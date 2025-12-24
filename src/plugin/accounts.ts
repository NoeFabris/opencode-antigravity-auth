import { formatRefreshParts, parseRefreshParts } from "./auth";
import { loadAccounts, saveAccounts, type AccountStorageV3, type RateLimitStateV3, type ModelFamily, type HeaderStyle } from "./storage";
import { isAccountReserved, reserveAccount, releaseAccount } from "./reservation";
import type { OAuthAuthDetails, RefreshParts } from "./types";

export type { ModelFamily, HeaderStyle } from "./storage";

export type QuotaKey = "claude" | "gemini-antigravity" | "gemini-cli";

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

function getQuotaKey(family: ModelFamily, headerStyle: HeaderStyle): QuotaKey {
  if (family === "claude") {
    return "claude";
  }
  return headerStyle === "gemini-cli" ? "gemini-cli" : "gemini-antigravity";
}

function isRateLimitedForQuotaKey(account: ManagedAccount, key: QuotaKey): boolean {
  const resetTime = account.rateLimitResetTimes[key];
  return resetTime !== undefined && nowMs() < resetTime;
}

function isRateLimitedForFamily(account: ManagedAccount, family: ModelFamily): boolean {
  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude");
  }
  return isRateLimitedForQuotaKey(account, "gemini-antigravity") && 
         isRateLimitedForQuotaKey(account, "gemini-cli");
}

function clearExpiredRateLimits(account: ManagedAccount): void {
  const now = nowMs();
  const keys: QuotaKey[] = ["claude", "gemini-antigravity", "gemini-cli"];
  for (const key of keys) {
    if (account.rateLimitResetTimes[key] !== undefined && now >= account.rateLimitResetTimes[key]!) {
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
  private lastToastAccountIndex = -1;
  private lastToastTime = 0;

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

  getCurrentOrNextForFamily(family: ModelFamily): ManagedAccount | null {
    const current = this.getCurrentAccountForFamily(family);
    if (current) {
      clearExpiredRateLimits(current);
      if (!isRateLimitedForFamily(current, family)) {
        current.lastUsed = nowMs();
        return current;
      }
    }

    const next = this.getNextForFamily(family);
    if (next) {
      this.currentAccountIndexByFamily[family] = next.index;
    }
    return next;
  }

  async getCurrentOrNextForFamilyWithReservation(family: ModelFamily): Promise<ManagedAccount | null> {
    const current = this.getCurrentAccountForFamily(family);
    if (current) {
      clearExpiredRateLimits(current);
      if (!isRateLimitedForFamily(current, family)) {
        const reserved = await isAccountReserved(current.index, family);
        if (!reserved) {
          await reserveAccount(current.index, family);
          current.lastUsed = nowMs();
          return current;
        }
      }
    }

    const next = await this.getNextForFamilyWithReservation(family);
    if (next) {
      this.currentAccountIndexByFamily[family] = next.index;
    }
    return next;
  }

  getNextForFamily(family: ModelFamily): ManagedAccount | null {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return !isRateLimitedForFamily(a, family);
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

  async getNextForFamilyWithReservation(family: ModelFamily): Promise<ManagedAccount | null> {
    const available: ManagedAccount[] = [];

    for (const a of this.accounts) {
      clearExpiredRateLimits(a);
      if (isRateLimitedForFamily(a, family)) continue;

      const reserved = await isAccountReserved(a.index, family);
      if (reserved) continue;

      available.push(a);
    }

    if (available.length === 0) {
      return this.getNextForFamily(family);
    }

    const account = available[this.cursor % available.length];
    if (!account) {
      return null;
    }

    await reserveAccount(account.index, family);
    this.cursor++;
    account.lastUsed = nowMs();
    return account;
  }

  async releaseAccountReservation(accountIndex: number): Promise<void> {
    await releaseAccount(accountIndex);
  }

  markRateLimited(account: ManagedAccount, retryAfterMs: number, family: ModelFamily, headerStyle: HeaderStyle = "antigravity"): void {
    const key = getQuotaKey(family, headerStyle);
    account.rateLimitResetTimes[key] = nowMs() + retryAfterMs;
  }

  isRateLimitedForHeaderStyle(account: ManagedAccount, family: ModelFamily, headerStyle: HeaderStyle): boolean {
    clearExpiredRateLimits(account);
    const key = getQuotaKey(family, headerStyle);
    return isRateLimitedForQuotaKey(account, key);
  }

  getAvailableHeaderStyle(account: ManagedAccount, family: ModelFamily): HeaderStyle | null {
    clearExpiredRateLimits(account);
    if (family === "claude") {
      return isRateLimitedForQuotaKey(account, "claude") ? null : "antigravity";
    }
    if (!isRateLimitedForQuotaKey(account, "gemini-antigravity")) {
      return "antigravity";
    }
    if (!isRateLimitedForQuotaKey(account, "gemini-cli")) {
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
    account.parts = parts;
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

  getMinWaitTimeForFamily(family: ModelFamily): number {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return !isRateLimitedForFamily(a, family);
    });
    if (available.length > 0) {
      return 0;
    }

    const waitTimes: number[] = [];
    for (const a of this.accounts) {
      if (family === "claude") {
        const t = a.rateLimitResetTimes.claude;
        if (t !== undefined) waitTimes.push(Math.max(0, t - nowMs()));
      } else {
        // For Gemini, account becomes available when EITHER pool expires
        const t1 = a.rateLimitResetTimes["gemini-antigravity"];
        const t2 = a.rateLimitResetTimes["gemini-cli"];
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
      })),
      activeIndex: claudeIndex,
      activeIndexByFamily: {
        claude: claudeIndex,
        gemini: geminiIndex,
      },
    };

    await saveAccounts(storage);
  }
}
