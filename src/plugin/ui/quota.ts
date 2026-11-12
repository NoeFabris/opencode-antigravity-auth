import type { AccountSummary } from "../account-rpc.ts"
import type { AccountQuotaResult } from "../quota.ts"
import { ANSI } from "./ansi.ts"

/** Format a cached quota and reset countdown for an account menu row. */
export function formatQuotaDescription(quota: AccountSummary["quota"], now = Date.now()): string {
  if (!quota) return "no quota data"
  const percent = Math.round(quota.remainingFraction * 100)
  const description = `${percent}%`
  if (percent >= 100 || !quota.resetTime) return description

  const resetAt = Date.parse(quota.resetTime)
  if (!Number.isFinite(resetAt)) return description
  const minutes = Math.ceil((resetAt - now) / 60_000)
  if (minutes <= 0) return `${description} · reset due`

  const days = Math.floor(minutes / (24 * 60))
  const hours = Math.floor(minutes / 60) % 24
  const duration = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
  return `${description} · resets in ${duration}`
}

export interface ProgressBarOptions {
  width?: number
  ansi?: boolean
}

/**
 * Creates an Antigravity bracketed progress bar:
 * e.g. [█████████████░░░░░░░░░░░░░░░░░░░░░] 32.86%
 */
export function createProgressBar(fraction: number | undefined, options: ProgressBarOptions = {}): string {
  const width = options.width ?? 34
  const ansi = options.ansi ?? false

  if (typeof fraction !== "number" || !Number.isFinite(fraction)) {
    const emptyBar = "░".repeat(width)
    return `[${ansi ? ANSI.dim : ""}${emptyBar}${ansi ? ANSI.reset : ""}] ???%`
  }

  const clamped = Math.max(0, Math.min(1, fraction))
  const filled = Math.round(clamped * width)
  const empty = width - filled
  const percentStr = `${(clamped * 100).toFixed(2)}%`

  if (!ansi) {
    return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${percentStr}`
  }

  const color = clamped >= 0.6 ? ANSI.green : clamped >= 0.2 ? ANSI.yellow : ANSI.red
  const filledBar = `${color}${"█".repeat(filled)}${ANSI.reset}`
  const emptyBar = `${ANSI.dim}${"░".repeat(empty)}${ANSI.reset}`
  return `[${filledBar}${emptyBar}] ${percentStr}`
}

/**
 * Formats countdown or availability status under a limit:
 * e.g. "Refreshes in 104h 11m" or "Quota available" or "Reset due"
 */
export function formatResetCountdown(
  resetTime?: string,
  remainingFraction?: number,
  now = Date.now(),
  ansi = false,
): string {
  const isFull = typeof remainingFraction === "number" && remainingFraction >= 1
  if (isFull || (!resetTime && remainingFraction !== 0)) {
    return ansi ? `${ANSI.green}Quota available${ANSI.reset}` : "Quota available"
  }

  if (resetTime) {
    const resetAt = Date.parse(resetTime)
    if (Number.isFinite(resetAt)) {
      const diffMs = resetAt - now
      if (diffMs <= 0) {
        return ansi ? `${ANSI.yellow}Reset due${ANSI.reset}` : "Reset due"
      }
      const totalMinutes = Math.max(1, Math.ceil(diffMs / 60_000))
      const hours = Math.floor(totalMinutes / 60)
      const minutes = totalMinutes % 60
      const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
      const text = `Refreshes in ${duration}`
      if (!ansi) return text
      const color = remainingFraction !== undefined && remainingFraction >= 0.6 ? ANSI.green : remainingFraction !== undefined && remainingFraction < 0.2 ? ANSI.red : ANSI.yellow
      return `${color}${text}${ANSI.reset}`
    }
  }

  if (remainingFraction === 0) {
    return ansi ? `${ANSI.red}Exhausted${ANSI.reset}` : "Exhausted"
  }

  return ansi ? `${ANSI.green}Quota available${ANSI.reset}` : "Quota available"
}

export interface QuotaCardItem {
  name: string
  remainingFraction?: number
  resetTime?: string
}

export interface QuotaCardGroup {
  title: string
  subtitle: string
  items: QuotaCardItem[]
}

/**
 * Formats structured quota card groups into the Antigravity /usage visual layout.
 */
export function formatQuotaCards(groups: QuotaCardGroup[], options: { ansi?: boolean; now?: number } = {}): string {
  const ansi = options.ansi ?? false
  const now = options.now ?? Date.now()
  const lines: string[] = []

  for (let gIdx = 0; gIdx < groups.length; gIdx++) {
    const group = groups[gIdx]!
    if (gIdx > 0) lines.push("")

    const titleLine = ansi ? `${ANSI.bold}${ANSI.cyan}${group.title}${ANSI.reset}` : group.title
    lines.push(titleLine)
    if (group.subtitle) {
      const subtitleLine = ansi ? `  ${ANSI.dim}${group.subtitle}${ANSI.reset}` : `  ${group.subtitle}`
      lines.push(subtitleLine)
    }
    lines.push("")

    for (let iIdx = 0; iIdx < group.items.length; iIdx++) {
      const item = group.items[iIdx]!
      if (iIdx > 0) lines.push("")
      lines.push(`  ${item.name}`)
      lines.push(`    ${createProgressBar(item.remainingFraction, { width: 34, ansi })}`)
      lines.push(`    ${formatResetCountdown(item.resetTime, item.remainingFraction, now, ansi)}`)
    }
  }

  return lines.join("\n")
}

export type QuotaTone = "success" | "warning" | "error" | "muted"

/** Maps a remaining fraction to the same thresholds the CLI report uses. */
export function quotaTone(fraction: number | undefined): QuotaTone {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return "muted"
  if (fraction >= 0.6) return "success"
  if (fraction >= 0.2) return "warning"
  return "error"
}

export type QuotaReportLine =
  | { kind: "blank" }
  | { kind: "title"; text: string }
  | { kind: "bar"; indent: number; filled: string; empty: string; percent: string; tone: QuotaTone }
  | { kind: "status"; indent: number; text: string; tone: QuotaTone }
  | { kind: "text"; indent: number; text: string }

const QUOTA_BAR_LINE = /^(\s*)\[([█]*)([░]*)\]\s+(\d+(?:\.\d+)?%|\?\?\?%)$/

/**
 * Parses one line of a formatted quota report so interactive renderers can
 * color it without re-deriving the numbers. Unknown lines fall back to `text`,
 * so a format change degrades to plain output instead of an error.
 */
export function parseQuotaLine(line: string): QuotaReportLine {
  if (line.trim().length === 0) return { kind: "blank" }

  const bar = QUOTA_BAR_LINE.exec(line)
  if (bar) {
    const percent = bar[4]!
    const fraction = percent === "???%" ? undefined : Number.parseFloat(percent) / 100
    return { kind: "bar", indent: bar[1]!.length, filled: bar[2]!, empty: bar[3]!, percent, tone: quotaTone(fraction) }
  }

  const text = line.trim()
  const indent = line.length - line.trimStart().length
  if (text === "Quota available") return { kind: "status", indent, text, tone: "success" }
  if (text === "Exhausted") return { kind: "status", indent, text, tone: "error" }
  if (text === "Reset due") return { kind: "status", indent, text, tone: "warning" }
  if (text.startsWith("Refreshes in ")) return { kind: "status", indent, text, tone: "muted" }
  if (indent === 0 && /[A-Z]/.test(text) && text === text.toUpperCase()) return { kind: "title", text }
  return { kind: "text", indent, text }
}

function classifyLimitWindow(resetTime: string | undefined, now: number): "weekly" | "five_hour" | "unknown" {
  if (!resetTime) return "unknown"
  const resetAt = Date.parse(resetTime)
  if (!Number.isFinite(resetAt)) return "unknown"
  return resetAt - now > 24 * 3600_000 ? "weekly" : "five_hour"
}

function limitWindowLabel(window: "weekly" | "five_hour" | "unknown", fallback = "Quota Remaining"): string {
  if (window === "weekly") return "Weekly Limit Remaining"
  if (window === "five_hour") return "Five Hour Limit Remaining"
  return fallback
}

/**
 * Builds the Antigravity /usage card groups from an AccountQuotaResult and renders the report.
 */
export function formatAccountQuotaReport(
  result: AccountQuotaResult,
  options: { ansi?: boolean; now?: number } = {},
): string {
  const now = options.now ?? Date.now()
  const accountHeader = `${result.email ?? `Account ${result.index + 1}`}${result.disabled ? " [disabled]" : ""}`
  if (result.status === "disabled") {
    return `${accountHeader}\n  Skipped (disabled)`
  }
  if (result.status === "error" || result.error) {
    return `${accountHeader}\n  Error: ${result.error ?? "Unknown error"}`
  }

  const groups: QuotaCardGroup[] = []
  const antigravityGroups = result.quota?.groups ?? {}

  if (result.quotaSummary && result.quotaSummary.length > 0) {
    for (const pool of result.quotaSummary) {
      const lower = pool.displayName.toLowerCase()
      let title = pool.displayName.toUpperCase()
      let subtitle = `Models within this group: ${pool.displayName}`

      if (lower.includes("gemini") && !lower.includes("argon")) {
        title = "GEMINI MODELS"
        subtitle = "Models within this group: Gemini Flash, Gemini Pro"
      } else if (lower.includes("claude") || lower.includes("3p") || lower.includes("gpt")) {
        title = "CLAUDE AND GPT MODELS"
        subtitle = "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS"
      }

      const items: QuotaCardItem[] = []
      if (pool.weekly && !pool.weekly.disabled) {
        items.push({
          name: "Weekly Limit Remaining",
          remainingFraction: pool.weekly.remainingFraction,
          resetTime: pool.weekly.resetTime,
        })
      }
      if (pool.fiveHour && !pool.fiveHour.disabled) {
        items.push({
          name: "Five Hour Limit Remaining",
          remainingFraction: pool.fiveHour.remainingFraction,
          resetTime: pool.fiveHour.resetTime,
        })
      }
      if (items.length > 0) {
        groups.push({ title, subtitle, items })
      }
    }
  } else {
    // Fallback when retrieveUserQuotaSummary is unavailable: derive from fetchAvailableModels groups.
    const geminiFlash = antigravityGroups["gemini-flash"]
    const geminiPro = antigravityGroups["gemini-pro"]
    if (geminiFlash || geminiPro) {
      const items: QuotaCardItem[] = []
      if (geminiFlash && geminiPro) {
        const flashWindow = classifyLimitWindow(geminiFlash.resetTime, now)
        const proWindow = classifyLimitWindow(geminiPro.resetTime, now)
        const identical =
          geminiFlash.remainingFraction === geminiPro.remainingFraction &&
          geminiFlash.resetTime === geminiPro.resetTime

        if (identical) {
          items.push({
            name: limitWindowLabel(flashWindow),
            remainingFraction: geminiFlash.remainingFraction,
            resetTime: geminiFlash.resetTime,
          })
        } else if (flashWindow === "weekly" && proWindow !== "weekly") {
          items.push({ name: "Weekly Limit Remaining", remainingFraction: geminiFlash.remainingFraction, resetTime: geminiFlash.resetTime })
          items.push({ name: "Five Hour Limit Remaining", remainingFraction: geminiPro.remainingFraction, resetTime: geminiPro.resetTime })
        } else if (proWindow === "weekly" && flashWindow !== "weekly") {
          items.push({ name: "Weekly Limit Remaining", remainingFraction: geminiPro.remainingFraction, resetTime: geminiPro.resetTime })
          items.push({ name: "Five Hour Limit Remaining", remainingFraction: geminiFlash.remainingFraction, resetTime: geminiFlash.resetTime })
        } else {
          items.push({ name: "Gemini Flash Limit Remaining", remainingFraction: geminiFlash.remainingFraction, resetTime: geminiFlash.resetTime })
          items.push({ name: "Gemini Pro Limit Remaining", remainingFraction: geminiPro.remainingFraction, resetTime: geminiPro.resetTime })
        }
      } else {
        const g = geminiFlash ?? geminiPro!
        const window = classifyLimitWindow(g.resetTime, now)
        const fallback = geminiFlash ? "Gemini Flash Limit Remaining" : "Gemini Pro Limit Remaining"
        items.push({
          name: limitWindowLabel(window, fallback),
          remainingFraction: g.remainingFraction,
          resetTime: g.resetTime,
        })
      }

      groups.push({
        title: "GEMINI MODELS",
        subtitle: "Models within this group: Gemini Flash, Gemini Pro",
        items,
      })
    }

    const claude = antigravityGroups.claude
    if (claude) {
      const window = classifyLimitWindow(claude.resetTime, now)
      groups.push({
        title: "CLAUDE AND GPT MODELS",
        subtitle: "Models within this group: Claude Opus, Claude Sonnet",
        items: [{
          name: limitWindowLabel(window),
          remainingFraction: claude.remainingFraction,
          resetTime: claude.resetTime,
        }],
      })
    }
  }

  // 3. Gemini CLI Quota (if present)
  const cliModels = result.geminiCliQuota?.models ?? []
  if (cliModels.length > 0) {
    groups.push({
      title: "GEMINI CLI MODELS",
      subtitle: `Models within this group: ${cliModels.map(m => m.modelId).join(", ")}`,
      items: cliModels.map(m => ({
        name: `${m.modelId} Limit Remaining`,
        remainingFraction: m.remainingFraction,
        resetTime: m.resetTime,
      })),
    })
  }

  if (groups.length === 0) {
    return `${accountHeader}\n  No quota information available`
  }

  return formatQuotaCards(groups, options)
}
