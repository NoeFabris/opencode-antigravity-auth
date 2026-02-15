import { beforeEach, describe, expect, it, vi } from "vitest"

const { fetchWithProxyMock, refreshAccessTokenMock, ensureProjectContextMock } = vi.hoisted(() => ({
  fetchWithProxyMock: vi.fn(),
  refreshAccessTokenMock: vi.fn(),
  ensureProjectContextMock: vi.fn(),
}))

vi.mock("./proxy", () => ({
  fetchWithProxy: fetchWithProxyMock,
}))

vi.mock("./token", () => ({
  refreshAccessToken: refreshAccessTokenMock,
}))

vi.mock("./project", () => ({
  ensureProjectContext: ensureProjectContextMock,
}))

import { checkAccountsQuota } from "./quota"
import type { AccountMetadataV3 } from "./storage"
import type { OAuthAuthDetails, PluginClient } from "./types"

describe("checkAccountsQuota proxy routing", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("passes account-scoped proxies/index to refresh, project context, and quota fetches", async () => {
    const proxies = [{ url: "http://127.0.0.1:8080" }]
    const accountIndex = 7
    const providerId = "antigravity"

    const refreshedAuth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh-token|project-1|managed-project-1",
      access: "access-new",
      expires: Date.now() + 60_000,
    }

    refreshAccessTokenMock.mockResolvedValueOnce(refreshedAuth)
    ensureProjectContextMock.mockResolvedValueOnce({
      auth: refreshedAuth,
      effectiveProjectId: "managed-project-1",
    })

    fetchWithProxyMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: {
              "gemini-3-pro": {
                quotaInfo: {
                  remainingFraction: 0.8,
                  resetTime: "2026-02-15T12:00:00Z",
                },
              },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            buckets: [
              {
                modelId: "gemini-3-pro",
                remainingFraction: 0.6,
                resetTime: "2026-02-15T10:00:00Z",
              },
            ],
          }),
          { status: 200 },
        ),
      )

    const accounts: AccountMetadataV3[] = [
      {
        refreshToken: "refresh-token",
        projectId: "project-1",
        addedAt: Date.now(),
        lastUsed: Date.now(),
        proxies,
      },
    ]

    const client = {
      auth: {
        set: vi.fn(async () => {}),
      },
    } as unknown as PluginClient

    const results = await checkAccountsQuota(accounts, client, providerId, [accountIndex])

    expect(results[0]?.status).toBe("ok")

    expect(refreshAccessTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "oauth" }),
      client,
      providerId,
      proxies,
      accountIndex,
    )

    expect(ensureProjectContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "oauth" }),
      proxies,
      accountIndex,
    )

    expect(fetchWithProxyMock).toHaveBeenCalledTimes(2)
    for (const call of fetchWithProxyMock.mock.calls) {
      expect(call[2]).toEqual(proxies)
      expect(call[3]).toBe(accountIndex)
    }

    expect(fetchWithProxyMock.mock.calls[0]?.[0]).toContain("/v1internal:fetchAvailableModels")
    expect(fetchWithProxyMock.mock.calls[1]?.[0]).toContain("/v1internal:retrieveUserQuota")
  })
})