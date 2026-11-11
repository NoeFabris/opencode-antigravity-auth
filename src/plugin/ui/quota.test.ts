import { describe, expect, it } from "vitest"
import {
  createProgressBar,
  formatQuotaDescription,
  formatResetCountdown,
  formatAccountQuotaReport,
  parseQuotaLine,
} from "./quota.ts"
import type { AccountQuotaResult } from "../quota.ts"

const NOW = Date.parse("2026-10-27T12:00:00Z")

describe("cached quota descriptions", () => {
  it("shows when no cached quota is available", () => {
    expect(formatQuotaDescription(undefined, NOW)).toBe("no quota data")
  })

  it.each([
    ["2026-10-27T14:54:00Z", "81% · resets in 2h 54m"],
    ["2026-11-03T09:00:00Z", "81% · resets in 6d 21h"],
    ["2026-10-28T12:00:00Z", "81% · resets in 1d 0h"],
    ["2026-10-27T13:00:00Z", "81% · resets in 1h 0m"],
    ["2026-10-27T12:05:00Z", "81% · resets in 5m"],
    ["2026-10-27T12:00:01Z", "81% · resets in 1m"],
    ["2026-10-27T12:00:00Z", "81% · reset due"],
    ["2026-10-27T11:59:00Z", "81% · reset due"],
  ])("formats reset time %s", (resetTime, expected) => {
    expect(formatQuotaDescription({ remainingFraction: 0.81, resetTime }, NOW)).toBe(expected)
  })

  it("omits reset times when the displayed quota is full", () => {
    const resetTime = "2026-10-27T14:54:00Z"
    expect(formatQuotaDescription({ remainingFraction: 1, resetTime }, NOW)).toBe("100%")
    expect(formatQuotaDescription({ remainingFraction: 0.999, resetTime }, NOW)).toBe("100%")
  })

  it("keeps the percentage when reset time is absent or invalid", () => {
    expect(formatQuotaDescription({ remainingFraction: 0.794 }, NOW)).toBe("79%")
    expect(formatQuotaDescription({ remainingFraction: 0.81, resetTime: "invalid" }, NOW)).toBe("81%")
  })

  it("shows an exhausted quota and its reset time", () => {
    expect(formatQuotaDescription({ remainingFraction: 0, resetTime: "2026-10-27T14:54:00Z" }, NOW)).toBe("0% · resets in 2h 54m")
  })
})

describe("Antigravity progress bar", () => {
  it("renders a 100% full progress bar with default 34 width", () => {
    const bar = createProgressBar(1, { width: 34, ansi: false })
    expect(bar).toBe("[██████████████████████████████████] 100.00%")
  })

  it("renders a 32.86% partial progress bar", () => {
    const bar = createProgressBar(0.3286, { width: 34, ansi: false })
    // 34 * 0.3286 = 11.17 -> 11 filled, 23 empty
    expect(bar).toBe("[███████████░░░░░░░░░░░░░░░░░░░░░░░] 32.86%")
  })

  it("renders a 93.74% progress bar", () => {
    const bar = createProgressBar(0.9374, { width: 34, ansi: false })
    // 34 * 0.9374 = 31.87 -> 32 filled, 2 empty
    expect(bar).toBe("[████████████████████████████████░░] 93.74%")
  })

  it("renders undefined quota with unknown state", () => {
    const bar = createProgressBar(undefined, { width: 34, ansi: false })
    expect(bar).toBe("[░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] ???%")
  })
})

describe("formatResetCountdown", () => {
  it("formats multi-day and multi-hour countdown in hours and minutes", () => {
    // 104 hours and 11 minutes later: 104 * 3600000 + 11 * 60000 = 374400000 + 660000 = 375060000 ms
    const target = new Date(NOW + 375060000).toISOString()
    expect(formatResetCountdown(target, 0.3286, NOW, false)).toBe("Refreshes in 104h 11m")
  })

  it("formats sub-day countdown in hours and minutes", () => {
    // 4 hours and 35 minutes later: 4 * 3600000 + 35 * 60000 = 16500000 ms
    const target = new Date(NOW + 16500000).toISOString()
    expect(formatResetCountdown(target, 0.9374, NOW, false)).toBe("Refreshes in 4h 35m")
  })

  it("returns 'Quota available' when fraction is 1 or no resetTime", () => {
    expect(formatResetCountdown(undefined, 1, NOW, false)).toBe("Quota available")
    expect(formatResetCountdown(undefined, undefined, NOW, false)).toBe("Quota available")
  })

  it("returns 'Reset due' when resetTime is in the past", () => {
    const past = new Date(NOW - 60000).toISOString()
    expect(formatResetCountdown(past, 0.5, NOW, false)).toBe("Reset due")
  })
})

describe("formatAccountQuotaReport", () => {
  it("renders card groups matching Image 1 format", () => {
    const result: AccountQuotaResult = {
      index: 0,
      email: "user@example.com",
      status: "ok",
      quota: {
        groups: {
          claude: { remainingFraction: 1, modelCount: 2 },
          "gemini-flash": {
            remainingFraction: 0.3286,
            resetTime: new Date(NOW + 375060000).toISOString(),
            modelCount: 1,
          },
          "gemini-pro": {
            remainingFraction: 0.9374,
            resetTime: new Date(NOW + 16500000).toISOString(),
            modelCount: 1,
          },
        },
        modelCount: 4,
      },
    }

    const report = formatAccountQuotaReport(result, { ansi: false, now: NOW })
    expect(report).toContain("GEMINI MODELS")
    expect(report).toContain("Models within this group: Gemini Flash, Gemini Pro")
    expect(report).toContain("Weekly Limit Remaining")
    expect(report).toContain("[███████████░░░░░░░░░░░░░░░░░░░░░░░] 32.86%")
    expect(report).toContain("Refreshes in 104h 11m")
    expect(report).toContain("Five Hour Limit Remaining")
    expect(report).toContain("[████████████████████████████████░░] 93.74%")
    expect(report).toContain("Refreshes in 4h 35m")
    expect(report).toContain("CLAUDE AND GPT MODELS")
    expect(report).toContain("Models within this group: Claude Opus, Claude Sonnet")
    expect(report).toContain("Quota available")
  })

  it("avoids duplicating or mislabeling identical weekly Gemini Flash and Pro limits", () => {
    const weeklyReset = new Date(NOW + 166 * 3600_000 + 55 * 60_000).toISOString()
    const result: AccountQuotaResult = {
      index: 0,
      email: "user@example.com",
      status: "ok",
      quota: {
        groups: {
          "gemini-flash": { remainingFraction: 0.0015, resetTime: weeklyReset, modelCount: 1 },
          "gemini-pro": { remainingFraction: 0.0015, resetTime: weeklyReset, modelCount: 1 },
          claude: { remainingFraction: 1, modelCount: 2 },
        },
        modelCount: 4,
      },
    }

    const report = formatAccountQuotaReport(result, { ansi: false, now: NOW })
    expect(report).toContain("Weekly Limit Remaining")
    expect(report).toContain("Refreshes in 166h 55m")
    expect(report).not.toContain("Five Hour Limit Remaining")
  })

  it("labels a shared sub-day Gemini limit as Five Hour Limit Remaining without a duplicate Weekly entry", () => {
    const shortReset = new Date(NOW + 3 * 3600_000 + 56 * 60_000).toISOString()
    const result: AccountQuotaResult = {
      index: 0,
      email: "user@example.com",
      status: "ok",
      quota: {
        groups: {
          "gemini-flash": { remainingFraction: 0.831, resetTime: shortReset, modelCount: 1 },
          "gemini-pro": { remainingFraction: 0.831, resetTime: shortReset, modelCount: 1 },
        },
        modelCount: 2,
      },
    }

    const report = formatAccountQuotaReport(result, { ansi: false, now: NOW })
    expect(report).toContain("Five Hour Limit Remaining")
    expect(report).toContain("Refreshes in 3h 56m")
    expect(report).not.toContain("Weekly Limit Remaining")
  })

  it("keeps distinct Flash and Pro entries when both use the same window length with different values", () => {
    const resetA = new Date(NOW + 2 * 3600_000).toISOString()
    const resetB = new Date(NOW + 4 * 3600_000).toISOString()
    const result: AccountQuotaResult = {
      index: 0,
      email: "user@example.com",
      status: "ok",
      quota: {
        groups: {
          "gemini-flash": { remainingFraction: 0.6, resetTime: resetA, modelCount: 1 },
          "gemini-pro": { remainingFraction: 0.9, resetTime: resetB, modelCount: 1 },
        },
        modelCount: 2,
      },
    }

    const report = formatAccountQuotaReport(result, { ansi: false, now: NOW })
    expect(report).toContain("Gemini Flash Limit Remaining")
    expect(report).toContain("Gemini Pro Limit Remaining")
    expect(report).toContain("60.00%")
    expect(report).toContain("90.00%")
  })

  it("renders both Weekly and Five Hour bars when quotaSummary from retrieveUserQuotaSummary is present", () => {
    const weeklyReset = new Date(NOW + 104 * 3600_000 + 11 * 60_000).toISOString()
    const fiveHourReset = new Date(NOW + 4 * 3600_000 + 35 * 60_000).toISOString()
    const result: AccountQuotaResult = {
      index: 0,
      email: "user@example.com",
      status: "ok",
      quota: {
        groups: {
          "gemini-flash": { remainingFraction: 0.9374, resetTime: fiveHourReset, modelCount: 1 },
          "gemini-pro": { remainingFraction: 0.9374, resetTime: fiveHourReset, modelCount: 1 },
        },
        modelCount: 2,
      },
      quotaSummary: [
        {
          displayName: "Gemini Models",
          weekly: { remainingFraction: 0.3286, resetTime: weeklyReset },
          fiveHour: { remainingFraction: 0.9374, resetTime: fiveHourReset },
        },
        {
          displayName: "Claude and GPT models",
          weekly: { remainingFraction: 1 },
          fiveHour: { remainingFraction: 1 },
        },
      ],
    }

    const report = formatAccountQuotaReport(result, { ansi: false, now: NOW })
    expect(report).toContain("GEMINI MODELS")
    expect(report).toContain("Weekly Limit Remaining")
    expect(report).toContain("[███████████░░░░░░░░░░░░░░░░░░░░░░░] 32.86%")
    expect(report).toContain("Refreshes in 104h 11m")
    expect(report).toContain("Five Hour Limit Remaining")
    expect(report).toContain("[████████████████████████████████░░] 93.74%")
    expect(report).toContain("Refreshes in 4h 35m")
    expect(report).toContain("CLAUDE AND GPT MODELS")
    expect(report).toContain("Models within this group: Claude Opus, Claude Sonnet, GPT-OSS")
    expect(report).toContain("[██████████████████████████████████] 100.00%")
    expect(report).toContain("Quota available")
  })

  it("keeps every pool subtitle on the uniform model line", () => {
    const result: AccountQuotaResult = {
      index: 0,
      email: "user@example.com",
      status: "ok",
      quota: { groups: {}, modelCount: 0 },
      quotaSummary: [
        {
          displayName: "Gemini 4 Argon",
          description: "For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.",
          weekly: { remainingFraction: 0.5, resetTime: new Date(NOW + 24 * 3600_000).toISOString() },
        },
      ],
    }

    const report = formatAccountQuotaReport(result, { ansi: false, now: NOW })
    expect(report).toContain("GEMINI 4 ARGON")
    expect(report).toContain("Models within this group: Gemini 4 Argon")
    expect(report).not.toContain("Ultra plans")
  })
})

describe("interactive quota line parsing", () => {
  it.each([
    ["    [██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 18.00%", "error"],
    ["    [███████████░░░░░░░░░░░░░░░░░░░░░░░] 32.86%", "warning"],
    ["    [██████████████████████████████████] 100.00%", "success"],
    ["    [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] ???%", "muted"],
  ])("tones a progress bar by its limit: %s", (line, tone) => {
    expect(parseQuotaLine(line)).toMatchObject({ kind: "bar", indent: 4, tone })
  })

  it("keeps the bar segments and percentage available to the renderer", () => {
    expect(parseQuotaLine("    [███░░░] 50.00%")).toEqual({
      kind: "bar", indent: 4, filled: "███", empty: "░░░", percent: "50.00%", tone: "warning",
    })
  })

  it.each([
    ["    Quota available", "success"],
    ["    Exhausted", "error"],
    ["    Reset due", "warning"],
    ["    Refreshes in 101h 37m", "muted"],
  ])("classifies the status line %s", (line, tone) => {
    expect(parseQuotaLine(line)).toEqual({ kind: "status", indent: 4, text: line.trim(), tone })
  })

  it("recognizes group titles and keeps unknown lines as plain text", () => {
    expect(parseQuotaLine("CLAUDE AND GPT MODELS")).toEqual({ kind: "title", text: "CLAUDE AND GPT MODELS" })
    expect(parseQuotaLine("  Models within this group: Gemini Flash, Gemini Pro")).toEqual({
      kind: "text", indent: 2, text: "Models within this group: Gemini Flash, Gemini Pro",
    })
    expect(parseQuotaLine("  Error: boom")).toEqual({ kind: "text", indent: 2, text: "Error: boom" })
    expect(parseQuotaLine("")).toEqual({ kind: "blank" })
  })
})
