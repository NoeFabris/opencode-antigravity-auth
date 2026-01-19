import { formatRefreshParts, parseRefreshParts } from "./auth";
import { loadAccounts, saveAccounts, type AccountStorageV3, type RateLimitStateV3, type ModelFamily, type HeaderStyle, type CooldownReason } from "./storage";
import type { OAuthAuthDetails, RefreshParts } from "./types";
import type { AccountSelectionStrategy } from "./config/schema";
import { getHealthTracker, getTokenTracker, selectHybridAccount, type AccountWithMetrics } from "./rotation";

export type { ModelFamily, HeaderStyle, CooldownReason } from "./storage";
export type { AccountSelectionStrategy } from "./config/schema";

export type RateLimitReason = 
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMIT_EXCEEDED" 
  | "MODEL_CAPACITY_EXHAUSTED"
  | "SERVER_ERROR"
  | "UNKNOWN";

export interface RateLimitBackoffResult {
  backoffMs: number;
  reason: RateLimitReason;
}

const QUOTA_EXHAUSTED_BACKOFFS = [60_000, 300_000, 1_800_000, 7_200_000] as const;
const RATE_LIMIT_EXCEEDED_BACKOFF = 30_000;
const MODEL_CAPACITY_EXHAUSTED_BACKOFF = 15_000;
const SERVER_ERROR_BACKOFF = 20_000;
const UNKNOWN_BACKOFF = 60_000;
const MIN_BACKOFF_MS = 2_000;

export function parseRateLimitReason(reason?: string, message?: string): RateLimitReason {
  if (reason) {
    switch (reason.toUpperCase()) {
      case "QUOTA_EXHAUSTED": return "QUOTA_EXHAUSTED";
      case "RATE_LIMIT_EXCEEDED": return "RATE_LIMIT_EXCEEDED";
      case "MODEL_CAPACITY_EXHAUSTED": return "MODEL_CAPACITY_EXHAUSTED";
    }
  }
  
  if (message) {
    const lower = message.toLowerCase();
    if (lower.includes("per minute") || lower.includes("rate limit") || lower.includes("too many requests")) {
      return "RATE_LIMIT_EXCEEDED";
    }
    if (lower.includes("exhausted") || lower.includes("quota")) {
      return "QUOTA_EXHAUSTED";
    }
  }
  
  return "UNKNOWN";
}

export function calculateBackoffMs(
  reason: RateLimitReason,
  consecutiveFailures: number,
  retryAfterMs?: number | null
): number {
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.max(retryAfterMs, MIN_BACKOFF_MS);
  }
  
  switch (reason) {
    case "QUOTA_EXHAUSTED": {
      const index = Math.min(consecutiveFailures, QUOTA_EXHAUSTED_BACKOFFS.length - 1);
      return QUOTA_EXHAUSTED_BACKOFFS[index] ?? UNKNOWN_BACKOFF;
    }
    case "RATE_LIMIT_EXCEEDED":
      return RATE_LIMIT_EXCEEDED_BACKOFF;
    case "MODEL_CAPACITY_EXHAUSTED":
      return MODEL_CAPACITY_EXHAUSTED_BACKOFF;
    case "SERVER_ERROR":
      return SERVER_ERROR_BACKOFF;
    case "UNKNOWN":
    default:
      return UNKNOWN_BACKOFF;
  }
}

export type BaseQuotaKey = "claude" | "gemini-antigravity" | "gemini-cli";
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`;

export interface ManagedAccount {
  index: number;
  email?: string;
  addedAt: number;
  lastUsed: number;
  parts: RefreshParts;
  access?: string;
  expires?: number;
  rateLimitResetTimes: RateLimitStateV3;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  coolingDownUntil?: number;
  cooldownReason?: CooldownReason;
  touchedForQuota: Record<string, number>;
  consecutiveFailures?: number;
}

function nowMs(): number {
  return Date.now();
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value < 0 ? 0 : Math.floor(value);
}

function getQuotaKey(family: ModelFamily, headerStyle: HeaderStyle, model?: string | null): QuotaKey {
  if (family === "claude") {
    return "claude";
  }
  const base = headerStyle === "gemini-cli" ? "gemini-cli" : "gemini-antigravity";
  if (model) {
    return `${base}:${model}`;
  }
  return base;
}

function isRateLimitedForQuotaKey(account: ManagedAccount, key: QuotaKey): boolean {
  const resetTime = account.rateLimitResetTimes[key];
  return resetTime !== undefined && nowMs() < resetTime;
}

function isRateLimitedForFamily(account: ManagedAccount, family: ModelFamily, model?: string | null): boolean {
  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude");
  }
  
  const antigravityIsLimited = isRateLimitedForHeaderStyle(account, family, "antigravity", model);
  const cliIsLimited = isRateLimitedForHeaderStyle(account, family, "gemini-cli", model);
  
  return antigravityIsLimited && cliIsLimited;
}

function isRateLimitedForHeaderStyle(account: ManagedAccount, family: ModelFamily, headerStyle: HeaderStyle, model?: string | null): boolean {
  clearExpiredRateLimits(account);
  
  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude");
  }

  // Check model-specific quota first if provided
  if (model) {
    const modelKey = getQuotaKey(family, headerStyle, model);
    if (isRateLimitedForQuotaKey(account, modelKey)) {
      return true;
    }
  }

  // Then check base family quota
  const baseKey = getQuotaKey(family, headerStyle);
  return isRateLimitedForQuotaKey(account, baseKey);
}

function clearExpiredRateLimits(account: ManagedAccount): void {
  const now = nowMs();
  const keys = Object.keys(account.rateLimitResetTimes) as QuotaKey[];
  for (const key of keys) {
    const resetTime = account.rateLimitResetTimes[key];
    if (resetTime !== undefined && now >= resetTime) {
      delete account.rateLimitResetTimes[key];
    }
  }
}

/**
 * In-memory multi-account manager with sticky account selection.
 *
 * Uses the same account until it hits a rate limit (429), then switches.
 * Rate limits are tracked per-model-family (claude/gemini) so an account
 * rate-limited for Claude can still be used for Gemini.
 *
 * Source of truth for the pool is `antigravity-accounts.json`.
 */
export class AccountManager {
  private accounts: ManagedAccount[] = [];
  private cursor = 0;
  private currentAccountIndexByFamily: Record<ModelFamily, number> = {
    claude: -1,
    gemini: -1,
  };
  private sessionOffsetApplied: Record<ModelFamily, boolean> = {
    claude: false,
    gemini: false,
  };
  private lastToastAccountIndex = -1;
  private lastToastTime = 0;

  private savePending = false;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private savePromiseResolvers: Array<() => void> = [];

  static async loadFromDisk(authFallback?: OAuthAuthDetails): Promise<AccountManager> {
    const stored = await loadAccounts();
    return new AccountManager(authFallback, stored);
  }

  constructor(authFallback?: OAuthAuthDetails, stored?: AccountStorageV3 | null) {
    const authParts = authFallback ? parseRefreshParts(authFallback.refresh) : null;

    if (stored && stored.accounts.length === 0) {
      this.accounts = [];
      this.cursor = 0;
      return;
    }

    if (stored && stored.accounts.length > 0) {
      const baseNow = nowMs();
      this.accounts = stored.accounts
        .map((acc, index): ManagedAccount | null => {
          if (!acc.refreshToken || typeof acc.refreshToken !== "string") {
            return null;
          }
          const matchesFallback = !!(
            authFallback &&
            authParts &&
            authParts.refreshToken &&
            acc.refreshToken === authParts.refreshToken
          );

          return {
            index,
            email: acc.email,
            addedAt: clampNonNegativeInt(acc.addedAt, baseNow),
            lastUsed: clampNonNegativeInt(acc.lastUsed, 0),
            parts: {
              refreshToken: acc.refreshToken,
              projectId: acc.projectId,
              managedProjectId: acc.managedProjectId,
            },
            access: matchesFallback ? authFallback?.access : undefined,
            expires: matchesFallback ? authFallback?.expires : undefined,
            rateLimitResetTimes: acc.rateLimitResetTimes ?? {},
            lastSwitchReason: acc.lastSwitchReason,
            coolingDownUntil: acc.coolingDownUntil,
            cooldownReason: acc.cooldownReason,
            touchedForQuota: {},
          };
        })
        .filter((a): a is ManagedAccount => a !== null);

      this.cursor = clampNonNegativeInt(stored.activeIndex, 0);
      if (this.accounts.length > 0) {
        this.cursor = this.cursor % this.accounts.length;
        const defaultIndex = this.cursor;
        this.currentAccountIndexByFamily.claude = clampNonNegativeInt(
          stored.activeIndexByFamily?.claude,
          defaultIndex
        ) % this.accounts.length;
        this.currentAccountIndexByFamily.gemini = clampNonNegativeInt(
          stored.activeIndexByFamily?.gemini,
          defaultIndex
        ) % this.accounts.length;
      }

      return;
    }

    // If we have stored accounts, check if we need to add the current auth
    if (authFallback && this.accounts.length > 0) {
      const authParts = parseRefreshParts(authFallback.refresh);
      const hasMatching = this.accounts.some(acc => acc.parts.refreshToken === authParts.refreshToken);
      if (!hasMatching && authParts.refreshToken) {
        const now = nowMs();
        const newAccount: ManagedAccount = {
          index: this.accounts.length,
          email: undefined,
          addedAt: now,
          lastUsed: 0,
          parts: authParts,
          access: authFallback.access,
          expires: authFallback.expires,
          rateLimitResetTimes: {},
          touchedForQuota: {},
        };
        this.accounts.push(newAccount);
        // Update indices to include the new account
        this.currentAccountIndexByFamily.claude = Math.min(this.currentAccountIndexByFamily.claude, this.accounts.length - 1);
        this.currentAccountIndexByFamily.gemini = Math.min(this.currentAccountIndexByFamily.gemini, this.accounts.length - 1);
      }
    }

    if (authFallback) {
      const parts = parseRefreshParts(authFallback.refresh);
      if (parts.refreshToken) {
        const now = nowMs();
        this.accounts = [
          {
            index: 0,
            email: undefined,
            addedAt: now,
            lastUsed: 0,
            parts,
            access: authFallback.access,
            expires: authFallback.expires,
            rateLimitResetTimes: {},
            touchedForQuota: {},
          },
        ];
        this.cursor = 0;
        this.currentAccountIndexByFamily.claude = 0;
        this.currentAccountIndexByFamily.gemini = 0;
      }
    }
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  getAccountsSnapshot(): ManagedAccount[] {
    return this.accounts.map((a) => ({ ...a, parts: { ...a.parts }, rateLimitResetTimes: { ...a.rateLimitResetTimes } }));
  }

  getCurrentAccountForFamily(family: ModelFamily): ManagedAccount | null {
    const currentIndex = this.currentAccountIndexByFamily[family];
    if (currentIndex >= 0 && currentIndex < this.accounts.length) {
      return this.accounts[currentIndex] ?? null;
    }
    return null;
  }

  markSwitched(account: ManagedAccount, reason: "rate-limit" | "initial" | "rotation", family: ModelFamily): void {
    account.lastSwitchReason = reason;
    this.currentAccountIndexByFamily[family] = account.index;
  }

  shouldShowAccountToast(accountIndex: number, debounceMs = 30000): boolean {
    const now = nowMs();
    if (accountIndex === this.lastToastAccountIndex && now - this.lastToastTime < debounceMs) {
      return false;
    }
    return true;
  }

  markToastShown(accountIndex: number): void {
    this.lastToastAccountIndex = accountIndex;
    this.lastToastTime = nowMs();
  }

  getCurrentOrNextForFamily(
    family: ModelFamily, 
    model?: string | null,
    strategy: AccountSelectionStrategy = 'sticky',
    headerStyle: HeaderStyle = 'antigravity',
    pidOffsetEnabled: boolean = false,
  ): ManagedAccount | null {
    const quotaKey = getQuotaKey(family, headerStyle, model);

    if (strategy === 'round-robin') {
      const next = this.getNextForFamily(family, model, headerStyle);
      if (next) {
        this.markTouchedForQuota(next, quotaKey);
        this.currentAccountIndexByFamily[family] = next.index;
      }
      return next;
    }

    if (strategy === 'hybrid') {
      const healthTracker = getHealthTracker();
      const tokenTracker = getTokenTracker();
      
      const accountsWithMetrics: AccountWithMetrics[] = this.accounts.map(acc => {
        clearExpiredRateLimits(acc);
        return {
          index: acc.index,
          lastUsed: acc.lastUsed,
          healthScore: healthTracker.getScore(acc.index),
          isRateLimited: isRateLimitedForFamily(acc, family, model),
          isCoolingDown: this.isAccountCoolingDown(acc),
        };
      });

      const selectedIndex = selectHybridAccount(accountsWithMetrics, tokenTracker);
      if (selectedIndex !== null) {
        const selected = this.accounts[selectedIndex];
        if (selected) {
          selected.lastUsed = nowMs();
          this.markTouchedForQuota(selected, quotaKey);
          this.currentAccountIndexByFamily[family] = selected.index;
          return selected;
        }
      }
    }

    // Fallback: sticky selection (used when hybrid finds no candidates)
    // PID-based offset for multi-session distribution (opt-in)
    // Different sessions (PIDs) will prefer different starting accounts
    if (pidOffsetEnabled && !this.sessionOffsetApplied[family] && this.accounts.length > 1) {
      const pidOffset = process.pid % this.accounts.length;
      const baseIndex = this.currentAccountIndexByFamily[family] ?? 0;
      this.currentAccountIndexByFamily[family] = (baseIndex + pidOffset) % this.accounts.length;
      this.sessionOffsetApplied[family] = true;
    }

    const current = this.getCurrentAccountForFamily(family);
    if (current) {
      clearExpiredRateLimits(current);
      const isLimitedForRequestedStyle = isRateLimitedForHeaderStyle(current, family, headerStyle, model);
      if (!isLimitedForRequestedStyle && !this.isAccountCoolingDown(current)) {
        current.lastUsed = nowMs();
        this.markTouchedForQuota(current, quotaKey);
        return current;
      }
    }

    const next = this.getNextForFamily(family, model, headerStyle);
    if (next) {
      this.markTouchedForQuota(next, quotaKey);
      this.currentAccountIndexByFamily[family] = next.index;
    }
    return next;
  }

  getNextForFamily(family: ModelFamily, model?: string | null, headerStyle: HeaderStyle = "antigravity"): ManagedAccount | null {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return !isRateLimitedForHeaderStyle(a, family, headerStyle, model) && !this.isAccountCoolingDown(a);
    });

    if (available.length === 0) {
      return null;
    }

    const account = available[this.cursor % available.length];
    if (!account) {
      return null;
    }

    this.cursor++;
    account.lastUsed = nowMs();
    return account;
  }

  markRateLimited(
    account: ManagedAccount,
    retryAfterMs: number,
    family: ModelFamily,
    headerStyle: HeaderStyle = "antigravity",
    model?: string | null
  ): void {
    const key = getQuotaKey(family, headerStyle, model);
    account.rateLimitResetTimes[key] = nowMs() + retryAfterMs;
  }

  markRateLimitedWithReason(
    account: ManagedAccount,
    family: ModelFamily,
    headerStyle: HeaderStyle,
    model: string | null | undefined,
    reason: RateLimitReason,
    retryAfterMs?: number | null
  ): number {
    const failures = (account.consecutiveFailures ?? 0) + 1;
    account.consecutiveFailures = failures;
    
    const backoffMs = calculateBackoffMs(reason, failures - 1, retryAfterMs);
    const key = getQuotaKey(family, headerStyle, model);
    account.rateLimitResetTimes[key] = nowMs() + backoffMs;
    
    return backoffMs;
  }

  markRequestSuccess(account: ManagedAccount): void {
    if (account.consecutiveFailures) {
      account.consecutiveFailures = 0;
    }
  }

  clearAllRateLimitsForFamily(family: ModelFamily, model?: string | null): void {
    for (const account of this.accounts) {
      if (family === "claude") {
        delete account.rateLimitResetTimes.claude;
      } else {
        const antigravityKey = getQuotaKey(family, "antigravity", model);
        const cliKey = getQuotaKey(family, "gemini-cli", model);
        delete account.rateLimitResetTimes[antigravityKey];
        delete account.rateLimitResetTimes[cliKey];
      }
      account.consecutiveFailures = 0;
    }
  }

  shouldTryOptimisticReset(family: ModelFamily, model?: string | null): boolean {
    const minWaitMs = this.getMinWaitTimeForFamily(family, model);
    return minWaitMs > 0 && minWaitMs <= 2_000;
  }

  markAccountCoolingDown(account: ManagedAccount, cooldownMs: number, reason: CooldownReason): void {
    account.coolingDownUntil = nowMs() + cooldownMs;
    account.cooldownReason = reason;
  }

  isAccountCoolingDown(account: ManagedAccount): boolean {
    if (account.coolingDownUntil === undefined) {
      return false;
    }
    if (nowMs() >= account.coolingDownUntil) {
      this.clearAccountCooldown(account);
      return false;
    }
    return true;
  }

  clearAccountCooldown(account: ManagedAccount): void {
    delete account.coolingDownUntil;
    delete account.cooldownReason;
  }

  getAccountCooldownReason(account: ManagedAccount): CooldownReason | undefined {
    return this.isAccountCoolingDown(account) ? account.cooldownReason : undefined;
  }

  markTouchedForQuota(account: ManagedAccount, quotaKey: string): void {
    account.touchedForQuota[quotaKey] = nowMs();
  }

  isFreshForQuota(account: ManagedAccount, quotaKey: string): boolean {
    const touchedAt = account.touchedForQuota[quotaKey];
    if (!touchedAt) return true;
    
    const resetTime = account.rateLimitResetTimes[quotaKey as QuotaKey];
    if (resetTime && touchedAt < resetTime) return true;
    
    return false;
  }

  getFreshAccountsForQuota(quotaKey: string, family: ModelFamily, model?: string | null): ManagedAccount[] {
    return this.accounts.filter(acc => {
      clearExpiredRateLimits(acc);
      return this.isFreshForQuota(acc, quotaKey) && 
             !isRateLimitedForFamily(acc, family, model) && 
             !this.isAccountCoolingDown(acc);
    });
  }

  isRateLimitedForHeaderStyle(
    account: ManagedAccount,
    family: ModelFamily,
    headerStyle: HeaderStyle,
    model?: string | null
  ): boolean {
    return isRateLimitedForHeaderStyle(account, family, headerStyle, model);
  }

  getAvailableHeaderStyle(account: ManagedAccount, family: ModelFamily, model?: string | null): HeaderStyle | null {
    clearExpiredRateLimits(account);
    if (family === "claude") {
      return isRateLimitedForHeaderStyle(account, family, "antigravity") ? null : "antigravity";
    }
    if (!isRateLimitedForHeaderStyle(account, family, "antigravity", model)) {
      return "antigravity";
    }
    if (!isRateLimitedForHeaderStyle(account, family, "gemini-cli", model)) {
      return "gemini-cli";
    }
    return null;
  }

  removeAccount(account: ManagedAccount): boolean {
    const idx = this.accounts.indexOf(account);
    if (idx < 0) {
      return false;
    }

    this.accounts.splice(idx, 1);
    this.accounts.forEach((acc, index) => {
      acc.index = index;
    });

    if (this.accounts.length === 0) {
      this.cursor = 0;
      this.currentAccountIndexByFamily.claude = -1;
      this.currentAccountIndexByFamily.gemini = -1;
      return true;
    }

    if (this.cursor > idx) {
      this.cursor -= 1;
    }
    this.cursor = this.cursor % this.accounts.length;

    for (const family of ["claude", "gemini"] as ModelFamily[]) {
      if (this.currentAccountIndexByFamily[family] > idx) {
        this.currentAccountIndexByFamily[family] -= 1;
      }
      if (this.currentAccountIndexByFamily[family] >= this.accounts.length) {
        this.currentAccountIndexByFamily[family] = -1;
      }
    }

    return true;
  }

  updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void {
    const parts = parseRefreshParts(auth.refresh);
    // Preserve existing projectId/managedProjectId if not in the new parts
    account.parts = {
      ...parts,
      projectId: parts.projectId ?? account.parts.projectId,
      managedProjectId: parts.managedProjectId ?? account.parts.managedProjectId,
    };
    account.access = auth.access;
    account.expires = auth.expires;
  }

  toAuthDetails(account: ManagedAccount): OAuthAuthDetails {
    return {
      type: "oauth",
      refresh: formatRefreshParts(account.parts),
      access: account.access,
      expires: account.expires,
    };
  }

  getMinWaitTimeForFamily(
    family: ModelFamily,
    model?: string | null,
    headerStyle?: HeaderStyle,
    strict?: boolean,
  ): number {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return strict && headerStyle
        ? !isRateLimitedForHeaderStyle(a, family, headerStyle, model)
        : !isRateLimitedForFamily(a, family, model);
    });
    if (available.length > 0) {
      return 0;
    }

    const waitTimes: number[] = [];
    for (const a of this.accounts) {
      if (family === "claude") {
        const t = a.rateLimitResetTimes.claude;
        if (t !== undefined) waitTimes.push(Math.max(0, t - nowMs()));
      } else if (strict && headerStyle) {
        const key = getQuotaKey(family, headerStyle, model);
        const t = a.rateLimitResetTimes[key];
        if (t !== undefined) waitTimes.push(Math.max(0, t - nowMs()));
      } else {
        // For Gemini, account becomes available when EITHER pool expires for this model/family
        const antigravityKey = getQuotaKey(family, "antigravity", model);
        const cliKey = getQuotaKey(family, "gemini-cli", model);

        const t1 = a.rateLimitResetTimes[antigravityKey];
        const t2 = a.rateLimitResetTimes[cliKey];
        
        const accountWait = Math.min(
          t1 !== undefined ? Math.max(0, t1 - nowMs()) : Infinity,
          t2 !== undefined ? Math.max(0, t2 - nowMs()) : Infinity
        );
        if (accountWait !== Infinity) waitTimes.push(accountWait);
      }
    }

    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
  }

  getAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  async saveToDisk(): Promise<void> {
    const claudeIndex = Math.max(0, this.currentAccountIndexByFamily.claude);
    const geminiIndex = Math.max(0, this.currentAccountIndexByFamily.gemini);
    
    const storage: AccountStorageV3 = {
      version: 3,
      accounts: this.accounts.map((a) => ({
        email: a.email,
        refreshToken: a.parts.refreshToken,
        projectId: a.parts.projectId,
        managedProjectId: a.parts.managedProjectId,
        addedAt: a.addedAt,
        lastUsed: a.lastUsed,
        lastSwitchReason: a.lastSwitchReason,
        rateLimitResetTimes: Object.keys(a.rateLimitResetTimes).length > 0 ? a.rateLimitResetTimes : undefined,
        coolingDownUntil: a.coolingDownUntil,
        cooldownReason: a.cooldownReason,
      })),
      activeIndex: claudeIndex,
      activeIndexByFamily: {
        claude: claudeIndex,
        gemini: geminiIndex,
      },
    };

    await saveAccounts(storage);
  }

  requestSaveToDisk(): void {
    if (this.savePending) {
      return;
    }
    this.savePending = true;
    this.saveTimeout = setTimeout(() => {
      void this.executeSave();
    }, 1000);
  }

  async flushSaveToDisk(): Promise<void> {
    if (!this.savePending) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.savePromiseResolvers.push(resolve);
    });
  }

  private async executeSave(): Promise<void> {
    this.savePending = false;
    this.saveTimeout = null;
    
    try {
      await this.saveToDisk();
    } catch {
      // best-effort persistence; avoid unhandled rejection from timer-driven saves
    } finally {
      const resolvers = this.savePromiseResolvers;
      this.savePromiseResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }
}
