/**
 * Structured Logger for Antigravity Plugin
 *
 * Logging behavior:
 * - debug disabled → no logs anywhere
 * - debug enabled → log files only (via debug.ts logWriter)
 * - debug_tui enabled → log files + TUI log panel
 * - OPENCODE_ANTIGRAVITY_CONSOLE_LOG=1 → console output (independent of debug flags)
 */

import type { PluginClient } from "./types";
import { isDebugTuiEnabled } from "./debug";
import {
  isTruthyFlag,
  writeConsoleLog,
} from "./logging-utils";

type LogLevel = "debug" | "info" | "warn" | "error";

const ENV_CONSOLE_LOG = "OPENCODE_ANTIGRAVITY_CONSOLE_LOG";
const ANTIGRAVITY_CONSOLE_PREFIX = "[Antigravity]";

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

let _client: PluginClient | null = null;

/**
 * Check if console logging is enabled via environment variable.
 */
function isConsoleLogEnabled(): boolean {
  return isTruthyFlag(process.env[ENV_CONSOLE_LOG]);
}

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

    // Console fallback: when env var is set (independent of debug flags)
    if (isConsoleLogEnabled()) {
      const prefix = `[${service}]`;
      const args = extra ? [prefix, message, extra] : [prefix, message];
      writeConsoleLog(level, ...args);
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
export function printAntigravityConsole(
  level: LogLevel,
  message: string,
  extra?: unknown,
): void {
  if (!isConsoleLogEnabled()) {
    return;
  }

  const prefixedMessage = `${ANTIGRAVITY_CONSOLE_PREFIX} ${message}`;
  const args = extra === undefined ? [prefixedMessage] : [prefixedMessage, extra];

  writeConsoleLog(level, ...args);
}
