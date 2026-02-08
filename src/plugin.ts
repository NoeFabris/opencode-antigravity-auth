import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import { tool } from "@opencode-ai/plugin";
import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_HEADERS,
  ANTIGRAVITY_PROVIDER_ID,
  type HeaderStyle,
} from "./constants";
import { authorizeAntigravity, exchangeAntigravity } from "./antigravity/oauth";
import type { AntigravityTokenExchangeResult } from "./antigravity/oauth";
import { accessTokenExpired, formatRefreshParts, isOAuthAuth, parseRefreshParts } from "./plugin/auth";
import { promptAddAnotherAccount, promptLoginMode, promptProjectId } from "./plugin/cli";
import { ensureProjectContext } from "./plugin/project";
import {
  startAntigravityDebugRequest, 
  logAntigravityDebugResponse,
  logAccountContext,
  logRateLimitEvent,
  logRateLimitSnapshot,
  logResponseBody,
  logModelFamily,
  isDebugEnabled,
  getLogFilePath,
  initializeDebug,
} from "./plugin/debug";
import {
  buildThinkingWarmupBody,
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from "./plugin/request";
import { resolveModelWithTier } from "./plugin/transform/model-resolver";
import {
  isEmptyResponseBody,
  createSyntheticErrorResponse,
} from "./plugin/request-helpers";
import { EmptyResponseError } from "./plugin/errors";
import { AntigravityTokenRefreshError, refreshAccessToken } from "./plugin/token";
import { startOAuthListener, type OAuthListener } from "./plugin/server";
import {
  clearAccounts,
  clearBlockedAccounts,
  loadAccounts,
  loadBlockedAccounts,
  saveAccounts,
  saveBlockedAccounts,
} from "./plugin/storage";
import { AccountManager, type ModelFamily, parseRateLimitReason, calculateBackoffMs } from "./plugin/accounts";
import { createAutoUpdateCheckerHook } from "./hooks/auto-update-checker";
import { loadConfig, initRuntimeConfig, type AntigravityConfig } from "./plugin/config";
import { createSessionRecoveryHook, getRecoverySuccessToast } from "./plugin/recovery";
import { checkAccountsQuota, type AccountQuotaResult } from "./plugin/quota";
import { initDiskSignatureCache } from "./plugin/cache";
import { createProactiveRefreshQueue, type ProactiveRefreshQueue } from "./plugin/refresh-queue";
import { initLogger, createLogger } from "./plugin/logger";
import { initHealthTracker, getHealthTracker, initTokenTracker, getTokenTracker } from "./plugin/rotation";
import { executeSearch } from "./plugin/search";
import { select, type MenuItem } from "./plugin/ui/select";
import type {
  GetAuth,
  LoaderResult,
  OAuthAuthDetails,
  PluginClient,
  PluginContext,
  PluginResult,
  ProjectContextResult,
  Provider,
} from "./plugin/types";

const MAX_OAUTH_ACCOUNTS = 10;
const MAX_WARMUP_SESSIONS = 1000;
const MAX_WARMUP_RETRIES = 2;
const CAPACITY_BACKOFF_TIERS_MS = [5000, 10000, 20000, 30000, 60000];

function getCapacityBackoffDelay(consecutiveFailures: number): number {
  const index = Math.min(consecutiveFailures, CAPACITY_BACKOFF_TIERS_MS.length - 1);
  return CAPACITY_BACKOFF_TIERS_MS[Math.max(0, index)] ?? 5000;
}
const warmupAttemptedSessionIds = new Set<string>();
const warmupSucceededSessionIds = new Set<string>();

const log = createLogger("plugin");

// Used to filter toasts based on toast_scope config.
let isChildSession = false;
let childSessionParentID: string | undefined = undefined;

function summarizeUpstreamValidationMessage(message: string): string {
  const raw = (message || "").trim();
  if (!raw) return "403 VALIDATION_REQUIRED (Antigravity)";

  // Strip any appended debug sections and links; the actionable link is handled separately.
  const withoutDebug = raw.split(/\n\s*\[Debug Info\][\s\S]*$/i)[0]?.trim() ?? raw;
  const firstLine = withoutDebug.split(/\r?\n/).find((l) => l.trim())?.trim() ?? withoutDebug;
  const withoutUrls = firstLine.replace(/https?:\/\/\S+/gi, "[link]");

  // Keep it terse; the user already knows it is a verification error.
  return withoutUrls.length > 160 ? `${withoutUrls.slice(0, 157)}...` : withoutUrls;
}

function isGeminiCodeAssistLicenseError(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  // Observed upstream error: "lack a Gemini Code Assist license... (#3501)"
  return (
    t.includes("#3501")
    || (t.includes("gemini code assist") && t.includes("license"))
    || t.includes("lack a gemini code assist license")
  );
}

function summarizeUpstreamLicenseMessage(message: string): string {
  const raw = (message || "").trim();
  if (!raw) return "Gemini Code Assist license missing (#3501)";
  const withoutDebug = raw.split(/\n\s*\[Debug Info\][\s\S]*$/i)[0]?.trim() ?? raw;
  const firstLine = withoutDebug.split(/\r?\n/).find((l) => l.trim())?.trim() ?? withoutDebug;
  return firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine;
}

const GEMINI_AUTH_SUCCESS_URL = "https://developers.google.com/gemini-code-assist/auth/auth_success_gemini";

function isGoogleAccountsHost(hostname: string): boolean {
  const h = (hostname || "").toLowerCase();
  return h === "accounts.google.com" || h.endsWith(".accounts.google.com");
}

function ensureSigninContinueUrl(url: URL): URL {
  const out = new URL(url.toString());
  if (!out.searchParams.get("sarp")) out.searchParams.set("sarp", "1");
  if (!out.searchParams.get("scc")) out.searchParams.set("scc", "1");
  if (!out.searchParams.get("continue")) out.searchParams.set("continue", GEMINI_AUTH_SUCCESS_URL);
  if (!out.searchParams.get("flowName")) out.searchParams.set("flowName", "GlifWebSignIn");
  return out;
}

function cleanAuthuserValue(input: string | null | undefined): string {
  const raw = (input || "").trim();
  if (!raw) return "";
  return raw.replace(/^[\s"',]+|[\s"',]+$/g, "");
}

function sanitizeGoogleSigninParams(url: URL, accountEmail?: string): URL {
  const out = new URL(url.toString());

  // Some upstream responses occasionally include malformed authuser keys like
  // `authuser%2522%2C`, which can lead to broken 400 links in browsers.
  const weirdAuthuserKeys: string[] = [];
  for (const [key, value] of out.searchParams.entries()) {
    const normalizedKey = key.toLowerCase().replace(/%25/g, "%");
    if (normalizedKey.startsWith("authuser") && key !== "authuser") {
      weirdAuthuserKeys.push(key);
      const cleaned = cleanAuthuserValue(value);
      if (cleaned && !out.searchParams.get("authuser")) {
        out.searchParams.set("authuser", cleaned);
      }
    }
  }
  for (const key of weirdAuthuserKeys) {
    out.searchParams.delete(key);
  }

  const cleanedAuthuser = cleanAuthuserValue(out.searchParams.get("authuser"));
  if (cleanedAuthuser) {
    out.searchParams.set("authuser", cleanedAuthuser);
  } else {
    out.searchParams.delete("authuser");
  }

  if (accountEmail && accountEmail.trim()) {
    const trimmedEmail = accountEmail.trim();
    if (!out.searchParams.get("Email")) out.searchParams.set("Email", trimmedEmail);
    if (!out.searchParams.get("authuser")) out.searchParams.set("authuser", trimmedEmail);
  }

  return out;
}

function normalizeGoogleVerificationUrl(rawUrl: string, accountEmail?: string): string {
  const raw = (rawUrl || "").trim();
  if (!raw) return "";

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }

  if (!isGoogleAccountsHost(parsed.hostname)) {
    return raw;
  }

  const path = parsed.pathname.toLowerCase();

  // Keep Google-provided sign-in links intact; they often include opaque tokens
  // (e.g. `plt=`) and rewriting them into synthesized chooser links can break flow.
  if (path.includes("/signin/continue")) {
    return ensureSigninContinueUrl(sanitizeGoogleSigninParams(parsed, accountEmail)).toString();
  }

  if (path.includes("/accountchooser")) {
    const nested = parsed.searchParams.get("continue");
    if (nested) {
      try {
        const nestedUrl = new URL(nested);
        if (isGoogleAccountsHost(nestedUrl.hostname) && nestedUrl.pathname.toLowerCase().includes("/signin/continue")) {
          parsed.searchParams.set("continue", ensureSigninContinueUrl(nestedUrl).toString());
        }
      } catch {
        // Keep existing continue param when it is not parseable.
      }
    }

    if (accountEmail && !parsed.searchParams.get("Email")) {
      parsed.searchParams.set("Email", accountEmail);
    }

    return sanitizeGoogleSigninParams(parsed, accountEmail).toString();
  }

  return raw;
}

function buildGoogleSigninFirstUrl(verificationUrl: string, accountEmail?: string): string {
  const verify = (verificationUrl || "").trim();
  if (!verify) return "";

  try {
    const continueUrl = new URL(verify).toString();
    // Force add-session flow so browser consistently prompts sign-in first,
    // then redirects to the verification continue URL after authentication.
    const signin = new URL("https://accounts.google.com/signin/v2/identifier");
    signin.searchParams.set("continue", continueUrl);
    signin.searchParams.set("followup", continueUrl);
    signin.searchParams.set("service", "mail");
    signin.searchParams.set("emr", "1");
    signin.searchParams.set("flowName", "GlifWebSignIn");
    signin.searchParams.set("flowEntry", "AddSession");
    if (accountEmail && accountEmail.trim()) {
      const trimmedEmail = accountEmail.trim();
      signin.searchParams.set("Email", trimmedEmail);
      signin.searchParams.set("login_hint", trimmedEmail);
    }
    return signin.toString();
  } catch {
    return verify;
  }
}

type VerificationScanStatus = "ok" | "blocked" | "license" | "error" | "skipped";

type VerificationAccountOrigin = "active" | "quarantined";

type VerificationScanResult = {
  index: number;
  origin: VerificationAccountOrigin;
  refreshToken: string;
  email?: string;
  enabled: boolean;
  status: VerificationScanStatus;
  message?: string;
  verifyUrl?: string;
};

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function extractValidationUrlAndMessage(
  bodyText: string,
  accountEmail?: string,
): { isValidationRequired: boolean; validationUrl?: string; message?: string } {
  let upstreamMessage = bodyText;
  const urlCandidates: string[] = [];
  let isValidationRequired = false;

  const normalizeUrlCandidate = (input: string): string => {
    let out = input.trim();
    if (!out) return "";

    // Common HTML entity in some upstream logs.
    out = out.replace(/&amp;/g, "&");

    // If we captured a JSON-escaped URL string (e.g. "...sarp=1\\u0026scc=1..."),
    // decode any \uXXXX sequences to avoid broken links (400 malformed request).
    // Apply twice to handle rare double-escaped strings.
    for (let i = 0; i < 2; i++) {
      const next = out.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => {
        const code = Number.parseInt(hex, 16);
        return Number.isFinite(code) ? String.fromCharCode(code) : _m;
      });
      if (next === out) break;
      out = next;
    }

    return normalizeGoogleVerificationUrl(out, accountEmail);
  };

  const pushUrlCandidate = (input: string) => {
    const normalized = normalizeUrlCandidate(input);
    if (!normalized) return;
    urlCandidates.push(normalized);
  };

  const collectFromParsed = (parsed: any) => {
    if (!parsed || typeof parsed !== "object") return;

    if (typeof parsed?.error?.message === "string") {
      upstreamMessage = parsed.error.message;
    }

    const details = parsed?.error?.details;
    if (!Array.isArray(details)) return;

    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      if (typeof detail?.reason === "string" && detail.reason.toUpperCase() === "VALIDATION_REQUIRED") {
        isValidationRequired = true;
      }
      const metadata = detail?.metadata;
      const url = metadata?.validation_url ?? metadata?.validationUrl ?? metadata?.validationURL;
      if (typeof url === "string" && url.trim()) {
        pushUrlCandidate(url);
      }
    }
  };

  // Some endpoints return `text/event-stream` (SSE) even for errors (403 VALIDATION_REQUIRED).
  // Parse both raw JSON and SSE `data:` lines to capture the full validation_url (often includes `plt=`).
  try {
    collectFromParsed(JSON.parse(bodyText));
  } catch {
    // ignore JSON parsing; fall back to SSE + string scanning below
  }

  for (const line of bodyText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      collectFromParsed(JSON.parse(payload));
    } catch {
      // ignore malformed SSE chunks
    }
  }

  const lower = `${upstreamMessage}\n${bodyText}`.toLowerCase();
  if (
    lower.includes("validation_required") ||
    lower.includes("verify your account") ||
    lower.includes("verify your google account")
  ) {
    isValidationRequired = true;
  }

  const combined = `${upstreamMessage}\n${bodyText}`;
  for (const match of combined.matchAll(/https?:\/\/accounts\.google\.com\/\S+/gi)) {
    const raw = match[0]?.trim();
    if (!raw) continue;
    // Trim common trailing punctuation from logs.
    pushUrlCandidate(raw.replace(/[)\]]+$/, ""));
  }

  // Prefer the most "complete" looking URL (often includes a long `plt=` token).
  const scoreUrl = (u: string): number => {
    const lower = u.toLowerCase();
    let score = u.length;
    if (lower.includes("plt=")) score += 10_000;
    if (lower.includes("flowname=glifwebsignin")) score += 500;
    if (lower.includes("signin/continue")) score += 100;
    return score;
  };

  let validationUrl: string | undefined;
  for (const u of urlCandidates) {
    if (!u) continue;
    if (!validationUrl || scoreUrl(u) > scoreUrl(validationUrl)) {
      validationUrl = u;
    }
  }

  return { isValidationRequired, validationUrl, message: upstreamMessage };
}

async function scanAccountForVerification(
  account: any,
  client: PluginClient,
  providerId: string,
): Promise<VerificationScanResult> {
  const enabled = account.enabled !== false;
  const email = account.email as string | undefined;
  const index = account.index as number;
  const origin = (account.origin as VerificationAccountOrigin) ?? "active";
  const refreshToken = account.refreshToken as string | undefined;

  if (!refreshToken) {
    return { index, origin, refreshToken: "", email, enabled, status: "error", message: "missing refreshToken" };
  }

  // For quarantined accounts, we still scan even if the user previously disabled them,
  // since they are already out of the active rotation pool.
  if (!enabled && origin !== "quarantined") {
    return { index, origin, refreshToken, email, enabled, status: "skipped", message: "disabled" };
  }

  let authRecord: OAuthAuthDetails = {
    type: "oauth" as const,
    refresh: formatRefreshParts({
      refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
    access: undefined,
    expires: undefined,
  };

  try {
    if (accessTokenExpired(authRecord)) {
      const refreshed = await withTimeout(
        refreshAccessToken(authRecord, client, providerId),
        10_000,
        "token refresh timed out",
      );
      if (!refreshed) {
        return { index, origin, refreshToken, email, enabled, status: "error", message: "token refresh failed" };
      }
      authRecord = refreshed;
    }

    // IMPORTANT: Do not call ensureProjectContext() here.
    // This scan is a best-effort health check and must not block on managed-project onboarding.
    const parts = parseRefreshParts(authRecord.refresh);
    const effectiveProjectId = parts.managedProjectId || parts.projectId || ANTIGRAVITY_DEFAULT_PROJECT_ID;

    const endpoint = ANTIGRAVITY_ENDPOINT_PROD;
    const quotaUserAgent = ANTIGRAVITY_HEADERS["User-Agent"] || "antigravity/windows/amd64";
    // Use a real generateContent call to reliably trigger account verification blocks
    // (VALIDATION_REQUIRED) and license errors (#3501). fetchAvailableModels can succeed
    // even when generate requests are blocked.
    //
    // Use the streaming endpoint to match runtime behavior and ensure we receive the full
    // validation URL (often includes a long `plt=` token).
    const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;
    const body = {
      project: effectiveProjectId,
      model: "gemini-3-flash",
      userAgent: "antigravity",
      requestId: "verify-scan-" + crypto.randomUUID(),
      requestType: "agent",
      request: {
        contents: [
          {
            role: "user",
            parts: [{ text: "ping" }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 1,
          temperature: 0,
        },
      },
    };

    const resp = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authRecord.access ?? ""}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "User-Agent": quotaUserAgent,
      },
      body: JSON.stringify(body),
    }, 10_000);

    if (resp.ok) {
      try {
        await resp.body?.cancel();
      } catch {
        // ignore; best-effort
      }
      return { index, origin, refreshToken, email, enabled, status: "ok" };
    }

    const text = await resp.text().catch(() => "");
    if (resp.status === 429) {
      return { index, origin, refreshToken, email, enabled, status: "error", message: "rate-limited (429)" };
    }
    if (isGeminiCodeAssistLicenseError(text)) {
      return { index, origin, refreshToken, email, enabled, status: "license", message: summarizeUpstreamLicenseMessage(text) };
    }

    const extracted = extractValidationUrlAndMessage(text, email);
    if (resp.status === 403 && extracted.isValidationRequired) {
      return {
        index,
        origin,
        refreshToken,
        email,
        enabled,
        status: "blocked",
        message: summarizeUpstreamValidationMessage(extracted.message ?? text),
        verifyUrl: extracted.validationUrl,
      };
    }

    return {
      index,
      origin,
      refreshToken,
      email,
      enabled,
      status: "error",
      message: `${resp.status}: ${(extracted.message ?? text).trim().slice(0, 200)}`,
    };
  } catch (err) {
    return { index, origin, refreshToken, email, enabled, status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function formatVerificationScanStatusForDisplay(result: VerificationScanResult): string {
  switch (result.status) {
    case "ok":
      return "OK";
    case "blocked":
      return "BLOCKED";
    case "license":
      return "NO LICENSE (#3501)";
    case "skipped":
      return "SKIPPED";
    case "error":
    default:
      return result.message ? `ERROR (${result.message})` : "ERROR";
  }
}

async function scanAllAccountsForVerification(
  accounts: any[],
  client: PluginClient,
  providerId: string,
  opts: {
    concurrency?: number;
    perAccountTimeoutMs?: number;
    onProgress?: (p: { done: number; total: number; result: VerificationScanResult }) => void;
  } = {},
  origin: VerificationAccountOrigin = "active",
): Promise<VerificationScanResult[]> {
  const total = accounts.length;
  const results: VerificationScanResult[] = new Array(total);

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, Math.max(1, total)));
  const perAccountTimeoutMs = Math.max(1_000, opts.perAccountTimeoutMs ?? 25_000);

  let nextIndex = 0;
  let done = 0;

  const worker = async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= total) return;

      const acc = accounts[idx];
      const email = acc?.email as string | undefined;
      const enabled = acc?.enabled !== false;
      const refreshToken = typeof acc?.refreshToken === "string" ? (acc.refreshToken as string) : "";

      let result: VerificationScanResult;
      try {
        result = await withTimeout(
          scanAccountForVerification({ ...acc, index: idx, origin }, client, providerId),
          perAccountTimeoutMs,
          `scan timed out after ${perAccountTimeoutMs}ms`,
        );
      } catch (err) {
        result = {
          index: idx,
          origin,
          refreshToken,
          email,
          enabled,
          status: enabled ? "error" : "skipped",
          message: err instanceof Error ? err.message : String(err),
        };
      }

      results[idx] = result;
      done += 1;
      opts.onProgress?.({ done, total, result });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results.filter((r): r is VerificationScanResult => Boolean(r));
}

async function openUrlInDefaultBrowser(url: string): Promise<boolean> {
  return openBrowser(url);
}

function copyTextToClipboard(text: string): boolean {
  // Best-effort: copy text to Windows clipboard using built-in tools.
  // Use stdin piping (spawnSync input) to avoid shell escaping issues.
  try {
    const input = text.endsWith("\n") ? text : `${text}\n`;
    const result = spawnSync("cmd", ["/c", "clip"], {
      input,
      encoding: "utf8",
      windowsHide: true,
    });
    return result.status === 0;
  } catch (err) {
    log.debug("Failed to copy URL to clipboard", { err });
    return false;
  }
}

// Module-level toast debounce to persist across requests (fixes toast spam)
const rateLimitToastCooldowns = new Map<string, number>();
const RATE_LIMIT_TOAST_COOLDOWN_MS = 5000;
const MAX_TOAST_COOLDOWN_ENTRIES = 100;

// Track if "all accounts rate-limited" toast was shown to prevent spam in while loop
let allAccountsRateLimitedToastShown = false;

function cleanupToastCooldowns(): void {
  if (rateLimitToastCooldowns.size > MAX_TOAST_COOLDOWN_ENTRIES) {
    const now = Date.now();
    for (const [key, time] of rateLimitToastCooldowns) {
      if (now - time > RATE_LIMIT_TOAST_COOLDOWN_MS * 2) {
        rateLimitToastCooldowns.delete(key);
      }
    }
  }
}

function shouldShowRateLimitToast(message: string): boolean {
  cleanupToastCooldowns();
  const toastKey = message.replace(/\d+/g, "X");
  const lastShown = rateLimitToastCooldowns.get(toastKey) ?? 0;
  const now = Date.now();
  if (now - lastShown < RATE_LIMIT_TOAST_COOLDOWN_MS) {
    return false;
  }
  rateLimitToastCooldowns.set(toastKey, now);
  return true;
}

function resetAllAccountsRateLimitedToast(): void {
  allAccountsRateLimitedToastShown = false;
}

function trackWarmupAttempt(sessionId: string): boolean {
  if (warmupSucceededSessionIds.has(sessionId)) {
    return false;
  }
  if (warmupAttemptedSessionIds.size >= MAX_WARMUP_SESSIONS) {
    const first = warmupAttemptedSessionIds.values().next().value;
    if (first) {
      warmupAttemptedSessionIds.delete(first);
      warmupSucceededSessionIds.delete(first);
    }
  }
  const attempts = getWarmupAttemptCount(sessionId);
  if (attempts >= MAX_WARMUP_RETRIES) {
    return false;
  }
  warmupAttemptedSessionIds.add(sessionId);
  return true;
}

function getWarmupAttemptCount(sessionId: string): number {
  return warmupAttemptedSessionIds.has(sessionId) ? 1 : 0;
}

function markWarmupSuccess(sessionId: string): void {
  warmupSucceededSessionIds.add(sessionId);
  if (warmupSucceededSessionIds.size >= MAX_WARMUP_SESSIONS) {
    const first = warmupSucceededSessionIds.values().next().value;
    if (first) warmupSucceededSessionIds.delete(first);
  }
}

function clearWarmupAttempt(sessionId: string): void {
  warmupAttemptedSessionIds.delete(sessionId);
}

function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const { readFileSync } = require("node:fs");
    const release = readFileSync("/proc/version", "utf8").toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

function isWSL2(): boolean {
  if (!isWSL()) return false;
  try {
    const { readFileSync } = require("node:fs");
    const version = readFileSync("/proc/version", "utf8").toLowerCase();
    return version.includes("wsl2") || version.includes("microsoft-standard");
  } catch {
    return false;
  }
}

function isRemoteEnvironment(): boolean {
  if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }
  if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) {
    return true;
  }
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !isWSL()) {
    return true;
  }
  return false;
}

function shouldSkipLocalServer(): boolean {
  return isWSL2() || isRemoteEnvironment();
}

function sanitizeBrowserUrl(input: string): string {
  const raw = (input || "").trim();
  if (!raw) {
    throw new Error("empty url");
  }

  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`unsupported url protocol: ${parsed.protocol}`);
  }

  // Prevent accidental control chars from leaking into process args.
  const normalized = parsed.toString().replace(/[\r\n\t]/g, "");
  if (!normalized) {
    throw new Error("invalid url");
  }
  return normalized;
}

async function openBrowser(url: string): Promise<boolean> {
  const tryOpen = (command: string, args: string[]): boolean => {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  };

  try {
    const safeUrl = sanitizeBrowserUrl(url);
    if (process.platform === "darwin") {
      return tryOpen("open", [safeUrl]);
    }
    if (process.platform === "win32") {
      if (tryOpen("rundll32", ["url.dll,FileProtocolHandler", safeUrl])) {
        return true;
      }
      // `explorer.exe` can open URLs without involving a shell (more reliable for `&` in query strings).
      return tryOpen("explorer.exe", [safeUrl]);
    }
    if (isWSL()) {
      if (tryOpen("wslview", [safeUrl])) {
        return true;
      }
    }
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return false;
    }
    return tryOpen("xdg-open", [safeUrl]);
  } catch {
    return false;
  }
}

async function promptOAuthCallbackValue(message: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

type OAuthCallbackParams = { code: string; state: string };

function getStateFromAuthorizationUrl(authorizationUrl: string): string {
  try {
    return new URL(authorizationUrl).searchParams.get("state") ?? "";
  } catch {
    return "";
  }
}

function extractOAuthCallbackParams(url: URL): OAuthCallbackParams | null {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return null;
  }
  return { code, state };
}

function parseOAuthCallbackInput(
  value: string,
  fallbackState: string,
): OAuthCallbackParams | { error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { error: "Missing authorization code" };
  }

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? fallbackState;

    if (!code) {
      return { error: "Missing code in callback URL" };
    }
    if (!state) {
      return { error: "Missing state in callback URL" };
    }

    return { code, state };
  } catch {
    if (!fallbackState) {
      return { error: "Missing state. Paste the full redirect URL instead of only the code." };
    }

    return { code: trimmed, state: fallbackState };
  }
}

async function promptManualOAuthInput(
  fallbackState: string,
): Promise<AntigravityTokenExchangeResult> {
  console.log("1. Open the URL above in your browser and complete Google sign-in.");
  console.log("2. After approving, copy the full redirected localhost URL from the address bar.");
  console.log("3. Paste it back here.\n");

  const callbackInput = await promptOAuthCallbackValue(
    "Paste the redirect URL (or just the code) here: ",
  );
  const params = parseOAuthCallbackInput(callbackInput, fallbackState);
  if ("error" in params) {
    return { type: "failed", error: params.error };
  }

  return exchangeAntigravity(params.code, params.state);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

async function persistAccountPool(
  results: Array<Extract<AntigravityTokenExchangeResult, { type: "success" }>>,
  replaceAll: boolean = false,
): Promise<void> {
  if (results.length === 0) {
    return;
  }

  const now = Date.now();
  
  // If replaceAll is true (fresh login), start with empty accounts
  // Otherwise, load existing accounts and merge
  const stored = replaceAll ? null : await loadAccounts();
  const accounts = stored?.accounts ? [...stored.accounts] : [];

  // When preserving deletions, `saveAccounts` will drop refresh tokens that are only present
  // in our in-memory storage unless they are explicitly marked as "added". Track those here
  // so login/refresh flows don't get pruned.
  const addedRefreshTokens = new Set<string>();
  const removedRefreshTokens = new Set<string>();

  const indexByRefreshToken = new Map<string, number>();
  const indexByEmail = new Map<string, number>();
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (acc?.refreshToken) {
      indexByRefreshToken.set(acc.refreshToken, i);
    }
    if (acc?.email) {
      indexByEmail.set(acc.email, i);
    }
  }

  for (const result of results) {
    const parts = parseRefreshParts(result.refresh);
    if (!parts.refreshToken) {
      continue;
    }

    // First, check for existing account by email (prevents duplicates when refresh token changes)
    // Only use email-based deduplication if the new account has an email
    const existingByEmail = result.email ? indexByEmail.get(result.email) : undefined;
    const existingByToken = indexByRefreshToken.get(parts.refreshToken);
    
    // Prefer email-based match to handle refresh token rotation
    const existingIndex = existingByEmail ?? existingByToken;
    
    if (existingIndex === undefined) {
      // New account - add it
      const newIndex = accounts.length;
      indexByRefreshToken.set(parts.refreshToken, newIndex);
      if (result.email) {
        indexByEmail.set(result.email, newIndex);
      }
      addedRefreshTokens.add(parts.refreshToken);
      removedRefreshTokens.delete(parts.refreshToken);
      accounts.push({
        email: result.email,
        refreshToken: parts.refreshToken,
        projectId: parts.projectId,
        managedProjectId: parts.managedProjectId,
        addedAt: now,
        lastUsed: now,
        enabled: true,
      });
      continue;
    }

    const existing = accounts[existingIndex];
    if (!existing) {
      continue;
    }

    // Update existing account (this handles both email match and token match cases)
    // When email matches but token differs, this effectively replaces the old token
    const oldToken = existing.refreshToken;
    accounts[existingIndex] = {
      ...existing,
      email: result.email ?? existing.email,
      refreshToken: parts.refreshToken,
      projectId: parts.projectId ?? existing.projectId,
      managedProjectId: parts.managedProjectId ?? existing.managedProjectId,
      lastUsed: now,
    };
    
    // Update the token index if the token changed
    if (oldToken !== parts.refreshToken) {
      indexByRefreshToken.delete(oldToken);
      indexByRefreshToken.set(parts.refreshToken, existingIndex);
      removedRefreshTokens.add(oldToken);
      addedRefreshTokens.delete(oldToken);
      addedRefreshTokens.add(parts.refreshToken);
      removedRefreshTokens.delete(parts.refreshToken);
    }
  }

  if (accounts.length === 0) {
    return;
  }

  // For fresh logins, always start at index 0
  const activeIndex = replaceAll 
    ? 0 
    : (typeof stored?.activeIndex === "number" && Number.isFinite(stored.activeIndex) ? stored.activeIndex : 0);

  await saveAccounts(
    {
      version: 3,
      accounts,
      activeIndex: clampInt(activeIndex, 0, accounts.length - 1),
      activeIndexByFamily: {
        claude: clampInt(activeIndex, 0, accounts.length - 1),
        gemini: clampInt(activeIndex, 0, accounts.length - 1),
      },
    },
    replaceAll
      ? { merge: false }
      : {
          merge: true,
          preserveDeletions: true,
          addedRefreshTokens: Array.from(addedRefreshTokens),
          removedRefreshTokens: Array.from(removedRefreshTokens),
        },
  );
}

function retryAfterMsFromResponse(response: Response, defaultRetryMs: number = 60_000): number {
  const retryAfterMsHeader = response.headers.get("retry-after-ms");
  if (retryAfterMsHeader) {
    const parsed = Number.parseInt(retryAfterMsHeader, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const retryAfterHeader = response.headers.get("retry-after");
  if (retryAfterHeader) {
    const parsed = Number.parseInt(retryAfterHeader, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed * 1000;
    }
  }

  return defaultRetryMs;
}

/**
 * Parse Go-style duration strings to milliseconds.
 * Supports compound durations: "1h16m0.667s", "1.5s", "200ms", "5m30s"
 * 
 * @param duration - Duration string in Go format
 * @returns Duration in milliseconds, or null if parsing fails
 */
function parseDurationToMs(duration: string): number | null {
  // Handle simple formats first for backwards compatibility
  const simpleMatch = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (simpleMatch) {
    const value = parseFloat(simpleMatch[1]!);
    const unit = (simpleMatch[2] || "s").toLowerCase();
    switch (unit) {
      case "h": return value * 3600 * 1000;
      case "m": return value * 60 * 1000;
      case "s": return value * 1000;
      case "ms": return value;
      default: return value * 1000;
    }
  }
  
  // Parse compound Go-style durations: "1h16m0.667s", "5m30s", etc.
  const compoundRegex = /(\d+(?:\.\d+)?)(h|m(?!s)|s|ms)/gi;
  let totalMs = 0;
  let matchFound = false;
  let match;
  
  while ((match = compoundRegex.exec(duration)) !== null) {
    matchFound = true;
    const value = parseFloat(match[1]!);
    const unit = match[2]!.toLowerCase();
    switch (unit) {
      case "h": totalMs += value * 3600 * 1000; break;
      case "m": totalMs += value * 60 * 1000; break;
      case "s": totalMs += value * 1000; break;
      case "ms": totalMs += value; break;
    }
  }
  
  return matchFound ? totalMs : null;
}

interface RateLimitBodyInfo {
  retryDelayMs: number | null;
  message?: string;
  quotaResetTime?: string;
  reason?: string;
}

function extractRateLimitBodyInfo(body: unknown): RateLimitBodyInfo {
  if (!body || typeof body !== "object") {
    return { retryDelayMs: null };
  }

  const error = (body as { error?: unknown }).error;
  const message = error && typeof error === "object" 
    ? (error as { message?: string }).message 
    : undefined;

  const details = error && typeof error === "object" 
    ? (error as { details?: unknown[] }).details 
    : undefined;

  let reason: string | undefined;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const type = (detail as { "@type"?: string })["@type"];
      if (typeof type === "string" && type.includes("google.rpc.ErrorInfo")) {
        const detailReason = (detail as { reason?: string }).reason;
        if (typeof detailReason === "string") {
          reason = detailReason;
          break;
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const type = (detail as { "@type"?: string })["@type"];
      if (typeof type === "string" && type.includes("google.rpc.RetryInfo")) {
        const retryDelay = (detail as { retryDelay?: string }).retryDelay;
        if (typeof retryDelay === "string") {
          const retryDelayMs = parseDurationToMs(retryDelay);
          if (retryDelayMs !== null) {
            return { retryDelayMs, message, reason };
          }
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const metadata = (detail as { metadata?: Record<string, string> }).metadata;
      if (metadata && typeof metadata === "object") {
        const quotaResetDelay = metadata.quotaResetDelay;
        const quotaResetTime = metadata.quotaResetTimeStamp;
        if (typeof quotaResetDelay === "string") {
          const quotaResetDelayMs = parseDurationToMs(quotaResetDelay);
          if (quotaResetDelayMs !== null) {
            return { retryDelayMs: quotaResetDelayMs, message, quotaResetTime, reason };
          }
        }
      }
    }
  }

  if (message) {
    const afterMatch = message.match(/reset after\s+([0-9hms.]+)/i);
    const rawDuration = afterMatch?.[1];
    if (rawDuration) {
      const parsed = parseDurationToMs(rawDuration);
      if (parsed !== null) {
        return { retryDelayMs: parsed, message, reason };
      }
    }
  }

  return { retryDelayMs: null, message, reason };
}

async function extractRetryInfoFromBody(response: Response): Promise<RateLimitBodyInfo> {
  try {
    const text = await response.clone().text();
    try {
      const parsed = JSON.parse(text) as unknown;
      return extractRateLimitBodyInfo(parsed);
    } catch {
      return { retryDelayMs: null };
    }
  } catch {
    return { retryDelayMs: null };
  }
}

function formatWaitTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

// Progressive rate limit retry delays
const FIRST_RETRY_DELAY_MS = 1000;      // 1s - first 429 quick retry on same account
const SWITCH_ACCOUNT_DELAY_MS = 5000;   // 5s - delay before switching to another account

/**
 * Rate limit state tracking with time-window deduplication.
 * 
 * Problem: When multiple subagents hit 429 simultaneously, each would increment
 * the consecutive counter, causing incorrect exponential backoff (5 concurrent
 * 429s = 2^5 backoff instead of 2^1).
 * 
 * Solution: Track per account+quota with deduplication window. Multiple 429s
 * within RATE_LIMIT_DEDUP_WINDOW_MS are treated as a single event.
 */
const RATE_LIMIT_DEDUP_WINDOW_MS = 2000; // 2 seconds - concurrent requests within this window are deduplicated
const RATE_LIMIT_STATE_RESET_MS = 120_000; // Reset consecutive counter after 2 minutes of no 429s

interface RateLimitState {
  consecutive429: number;
  lastAt: number;
  quotaKey: string; // Track which quota this state is for
}

// Key format: `${accountIndex}:${quotaKey}` for per-account-per-quota tracking
const rateLimitStateByAccountQuota = new Map<string, RateLimitState>();

// Track empty response retry attempts (ported from LLM-API-Key-Proxy)
const emptyResponseAttempts = new Map<string, number>();

/**
 * Get rate limit backoff with time-window deduplication.
 * 
 * @param accountIndex - The account index
 * @param quotaKey - The quota key (e.g., "gemini-cli", "gemini-antigravity", "claude")
 * @param serverRetryAfterMs - Server-provided retry delay (if any)
 * @param maxBackoffMs - Maximum backoff delay in milliseconds (default 60000)
 * @returns { attempt, delayMs, isDuplicate } - isDuplicate=true if within dedup window
 */
function getRateLimitBackoff(
  accountIndex: number, 
  quotaKey: string,
  serverRetryAfterMs: number | null,
  maxBackoffMs: number = 60_000
): { attempt: number; delayMs: number; isDuplicate: boolean } {
  const now = Date.now();
  const stateKey = `${accountIndex}:${quotaKey}`;
  const previous = rateLimitStateByAccountQuota.get(stateKey);
  
  // Check if this is a duplicate 429 within the dedup window
  if (previous && (now - previous.lastAt < RATE_LIMIT_DEDUP_WINDOW_MS)) {
    // Same rate limit event from concurrent request - don't increment
    const baseDelay = serverRetryAfterMs ?? 1000;
    const backoffDelay = Math.min(baseDelay * Math.pow(2, previous.consecutive429 - 1), maxBackoffMs);
    return { 
      attempt: previous.consecutive429, 
      delayMs: Math.max(baseDelay, backoffDelay),
      isDuplicate: true 
    };
  }
  
  // Check if we should reset (no 429 for 2 minutes) or increment
  const attempt = previous && (now - previous.lastAt < RATE_LIMIT_STATE_RESET_MS) 
    ? previous.consecutive429 + 1 
    : 1;
  
  rateLimitStateByAccountQuota.set(stateKey, { 
    consecutive429: attempt, 
    lastAt: now,
    quotaKey 
  });
  
  const baseDelay = serverRetryAfterMs ?? 1000;
  const backoffDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxBackoffMs);
  return { attempt, delayMs: Math.max(baseDelay, backoffDelay), isDuplicate: false };
}

/**
 * Reset rate limit state for an account+quota combination.
 * Only resets the specific quota, not all quotas for the account.
 */
function resetRateLimitState(accountIndex: number, quotaKey: string): void {
  const stateKey = `${accountIndex}:${quotaKey}`;
  rateLimitStateByAccountQuota.delete(stateKey);
}

/**
 * Reset all rate limit state for an account (all quotas).
 * Used when account is completely healthy.
 */
function resetAllRateLimitStateForAccount(accountIndex: number): void {
  for (const key of rateLimitStateByAccountQuota.keys()) {
    if (key.startsWith(`${accountIndex}:`)) {
      rateLimitStateByAccountQuota.delete(key);
    }
  }
}

function headerStyleToQuotaKey(headerStyle: HeaderStyle, family: ModelFamily): string {
  if (family === "claude") return "claude";
  return headerStyle === "antigravity" ? "gemini-antigravity" : "gemini-cli";
}

// Track consecutive non-429 failures per account to prevent infinite loops
const accountFailureState = new Map<number, { consecutiveFailures: number; lastFailureAt: number }>();
const MAX_CONSECUTIVE_FAILURES = 5;
const FAILURE_COOLDOWN_MS = 30_000; // 30 seconds cooldown after max failures
const FAILURE_STATE_RESET_MS = 120_000; // Reset failure count after 2 minutes of no failures

function trackAccountFailure(accountIndex: number): { failures: number; shouldCooldown: boolean; cooldownMs: number } {
  const now = Date.now();
  const previous = accountFailureState.get(accountIndex);
  
  // Reset if last failure was more than 2 minutes ago
  const failures = previous && (now - previous.lastFailureAt < FAILURE_STATE_RESET_MS) 
    ? previous.consecutiveFailures + 1 
    : 1;
  
  accountFailureState.set(accountIndex, { consecutiveFailures: failures, lastFailureAt: now });
  
  const shouldCooldown = failures >= MAX_CONSECUTIVE_FAILURES;
  const cooldownMs = shouldCooldown ? FAILURE_COOLDOWN_MS : 0;
  
  return { failures, shouldCooldown, cooldownMs };
}

function resetAccountFailureState(accountIndex: number): void {
  accountFailureState.delete(accountIndex);
}

/**
 * Sleep for a given number of milliseconds, respecting an abort signal.
 */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Creates an Antigravity OAuth plugin for a specific provider ID.
 */
export const createAntigravityPlugin = (providerId: string) => async (
  { client, directory }: PluginContext,
): Promise<PluginResult> => {
  // Load configuration from files and environment variables
  const config = loadConfig(directory);
  initRuntimeConfig(config);

  // Cached getAuth function for tool access
  let cachedGetAuth: GetAuth | null = null;
  
  // Initialize debug with config
  initializeDebug(config);
  
  // Initialize structured logger for TUI integration
  initLogger(client);
  
  // Initialize health tracker for hybrid strategy
  if (config.health_score) {
    initHealthTracker({
      initial: config.health_score.initial,
      successReward: config.health_score.success_reward,
      rateLimitPenalty: config.health_score.rate_limit_penalty,
      failurePenalty: config.health_score.failure_penalty,
      recoveryRatePerHour: config.health_score.recovery_rate_per_hour,
      minUsable: config.health_score.min_usable,
      maxScore: config.health_score.max_score,
    });
  }

  // Initialize token tracker for hybrid strategy
  if (config.token_bucket) {
    initTokenTracker({
      maxTokens: config.token_bucket.max_tokens,
      regenerationRatePerMinute: config.token_bucket.regeneration_rate_per_minute,
      initialTokens: config.token_bucket.initial_tokens,
    });
  }
  
  // Initialize disk signature cache if keep_thinking is enabled
  // This integrates with the in-memory cacheSignature/getCachedSignature functions
  if (config.keep_thinking) {
    initDiskSignatureCache(config.signature_cache);
  }
  
  // Initialize session recovery hook with full context
  const sessionRecovery = createSessionRecoveryHook({ client, directory }, config);
  
  const updateChecker = createAutoUpdateCheckerHook(client, directory, {
    showStartupToast: true,
    autoUpdate: config.auto_update,
  });

  // Event handler for session recovery and updates
  const eventHandler = async (input: { event: { type: string; properties?: unknown } }) => {
    // Forward to update checker
    await updateChecker.event(input);

    // Track if this is a child session (subagent, background task).
    // This is used to filter toasts based on toast_scope config.
    if (input.event.type === "session.created") {
      const props = input.event.properties as { info?: { parentID?: string } } | undefined;
      if (props?.info?.parentID) {
        isChildSession = true;
        childSessionParentID = props.info.parentID;
        log.debug("child-session-detected", { parentID: props.info.parentID });
      } else {
        // Reset for root sessions - important when plugin instance is reused.
        isChildSession = false;
        childSessionParentID = undefined;
        log.debug("root-session-detected", {});
      }
    }
    
    // Handle session recovery
    if (sessionRecovery && input.event.type === "session.error") {
      const props = input.event.properties as Record<string, unknown> | undefined;
      const sessionID = props?.sessionID as string | undefined;
      const messageID = props?.messageID as string | undefined;
      const error = props?.error;
      
      if (sessionRecovery.isRecoverableError(error)) {
        const messageInfo = {
          id: messageID,
          role: "assistant" as const,
          sessionID,
          error,
        };
        
        // handleSessionRecovery now does the actual fix (injects tool_result, etc.)
        const recovered = await sessionRecovery.handleSessionRecovery(messageInfo);

        // Only send "continue" AFTER successful tool_result_missing recovery
        // (thinking recoveries already resume inside handleSessionRecovery)
        if (recovered && sessionID && config.auto_resume) {
          // For tool_result_missing, we need to send continue after injecting tool_results
          await client.session.prompt({
            path: { id: sessionID },
            body: { parts: [{ type: "text", text: config.resume_text }] },
            query: { directory },
          }).catch(() => {});
          
          // Show success toast (respects quiet_mode + toast_scope for child sessions)
          const successToast = getRecoverySuccessToast();
          const toastScope = config.toast_scope;
          log.debug("recovery-toast", {
            ...successToast,
            isChildSession,
            toastScope,
            parentID: childSessionParentID,
          });

          if (!config.quiet_mode && !(toastScope === "root_only" && isChildSession)) {
            await client.tui.showToast({
              body: {
                title: successToast.title,
                message: successToast.message,
                variant: "success",
              },
            }).catch(() => {});
          }
        }
      }
    }
  };

  // Create google_search tool with access to auth context
  const googleSearchTool = tool({
    description: "Search the web using Google Search and analyze URLs. Returns real-time information from the internet with source citations. Use this when you need up-to-date information about current events, recent developments, or any topic that may have changed. You can also provide specific URLs to analyze. IMPORTANT: If the user mentions or provides any URLs in their query, you MUST extract those URLs and pass them in the 'urls' parameter for direct analysis.",
    args: {
      query: tool.schema.string().describe("The search query or question to answer using web search"),
      urls: tool.schema.array(tool.schema.string()).optional().describe("List of specific URLs to fetch and analyze. IMPORTANT: Always extract and include any URLs mentioned by the user in their query here."),
      thinking: tool.schema.boolean().optional().default(true).describe("Enable deep thinking for more thorough analysis (default: true)"),
    },
    async execute(args, ctx) {
      log.debug("Google Search tool called", { query: args.query, urlCount: args.urls?.length ?? 0 });

      // Get current auth context
      const auth = cachedGetAuth ? await cachedGetAuth() : null;
      if (!auth || !isOAuthAuth(auth)) {
        return "Error: Not authenticated with Antigravity. Please run `opencode auth login` to authenticate.";
      }

      // Get access token and project ID
      const parts = parseRefreshParts(auth.refresh);
      const projectId = parts.managedProjectId || parts.projectId || "unknown";

      // Ensure we have a valid access token
      let accessToken = auth.access;
      if (!accessToken || accessTokenExpired(auth)) {
        try {
          const refreshed = await refreshAccessToken(auth, client, providerId);
          accessToken = refreshed?.access;
        } catch (error) {
          return `Error: Failed to refresh access token: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      if (!accessToken) {
        return "Error: No valid access token available. Please run `opencode auth login` to re-authenticate.";
      }

      return executeSearch(
        {
          query: args.query,
          urls: args.urls,
          thinking: args.thinking,
        },
        accessToken,
        projectId,
        ctx.abort,
      );
    },
  });

  return {
    event: eventHandler,
    tool: {
      google_search: googleSearchTool,
    },
    auth: {
    provider: providerId,
    loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | Record<string, unknown>> => {
      // Cache getAuth for tool access
      cachedGetAuth = getAuth;

      const auth = await getAuth();
      
      // If OpenCode has no valid OAuth auth, clear any stale account storage
       if (!isOAuthAuth(auth)) {
         try {
           await clearAccounts();
           await clearBlockedAccounts();
         } catch {
           // ignore
         }
         return {};
       }

      // Validate that stored accounts are in sync with OpenCode's auth
      // If OpenCode's refresh token doesn't match any stored account, clear stale storage
      const authParts = parseRefreshParts(auth.refresh);
      const storedAccounts = await loadAccounts();
      
      // Note: AccountManager now ensures the current auth is always included in accounts

      const accountManager = await AccountManager.loadFromDisk(auth);
      if (accountManager.getAccountCount() > 0) {
        accountManager.requestSaveToDisk();
      }

      // Initialize proactive token refresh queue (ported from LLM-API-Key-Proxy)
      let refreshQueue: ProactiveRefreshQueue | null = null;
      if (config.proactive_token_refresh && accountManager.getAccountCount() > 0) {
        refreshQueue = createProactiveRefreshQueue(client, providerId, {
          enabled: config.proactive_token_refresh,
          bufferSeconds: config.proactive_refresh_buffer_seconds,
          checkIntervalSeconds: config.proactive_refresh_check_interval_seconds,
        });
        refreshQueue.setAccountManager(accountManager);
        refreshQueue.start();
      }

      if (isDebugEnabled()) {
        const logPath = getLogFilePath();
        if (logPath) {
          try {
            const toastScope = config.toast_scope;
            if (!config.quiet_mode && !(toastScope === "root_only" && isChildSession)) {
              await client.tui.showToast({
                body: { message: `Debug log: ${logPath}`, variant: "info" },
              });
            }
          } catch {
            // TUI may not be available
          }
        }
      }

      if (provider.models) {
        for (const model of Object.values(provider.models)) {
          if (model) {
            model.cost = { input: 0, output: 0 };
          }
        }
      }

      return {
        apiKey: "",
        async fetch(input, init) {
          if (!isGenerativeLanguageRequest(input)) {
            return fetch(input, init);
          }

          const latestAuth = await getAuth();
          if (!isOAuthAuth(latestAuth)) {
            return fetch(input, init);
          }

          if (accountManager.getAccountCount() === 0) {
            throw new Error("No Antigravity accounts configured. Run `opencode auth login`.");
          }

          const urlString = toUrlString(input);
          const family = getModelFamilyFromUrl(urlString);
          const model = extractModelFromUrl(urlString);
          const debugLines: string[] = [];
          const pushDebug = (line: string) => {
            if (!isDebugEnabled()) return;
            debugLines.push(line);
          };
          pushDebug(`request=${urlString}`);

          type FailureContext = {
            response: Response;
            streaming: boolean;
            debugContext: ReturnType<typeof startAntigravityDebugRequest>;
            requestedModel?: string;
            projectId?: string;
            endpoint?: string;
            effectiveModel?: string;
            sessionId?: string;
            toolDebugMissing?: number;
            toolDebugSummary?: string;
            toolDebugPayload?: string;
          };

          let lastFailure: FailureContext | null = null;
          let lastError: Error | null = null;
          const abortSignal = init?.signal ?? undefined;

          // Helper to check if request was aborted
          const checkAborted = () => {
            if (abortSignal?.aborted) {
              throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Aborted");
            }
          };

          // Use while(true) loop to handle rate limits with backoff
          // This ensures we wait and retry when all accounts are rate-limited
          const quietMode = config.quiet_mode;

          // Helper to show toast without blocking on abort (respects quiet_mode)
          const showToast = async (message: string, variant: "info" | "warning" | "success" | "error") => {
            if (quietMode) return;
            if (abortSignal?.aborted) return;
            if (config.toast_scope === "root_only" && isChildSession) return;
             
            if (variant === "warning" && message.toLowerCase().includes("rate")) {
              if (!shouldShowRateLimitToast(message)) {
                return;
              }
            }
            
            try {
              await client.tui.showToast({
                body: { message, variant },
              });
            } catch {
              // TUI may not be available
            }
          };
          
          const hasOtherAccountWithAntigravity = (currentAccount: any): boolean => {
            return accountManager.hasOtherAccountWithAntigravityAvailable(
              currentAccount.index,
              family,
              model,
            );
          };

          while (true) {
            // Check for abort at the start of each iteration
            checkAborted();
            
            let accountCount = accountManager.getAccountCount();
            
            if (accountCount === 0) {
              // Accounts may have been restored/quarantined outside this process (e.g. via
              // `opencode auth login`). Reload once so users don't need to restart OpenCode.
              await accountManager.reloadFromDisk();
              accountCount = accountManager.getAccountCount();
            }
            
            if (accountCount === 0) {
              throw new Error("No Antigravity accounts available. Run `opencode auth login`.");
            }

            const account = accountManager.getCurrentOrNextForFamily(
              family, 
              model, 
              config.account_selection_strategy,
              'antigravity',
              config.pid_offset_enabled,
            );
            
            if (!account) {
              const headerStyle = getHeaderStyleFromUrl(urlString, family, config.cli_first);
              const explicitQuota = isExplicitQuotaFromUrl(urlString);
              // All accounts are rate-limited - wait and retry
              const waitMs = accountManager.getMinWaitTimeForFamily(
                family,
                model,
                headerStyle,
                explicitQuota,
              ) || 60_000;
              const waitSecValue = Math.max(1, Math.ceil(waitMs / 1000));

              pushDebug(`all-rate-limited family=${family} accounts=${accountCount} waitMs=${waitMs}`);
              if (isDebugEnabled()) {
                logAccountContext("All accounts rate-limited", {
                  index: -1,
                  family,
                  totalAccounts: accountCount,
                });
                logRateLimitSnapshot(family, accountManager.getAccountsSnapshot());
              }

              // If wait time exceeds max threshold, return error immediately instead of hanging
              // 0 means disabled (wait indefinitely)
              const maxWaitMs = (config.max_rate_limit_wait_seconds ?? 300) * 1000;
              if (maxWaitMs > 0 && waitMs > maxWaitMs) {
                const waitTimeFormatted = formatWaitTime(waitMs);
                await showToast(
                  `Rate limited for ${waitTimeFormatted}. Try again later or add another account.`,
                  "error"
                );
                
                // Return a proper rate limit error response
                throw new Error(
                  `All ${accountCount} account(s) rate-limited for ${family}. ` +
                  `Quota resets in ${waitTimeFormatted}. ` +
                  `Add more accounts with \`opencode auth login\` or wait and retry.`
                );
              }

              if (!allAccountsRateLimitedToastShown) {
                await showToast(`All ${accountCount} account(s) rate-limited for ${family}. Waiting ${waitSecValue}s...`, "warning");
                allAccountsRateLimitedToastShown = true;
              }

              // Wait for the rate-limit cooldown to expire, then retry
              await sleep(waitMs, abortSignal);
              continue;
            }

            // Account is available - reset the toast flag
            resetAllAccountsRateLimitedToast();

            pushDebug(
              `selected idx=${account.index} email=${account.email ?? ""} family=${family} accounts=${accountCount} strategy=${config.account_selection_strategy}`,
            );
            if (isDebugEnabled()) {
              logAccountContext("Selected", {
                index: account.index,
                email: account.email,
                family,
                totalAccounts: accountCount,
                rateLimitState: account.rateLimitResetTimes,
              });
            }

            // Show toast when switching to a different account (debounced, quiet_mode handled by showToast)
            if (accountCount > 1 && accountManager.shouldShowAccountToast(account.index)) {
              const accountLabel = account.email || `Account ${account.index + 1}`;
              // Calculate position among enabled accounts (not absolute index)
              const enabledAccounts = accountManager.getEnabledAccounts();
              const enabledPosition = enabledAccounts.findIndex(a => a.index === account.index) + 1;
              await showToast(
                `Using ${accountLabel} (${enabledPosition}/${accountCount})`,
                "info"
              );
              accountManager.markToastShown(account.index);
            }

            accountManager.requestSaveToDisk();

            let authRecord = accountManager.toAuthDetails(account);

            if (accessTokenExpired(authRecord)) {
              try {
                const refreshed = await refreshAccessToken(authRecord, client, providerId);
                if (!refreshed) {
                  const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
                  getHealthTracker().recordFailure(account.index);
                  lastError = new Error("Antigravity token refresh failed");
                  if (shouldCooldown) {
                    accountManager.markAccountCoolingDown(account, cooldownMs, "auth-failure");
                    accountManager.markRateLimited(account, cooldownMs, family, "antigravity", model);
                    pushDebug(`token-refresh-failed: cooldown ${cooldownMs}ms after ${failures} failures`);
                  }
                  continue;
                }
                resetAccountFailureState(account.index);
                accountManager.updateFromAuth(account, refreshed);
                authRecord = refreshed;
                try {
                  await accountManager.saveToDisk();
                } catch (error) {
                  log.error("Failed to persist refreshed auth", { error: String(error) });
                }
              } catch (error) {
                if (error instanceof AntigravityTokenRefreshError && error.code === "invalid_grant") {
                  const removed = accountManager.removeAccount(account);
                  if (removed) {
                    log.warn("Removed revoked account from pool - reauthenticate via `opencode auth login`");
                    try {
                      await accountManager.saveToDisk();
                    } catch (persistError) {
                      log.error("Failed to persist revoked account removal", { error: String(persistError) });
                    }
                  }

                  if (accountManager.getAccountCount() === 0) {
                    try {
                      await client.auth.set({
                        path: { id: providerId },
                        body: { type: "oauth", refresh: "", access: "", expires: 0 },
                      });
                    } catch (storeError) {
                      log.error("Failed to clear stored Antigravity OAuth credentials", { error: String(storeError) });
                    }

                    throw new Error(
                      "All Antigravity accounts have invalid refresh tokens. Run `opencode auth login` and reauthenticate.",
                    );
                  }

                  lastError = error;
                  continue;
                }

                const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
                getHealthTracker().recordFailure(account.index);
                lastError = error instanceof Error ? error : new Error(String(error));
                if (shouldCooldown) {
                  accountManager.markAccountCoolingDown(account, cooldownMs, "auth-failure");
                  accountManager.markRateLimited(account, cooldownMs, family, "antigravity", model);
                  pushDebug(`token-refresh-error: cooldown ${cooldownMs}ms after ${failures} failures`);
                }
                continue;
              }
            }

            const accessToken = authRecord.access;
            if (!accessToken) {
              lastError = new Error("Missing access token");
              if (accountCount <= 1) {
                throw lastError;
              }
              continue;
            }

            let projectContext: ProjectContextResult;
            try {
              projectContext = await ensureProjectContext(authRecord);
              resetAccountFailureState(account.index);
            } catch (error) {
              const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
              getHealthTracker().recordFailure(account.index);
              lastError = error instanceof Error ? error : new Error(String(error));
              if (shouldCooldown) {
                accountManager.markAccountCoolingDown(account, cooldownMs, "project-error");
                accountManager.markRateLimited(account, cooldownMs, family, "antigravity", model);
                pushDebug(`project-context-error: cooldown ${cooldownMs}ms after ${failures} failures`);
              }
              continue;
            }

            if (projectContext.auth !== authRecord) {
              accountManager.updateFromAuth(account, projectContext.auth);
              authRecord = projectContext.auth;
              try {
                await accountManager.saveToDisk();
              } catch (error) {
                log.error("Failed to persist project context", { error: String(error) });
              }
            }

            const runThinkingWarmup = async (
              prepared: ReturnType<typeof prepareAntigravityRequest>,
              projectId: string,
            ): Promise<void> => {
              if (!prepared.needsSignedThinkingWarmup || !prepared.sessionId) {
                return;
              }

              if (!trackWarmupAttempt(prepared.sessionId)) {
                return;
              }

              const warmupBody = buildThinkingWarmupBody(
                typeof prepared.init.body === "string" ? prepared.init.body : undefined,
                Boolean(prepared.effectiveModel?.toLowerCase().includes("claude") && prepared.effectiveModel?.toLowerCase().includes("thinking")),
              );
              if (!warmupBody) {
                return;
              }

              const warmupUrl = toWarmupStreamUrl(prepared.request);
              const warmupHeaders = new Headers(prepared.init.headers ?? {});
              warmupHeaders.set("accept", "text/event-stream");

              const warmupInit: RequestInit = {
                ...prepared.init,
                method: prepared.init.method ?? "POST",
                headers: warmupHeaders,
                body: warmupBody,
              };

              const warmupDebugContext = startAntigravityDebugRequest({
                originalUrl: warmupUrl,
                resolvedUrl: warmupUrl,
                method: warmupInit.method,
                headers: warmupHeaders,
                body: warmupBody,
                streaming: true,
                projectId,
              });

              try {
                pushDebug("thinking-warmup: start");
                const warmupResponse = await fetch(warmupUrl, warmupInit);
                const transformed = await transformAntigravityResponse(
                  warmupResponse,
                  true,
                  warmupDebugContext,
                  prepared.requestedModel,
                  projectId,
                  warmupUrl,
                  prepared.effectiveModel,
                  prepared.sessionId,
                );
                await transformed.text();
                markWarmupSuccess(prepared.sessionId);
                pushDebug("thinking-warmup: done");
              } catch (error) {
                clearWarmupAttempt(prepared.sessionId);
                pushDebug(
                  `thinking-warmup: failed ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            };

            // Try endpoint fallbacks with single header style based on model suffix
            let shouldSwitchAccount = false;
            
            // Determine header style from model suffix:
            // - Models with :antigravity suffix -> use Antigravity quota
            // - Models without suffix (default) -> use Gemini CLI quota
            // - Claude models -> always use Antigravity
            let headerStyle = getHeaderStyleFromUrl(urlString, family, config.cli_first);
            const explicitQuota = isExplicitQuotaFromUrl(urlString);
            pushDebug(`headerStyle=${headerStyle} explicit=${explicitQuota}`);
            if (account.fingerprint) {
              pushDebug(`fingerprint: quotaUser=${account.fingerprint.quotaUser} deviceId=${account.fingerprint.deviceId.slice(0, 8)}...`);
            }
            
            // Check if this header style is rate-limited for this account
            if (accountManager.isRateLimitedForHeaderStyle(account, family, headerStyle, model)) {
              // Quota fallback: try alternate quota on same account (direction depends on cli_first).
              if (family === "gemini") {
                const alternateStyle = accountManager.getAvailableHeaderStyle(account, family, model);
                const fallbackStyle = resolveQuotaFallbackHeaderStyle({
                  quotaFallback: config.quota_fallback,
                  cliFirst: config.cli_first,
                  explicitQuota,
                  family,
                  headerStyle,
                  alternateStyle,
                });

                if (fallbackStyle) {
                  const quotaName = headerStyle === "gemini-cli" ? "Gemini CLI" : "Antigravity";
                  const altQuotaName = fallbackStyle === "gemini-cli" ? "Gemini CLI" : "Antigravity";
                  await showToast(`${quotaName} quota exhausted, using ${altQuotaName} quota`, "warning");
                  headerStyle = fallbackStyle;
                  pushDebug(`quota fallback: ${headerStyle}`);
                } else {
                  shouldSwitchAccount = true;
                }
              } else {
                shouldSwitchAccount = true;
              }
            }
            
            while (!shouldSwitchAccount) {
            
            // Flag to force thinking recovery on retry after API error
            let forceThinkingRecovery = false;
            
            // Track if token was consumed (for hybrid strategy refund on error)
            let tokenConsumed = false;
            
            // Track capacity retries per endpoint to prevent infinite loops
            let capacityRetryCount = 0;
            let lastEndpointIndex = -1;
            
            for (let i = 0; i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length; i++) {
              // Reset capacity retry counter when switching to a new endpoint
              if (i !== lastEndpointIndex) {
                capacityRetryCount = 0;
                lastEndpointIndex = i;
              }

              const currentEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[i];

              try {
                const prepared = prepareAntigravityRequest(
                  input,
                  init,
                  accessToken,
                  projectContext.effectiveProjectId,
                  currentEndpoint,
                  headerStyle,
                  forceThinkingRecovery,
                  {
                    claudeToolHardening: config.claude_tool_hardening,
                    fingerprint: account.fingerprint,
                  },
                );

                const originalUrl = toUrlString(input);
                const resolvedUrl = toUrlString(prepared.request);
                pushDebug(`endpoint=${currentEndpoint}`);
                pushDebug(`resolved=${resolvedUrl}`);
                const debugContext = startAntigravityDebugRequest({
                  originalUrl,
                  resolvedUrl,
                  method: prepared.init.method,
                  headers: prepared.init.headers,
                  body: prepared.init.body,
                  streaming: prepared.streaming,
                  projectId: projectContext.effectiveProjectId,
                });

                await runThinkingWarmup(prepared, projectContext.effectiveProjectId);

                if (config.request_jitter_max_ms > 0) {
                  const jitterMs = Math.floor(Math.random() * config.request_jitter_max_ms);
                  if (jitterMs > 0) {
                    await sleep(jitterMs, abortSignal);
                  }
                }

                // Consume token for hybrid strategy
                // Refunded later if request fails (429 or network error)
                if (config.account_selection_strategy === 'hybrid') {
                  tokenConsumed = getTokenTracker().consume(account.index);
                }

                let response = await fetch(prepared.request, prepared.init);
                pushDebug(`status=${response.status} ${response.statusText}`);




                // Handle 429 rate limit (or Service Overloaded) with improved logic
                if (response.status === 429 || response.status === 503 || response.status === 529) {
                  // Refund token on rate limit
                  if (tokenConsumed) {
                    getTokenTracker().refund(account.index);
                    tokenConsumed = false;
                  }

                  const defaultRetryMs = (config.default_retry_after_seconds ?? 60) * 1000;
                  const maxBackoffMs = (config.max_backoff_seconds ?? 60) * 1000;
                  const headerRetryMs = retryAfterMsFromResponse(response, defaultRetryMs);
                  const bodyInfo = await extractRetryInfoFromBody(response);
                  const serverRetryMs = bodyInfo.retryDelayMs ?? headerRetryMs;

                  // [Enhanced Parsing] Pass status to handling logic
                  const rateLimitReason = parseRateLimitReason(bodyInfo.reason, bodyInfo.message, response.status);

                  // STRATEGY 1: CAPACITY / SERVER ERROR (Transient)
                  // Goal: Wait and Retry SAME Account. DO NOT LOCK.
                  // We handle this FIRST to avoid calling getRateLimitBackoff() and polluting the global rate limit state for transient errors.
                  if (rateLimitReason === "MODEL_CAPACITY_EXHAUSTED" || rateLimitReason === "SERVER_ERROR") {
                     // Exponential backoff with jitter for capacity errors: 1s → 2s → 4s → 8s (max)
                     // Matches Antigravity-Manager's ExponentialBackoff(1s, 8s)
                     const baseDelayMs = 1000;
                     const maxDelayMs = 8000;
                     const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, capacityRetryCount), maxDelayMs);
                     // Add ±10% jitter to prevent thundering herd
                     const jitter = exponentialDelay * (0.9 + Math.random() * 0.2);
                     const waitMs = Math.round(jitter);
                     const waitSec = Math.round(waitMs / 1000);
                     
                     pushDebug(`Server busy (${rateLimitReason}) on account ${account.index}, exponential backoff ${waitMs}ms (attempt ${capacityRetryCount + 1})`);

                     await showToast(
                       `⏳ Server busy (${response.status}). Retrying in ${waitSec}s...`,
                       "warning",
                     );
                     
                     await sleep(waitMs, abortSignal);
                     
                     // CRITICAL FIX: Decrement i so that the loop 'continue' retries the SAME endpoint index
                     // (i++ in the loop will bring it back to the current index)
                     // But limit retries to prevent infinite loops (Greptile feedback)
                     if (capacityRetryCount < 3) {
                       capacityRetryCount++;
                       i -= 1;
                       continue; 
                      } else {
                        pushDebug(`Max capacity retries (3) exhausted for endpoint ${currentEndpoint}, regenerating fingerprint...`);
                        // Regenerate fingerprint to get fresh device identity before trying next endpoint
                        const newFingerprint = accountManager.regenerateAccountFingerprint(account.index);
                        if (newFingerprint) {
                          pushDebug(`Fingerprint regenerated for account ${account.index}`);
                        }
                        continue;
                      }
                  }

                  // STRATEGY 2: RATE LIMIT EXCEEDED (RPM) / QUOTA EXHAUSTED / UNKNOWN
                  // Goal: Lock and Rotate (Standard Logic)
                  
                  // Only now do we call getRateLimitBackoff, which increments the global failure tracker
                  const quotaKey = headerStyleToQuotaKey(headerStyle, family);
                  const { attempt, delayMs, isDuplicate } = getRateLimitBackoff(account.index, quotaKey, serverRetryMs);
                  
                  // Calculate potential backoffs
                  const smartBackoffMs = calculateBackoffMs(rateLimitReason, account.consecutiveFailures ?? 0, serverRetryMs);
                  const effectiveDelayMs = Math.max(delayMs, smartBackoffMs);

                  pushDebug(
                    `429 idx=${account.index} email=${account.email ?? ""} family=${family} delayMs=${effectiveDelayMs} attempt=${attempt} reason=${rateLimitReason}`,
                  );
                  if (bodyInfo.message) {
                    pushDebug(`429 message=${bodyInfo.message}`);
                  }
                  if (bodyInfo.quotaResetTime) {
                    pushDebug(`429 quotaResetTime=${bodyInfo.quotaResetTime}`);
                  }
                  if (bodyInfo.reason) {
                    pushDebug(`429 reason=${bodyInfo.reason}`);
                  }

                   logRateLimitEvent(
                    account.index,
                    account.email,
                    family,
                    response.status,
                    effectiveDelayMs,
                    bodyInfo,
                  );

                  await logResponseBody(debugContext, response, 429);

                  getHealthTracker().recordRateLimit(account.index);

                  const accountLabel = account.email || `Account ${account.index + 1}`;

                  // Progressive retry for standard 429s: 1st 429 → 1s then switch (if enabled) or retry same
                  if (attempt === 1 && rateLimitReason !== "QUOTA_EXHAUSTED") {
                    await showToast(`Rate limited. Quick retry in 1s...`, "warning");
                    await sleep(FIRST_RETRY_DELAY_MS, abortSignal);
                    
                    // CacheFirst mode: wait for same account if within threshold (preserves prompt cache)
                    if (config.scheduling_mode === 'cache_first') {
                      const maxCacheFirstWaitMs = config.max_cache_first_wait_seconds * 1000;
                      // effectiveDelayMs is the backoff calculated for this account
                      if (effectiveDelayMs <= maxCacheFirstWaitMs) {
                        pushDebug(`cache_first: waiting ${effectiveDelayMs}ms for same account to recover`);
                        await showToast(`⏳ Waiting ${Math.ceil(effectiveDelayMs / 1000)}s for same account (prompt cache preserved)...`, "info");
                        accountManager.markRateLimitedWithReason(account, family, headerStyle, model, rateLimitReason, serverRetryMs);
                        await sleep(effectiveDelayMs, abortSignal);
                        // Retry same endpoint after wait
                        i -= 1;
                        continue;
                      }
                      // Wait time exceeds threshold, fall through to switch
                      pushDebug(`cache_first: wait ${effectiveDelayMs}ms exceeds max ${maxCacheFirstWaitMs}ms, switching account`);
                    }
                    
                    if (config.switch_on_first_rate_limit && accountCount > 1) {
                      accountManager.markRateLimitedWithReason(account, family, headerStyle, model, rateLimitReason, serverRetryMs, config.failure_ttl_seconds * 1000);
                      shouldSwitchAccount = true;
                      break;
                    }
                    
                    // Same endpoint retry for first RPM hit
                    i -= 1; 
                    continue;
                  }

                  accountManager.markRateLimitedWithReason(account, family, headerStyle, model, rateLimitReason, serverRetryMs, config.failure_ttl_seconds * 1000);

                  accountManager.requestSaveToDisk();

                  // For Gemini, try prioritized Antigravity across ALL accounts first
                  if (family === "gemini") {
                    if (headerStyle === "antigravity") {
                      // Check if any other account has Antigravity quota for this model
                      if (hasOtherAccountWithAntigravity(account)) {
                        pushDebug(`antigravity exhausted on account ${account.index}, but available on others. Switching account.`);
                        await showToast(`Rate limited again. Switching account in 5s...`, "warning");
                        await sleep(SWITCH_ACCOUNT_DELAY_MS, abortSignal);
                        shouldSwitchAccount = true;
                        break;
                      }

                      // All accounts exhausted for Antigravity on THIS model.
                      // Before falling back to the alternate quota pool, honor cli_first fallback direction.
                      const alternateStyle = accountManager.getAvailableHeaderStyle(account, family, model);
                      const fallbackStyle = resolveQuotaFallbackHeaderStyle({
                        quotaFallback: config.quota_fallback,
                        cliFirst: config.cli_first,
                        explicitQuota,
                        family,
                        headerStyle,
                        alternateStyle,
                      });
                      if (fallbackStyle) {
                        const safeModelName = model || "this model";
                        await showToast(
                          `Antigravity quota exhausted for ${safeModelName}. Switching to ${fallbackStyle === "gemini-cli" ? "Gemini CLI" : "Antigravity"} quota...`,
                          "warning",
                        );
                        headerStyle = fallbackStyle;
                        pushDebug(`quota fallback: ${headerStyle}`);
                        continue;
                      }
                    }
                  }

                  const quotaName = headerStyle === "antigravity" ? "Antigravity" : "Gemini CLI";

                  if (accountCount > 1) {
                    const quotaMsg = bodyInfo.quotaResetTime 
                      ? ` (quota resets ${bodyInfo.quotaResetTime})`
                      : ``;
                    await showToast(`Rate limited again. Switching account in 5s...${quotaMsg}`, "warning");
                    await sleep(SWITCH_ACCOUNT_DELAY_MS, abortSignal);
                    
                    lastFailure = {
                      response,
                      streaming: prepared.streaming,
                      debugContext,
                      requestedModel: prepared.requestedModel,
                      projectId: prepared.projectId,
                      endpoint: prepared.endpoint,
                      effectiveModel: prepared.effectiveModel,
                      sessionId: prepared.sessionId,
                      toolDebugMissing: prepared.toolDebugMissing,
                      toolDebugSummary: prepared.toolDebugSummary,
                      toolDebugPayload: prepared.toolDebugPayload,
                    };
                    shouldSwitchAccount = true;
                    break;
                  } else {
                    // Single account: exponential backoff (1s, 2s, 4s, 8s... max 60s)
                    const expBackoffMs = Math.min(FIRST_RETRY_DELAY_MS * Math.pow(2, attempt - 1), 60000);
                    const expBackoffFormatted = expBackoffMs >= 1000 ? `${Math.round(expBackoffMs / 1000)}s` : `${expBackoffMs}ms`;
                    await showToast(`Rate limited. Retrying in ${expBackoffFormatted} (attempt ${attempt})...`, "warning");
                    
                    lastFailure = {
                      response,
                      streaming: prepared.streaming,
                      debugContext,
                      requestedModel: prepared.requestedModel,
                      projectId: prepared.projectId,
                      endpoint: prepared.endpoint,
                      effectiveModel: prepared.effectiveModel,
                      sessionId: prepared.sessionId,
                      toolDebugMissing: prepared.toolDebugMissing,
                      toolDebugSummary: prepared.toolDebugSummary,
                      toolDebugPayload: prepared.toolDebugPayload,
                    };
                    
                    await sleep(expBackoffMs, abortSignal);
                    shouldSwitchAccount = true;
                    break;
                  }
                }

                // Success - reset rate limit backoff state for this quota
                const quotaKey = headerStyleToQuotaKey(headerStyle, family);
                resetRateLimitState(account.index, quotaKey);
                resetAccountFailureState(account.index);

                // Only retry alternate endpoints for transient errors.
                // A 403 is typically account-specific (e.g., VALIDATION_REQUIRED) and retrying
                // other endpoints just hides the actionable verification link from the user.
                const shouldRetryEndpoint = (
                  response.status === 404 ||
                  response.status >= 500
                );

                if (shouldRetryEndpoint) {
                  await logResponseBody(debugContext, response, response.status);
                }

                if (shouldRetryEndpoint && i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
                  lastFailure = {
                    response,
                    streaming: prepared.streaming,
                    debugContext,
                    requestedModel: prepared.requestedModel,
                    projectId: prepared.projectId,
                    endpoint: prepared.endpoint,
                    effectiveModel: prepared.effectiveModel,
                    sessionId: prepared.sessionId,
                    toolDebugMissing: prepared.toolDebugMissing,
                    toolDebugSummary: prepared.toolDebugSummary,
                    toolDebugPayload: prepared.toolDebugPayload,
                  };
                  continue;
                }

                // Success or non-retryable error - return the response
                if (response.ok) {
                  account.consecutiveFailures = 0;
                  getHealthTracker().recordSuccess(account.index);
                  accountManager.markAccountUsed(account.index);
                }
                logAntigravityDebugResponse(debugContext, response, {
                  note: response.ok ? "Success" : `Error ${response.status}`,
                });
                if (!response.ok) {
                  await logResponseBody(debugContext, response, response.status);

                  // If an account is missing a Gemini Code Assist license (#3501),
                  // automatically rotate to the next account (user requested behavior).
                  //
                  // This error is account/project-specific and will not be fixed by endpoint fallbacks.
                  // Avoid returning this error to the user if other accounts can succeed.
                  let errorBodyText = "";
                  try {
                    errorBodyText = await response.clone().text();
                  } catch {
                    errorBodyText = "";
                  }
                  if (isGeminiCodeAssistLicenseError(errorBodyText)) {
                    const accountLabel = account.email ? account.email : `Account ${account.index + 1}`;
                    const upstreamMsg = summarizeUpstreamLicenseMessage(errorBodyText);
                    await showToast(`No Gemini Code Assist license (${accountLabel})`, "warning");

                    // Cool down this account for a while to avoid repeated selection loops.
                    const cooldownMs = 10 * 60 * 1000;
                    // Treat license errors as a project-scoped configuration problem.
                    accountManager.markAccountCoolingDown(account, cooldownMs, "project-error");
                    accountManager.markRateLimited(account, cooldownMs, family, headerStyle, model);
                    accountManager.requestSaveToDisk();

                    lastError = new Error(upstreamMsg);
                    lastFailure = {
                      response,
                      streaming: prepared.streaming,
                      debugContext,
                      requestedModel: prepared.requestedModel,
                      projectId: prepared.projectId,
                      endpoint: prepared.endpoint,
                      effectiveModel: prepared.effectiveModel,
                      sessionId: prepared.sessionId,
                      toolDebugMissing: prepared.toolDebugMissing,
                      toolDebugSummary: prepared.toolDebugSummary,
                      toolDebugPayload: prepared.toolDebugPayload,
                    };

                    shouldSwitchAccount = true;
                    break;
                  }

                  // 403 VALIDATION_REQUIRED: Google account needs manual verification.
                  // Runtime/TUI behavior must be minimal: quarantine the account so it won't be
                  // selected again, and tell the user to verify via `opencode auth login`.
                  if (response.status === 403) {
                    const extracted = extractValidationUrlAndMessage(errorBodyText, account.email);
                    if (extracted.isValidationRequired) {
                      const accountLabel = account.email ? account.email : `Account ${account.index + 1}`;
                      await showToast(
                        `Verification required (${accountLabel}). Run \`opencode auth login\` to verify.`,
                        "warning",
                      );

                      // Remove from the active pool (and persist) so rotation doesn't keep hitting it.
                      await accountManager.quarantineAccountForVerification(
                        account,
                        summarizeUpstreamValidationMessage(extracted.message ?? errorBodyText),
                        extracted.validationUrl,
                      );

                      if (accountManager.getAccountCount() === 0) {
                        const errorMessage = [
                          "Antigravity account verification required.",
                          "",
                          `Blocked account: ${accountLabel}`,
                          "",
                          "Run: opencode auth login",
                          "Then: Verify blocked accounts",
                          "",
                          "After verification completes, retry your last prompt. (No restart required.)",
                        ].join("\n");
                        const synthetic = createSyntheticErrorResponse(
                          errorMessage,
                          prepared.requestedModel ?? prepared.effectiveModel ?? "unknown",
                          "validation_required",
                        );
                        return await transformAntigravityResponse(
                          synthetic,
                          true,
                          debugContext,
                          prepared.requestedModel,
                          prepared.projectId,
                          prepared.endpoint,
                          prepared.effectiveModel,
                          prepared.sessionId,
                          prepared.toolDebugMissing,
                          prepared.toolDebugSummary,
                          prepared.toolDebugPayload,
                          debugLines,
                        );
                      }

                      lastError = new Error(
                        "Antigravity account verification required. Run `opencode auth login` and choose \"Verify blocked accounts\".",
                      );
                      shouldSwitchAccount = true;
                      break;
                    }
                  }
                  
                  // Handle 400 "Prompt too long" with synthetic response to avoid session lock
                  if (response.status === 400) {
                    const cloned = response.clone();
                    const bodyText = await cloned.text();
                    if (bodyText.includes("Prompt is too long") || bodyText.includes("prompt_too_long")) {
                      await showToast(
                        "Context too long - use /compact to reduce size",
                        "warning"
                      );
                      const errorMessage = `[Antigravity Error] Context is too long for this model.\n\nPlease use /compact to reduce context size, then retry your request.\n\nAlternatively, you can:\n- Use /clear to start fresh\n- Use /undo to remove recent messages\n- Switch to a model with larger context window`;
                      const synthetic = createSyntheticErrorResponse(errorMessage, prepared.requestedModel);
                      return await transformAntigravityResponse(
                        synthetic,
                        true,
                        debugContext,
                        prepared.requestedModel,
                        prepared.projectId,
                        prepared.endpoint,
                        prepared.effectiveModel,
                        prepared.sessionId,
                        prepared.toolDebugMissing,
                        prepared.toolDebugSummary,
                        prepared.toolDebugPayload,
                        debugLines,
                      );
                    }
                  }
                }
                
                // Empty response retry logic (ported from LLM-API-Key-Proxy)
                // For non-streaming responses, check if the response body is empty
                // and retry if so (up to config.empty_response_max_attempts times)
                if (response.ok && !prepared.streaming) {
                  const maxAttempts = config.empty_response_max_attempts ?? 4;
                  const retryDelayMs = config.empty_response_retry_delay_ms ?? 2000;
                  
                  // Clone to check body without consuming original
                  const clonedForCheck = response.clone();
                  const bodyText = await clonedForCheck.text();
                  
                  if (isEmptyResponseBody(bodyText)) {
                    // Track empty response attempts per request
                    const emptyAttemptKey = `${prepared.sessionId ?? "none"}:${prepared.effectiveModel ?? "unknown"}`;
                    const currentAttempts = (emptyResponseAttempts.get(emptyAttemptKey) ?? 0) + 1;
                    emptyResponseAttempts.set(emptyAttemptKey, currentAttempts);
                    
                    pushDebug(`empty-response: attempt ${currentAttempts}/${maxAttempts}`);
                    
                    if (currentAttempts < maxAttempts) {
                      await showToast(
                        `Empty response received. Retrying (${currentAttempts}/${maxAttempts})...`,
                        "warning"
                      );
                      await sleep(retryDelayMs, abortSignal);
                      continue; // Retry the endpoint loop
                    }
                    
                    // Clean up and throw after max attempts
                    emptyResponseAttempts.delete(emptyAttemptKey);
                    throw new EmptyResponseError(
                      "antigravity",
                      prepared.effectiveModel ?? "unknown",
                      currentAttempts,
                    );
                  }
                  
                  // Clean up successful attempt tracking
                  const emptyAttemptKeyClean = `${prepared.sessionId ?? "none"}:${prepared.effectiveModel ?? "unknown"}`;
                  emptyResponseAttempts.delete(emptyAttemptKeyClean);
                }
                
                const transformedResponse = await transformAntigravityResponse(
                  response,
                  prepared.streaming,
                  debugContext,
                  prepared.requestedModel,
                  prepared.projectId,
                  prepared.endpoint,
                  prepared.effectiveModel,
                  prepared.sessionId,
                  prepared.toolDebugMissing,
                  prepared.toolDebugSummary,
                  prepared.toolDebugPayload,
                  debugLines,
                );

                // Check for context errors and show appropriate toast
                const contextError = transformedResponse.headers.get("x-antigravity-context-error");
                if (contextError) {
                  if (contextError === "prompt_too_long") {
                    await showToast(
                      "Context too long - use /compact to reduce size, or trim your request",
                      "warning"
                    );
                  } else if (contextError === "tool_pairing") {
                    await showToast(
                      "Tool call/result mismatch - use /compact to fix, or /undo last message",
                      "warning"
                    );
                  }
                }

                return transformedResponse;
              } catch (error) {
                // Refund token on network/API error (only if consumed)
                if (tokenConsumed) {
                  getTokenTracker().refund(account.index);
                  tokenConsumed = false;
                }

                // Handle recoverable thinking errors - retry with forced recovery
                if (error instanceof Error && error.message === "THINKING_RECOVERY_NEEDED") {
                  // Only retry once with forced recovery to avoid infinite loops
                  if (!forceThinkingRecovery) {
                    pushDebug("thinking-recovery: API error detected, retrying with forced recovery");
                    forceThinkingRecovery = true;
                    i = -1; // Will become 0 after loop increment, restart endpoint loop
                    continue;
                  }
                  
                  // Already tried with forced recovery, give up and return error
                  const recoveryError = error as any;
                  const originalError = recoveryError.originalError || { error: { message: "Thinking recovery triggered" } };
                  
                  const recoveryMessage = `${originalError.error?.message || "Session recovery failed"}\n\n[RECOVERY] Thinking block corruption could not be resolved. Try starting a new session.`;
                  
                  return new Response(JSON.stringify({
                    type: "error",
                    error: {
                      type: "unrecoverable_error",
                      message: recoveryMessage
                    }
                  }), {
                    status: 400,
                    headers: { "Content-Type": "application/json" }
                  });
                }

                if (i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
                  lastError = error instanceof Error ? error : new Error(String(error));
                  continue;
                }

                // All endpoints failed for this account - track failure and try next account
                const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
                lastError = error instanceof Error ? error : new Error(String(error));
                if (shouldCooldown) {
                  accountManager.markAccountCoolingDown(account, cooldownMs, "network-error");
                  accountManager.markRateLimited(account, cooldownMs, family, headerStyle, model);
                  pushDebug(`endpoint-error: cooldown ${cooldownMs}ms after ${failures} failures`);
                }
                shouldSwitchAccount = true;
                break;
              }
            }
            } // end headerStyleLoop
            
            if (shouldSwitchAccount) {
              // Avoid tight retry loops when there's only one account.
              if (accountCount <= 1) {
                if (lastFailure) {
                  return transformAntigravityResponse(
                    lastFailure.response,
                    lastFailure.streaming,
                    lastFailure.debugContext,
                    lastFailure.requestedModel,
                    lastFailure.projectId,
                    lastFailure.endpoint,
                    lastFailure.effectiveModel,
                    lastFailure.sessionId,
                    lastFailure.toolDebugMissing,
                    lastFailure.toolDebugSummary,
                    lastFailure.toolDebugPayload,
                    debugLines,
                  );
                }

                throw lastError || new Error("All Antigravity endpoints failed");
              }

              continue;
            }

            // If we get here without returning, something went wrong
            if (lastFailure) {
              return transformAntigravityResponse(
                lastFailure.response,
                lastFailure.streaming,
                lastFailure.debugContext,
                lastFailure.requestedModel,
                lastFailure.projectId,
                lastFailure.endpoint,
                lastFailure.effectiveModel,
                lastFailure.sessionId,
                lastFailure.toolDebugMissing,
                lastFailure.toolDebugSummary,
                lastFailure.toolDebugPayload,
                debugLines,
              );
            }

            throw lastError || new Error("All Antigravity accounts failed");
          }
        },
      };
    },
    methods: [
      {
        label: "OAuth with Google (Antigravity)",
        type: "oauth",
        authorize: async (inputs?: Record<string, string>) => {
          const isHeadless = !!(
            process.env.SSH_CONNECTION ||
            process.env.SSH_CLIENT ||
            process.env.SSH_TTY ||
            process.env.OPENCODE_HEADLESS
          );

          // CLI flow (`opencode auth login`) passes an inputs object.
          if (inputs) {
            const accounts: Array<Extract<AntigravityTokenExchangeResult, { type: "success" }>> = [];
            const noBrowser = inputs.noBrowser === "true" || inputs["no-browser"] === "true";
            const useManualMode = noBrowser || shouldSkipLocalServer();

            // Check for existing accounts and prompt user for login mode
            let startFresh = true;
            let refreshAccountIndex: number | undefined;
            let existingStorage = await loadAccounts();
            let blockedStorage = await loadBlockedAccounts();
            const hasActiveAccounts = (existingStorage?.accounts?.length ?? 0) > 0;
            const hasQuarantinedAccounts = blockedStorage.accounts.length > 0;

            if (!existingStorage) {
              existingStorage = { version: 3, accounts: [], activeIndex: 0 };
            }

            if (hasActiveAccounts || hasQuarantinedAccounts) {
              let menuResult;
              while (true) {
                const now = Date.now();
                const existingAccounts = existingStorage.accounts.map((acc, idx) => {
                  let status: 'active' | 'rate-limited' | 'expired' | 'unknown' = 'unknown';
                  
                  const rateLimits = acc.rateLimitResetTimes;
                  if (rateLimits) {
                    const isRateLimited = Object.values(rateLimits).some(
                      (resetTime) => typeof resetTime === 'number' && resetTime > now
                    );
                    if (isRateLimited) {
                      status = 'rate-limited';
                    } else {
                      status = 'active';
                    }
                  } else {
                    status = 'active';
                  }

                  if (acc.coolingDownUntil && acc.coolingDownUntil > now) {
                    status = 'rate-limited';
                  }

                  return {
                    email: acc.email,
                    index: idx,
                    addedAt: acc.addedAt,
                    lastUsed: acc.lastUsed,
                    status,
                    isCurrentAccount: idx === (existingStorage.activeIndex ?? 0),
                    enabled: acc.enabled !== false,
                  };
                });
                
                menuResult = await promptLoginMode(existingAccounts);

                if (menuResult.deleteAccountIndex !== undefined) {
                  const deleteIndex = menuResult.deleteAccountIndex;
                  const toDelete = existingStorage.accounts[deleteIndex];
                  const label = toDelete?.email || `Account ${deleteIndex + 1}`;
                  const refreshToken = typeof toDelete?.refreshToken === "string" ? toDelete.refreshToken : undefined;

                  const updatedAccounts = existingStorage.accounts.filter((_, idx) => idx !== deleteIndex);
                  existingStorage.accounts = updatedAccounts;

                  // Clamp active index after deletion.
                  const nextActive = updatedAccounts.length > 0
                    ? Math.min(existingStorage.activeIndex ?? 0, updatedAccounts.length - 1)
                    : 0;
                  existingStorage.activeIndex = nextActive;

                  // Merge+preserve deletions so concurrent OpenCode processes don't resurrect the account.
                  await saveAccounts(existingStorage, {
                    merge: true,
                    preserveDeletions: true,
                    removedRefreshTokens: refreshToken ? [refreshToken] : undefined,
                  });
                  // Also remove from blocked/quarantine storage if present.
                  if (refreshToken) {
                    blockedStorage.accounts = (blockedStorage.accounts ?? []).filter((a: any) => a?.refreshToken !== refreshToken);
                    await saveBlockedAccounts(blockedStorage);
                  }
                  console.log(`\nDeleted ${label}.\n`);
                  continue;
                }

                if (menuResult.mode === "check") {
                  type QuotaMenuChoice =
                    | { type: "back" }
                    | { type: "rescan" }
                    | { type: "account"; index: number };

                  type QuotaAction = { type: "back" } | { type: "copy" };

                  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

                  const pct = (value?: number) =>
                    typeof value === "number" && Number.isFinite(value)
                      ? `${Math.round(value * 100)}%`
                      : "UNKNOWN";

                  const resetHint = (resetTime?: string) => {
                    if (!resetTime) return "";
                    const delta = Date.parse(resetTime) - Date.now();
                    if (!Number.isFinite(delta)) return "";
                    return `, resets in ${formatWaitTime(delta)}`;
                  };

                  const summarizeGroups = (res: AccountQuotaResult): string => {
                    const groups = res.quota?.groups;
                    if (!groups) return "";
                    const parts: string[] = [];
                    if (groups.claude) parts.push(`C:${pct(groups.claude.remainingFraction)}`);
                    if (groups["gemini-pro"]) parts.push(`P:${pct(groups["gemini-pro"].remainingFraction)}`);
                    if (groups["gemini-flash"]) parts.push(`F:${pct(groups["gemini-flash"].remainingFraction)}`);
                    return parts.join(" ");
                  };

                  const quotaErrorOf = (res: AccountQuotaResult): string | undefined => {
                    if (res.status === "error") return res.error || "Unknown error";
                    if (res.quota?.error) return res.quota.error;
                    return undefined;
                  };

                  const badgeOf = (res: AccountQuotaResult): string => {
                    if (res.disabled) return "[disabled]";
                    return quotaErrorOf(res) ? "[error]" : "[ok]";
                  };

                  const colorOf = (res: AccountQuotaResult): MenuItem<QuotaMenuChoice>["color"] => {
                    if (res.disabled) return undefined;
                    return quotaErrorOf(res) ? "red" : "green";
                  };

                  const runCheck = async (): Promise<AccountQuotaResult[]> => {
                    console.log("\nChecking quotas for all accounts...\n");
                    const results = await checkAccountsQuota(existingStorage.accounts, client, providerId, {
                      concurrency: 3,
                      perAccountTimeoutMs: 25_000,
                      onProgress: ({ done, total, result }) => {
                        const label = result.email || `Account ${result.index + 1}`;
                        const disabledStr = result.disabled ? " (disabled)" : "";
                        const err = quotaErrorOf(result);
                        const status = result.status === "disabled"
                          ? "DISABLED"
                          : err ? `ERROR (${err})` : "OK";
                        console.log(`[${done}/${total}] ${label}${disabledStr}: ${status}`);
                      },
                    });

                    let needsSave = false;
                    const addedRefreshTokens = new Set<string>();
                    const removedRefreshTokens = new Set<string>();
                    for (const res of results) {
                      if (res.updatedAccount) {
                        const previous = existingStorage.accounts[res.index];
                        const previousRefreshToken = previous?.refreshToken;
                        const nextRefreshToken = res.updatedAccount.refreshToken;
                        if (
                          typeof previousRefreshToken === "string"
                          && previousRefreshToken
                          && typeof nextRefreshToken === "string"
                          && nextRefreshToken
                          && previousRefreshToken !== nextRefreshToken
                        ) {
                          removedRefreshTokens.add(previousRefreshToken);
                          addedRefreshTokens.add(nextRefreshToken);
                        }
                        existingStorage.accounts[res.index] = res.updatedAccount;
                        needsSave = true;
                      }
                    }
                    if (needsSave) {
                      await saveAccounts(existingStorage, {
                        merge: true,
                        preserveDeletions: true,
                        addedRefreshTokens: Array.from(addedRefreshTokens),
                        removedRefreshTokens: Array.from(removedRefreshTokens),
                      });
                    }

                    return results;
                  };

                  let results = await runCheck();

                  if (!isInteractive) {
                    for (const res of results) {
                      const label = res.email || `Account ${res.index + 1}`;
                      const disabledStr = res.disabled ? " (disabled)" : "";
                      console.log(`\n${res.index + 1}. ${label}${disabledStr}`);

                      const err = quotaErrorOf(res);
                      if (err) {
                        console.log(`   Error: ${err}`);
                        continue;
                      }

                      if (!res.quota || Object.keys(res.quota.groups).length === 0) {
                        console.log("   No quota information available.");
                        continue;
                      }

                      const printGrp = (name: string, group: any) => {
                        if (!group) return;
                        console.log(
                          `   ${name}: ${pct(group.remainingFraction)}${resetHint(group.resetTime)}`,
                        );
                      };
                      printGrp("Claude", res.quota.groups.claude);
                      printGrp("Gemini 3 Pro", res.quota.groups["gemini-pro"]);
                      printGrp("Gemini 3 Flash", res.quota.groups["gemini-flash"]);
                    }

                    console.log("");
                    continue;
                  }

                  const summaryCounts = (results: AccountQuotaResult[]) => {
                    const disabled = results.filter((r) => r.disabled).length;
                    const errored = results.filter((r) => !r.disabled && !!quotaErrorOf(r)).length;
                    const ok = Math.max(0, results.length - disabled - errored);
                    return { ok, errored, disabled };
                  };

                  while (true) {
                    const counts = summaryCounts(results);

                    const items: MenuItem<QuotaMenuChoice>[] = [
                      { label: "Actions", value: { type: "back" }, kind: "heading" },
                      { label: "Rescan accounts", value: { type: "rescan" }, color: "cyan" },
                      { label: "Back", value: { type: "back" } },
                      { label: "", value: { type: "back" }, separator: true },
                      { label: "Accounts", value: { type: "back" }, kind: "heading" },
                      ...results.map((res) => {
                        const label = res.email || `Account ${res.index + 1}`;
                        const numbered = `${res.index + 1}. ${label}`;
                        const hint = quotaErrorOf(res) ? "" : summarizeGroups(res);
                        return {
                          label: `${numbered} ${badgeOf(res)}`,
                          hint,
                          value: { type: "account" as const, index: res.index },
                          color: colorOf(res),
                        };
                      }),
                    ];

                    const choice = await select(items, {
                      message: "Check quotas",
                      subtitle: `Results: ${counts.ok} ok, ${counts.errored} error, ${counts.disabled} disabled`,
                      help: "Up/Down to select | Enter: details | Esc: back",
                      clearScreen: true,
                    });

                    if (!choice || choice.type === "back") break;

                    if (choice.type === "rescan") {
                      results = await runCheck();
                      continue;
                    }

                    const selected = results.find((r) => r.index === choice.index);
                    if (!selected) continue;

                    const label = selected.email || `Account ${selected.index + 1}`;
                    const err = quotaErrorOf(selected);

                    const detailLines: string[] = [];
                    if (selected.disabled) {
                      detailLines.push("This account is disabled and will not be used for requests.");
                    }
                    if (err) {
                      detailLines.push(`Error: ${err}`);
                    }

                    const quota = selected.quota;
                    if (!quota || Object.keys(quota.groups).length === 0) {
                      if (!err) {
                        detailLines.push("No quota information available.");
                      }
                    } else {
                      const pushGrp = (name: string, group: any) => {
                        if (!group) return;
                        detailLines.push(`${name}: ${pct(group.remainingFraction)}${resetHint(group.resetTime)}`);
                      };
                      pushGrp("Claude", quota.groups.claude);
                      pushGrp("Gemini 3 Pro", quota.groups["gemini-pro"]);
                      pushGrp("Gemini 3 Flash", quota.groups["gemini-flash"]);
                      if (quota.modelCount) detailLines.push(`Models counted: ${quota.modelCount}`);
                    }

                    const copyText = `Quota check for ${label}\n` + detailLines.map((l) => `- ${l}`).join("\n");

                    const actionItems: MenuItem<QuotaAction>[] = [
                      { label: "Details", value: { type: "back" }, kind: "heading" },
                      ...detailLines.map(
                        (l): MenuItem<QuotaAction> => ({ label: l, value: { type: "back" }, kind: "heading" }),
                      ),
                      { label: "", value: { type: "back" }, separator: true },
                      { label: "Copy details", value: { type: "copy" }, color: "cyan" },
                      { label: "Back", value: { type: "back" } },
                    ];

                    const action = await select(actionItems, {
                      message: `Quota: ${label}`,
                      subtitle: badgeOf(selected),
                      help: "Up/Down to select | Enter: confirm | Esc: back",
                      clearScreen: true,
                    });

                    if (!action || action.type === "back") continue;

                    const copied = copyTextToClipboard(copyText);
                    if (copied) {
                      console.log("\nCopied quota details to clipboard.\n");
                    } else {
                      console.log(`\n${copyText}\n`);
                    }
                  }

                  console.log("");
                  continue;
                }

                if (menuResult.mode === "verify") {
                  const labelOf = (r: VerificationScanResult) => r.email || `Account ${r.index + 1}`;

                  let scanResults: VerificationScanResult[] = [];

                  const runScan = async () => {
                    // Reload quarantined accounts each scan so the UI reflects runtime quarantines.
                    blockedStorage = await loadBlockedAccounts();

                    const activeAccounts = existingStorage.accounts;
                    const quarantinedAccounts = blockedStorage.accounts;

                    const total = activeAccounts.length + quarantinedAccounts.length;
                    let done = 0;

                    console.log("\nScanning accounts for Google verification blocks...\n");

                    const onProgress = (result: VerificationScanResult) => {
                      done += 1;
                      const label = labelOf(result);
                      const disabledStr = result.enabled ? "" : " (disabled)";
                      const originStr = result.origin === "quarantined" ? " (quarantined)" : "";
                      console.log(
                        `[${done}/${Math.max(1, total)}] ${label}${disabledStr}${originStr}: ${formatVerificationScanStatusForDisplay(result)}`,
                      );
                    };

                    const activeResults = await scanAllAccountsForVerification(
                      activeAccounts,
                      client,
                      providerId,
                      {
                        concurrency: 3,
                        perAccountTimeoutMs: 25_000,
                        onProgress: ({ result }) => onProgress(result),
                      },
                      "active",
                    );

                    const quarantinedResults = await scanAllAccountsForVerification(
                      quarantinedAccounts,
                      client,
                      providerId,
                      {
                        concurrency: 3,
                        perAccountTimeoutMs: 25_000,
                        onProgress: ({ result }) => onProgress(result),
                      },
                      "quarantined",
                    );

                     scanResults = [...activeResults, ...quarantinedResults];

                      // Prefer the verification URL captured at quarantine time (from runtime),
                      // since the scan endpoint can sometimes return shortened URLs that 400.
                      const quarantinedByToken = new Map(
                        (blockedStorage.accounts ?? [])
                          .filter((a: any) => a?.refreshToken)
                          .map((a: any) => [a.refreshToken as string, a] as const),
                      );
                      for (const r of scanResults) {
                        if (r.origin !== "quarantined") continue;
                        const blockedAcc = quarantinedByToken.get(r.refreshToken);
                        const storedUrl = blockedAcc?.verifyUrl;
                        if (typeof storedUrl !== "string" || !storedUrl.trim()) continue;

                        if (!r.verifyUrl) {
                          r.verifyUrl = storedUrl.trim();
                          continue;
                        }

                        const hasPlt = (u: string) => u.toLowerCase().includes("plt=");
                        if (hasPlt(storedUrl) && !hasPlt(r.verifyUrl)) {
                          r.verifyUrl = storedUrl.trim();
                        }
                      }

                     // Auto-restore quarantined accounts that are now OK.
                     const okQuarantined = scanResults.filter((r) => r.origin === "quarantined" && r.status === "ok");
                     if (okQuarantined.length > 0) {
                      const okSet = new Set(okQuarantined.map((r) => r.refreshToken));
                      const toRestore = blockedStorage.accounts.filter((a) => okSet.has(a.refreshToken));
                      const remainingBlocked = blockedStorage.accounts.filter((a) => !okSet.has(a.refreshToken));

                      let restoredCount = 0;
                       for (const blockedAcc of toRestore) {
                         // Strip blocked-only fields before moving back into the active rotation pool.
                         const { blockedAt, blockedReason, verifyUrl, ...rest } = blockedAcc as any;
                         if (!rest?.refreshToken) continue;
                         if (!existingStorage.accounts.some((a) => a.refreshToken === rest.refreshToken)) {
                           existingStorage.accounts.push(rest);
                           restoredCount += 1;
                         }
                       }

                      blockedStorage.accounts = remainingBlocked as any;
                      await saveAccounts(existingStorage, {
                        merge: true,
                        preserveDeletions: true,
                        addedRefreshTokens: toRestore.map((a: any) => a?.refreshToken).filter(Boolean),
                      });
                      await saveBlockedAccounts(blockedStorage);

                      if (restoredCount > 0) {
                        console.log(`\nRestored ${restoredCount} verified account(s) to active rotation.\n`);
                      }
                    }

                    const blocked = scanResults.filter((r) => r.status === "blocked");
                    const license = scanResults.filter((r) => r.status === "license");
                    const ok = scanResults.filter((r) => r.status === "ok");
                    const skipped = scanResults.filter((r) => r.status === "skipped");
                    const errors = scanResults.filter((r) => r.status === "error");

                    console.log(
                      `\nResults: ${ok.length} ok, ${blocked.length} blocked, ${license.length} no-license, ${errors.length} error, ${skipped.length} skipped\n`,
                    );
                  };

                  await runScan();

                  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
                  if (!isInteractive) {
                    const blocked = scanResults.filter((r) => r.status === "blocked" && !!r.verifyUrl);
                    if (blocked.length === 0) {
                      console.log("\nNo blocked accounts detected.\n");
                      continue;
                    }

                    console.log("\nBlocked accounts:\n");
                    for (const b of blocked) {
                      console.log(`- ${labelOf(b)}${b.origin === "quarantined" ? " (quarantined)" : ""}`);
                      if (b.verifyUrl) console.log(`  ${b.verifyUrl}`);
                    }
                    console.log("");
                    continue;
                  }

                  type VerifyMenuChoice =
                    | { type: "back" }
                    | { type: "rescan" }
                    | { type: "toggleAll" }
                    | { type: "account"; refreshToken: string };

                  const badgeOf = (r: VerificationScanResult): string => {
                    const originBadge = r.origin === "quarantined" ? "[quarantined]" : "";
                    if (r.enabled === false || r.status === "skipped") {
                      return originBadge ? `${originBadge} [disabled]` : "[disabled]";
                    }
                    const statusBadge = (() => {
                      switch (r.status) {
                        case "ok":
                          return "[ok]";
                        case "blocked":
                          return "[blocked]";
                        case "license":
                          return "[no-license]";
                        case "error":
                        default:
                          return "[error]";
                      }
                    })();
                    return originBadge ? `${originBadge} ${statusBadge}` : statusBadge;
                  };

                  const colorOf = (r: VerificationScanResult): MenuItem<VerifyMenuChoice>["color"] => {
                    if (r.enabled === false || r.status === "skipped") return undefined;
                    switch (r.status) {
                      case "ok":
                        return "green";
                      case "blocked":
                        return "red";
                      case "license":
                        return "yellow";
                      case "error":
                      default:
                        return "red";
                    }
                  };

                  const rankOf = (r: VerificationScanResult): number => {
                    // Prioritize actionable items first.
                    switch (r.status) {
                      case "blocked":
                        return 0;
                      case "error":
                        return 1;
                      case "license":
                        return 2;
                      case "ok":
                        return 3;
                      case "skipped":
                      default:
                        return 4;
                    }
                  };

                  type BlockedAction =
                    | { type: "back" }
                    | { type: "copySignin" }
                    | { type: "openSignin" }
                    | { type: "copyDirect" }
                    | { type: "openDirect" };
                  type DetailAction = { type: "back" } | { type: "copy" };

                  let showAll = false;

                  const sortedForUi = (): VerificationScanResult[] =>
                    [...scanResults].sort((a, b) => {
                      const ra = rankOf(a);
                      const rb = rankOf(b);
                      if (ra !== rb) return ra - rb;
                      const ao = a.origin === "quarantined" ? 0 : 1;
                      const bo = b.origin === "quarantined" ? 0 : 1;
                      if (ao !== bo) return ao - bo;
                      return labelOf(a).localeCompare(labelOf(b));
                    });

                  while (true) {
                    const sorted = sortedForUi();
                    const blocked = sorted.filter((r) => r.status === "blocked");
                    const issues = sorted.filter((r) => r.status === "license" || r.status === "error");
                    const ok = sorted.filter((r) => r.status === "ok");
                    const skipped = sorted.filter((r) => r.status === "skipped");

                    const hasActionable = blocked.length > 0 || issues.length > 0;

                    const items: MenuItem<VerifyMenuChoice>[] = [
                      { label: "Actions", value: { type: "back" }, kind: "heading" },
                      { label: "Rescan accounts", value: { type: "rescan" }, color: "cyan" },
                      {
                        label: showAll ? "Hide OK accounts" : "Show all accounts",
                        value: { type: "toggleAll" },
                        color: "cyan",
                      },
                      { label: "Back", value: { type: "back" } },
                      { label: "", value: { type: "back" }, separator: true },
                    ];

                    if (!hasActionable && !showAll) {
                      items.push({ label: "No blocked accounts detected.", value: { type: "back" }, kind: "heading" });
                    }

                    const pushGroup = (title: string, group: VerificationScanResult[]) => {
                      if (group.length === 0) return;
                      items.push({ label: title, value: { type: "back" }, kind: "heading" });
                      for (const r of group) {
                        items.push({
                          label: `${r.index + 1}. ${labelOf(r)} ${badgeOf(r)}`,
                          value: { type: "account" as const, refreshToken: r.refreshToken },
                          color: colorOf(r),
                        });
                      }
                      items.push({ label: "", value: { type: "back" }, separator: true });
                    };

                    if (hasActionable || showAll) {
                      pushGroup("Blocked (verification required)", blocked);
                      pushGroup("Other issues", issues);
                    }
                    if (showAll) {
                      pushGroup("OK", ok);
                      pushGroup("Disabled", skipped);
                    }

                    // Remove trailing separator if present.
                    const last = items[items.length - 1];
                    if (last?.separator) items.pop();

                    const subtitle = showAll
                      ? "All accounts (blocked first)"
                      : hasActionable
                        ? "Actionable accounts first"
                        : "All accounts OK";

                    const choice = await select(items, {
                      message: "Verify blocked accounts",
                      subtitle,
                      help: "Up/Down to select | Enter: options | Esc: back",
                      clearScreen: true,
                    });

                    if (!choice || choice.type === "back") break;

                    if (choice.type === "toggleAll") {
                      showAll = !showAll;
                      continue;
                    }

                    if (choice.type === "rescan") {
                      await runScan();
                      continue;
                    }

                    const selected = scanResults.find((r) => r.refreshToken === choice.refreshToken);
                    if (!selected) continue;

                    const selectedLabel = labelOf(selected);
                    const selectedStatus = formatVerificationScanStatusForDisplay(selected);

                    if (selected.status === "blocked") {
                      const verifyUrl = selected.verifyUrl ?? "";
                      if (!verifyUrl) {
                        console.log("\nBlocked account detected, but Google did not return a verification URL.\n");
                        continue;
                      }

                      const verifyLink = normalizeGoogleVerificationUrl(verifyUrl.trim(), selected.email);
                      const signinFirstLink = buildGoogleSigninFirstUrl(verifyLink, selected.email);

                      const action = await select<BlockedAction>(
                        [
                          { label: "Open sign-in page (prefill email)", value: { type: "openSignin" }, color: "cyan" },
                          { label: "Copy sign-in page link", value: { type: "copySignin" }, color: "cyan" },
                          { label: "Open direct verification link", value: { type: "openDirect" } },
                          { label: "Copy direct verification link", value: { type: "copyDirect" } },
                          { label: "Back", value: { type: "back" } },
                        ],
                        {
                          message: `Verify ${selectedLabel}`,
                          subtitle: "Sign-in first prefills the blocked email, then continues to verification",
                          help: "Up/Down to select | Enter: confirm | Esc: back",
                          clearScreen: true,
                        },
                      );

                      if (!action || action.type === "back") continue;

                      if (action.type === "copySignin") {
                        const ok = copyTextToClipboard(signinFirstLink);
                        if (ok) {
                          console.log("\nSign-in link copied to clipboard (email prefilled).\n");
                        } else {
                          console.log("\nFailed to copy sign-in link to clipboard.\n");
                          console.log(`${signinFirstLink}\n`);
                        }
                        continue;
                      }

                      if (action.type === "openSignin") {
                        const opened = await openUrlInDefaultBrowser(signinFirstLink);
                        if (opened) {
                          console.log("\nOpened sign-in page (email prefilled). After password, Google should continue to verification.\n");
                        } else {
                          console.log("\nCould not open browser automatically. Use this sign-in link:\n");
                          console.log(`${signinFirstLink}\n`);
                        }
                        continue;
                      }

                      if (action.type === "copyDirect") {
                        const ok = copyTextToClipboard(verifyLink);
                        if (ok) {
                          console.log("\nDirect verification link copied to clipboard.\n");
                        } else {
                          console.log("\nFailed to copy direct verification link to clipboard.\n");
                          console.log(`${verifyLink}\n`);
                        }
                        continue;
                      }

                      if (action.type === "openDirect") {
                        const opened = await openUrlInDefaultBrowser(verifyLink);
                        if (opened) {
                          console.log("\nOpened direct verification link in browser.\n");
                        } else {
                          console.log("\nCould not open browser automatically. Use this verification link:\n");
                          console.log(`${verifyLink}\n`);
                        }
                        continue;
                      }

                      continue;
                    }

                    const detailLines: string[] = [
                      `Status: ${selectedStatus}`,
                    ];
                    if (selected.origin === "quarantined") {
                      detailLines.push("Origin: quarantined (removed from rotation)");
                    }
                    if (selected.message) {
                      detailLines.push(`Message: ${selected.message}`);
                    }

                    const copyText = `${selectedLabel}\n` + detailLines.join("\n");

                    const actionItems: MenuItem<DetailAction>[] = [
                      { label: "Details", value: { type: "back" }, kind: "heading" },
                      ...detailLines.map(
                        (l): MenuItem<DetailAction> => ({ label: l, value: { type: "back" }, kind: "heading" }),
                      ),
                      { label: "", value: { type: "back" }, separator: true },
                      { label: "Copy details", value: { type: "copy" }, color: "cyan" },
                      { label: "Back", value: { type: "back" } },
                    ];

                    const action = await select(actionItems, {
                      message: selectedLabel,
                      subtitle: selectedStatus,
                      help: "Up/Down to select | Enter: confirm | Esc: back",
                      clearScreen: true,
                    });

                    if (!action || action.type === "back") continue;

                    const copied = copyTextToClipboard(copyText);
                    if (copied) {
                      console.log("\nCopied details to clipboard.\n");
                    } else {
                      console.log(`\n${copyText}\n`);
                    }
                  }

                  console.log("");
                  continue;
                }

                if (menuResult.mode === "manage") {
                  if (menuResult.toggleAccountIndex !== undefined) {
                    const acc = existingStorage.accounts[menuResult.toggleAccountIndex];
                    if (acc) {
                      acc.enabled = acc.enabled === false;
                      await saveAccounts(existingStorage, { merge: true, preserveDeletions: true });
                      console.log(`\nAccount ${acc.email || menuResult.toggleAccountIndex + 1} ${acc.enabled ? 'enabled' : 'disabled'}.\n`);
                    }
                  }
                  continue;
                }

                break;
              }
              
              if (menuResult.mode === "cancel") {
                return {
                  url: "",
                  instructions: "Authentication cancelled",
                  method: "auto",
                  callback: async () => ({ type: "failed", error: "Authentication cancelled" }),
                };
              }
              
              if (menuResult.refreshAccountIndex !== undefined) {
                refreshAccountIndex = menuResult.refreshAccountIndex;
                const refreshEmail = existingStorage.accounts[refreshAccountIndex]?.email;
                console.log(`\nRe-authenticating ${refreshEmail || 'account'}...\n`);
                startFresh = false;
              }
              
              if (menuResult.deleteAll) {
                await clearAccounts();
                await clearBlockedAccounts();
                console.log("\nAll accounts deleted.\n");
                startFresh = true;
              } else {
                startFresh = menuResult.mode === "fresh";
              }
              
              if (startFresh && !menuResult.deleteAll) {
                console.log("\nStarting fresh - existing accounts will be replaced.\n");
              } else if (!startFresh) {
                console.log("\nAdding to existing accounts.\n");
              }
            }

            while (accounts.length < MAX_OAUTH_ACCOUNTS) {
              console.log(`\n=== Antigravity OAuth (Account ${accounts.length + 1}) ===`);

              const projectId = await promptProjectId();

              const result = await (async (): Promise<AntigravityTokenExchangeResult> => {
                const authorization = await authorizeAntigravity(projectId);
                const fallbackState = getStateFromAuthorizationUrl(authorization.url);

                console.log("\nOAuth URL:\n" + authorization.url + "\n");

                if (useManualMode) {
                  const browserOpened = await openBrowser(authorization.url);
                  if (!browserOpened) {
                    console.log("Could not open browser automatically.");
                    console.log("Please open the URL above manually in your local browser.\n");
                  }
                  return promptManualOAuthInput(fallbackState);
                }

                let listener: OAuthListener | null = null;
                if (!isHeadless) {
                  try {
                    listener = await startOAuthListener();
                  } catch {
                    listener = null;
                  }
                }

                if (!isHeadless) {
                  await openBrowser(authorization.url);
                }

                if (listener) {
                  try {
                    const SOFT_TIMEOUT_MS = 30000;
                    const callbackPromise = listener.waitForCallback();
                    const timeoutPromise = new Promise<never>((_, reject) =>
                      setTimeout(() => reject(new Error("SOFT_TIMEOUT")), SOFT_TIMEOUT_MS)
                    );

                    let callbackUrl: URL;
                    try {
                      callbackUrl = await Promise.race([callbackPromise, timeoutPromise]);
                    } catch (err) {
                      if (err instanceof Error && err.message === "SOFT_TIMEOUT") {
                        console.log("\n⏳ Automatic callback not received after 30 seconds.");
                        console.log("You can paste the redirect URL manually.\n");
                        console.log("OAuth URL (in case you need it again):");
                        console.log(authorization.url + "\n");
                        
                        try {
                          await listener.close();
                        } catch {}
                        
                        return promptManualOAuthInput(fallbackState);
                      }
                      throw err;
                    }

                    const params = extractOAuthCallbackParams(callbackUrl);
                    if (!params) {
                      return { type: "failed", error: "Missing code or state in callback URL" };
                    }

                    return exchangeAntigravity(params.code, params.state);
                  } catch (error) {
                    if (error instanceof Error && error.message !== "SOFT_TIMEOUT") {
                      return {
                        type: "failed",
                        error: error.message,
                      };
                    }
                    return {
                      type: "failed",
                      error: error instanceof Error ? error.message : "Unknown error",
                    };
                  } finally {
                    try {
                      await listener.close();
                    } catch {}
                  }
                }

                return promptManualOAuthInput(fallbackState);
              })();

              if (result.type === "failed") {
                if (accounts.length === 0) {
                  return {
                    url: "",
                    instructions: `Authentication failed: ${result.error}`,
                    method: "auto",
                    callback: async () => result,
                  };
                }

                console.warn(
                  `[opencode-antigravity-auth] Skipping failed account ${accounts.length + 1}: ${result.error}`,
                );
                break;
              }

              accounts.push(result);

              try {
                await client.tui.showToast({
                  body: {
                    message: `Account ${accounts.length} authenticated${result.email ? ` (${result.email})` : ""}`,
                    variant: "success",
                  },
                });
              } catch {
              }

              try {
                if (refreshAccountIndex !== undefined) {
                  const currentStorage = await loadAccounts();
                  if (currentStorage) {
                    const updatedAccounts = [...currentStorage.accounts];
                    const parts = parseRefreshParts(result.refresh);
                    const previous = updatedAccounts[refreshAccountIndex];
                    const previousRefreshToken =
                      typeof previous?.refreshToken === "string" ? previous.refreshToken : undefined;
                    const nextRefreshToken = parts.refreshToken;

                    if (nextRefreshToken) {
                      updatedAccounts[refreshAccountIndex] = {
                        ...(previous ?? {}),
                        email: result.email ?? previous?.email,
                        refreshToken: nextRefreshToken,
                        projectId: parts.projectId ?? previous?.projectId,
                        managedProjectId: parts.managedProjectId ?? previous?.managedProjectId,
                        addedAt: previous?.addedAt ?? Date.now(),
                        lastUsed: Date.now(),
                      };
                      await saveAccounts(
                        {
                          version: 3,
                          accounts: updatedAccounts,
                          activeIndex: currentStorage.activeIndex,
                          activeIndexByFamily: currentStorage.activeIndexByFamily,
                        },
                        {
                          merge: true,
                          preserveDeletions: true,
                          addedRefreshTokens: [nextRefreshToken],
                          removedRefreshTokens:
                            previousRefreshToken && previousRefreshToken !== nextRefreshToken
                              ? [previousRefreshToken]
                              : undefined,
                        },
                      );
                    }
                  }
                } else {
                  const isFirstAccount = accounts.length === 1;
                  await persistAccountPool([result], isFirstAccount && startFresh);
                }
              } catch {
              }

              if (refreshAccountIndex !== undefined) {
                break;
              }

              if (accounts.length >= MAX_OAUTH_ACCOUNTS) {
                break;
              }

              // Get the actual deduplicated account count from storage for the prompt
              let currentAccountCount = accounts.length;
              try {
                const currentStorage = await loadAccounts();
                if (currentStorage) {
                  currentAccountCount = currentStorage.accounts.length;
                }
              } catch {
                // Fall back to accounts.length if we can't read storage
              }

              const addAnother = await promptAddAnotherAccount(currentAccountCount);
              if (!addAnother) {
                break;
              }
            }

            const primary = accounts[0];
            if (!primary) {
              return {
                url: "",
                instructions: "Authentication cancelled",
                method: "auto",
                callback: async () => ({ type: "failed", error: "Authentication cancelled" }),
              };
            }

            let actualAccountCount = accounts.length;
            try {
              const finalStorage = await loadAccounts();
              if (finalStorage) {
                actualAccountCount = finalStorage.accounts.length;
              }
            } catch {
            }

            const successMessage = refreshAccountIndex !== undefined
              ? `Token refreshed successfully.`
              : `Multi-account setup complete (${actualAccountCount} account(s)).`;

            return {
              url: "",
              instructions: successMessage,
              method: "auto",
              callback: async (): Promise<AntigravityTokenExchangeResult> => primary,
            };
          }

          // TUI flow (`/connect`) does not support per-account prompts.
          // Default to adding new accounts (non-destructive).
          // Users can run `opencode auth logout` first if they want a fresh start.
          const projectId = "";

          // Check existing accounts count for toast message
          const existingStorage = await loadAccounts();
          const existingCount = existingStorage?.accounts.length ?? 0;

          const useManualFlow = isHeadless || shouldSkipLocalServer();

          let listener: OAuthListener | null = null;
          if (!useManualFlow) {
            try {
              listener = await startOAuthListener();
            } catch {
              listener = null;
            }
          }

          const authorization = await authorizeAntigravity(projectId);
          const fallbackState = getStateFromAuthorizationUrl(authorization.url);

          if (!useManualFlow) {
            const browserOpened = await openBrowser(authorization.url);
            if (!browserOpened) {
              listener?.close().catch(() => {});
              listener = null;
            }
          }

          if (listener) {
            return {
              url: authorization.url,
              instructions:
                "Complete sign-in in your browser. We'll automatically detect the redirect back to localhost.",
              method: "auto",
              callback: async (): Promise<AntigravityTokenExchangeResult> => {
                const CALLBACK_TIMEOUT_MS = 30000;
                try {
                  const callbackPromise = listener.waitForCallback();
                  const timeoutPromise = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("CALLBACK_TIMEOUT")), CALLBACK_TIMEOUT_MS),
                  );

                  let callbackUrl: URL;
                  try {
                    callbackUrl = await Promise.race([callbackPromise, timeoutPromise]);
                  } catch (err) {
                    if (err instanceof Error && err.message === "CALLBACK_TIMEOUT") {
                      return {
                        type: "failed",
                        error: "Callback timeout - please use CLI with --no-browser flag for manual input",
                      };
                    }
                    throw err;
                  }

                  const params = extractOAuthCallbackParams(callbackUrl);
                  if (!params) {
                    return { type: "failed", error: "Missing code or state in callback URL" };
                  }

                  const result = await exchangeAntigravity(params.code, params.state);
                  if (result.type === "success") {
                    try {
                      await persistAccountPool([result], false);
                    } catch {
                    }

                    const newTotal = existingCount + 1;
                    const toastMessage = existingCount > 0
                      ? `Added account${result.email ? ` (${result.email})` : ""} - ${newTotal} total`
                      : `Authenticated${result.email ? ` (${result.email})` : ""}`;

                    try {
                      await client.tui.showToast({
                        body: {
                          message: toastMessage,
                          variant: "success",
                        },
                      });
                    } catch {
                    }
                  }

                  return result;
                } catch (error) {
                  return {
                    type: "failed",
                    error: error instanceof Error ? error.message : "Unknown error",
                  };
                } finally {
                  try {
                    await listener.close();
                  } catch {
                  }
                }
              },
            };
          }

          return {
            url: authorization.url,
            instructions:
              "Visit the URL above, complete OAuth, then paste either the full redirect URL or the authorization code.",
            method: "code",
            callback: async (codeInput: string): Promise<AntigravityTokenExchangeResult> => {
              const params = parseOAuthCallbackInput(codeInput, fallbackState);
              if ("error" in params) {
                return { type: "failed", error: params.error };
              }

              const result = await exchangeAntigravity(params.code, params.state);
              if (result.type === "success") {
                try {
                  // TUI flow adds to existing accounts (non-destructive)
                  await persistAccountPool([result], false);
                } catch {
                  // ignore
                }

                // Show appropriate toast message
                const newTotal = existingCount + 1;
                const toastMessage = existingCount > 0
                  ? `Added account${result.email ? ` (${result.email})` : ""} - ${newTotal} total`
                  : `Authenticated${result.email ? ` (${result.email})` : ""}`;

                try {
                  await client.tui.showToast({
                    body: {
                      message: toastMessage,
                      variant: "success",
                    },
                  });
                } catch {
                  // TUI may not be available
                }
              }

              return result;
            },
          };
        },
      },
      {
        label: "Manually enter API Key",
        type: "api",
      },
    ],
  },
  };
};

export const AntigravityCLIOAuthPlugin = createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID);
export const GoogleOAuthPlugin = AntigravityCLIOAuthPlugin;

function toUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value;
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

function toWarmupStreamUrl(value: RequestInfo): string {
  const urlString = toUrlString(value);
  try {
    const url = new URL(urlString);
    if (!url.pathname.includes(":streamGenerateContent")) {
      url.pathname = url.pathname.replace(":generateContent", ":streamGenerateContent");
    }
    url.searchParams.set("alt", "sse");
    return url.toString();
  } catch {
    return urlString;
  }
}

function extractModelFromUrl(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:\/?]+)(?::\w+)?/);
  return match?.[1] ?? null;
}

function extractModelFromUrlWithSuffix(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:\/\?]+)/);
  return match?.[1] ?? null;
}

function getModelFamilyFromUrl(urlString: string): ModelFamily {
  const model = extractModelFromUrl(urlString);
  let family: ModelFamily = "gemini";
  if (model && model.includes("claude")) {
    family = "claude";
  }
  if (isDebugEnabled()) {
    logModelFamily(urlString, model, family);
  }
  return family;
}

function getHeaderStyleFromUrl(
  urlString: string,
  family: ModelFamily,
  cliFirst: boolean,
): HeaderStyle {
  if (family === "claude") {
    return "antigravity";
  }
  const modelWithSuffix = extractModelFromUrlWithSuffix(urlString);
  if (!modelWithSuffix) {
    return "gemini-cli";
  }
  const { quotaPreference } = resolveModelWithTier(modelWithSuffix, {
    cli_first: cliFirst,
  });
  return quotaPreference ?? "gemini-cli";
}

function isExplicitQuotaFromUrl(urlString: string): boolean {
  const modelWithSuffix = extractModelFromUrlWithSuffix(urlString);
  if (!modelWithSuffix) {
    return false;
  }
  const { explicitQuota } = resolveModelWithTier(modelWithSuffix);
  return explicitQuota ?? false;
}

function resolveQuotaFallbackHeaderStyle(input: {
  quotaFallback: boolean;
  cliFirst: boolean;
  explicitQuota: boolean;
  family: ModelFamily;
  headerStyle: HeaderStyle;
  alternateStyle: HeaderStyle | null;
}): HeaderStyle | null {
  const {
    quotaFallback,
    cliFirst,
    explicitQuota,
    family,
    headerStyle,
    alternateStyle,
  } = input;

  if (!quotaFallback) return null;
  if (explicitQuota) return null;
  if (family !== "gemini") return null;
  if (!alternateStyle) return null;
  if (alternateStyle === headerStyle) return null;

  // Direction matters:
  // - cli_first=true: start on gemini-cli, allow fallback to antigravity only
  // - cli_first=false: start on antigravity, allow fallback to gemini-cli only
  if (cliFirst) {
    return headerStyle === "gemini-cli" && alternateStyle === "antigravity" ? alternateStyle : null;
  }
  return headerStyle === "antigravity" && alternateStyle === "gemini-cli" ? alternateStyle : null;
}

// Exported only for unit tests.
export const __testExports = {
  resolveQuotaFallbackHeaderStyle,
};
