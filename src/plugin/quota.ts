/**
 * Quota fetching module for Antigravity accounts.
 * 
 * Fetches model quota information (remaining fraction and reset time) 
 * from the Antigravity API using the fetchAvailableModels endpoint.
 */

import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_HEADERS,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
} from "../constants.js";
import { createLogger } from "./logger.js";

const log = createLogger("quota");

const FETCH_TIMEOUT_MS = 15000;

export interface QuotaInfo {
  remainingFraction: number | null;
  resetTime: string | null;
}

export interface ModelQuotaInfo extends QuotaInfo {
  displayName?: string;
}

export interface FetchAvailableModelsResponse {
  models?: Record<string, {
    displayName?: string;
    quotaInfo?: {
      remainingFraction?: number;
      resetTime?: string;
    };
  }>;
}

/**
 * Refreshes an access token from a refresh token.
 * Standalone version that doesn't require PluginClient.
 */
export async function refreshAccessTokenStandalone(
  refreshToken: string
): Promise<{ accessToken: string; expiresIn: number } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      log.warn("Token refresh failed", { status: response.status, error: errorText });
      return null;
    }

    const payload = await response.json() as {
      access_token: string;
      expires_in: number;
    };

    return {
      accessToken: payload.access_token,
      expiresIn: payload.expires_in,
    };
  } catch (error) {
    clearTimeout(timeout);
    if ((error as Error).name === "AbortError") {
      log.warn("Token refresh timeout");
      return null;
    }
    log.error("Token refresh error", { error: String(error) });
    return null;
  }
}

/**
 * Fetches available models with quota info from the Antigravity API.
 */
export async function fetchAvailableModels(
  accessToken: string
): Promise<FetchAvailableModelsResponse | null> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    ...ANTIGRAVITY_HEADERS,
  };

  for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const url = `${endpoint}/v1internal:fetchAvailableModels`;

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        log.warn(`fetchAvailableModels error at ${endpoint}`, {
          status: response.status,
          error: errorText,
        });
        continue;
      }

      return (await response.json()) as FetchAvailableModelsResponse;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        log.warn(`fetchAvailableModels timeout at ${endpoint}`);
      } else {
        log.warn(`fetchAvailableModels failed at ${endpoint}`, {
          error: String(error),
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  log.error("Failed to fetch available models from all endpoints");
  return null;
}

/**
 * Get the model family from model name (dynamic detection).
 */
function getModelFamily(modelName: string): "claude" | "gemini" | "unknown" {
  const lower = (modelName || "").toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("gemini")) return "gemini";
  return "unknown";
}

/**
 * Check if a model is supported (Claude or Gemini).
 */
function isSupportedModel(modelId: string): boolean {
  const family = getModelFamily(modelId);
  return family === "claude" || family === "gemini";
}

/**
 * Get model quotas for an account.
 * Returns a map of modelId -> { remainingFraction, resetTime, displayName }
 */
export async function getModelQuotas(
  accessToken: string
): Promise<Record<string, ModelQuotaInfo>> {
  const data = await fetchAvailableModels(accessToken);
  if (!data || !data.models) return {};

  const quotas: Record<string, ModelQuotaInfo> = {};
  
  for (const [modelId, modelData] of Object.entries(data.models)) {
    if (!isSupportedModel(modelId)) continue;

    quotas[modelId] = {
      remainingFraction: modelData.quotaInfo?.remainingFraction ?? null,
      resetTime: modelData.quotaInfo?.resetTime ?? null,
      displayName: modelData.displayName,
    };
  }

  return quotas;
}

/**
 * Format duration in milliseconds to human-readable string.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  
  const seconds = Math.floor(ms / 1000);
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

/**
 * Format quota percentage for display.
 */
export function formatQuotaPercent(fraction: number | null): string {
  if (fraction === null) return "N/A";
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Format reset time for display.
 */
export function formatResetTime(resetTime: string | null): string {
  if (!resetTime) return "-";
  
  const resetDate = new Date(resetTime);
  if (isNaN(resetDate.getTime())) return resetTime;
  
  const now = Date.now();
  const diffMs = resetDate.getTime() - now;
  
  if (diffMs <= 0) return "resetting...";
  
  return `${formatDuration(diffMs)} (${resetDate.toLocaleTimeString()})`;
}

export interface AccountQuotaResult {
  email?: string;
  status: "ok" | "error" | "invalid";
  error?: string;
  models: Record<string, ModelQuotaInfo>;
}

/**
 * Fetch quotas for all accounts from storage.
 * Returns an array of account quota results.
 */
export async function fetchAllAccountQuotas(): Promise<AccountQuotaResult[]> {
  const { loadAccounts } = await import("./storage.js");
  const { parseRefreshParts } = await import("./auth.js");

  const storage = await loadAccounts();
  if (!storage || storage.accounts.length === 0) {
    return [];
  }

  const results: AccountQuotaResult[] = [];

  for (const account of storage.accounts) {
    const parts = parseRefreshParts(`${account.refreshToken}|${account.projectId || ""}`);
    
    if (!parts.refreshToken) {
      results.push({
        email: account.email,
        status: "invalid",
        error: "Missing refresh token",
        models: {},
      });
      continue;
    }

    // Refresh access token
    const tokenResult = await refreshAccessTokenStandalone(parts.refreshToken);
    if (!tokenResult) {
      results.push({
        email: account.email,
        status: "error",
        error: "Failed to refresh access token",
        models: {},
      });
      continue;
    }

    // Fetch quotas
    try {
      const quotas = await getModelQuotas(tokenResult.accessToken);
      results.push({
        email: account.email,
        status: "ok",
        models: quotas,
      });
    } catch (error) {
      results.push({
        email: account.email,
        status: "error",
        error: String(error),
        models: {},
      });
    }
  }

  return results;
}

/**
 * Generate a formatted quota table for CLI display.
 */
export function generateQuotaTable(results: AccountQuotaResult[]): string {
  const lines: string[] = [];
  const timestamp = new Date().toLocaleString();
  
  lines.push(`Antigravity Account Quotas (${timestamp})`);
  lines.push("");

  if (results.length === 0) {
    lines.push("No accounts configured. Run 'opencode auth login' to add accounts.");
    return lines.join("\n");
  }

  // Collect all unique model IDs
  const allModelIds = new Set<string>();
  for (const result of results) {
    for (const modelId of Object.keys(result.models)) {
      allModelIds.add(modelId);
    }
  }
  const sortedModels = Array.from(allModelIds).sort();

  // Account summary
  const okCount = results.filter(r => r.status === "ok").length;
  const errorCount = results.filter(r => r.status === "error" || r.status === "invalid").length;
  lines.push(`Accounts: ${results.length} total, ${okCount} available, ${errorCount} with errors`);
  lines.push("");

  if (sortedModels.length === 0) {
    lines.push("No quota data available.");
    return lines.join("\n");
  }

  // Separate models by family
  const claudeModels = sortedModels.filter(m => m.toLowerCase().includes("claude"));
  const geminiModels = sortedModels.filter(m => m.toLowerCase().includes("gemini"));

  // Column widths
  const modelColWidth = Math.max(30, ...sortedModels.map(m => m.length)) + 2;
  const accountColWidth = 35;

  // Helper to render model rows
  const renderModelSection = (models: string[], title: string) => {
    if (models.length === 0) return;
    
    lines.push(`--- ${title} ---`);
    
    // Header
    let header = "Model".padEnd(modelColWidth);
    for (const result of results) {
      const shortEmail = (result.email || "Unknown").split("@")[0]?.slice(0, 30) || "Unknown";
      header += shortEmail.padEnd(accountColWidth);
    }
    lines.push(header);
    lines.push("─".repeat(modelColWidth + results.length * accountColWidth));

    // Model rows
    for (const modelId of models) {
      let row = modelId.padEnd(modelColWidth);
      
      for (const result of results) {
        let cell: string;
        
        if (result.status !== "ok") {
          cell = `[${result.status}]`;
        } else {
          const quota = result.models[modelId];
          if (!quota) {
            cell = "-";
          } else if (quota.remainingFraction === 0 || quota.remainingFraction === null) {
            if (quota.resetTime) {
              const resetMs = new Date(quota.resetTime).getTime() - Date.now();
              if (resetMs > 0) {
                cell = `0% (wait ${formatDuration(resetMs)})`;
              } else {
                cell = "0% (resetting...)";
              }
            } else {
              cell = quota.remainingFraction === 0 ? "0% (exhausted)" : "N/A";
            }
          } else {
            const pct = Math.round(quota.remainingFraction * 100);
            cell = `${pct}%`;
          }
        }
        
        row += cell.padEnd(accountColWidth);
      }
      lines.push(row);
    }
    lines.push("");
  };

  renderModelSection(claudeModels, "Claude Models");
  renderModelSection(geminiModels, "Gemini Models");

  return lines.join("\n");
}

/**
 * Generate JSON output for quota data.
 */
export function generateQuotaJson(results: AccountQuotaResult[]): string {
  const output = {
    timestamp: new Date().toISOString(),
    totalAccounts: results.length,
    accounts: results.map(result => ({
      email: result.email || "unknown",
      status: result.status,
      error: result.error || null,
      models: Object.fromEntries(
        Object.entries(result.models).map(([modelId, quota]) => [
          modelId,
          {
            remaining: formatQuotaPercent(quota.remainingFraction),
            remainingFraction: quota.remainingFraction,
            resetTime: quota.resetTime,
          },
        ])
      ),
    })),
  };

  return JSON.stringify(output, null, 2);
}

/**
 * Simplified pool info for an account.
 */
export interface PoolQuotaInfo {
  remaining: string;
  remainingFraction: number | null;
  resetIn: string;
  resetTime: string | null;
}

export interface SimplifiedAccountQuota {
  email: string;
  status: "ok" | "error" | "invalid";
  error?: string;
  claude: PoolQuotaInfo;
  gemini: PoolQuotaInfo;
}

/**
 * Get simplified quota info showing just 2 pools: Claude and Gemini.
 * - Claude: Uses any claude model (they share the same quota)
 * - Gemini: Uses gemini-3-pro-high or gemini-3-pro-low as representative
 */
export function getSimplifiedQuotas(results: AccountQuotaResult[]): SimplifiedAccountQuota[] {
  return results.map(result => {
    // Find Claude quota (any claude model - they share the same limit)
    const claudeModel = Object.keys(result.models).find(m => 
      m.toLowerCase().includes("claude")
    );
    const claudeQuota = claudeModel ? result.models[claudeModel] ?? null : null;

    // Find Gemini quota (prefer gemini-3-pro-high, fallback to gemini-3-pro-low)
    const geminiModel = Object.keys(result.models).find(m => 
      m === "gemini-3-pro-high"
    ) || Object.keys(result.models).find(m => 
      m === "gemini-3-pro-low"
    ) || Object.keys(result.models).find(m => 
      m.toLowerCase().includes("gemini-3-pro")
    );
    const geminiQuota = geminiModel ? result.models[geminiModel] ?? null : null;

    const formatPool = (quota: ModelQuotaInfo | null): PoolQuotaInfo => {
      if (!quota) {
        return { remaining: "N/A", remainingFraction: null, resetIn: "-", resetTime: null };
      }
      
      let resetIn = "-";
      if (quota.resetTime) {
        const diffMs = new Date(quota.resetTime).getTime() - Date.now();
        if (diffMs > 0) {
          resetIn = formatDuration(diffMs);
        } else {
          resetIn = "resetting...";
        }
      }

      return {
        remaining: formatQuotaPercent(quota.remainingFraction),
        remainingFraction: quota.remainingFraction,
        resetIn,
        resetTime: quota.resetTime,
      };
    };

    return {
      email: result.email || "unknown",
      status: result.status,
      error: result.error,
      claude: formatPool(claudeQuota),
      gemini: formatPool(geminiQuota),
    };
  });
}

/**
 * Generate a simple 2-pool quota table for CLI display.
 * Shows only Claude and Gemini pools per account.
 */
export function generateSimpleQuotaTable(results: AccountQuotaResult[]): string {
  const simplified = getSimplifiedQuotas(results);
  const lines: string[] = [];
  
  lines.push("Antigravity Quota Status");
  lines.push("========================");
  lines.push("");

  if (simplified.length === 0) {
    lines.push("No accounts configured.");
    return lines.join("\n");
  }

  // Column widths
  const accountCol = 25;
  const poolCol = 20;

  // Header
  lines.push(
    "Account".padEnd(accountCol) + 
    "Claude".padEnd(poolCol) + 
    "Gemini (3-pro)".padEnd(poolCol)
  );
  lines.push("─".repeat(accountCol + poolCol * 2));

  // Data rows
  for (const account of simplified) {
    const shortEmail = account.email.split("@")[0]?.slice(0, 22) || "Unknown";
    
    if (account.status !== "ok") {
      lines.push(
        shortEmail.padEnd(accountCol) + 
        `[${account.status}]`.padEnd(poolCol) + 
        `[${account.status}]`.padEnd(poolCol)
      );
      continue;
    }

    const formatCell = (pool: PoolQuotaInfo): string => {
      if (pool.remainingFraction === null) return "N/A";
      if (pool.remainingFraction === 0) return `0% (${pool.resetIn})`;
      return `${pool.remaining} (${pool.resetIn})`;
    };

    lines.push(
      shortEmail.padEnd(accountCol) + 
      formatCell(account.claude).padEnd(poolCol) + 
      formatCell(account.gemini).padEnd(poolCol)
    );
  }

  lines.push("");
  lines.push(`Updated: ${new Date().toLocaleTimeString()}`);

  return lines.join("\n");
}
