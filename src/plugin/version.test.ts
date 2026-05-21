import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

/**
 * Regression tests for the version fallback mechanism.
 *
 * Issue #468: On WSL2/AlmaLinux with strict firewall rules, both the
 * auto-updater API and changelog fetch fail. The plugin then uses the
 * hardcoded fallback version in User-Agent headers. If the fallback is
 * too old, the backend rejects requests for newer models (e.g., Gemini 3.1 Pro)
 * with "not available on this version".
 *
 * These tests verify the fallback is current and that the
 * network-failure path correctly uses it.
 */

// Hoist mock so it applies before dynamic imports in each test
const mockExecFile = vi.hoisted(() =>
  vi.fn((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string) => void) => {
    cb(new Error("ENOENT"))
  })
)

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}))

// Reset module state between tests so versionLocked starts fresh
beforeEach(() => {
  vi.resetModules()
  // Default: agy not found
  mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string) => void) => {
    cb(new Error("ENOENT"))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ANTIGRAVITY_VERSION_FALLBACK", () => {
  it("defaults to the exported fallback constant", async () => {
    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityVersion } = await import("../constants.ts")
    expect(getAntigravityVersion()).toBe(ANTIGRAVITY_VERSION_FALLBACK)
  })

  it("is at least 1.18.0 to support Gemini 3.1 Pro", async () => {
    const { getAntigravityVersion } = await import("../constants.ts")
    const [major, minor] = getAntigravityVersion().split(".").map(Number)
    expect(major).toBeGreaterThanOrEqual(1)
    if (major === 1) expect(minor).toBeGreaterThanOrEqual(18)
  })
})

describe("setAntigravityVersion", () => {
  it("updates the version on first call", async () => {
    const { getAntigravityVersion, setAntigravityVersion } = await import("../constants.ts")
    setAntigravityVersion("2.0.0")
    expect(getAntigravityVersion()).toBe("2.0.0")
  })

  it("locks after first call — subsequent calls are ignored", async () => {
    const { getAntigravityVersion, setAntigravityVersion } = await import("../constants.ts")
    setAntigravityVersion("2.0.0")
    setAntigravityVersion("3.0.0")
    expect(getAntigravityVersion()).toBe("2.0.0")
  })
})

describe("initAntigravityVersion — local agy detection", () => {
  it("uses local agy version when binary is available", async () => {
    mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
      cb(null, "1.0.0\n")
    })

    const { getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe("1.0.0")
  })

  it("falls through to API when agy binary is not found", async () => {
    // mockExecFile already returns ENOENT by default
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => "1.19.0" }),
    )

    const { getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe("1.19.0")
  })

  it("local agy version takes priority over API version", async () => {
    mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
      cb(null, "1.0.0\n")
    })
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "1.99.0" })
    vi.stubGlobal("fetch", mockFetch)

    const { getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe("1.0.0")
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe("initAntigravityVersion — network failure path", () => {
  it("falls back to hardcoded version when both fetches throw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unreachable")))

    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe(ANTIGRAVITY_VERSION_FALLBACK)
  })

  it("falls back to hardcoded version when both fetches return non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "" }),
    )

    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe(ANTIGRAVITY_VERSION_FALLBACK)
  })

  it("uses API version when auto-updater responds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => "1.19.0" }),
    )

    const { getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe("1.19.0")
  })

  it("fallback version appears in User-Agent header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")))

    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityHeaders } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    const headers = getAntigravityHeaders()
    expect(headers["User-Agent"]).toContain(`Antigravity/${ANTIGRAVITY_VERSION_FALLBACK}`)
  })

  it("fallback version appears in randomized antigravity headers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")))

    const { ANTIGRAVITY_VERSION_FALLBACK, getRandomizedHeaders } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    const headers = getRandomizedHeaders("antigravity")
    expect(headers["User-Agent"]).toContain(ANTIGRAVITY_VERSION_FALLBACK)
  })
})
