import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./token", () => ({
  refreshAccessToken: vi.fn(async (auth: { refresh: string }) => ({
    type: "oauth",
    refresh: auth.refresh,
    access: "access-token",
    expires: Date.now() + 3_600_000,
  })),
}))

import { GEMINI_CLI_HEADERS, getAntigravityUserAgent } from "../constants.ts"
import { checkAccountsQuota } from "./quota.ts"
import { refreshAccessToken } from "./token.ts"
import type { AccountMetadataV3 } from "./storage.ts"
import type { PluginClient } from "./types.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const account: AccountMetadataV3 = {
  email: "user@example.com",
  refreshToken: "refresh-token",
  managedProjectId: "managed-project",
  addedAt: 0,
  lastUsed: 0,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("checkAccountsQuota", () => {
  it("persists OAuth rotation before catalog I/O starts", async () => {
    vi.mocked(refreshAccessToken).mockResolvedValueOnce({ type: "oauth", refresh: "rotated||managed-project", access: "fresh", expires: Date.now() + 3600_000 })
    let persisted = false
    const save = vi.fn(async () => { persisted = true })
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(persisted).toBe(true)
      if (String(input).endsWith(":fetchAvailableModels")) return jsonResponse({ models: {} })
      return jsonResponse({ buckets: [] })
    }))
    await checkAccountsQuota([account], {} as PluginClient, "google", { onAccountUpdated: save })
    expect(save).toHaveBeenCalledWith(account, expect.objectContaining({ refreshToken: "rotated" }))
  })

  it("skips disabled accounts without refreshing their tokens when requested", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const results = await checkAccountsQuota([{ ...account, enabled: false }], {} as PluginClient, "google", { includeDisabled: false })
    expect(results).toEqual([{ index: 0, email: account.email, status: "disabled", disabled: true }])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reads Antigravity quota from the daily host with the Hub User-Agent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/v1internal:fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "claude-opus-5-5-high": { quotaInfo: { remainingFraction: 0.5, resetTime: "2026-10-22T00:00:00Z" } },
            "gemini-3.8-flash-high": { quotaInfo: { remainingFraction: 0.25 } },
            "gemini-4-argon-high": { maxTokens: 1048576, quotaInfo: { remainingFraction: 0.75 } },
            "gemini-4-argon-disabled": { disabled: true, quotaInfo: { remainingFraction: 0 } },
            "malformed-entry": null,
          },
        })
      }
      if (url.endsWith("/v1internal:retrieveUserQuota")) {
        return jsonResponse({ buckets: [] })
      }
      return jsonResponse({ error: "unexpected" }, 404)
    })
    vi.stubGlobal("fetch", fetchMock)

    const [result] = await checkAccountsQuota([account], {} as PluginClient)

    expect(result?.status).toBe("ok")
    expect(result?.quota?.groups.claude?.remainingFraction).toBe(0.5)
    expect(result?.quota?.groups["gemini-flash"]?.remainingFraction).toBe(0.25)
    expect(result?.quota?.groups["gemini-pro"]?.remainingFraction).toBe(0.75)
    expect(result?.quota?.models?.["gemini-4-argon-high"]?.maxTokens).toBe(1048576)

    const modelsCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/v1internal:fetchAvailableModels"))
    expect(modelsCalls).toHaveLength(1)
    const [modelsUrl, modelsInit] = modelsCalls[0]!
    expect(String(modelsUrl)).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels")
    expect(new Headers(modelsInit?.headers).get("User-Agent")).toBe(getAntigravityUserAgent())
    expect(JSON.parse(String(modelsInit?.body))).toEqual({ project: "managed-project" })

    // Gemini CLI quota buckets stay on production.
    const cliCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/v1internal:retrieveUserQuota"))
    expect(String(cliCall?.[0])).toBe("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")
    expect(new Headers(cliCall?.[1]?.headers).get("User-Agent")).toBe(GEMINI_CLI_HEADERS["User-Agent"])
  })

  it("shows current Gemini CLI model versions returned by Google", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith(":fetchAvailableModels")) return jsonResponse({ models: {} })
      return jsonResponse({ buckets: [
        { modelId: "gemini-3.8-flash-high", remainingFraction: 0.42, resetTime: "2026-10-22T00:00:00Z" },
        { modelId: "gemini-3.5-flash-lite", remainingFraction: 0.8 },
        { modelId: "gemini-4-pro", remainingFraction: 0.6 },
        { modelId: "unrelated-model", remainingFraction: 1 },
      ] })
    }))
    const [result] = await checkAccountsQuota([account], {} as PluginClient)
    expect(result?.geminiCliQuota?.models.map(model => model.modelId)).toEqual([
      "gemini-3.5-flash-lite", "gemini-3.8-flash-high", "gemini-4-pro",
    ])
    expect(result?.geminiCliQuota?.models[1]).toMatchObject({ remainingFraction: 0.42, resetTime: "2026-10-22T00:00:00Z" })
  })

  it.each([false, true])("keeps the lowest quota's reset separate from the earliest group reset (reverse: %s)", async reverse => {
    const entries = [
      ["claude-opus-4-6-thinking", { quotaInfo: { remainingFraction: 0.2, resetTime: "2026-10-27T17:00:00Z" } }],
      ["claude-sonnet-4-6", { quotaInfo: { remainingFraction: 0.8, resetTime: "2026-10-27T13:00:00Z" } }],
    ]
    const models = Object.fromEntries(reverse ? entries.reverse() : entries)
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      return jsonResponse(String(input).endsWith(":fetchAvailableModels") ? { models } : { buckets: [] })
    }))
    const [result] = await checkAccountsQuota([account], {} as PluginClient)
    expect(result?.quota?.groups.claude).toEqual({
      remainingFraction: 0.2,
      resetTime: "2026-10-27T13:00:00Z",
      remainingFractionResetTime: "2026-10-27T17:00:00Z",
      modelCount: 2,
    })
  })

  it("clears the associated reset when a lower quota has no reset time", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      return jsonResponse(String(input).endsWith(":fetchAvailableModels") ? { models: {
        "claude-sonnet-4-6": { quotaInfo: { remainingFraction: 0.8, resetTime: "2026-10-27T13:00:00Z" } },
        "claude-opus-4-6-thinking": { quotaInfo: { remainingFraction: 0.2 } },
      } } : { buckets: [] })
    }))
    const [result] = await checkAccountsQuota([account], {} as PluginClient)
    expect(result?.quota?.groups.claude).toMatchObject({ remainingFraction: 0.2, resetTime: "2026-10-27T13:00:00Z" })
    expect(result?.quota?.groups.claude?.remainingFractionResetTime).toBeUndefined()
  })

  it("uses a known reset when models have the same minimum quota", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      return jsonResponse(String(input).endsWith(":fetchAvailableModels") ? { models: {
        "claude-sonnet-4-6": { quotaInfo: { remainingFraction: 0.2 } },
        "claude-opus-4-6-thinking": { quotaInfo: { remainingFraction: 0.2, resetTime: "2026-10-27T17:00:00Z" } },
      } } : { buckets: [] })
    }))
    const [result] = await checkAccountsQuota([account], {} as PluginClient)
    expect(result?.quota?.groups.claude).toMatchObject({ remainingFraction: 0.2, remainingFractionResetTime: "2026-10-27T17:00:00Z" })
  })
})
