import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

function semverCompare(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

const MIN_VERSION_FOR_GEMINI_3_PRO = "1.18.0"
const BROKEN_VERSION = "1.15.8"

describe("ANTIGRAVITY_VERSION_FALLBACK (Issue #468 regression)", () => {
  it("is at least 1.18.0 — minimum version that supports Gemini 3.1 Pro", async () => {
    const { ANTIGRAVITY_VERSION } = await import("../constants.ts")
    expect(
      semverCompare(ANTIGRAVITY_VERSION, MIN_VERSION_FOR_GEMINI_3_PRO),
      `Fallback ${ANTIGRAVITY_VERSION} < ${MIN_VERSION_FOR_GEMINI_3_PRO} — would cause "not available on this version" for Gemini 3.1 Pro`,
    ).toBeGreaterThanOrEqual(0)
  })

  it("is 1.18.3 (confirmed working at time of fix)", async () => {
    const { ANTIGRAVITY_VERSION } = await import("../constants.ts")
    expect(ANTIGRAVITY_VERSION).toBe("1.18.3")
  })
})

describe("initAntigravityVersion", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("uses fallback when both version URLs are unreachable (WSL2/firewall — the Issue #468 scenario)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unreachable")))

    const { getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")

    await initAntigravityVersion()

    const version = getAntigravityVersion()
    expect(version).toBe("1.18.3")
    expect(semverCompare(version, MIN_VERSION_FOR_GEMINI_3_PRO)).toBeGreaterThanOrEqual(0)
  })

  it("uses fallback when version fetch times out (slow WSL2 DNS)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error("AbortError")), 0)),
      ),
    )

    const { getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")

    await initAntigravityVersion()

    expect(semverCompare(getAntigravityVersion(), MIN_VERSION_FOR_GEMINI_3_PRO)).toBeGreaterThanOrEqual(0)
  })

  it("uses fallback when API returns non-200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, text: async () => "" }))

    const { getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")

    await initAntigravityVersion()

    expect(semverCompare(getAntigravityVersion(), MIN_VERSION_FOR_GEMINI_3_PRO)).toBeGreaterThanOrEqual(0)
  })

  it("updates version when auto-updater returns a newer version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => "Stable Version: 1.19.0" }),
    )

    const { getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")

    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe("1.19.0")
  })

  it("falls back to changelog when API fails but changelog has version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockRejectedValueOnce(new Error("network unreachable"))
        .mockResolvedValueOnce({ ok: true, text: async () => "Antigravity 1.20.1 changelog" }),
    )

    const { getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")

    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe("1.20.1")
  })
})

describe("User-Agent version propagation", () => {
  it("embeds the fallback version in the antigravity User-Agent header", async () => {
    const { getAntigravityHeaders } = await import("../constants.ts")
    const headers = getAntigravityHeaders()
    expect(headers["User-Agent"]).toMatch(/Antigravity\/\d+\.\d+\.\d+/)
    expect(headers["User-Agent"]).not.toContain(`Antigravity/${BROKEN_VERSION}`)
  })

  it("1.15.8 is below minimum — confirms the root cause of Issue #468", () => {
    expect(semverCompare(BROKEN_VERSION, MIN_VERSION_FOR_GEMINI_3_PRO)).toBeLessThan(0)
  })
})
