import { type AccountStorageV3, type RateLimitStateV3, type ModelFamily, type HeaderStyle, type CooldownReason } from "./storage";
import type { OAuthAuthDetails, RefreshParts } from "./types";
import type { AccountSelectionStrategy } from "./config/schema";
export type { ModelFamily, HeaderStyle, CooldownReason } from "./storage";
export type { AccountSelectionStrategy } from "./config/schema";
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
/**
 * In-memory multi-account manager with sticky account selection.
 *
 * Uses the same account until it hits a rate limit (429), then switches.
 * Rate limits are tracked per-model-family (claude/gemini) so an account
 * rate-limited for Claude can still be used for Gemini.
 *
 * Source of truth for the pool is `antigravity-accounts.json`.
 */
export declare class AccountManager {
    private accounts;
    private cursor;
    private currentAccountIndexByFamily;
    private sessionOffsetApplied;
    private lastToastAccountIndex;
    private lastToastTime;
    static loadFromDisk(authFallback?: OAuthAuthDetails): Promise<AccountManager>;
    constructor(authFallback?: OAuthAuthDetails, stored?: AccountStorageV3 | null);
    getAccountCount(): number;
    getAccountsSnapshot(): ManagedAccount[];
    getCurrentAccountForFamily(family: ModelFamily): ManagedAccount | null;
    markSwitched(account: ManagedAccount, reason: "rate-limit" | "initial" | "rotation", family: ModelFamily): void;
    shouldShowAccountToast(accountIndex: number, debounceMs?: number): boolean;
    markToastShown(accountIndex: number): void;
    getCurrentOrNextForFamily(family: ModelFamily, model?: string | null, strategy?: AccountSelectionStrategy, headerStyle?: HeaderStyle, pidOffsetEnabled?: boolean): ManagedAccount | null;
    getNextForFamily(family: ModelFamily, model?: string | null): ManagedAccount | null;
    markRateLimited(account: ManagedAccount, retryAfterMs: number, family: ModelFamily, headerStyle?: HeaderStyle, model?: string | null): void;
    markAccountCoolingDown(account: ManagedAccount, cooldownMs: number, reason: CooldownReason): void;
    isAccountCoolingDown(account: ManagedAccount): boolean;
    clearAccountCooldown(account: ManagedAccount): void;
    getAccountCooldownReason(account: ManagedAccount): CooldownReason | undefined;
    markTouchedForQuota(account: ManagedAccount, quotaKey: string): void;
    isFreshForQuota(account: ManagedAccount, quotaKey: string): boolean;
    getFreshAccountsForQuota(quotaKey: string, family: ModelFamily, model?: string | null): ManagedAccount[];
    isRateLimitedForHeaderStyle(account: ManagedAccount, family: ModelFamily, headerStyle: HeaderStyle, model?: string | null): boolean;
    getAvailableHeaderStyle(account: ManagedAccount, family: ModelFamily, model?: string | null): HeaderStyle | null;
    removeAccount(account: ManagedAccount): boolean;
    updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void;
    toAuthDetails(account: ManagedAccount): OAuthAuthDetails;
    getMinWaitTimeForFamily(family: ModelFamily, model?: string | null): number;
    getAccounts(): ManagedAccount[];
    saveToDisk(): Promise<void>;
}
//# sourceMappingURL=accounts.d.ts.map