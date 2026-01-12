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
import type { PluginClient } from "./types";
type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
    debug(message: string, extra?: Record<string, unknown>): void;
    info(message: string, extra?: Record<string, unknown>): void;
    warn(message: string, extra?: Record<string, unknown>): void;
    error(message: string, extra?: Record<string, unknown>): void;
}
/**
 * Initialize the logger with the plugin client.
 * Must be called during plugin initialization to enable TUI logging.
 */
export declare function initLogger(client: PluginClient): void;
/**
 * Get the current client (for testing or advanced usage).
 */
export declare function getLoggerClient(): PluginClient | null;
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
export declare function createLogger(module: string): Logger;
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
export declare function printAntigravityConsole(level: LogLevel, message: string, extra?: unknown): void;
export {};
//# sourceMappingURL=logger.d.ts.map