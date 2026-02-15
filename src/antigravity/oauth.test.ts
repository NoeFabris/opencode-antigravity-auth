import { beforeEach, describe, expect, it, vi } from "vitest"

const { fetchWithProxyMock } = vi.hoisted(() => ({
  fetchWithProxyMock: vi.fn(),
}))

vi.mock("../plugin/proxy", () => ({
  fetchWithProxy: fetchWithProxyMock,
}))

import { exchangeAntigravity } from "./oauth"

function makeState(verifier: string, projectId = ""): string {
  return Buffer.from(JSON.stringify({ verifier, projectId }), "utf8").toString("base64url")
}

describe("exchangeAntigravity proxy routing", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("routes token and userinfo requests through account-scoped proxy args", async () => {
    fetchWithProxyMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-1",
            expires_in: 3600,
            refresh_token: "refresh-1",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ email: "user@example.com" }),
          { status: 200 },
        ),
      )

    const proxies = [{ url: "socks5://127.0.0.1:1080" }]
    const accountIndex = 4

    const result = await exchangeAntigravity(
      "auth-code",
      makeState("pkce-verifier", "project-1"),
      proxies,
      accountIndex,
    )

    expect(result.type).toBe("success")
    expect(fetchWithProxyMock).toHaveBeenCalledTimes(2)

    const firstCall = fetchWithProxyMock.mock.calls[0] ?? []
    const secondCall = fetchWithProxyMock.mock.calls[1] ?? []

    expect(firstCall[0]).toBe("https://oauth2.googleapis.com/token")
    expect(secondCall[0]).toBe("https://www.googleapis.com/oauth2/v1/userinfo?alt=json")

    expect(firstCall[2]).toEqual(proxies)
    expect(firstCall[3]).toBe(accountIndex)
    expect(secondCall[2]).toEqual(proxies)
    expect(secondCall[3]).toBe(accountIndex)
  })

  it("routes project discovery request through account-scoped proxy args when projectId is missing", async () => {
    fetchWithProxyMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-2",
            expires_in: 3600,
            refresh_token: "refresh-2",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            cloudaicompanionProject: "resolved-project",
          }),
          { status: 200 },
        ),
      )

    const proxies = [{ url: "http://127.0.0.1:8080" }]
    const accountIndex = 9

    const result = await exchangeAntigravity(
      "auth-code",
      makeState("pkce-verifier"),
      proxies,
      accountIndex,
    )

    expect(result.type).toBe("success")
    expect(fetchWithProxyMock).toHaveBeenCalledTimes(3)

    const projectCall = fetchWithProxyMock.mock.calls[2] ?? []
    expect(typeof projectCall[0]).toBe("string")
    expect(projectCall[0]).toContain("/v1internal:loadCodeAssist")
    expect(projectCall[2]).toEqual(proxies)
    expect(projectCall[3]).toBe(accountIndex)
  })
})