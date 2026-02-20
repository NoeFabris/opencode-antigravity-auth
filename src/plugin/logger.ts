/**
 * Structured Logger for Antigravity Plugin
 *
 * Logging behavior:
 * - debug disabled → no logs anywhere
 * - debug enabled → log files only (via debug.ts logWriter)
 * - debug_tui enabled → log files + TUI log panel
 */

import type { PluginClient } from "./types";
import { isDebugTuiEnabled } from "./debug";

type LogLevel = "debug" | "info" | "warn" | "error";

const ANTIGRAVITY_CONSOLE_PREFIX = "[Antigravity]";

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

let _client: PluginClient | null = null;

/**
 * Initialize the logger with the plugin client.
 * Must be called during plugin initialization to enable TUI logging.
 */
export function initLogger(client: PluginClient): void {
  _client = client;
}

/**
 * Get the current client (for testing or advanced usage).
 */
export function getLoggerClient(): PluginClient | null {
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
export function createLogger(module: string): Logger {
  const service = `antigravity.${module}`;

  const log = (level: LogLevel, message: string, extra?: Record<string, unknown>): void => {
    // TUI logging: only when debug TUI is enabled
    if (isDebugTuiEnabled()) {
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
    }

    // If TUI logging is not enabled, log is silently discarded
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
 *
 * Use this for standalone messages that don't belong to a specific module.
 *
 * @param level - Log level
 * @param message - Message to print
 * @param extra - Optional extra data
 */
export function printAntigravityConsole(
  level: LogLevel,
  message: string,
  extra?: unknown,
): void {
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
