import { describe, expect, it } from "vitest"
import { formatQuotaDescription } from "./quota.ts"

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
