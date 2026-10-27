import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_ENDPOINT_PROD,
  getAntigravityUserAgent,
  getRandomizedHeaders,
  ANTIGRAVITY_PROVIDER_ID,
} from "../constants";
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./auth";
import { logQuotaFetch, logQuotaStatus } from "./debug";
import { ensureProjectContext } from "./project";
import { refreshAccessToken } from "./token";
import { getModelFamily } from "./transform/model-resolver";
import type { PluginClient, OAuthAuthDetails } from "./types";
import type { AccountMetadataV3 } from "./storage";

const FETCH_TIMEOUT_MS = 10000;

export type QuotaGroup = "claude" | "gemini-pro" | "gemini-flash";

export interface QuotaGroupSummary {
  remainingFraction?: number;
  resetTime?: string;
  /** Reset belonging to the model that supplies remainingFraction. */
  remainingFractionResetTime?: string;
  modelCount: number;
}

export interface QuotaSummary {
  groups: Partial<Record<QuotaGroup, QuotaGroupSummary>>;
  modelCount: number;
  models?: Record<string, AvailableModel>;
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
  updatedAccount?: AccountMetadataV3;
}

export interface FetchAvailableModelsResponse {
  models?: Record<string, FetchAvailableModelEntry>;
  agentModelSorts?: Array<{ groups?: Array<{ modelIds?: string[] }> }>;
  tieredModelIds?: Record<string, string[]>;
}

export interface AvailableModel {
  displayName?: string;
  maxTokens?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  disabled?: boolean;
  selectable?: boolean;
}

interface FetchAvailableModelEntry extends AvailableModel {
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
  if (!combined.includes("gemini")) {
    return null;
  }
  const family = getModelFamily(modelName);
  return family === "gemini-flash" ? "gemini-flash" : "gemini-pro";
}

function aggregateQuota(models?: Record<string, FetchAvailableModelEntry>, selectable?: Set<string>): QuotaSummary {
  const groups: Partial<Record<QuotaGroup, QuotaGroupSummary>> = {};
  const catalog: Record<string, AvailableModel> = {};
  if (!models) {
    return { groups, modelCount: 0 };
  }

  let totalCount = 0;
  for (const [modelName, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    // Keep only catalog metadata. API experiments can contain unrelated prompts.
    catalog[modelName] = {
      displayName: entry.displayName,
      maxTokens: entry.maxTokens,
      maxOutputTokens: entry.maxOutputTokens,
      supportsImages: entry.supportsImages,
      supportsThinking: entry.supportsThinking,
      disabled: entry.disabled,
      selectable: selectable ? selectable.has(modelName) : undefined,
    };
    if (entry.disabled) continue;
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

    const existing = groups[group];
    const nextCount = (existing?.modelCount ?? 0) + 1;
    const nextRemaining =
      remainingFraction === undefined
        ? existing?.remainingFraction
        : existing?.remainingFraction === undefined
          ? remainingFraction
          : Math.min(existing.remainingFraction, remainingFraction);

    let remainingFractionResetTime = existing?.remainingFractionResetTime
    if (remainingFraction !== undefined && (existing?.remainingFraction === undefined || remainingFraction < existing.remainingFraction)) {
      remainingFractionResetTime = resetTimestamp === null ? undefined : resetTime
    } else if (remainingFraction !== undefined && remainingFraction === existing?.remainingFraction && !remainingFractionResetTime && resetTimestamp !== null) {
      remainingFractionResetTime = resetTime
    }

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
      remainingFractionResetTime,
      modelCount: nextCount,
    };
  }

  return { groups, modelCount: totalCount, models: catalog };
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
  // Antigravity quota comes from the same host and Hub User-Agent as content requests.
  const endpoint = ANTIGRAVITY_ENDPOINT;
  const quotaUserAgent = getAntigravityUserAgent();
  const errors: string[] = [];

  const body = projectId ? { project: projectId } : {};
  const response = await fetchWithTimeout(`${endpoint}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": quotaUserAgent,
    },
    body: JSON.stringify(body),
  });

  if (response.ok) {
    return (await response.json()) as FetchAvailableModelsResponse;
  }

  const message = await response.text().catch(() => "");
  const snippet = message.trim().slice(0, 200);
  errors.push(
    `fetchAvailableModels ${response.status} at ${endpoint}${snippet ? `: ${snippet}` : ""}`,
  );

  throw new Error(errors.join("; ") || "fetchAvailableModels failed");
}

async function fetchGeminiCliQuota(
  accessToken: string,
  projectId: string,
): Promise<RetrieveUserQuotaResponse> {
  const endpoint = ANTIGRAVITY_ENDPOINT_PROD;
  const body = projectId ? { project: projectId } : {};
  
  try {
    const response = await fetchWithTimeout(`${endpoint}/v1internal:retrieveUserQuota`, {
      method: "POST",
      headers: {
        ...getRandomizedHeaders("gemini-cli"),
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const data = (await response.json()) as RetrieveUserQuotaResponse;
      return data;
    }

    // Non-OK response - return empty buckets
    return { buckets: [] };
  } catch {
    // Network error or timeout - return empty buckets
    return { buckets: [] };
  }
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
    
    // Keep the model versions returned by Google instead of a dated allowlist.
    const modelId = bucket.modelId;
    if (!modelId.startsWith("gemini-")) {
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

export async function checkAccountsQuota(
  accounts: AccountMetadataV3[],
  client: PluginClient,
  providerId = ANTIGRAVITY_PROVIDER_ID,
  options: {
    includeDisabled?: boolean;
    onAccountUpdated?: (original: AccountMetadataV3, updated: AccountMetadataV3) => Promise<unknown>;
    signal?: AbortSignal;
  } = {},
): Promise<AccountQuotaResult[]> {
  const results: AccountQuotaResult[] = [];
  
  logQuotaFetch("start", accounts.length);

  for (const [index, account] of accounts.entries()) {
    const disabled = account.enabled === false;
    if (disabled && options.includeDisabled !== true) {
      results.push({ index, email: account.email, status: "disabled", disabled: true });
      continue;
    }

    let auth = buildAuthFromAccount(account);
    let updatedAccount: AccountMetadataV3 | undefined;

    try {
      options.signal?.throwIfAborted();
      if (accessTokenExpired(auth)) {
        const refreshed = await refreshAccessToken(auth, client, providerId);
        if (!refreshed) {
          throw new Error("Token refresh failed");
        }
        auth = refreshed;
      }

      updatedAccount = applyAccountUpdates(account, auth);
      if (updatedAccount) await options.onAccountUpdated?.(account, updatedAccount);
      options.signal?.throwIfAborted();
      const beforeProject = updatedAccount ?? account;
      const projectContext = await ensureProjectContext(auth);
      auth = projectContext.auth;
      updatedAccount = applyAccountUpdates(account, auth);
      const projectUpdates = applyAccountUpdates(beforeProject, auth);
      if (projectUpdates) await options.onAccountUpdated?.(beforeProject, projectUpdates);
      options.signal?.throwIfAborted();

      let quotaResult: QuotaSummary;
      let geminiCliQuotaResult: GeminiCliQuotaSummary;
      
      // Fetch both Antigravity and Gemini CLI quotas in parallel
      const [antigravityResponse, geminiCliResponse] = await Promise.all([
        fetchAvailableModels(auth.access ?? "", projectContext.effectiveProjectId)
          .catch((error): FetchAvailableModelsResponse => ({ models: undefined })),
        fetchGeminiCliQuota(auth.access ?? "", projectContext.effectiveProjectId),
      ]);

      // Process Antigravity quota
      if (antigravityResponse.models === undefined) {
        quotaResult = {
          groups: {},
          modelCount: 0,
          error: "Failed to fetch Antigravity quota",
        };
      } else {
        const visible = (antigravityResponse.agentModelSorts ?? []).flatMap(sort => (sort.groups ?? []).flatMap(group => group.modelIds ?? []));
        // The backend also exposes obsolete aliases, completion models, and
        // routing IDs. Prefer the same selectable inventory as Antigravity.
        const selectable = visible.length ? new Set([...visible, ...Object.values(antigravityResponse.tieredModelIds ?? {}).flat()]) : undefined;
        quotaResult = aggregateQuota(antigravityResponse.models, selectable);
      }

      // Process Gemini CLI quota
      geminiCliQuotaResult = aggregateGeminiCliQuota(geminiCliResponse);
      if (geminiCliResponse.buckets === undefined || geminiCliResponse.buckets.length === 0) {
        geminiCliQuotaResult.error = geminiCliQuotaResult.models.length === 0 
          ? "No Gemini CLI quota available" 
          : undefined;
      }

      results.push({
        index,
        email: account.email,
        status: "ok",
        disabled,
        quota: quotaResult,
        geminiCliQuota: geminiCliQuotaResult,
        updatedAccount,
      });
      
      // Log quota status for each family
      for (const [family, groupQuota] of Object.entries(quotaResult.groups)) {
        const remainingPercent = (groupQuota.remainingFraction ?? 0) * 100;
        logQuotaStatus(account.email, index, remainingPercent, family);
      }
    } catch (error) {
      results.push({
        index,
        email: account.email,
        status: "error",
        updatedAccount,
        disabled,
        error: error instanceof Error ? error.message : String(error),
      });
      logQuotaFetch("error", undefined, `account=${account.email ?? index} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logQuotaFetch("complete", accounts.length, `ok=${results.filter(r => r.status === "ok").length} errors=${results.filter(r => r.status === "error").length}`);
  return results;
}
