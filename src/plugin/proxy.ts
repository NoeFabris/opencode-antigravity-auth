import { ProxyAgent } from "undici"
import type { Dispatcher } from "undici"
import { socksDispatcher } from "fetch-socks"
import type { ProxyConfig } from "./storage"
import { createLogger } from "./logger"

const log = createLogger("proxy")

interface ProxiedRequestInit extends RequestInit {
  dispatcher?: Dispatcher
}

interface ProxyRuntimeState {
  failCount: number
  lastFailTime: number
  cooldownUntil: number
}

export class ProxyExhaustedError extends Error {
  readonly proxyCount: number
  readonly accountIndex: number

  constructor(accountIndex: number, proxyCount: number) {
    super(
      proxyCount > 0
        ? (
          `All ${proxyCount} proxy(ies) failed for account ${accountIndex}. ` +
          `Check proxy connectivity or remove failing proxies.`
        )
        : `No enabled proxies configured for account ${accountIndex}. Refusing direct connection to prevent IP leakage.`
    )
    this.name = "ProxyExhaustedError"
    this.proxyCount = proxyCount
    this.accountIndex = accountIndex
  }
}

const PROXY_COOLDOWN_PROGRESSION_MS = [5_000, 15_000, 60_000, 300_000] as const
const PROXY_ERROR_CODES = [
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_PRX_TLS",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
] as const

const dispatcherCache = new Map<string, Dispatcher>()
const proxyStates = new Map<string, ProxyRuntimeState>()

function stateKey(accountIndex: number, proxyUrl: string): string {
  return `${accountIndex}:${proxyUrl}`
}

function calculateCooldownMs(failCount: number): number {
  const idx = Math.min(failCount - 1, PROXY_COOLDOWN_PROGRESSION_MS.length - 1)
  return PROXY_COOLDOWN_PROGRESSION_MS[idx] ?? 300_000
}

function getOrCreateDispatcher(proxyUrl: string): Dispatcher {
  const cached = dispatcherCache.get(proxyUrl)
  if (cached) return cached

  const url = new URL(proxyUrl)
  const protocol = url.protocol.replace(":", "")
  let dispatcher: Dispatcher

  if (protocol === "socks5" || protocol === "socks4" ||
      protocol === "socks5h" || protocol === "socks4a") {
    dispatcher = socksDispatcher({
      type: protocol.startsWith("socks5") ? 5 : 4,
      host: url.hostname,
      port: parseInt(url.port, 10) || 1080,
      userId: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
    })
  } else {
    dispatcher = new ProxyAgent({ uri: proxyUrl })
  }

  dispatcherCache.set(proxyUrl, dispatcher)
  return dispatcher
}

function isAvailable(accountIndex: number, proxy: ProxyConfig): boolean {
  if (proxy.enabled === false) return false
  const state = proxyStates.get(stateKey(accountIndex, proxy.url))
  if (!state) return true
  return Date.now() >= state.cooldownUntil
}

function markFailed(accountIndex: number, proxy: ProxyConfig): void {
  const key = stateKey(accountIndex, proxy.url)
  const existing = proxyStates.get(key)
  const failCount = (existing?.failCount ?? 0) + 1
  const now = Date.now()
  proxyStates.set(key, {
    failCount,
    lastFailTime: now,
    cooldownUntil: now + calculateCooldownMs(failCount),
  })
  log.warn("Proxy marked failed", {
    proxy: redactUrl(proxy.url),
    failCount,
    cooldownMs: calculateCooldownMs(failCount),
  })
}

function markSuccess(accountIndex: number, proxy: ProxyConfig): void {
  proxyStates.delete(stateKey(accountIndex, proxy.url))
}

function getErrorChain(error: Error): unknown[] {
  const chain: unknown[] = [error]
  let cursor: unknown = error
  let depth = 0

  while (depth < 4 && cursor && typeof cursor === "object") {
    const cause = (cursor as { cause?: unknown }).cause
    if (!cause) {
      break
    }
    chain.push(cause)
    cursor = cause
    depth += 1
  }

  return chain
}

function getErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const code = (value as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function getErrorName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const name = (value as { name?: unknown }).name
  return typeof name === "string" ? name : undefined
}

function getErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object") return ""
  const message = (value as { message?: unknown }).message
  return typeof message === "string" ? message.toLowerCase() : ""
}

function hasProxyErrorMessage(message: string): boolean {
  return (
    message.includes("proxy") ||
    message.includes("tunnel") ||
    message.includes("socks") ||
    message.includes("socket hang up") ||
    message.includes("connect econnrefused")
  )
}

function isProxyConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return true

  for (const entry of getErrorChain(error)) {
    const name = getErrorName(entry)
    if (name === "AbortError") {
      return false
    }

    const code = getErrorCode(entry)
    if (code && PROXY_ERROR_CODES.includes(code as (typeof PROXY_ERROR_CODES)[number])) {
      return true
    }

    const message = getErrorMessage(entry)
    if (hasProxyErrorMessage(message)) {
      return true
    }
  }

  if (error instanceof TypeError) {
    return false
  }

  return false
}

export { isProxyConnectionError as isProxyError }

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username) parsed.username = "***"
    if (parsed.password) parsed.password = "***"
    return parsed.toString()
  } catch {
    return "[invalid-url]"
  }
}

export async function fetchWithProxy(
  input: RequestInfo | URL,
  init?: RequestInit,
  proxies?: ProxyConfig[],
  accountIndex?: number,
): Promise<Response> {
  if (!proxies || proxies.length === 0) {
    return fetch(input, init)
  }

  const acctIdx = accountIndex ?? 0
  const enabledCount = proxies.filter(p => p.enabled !== false).length
  if (enabledCount === 0) {
    throw new ProxyExhaustedError(acctIdx, 0)
  }

  const available = proxies.filter(p => isAvailable(acctIdx, p))
  if (available.length === 0) {
    throw new ProxyExhaustedError(acctIdx, enabledCount)
  }

  for (const proxy of available) {
    try {
      const dispatcher = getOrCreateDispatcher(proxy.url)
      const proxiedInit: ProxiedRequestInit = { ...init, dispatcher }

      log.debug("Fetching via proxy", {
        proxy: redactUrl(proxy.url),
        accountIndex: acctIdx,
      })

      const response = await fetch(input, proxiedInit as RequestInit)
      markSuccess(acctIdx, proxy)
      return response
    } catch (error) {
      if (!isProxyConnectionError(error)) {
        throw error
      }

      markFailed(acctIdx, proxy)
    }
  }

  throw new ProxyExhaustedError(acctIdx, available.length)
}

export function resetProxyState(): void {
  proxyStates.clear()
  dispatcherCache.clear()
}

export const __testExports = {
  isProxyConnectionError,
  calculateCooldownMs,
  redactUrl,
  proxyStates,
  dispatcherCache,
}

