import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { homedir } from "node:os";
import type { AntigravityConfig } from "./config";
import {
  deriveDebugPolicy,
  formatAccountContextLabel,
  formatAccountLabel,
  formatBodyPreviewForLog,
  formatErrorForLog,
  isTruthyFlag,
  truncateTextForLog,
} from "./logging-utils";
import { ensureGitignoreSync } from "./storage";

const MAX_BODY_PREVIEW_CHARS = 12000;
const MAX_BODY_LOG_CHARS = 50000;

export const DEBUG_MESSAGE_PREFIX = "[opencode-antigravity-auth debug]";

// =============================================================================
// Debug State (lazily initialized with config)
// =============================================================================

interface DebugState {
  debugEnabled: boolean;
  debugTuiEnabled: boolean;
  logFilePath: string | undefined;
  logWriter: (line: string) => void;
}

let debugState: DebugState | null = null;

/**
 * Get the OS-specific config directory.
 */
function getConfigDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  const xdgConfig = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/**
 * Returns the logs directory, creating it if needed.
 */
function getLogsDir(customLogDir?: string): string {
  const logsDir = customLogDir || join(getConfigDir(), "antigravity-logs");

  try {
    mkdirSync(logsDir, { recursive: true });
  } catch {
    // Directory may already exist or we don't have permission
  }

  return logsDir;
}

/**
 * Builds a timestamped log file path.
 */
function createLogFilePath(customLogDir?: string): string {
  const logsDir = getLogsDir(customLogDir);
  cleanupOldLogs(logsDir, 25);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(logsDir, `antigravity-debug-${timestamp}.log`);
}

/**
 * Cleans up old log files, keeping only the most recent maxFiles.
 */
function cleanupOldLogs(logsDir: string, maxFiles: number): void {
  try {
    const files = readdirSync(logsDir)
      .filter((file) => file.startsWith("antigravity-debug-") && file.endsWith(".log"))
      .map((file) => join(logsDir, file));

    if (files.length <= maxFiles) {
      return;
    }

    const sortedFiles = files
      .map((file) => ({
        file,
        mtime: statSync(file).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    for (let i = maxFiles; i < sortedFiles.length; i++) {
      try {
        unlinkSync(sortedFiles[i]!.file);
      } catch {
        // Ignore deletion errors
      }
    }
  } catch {
    // Ignore directory read errors
  }
}

/**
 * Creates a log writer function that writes to a file.
 */
function createLogWriter(filePath?: string): (line: string) => void {
  if (!filePath) {
    return () => {};
  }

  try {
    const stream = createWriteStream(filePath, { flags: "a" });
    stream.on("error", () => {});
    return (line: string) => {
      const timestamp = new Date().toISOString();
      const formatted = `[${timestamp}] ${line}`;
      stream.write(`${formatted}\n`);
    };
  } catch {
    return () => {};
  }
}

/**
 * Initialize or reinitialize debug state with the given config.
 * Call this once at plugin startup after loading config.
 */
export function initializeDebug(config: AntigravityConfig): void {
  // Config takes precedence, but env var can force enable for debugging
  const envDebugFlag = env.OPENCODE_ANTIGRAVITY_DEBUG ?? "";
  const { debugEnabled } = deriveDebugPolicy({
    configDebug: config.debug,
    configDebugTui: config.debug_tui,
    envDebugFlag,
    envDebugTuiFlag: env.OPENCODE_ANTIGRAVITY_DEBUG_TUI,
  });
  const debugTuiEnabled = config.debug_tui || isTruthyFlag(env.OPENCODE_ANTIGRAVITY_DEBUG_TUI);
  const logFilePath = debugEnabled ? createLogFilePath(config.log_dir) : undefined;
  const logWriter = createLogWriter(logFilePath);

  if (debugEnabled) {
    ensureGitignoreSync(getConfigDir());
  }

  debugState = {
    debugEnabled,
    debugTuiEnabled,
    logFilePath,
    logWriter,
  };
}

/**
 * Get the current debug state, initializing with defaults if needed.
 * This allows the module to work even before initializeDebug is called.
 */
function getDebugState(): DebugState {
  if (!debugState) {
    // Fallback to env-based initialization for backward compatibility
    const { debugEnabled } = deriveDebugPolicy({
      configDebug: false,
      configDebugTui: false,
      envDebugFlag: env.OPENCODE_ANTIGRAVITY_DEBUG,
      envDebugTuiFlag: env.OPENCODE_ANTIGRAVITY_DEBUG_TUI,
    });
    const debugTuiEnabled = isTruthyFlag(env.OPENCODE_ANTIGRAVITY_DEBUG_TUI);
    const logFilePath = debugEnabled ? createLogFilePath() : undefined;
    const logWriter = createLogWriter(logFilePath);

    debugState = {
      debugEnabled,
      debugTuiEnabled,
      logFilePath,
      logWriter,
    };
  }
  return debugState;
}

// =============================================================================
// Public API
// =============================================================================

export function isDebugEnabled(): boolean {
  return getDebugState().debugEnabled;
}

export function isDebugTuiEnabled(): boolean {
  return getDebugState().debugTuiEnabled;
}

export function getLogFilePath(): string | undefined {
  return getDebugState().logFilePath;
}

export interface AntigravityDebugContext {
  id: string;
  streaming: boolean;
  startedAt: number;
}

interface AntigravityDebugRequestMeta {
  originalUrl: string;
  resolvedUrl: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  streaming: boolean;
  projectId?: string;
}

interface AntigravityDebugResponseMeta {
  body?: string;
  note?: string;
  error?: unknown;
  headersOverride?: HeadersInit;
}

let requestCounter = 0;

/**
 * Begins a debug trace for an Antigravity request.
 */
export function startAntigravityDebugRequest(meta: AntigravityDebugRequestMeta): AntigravityDebugContext | null {
  const state = getDebugState();
  if (!state.debugEnabled) {
    return null;
  }

  const id = `ANTIGRAVITY-${++requestCounter}`;
  const method = meta.method ?? "GET";
  logDebug(`[Antigravity Debug ${id}] pid=${process.pid} ${method} ${meta.resolvedUrl}`);
  if (meta.originalUrl && meta.originalUrl !== meta.resolvedUrl) {
    logDebug(`[Antigravity Debug ${id}] Original URL: ${meta.originalUrl}`);
  }
  if (meta.projectId) {
    logDebug(`[Antigravity Debug ${id}] Project: ${meta.projectId}`);
  }
  logDebug(`[Antigravity Debug ${id}] Streaming: ${meta.streaming ? "yes" : "no"}`);
  logDebug(`[Antigravity Debug ${id}] Headers: ${JSON.stringify(maskHeaders(meta.headers))}`);
  const bodyPreview = formatBodyPreviewForLog(meta.body, MAX_BODY_PREVIEW_CHARS);
  if (bodyPreview) {
    logDebug(`[Antigravity Debug ${id}] Body Preview: ${bodyPreview}`);
  }

  return { id, streaming: meta.streaming, startedAt: Date.now() };
}

/**
 * Logs response details for a previously started debug trace.
 */
export function logAntigravityDebugResponse(
  context: AntigravityDebugContext | null | undefined,
  response: Response,
  meta: AntigravityDebugResponseMeta = {},
): void {
  const state = getDebugState();
  if (!state.debugEnabled || !context) {
    return;
  }

  const durationMs = Date.now() - context.startedAt;
  logDebug(
    `[Antigravity Debug ${context.id}] Response ${response.status} ${response.statusText} (${durationMs}ms)`,
  );
  logDebug(
    `[Antigravity Debug ${context.id}] Response Headers: ${JSON.stringify(
      maskHeaders(meta.headersOverride ?? response.headers),
    )}`,
  );

  if (meta.note) {
    logDebug(`[Antigravity Debug ${context.id}] Note: ${meta.note}`);
  }

  if (meta.error) {
    logDebug(`[Antigravity Debug ${context.id}] Error: ${formatErrorForLog(meta.error)}`);
  }

  if (meta.body) {
    logDebug(
      `[Antigravity Debug ${context.id}] Response Body Preview: ${truncateTextForLog(meta.body, MAX_BODY_PREVIEW_CHARS)}`,
    );
  }
}

/**
 * Obscures sensitive headers and returns a plain object for logging.
 */
function maskHeaders(headers?: HeadersInit | Headers): Record<string, string> {
  if (!headers) {
    return {};
  }

  const REDACTED_HEADERS = new Set(["authorization", "x-goog-api-key"]);
  const result: Record<string, string> = {};
  const parsed = headers instanceof Headers ? headers : new Headers(headers);
  parsed.forEach((value, key) => {
    if (REDACTED_HEADERS.has(key.toLowerCase())) {
      result[key] = "[redacted]";
    } else {
      result[key] = value;
    }
  });
  return result;
}

/**
 * Writes a single debug line using the configured writer.
 */
function logDebug(line: string): void {
  getDebugState().logWriter(line);
}

function runWithDebugEnabled(action: () => void): void {
  if (!getDebugState().debugEnabled) return;
  action();
}

export interface AccountDebugInfo {
  index: number;
  email?: string;
  family: string;
  totalAccounts: number;
  rateLimitState?: { claude?: number; gemini?: number };
}

export function logAccountContext(label: string, info: AccountDebugInfo): void {
  runWithDebugEnabled(() => {
    const accountLabel = formatAccountContextLabel(info.email, info.index);

    const indexLabel = info.index >= 0 ? `${info.index + 1}/${info.totalAccounts}` : `-/${info.totalAccounts}`;

    let rateLimitInfo = "";
    if (info.rateLimitState && Object.keys(info.rateLimitState).length > 0) {
      const now = Date.now();
      const activeRateLimits: Record<string, string> = {};
      for (const [key, resetTime] of Object.entries(info.rateLimitState)) {
        if (typeof resetTime === "number" && resetTime > now) {
          const remainingSec = Math.ceil((resetTime - now) / 1000);
          activeRateLimits[key] = `${remainingSec}s`;
        }
      }
      if (Object.keys(activeRateLimits).length > 0) {
        rateLimitInfo = ` rateLimits=${JSON.stringify(activeRateLimits)}`;
      }
    }

    logDebug(`[Account] ${label}: ${accountLabel} (${indexLabel}) family=${info.family}${rateLimitInfo}`);
  });
}

export function logRateLimitEvent(
  accountIndex: number,
  email: string | undefined,
  family: string,
  status: number,
  retryAfterMs: number,
  bodyInfo: { message?: string; quotaResetTime?: string; retryDelayMs?: number | null; reason?: string },
): void {
  runWithDebugEnabled(() => {
    const accountLabel = formatAccountLabel(email, accountIndex);
    logDebug(`[RateLimit] ${status} on ${accountLabel} family=${family} retryAfterMs=${retryAfterMs}`);
    if (bodyInfo.message) {
      logDebug(`[RateLimit] message: ${bodyInfo.message}`);
    }
    if (bodyInfo.quotaResetTime) {
      logDebug(`[RateLimit] quotaResetTime: ${bodyInfo.quotaResetTime}`);
    }
    if (bodyInfo.retryDelayMs !== undefined && bodyInfo.retryDelayMs !== null) {
      logDebug(`[RateLimit] body retryDelayMs: ${bodyInfo.retryDelayMs}`);
    }
    if (bodyInfo.reason) {
      logDebug(`[RateLimit] reason: ${bodyInfo.reason}`);
    }
  });
}

export function logRateLimitSnapshot(
  family: string,
  accounts: Array<{ index: number; email?: string; rateLimitResetTimes?: { claude?: number; gemini?: number } }>,
): void {
  runWithDebugEnabled(() => {
    const now = Date.now();
    const entries = accounts.map((account) => {
      const label = formatAccountLabel(account.email, account.index);
      const reset = account.rateLimitResetTimes?.[family as "claude" | "gemini"];
      if (typeof reset !== "number") {
        return `${label}=ready`;
      }
      const remaining = Math.max(0, reset - now);
      const seconds = Math.ceil(remaining / 1000);
      return `${label}=wait ${seconds}s`;
    });
    logDebug(`[RateLimit] snapshot family=${family} ${entries.join(" | ")}`);
  });
}

export async function logResponseBody(
  context: AntigravityDebugContext | null | undefined,
  response: Response,
  status: number,
): Promise<string | undefined> {
  const state = getDebugState();
  if (!state.debugEnabled || !context) return undefined;

  try {
    const text = await response.clone().text();
    const preview = truncateTextForLog(text, MAX_BODY_LOG_CHARS);
    logDebug(`[Antigravity Debug ${context.id}] Response Body (${status}): ${preview}`);
    return text;
  } catch (e) {
    logDebug(`[Antigravity Debug ${context.id}] Failed to read response body: ${formatErrorForLog(e)}`);
    return undefined;
  }
}

export function logModelFamily(url: string, extractedModel: string | null, family: string): void {
  runWithDebugEnabled(() => {
    logDebug(`[ModelFamily] url=${url} model=${extractedModel ?? "unknown"} family=${family}`);
  });
}

export function debugLogToFile(message: string): void {
  runWithDebugEnabled(() => {
    logDebug(message);
  });
}

/**
 * Logs a toast message to the debug file.
 * This helps correlate what the user saw with debug events.
 */
export function logToast(message: string, variant: "info" | "warning" | "success" | "error"): void {
  runWithDebugEnabled(() => {
    const variantLabel = variant.toUpperCase();
    logDebug(`[Toast/${variantLabel}] ${message}`);
  });
}

/**
 * Logs retry attempt information.
 * @param maxAttempts - Use -1 for unlimited retries
 */
export function logRetryAttempt(
  attempt: number,
  maxAttempts: number,
  reason: string,
  delayMs?: number,
): void {
  runWithDebugEnabled(() => {
    const delayInfo = delayMs !== undefined ? ` delay=${delayMs}ms` : "";
    const maxInfo = maxAttempts < 0 ? "∞" : maxAttempts.toString();
    logDebug(`[Retry] Attempt ${attempt}/${maxInfo} reason=${reason}${delayInfo}`);
  });
}

/**
 * Logs cache hit/miss information from response usage metadata.
 */
export function logCacheStats(
  model: string,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  totalInputTokens: number,
): void {
  runWithDebugEnabled(() => {
    const cacheHitRate = totalInputTokens > 0 
      ? Math.round((cacheReadTokens / totalInputTokens) * 100) 
      : 0;
    const status = cacheReadTokens > 0 ? "HIT" : (cacheWriteTokens > 0 ? "WRITE" : "MISS");
    logDebug(`[Cache] ${status} model=${model} read=${cacheReadTokens} write=${cacheWriteTokens} total=${totalInputTokens} hitRate=${cacheHitRate}%`);
  });
}

/**
 * Logs quota status for an account.
 */
export function logQuotaStatus(
  accountEmail: string | undefined,
  accountIndex: number,
  quotaPercent: number,
  family?: string,
): void {
  runWithDebugEnabled(() => {
    const accountLabel = formatAccountLabel(accountEmail, accountIndex);
    const familyInfo = family ? ` family=${family}` : "";
    const status = quotaPercent <= 0 ? "EXHAUSTED" : quotaPercent < 20 ? "LOW" : "OK";
    logDebug(`[Quota] ${accountLabel} remaining=${quotaPercent.toFixed(1)}% status=${status}${familyInfo}`);
  });
}

/**
 * Logs background quota fetch events.
 */
export function logQuotaFetch(
  event: "start" | "complete" | "error",
  accountCount?: number,
  details?: string,
): void {
  runWithDebugEnabled(() => {
    const countInfo = accountCount !== undefined ? ` accounts=${accountCount}` : "";
    const detailsInfo = details ? ` ${details}` : "";
    logDebug(`[QuotaFetch] ${event.toUpperCase()}${countInfo}${detailsInfo}`);
  });
}

/**
 * Logs which model is being used for a request.
 */
export function logModelUsed(
  requestedModel: string,
  actualModel: string,
  accountEmail?: string,
): void {
  runWithDebugEnabled(() => {
    const accountInfo = accountEmail ? ` account=${accountEmail}` : "";
    if (requestedModel !== actualModel) {
      logDebug(`[Model] requested=${requestedModel} actual=${actualModel}${accountInfo}`);
    } else {
      logDebug(`[Model] ${actualModel}${accountInfo}`);
    }
  });
}

/**
 * Logs credit cost from ChatModelMetadata per generation call.
 */
export function logCreditCost(
  model: string,
  creditCost: number,
  totalCredits?: number,
): void {
  runWithDebugEnabled(() => {
    const totalInfo = totalCredits !== undefined ? ` totalCredits=${totalCredits}` : ""
    logDebug(`[Credit] model=${model} cost=${creditCost}${totalInfo}`)
  })
}

/**
 * Logs subscription tier for an account.
 */
export function logSubscriptionTier(
  accountEmail: string | undefined,
  tier: string,
  tierId: string | null,
): void {
  runWithDebugEnabled(() => {
    const emailInfo = accountEmail ? ` account=${accountEmail}` : ""
    logDebug(`[Subscription] tier=${tier} tierId=${tierId}${emailInfo}`)
  })
}

// =============================================================================
// Rotation / Fallback Observability
//
// All public debug log helpers below self-gate via runWithDebugEnabled().
// Callers may invoke them unconditionally — they are no-ops when debug is off.
// =============================================================================

/**
 * Logs an account rotation decision (selection, switch, or failure).
 *
 * @param event - "selected" | "switched" | "skipped" | "exhausted"
 * @param accountIndex - 0-based index of the account involved (-1 = all)
 * @param accountEmail - Redacted account identifier (email or undefined)
 * @param totalAccounts - Total number of enabled accounts in the pool
 * @param reason - Human-readable reason for the event
 * @param extra - Optional extra key=value pairs appended verbatim
 */
export function logAccountRotation(
  event: "selected" | "switched" | "skipped" | "exhausted",
  accountIndex: number,
  accountEmail: string | undefined,
  totalAccounts: number,
  reason: string,
  extra?: string,
): void {
  runWithDebugEnabled(() => {
    const accountLabel = formatAccountLabel(accountEmail, accountIndex)
    const indexLabel = accountIndex >= 0 ? `${accountIndex + 1}/${totalAccounts}` : `-/${totalAccounts}`
    const extraInfo = extra ? ` ${extra}` : ""
    logDebug(`[Rotation/${event.toUpperCase()}] ${accountLabel} (${indexLabel}) reason=${reason}${extraInfo}`)
  })
}

/**
 * Logs a header pool switch (antigravity ↔ gemini-cli).
 *
 * @param accountIndex - 0-based index of the account
 * @param accountEmail - Account identifier
 * @param from - Previous header style
 * @param to - New header style
 * @param reason - Why the switch happened
 */
export function logHeaderPoolSwitch(
  accountIndex: number,
  accountEmail: string | undefined,
  from: string,
  to: string,
  reason: string,
): void {
  runWithDebugEnabled(() => {
    const accountLabel = formatAccountLabel(accountEmail, accountIndex)
    logDebug(`[HeaderPool] ${accountLabel} from=${from} to=${to} reason=${reason}`)
  })
}

/**
 * Logs a fingerprint regeneration event.
 *
 * @param event - "regenerated"
 * @param accountIndex - 0-based index of the account
 * @param accountEmail - Account identifier
 * @param reason - Why the fingerprint was regenerated
 * @param deviceIdPrefix - First 8 chars of new device ID (safe partial, not full UUID)
 */
export function logFingerprintEvent(
  event: "regenerated",
  accountIndex: number,
  accountEmail: string | undefined,
  reason: string,
  deviceIdPrefix?: string,
): void {
  runWithDebugEnabled(() => {
    const accountLabel = formatAccountLabel(accountEmail, accountIndex)
    const deviceInfo = deviceIdPrefix ? ` newDeviceId=${deviceIdPrefix}...` : ""
    logDebug(`[Fingerprint/${event.toUpperCase()}] ${accountLabel} reason=${reason}${deviceInfo}`)
  })
}

/**
 * Logs a token refresh event.
 *
 * @param event - "started" | "success" | "failed"
 * @param accountIndex - 0-based index of the account
 * @param accountEmail - Account identifier
 * @param reason - Why refresh was triggered or what failed
 */
export function logTokenRefresh(
  event: "started" | "success" | "failed",
  accountIndex: number,
  accountEmail: string | undefined,
  reason?: string,
): void {
  runWithDebugEnabled(() => {
    const accountLabel = formatAccountLabel(accountEmail, accountIndex)
    const reasonInfo = reason ? ` reason=${reason}` : ""
    logDebug(`[TokenRefresh/${event.toUpperCase()}] ${accountLabel}${reasonInfo}`)
  })
}

/**
 * Logs a model fallback event (e.g. Claude → Gemini due to quota/error).
 *
 * @param requestedModel - The model originally requested by the caller
 * @param effectiveModel - The model actually used after fallback
 * @param reason - Why the fallback occurred
 * @param accountIndex - Optional account index for context
 */
export function logModelFallback(
  requestedModel: string,
  effectiveModel: string,
  reason: string,
  accountIndex?: number,
): void {
  runWithDebugEnabled(() => {
    const accountInfo = accountIndex !== undefined ? ` account=${accountIndex + 1}` : ""
    logDebug(`[ModelFallback] requested=${requestedModel} effective=${effectiveModel} reason=${reason}${accountInfo}`)
  })
}
