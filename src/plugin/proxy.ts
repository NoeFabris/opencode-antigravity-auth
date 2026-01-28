import { ProxyAgent } from 'undici';

const agentCache = new Map<string, ProxyAgent>();
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

function sanitizeCredentials(url: string): string {
  return url.replace(/:\/\/[^@]+@/, '://***:***@');
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
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create proxy agent for ${sanitizeCredentials(normalizedUrl)}: ${sanitizeCredentials(rawMessage)}`);
    }
  }
  
  return agent;
}

export async function fetchWithProxy(
  input: RequestInfo | URL,
  init?: RequestInit,
  proxyUrl?: string,
): Promise<Response> {
  const agent = getProxyAgent(proxyUrl);
  
  if (!agent) {
    return fetch(input, init);
  }
  
  const { fetch: undiciFetch } = await import('undici');
  
  const url = typeof input === 'string' 
    ? input 
    : input instanceof URL 
      ? input.href 
      : input.url;
  
  // @ts-ignore - undici.fetch dispatcher property not in standard RequestInit
  return undiciFetch(url, { ...init, dispatcher: agent }) as unknown as Promise<Response>;
}
