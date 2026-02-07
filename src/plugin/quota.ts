import {
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_HEADERS,
  ANTIGRAVITY_PROVIDER_ID,
} from "../constants";
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./auth";
import { refreshAccessToken } from "./token";
import { getModelFamily } from "./transform/model-resolver";
import type { PluginClient, OAuthAuthDetails } from "./types";
import type { AccountMetadataV3 } from "./storage";

const FETCH_TIMEOUT_MS = 10000;

export type QuotaGroup = "claude" | "gemini-pro" | "gemini-flash";

export interface QuotaGroupSummary {
  remainingFraction?: number;
  resetTime?: string;
  modelCount: number;
}

export interface QuotaSummary {
  groups: Partial<Record<QuotaGroup, QuotaGroupSummary>>;
  modelCount: number;
  error?: string;
}

export type AccountQuotaStatus = "ok" | "disabled" | "error";

export interface AccountQuotaResult {
  index: number;
  email?: string;
  status: AccountQuotaStatus;
  error?: string;
  disabled?: boolean;
  quota?: QuotaSummary;
  updatedAccount?: AccountMetadataV3;
}

export interface CheckAccountsQuotaOptions {
  concurrency?: number;
  perAccountTimeoutMs?: number;
  onProgress?: (info: { done: number; total: number; result: AccountQuotaResult }) => void;
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

function normalizeRemainingFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
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
  const isGemini3 = combined.includes("gemini-3") || combined.includes("gemini 3");
  if (!isGemini3) {
    return null;
  }
  const family = getModelFamily(modelName);
  return family === "gemini-flash" ? "gemini-flash" : "gemini-pro";
}

function aggregateQuota(models?: Record<string, FetchAvailableModelEntry>): QuotaSummary {
  const groups: Partial<Record<QuotaGroup, QuotaGroupSummary>> = {};
  if (!models) {
    return { groups, modelCount: 0 };
  }

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

  return { groups, modelCount: totalCount };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timer]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
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
  const endpoint = ANTIGRAVITY_ENDPOINT_PROD;
  const quotaUserAgent = ANTIGRAVITY_HEADERS["User-Agent"] || "antigravity/windows/amd64";
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
  options: CheckAccountsQuotaOptions = {},
): Promise<AccountQuotaResult[]> {
  const total = accounts.length;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, total));
  const perAccountTimeoutMs = options.perAccountTimeoutMs ?? 25_000;

  const results: AccountQuotaResult[] = new Array(total);
  let cursor = 0;
  let done = 0;

  const checkOne = async (account: AccountMetadataV3, index: number): Promise<AccountQuotaResult> => {
    const disabled = account.enabled === false;
    let auth = buildAuthFromAccount(account);

    try {
      if (accessTokenExpired(auth)) {
        const refreshed = await withTimeout(
          refreshAccessToken(auth, client, providerId),
          perAccountTimeoutMs,
          `Token refresh for account ${index + 1}`,
        );
        if (!refreshed) {
          throw new Error("Token refresh failed");
        }
        auth = refreshed;
      }

      // Avoid ensureProjectContext here: it can trigger onboarding loops and long delays.
      const parts = parseRefreshParts(auth.refresh ?? "");
      const effectiveProjectId =
        parts.managedProjectId || parts.projectId || ANTIGRAVITY_DEFAULT_PROJECT_ID;

      const updatedAccount = applyAccountUpdates(account, auth);

      let quotaResult: QuotaSummary;
      try {
        const response = await fetchAvailableModels(auth.access ?? "", effectiveProjectId);
        quotaResult = aggregateQuota(response.models);
      } catch (error) {
        quotaResult = {
          groups: {},
          modelCount: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      return {
        index,
        email: account.email,
        status: "ok",
        disabled,
        quota: quotaResult,
        updatedAccount,
      };
    } catch (error) {
      return {
        index,
        email: account.email,
        status: "error",
        disabled,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;

      const account = accounts[index]!;
      const result = await withTimeout(
        checkOne(account, index),
        perAccountTimeoutMs,
        `Quota check for account ${index + 1}`,
      ).catch((error) => ({
        index,
        email: account.email,
        status: "error" as const,
        disabled: account.enabled === false,
        error: error instanceof Error ? error.message : String(error),
      }));

      results[index] = result;
      done += 1;
      options.onProgress?.({ done, total, result });
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return results;
}
