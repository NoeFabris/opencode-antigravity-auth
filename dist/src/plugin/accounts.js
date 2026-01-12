import { formatRefreshParts, parseRefreshParts } from "./auth";
import { loadAccounts, saveAccounts } from "./storage";
function nowMs() {
    return Date.now();
}
function clampNonNegativeInt(value, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    return value < 0 ? 0 : Math.floor(value);
}
function getQuotaKey(family, headerStyle, model) {
    if (family === "claude") {
        return "claude";
    }
    const base = headerStyle === "gemini-cli" ? "gemini-cli" : "gemini-antigravity";
    if (model) {
        return `${base}:${model}`;
    }
    return base;
}
function isRateLimitedForQuotaKey(account, key) {
    const resetTime = account.rateLimitResetTimes[key];
    return resetTime !== undefined && nowMs() < resetTime;
}
function isRateLimitedForFamily(account, family, model) {
    if (family === "claude") {
        return isRateLimitedForQuotaKey(account, "claude");
    }
    const antigravityIsLimited = isRateLimitedForHeaderStyle(account, family, "antigravity", model);
    const cliIsLimited = isRateLimitedForHeaderStyle(account, family, "gemini-cli", model);
    return antigravityIsLimited && cliIsLimited;
}
function isRateLimitedForHeaderStyle(account, family, headerStyle, model) {
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
function clearExpiredRateLimits(account) {
    const now = nowMs();
    const keys = Object.keys(account.rateLimitResetTimes);
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
    accounts = [];
    cursor = 0;
    currentAccountIndexByFamily = {
        claude: -1,
        gemini: -1,
    };
    sessionOffsetApplied = {
        claude: false,
        gemini: false,
    };
    lastToastAccountIndex = -1;
    lastToastTime = 0;
    static async loadFromDisk(authFallback) {
        const stored = await loadAccounts();
        return new AccountManager(authFallback, stored);
    }
    constructor(authFallback, stored) {
        const authParts = authFallback ? parseRefreshParts(authFallback.refresh) : null;
        if (stored && stored.accounts.length === 0) {
            this.accounts = [];
            this.cursor = 0;
            return;
        }
        if (stored && stored.accounts.length > 0) {
            const baseNow = nowMs();
            this.accounts = stored.accounts
                .map((acc, index) => {
                if (!acc.refreshToken || typeof acc.refreshToken !== "string") {
                    return null;
                }
                const matchesFallback = !!(authFallback &&
                    authParts &&
                    authParts.refreshToken &&
                    acc.refreshToken === authParts.refreshToken);
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
                .filter((a) => a !== null);
            this.cursor = clampNonNegativeInt(stored.activeIndex, 0);
            if (this.accounts.length > 0) {
                this.cursor = this.cursor % this.accounts.length;
                const defaultIndex = this.cursor;
                this.currentAccountIndexByFamily.claude = clampNonNegativeInt(stored.activeIndexByFamily?.claude, defaultIndex) % this.accounts.length;
                this.currentAccountIndexByFamily.gemini = clampNonNegativeInt(stored.activeIndexByFamily?.gemini, defaultIndex) % this.accounts.length;
            }
            return;
        }
        // If we have stored accounts, check if we need to add the current auth
        if (authFallback && this.accounts.length > 0) {
            const authParts = parseRefreshParts(authFallback.refresh);
            const hasMatching = this.accounts.some(acc => acc.parts.refreshToken === authParts.refreshToken);
            if (!hasMatching && authParts.refreshToken) {
                const now = nowMs();
                const newAccount = {
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
    getAccountCount() {
        return this.accounts.length;
    }
    getAccountsSnapshot() {
        return this.accounts.map((a) => ({ ...a, parts: { ...a.parts }, rateLimitResetTimes: { ...a.rateLimitResetTimes } }));
    }
    getCurrentAccountForFamily(family) {
        const currentIndex = this.currentAccountIndexByFamily[family];
        if (currentIndex >= 0 && currentIndex < this.accounts.length) {
            return this.accounts[currentIndex] ?? null;
        }
        return null;
    }
    markSwitched(account, reason, family) {
        account.lastSwitchReason = reason;
        this.currentAccountIndexByFamily[family] = account.index;
    }
    shouldShowAccountToast(accountIndex, debounceMs = 30000) {
        const now = nowMs();
        if (accountIndex === this.lastToastAccountIndex && now - this.lastToastTime < debounceMs) {
            return false;
        }
        return true;
    }
    markToastShown(accountIndex) {
        this.lastToastAccountIndex = accountIndex;
        this.lastToastTime = nowMs();
    }
    getCurrentOrNextForFamily(family, model, strategy = 'sticky', headerStyle = 'antigravity', pidOffsetEnabled = false) {
        const quotaKey = getQuotaKey(family, headerStyle, model);
        if (strategy === 'round-robin') {
            const next = this.getNextForFamily(family, model);
            if (next) {
                this.markTouchedForQuota(next, quotaKey);
                this.currentAccountIndexByFamily[family] = next.index;
            }
            return next;
        }
        if (strategy === 'hybrid') {
            const freshAccounts = this.getFreshAccountsForQuota(quotaKey, family, model);
            if (freshAccounts.length > 0) {
                const fresh = freshAccounts[0];
                if (fresh) {
                    fresh.lastUsed = nowMs();
                    this.markTouchedForQuota(fresh, quotaKey);
                    this.currentAccountIndexByFamily[family] = fresh.index;
                    return fresh;
                }
            }
        }
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
            if (!isRateLimitedForFamily(current, family, model) && !this.isAccountCoolingDown(current)) {
                current.lastUsed = nowMs();
                this.markTouchedForQuota(current, quotaKey);
                return current;
            }
        }
        const next = this.getNextForFamily(family, model);
        if (next) {
            this.markTouchedForQuota(next, quotaKey);
            this.currentAccountIndexByFamily[family] = next.index;
        }
        return next;
    }
    getNextForFamily(family, model) {
        const available = this.accounts.filter((a) => {
            clearExpiredRateLimits(a);
            return !isRateLimitedForFamily(a, family, model) && !this.isAccountCoolingDown(a);
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
    markRateLimited(account, retryAfterMs, family, headerStyle = "antigravity", model) {
        const key = getQuotaKey(family, headerStyle, model);
        account.rateLimitResetTimes[key] = nowMs() + retryAfterMs;
    }
    markAccountCoolingDown(account, cooldownMs, reason) {
        account.coolingDownUntil = nowMs() + cooldownMs;
        account.cooldownReason = reason;
    }
    isAccountCoolingDown(account) {
        if (account.coolingDownUntil === undefined) {
            return false;
        }
        if (nowMs() >= account.coolingDownUntil) {
            this.clearAccountCooldown(account);
            return false;
        }
        return true;
    }
    clearAccountCooldown(account) {
        delete account.coolingDownUntil;
        delete account.cooldownReason;
    }
    getAccountCooldownReason(account) {
        return this.isAccountCoolingDown(account) ? account.cooldownReason : undefined;
    }
    markTouchedForQuota(account, quotaKey) {
        account.touchedForQuota[quotaKey] = nowMs();
    }
    isFreshForQuota(account, quotaKey) {
        const touchedAt = account.touchedForQuota[quotaKey];
        if (!touchedAt)
            return true;
        const resetTime = account.rateLimitResetTimes[quotaKey];
        if (resetTime && touchedAt < resetTime)
            return true;
        return false;
    }
    getFreshAccountsForQuota(quotaKey, family, model) {
        return this.accounts.filter(acc => {
            clearExpiredRateLimits(acc);
            return this.isFreshForQuota(acc, quotaKey) &&
                !isRateLimitedForFamily(acc, family, model) &&
                !this.isAccountCoolingDown(acc);
        });
    }
    isRateLimitedForHeaderStyle(account, family, headerStyle, model) {
        return isRateLimitedForHeaderStyle(account, family, headerStyle, model);
    }
    getAvailableHeaderStyle(account, family, model) {
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
    removeAccount(account) {
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
        for (const family of ["claude", "gemini"]) {
            if (this.currentAccountIndexByFamily[family] > idx) {
                this.currentAccountIndexByFamily[family] -= 1;
            }
            if (this.currentAccountIndexByFamily[family] >= this.accounts.length) {
                this.currentAccountIndexByFamily[family] = -1;
            }
        }
        return true;
    }
    updateFromAuth(account, auth) {
        const parts = parseRefreshParts(auth.refresh);
        account.parts = parts;
        account.access = auth.access;
        account.expires = auth.expires;
    }
    toAuthDetails(account) {
        return {
            type: "oauth",
            refresh: formatRefreshParts(account.parts),
            access: account.access,
            expires: account.expires,
        };
    }
    getMinWaitTimeForFamily(family, model) {
        const available = this.accounts.filter((a) => {
            clearExpiredRateLimits(a);
            return !isRateLimitedForFamily(a, family, model);
        });
        if (available.length > 0) {
            return 0;
        }
        const waitTimes = [];
        for (const a of this.accounts) {
            if (family === "claude") {
                const t = a.rateLimitResetTimes.claude;
                if (t !== undefined)
                    waitTimes.push(Math.max(0, t - nowMs()));
            }
            else {
                // For Gemini, account becomes available when EITHER pool expires for this model/family
                const antigravityKey = getQuotaKey(family, "antigravity", model);
                const cliKey = getQuotaKey(family, "gemini-cli", model);
                const t1 = a.rateLimitResetTimes[antigravityKey];
                const t2 = a.rateLimitResetTimes[cliKey];
                const accountWait = Math.min(t1 !== undefined ? Math.max(0, t1 - nowMs()) : Infinity, t2 !== undefined ? Math.max(0, t2 - nowMs()) : Infinity);
                if (accountWait !== Infinity)
                    waitTimes.push(accountWait);
            }
        }
        return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
    }
    getAccounts() {
        return [...this.accounts];
    }
    async saveToDisk() {
        const claudeIndex = Math.max(0, this.currentAccountIndexByFamily.claude);
        const geminiIndex = Math.max(0, this.currentAccountIndexByFamily.gemini);
        const storage = {
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
}
//# sourceMappingURL=accounts.js.map