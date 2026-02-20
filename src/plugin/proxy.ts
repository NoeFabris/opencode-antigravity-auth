import { ProxyAgent } from 'undici';

const MAX_AGENT_CACHE_SIZE = 50; // Prevent unbounded growth
const agentCache = new Map<string, ProxyAgent>();
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

function sanitizeCredentials(url: string): string {
  return url.replace(/:\/\/[^@]+@/, '://***:***@');
}

/**
 * Dispose a proxy agent and remove it from cache.
 * Call this when an account is removed or its proxy URL changes.
 */
export function disposeProxyAgent(proxyUrl: string): void {
  const normalizedUrl = proxyUrl.trim();
  const agent = agentCache.get(normalizedUrl);
  if (agent) {
    agent.close().catch(() => {});
    agentCache.delete(normalizedUrl);
  }
}

/**
 * Clear oldest entries if cache exceeds max size (LRU eviction).
 */
function evictOldestIfNeeded(): void {
  if (agentCache.size <= MAX_AGENT_CACHE_SIZE) return;
  
  const entriesToDelete = agentCache.size - MAX_AGENT_CACHE_SIZE;
  const keys = Array.from(agentCache.keys());
  for (let i = 0; i < entriesToDelete; i++) {
    const key = keys[i];
    if (key) {
      const agent = agentCache.get(key);
      agent?.close().catch(() => {});
      agentCache.delete(key);
    }
  }
}

export function getProxyAgent(proxyUrl?: string): ProxyAgent | undefined {
  if (!proxyUrl?.trim()) return undefined;
  
  const normalizedUrl = proxyUrl.trim();

  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw new Error(`Invalid proxy URL format: ${sanitizeCredentials(normalizedUrl)}`);
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Unsupported proxy protocol: ${parsed.protocol} (only http: and https: supported)`);
  }

  let agent = agentCache.get(normalizedUrl);
  
  if (!agent) {
    try {
      agent = new ProxyAgent({
        uri: normalizedUrl,
        connect: { timeout: 30000 },
      });
      agentCache.set(normalizedUrl, agent);
      evictOldestIfNeeded();
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create proxy agent for ${sanitizeCredentials(normalizedUrl)}: ${sanitizeCredentials(rawMessage)}`);
    }
  }
  
  return agent;
}

export async function fetchWithProxy(
  input: string | URL,
  init?: RequestInit,
  proxyUrl?: string,
): Promise<Response> {
  const agent = getProxyAgent(proxyUrl);
  
  if (!agent) {
    return fetch(input, init);
  }
  
  const { fetch: undiciFetch } = await import('undici');
  
  const url = typeof input === 'string' ? input : input.href;
  
  // @ts-ignore - undici.fetch dispatcher property not in standard RequestInit
  return undiciFetch(url, { ...init, dispatcher: agent }) as unknown as Promise<Response>;
}
