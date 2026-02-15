import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProxyConfig } from "./storage.ts"

const { proxyAgentCtor, socksDispatcherFactory } = vi.hoisted(() => {
  return {
    proxyAgentCtor: vi.fn(function MockProxyAgent(options: { uri: string }) {
      return {
        kind: "proxy-agent",
        options,
      }
    }),
    socksDispatcherFactory: vi.fn((options: {
      type: 4 | 5
      host: string
      port: number
      userId?: string
      password?: string
    }) => {
      return {
        kind: "socks-dispatcher",
        options,
      }
    }),
  }
})

vi.mock("undici", () => ({
  ProxyAgent: proxyAgentCtor,
}))

vi.mock("fetch-socks", () => ({
  socksDispatcher: socksDispatcherFactory,
}))

import {
  fetchWithProxy,
  ProxyExhaustedError,
  resetProxyState,
  __testExports,
} from "./proxy.ts"

const {
  isProxyConnectionError,
  calculateCooldownMs,
  redactUrl,
  proxyStates,
  dispatcherCache,
} = __testExports

function createConnectionError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

function proxy(url: string, enabled = true): ProxyConfig {
  return { url, enabled }
}

function getDispatcherFromCall(fetchMock: {
  mock: {
    calls: unknown[][]
  }
}, callIndex: number): {
  kind?: string
  options?: { uri?: string; host?: string; port?: number; type?: number; userId?: string; password?: string }
} {
  const init = fetchMock.mock.calls[callIndex]?.[1] as
    | (RequestInit & {
        dispatcher?: {
          kind?: string
          options?: {
            uri?: string
            host?: string
            port?: number
            type?: number
            userId?: string
            password?: string
          }
        }
      })
    | undefined
  return init?.dispatcher ?? {}
}

describe("fetchWithProxy", () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    resetProxyState()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetProxyState()
  })

  describe("core behavior", () => {
    it("uses direct fetch when proxies are undefined", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))

      const result = await fetchWithProxy("https://example.com")

      expect(result.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith("https://example.com", undefined)
      expect(dispatcherCache.size).toBe(0)
    })

    it("uses direct fetch when proxies are empty", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))

      const result = await fetchWithProxy("https://example.com", { method: "POST" }, [])

      expect(result.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith("https://example.com", { method: "POST" })
      expect(dispatcherCache.size).toBe(0)
    })

    it("fails closed when proxies are configured but all are disabled", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))

      const promise = fetchWithProxy(
        "https://example.com",
        undefined,
        [
          proxy("http://disabled-1.local:8080", false),
          proxy("http://disabled-2.local:8080", false),
        ],
        2,
      )

      await expect(promise).rejects.toMatchObject({
        name: "ProxyExhaustedError",
        accountIndex: 2,
        proxyCount: 0,
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(proxyStates.size).toBe(0)
      expect(dispatcherCache.size).toBe(0)
    })

    it("routes through the first available proxy", async () => {
      const firstProxy = "http://proxy-1.local:8080"
      const secondProxy = "http://proxy-2.local:8080"
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("proxied"))

      const response = await fetchWithProxy(
        "https://example.com",
        { method: "GET" },
        [proxy(firstProxy), proxy(secondProxy)],
      )

      const dispatcher = getDispatcherFromCall(fetchMock, 0)
      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(dispatcher.options?.uri).toBe(firstProxy)
      expect(dispatcherCache.size).toBe(1)
    })

    it("fails over sequentially on proxy connection errors", async () => {
      const firstProxy = "http://proxy-1.local:8080"
      const secondProxy = "http://proxy-2.local:8080"
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(createConnectionError("ECONNREFUSED"))
        .mockResolvedValueOnce(new Response("ok"))

      const response = await fetchWithProxy(
        "https://example.com",
        undefined,
        [proxy(firstProxy), proxy(secondProxy)],
        5,
      )

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(getDispatcherFromCall(fetchMock, 0).options?.uri).toBe(firstProxy)
      expect(getDispatcherFromCall(fetchMock, 1).options?.uri).toBe(secondProxy)
      expect(proxyStates.get(`5:${firstProxy}`)?.failCount).toBe(1)
      expect(proxyStates.get(`5:${secondProxy}`)).toBeUndefined()
    })

    it.each([400, 500, 503])("does not fail over on HTTP %i responses", async status => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream", { status }))

      const response = await fetchWithProxy(
        "https://example.com",
        undefined,
        [proxy("http://proxy-1.local:8080"), proxy("http://proxy-2.local:8080")],
      )

      expect(response.status).toBe(status)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(proxyStates.size).toBe(0)
    })

    it("throws ProxyExhaustedError when all available proxies fail", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(createConnectionError("ETIMEDOUT"))
        .mockRejectedValueOnce(createConnectionError("ECONNRESET"))

      const promise = fetchWithProxy(
        "https://example.com",
        undefined,
        [proxy("http://proxy-1.local:8080"), proxy("http://proxy-2.local:8080")],
        1,
      )

      await expect(promise).rejects.toBeInstanceOf(ProxyExhaustedError)
      await expect(promise).rejects.toMatchObject({ accountIndex: 1, proxyCount: 2 })
      expect(proxyStates.get("1:http://proxy-1.local:8080")?.failCount).toBe(1)
      expect(proxyStates.get("1:http://proxy-2.local:8080")?.failCount).toBe(1)
    })

    it("throws ProxyExhaustedError when all enabled proxies are in cooldown", async () => {
      const firstProxy = "http://proxy-1.local:8080"
      const secondProxy = "http://proxy-2.local:8080"
      const now = new Date("2025-01-01T00:00:00.000Z").getTime()

      vi.useFakeTimers()
      vi.setSystemTime(now)
      proxyStates.set(`4:${firstProxy}`, {
        failCount: 1,
        lastFailTime: now,
        cooldownUntil: now + 5_000,
      })
      proxyStates.set(`4:${secondProxy}`, {
        failCount: 2,
        lastFailTime: now,
        cooldownUntil: now + 15_000,
      })

      const fetchMock = vi.spyOn(globalThis, "fetch")
      const promise = fetchWithProxy(
        "https://example.com",
        undefined,
        [proxy(firstProxy), proxy(secondProxy)],
        4,
      )

      await expect(promise).rejects.toMatchObject({
        name: "ProxyExhaustedError",
        accountIndex: 4,
        proxyCount: 2,
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("propagates AbortError without failover", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new DOMException("aborted", "AbortError"))

      const promise = fetchWithProxy(
        "https://example.com",
        undefined,
        [proxy("http://proxy-1.local:8080"), proxy("http://proxy-2.local:8080")],
      )

      await expect(promise).rejects.toMatchObject({ name: "AbortError" })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(proxyStates.size).toBe(0)
    })

    it("propagates TypeError without failover", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("invalid url"))

      const promise = fetchWithProxy(
        "https://example.com",
        undefined,
        [proxy("http://proxy-1.local:8080"), proxy("http://proxy-2.local:8080")],
      )

      await expect(promise).rejects.toBeInstanceOf(TypeError)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(proxyStates.size).toBe(0)
    })

    it("fails over on TypeError when cause has proxy error code", async () => {
      const firstProxy = "http://proxy-1.local:8080"
      const secondProxy = "http://proxy-2.local:8080"
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new TypeError("fetch failed", { cause: createConnectionError("ECONNREFUSED") }))
        .mockResolvedValueOnce(new Response("ok"))

      const response = await fetchWithProxy(
        "https://example.com",
        undefined,
        [proxy(firstProxy), proxy(secondProxy)],
        6,
      )

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(getDispatcherFromCall(fetchMock, 0).options?.uri).toBe(firstProxy)
      expect(getDispatcherFromCall(fetchMock, 1).options?.uri).toBe(secondProxy)
      expect(proxyStates.get(`6:${firstProxy}`)?.failCount).toBe(1)
      expect(proxyStates.get(`6:${secondProxy}`)).toBeUndefined()
    })
    it.each(["ENOTFOUND", "EAI_AGAIN"])("fails over on DNS error code %s in TypeError cause", async (code) => {
      const firstProxy = "http://proxy-1.local:8080"
      const secondProxy = "http://proxy-2.local:8080"
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new TypeError("fetch failed", { cause: createConnectionError(code) }))
        .mockResolvedValueOnce(new Response("ok"))

      const response = await fetchWithProxy(
        "https://example.com",
        undefined,
        [proxy(firstProxy), proxy(secondProxy)],
        8,
      )

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(getDispatcherFromCall(fetchMock, 0).options?.uri).toBe(firstProxy)
      expect(getDispatcherFromCall(fetchMock, 1).options?.uri).toBe(secondProxy)
      expect(proxyStates.get(`8:${firstProxy}`)?.failCount).toBe(1)
      expect(proxyStates.get(`8:${secondProxy}`)).toBeUndefined()
    })

    it("skips cooled-down proxies and uses next available proxy", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"))

      const firstProxy = "http://proxy-1.local:8080"
      const secondProxy = "http://proxy-2.local:8080"
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(createConnectionError("ECONNREFUSED"))
        .mockResolvedValueOnce(new Response("ok"))
        .mockResolvedValueOnce(new Response("ok-again"))

      await fetchWithProxy(
        "https://example.com",
        undefined,
        [proxy(firstProxy), proxy(secondProxy)],
        3,
      )

      await fetchWithProxy(
        "https://example.com/next",
        undefined,
        [proxy(firstProxy), proxy(secondProxy)],
        3,
      )

      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(getDispatcherFromCall(fetchMock, 0).options?.uri).toBe(firstProxy)
      expect(getDispatcherFromCall(fetchMock, 1).options?.uri).toBe(secondProxy)
      expect(getDispatcherFromCall(fetchMock, 2).options?.uri).toBe(secondProxy)

      const failedProxyState = proxyStates.get(`3:${firstProxy}`)
      expect(failedProxyState?.failCount).toBe(1)
      expect(failedProxyState?.cooldownUntil).toBe(Date.now() + 5_000)
    })

    it("resets a proxy failure state after successful request", async () => {
      const targetProxy = "http://proxy-1.local:8080"
      proxyStates.set(`0:${targetProxy}`, {
        failCount: 3,
        lastFailTime: 111,
        cooldownUntil: 0,
      })

      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
      await fetchWithProxy("https://example.com", undefined, [proxy(targetProxy)], 0)

      expect(proxyStates.get(`0:${targetProxy}`)).toBeUndefined()
    })
  })

  describe("integration scenarios", () => {
    it("isolates proxy health state between account indexes", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"))

      const sharedProxy = "http://shared.proxy.local:8080"
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(createConnectionError("ECONNRESET"))
        .mockResolvedValueOnce(new Response("ok"))

      await expect(
        fetchWithProxy("https://example.com/a", undefined, [proxy(sharedProxy)], 0),
      ).rejects.toBeInstanceOf(ProxyExhaustedError)

      const response = await fetchWithProxy(
        "https://example.com/b",
        undefined,
        [proxy(sharedProxy)],
        1,
      )

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(proxyStates.get(`0:${sharedProxy}`)?.failCount).toBe(1)
      expect(proxyStates.get(`1:${sharedProxy}`)).toBeUndefined()
    })

    it("keeps per-request proxy selection isolated", async () => {
      const accountIndex = 7
      const proxyA = "http://proxy-a.local:8080"
      const proxyB = "http://proxy-b.local:8080"
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("first"))
        .mockResolvedValueOnce(new Response("second"))

      await fetchWithProxy("https://example.com/one", undefined, [proxy(proxyA)], accountIndex)
      await fetchWithProxy("https://example.com/two", undefined, [proxy(proxyB)], accountIndex)

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(getDispatcherFromCall(fetchMock, 0).options?.uri).toBe(proxyA)
      expect(getDispatcherFromCall(fetchMock, 1).options?.uri).toBe(proxyB)
      expect(dispatcherCache.size).toBe(2)
      expect(proxyStates.size).toBe(0)
    })

    it("supports different proxy chains for multiple accounts", async () => {
      const account0Primary = "http://a0-primary.local:8080"
      const account0Secondary = "http://a0-secondary.local:8080"
      const account1Primary = "http://a1-primary.local:8080"

      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(createConnectionError("ECONNREFUSED"))
        .mockResolvedValueOnce(new Response("account0-ok"))
        .mockResolvedValueOnce(new Response("account1-ok"))

      await fetchWithProxy(
        "https://example.com/account-0",
        undefined,
        [proxy(account0Primary), proxy(account0Secondary)],
        0,
      )
      await fetchWithProxy(
        "https://example.com/account-1",
        undefined,
        [proxy(account1Primary)],
        1,
      )

      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(getDispatcherFromCall(fetchMock, 0).options?.uri).toBe(account0Primary)
      expect(getDispatcherFromCall(fetchMock, 1).options?.uri).toBe(account0Secondary)
      expect(getDispatcherFromCall(fetchMock, 2).options?.uri).toBe(account1Primary)
      expect(proxyStates.get(`0:${account0Primary}`)?.failCount).toBe(1)
      expect(proxyStates.get(`1:${account1Primary}`)).toBeUndefined()
    })
  })
})

describe("isProxyConnectionError", () => {
  it.each([
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_PRX_TLS",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EPIPE",
  ])("returns true for code %s", code => {
    expect(isProxyConnectionError(createConnectionError(code))).toBe(true)
  })

  it("returns false for AbortError", () => {
    expect(isProxyConnectionError(new DOMException("aborted", "AbortError"))).toBe(false)
  })

  it("returns false for TypeError", () => {
    expect(isProxyConnectionError(new TypeError("invalid url"))).toBe(false)
  })

  it("returns true for TypeError with proxy failure cause", () => {
    const error = new TypeError("fetch failed", { cause: createConnectionError("ECONNREFUSED") })
    expect(isProxyConnectionError(error)).toBe(true)
  })

  it.each([
    "Proxy authentication required",
    "Tunnel connection failed",
    "SOCKS handshake failed",
    "socket hang up",
    "connect ECONNREFUSED 127.0.0.1:8080",
  ])("uses message fallback for '%s'", message => {
    expect(isProxyConnectionError(new Error(message))).toBe(true)
  })

  it("returns false for unrelated Error messages", () => {
    expect(isProxyConnectionError(new Error("invalid JSON payload"))).toBe(false)
  })

  it("returns true for non-Error unknown values", () => {
    expect(isProxyConnectionError("proxy failed")).toBe(true)
  })
})

describe("cooldown progression", () => {
  it("returns expected durations for each failure tier", () => {
    expect(calculateCooldownMs(1)).toBe(5_000)
    expect(calculateCooldownMs(2)).toBe(15_000)
    expect(calculateCooldownMs(3)).toBe(60_000)
    expect(calculateCooldownMs(4)).toBe(300_000)
    expect(calculateCooldownMs(12)).toBe(300_000)
  })

  it("escalates cooldown durations across repeated failures and caps at 300s", async () => {
    vi.useFakeTimers()
    let now = new Date("2025-01-01T00:00:00.000Z").getTime()
    vi.setSystemTime(now)

    const targetProxy = "http://cooldown.proxy.local:8080"
    vi.spyOn(globalThis, "fetch").mockRejectedValue(createConnectionError("ECONNRESET"))

    await expect(
      fetchWithProxy("https://example.com/1", undefined, [proxy(targetProxy)], 9),
    ).rejects.toBeInstanceOf(ProxyExhaustedError)
    expect(proxyStates.get(`9:${targetProxy}`)?.cooldownUntil).toBe(now + 5_000)
    expect(proxyStates.get(`9:${targetProxy}`)?.failCount).toBe(1)

    now += 5_001
    vi.setSystemTime(now)
    await expect(
      fetchWithProxy("https://example.com/2", undefined, [proxy(targetProxy)], 9),
    ).rejects.toBeInstanceOf(ProxyExhaustedError)
    expect(proxyStates.get(`9:${targetProxy}`)?.cooldownUntil).toBe(now + 15_000)
    expect(proxyStates.get(`9:${targetProxy}`)?.failCount).toBe(2)

    now += 15_001
    vi.setSystemTime(now)
    await expect(
      fetchWithProxy("https://example.com/3", undefined, [proxy(targetProxy)], 9),
    ).rejects.toBeInstanceOf(ProxyExhaustedError)
    expect(proxyStates.get(`9:${targetProxy}`)?.cooldownUntil).toBe(now + 60_000)
    expect(proxyStates.get(`9:${targetProxy}`)?.failCount).toBe(3)

    now += 60_001
    vi.setSystemTime(now)
    await expect(
      fetchWithProxy("https://example.com/4", undefined, [proxy(targetProxy)], 9),
    ).rejects.toBeInstanceOf(ProxyExhaustedError)
    expect(proxyStates.get(`9:${targetProxy}`)?.cooldownUntil).toBe(now + 300_000)
    expect(proxyStates.get(`9:${targetProxy}`)?.failCount).toBe(4)

    now += 300_001
    vi.setSystemTime(now)
    await expect(
      fetchWithProxy("https://example.com/5", undefined, [proxy(targetProxy)], 9),
    ).rejects.toBeInstanceOf(ProxyExhaustedError)
    expect(proxyStates.get(`9:${targetProxy}`)?.cooldownUntil).toBe(now + 300_000)
    expect(proxyStates.get(`9:${targetProxy}`)?.failCount).toBe(5)
  })
})

describe("redactUrl", () => {
  it("redacts username and password credentials", () => {
    expect(redactUrl("http://alice:s3cr3t@proxy.local:8080")).toBe("http://***:***@proxy.local:8080/")
  })

  it("preserves URLs without credentials", () => {
    expect(redactUrl("http://proxy.local:8080")).toBe("http://proxy.local:8080/")
  })

  it("handles invalid URLs gracefully", () => {
    expect(redactUrl("not a url")).toBe("[invalid-url]")
  })
})

describe("dispatcher factory", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    resetProxyState()
  })

  it("uses ProxyAgent for HTTP and HTTPS proxy URLs", async () => {
    const httpProxy = "http://http-proxy.local:8080"
    const httpsProxy = "https://https-proxy.local:8443"
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("http"))
      .mockResolvedValueOnce(new Response("https"))

    await fetchWithProxy("https://example.com/http", undefined, [proxy(httpProxy)], 0)
    await fetchWithProxy("https://example.com/https", undefined, [proxy(httpsProxy)], 0)

    expect(proxyAgentCtor).toHaveBeenCalledTimes(2)
    expect(proxyAgentCtor).toHaveBeenNthCalledWith(1, { uri: httpProxy })
    expect(proxyAgentCtor).toHaveBeenNthCalledWith(2, { uri: httpsProxy })
    expect(socksDispatcherFactory).not.toHaveBeenCalled()
  })

  it("uses socksDispatcher for SOCKS proxies with decoded credentials", async () => {
    const socksProxy = "socks5://user%20name:p%40ss@socks.local:1234"
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))

    await fetchWithProxy("https://example.com", undefined, [proxy(socksProxy)], 0)

    expect(socksDispatcherFactory).toHaveBeenCalledTimes(1)
    expect(socksDispatcherFactory).toHaveBeenCalledWith({
      type: 5,
      host: "socks.local",
      port: 1234,
      userId: "user name",
      password: "p@ss",
    })

    const dispatcher = getDispatcherFromCall(fetchMock, 0)
    expect(dispatcher.kind).toBe("socks-dispatcher")
  })

  it("uses SOCKS4 defaults when port is omitted", async () => {
    const socksProxy = "socks4a://legacy-socks.local"
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))

    await fetchWithProxy("https://example.com", undefined, [proxy(socksProxy)], 0)

    expect(socksDispatcherFactory).toHaveBeenCalledTimes(1)
    expect(socksDispatcherFactory).toHaveBeenCalledWith({
      type: 4,
      host: "legacy-socks.local",
      port: 1080,
      userId: undefined,
      password: undefined,
    })
  })

  it("caches dispatchers by proxy URL", async () => {
    const proxyUrl = "http://cached-proxy.local:8080"
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("first"))
      .mockResolvedValueOnce(new Response("second"))

    await fetchWithProxy("https://example.com/one", undefined, [proxy(proxyUrl)], 0)
    await fetchWithProxy("https://example.com/two", undefined, [proxy(proxyUrl)], 0)

    expect(proxyAgentCtor).toHaveBeenCalledTimes(1)
    expect(dispatcherCache.size).toBe(1)
    expect(getDispatcherFromCall(fetchMock, 0)).toBe(getDispatcherFromCall(fetchMock, 1))
  })
})

