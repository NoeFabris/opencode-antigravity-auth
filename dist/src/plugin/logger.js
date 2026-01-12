/**
 * Structured Logger for Antigravity Plugin
 *
 * Provides TUI-integrated logging that is silent by default.
 * Logs are only visible when:
 * 1. TUI client is available (logs to app log panel)
 * 2. OPENCODE_ANTIGRAVITY_CONSOLE_LOG=1 is set (logs to console)
 *
 * Ported from opencode-google-antigravity-auth/src/plugin/logger.ts
 */
const ENV_CONSOLE_LOG = "OPENCODE_ANTIGRAVITY_CONSOLE_LOG";
const ANTIGRAVITY_CONSOLE_PREFIX = "[Antigravity]";
let _client = null;
/**
 * Check if console logging is enabled via environment variable.
 */
function isConsoleLogEnabled() {
    const val = process.env[ENV_CONSOLE_LOG];
    return val === "1" || val?.toLowerCase() === "true";
}
/**
 * Initialize the logger with the plugin client.
 * Must be called during plugin initialization to enable TUI logging.
 */
export function initLogger(client) {
    _client = client;
}
/**
 * Get the current client (for testing or advanced usage).
 */
export function getLoggerClient() {
    return _client;
}
/**
 * Create a logger instance for a specific module.
 *
 * @param module - The module name (e.g., "refresh-queue", "transform.claude")
 * @returns Logger instance with debug, info, warn, error methods
 *
 * @example
 * ```typescript
 * const log = createLogger("refresh-queue");
 * log.debug("Checking tokens", { count: 5 });
 * log.warn("Token expired", { accountIndex: 0 });
 * ```
 */
export function createLogger(module) {
    const service = `antigravity.${module}`;
    const log = (level, message, extra) => {
        // Try TUI logging first
        const app = _client?.app;
        if (app && typeof app.log === "function") {
            app
                .log({
                body: { service, level, message, extra },
            })
                .catch(() => {
                // Silently ignore logging errors
            });
        }
        else if (isConsoleLogEnabled()) {
            // Fallback to console if env var is set
            const prefix = `[${service}]`;
            const args = extra ? [prefix, message, extra] : [prefix, message];
            switch (level) {
                case "debug":
                    console.debug(...args);
                    break;
                case "info":
                    console.info(...args);
                    break;
                case "warn":
                    console.warn(...args);
                    break;
                case "error":
                    console.error(...args);
                    break;
            }
        }
        // If neither TUI nor console logging is enabled, log is silently discarded
    };
    return {
        debug: (message, extra) => log("debug", message, extra),
        info: (message, extra) => log("info", message, extra),
        warn: (message, extra) => log("warn", message, extra),
        error: (message, extra) => log("error", message, extra),
    };
}
/**
 * Print a message to the console with Antigravity prefix.
 * Only outputs when OPENCODE_ANTIGRAVITY_CONSOLE_LOG=1 is set.
 *
 * Use this for standalone messages that don't belong to a specific module.
 *
 * @param level - Log level
 * @param message - Message to print
 * @param extra - Optional extra data
 */
export function printAntigravityConsole(level, message, extra) {
    if (!isConsoleLogEnabled()) {
        return;
    }
    const prefixedMessage = `${ANTIGRAVITY_CONSOLE_PREFIX} ${message}`;
    const args = extra === undefined ? [prefixedMessage] : [prefixedMessage, extra];
    switch (level) {
        case "debug":
            console.debug(...args);
            break;
        case "info":
            console.info(...args);
            break;
        case "warn":
            console.warn(...args);
            break;
        case "error":
            console.error(...args);
            break;
    }
}
//# sourceMappingURL=logger.js.map