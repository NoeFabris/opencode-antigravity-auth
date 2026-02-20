import { describe, expect, it, vi } from "vitest"
import {
  deriveDebugPolicy,
  formatAccountContextLabel,
  formatAccountLabel,
  formatBodyPreviewForLog,
  formatErrorForLog,
  truncateTextForLog,
  writeConsoleLog,
} from "./logging-utils"

describe("deriveDebugPolicy", () => {
  it("keeps debug_tui disabled when debug is disabled", () => {
    const policy = deriveDebugPolicy({
      configDebug: false,
      configDebugTui: true,
      envDebugFlag: "",
      envDebugTuiFlag: "1",
    })

    expect(policy.debugEnabled).toBe(false)
    expect(policy.debugTuiEnabled).toBe(false)
    expect(policy.verboseEnabled).toBe(false)
    expect(policy.debugLevel).toBe(0)
  })

  it("supports verbose mode override when debug config is enabled", () => {
    const policy = deriveDebugPolicy({
      configDebug: true,
      configDebugTui: false,
      envDebugFlag: "verbose",
      envDebugTuiFlag: "",
    })

    expect(policy.debugEnabled).toBe(true)
    expect(policy.debugTuiEnabled).toBe(false)
    expect(policy.verboseEnabled).toBe(true)
    expect(policy.debugLevel).toBe(2)
  })
})

describe("format helpers", () => {
  it("formats account labels consistently", () => {
    expect(formatAccountLabel("person@example.com", 4)).toBe("person@example.com")
    expect(formatAccountLabel(undefined, 1)).toBe("Account 2")
    expect(formatAccountContextLabel(undefined, -1)).toBe("All accounts")
    expect(formatAccountContextLabel(undefined, 0)).toBe("Account 1")
  })

  it("formats errors defensively", () => {
    expect(formatErrorForLog(new Error("boom"))).toContain("boom")
    expect(formatErrorForLog({ code: 401 })).toBe('{"code":401}')

    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(formatErrorForLog(circular)).toContain("[object Object]")
  })

  it("truncates long text with metadata", () => {
    const longText = "x".repeat(12)
    expect(truncateTextForLog(longText, 5)).toBe("xxxxx... (truncated 7 chars)")
    expect(truncateTextForLog("short", 10)).toBe("short")
  })

  it("formats body previews safely", () => {
    expect(formatBodyPreviewForLog("abcdef", 3)).toBe("abc... (truncated 3 chars)")
    expect(formatBodyPreviewForLog(new URLSearchParams({ q: "value" }), 100)).toBe("q=value")
    expect(formatBodyPreviewForLog(new Uint8Array([1, 2]), 100)).toBe("[Uint8Array payload omitted]")
  })
})

describe("writeConsoleLog", () => {
  it("routes to the level-specific console method", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    writeConsoleLog("debug", "dbg")
    writeConsoleLog("info", "inf")
    writeConsoleLog("warn", "wrn")
    writeConsoleLog("error", "err")

    expect(debugSpy).toHaveBeenCalledWith("dbg")
    expect(infoSpy).toHaveBeenCalledWith("inf")
    expect(warnSpy).toHaveBeenCalledWith("wrn")
    expect(errorSpy).toHaveBeenCalledWith("err")

    debugSpy.mockRestore()
    infoSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
