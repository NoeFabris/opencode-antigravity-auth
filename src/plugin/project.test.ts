import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getAntigravityOnboardUserAgent,
  getAntigravityUserAgent,
  getAntigravityVersion,
} from "../constants.ts"
import {
  ensureProjectContext,
  invalidateProjectContextCache,
  loadManagedProject,
  onboardManagedProject,
} from "./project.ts"
import type { OAuthAuthDetails } from "./types.ts"

const DAILY = "https://daily-cloudcode-pa.googleapis.com"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function requestAt(fetchMock: ReturnType<typeof vi.fn>, index: number): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index]
  if (!call) throw new Error(`fetch call ${index} missing`)
  return { url: String(call[0]), init: call[1] as RequestInit }
}

function authFor(refresh: string): OAuthAuthDetails {
  return { type: "oauth", refresh, access: "access-token", expires: Date.now() + 3_600_000 }
}

beforeEach(() => {
  invalidateProjectContextCache()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("loadManagedProject", () => {
  it("sends ideType-only metadata with the Hub User-Agent to the daily host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ cloudaicompanionProject: "managed-1" }))
    vi.stubGlobal("fetch", fetchMock)

    const payload = await loadManagedProject("access-token")

    expect(payload?.cloudaicompanionProject).toBe("managed-1")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, init } = requestAt(fetchMock, 0)
    expect(url).toBe(`${DAILY}/v1internal:loadCodeAssist`)
    expect(JSON.parse(String(init.body))).toEqual({ metadata: { ideType: "ANTIGRAVITY" } })
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer access-token",
      "User-Agent": getAntigravityUserAgent(),
    })
  })

  it("does not retry other hosts when the daily host fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "unavailable" }, 503))
    vi.stubGlobal("fetch", fetchMock)

    expect(await loadManagedProject("access-token")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("onboardManagedProject", () => {
  it("sends snake_case Hub metadata with the long control-plane User-Agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ done: true, response: { cloudaicompanionProject: { id: "managed-2" } } }),
    )
    vi.stubGlobal("fetch", fetchMock)

    expect(await onboardManagedProject("access-token", "free-tier", undefined, 3, 0)).toBe("managed-2")

    const { url, init } = requestAt(fetchMock, 0)
    expect(url).toBe(`${DAILY}/v1internal:onboardUser`)
    expect(JSON.parse(String(init.body))).toEqual({
      tier_id: "free-tier",
      metadata: {
        ide_type: "ANTIGRAVITY",
        ide_version: getAntigravityVersion(),
        ide_name: "antigravity",
      },
    })
    expect(init.headers).toEqual({
      Accept: "*/*",
      "Content-Type": "application/json",
      Authorization: "Bearer access-token",
      "User-Agent": getAntigravityOnboardUserAgent(),
      "X-Goog-Api-Client": "gl-node/22.21.1",
    })
  })

  it("polls until the onboarding operation is done", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ done: false }))
      .mockResolvedValueOnce(jsonResponse({ done: true, response: { cloudaicompanionProject: "managed-3" } }))
    vi.stubGlobal("fetch", fetchMock)

    expect(await onboardManagedProject("access-token", "standard-tier", undefined, 3, 0)).toBe("managed-3")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("stops after a non-OK response without trying other hosts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "forbidden" }, 403))
    vi.stubGlobal("fetch", fetchMock)

    expect(await onboardManagedProject("access-token", "free-tier", undefined, 3, 0)).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("ensureProjectContext", () => {
  it("onboards with the default allowed tier when loadCodeAssist returns no project", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        allowedTiers: [{ id: "legacy-tier" }, { id: "standard-tier", isDefault: true }],
      }))
      .mockResolvedValueOnce(jsonResponse({ done: true, response: { cloudaicompanionProject: { id: "managed-4" } } }))
    vi.stubGlobal("fetch", fetchMock)

    const result = await ensureProjectContext(authFor("refresh-default-tier"))

    expect(result.effectiveProjectId).toBe("managed-4")
    expect(result.auth.refresh).toBe("refresh-default-tier||managed-4")
    expect(JSON.parse(String(requestAt(fetchMock, 1).init.body)).tier_id).toBe("standard-tier")
  })

  it("onboards with free-tier when no tier is advertised", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ done: true, response: { cloudaicompanionProject: "managed-5" } }))
    vi.stubGlobal("fetch", fetchMock)

    const result = await ensureProjectContext(authFor("refresh-free-tier"))

    expect(result.effectiveProjectId).toBe("managed-5")
    expect(JSON.parse(String(requestAt(fetchMock, 1).init.body)).tier_id).toBe("free-tier")
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0]).startsWith(`${DAILY}/`)).toBe(true)
    }
  })

  it("times out loadManagedProject and aborts its request signal when the response body stalls", async () => {
    vi.useFakeTimers()
    let capturedSignal: AbortSignal | undefined
    let bodyReadStarted = false
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined
      return new Response(
        new ReadableStream({
          pull() {
            bodyReadStarted = true
          },
        }, { highWaterMark: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }))

    const pending = loadManagedProject("access-token")
    await vi.waitFor(() => expect(bodyReadStarted).toBe(true))
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(pending).resolves.toBeNull()
    expect(capturedSignal?.aborted).toBe(true)
  })

  it("times out onboardManagedProject and aborts its request signal when the response body stalls", async () => {
    vi.useFakeTimers()
    let capturedSignal: AbortSignal | undefined
    let bodyReadStarted = false
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined
      return new Response(
        new ReadableStream({
          pull() {
            bodyReadStarted = true
          },
        }, { highWaterMark: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }))

    const pending = onboardManagedProject("access-token", "free-tier", undefined, 3, 0)
    await vi.waitFor(() => expect(bodyReadStarted).toBe(true))
    await vi.advanceTimersByTimeAsync(30_000)

    await expect(pending).resolves.toBeUndefined()
    expect(capturedSignal?.aborted).toBe(true)
  })
})
