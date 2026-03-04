import { describe, expect, it, vi } from "vitest"
import {
  deriveDebugPolicy,
  formatAccountContextLabel,
  formatAccountLabel,
  formatBodyPreviewForLog,
  formatErrorForLog,
  scrubTextForLog,
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

  it("scrubs sensitive values from error previews", () => {
    const raw = "token=abc123 email=user@example.com authorization: Bearer abc123 card=4242 4242 4242 4242"
    const scrubbed = scrubTextForLog(raw, 500)

    expect(scrubbed).toContain("token=[redacted]")
    expect(scrubbed).toContain("email=[redacted-email]")
    expect(scrubbed).toContain("authorization: [redacted]")
    expect(scrubbed).toContain("card=[redacted-card]")
    expect(scrubbed).not.toContain("user@example.com")
    expect(scrubbed).not.toContain("Bearer")
    expect(scrubbed).not.toContain("abc123")
  })

  it("scrubs quoted credential keys in JSON-like payloads", () => {
    const raw = '{"authorization":"Bearer abc123","token":"abc123","api_key":"k-123"}'
    const scrubbed = scrubTextForLog(raw, 500)

    expect(scrubbed).toContain('"authorization":"[redacted]"')
    expect(scrubbed).toContain('"token":"[redacted]"')
    expect(scrubbed).toContain('"api_key":"[redacted]"')
    expect(scrubbed).not.toContain("abc123")
    expect(scrubbed).not.toContain("k-123")
  })

  it("scrubs multi-word credential values without leaking trailing words", () => {
    const raw = '{"secret":"multi word value","email":"user@example.com"}'
    const scrubbed = scrubTextForLog(raw, 500)

    expect(scrubbed).toContain('"secret":"[redacted]"')
    expect(scrubbed).not.toContain("multi word value")
    expect(scrubbed).toContain('"email":"[redacted-email]"')
  })

  it("scrubs standalone base64-like tokens with trailing padding", () => {
    const token = "QWxhZGRpbjpvcGVuIHNlc2FtZQ+/=QWxhZGRpbjpvcGVuIHNlc2FtZQ+/="
    const raw = `debug=${token}`
    const scrubbed = scrubTextForLog(raw, 500)

    expect(scrubbed).toContain("[redacted-token]")
    expect(scrubbed).not.toContain(token)
  })

  it("scrubs long token values without redacting long key names", () => {
    const key = "K".repeat(44)
    const token = "T".repeat(44)
    const raw = `${key}=${token}`
    const scrubbed = scrubTextForLog(raw, 500)

    expect(scrubbed).toContain(`${key}=[redacted-token]`)
    expect(scrubbed).not.toContain(token)
  })

  it("does not scrub punctuation-separated digits as credit cards", () => {
    const raw = "id=4!2!4!2!4!2!4!2!4!2!4!2!4!2!4!2"
    const scrubbed = scrubTextForLog(raw, 500)

    expect(scrubbed).toContain(raw)
    expect(scrubbed).not.toContain("[redacted-card]")
  })

  it("does not scrub plain long numeric identifiers as credit cards", () => {
    const raw = "trace_id=1748000000000000000"
    const scrubbed = scrubTextForLog(raw, 500)

    expect(scrubbed).toContain(raw)
    expect(scrubbed).not.toContain("[redacted-card]")
  })

  it("normalizes and truncates scrubbed text", () => {
    const raw = "  a    b    c  "
    expect(scrubTextForLog(raw, 5)).toBe("a b c")
    expect(scrubTextForLog("x".repeat(20), 5)).toBe("xxxxx... (truncated 15 chars)")
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
