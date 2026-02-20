import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { homedir } from "node:os";
import type { AntigravityConfig } from "./config";
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
  const debugEnabled = Boolean(config.debug);
  const debugTuiEnabled = debugEnabled && config.debug_tui;
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
    debugState = {
      debugEnabled: false,
      debugTuiEnabled: false,
      logFilePath: undefined,
      logWriter: createLogWriter(),
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
  const bodyPreview = formatBodyPreview(meta.body);
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
    logDebug(`[Antigravity Debug ${context.id}] Error: ${formatError(meta.error)}`);
  }

  if (meta.body) {
    logDebug(
      `[Antigravity Debug ${context.id}] Response Body Preview: ${truncateForLog(meta.body)}`,
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

  const result: Record<string, string> = {};
  const parsed = headers instanceof Headers ? headers : new Headers(headers);
  parsed.forEach((value, key) => {
    if (key.toLowerCase() === "authorization") {
      result[key] = "[redacted]";
    } else {
      result[key] = value;
    }
  });
  return result;
}

/**
 * Produces a short, type-aware preview of a request/response body for logs.
 */
function formatBodyPreview(body?: BodyInit | null): string | undefined {
  if (body == null) {
    return undefined;
  }

  if (typeof body === "string") {
    return truncateForLog(body);
  }

  if (body instanceof URLSearchParams) {
    return truncateForLog(body.toString());
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return `[Blob size=${body.size}]`;
  }

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return "[FormData payload omitted]";
  }

  return `[${body.constructor?.name ?? typeof body} payload omitted]`;
}

/**
 * Truncates long strings to a fixed preview length for logging.
 */
function truncateForLog(text: string): string {
  if (text.length <= MAX_BODY_PREVIEW_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_BODY_PREVIEW_CHARS)}... (truncated ${text.length - MAX_BODY_PREVIEW_CHARS} chars)`;
}

/**
 * Writes a single debug line using the configured writer.
 */
function logDebug(line: string): void {
  getDebugState().logWriter(line);
}

/**
 * Converts unknown error-like values into printable strings.
 */
function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export interface AccountDebugInfo {
  index: number;
  email?: string;
  family: string;
  totalAccounts: number;
  rateLimitState?: { claude?: number; gemini?: number };
}

export function logAccountContext(label: string, info: AccountDebugInfo): void {
  if (!getDebugState().debugEnabled) return;

  const accountLabel = info.email
    ? info.email
    : info.index >= 0
      ? `Account ${info.index + 1}`
      : "All accounts";

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
}

export function logRateLimitEvent(
  accountIndex: number,
  email: string | undefined,
  family: string,
  status: number,
  retryAfterMs: number,
  bodyInfo: { message?: string; quotaResetTime?: string; retryDelayMs?: number | null; reason?: string },
): void {
  if (!getDebugState().debugEnabled) return;
  const accountLabel = email || `Account ${accountIndex + 1}`;
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
}

export function logRateLimitSnapshot(
  family: string,
  accounts: Array<{ index: number; email?: string; rateLimitResetTimes?: { claude?: number; gemini?: number } }>,
): void {
  if (!getDebugState().debugEnabled) return;
  const now = Date.now();
  const entries = accounts.map((account) => {
    const label = account.email ? account.email : `Account ${account.index + 1}`;
    const reset = account.rateLimitResetTimes?.[family as "claude" | "gemini"];
    if (typeof reset !== "number") {
      return `${label}=ready`;
    }
    const remaining = Math.max(0, reset - now);
    const seconds = Math.ceil(remaining / 1000);
    return `${label}=wait ${seconds}s`;
  });
  logDebug(`[RateLimit] snapshot family=${family} ${entries.join(" | ")}`);
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
    const maxChars = MAX_BODY_LOG_CHARS;
    const preview = text.length <= maxChars
      ? text
      : `${text.slice(0, maxChars)}... (truncated ${text.length - maxChars} chars)`;
    logDebug(`[Antigravity Debug ${context.id}] Response Body (${status}): ${preview}`);
    return text;
  } catch (e) {
    logDebug(`[Antigravity Debug ${context.id}] Failed to read response body: ${formatError(e)}`);
    return undefined;
  }
}

export function logModelFamily(url: string, extractedModel: string | null, family: string): void {
  if (!getDebugState().debugEnabled) return;
  logDebug(`[ModelFamily] url=${url} model=${extractedModel ?? "unknown"} family=${family}`);
}

export function debugLogToFile(message: string): void {
  if (!getDebugState().debugEnabled) return;
  logDebug(message);
}

/**
 * Logs a toast message to the debug file.
 * This helps correlate what the user saw with debug events.
 */
export function logToast(message: string, variant: "info" | "warning" | "success" | "error"): void {
  if (!getDebugState().debugEnabled) return;
  const variantLabel = variant.toUpperCase();
  logDebug(`[Toast/${variantLabel}] ${message}`);
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
  if (!getDebugState().debugEnabled) return;
  const delayInfo = delayMs !== undefined ? ` delay=${delayMs}ms` : "";
  const maxInfo = maxAttempts < 0 ? "∞" : maxAttempts.toString();
  logDebug(`[Retry] Attempt ${attempt}/${maxInfo} reason=${reason}${delayInfo}`);
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
  if (!getDebugState().debugEnabled) return;
  const cacheHitRate = totalInputTokens > 0
    ? Math.round((cacheReadTokens / totalInputTokens) * 100)
    : 0;
  const status = cacheReadTokens > 0 ? "HIT" : (cacheWriteTokens > 0 ? "WRITE" : "MISS");
  logDebug(`[Cache] ${status} model=${model} read=${cacheReadTokens} write=${cacheWriteTokens} total=${totalInputTokens} hitRate=${cacheHitRate}%`);
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
  if (!getDebugState().debugEnabled) return;
  const accountLabel = accountEmail || `Account ${accountIndex + 1}`;
  const familyInfo = family ? ` family=${family}` : "";
  const status = quotaPercent <= 0 ? "EXHAUSTED" : quotaPercent < 20 ? "LOW" : "OK";
  logDebug(`[Quota] ${accountLabel} remaining=${quotaPercent.toFixed(1)}% status=${status}${familyInfo}`);
}

/**
 * Logs background quota fetch events.
 */
export function logQuotaFetch(
  event: "start" | "complete" | "error",
  accountCount?: number,
  details?: string,
): void {
  if (!getDebugState().debugEnabled) return;
  const countInfo = accountCount !== undefined ? ` accounts=${accountCount}` : "";
  const detailsInfo = details ? ` ${details}` : "";
  logDebug(`[QuotaFetch] ${event.toUpperCase()}${countInfo}${detailsInfo}`);
}

/**
 * Logs which model is being used for a request.
 */
export function logModelUsed(
  requestedModel: string,
  actualModel: string,
  accountEmail?: string,
): void {
  if (!getDebugState().debugEnabled) return;
  const accountInfo = accountEmail ? ` account=${accountEmail}` : "";
  if (requestedModel !== actualModel) {
    logDebug(`[Model] requested=${requestedModel} actual=${actualModel}${accountInfo}`);
  } else {
    logDebug(`[Model] ${actualModel}${accountInfo}`);
  }
}
