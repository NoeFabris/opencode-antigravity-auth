/**
 * Proactive Token Refresh Queue
 *
 * Ported from LLM-API-Key-Proxy's BackgroundRefresher.
 *
 * This module provides background token refresh to ensure OAuth tokens
 * remain valid without blocking user requests. It periodically checks
 * all accounts and refreshes tokens that are approaching expiry.
 *
 * Features:
 * - Non-blocking background refresh (doesn't block requests)
 * - Configurable refresh buffer (default: 30 minutes before expiry)
 * - Configurable check interval (default: 5 minutes)
 * - Serialized refresh to prevent concurrent refresh storms
 * - Integrates with existing AccountManager and token refresh logic
 * - Silent operation: no console output, uses structured logger
 */
import { refreshAccessToken } from "./token";
import { createLogger } from "./logger";
const log = createLogger("refresh-queue");
export const DEFAULT_PROACTIVE_REFRESH_CONFIG = {
    enabled: true,
    bufferSeconds: 1800, // 30 minutes
    checkIntervalSeconds: 300, // 5 minutes
};
/**
 * Proactive Token Refresh Queue
 *
 * Runs in the background and proactively refreshes tokens before they expire.
 * This ensures that user requests never block on token refresh.
 *
 * All logging is silent by default - uses structured logger that only outputs
 * when OPENCODE_ANTIGRAVITY_CONSOLE_LOG=1 is set or TUI logging is available.
 */
export class ProactiveRefreshQueue {
    config;
    client;
    providerId;
    accountManager = null;
    state = {
        isRunning: false,
        intervalHandle: null,
        isRefreshing: false,
        lastCheckTime: 0,
        lastRefreshTime: 0,
        refreshCount: 0,
        errorCount: 0,
    };
    constructor(client, providerId, config) {
        this.client = client;
        this.providerId = providerId;
        this.config = {
            ...DEFAULT_PROACTIVE_REFRESH_CONFIG,
            ...config,
        };
    }
    /**
     * Set the account manager to use for refresh operations.
     * Must be called before start().
     */
    setAccountManager(manager) {
        this.accountManager = manager;
    }
    /**
     * Check if a token needs proactive refresh.
     * Returns true if the token expires within the buffer period.
     */
    needsRefresh(account) {
        if (!account.expires) {
            // No expiry set - assume it's fine
            return false;
        }
        const now = Date.now();
        const bufferMs = this.config.bufferSeconds * 1000;
        const refreshThreshold = now + bufferMs;
        return account.expires <= refreshThreshold;
    }
    /**
     * Check if a token is already expired.
     */
    isExpired(account) {
        if (!account.expires) {
            return false;
        }
        return account.expires <= Date.now();
    }
    /**
     * Get all accounts that need proactive refresh.
     */
    getAccountsNeedingRefresh() {
        if (!this.accountManager) {
            return [];
        }
        return this.accountManager.getAccounts().filter((account) => {
            // Only refresh if not already expired (let the main flow handle expired tokens)
            if (this.isExpired(account)) {
                return false;
            }
            return this.needsRefresh(account);
        });
    }
    /**
     * Perform a single refresh check iteration.
     * This is called periodically by the background interval.
     */
    async runRefreshCheck() {
        if (this.state.isRefreshing) {
            // Already refreshing - skip this iteration
            return;
        }
        if (!this.accountManager) {
            return;
        }
        this.state.isRefreshing = true;
        this.state.lastCheckTime = Date.now();
        try {
            const accountsToRefresh = this.getAccountsNeedingRefresh();
            if (accountsToRefresh.length === 0) {
                return;
            }
            log.debug("Found accounts needing refresh", { count: accountsToRefresh.length });
            // Refresh accounts serially to avoid concurrent refresh storms
            for (const account of accountsToRefresh) {
                if (!this.state.isRunning) {
                    // Queue was stopped - abort
                    break;
                }
                try {
                    const auth = this.accountManager.toAuthDetails(account);
                    const refreshed = await this.refreshToken(auth, account);
                    if (refreshed) {
                        this.accountManager.updateFromAuth(account, refreshed);
                        this.state.refreshCount++;
                        this.state.lastRefreshTime = Date.now();
                        // Persist the refreshed token
                        try {
                            await this.accountManager.saveToDisk();
                        }
                        catch {
                            // Non-fatal - token is refreshed in memory
                        }
                    }
                }
                catch (error) {
                    this.state.errorCount++;
                    // Log but don't throw - continue with other accounts
                    log.warn("Failed to refresh account", {
                        accountIndex: account.index,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }
        finally {
            this.state.isRefreshing = false;
        }
    }
    /**
     * Refresh a single token.
     */
    async refreshToken(auth, account) {
        const minutesUntilExpiry = account.expires
            ? Math.round((account.expires - Date.now()) / 60000)
            : "unknown";
        log.debug("Proactively refreshing token", {
            accountIndex: account.index,
            email: account.email ?? "unknown",
            minutesUntilExpiry,
        });
        return refreshAccessToken(auth, this.client, this.providerId);
    }
    /**
     * Start the background refresh queue.
     */
    start() {
        if (this.state.isRunning) {
            return;
        }
        if (!this.config.enabled) {
            log.debug("Proactive refresh disabled by config");
            return;
        }
        this.state.isRunning = true;
        const intervalMs = this.config.checkIntervalSeconds * 1000;
        log.debug("Started proactive refresh queue", {
            checkIntervalSeconds: this.config.checkIntervalSeconds,
            bufferSeconds: this.config.bufferSeconds,
        });
        // Run initial check after a short delay (let things settle)
        setTimeout(() => {
            if (this.state.isRunning) {
                this.runRefreshCheck().catch((error) => {
                    log.error("Initial check failed", {
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
            }
        }, 5000);
        // Set up periodic checks
        this.state.intervalHandle = setInterval(() => {
            this.runRefreshCheck().catch((error) => {
                log.error("Check failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }, intervalMs);
    }
    /**
     * Stop the background refresh queue.
     */
    stop() {
        if (!this.state.isRunning) {
            return;
        }
        this.state.isRunning = false;
        if (this.state.intervalHandle) {
            clearInterval(this.state.intervalHandle);
            this.state.intervalHandle = null;
        }
        log.debug("Stopped proactive refresh queue", {
            refreshCount: this.state.refreshCount,
            errorCount: this.state.errorCount,
        });
    }
    /**
     * Get current queue statistics.
     */
    getStats() {
        return { ...this.state };
    }
    /**
     * Check if the queue is currently running.
     */
    isRunning() {
        return this.state.isRunning;
    }
}
/**
 * Create a proactive refresh queue instance.
 */
export function createProactiveRefreshQueue(client, providerId, config) {
    return new ProactiveRefreshQueue(client, providerId, config);
}
//# sourceMappingURL=refresh-queue.js.map