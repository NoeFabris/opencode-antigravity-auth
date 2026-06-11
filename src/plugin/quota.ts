import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_LOAD_ENDPOINTS,
  ANTIGRAVITY_ENDPOINT_PROD,
  getAntigravityHeaders,
  ANTIGRAVITY_PROVIDER_ID,
} from "../constants";
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./auth";
import { logQuotaFetch, logQuotaStatus, logSubscriptionTier } from "./debug";
import { ensureProjectContext } from "./project";
import { refreshAccessToken } from "./token";
import { getModelFamily } from "./transform/model-resolver";
import type { PluginClient, OAuthAuthDetails } from "./types";
import type { AccountMetadataV3 } from "./storage";
import { createLogger } from "./logger";

const log = createLogger("quota");

const FETCH_TIMEOUT_MS = 10000;

/**
 * Per-account wall-clock budget for the full quota check cycle:
 * token refresh + project context + two API calls.
 * Sized for slow networks with two sequential network roundtrips before the
 * parallel fetch pair, plus FETCH_TIMEOUT_MS for each of the two parallel calls.
 */
const ACCOUNT_QUOTA_TIMEOUT_MS = 45_000;

/** Hard cap on concurrent quota checks. Matches MAX_OAUTH_ACCOUNTS in plugin.ts. */
const MAX_QUOTA_ACCOUNTS = 10;

export type QuotaGroup = "claude" | "gemini-pro" | "gemini-flash";

export interface QuotaModelSummary {
  modelId: string;
  displayName?: string;
  group: QuotaGroup;
  remainingFraction?: number;
  resetTime?: string;
}

export interface QuotaGroupSummary {
  remainingFraction?: number;
  resetTime?: string;
  modelCount: number;
}

export interface QuotaSummary {
  groups: Partial<Record<QuotaGroup, QuotaGroupSummary>>;
  models: QuotaModelSummary[];
  modelCount: number;
  error?: string;
}

// Gemini CLI quota types
export interface GeminiCliQuotaModel {
  modelId: string;
  remainingFraction: number;
  resetTime?: string;
}

export interface GeminiCliQuotaSummary {
  models: GeminiCliQuotaModel[];
  error?: string;
}

interface RetrieveUserQuotaResponse {
  buckets?: {
    remainingAmount?: string;
    remainingFraction?: number;
    resetTime?: string;
    tokenType?: string;
    modelId?: string;
  }[];
}

export type AccountQuotaStatus = "ok" | "disabled" | "error";

export interface AccountQuotaResult {
  index: number;
  email?: string;
  status: AccountQuotaStatus;
  error?: string;
  disabled?: boolean;
  quota?: QuotaSummary;
  geminiCliQuota?: GeminiCliQuotaSummary;
  subscriptionTier?: SubscriptionTier;
  updatedAccount?: AccountMetadataV3;
}

interface FetchAvailableModelsResponse {
  models?: Record<string, FetchAvailableModelEntry>;
}

interface FetchAvailableModelEntry {
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
  };
  displayName?: string;
  modelName?: string;
}

function buildAuthFromAccount(account: AccountMetadataV3): OAuthAuthDetails {
  return {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
    access: undefined,
    expires: undefined,
  };
}

function normalizeRemainingFraction(value: unknown): number {
  // If value is missing or invalid, treat as exhausted (0%)
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function parseResetTime(resetTime?: string): number | null {
  if (!resetTime) return null;
  const timestamp = Date.parse(resetTime);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return timestamp;
}

function classifyQuotaGroup(modelName: string, displayName?: string): QuotaGroup | null {
  const combined = `${modelName} ${displayName ?? ""}`.toLowerCase();
  if (combined.includes("claude")) {
    return "claude";
  }
  // Gemini 3.x (but NOT 3.5 — 3.5 has separate logic below)
  const isGemini3Not35 = /gemini-3(?!\.5)/i.test(combined);
  const isGemini35 = /gemini-3\.5/i.test(combined);
  if (!isGemini3Not35 && !isGemini35) {
    return null;
  }
  const family = getModelFamily(modelName);
  return family === "gemini-flash" ? "gemini-flash" : "gemini-pro";
}

function aggregateQuota(models?: Record<string, FetchAvailableModelEntry>): QuotaSummary {
  const groups: Partial<Record<QuotaGroup, QuotaGroupSummary>> = {};
  if (!models) {
    return { groups, models: [], modelCount: 0 };
  }

  const modelSummaries: QuotaModelSummary[] = [];
  let totalCount = 0;
  for (const [modelName, entry] of Object.entries(models)) {
    const group = classifyQuotaGroup(modelName, entry.displayName ?? entry.modelName);
    if (!group) {
      continue;
    }
    const quotaInfo = entry.quotaInfo;
    const remainingFraction = quotaInfo
      ? normalizeRemainingFraction(quotaInfo.remainingFraction)
      : undefined;
    const resetTime = quotaInfo?.resetTime;
    const resetTimestamp = parseResetTime(resetTime);

    totalCount += 1;
    modelSummaries.push({
      modelId: modelName,
      displayName: entry.displayName ?? entry.modelName,
      group,
      remainingFraction,
      resetTime,
    });

    const existing = groups[group];
    const nextCount = (existing?.modelCount ?? 0) + 1;
    const nextRemaining =
      remainingFraction === undefined
        ? existing?.remainingFraction
        : existing?.remainingFraction === undefined
          ? remainingFraction
          : Math.min(existing.remainingFraction, remainingFraction);

    let nextResetTime = existing?.resetTime;
    if (resetTimestamp !== null) {
      if (!existing?.resetTime) {
        nextResetTime = resetTime;
      } else {
        const existingTimestamp = parseResetTime(existing.resetTime);
        if (existingTimestamp === null || resetTimestamp < existingTimestamp) {
          nextResetTime = resetTime;
        }
      }
    }

    groups[group] = {
      remainingFraction: nextRemaining,
      resetTime: nextResetTime,
      modelCount: nextCount,
    };
  }

  modelSummaries.sort((a, b) => (a.displayName ?? a.modelId).localeCompare(b.displayName ?? b.modelId));

  return { groups, models: modelSummaries, modelCount: totalCount };
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
): Promise<FetchAvailableModelsResponse> {
  const quotaUserAgent = getAntigravityHeaders()["User-Agent"] || "antigravity/windows/amd64"
  const errors: string[] = []

  const body = projectId ? { project: projectId } : {}

  for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
    try {
      const response = await fetchWithTimeout(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": quotaUserAgent,
        },
        body: JSON.stringify(body),
      })

      if (response.ok) {
        return (await response.json()) as FetchAvailableModelsResponse
      }

      const message = await response.text().catch(() => "")
      const snippet = message.trim().slice(0, 200)
      errors.push(
        `fetchAvailableModels ${response.status} at ${endpoint}${snippet ? `: ${snippet}` : ""}`,
      )
    } catch (error) {
      errors.push(`fetchAvailableModels error at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new Error(errors.join("; ") || "fetchAvailableModels failed on all endpoints")
}

async function fetchGeminiCliQuota(
  accessToken: string,
  projectId: string,
): Promise<RetrieveUserQuotaResponse> {
  const platform = process.platform || "darwin"
  const arch = process.arch || "arm64"
  const geminiCliUserAgent = `GeminiCLI/1.0.0/gemini-2.5-pro (${platform}; ${arch})`

  const body = projectId ? { project: projectId } : {}
  
  for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
    try {
      const response = await fetchWithTimeout(`${endpoint}/v1internal:retrieveUserQuota`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": geminiCliUserAgent,
        },
        body: JSON.stringify(body),
      })

      if (response.ok) {
        const data = (await response.json()) as RetrieveUserQuotaResponse
        return data
      }

      logQuotaFetch("error", undefined, `geminiCliQuota non-OK: ${endpoint} status=${response.status}`)
    } catch (error) {
      logQuotaFetch("error", undefined, `geminiCliQuota error at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { buckets: [] }
}

function aggregateGeminiCliQuota(response: RetrieveUserQuotaResponse): GeminiCliQuotaSummary {
  const models: GeminiCliQuotaModel[] = [];
  
  if (!response.buckets || response.buckets.length === 0) {
    return { models };
  }

  for (const bucket of response.buckets) {
    if (!bucket.modelId) {
      continue;
    }
    
    // Filter out models we don't care about for Gemini CLI quotas
    // Show gemini-3* (including dotted like gemini-3.1-pro-preview, gemini-3.5-flash)
    // and gemini-2.5-pro (the premium legacy model)
    const modelId = bucket.modelId;
    const isRelevantModel = 
      modelId.startsWith("gemini-3") || 
      modelId === "gemini-2.5-pro";
    
    if (!isRelevantModel) {
      continue;
    }
    
    models.push({
      modelId: bucket.modelId,
      remainingFraction: normalizeRemainingFraction(bucket.remainingFraction),
      resetTime: bucket.resetTime,
    });
  }

  // Sort by model ID for consistent display
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));

  return { models };
}

function applyAccountUpdates(account: AccountMetadataV3, auth: OAuthAuthDetails): AccountMetadataV3 | undefined {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  const updated: AccountMetadataV3 = {
    ...account,
    refreshToken: parts.refreshToken,
    projectId: parts.projectId ?? account.projectId,
    managedProjectId: parts.managedProjectId ?? account.managedProjectId,
  };

  const changed =
    updated.refreshToken !== account.refreshToken ||
    updated.projectId !== account.projectId ||
    updated.managedProjectId !== account.managedProjectId;

  return changed ? updated : undefined;
}

function normalizeError(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  try {
    const serialized = JSON.stringify(reason);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // ignore — fall through to generic message
  }
  return "Unknown error";
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Quota check timed out after ${ms}ms (${label})`)),
      ms,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function checkSingleAccountQuota(
  account: AccountMetadataV3,
  index: number,
  client: PluginClient,
  providerId: string,
): Promise<AccountQuotaResult> {
  const disabled = account.enabled === false;
  const label = account.email ?? `account[${index}]`;
  let auth = buildAuthFromAccount(account);

  if (accessTokenExpired(auth)) {
    const refreshed = await refreshAccessToken(auth, client, providerId);
    if (!refreshed) {
      throw new Error("Token refresh failed");
    }
    auth = refreshed;
  }

  const projectContext = await ensureProjectContext(auth);
  auth = projectContext.auth;
  const updatedAccount = applyAccountUpdates(account, auth);

  const [antigravityResponse, geminiCliResponse, subscriptionInfo] = await Promise.all([
    fetchAvailableModels(auth.access ?? "", projectContext.effectiveProjectId)
      .catch((e): FetchAvailableModelsResponse => {
        log.warn("fetchAvailableModels failed during background refresh", { error: String(e) });
        return { models: undefined };
      }),
    fetchGeminiCliQuota(auth.access ?? "", projectContext.effectiveProjectId),
    getSubscriptionTier(auth.access ?? "")
      .catch((e): SubscriptionInfo => {
        log.warn("getSubscriptionTier failed", { error: String(e) });
        return { tier: "unknown", tierId: null, tierSource: null, projectId: null };
      }),
  ]);

  const quotaResult: QuotaSummary =
    antigravityResponse.models === undefined
      ? { groups: {}, models: [], modelCount: 0, error: "Failed to fetch Antigravity quota" }
      : aggregateQuota(antigravityResponse.models);

  const geminiCliQuotaResult = aggregateGeminiCliQuota(geminiCliResponse);
  if (geminiCliResponse.buckets === undefined || geminiCliResponse.buckets.length === 0) {
    geminiCliQuotaResult.error =
      geminiCliQuotaResult.models.length === 0 ? "No Gemini CLI quota available" : undefined;
  }

  for (const [family, groupQuota] of Object.entries(quotaResult.groups)) {
    const remainingPercent = (groupQuota.remainingFraction ?? 0) * 100;
    logQuotaStatus(account.email, index, remainingPercent, family);
  }

  logSubscriptionTier(account.email, subscriptionInfo.tier, subscriptionInfo.tierId)

  return {
    index,
    email: account.email,
    status: "ok",
    disabled,
    quota: quotaResult,
    geminiCliQuota: geminiCliQuotaResult,
    subscriptionTier: subscriptionInfo.tier,
    updatedAccount,
  };
}

export async function checkAccountsQuota(
  accounts: AccountMetadataV3[],
  client: PluginClient,
  providerId = ANTIGRAVITY_PROVIDER_ID,
): Promise<AccountQuotaResult[]> {
  // Snapshot the array immediately — index positions must stay stable
  // across the async lifetime of this function.
  const snapshot = accounts.slice(0, MAX_QUOTA_ACCOUNTS);

  logQuotaFetch("start", snapshot.length);

  const settled = await Promise.allSettled(
    snapshot.map((account, index) =>
      withTimeout(
        checkSingleAccountQuota(account, index, client, providerId),
        ACCOUNT_QUOTA_TIMEOUT_MS,
        account.email ?? `account[${index}]`,
      ),
    ),
  );

  const results: AccountQuotaResult[] = settled.map((outcome, index) => {
    const account = snapshot[index]!;
    if (outcome.status === "fulfilled") {
      return outcome.value;
    }
    const errorMessage = normalizeError(outcome.reason);
    logQuotaFetch(
      "error",
      undefined,
      `account=${account.email ?? index} error=${errorMessage}`,
    );
    return {
      index,
      email: account.email,
      status: "error" as const,
      disabled: account.enabled === false,
      error: errorMessage,
    };
  });

  logQuotaFetch(
    "complete",
    snapshot.length,
    `ok=${results.filter(r => r.status === "ok").length} errors=${results.filter(r => r.status === "error").length}`,
  );
  return results
}

// ============================================================================
// SUBSCRIPTION TIER DETECTION (loadCodeAssist)
// Based on: badrisnarayanan/antigravity-claude-proxy/src/cloudcode/model-api.js
// ============================================================================

export type SubscriptionTier = "free" | "pro" | "ultra" | "unknown"

export interface SubscriptionInfo {
  tier: SubscriptionTier
  tierId: string | null
  tierSource: string | null
  projectId: string | null
}

function parseTierId(tierId: string): SubscriptionTier {
  if (!tierId) return "unknown"
  const lower = tierId.toLowerCase()

  if (lower.includes("ultra")) return "ultra"
  if (lower === "standard-tier") return "pro"
  if (lower.includes("pro") || lower.includes("premium")) return "pro"
  if (lower === "free-tier" || lower.includes("free")) return "free"
  return "unknown"
}

interface LoadCodeAssistResponse {
  paidTier?: { id?: string }
  currentTier?: { id?: string }
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>
  cloudaicompanionProject?: string | { id?: string }
}

/**
 * Detect the subscription tier for an account by calling loadCodeAssist.
 *
 * Priority: paidTier (Google One AI) > currentTier > allowedTiers default.
 * Returns tier, tierId, tierSource, and the discovered projectId.
 */
export async function getSubscriptionTier(accessToken: string): Promise<SubscriptionInfo> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": getAntigravityHeaders()["Client-Metadata"],
  }

  const body = JSON.stringify({
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
      pluginType: "GEMINI",
    },
  })

  for (const endpoint of ANTIGRAVITY_LOAD_ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body,
      })

      if (!response.ok) {
        logQuotaFetch("error", undefined, `loadCodeAssist ${response.status} at ${endpoint}`)
        continue
      }

      const data = (await response.json()) as LoadCodeAssistResponse

      let projectId: string | null = null
      if (typeof data.cloudaicompanionProject === "string") {
        projectId = data.cloudaicompanionProject
      } else if (data.cloudaicompanionProject?.id) {
        projectId = data.cloudaicompanionProject.id
      }

      let tier: SubscriptionTier = "unknown"
      let tierId: string | null = null
      let tierSource: string | null = null

      // 1. paidTier — Google One AI subscription (most reliable)
      if (data.paidTier?.id) {
        tierId = data.paidTier.id
        tier = parseTierId(tierId)
        tierSource = "paidTier"
      }

      // 2. currentTier — fallback
      if (tier === "unknown" && data.currentTier?.id) {
        tierId = data.currentTier.id
        tier = parseTierId(tierId)
        tierSource = "currentTier"
      }

      // 3. allowedTiers — last resort (find default or first non-free)
      if (tier === "unknown" && Array.isArray(data.allowedTiers) && data.allowedTiers.length > 0) {
        const defaultTier = data.allowedTiers.find((t) => t?.isDefault) ?? data.allowedTiers[0]
        if (defaultTier?.id) {
          tierId = defaultTier.id
          tier = parseTierId(tierId)
          tierSource = "allowedTiers"
        }
      }

      logQuotaFetch("complete", undefined, `subscription tier=${tier} tierId=${tierId} source=${tierSource} projectId=${projectId}`)
      return { tier, tierId, tierSource, projectId }
    } catch (error) {
      logQuotaFetch("error", undefined, `loadCodeAssist error at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  logQuotaFetch("error", undefined, "loadCodeAssist failed on all endpoints — defaulting to unknown")
  return { tier: "unknown", tierId: null, tierSource: null, projectId: null }
}
