/**
 * Local token usage tracker — mirrors the official Antigravity CLI ModelUsageStats structure.
 *
 * Tracks input tokens, output tokens, thinking tokens, response tokens,
 * and cache read/write tokens per model for local monitoring independent of the server.
 *
 * Based on protobuf schema: exa.codeium_common_pb.proto → ModelUsageStats
 * Reference: badrisnarayanan/antigravity-claude-proxy/src/modules/usage-stats.js
 */

import { createLogger } from "./logger"

const log = createLogger("usage-tracker")

export interface ModelUsageStats {
  inputTokens: number
  outputTokens: number
  thinkingOutputTokens: number
  responseOutputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface FamilyBucket {
  _subtotal: number
  [modelId: string]: number | undefined
}

export interface HourlyBucket {
  [family: string]: FamilyBucket | number | undefined
  _total: number
}

interface UsageHistory {
  [hourKey: string]: HourlyBucket
}

let history: UsageHistory = {}
let totalStats: ModelUsageStats = createEmptyStats()

function createEmptyStats(): ModelUsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thinkingOutputTokens: 0,
    responseOutputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

function getFamily(modelId: string): string {
  const lower = (modelId || "").toLowerCase()
  if (lower.includes("claude")) return "claude"
  if (lower.includes("gemini")) return "gemini"
  return "other"
}

function getHourKey(): string {
  const now = new Date()
  now.setMinutes(0, 0, 0)
  return now.toISOString()
}

/**
 * Track usage from a streaming response chunk.
 * Extracts usage metadata from SSE payload and accumulates.
 */
export function trackUsage(modelId: string, usage: Partial<ModelUsageStats>): void {
  if (!modelId) return

  const family = getFamily(modelId)
  const key = getHourKey()

  if (!history[key]) {
    history[key] = { _total: 0 }
  }

  const hourData = history[key]!
  if (!hourData[family]) {
    hourData[family] = { _subtotal: 0 }
  }

  const famData = hourData[family] as FamilyBucket | undefined
  if (!famData || typeof famData !== "object") {
    hourData[family] = { _subtotal: 0 }
  }
  const fb = hourData[family] as FamilyBucket
  fb[modelId] = (fb[modelId] || 0) + 1
  fb._subtotal = (fb._subtotal || 0) + 1
  hourData._total = (hourData._total || 0) + 1

  // Accumulate totals
  if (usage.inputTokens) totalStats.inputTokens += usage.inputTokens
  if (usage.outputTokens) totalStats.outputTokens += usage.outputTokens
  if (usage.thinkingOutputTokens) totalStats.thinkingOutputTokens += usage.thinkingOutputTokens
  if (usage.responseOutputTokens) totalStats.responseOutputTokens += usage.responseOutputTokens
  if (usage.cacheReadTokens) totalStats.cacheReadTokens += usage.cacheReadTokens
  if (usage.cacheWriteTokens) totalStats.cacheWriteTokens += usage.cacheWriteTokens

  log.debug(`Usage: ${modelId} input=${usage.inputTokens ?? 0} output=${usage.outputTokens ?? 0} thinking=${usage.thinkingOutputTokens ?? 0} cache_read=${usage.cacheReadTokens ?? 0}`)
}

/**
 * Get the current session totals.
 */
export function getTotalUsage(): ModelUsageStats {
  return { ...totalStats }
}

/**
 * Get hourly history.
 */
export function getUsageHistory(): UsageHistory {
  const sortedKeys = Object.keys(history).sort()
  const sorted: UsageHistory = {}
  for (const key of sortedKeys) {
    sorted[key] = history[key]!
  }
  return sorted
}

/**
 * Reset session totals (keeps history).
 */
export function resetSessionUsage(): void {
  totalStats = createEmptyStats()
}

/**
 * Log a usage summary to the debug file.
 */
export function logUsageSummary(modelId: string, stats: Partial<ModelUsageStats>): void {
  const total = (stats.inputTokens ?? 0) + (stats.outputTokens ?? 0) + (stats.thinkingOutputTokens ?? 0)
  const cachePct = stats.inputTokens && stats.inputTokens > 0
    ? Math.round(((stats.cacheReadTokens ?? 0) / stats.inputTokens) * 100)
    : 0
  log.debug(`UsageSummary: ${modelId} total=${total} input=${stats.inputTokens ?? 0} output=${stats.outputTokens ?? 0} thinking=${stats.thinkingOutputTokens ?? 0} cache_hit=${cachePct}%`)
}
