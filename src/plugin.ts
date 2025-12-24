import { exec } from "node:child_process";
import { ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_PROVIDER_ID, type HeaderStyle } from "./constants";
import { authorizeAntigravity, exchangeAntigravity } from "./antigravity/oauth";
import type { AntigravityTokenExchangeResult } from "./antigravity/oauth";
import { accessTokenExpired, isOAuthAuth, parseRefreshParts } from "./plugin/auth";
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
} from "./plugin/debug";
import {
  buildThinkingWarmupBody,
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from "./plugin/request";
import { AntigravityTokenRefreshError, refreshAccessToken } from "./plugin/token";
import { startOAuthListener, type OAuthListener } from "./plugin/server";
import { clearAccounts, loadAccounts, saveAccounts } from "./plugin/storage";
import { AccountManager, type ModelFamily } from "./plugin/accounts";
import { releaseAllReservations, releaseAllReservationsSync, applyStartupJitter } from "./plugin/reservation";
import { createAutoUpdateCheckerHook } from "./hooks/auto-update-checker";
import type {
  GetAuth,
  LoaderResult,
  PluginContext,
  PluginResult,
  ProjectContextResult,
  Provider,
} from "./plugin/types";

const MAX_OAUTH_ACCOUNTS = 10;
const MAX_WARMUP_SESSIONS = 1000;
const MAX_WARMUP_RETRIES = 2;
const warmupAttemptedSessionIds = new Set<string>();
const warmupSucceededSessionIds = new Set<string>();

let jitterApplied = false;
let cleanupRegistered = false;

function registerProcessCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  process.on("exit", () => {
    releaseAllReservationsSync();
  });

  process.on("SIGINT", async () => {
    await releaseAllReservations();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await releaseAllReservations();
    process.exit(0);
  });
}

async function ensureJitterApplied(): Promise<void> {
  if (jitterApplied) return;
  jitterApplied = true;
  await applyStartupJitter();
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

async function openBrowser(url: string): Promise<void> {
  try {
    if (process.platform === "darwin") {
      exec(`open "${url}"`);
      return;
    }
    if (process.platform === "win32") {
      exec(`start "${url}"`);
      return;
    }
    exec(`xdg-open "${url}"`);
  } catch {
    // ignore
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

  const indexByRefreshToken = new Map<string, number>();
  for (let i = 0; i < accounts.length; i++) {
    const token = accounts[i]?.refreshToken;
    if (token) {
      indexByRefreshToken.set(token, i);
    }
  }

  for (const result of results) {
    const parts = parseRefreshParts(result.refresh);
    if (!parts.refreshToken) {
      continue;
    }

    const existingIndex = indexByRefreshToken.get(parts.refreshToken);
    if (existingIndex === undefined) {
      indexByRefreshToken.set(parts.refreshToken, accounts.length);
      accounts.push({
        email: result.email,
        refreshToken: parts.refreshToken,
        projectId: parts.projectId,
        managedProjectId: parts.managedProjectId,
        addedAt: now,
        lastUsed: now,
      });
      continue;
    }

    const existing = accounts[existingIndex];
    if (!existing) {
      continue;
    }

    accounts[existingIndex] = {
      ...existing,
      email: result.email ?? existing.email,
      projectId: parts.projectId ?? existing.projectId,
      managedProjectId: parts.managedProjectId ?? existing.managedProjectId,
      lastUsed: now,
    };
  }

  if (accounts.length === 0) {
    return;
  }

  // For fresh logins, always start at index 0
  const activeIndex = replaceAll 
    ? 0 
    : (typeof stored?.activeIndex === "number" && Number.isFinite(stored.activeIndex) ? stored.activeIndex : 0);

  await saveAccounts({
    version: 3,
    accounts,
    activeIndex: clampInt(activeIndex, 0, accounts.length - 1),
    activeIndexByFamily: {
      claude: clampInt(activeIndex, 0, accounts.length - 1),
      gemini: clampInt(activeIndex, 0, accounts.length - 1),
    },
  });
}

function retryAfterMsFromResponse(response: Response): number {
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

  return 60_000;
}

function parseDurationToMs(duration: string): number | null {
  const match = duration.match(/^(\d+(?:\.\d+)?)(s|m|h)?$/i);
  if (!match) return null;
  const value = parseFloat(match[1]!);
  const unit = (match[2] || "s").toLowerCase();
  switch (unit) {
    case "h": return value * 3600 * 1000;
    case "m": return value * 60 * 1000;
    case "s": return value * 1000;
    default: return value * 1000;
  }
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

const SHORT_RETRY_THRESHOLD_MS = 5000;

const rateLimitStateByAccount = new Map<number, { consecutive429: number; lastAt: number }>();

function getRateLimitBackoff(accountIndex: number, serverRetryAfterMs: number | null): { attempt: number; delayMs: number } {
  const now = Date.now();
  const previous = rateLimitStateByAccount.get(accountIndex);
  const attempt = previous && (now - previous.lastAt < 120_000) ? previous.consecutive429 + 1 : 1;
  rateLimitStateByAccount.set(accountIndex, { consecutive429: attempt, lastAt: now });
  
  const baseDelay = serverRetryAfterMs ?? 1000;
  const backoffDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), 60_000);
  return { attempt, delayMs: Math.max(baseDelay, backoffDelay) };
}

function resetRateLimitState(accountIndex: number): void {
  rateLimitStateByAccount.delete(accountIndex);
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
  const updateChecker = createAutoUpdateCheckerHook(client, directory, {
    showStartupToast: true,
    autoUpdate: true,
  });

  return {
    event: updateChecker.event,
    auth: {
    provider: providerId,
    loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | Record<string, unknown>> => {
      const auth = await getAuth();
      
      // If OpenCode has no valid OAuth auth, clear any stale account storage
      if (!isOAuthAuth(auth)) {
        try {
          await clearAccounts();
        } catch {
          // ignore
        }
        return {};
      }

      // Validate that stored accounts are in sync with OpenCode's auth
      // If OpenCode's refresh token doesn't match any stored account, clear stale storage
      const authParts = parseRefreshParts(auth.refresh);
      const storedAccounts = await loadAccounts();
      
      if (storedAccounts && storedAccounts.accounts.length > 0 && authParts.refreshToken) {
        const hasMatchingAccount = storedAccounts.accounts.some(
          (acc) => acc.refreshToken === authParts.refreshToken
        );
        
        if (!hasMatchingAccount) {
          // OpenCode's auth doesn't match any stored account - storage is stale
          // Clear it and let the user re-authenticate
          console.warn(
            "[opencode-antigravity-auth] Stored accounts don't match OpenCode's auth. Clearing stale storage."
          );
          try {
            await clearAccounts();
          } catch {
            // ignore
          }
        }
      }

      const accountManager = await AccountManager.loadFromDisk(auth);
      if (accountManager.getAccountCount() > 0) {
        try {
          await accountManager.saveToDisk();
        } catch (error) {
          console.error("[opencode-antigravity-auth] Failed to persist initial account pool:", error);
        }
      }

      registerProcessCleanup();

      if (isDebugEnabled()) {
        const logPath = getLogFilePath();
        if (logPath) {
          try {
            await client.tui.showToast({
              body: { message: `Debug log: ${logPath}`, variant: "info" },
            });
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
          // If the request is for the *other* provider, we might still want to intercept if URL matches
          // But strict compliance means we only handle requests if the auth provider matches.
          // Since loader is instantiated per provider, we are good.

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

          // Helper to show toast without blocking on abort
          const showToast = async (message: string, variant: "info" | "warning" | "success" | "error") => {
            if (abortSignal?.aborted) return;
            try {
              await client.tui.showToast({
                body: { message, variant },
              });
            } catch {
              // TUI may not be available
            }
          };

          // Use while(true) loop to handle rate limits with backoff
          // This ensures we wait and retry when all accounts are rate-limited
          const quietMode = process.env.OPENCODE_ANTIGRAVITY_QUIET === "1";
          
          while (true) {
            // Check for abort at the start of each iteration
            checkAborted();
            
            const accountCount = accountManager.getAccountCount();
            
            if (accountCount === 0) {
              throw new Error("No Antigravity accounts available. Run `opencode auth login`.");
            }

            await ensureJitterApplied();
            const account = await accountManager.getCurrentOrNextForFamilyWithReservation(family);
            
            if (!account) {
              // All accounts are rate-limited - wait and retry
              const waitMs = accountManager.getMinWaitTimeForFamily(family) || 60_000;
              const waitSec = Math.max(1, Math.ceil(waitMs / 1000));

              pushDebug(`all-rate-limited family=${family} accounts=${accountCount}`);
              if (isDebugEnabled()) {
                logAccountContext("All accounts rate-limited", {
                  index: -1,
                  family,
                  totalAccounts: accountCount,
                });
                logRateLimitSnapshot(family, accountManager.getAccountsSnapshot());
              }

              await showToast(`All ${accountCount} account(s) rate-limited for ${family}. Waiting ${waitSec}s...`, "warning");

              // Wait for the cooldown to expire
              await sleep(waitMs, abortSignal);
              continue;
            }

            pushDebug(
              `selected idx=${account.index} email=${account.email ?? ""} family=${family} accounts=${accountCount}`,
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

            // Show toast when switching to a different account (debounced, respects quiet mode)
            if (!quietMode && accountCount > 1 && accountManager.shouldShowAccountToast(account.index)) {
              const accountLabel = account.email || `Account ${account.index + 1}`;
              await showToast(
                `Using ${accountLabel} (${account.index + 1}/${accountCount})`,
                "info"
              );
              accountManager.markToastShown(account.index);
            }

            try {
              await accountManager.saveToDisk();
            } catch (error) {
              console.error("[opencode-antigravity-auth] Failed to persist rotation state:", error);
            }

            let authRecord = accountManager.toAuthDetails(account);

            if (accessTokenExpired(authRecord)) {
              try {
                const refreshed = await refreshAccessToken(authRecord, client, providerId);
                if (!refreshed) {
                  const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
                  lastError = new Error("Antigravity token refresh failed");
                  if (shouldCooldown) {
                    accountManager.markRateLimited(account, cooldownMs, family, "antigravity");
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
                  console.error("[opencode-antigravity-auth] Failed to persist refreshed auth:", error);
                }
              } catch (error) {
                if (error instanceof AntigravityTokenRefreshError && error.code === "invalid_grant") {
                  const removed = accountManager.removeAccount(account);
                  if (removed) {
                    console.warn(
                      "[opencode-antigravity-auth] Removed revoked account from pool. Reauthenticate it via `opencode auth login` to add it back.",
                    );
                    try {
                      await accountManager.saveToDisk();
                    } catch (persistError) {
                      console.error(
                        "[opencode-antigravity-auth] Failed to persist revoked account removal:",
                        persistError,
                      );
                    }
                  }

                  if (accountManager.getAccountCount() === 0) {
                    try {
                      await client.auth.set({
                        path: { id: providerId },
                        body: { type: "oauth", refresh: "", access: "", expires: 0 },
                      });
                    } catch (storeError) {
                      console.error("Failed to clear stored Antigravity OAuth credentials:", storeError);
                    }

                    throw new Error(
                      "All Antigravity accounts have invalid refresh tokens. Run `opencode auth login` and reauthenticate.",
                    );
                  }

                  lastError = error;
                  continue;
                }

                const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
                lastError = error instanceof Error ? error : new Error(String(error));
                if (shouldCooldown) {
                  accountManager.markRateLimited(account, cooldownMs, family, "antigravity");
                  pushDebug(`token-refresh-error: cooldown ${cooldownMs}ms after ${failures} failures`);
                }
                continue;
              }
            }

            const accessToken = authRecord.access;
            if (!accessToken) {
              lastError = new Error("Missing access token");
              continue;
            }

            let projectContext: ProjectContextResult;
            try {
              projectContext = await ensureProjectContext(authRecord);
              resetAccountFailureState(account.index);
            } catch (error) {
              const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
              lastError = error instanceof Error ? error : new Error(String(error));
              if (shouldCooldown) {
                accountManager.markRateLimited(account, cooldownMs, family, "antigravity");
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
                console.error("[opencode-antigravity-auth] Failed to persist project context:", error);
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

            // Try endpoint fallbacks with header style fallback for Gemini
            let shouldSwitchAccount = false;
            
            // For Gemini models, we can try both header styles (antigravity first, then gemini-cli)
            // For Claude models, only antigravity headers work
            const headerStyles: HeaderStyle[] = family === "gemini" 
              ? ["antigravity", "gemini-cli"] 
              : ["antigravity"];
            
            let currentHeaderStyleIndex = 0;
            
            // Find first non-rate-limited header style for this account
            while (currentHeaderStyleIndex < headerStyles.length) {
              const hs = headerStyles[currentHeaderStyleIndex];
              if (hs && !accountManager.isRateLimitedForHeaderStyle(account, family, hs)) {
                break;
              }
              currentHeaderStyleIndex++;
            }
            
            // If all header styles are rate-limited for this account, switch account
            if (currentHeaderStyleIndex >= headerStyles.length) {
              shouldSwitchAccount = true;
            }
            
            headerStyleLoop:
            while (!shouldSwitchAccount && currentHeaderStyleIndex < headerStyles.length) {
              const currentHeaderStyle = headerStyles[currentHeaderStyleIndex]!;
              pushDebug(`headerStyle=${currentHeaderStyle}`);
            
            for (let i = 0; i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length; i++) {
              const currentEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[i];

              try {
                const prepared = prepareAntigravityRequest(
                  input,
                  init,
                  accessToken,
                  projectContext.effectiveProjectId,
                  currentEndpoint,
                  currentHeaderStyle,
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

                const response = await fetch(prepared.request, prepared.init);
                pushDebug(`status=${response.status} ${response.statusText}`);




                // Handle 429 rate limit with improved logic
                if (response.status === 429) {
                  const headerRetryMs = retryAfterMsFromResponse(response);
                  const bodyInfo = await extractRetryInfoFromBody(response);
                  const serverRetryMs = bodyInfo.retryDelayMs ?? headerRetryMs;
                  const { attempt, delayMs } = getRateLimitBackoff(account.index, serverRetryMs);

                  const waitTimeFormatted = formatWaitTime(delayMs);
                  const isCapacityExhausted =
                    bodyInfo.reason === "MODEL_CAPACITY_EXHAUSTED" ||
                    (typeof bodyInfo.message === "string" && bodyInfo.message.toLowerCase().includes("no capacity"));

                  pushDebug(
                    `429 idx=${account.index} email=${account.email ?? ""} family=${family} delayMs=${delayMs} attempt=${attempt}`,
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
                    delayMs,
                    bodyInfo,
                  );

                  await logResponseBody(debugContext, response, 429);

                  if (isCapacityExhausted) {
                    accountManager.markRateLimited(account, delayMs, family, currentHeaderStyle);
                    await showToast(
                      `Model capacity exhausted for ${family}. Retrying in ${waitTimeFormatted} (attempt ${attempt})...`,
                      "warning",
                    );
                    await sleep(delayMs, abortSignal);
                    continue;
                  }
                  
                  const accountLabel = account.email || `Account ${account.index + 1}`;

                  // Short retry: if delay is small, just wait and retry same account
                  if (delayMs <= SHORT_RETRY_THRESHOLD_MS) {
                    await showToast(`Rate limited. Retrying in ${waitTimeFormatted} (attempt ${attempt})...`, "warning");
                    await sleep(delayMs, abortSignal);
                    continue;
                  }


                  // Mark this header style as rate-limited for this account
                  accountManager.markRateLimited(account, delayMs, family, currentHeaderStyle);

                  try {
                    await accountManager.saveToDisk();
                  } catch (error) {
                    console.error("[opencode-antigravity-auth] Failed to persist rate-limit state:", error);
                  }

                  // For Gemini, try next header style before switching accounts
                  if (family === "gemini" && currentHeaderStyleIndex < headerStyles.length - 1) {
                    const nextHeaderStyle = headerStyles[currentHeaderStyleIndex + 1];
                    await showToast(
                      `Rate limited on ${currentHeaderStyle} quota. Trying ${nextHeaderStyle} quota...`,
                      "warning",
                    );
                    currentHeaderStyleIndex++;
                    continue headerStyleLoop;
                  }

                  if (accountCount > 1) {
                    const quotaMsg = bodyInfo.quotaResetTime 
                      ? ` (quota resets ${bodyInfo.quotaResetTime})`
                      : ` (retry in ${waitTimeFormatted})`;
                    await showToast(`Rate limited on ${accountLabel}${quotaMsg}. Switching...`, "warning");
                    
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
                    const quotaMsg = bodyInfo.quotaResetTime 
                      ? `Quota resets ${bodyInfo.quotaResetTime}`
                      : `Waiting ${waitTimeFormatted}`;
                    await showToast(`Rate limited. ${quotaMsg} (attempt ${attempt})...`, "warning");
                    
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
                    
                    await sleep(delayMs, abortSignal);
                    shouldSwitchAccount = true;
                    break;
                  }
                }

                // Success - reset rate limit backoff state
                resetRateLimitState(account.index);
                resetAccountFailureState(account.index);

                const shouldRetryEndpoint = (
                  response.status === 403 ||
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
                logAntigravityDebugResponse(debugContext, response, {
                  note: response.ok ? "Success" : `Error ${response.status}`,
                });
                if (!response.ok) {
                  await logResponseBody(debugContext, response, response.status);
                }
                return transformAntigravityResponse(
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
              } catch (error) {
                if (i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
                  lastError = error instanceof Error ? error : new Error(String(error));
                  continue;
                }

                // All endpoints failed for this account - track failure and try next account
                const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
                lastError = error instanceof Error ? error : new Error(String(error));
                if (shouldCooldown) {
                  accountManager.markRateLimited(account, cooldownMs, family, currentHeaderStyle);
                  pushDebug(`endpoint-error: cooldown ${cooldownMs}ms after ${failures} failures`);
                }
                shouldSwitchAccount = true;
                break;
              }
            }
            } // end headerStyleLoop
            
            if (shouldSwitchAccount) {
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

            // Check for existing accounts and prompt user for login mode
            let startFresh = true;
            const existingStorage = await loadAccounts();
            if (existingStorage && existingStorage.accounts.length > 0) {
              const existingAccounts = existingStorage.accounts.map((acc, idx) => ({
                email: acc.email,
                index: idx,
              }));
              
              const loginMode = await promptLoginMode(existingAccounts);
              startFresh = loginMode === "fresh";
              
              if (startFresh) {
                console.log("\nStarting fresh - existing accounts will be replaced.\n");
              } else {
                console.log("\nAdding to existing accounts.\n");
              }
            }

            while (accounts.length < MAX_OAUTH_ACCOUNTS) {
              console.log(`\n=== Antigravity OAuth (Account ${accounts.length + 1}) ===`);

              const projectId = await promptProjectId();

              const result = await (async (): Promise<AntigravityTokenExchangeResult> => {
                let listener: OAuthListener | null = null;
                if (!isHeadless) {
                  try {
                    listener = await startOAuthListener();
                  } catch {
                    listener = null;
                  }
                }

                const authorization = await authorizeAntigravity(projectId);
                const fallbackState = getStateFromAuthorizationUrl(authorization.url);

                console.log("\nOAuth URL:\n" + authorization.url + "\n");

                if (!isHeadless) {
                  await openBrowser(authorization.url);
                }

                if (listener) {
                  try {
                    const callbackUrl = await listener.waitForCallback();
                    const params = extractOAuthCallbackParams(callbackUrl);
                    if (!params) {
                      return { type: "failed", error: "Missing code or state in callback URL" };
                    }

                    return exchangeAntigravity(params.code, params.state);
                  } catch (error) {
                    return {
                      type: "failed",
                      error: error instanceof Error ? error.message : "Unknown error",
                    };
                  } finally {
                    try {
                      await listener.close();
                    } catch {
                      // ignore
                    }
                  }
                }

                console.log("1. Open the URL below in your browser and complete Google sign-in.");
                console.log(
                  "2. After approving, copy the full redirected localhost URL from the address bar.",
                );
                console.log("3. Paste it back here.");

                const callbackInput = await promptOAuthCallbackValue(
                  "Paste the redirect URL (or just the code) here: ",
                );
                const params = parseOAuthCallbackInput(callbackInput, fallbackState);
                if ("error" in params) {
                  return { type: "failed", error: params.error };
                }

                return exchangeAntigravity(params.code, params.state);
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

              // Show toast for successful account authentication
              try {
                await client.tui.showToast({
                  body: {
                    message: `Account ${accounts.length} authenticated${result.email ? ` (${result.email})` : ""}`,
                    variant: "success",
                  },
                });
              } catch {
                // TUI may not be available in CLI mode
              }

              try {
                // Use startFresh only on first account, subsequent accounts always append
                const isFirstAccount = accounts.length === 1;
                await persistAccountPool([result], isFirstAccount && startFresh);
              } catch {
                // ignore
              }

              if (accounts.length >= MAX_OAUTH_ACCOUNTS) {
                break;
              }

              const addAnother = await promptAddAnotherAccount(accounts.length);
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

            return {
              url: "",
              instructions: `Multi-account setup complete (${accounts.length} account(s)).`,
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

          let listener: OAuthListener | null = null;
          if (!isHeadless) {
            try {
              listener = await startOAuthListener();
            } catch {
              listener = null;
            }
          }

          const authorization = await authorizeAntigravity(projectId);
          const fallbackState = getStateFromAuthorizationUrl(authorization.url);

          if (!isHeadless) {
            await openBrowser(authorization.url);
          }

          if (listener) {
            return {
              url: authorization.url,
              instructions:
                "Complete sign-in in your browser. We'll automatically detect the redirect back to localhost.",
              method: "auto",
              callback: async (): Promise<AntigravityTokenExchangeResult> => {
                try {
                  const callbackUrl = await listener.waitForCallback();
                  const params = extractOAuthCallbackParams(callbackUrl);
                  if (!params) {
                    return { type: "failed", error: "Missing code or state in callback URL" };
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
                } catch (error) {
                  return {
                    type: "failed",
                    error: error instanceof Error ? error.message : "Unknown error",
                  };
                } finally {
                  try {
                    await listener.close();
                  } catch {
                    // ignore
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
