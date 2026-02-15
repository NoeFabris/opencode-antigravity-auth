import { beforeEach, describe, expect, it, vi } from "vitest"

const { fetchWithProxyMock } = vi.hoisted(() => ({
  fetchWithProxyMock: vi.fn(),
}))

vi.mock("./proxy", () => ({
  fetchWithProxy: fetchWithProxyMock,
}))

import { ANTIGRAVITY_PROVIDER_ID } from "../constants"
import { refreshAccessToken } from "./token"
import type { OAuthAuthDetails, PluginClient } from "./types"

function createClient(): PluginClient {
  return {
    auth: {
      set: vi.fn(async () => {}),
    },
  } as unknown as PluginClient
}

describe("refreshAccessToken proxy routing", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("passes account proxies and account index to fetchWithProxy", async () => {
    fetchWithProxyMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "access-next",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    )

    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh-token|project-1",
      access: "access-old",
      expires: Date.now() - 1000,
    }
    const proxies = [{ url: "http://127.0.0.1:8080" }]
    const accountIndex = 11

    const result = await refreshAccessToken(
      auth,
      createClient(),
      ANTIGRAVITY_PROVIDER_ID,
      proxies,
      accountIndex,
    )

    expect(result?.access).toBe("access-next")
    expect(fetchWithProxyMock).toHaveBeenCalledTimes(1)

    const [url, init, passedProxies, passedAccountIndex] = fetchWithProxyMock.mock.calls[0] ?? []
    expect(url).toBe("https://oauth2.googleapis.com/token")
    expect((init as RequestInit | undefined)?.method).toBe("POST")
    expect(passedProxies).toEqual(proxies)
    expect(passedAccountIndex).toBe(accountIndex)
  })
})