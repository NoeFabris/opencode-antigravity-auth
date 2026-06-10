import { describe, it, expect, vi, beforeEach } from "vitest"
import type { AccountMetadataV3 } from "./storage.ts"
import type { PluginClient } from "./types.ts"

// --- module mocks (hoisted, factory runs once) ---

vi.mock("./auth.ts", () => ({
  accessTokenExpired: vi.fn(() => false),
  formatRefreshParts: vi.fn(
    ({
      refreshToken,
      projectId,
      managedProjectId,
    }: {
      refreshToken: string
      projectId?: string
      managedProjectId?: string
    }) => {
      const parts: Record<string, string> = { r: refreshToken }
      if (projectId) parts.p = projectId
      if (managedProjectId) parts.m = managedProjectId
      return JSON.stringify(parts)
    },
  ),
  parseRefreshParts: vi.fn((refresh: string) => {
    try {
      const parsed = JSON.parse(refresh) as Record<string, string>
      if (parsed && typeof parsed.r === "string") {
        return {
          refreshToken: parsed.r,
          projectId: parsed.p || undefined,
          managedProjectId: parsed.m || undefined,
        }
      }
    } catch {
      // fall through to legacy
    }
    const [refreshToken = "", projectId = "", managedProjectId = ""] = refresh.split("|")
    return { refreshToken, projectId: projectId || undefined, managedProjectId: managedProjectId || undefined }
  }),
}))

vi.mock("./token.ts", () => ({
  refreshAccessToken: vi.fn(),
}))

vi.mock("./project.ts", () => ({
  ensureProjectContext: vi.fn(),
}))

vi.mock("./debug.ts", () => ({
  logQuotaFetch: vi.fn(),
  logQuotaStatus: vi.fn(),
  logSubscriptionTier: vi.fn(),
}))

vi.mock("../constants.ts", () => ({
  ANTIGRAVITY_ENDPOINT_PROD: "https://cloudcode-pa.googleapis.com",
  ANTIGRAVITY_ENDPOINT_FALLBACKS: ["https://cloudcode-pa.googleapis.com"],
  ANTIGRAVITY_LOAD_ENDPOINTS: ["https://cloudcode-pa.googleapis.com"],
  ANTIGRAVITY_PROVIDER_ID: "google",
  getAntigravityHeaders: vi.fn(() => ({ "User-Agent": "antigravity/test" })),
}))

// --- import mocked modules for direct spy access ---

import { accessTokenExpired } from "./auth.ts"
import { refreshAccessToken } from "./token.ts"
import { ensureProjectContext } from "./project.ts"
import { checkAccountsQuota } from "./quota.ts"

// --- helpers ---

function makeAccount(overrides: Partial<AccountMetadataV3> = {}): AccountMetadataV3 {
  return {
    email: "test@example.com",
    refreshToken: "refresh-token-abc",
    addedAt: Date.now(),
    lastUsed: Date.now(),
    enabled: true,
    ...overrides,
  }
}

function makeClient(): PluginClient {
  return {} as PluginClient
}

function defaultProjectContext(auth: { refresh: string; access?: string }) {
  return Promise.resolve({
    auth: { ...auth, type: "oauth" as const, access: auth.access ?? "test-access-token" },
    effectiveProjectId: "test-project",
  })
}

function mockFetch(handler: (url: string) => { ok: boolean; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const { ok, body } = handler(url)
      return {
        ok,
        json: async () => body,
        text: async () => JSON.stringify(body),
        status: ok ? 200 : 500,
      }
    }),
  )
}

function mockFetchOk() {
  mockFetch(() => ({ ok: true, body: { models: {}, buckets: [] } }))
}

// --- tests ---

describe("checkAccountsQuota", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Re-apply default implementations after reset clears them
    vi.mocked(accessTokenExpired).mockReturnValue(false)
    vi.mocked(ensureProjectContext).mockImplementation(defaultProjectContext as typeof ensureProjectContext)
    mockFetchOk()
  })

  it("returns empty array for no accounts", async () => {
    const results = await checkAccountsQuota([], makeClient())
    expect(results).toEqual([])
  })

  it("returns ok result for a single healthy account", async () => {
    const results = await checkAccountsQuota([makeAccount()], makeClient())

    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe("ok")
    expect(results[0]?.index).toBe(0)
    expect(results[0]?.email).toBe("test@example.com")
  })

  it("returns error result when token refresh fails", async () => {
    vi.mocked(accessTokenExpired).mockReturnValue(true)
    vi.mocked(refreshAccessToken).mockResolvedValue(null as never)

    const results = await checkAccountsQuota([makeAccount()], makeClient())

    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe("error")
    expect(results[0]?.error).toMatch(/token refresh failed/i)
  })

  it("returns error for failed account without affecting successful ones", async () => {
    vi.mocked(ensureProjectContext).mockImplementation(async (auth) => {
      const token = (() => {
        try {
          const parsed = JSON.parse(auth.refresh) as Record<string, string>
          return parsed.r ?? auth.refresh
        } catch {
          return auth.refresh.split("|")[0] ?? ""
        }
      })()
      if (token === "bad-token") {
        throw new Error("project context failed")
      }
      return {
        auth: { ...auth, access: "test-access-token" },
        effectiveProjectId: "test-project",
      }
    })

    const accounts = [
      makeAccount({ email: "good@example.com", refreshToken: "good-token" }),
      makeAccount({ email: "bad@example.com", refreshToken: "bad-token" }),
      makeAccount({ email: "also-good@example.com", refreshToken: "also-good-token" }),
    ]

    const results = await checkAccountsQuota(accounts, makeClient())

    expect(results).toHaveLength(3)
    expect(results[0]?.status).toBe("ok")
    expect(results[1]?.status).toBe("error")
    expect(results[1]?.error).toBe("project context failed")
    expect(results[2]?.status).toBe("ok")
  })

  it("preserves original index ordering in results", async () => {
    const accounts = [
      makeAccount({ email: "zero@example.com" }),
      makeAccount({ email: "one@example.com" }),
      makeAccount({ email: "two@example.com" }),
    ]

    const results = await checkAccountsQuota(accounts, makeClient())

    expect(results.map((r) => r.index)).toEqual([0, 1, 2])
    expect(results.map((r) => r.email)).toEqual([
      "zero@example.com",
      "one@example.com",
      "two@example.com",
    ])
  })

  it("marks disabled accounts correctly", async () => {
    const results = await checkAccountsQuota(
      [makeAccount({ enabled: false })],
      makeClient(),
    )

    expect(results[0]?.disabled).toBe(true)
    expect(results[0]?.status).toBe("ok")
  })

  it("aggregates quota groups from fetchAvailableModels response", async () => {
    mockFetch((url) => {
      if (url.includes("fetchAvailableModels")) {
        return {
          ok: true,
          body: {
            models: {
              "claude-opus-4": {
                quotaInfo: { remainingFraction: 0.75, resetTime: "2026-06-11T00:00:00Z" },
                displayName: "Claude Opus 4",
              },
              "gemini-3-flash": {
                quotaInfo: { remainingFraction: 0.5, resetTime: "2026-06-11T00:00:00Z" },
                displayName: "Gemini 3 Flash",
              },
            },
          },
        }
      }
      return { ok: true, body: { buckets: [] } }
    })

    const results = await checkAccountsQuota([makeAccount()], makeClient())

    expect(results[0]?.status).toBe("ok")
    expect(results[0]?.quota?.groups.claude?.remainingFraction).toBe(0.75)
    expect(results[0]?.quota?.groups["gemini-flash"]?.remainingFraction).toBe(0.5)
  })

  it("runs accounts concurrently — all resolve despite varying latency", async () => {
    const resolutionOrder: string[] = []
    const resolvers = new Map<string, () => void>()

      vi.mocked(ensureProjectContext).mockImplementation(async (auth) => {
        const email = (() => {
          try {
            const parsed = JSON.parse(auth.refresh) as Record<string, string>
            return parsed.r ?? auth.refresh
          } catch {
            return auth.refresh.split("|")[0] ?? "unknown"
          }
        })()
      await new Promise<void>((resolve) => resolvers.set(email, resolve))
      resolutionOrder.push(email)
      return {
        auth: { ...auth, access: "test-access-token" },
        effectiveProjectId: "test-project",
      }
    })

    const accounts = [
      makeAccount({ email: "a@example.com", refreshToken: "a@example.com" }),
      makeAccount({ email: "b@example.com", refreshToken: "b@example.com" }),
      makeAccount({ email: "c@example.com", refreshToken: "c@example.com" }),
    ]

    const quotaPromise = checkAccountsQuota(accounts, makeClient())

    // Release in reverse order to prove parallel execution — results must still be [a, b, c]
    await Promise.resolve()
    resolvers.get("c@example.com")?.()
    resolvers.get("a@example.com")?.()
    resolvers.get("b@example.com")?.()

    const results = await quotaPromise

    expect(results).toHaveLength(3)
    expect(results.map((r) => r.email)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ])
    expect(results.every((r) => r.status === "ok")).toBe(true)
    // Resolution happened out of order — proves parallelism
    expect(resolutionOrder[0]).toBe("c@example.com")
  })

  it("returns error with timeout message when account hangs past budget", async () => {
    vi.useFakeTimers()

    vi.mocked(ensureProjectContext).mockImplementation(
      () => new Promise<never>(() => {}), // never resolves
    )

    const quotaPromise = checkAccountsQuota([makeAccount()], makeClient())
    await vi.runAllTimersAsync()
    const results = await quotaPromise

    expect(results[0]?.status).toBe("error")
    expect(results[0]?.error).toMatch(/timed out/i)

    vi.useRealTimers()
  })

  it("normalizes non-Error rejections to a readable string", async () => {
    vi.mocked(ensureProjectContext).mockRejectedValue("raw string error")

    const results = await checkAccountsQuota([makeAccount()], makeClient())

    expect(results[0]?.status).toBe("error")
    expect(results[0]?.error).toBe("raw string error")
  })

  it("silently truncates accounts list beyond MAX_QUOTA_ACCOUNTS (10)", async () => {
    const accounts = Array.from({ length: 12 }, (_, i) =>
      makeAccount({ email: `acc${i}@example.com`, refreshToken: `tok${i}` }),
    )

    const results = await checkAccountsQuota(accounts, makeClient())

    // Only first 10 processed — guard against runaway parallelism
    expect(results).toHaveLength(10)
    expect(results.every((r) => r.status === "ok")).toBe(true)
  })
})
