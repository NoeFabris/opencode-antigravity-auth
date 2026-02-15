import { beforeEach, describe, expect, it, vi } from "vitest"

const { fetchWithProxyMock } = vi.hoisted(() => ({
  fetchWithProxyMock: vi.fn(),
}))

vi.mock("./proxy", () => ({
  fetchWithProxy: fetchWithProxyMock,
}))

import { loadManagedProject, onboardManagedProject } from "./project"

describe("project proxy routing", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("routes loadManagedProject through fetchWithProxy with account-scoped proxy args", async () => {
    fetchWithProxyMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ cloudaicompanionProject: "managed-project" }),
        { status: 200 },
      ),
    )

    const proxies = [{ url: "http://127.0.0.1:8080" }]
    const result = await loadManagedProject("access-token", "my-project", proxies, 4)

    expect(result?.cloudaicompanionProject).toBe("managed-project")
    expect(fetchWithProxyMock).toHaveBeenCalledTimes(1)

    const [url, init, passedProxies, passedAccountIndex] = fetchWithProxyMock.mock.calls[0] ?? []
    expect(typeof url).toBe("string")
    expect(url).toContain("/v1internal:loadCodeAssist")
    expect((init as RequestInit | undefined)?.method).toBe("POST")
    expect(passedProxies).toEqual(proxies)
    expect(passedAccountIndex).toBe(4)
  })

  it("routes onboardManagedProject through fetchWithProxy with account-scoped proxy args", async () => {
    fetchWithProxyMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          done: true,
          response: {
            cloudaicompanionProject: {
              id: "managed-onboarded",
            },
          },
        }),
        { status: 200 },
      ),
    )

    const proxies = [{ url: "socks5://127.0.0.1:1080" }]
    const result = await onboardManagedProject(
      "access-token",
      "FREE",
      "my-project",
      proxies,
      6,
      1,
      0,
    )

    expect(result).toBe("managed-onboarded")
    expect(fetchWithProxyMock).toHaveBeenCalledTimes(1)

    const [url, init, passedProxies, passedAccountIndex] = fetchWithProxyMock.mock.calls[0] ?? []
    expect(typeof url).toBe("string")
    expect(url).toContain("/v1internal:onboardUser")
    expect((init as RequestInit | undefined)?.method).toBe("POST")
    expect(passedProxies).toEqual(proxies)
    expect(passedAccountIndex).toBe(6)
  })
})

