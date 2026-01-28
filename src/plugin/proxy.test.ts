import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { getProxyAgent, fetchWithProxy } from './proxy';

vi.mock('undici', () => {
  const ProxyAgentMock = vi.fn().mockImplementation((options) => ({
    uri: options.uri,
    options,
  }));
  return {
    ProxyAgent: ProxyAgentMock,
    fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as Response),
  };
});

describe('proxy.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // We can't easily clear the internal agentCache Map in proxy.ts 
    // because it's not exported. But we can test around it or 
    // use different URLs for different tests.
  });

  describe('getProxyAgent', () => {
    it('returns undefined when proxyUrl is empty or undefined', () => {
      expect(getProxyAgent()).toBeUndefined();
      expect(getProxyAgent('')).toBeUndefined();
      expect(getProxyAgent('   ')).toBeUndefined();
    });

    it('returns a ProxyAgent instance for a valid URL', () => {
      const proxyUrl = 'http://proxy.example.com:8080';
      const agent = getProxyAgent(proxyUrl);
      
      expect(agent).toBeDefined();
      expect(ProxyAgent).toHaveBeenCalledWith(expect.objectContaining({
        uri: proxyUrl,
        connect: { timeout: 30000 }
      }));
    });

    it('throws an error with sanitized credentials for a malformed URL', () => {
      const malformedUrlWithCreds = 'http://user:pass@malformed-url';
      // URL constructor will throw for things like 'not a url'
      // But 'http://user:pass@malformed-url' might actually be valid for URL.
      // Let's try something definitely invalid.
      const invalidUrl = 'http://user:pass@:invalid';
      
      expect(() => getProxyAgent(invalidUrl)).toThrow('Invalid proxy URL format: http://***:***@:invalid');
    });

    it('caches the ProxyAgent instance for the same URL', () => {
      const proxyUrl = 'http://cache.example.com';
      const agent1 = getProxyAgent(proxyUrl);
      const agent2 = getProxyAgent(proxyUrl);
      
      expect(agent1).toBe(agent2);
      expect(ProxyAgent).toHaveBeenCalledTimes(1);
    });

    it('returns different instances for different URLs', () => {
      const proxyUrl1 = 'http://proxy1.example.com';
      const proxyUrl2 = 'http://proxy2.example.com';
      
      const agent1 = getProxyAgent(proxyUrl1);
      const agent2 = getProxyAgent(proxyUrl2);
      
      expect(agent1).not.toBe(agent2);
      expect(ProxyAgent).toHaveBeenCalledTimes(2);
    });

    it('throws error when ProxyAgent creation fails', () => {
      // Setup ProxyAgent to throw once
      (ProxyAgent as any).mockImplementationOnce(() => {
        throw new Error('Creation failed');
      });
      
      const proxyUrl = 'http://fail.example.com';
      expect(() => getProxyAgent(proxyUrl)).toThrow('Failed to create proxy agent for http://fail.example.com: Creation failed');
    });

    it('sanitizes credentials when ProxyAgent creation fails', () => {
      (ProxyAgent as any).mockImplementationOnce(() => {
        throw new Error('Access denied');
      });
      
      const proxyUrl = 'http://user:pass@fail.example.com';
      expect(() => getProxyAgent(proxyUrl)).toThrow('Failed to create proxy agent for http://***:***@fail.example.com: Access denied');
    });
  });

  describe('fetchWithProxy', () => {
    it('uses global fetch when no proxy is provided', async () => {
      const globalFetch = vi.fn().mockResolvedValue({ ok: true } as Response);
      vi.stubGlobal('fetch', globalFetch);

      await fetchWithProxy('https://api.example.com');

      expect(globalFetch).toHaveBeenCalledWith('https://api.example.com', undefined);
      expect(undiciFetch).not.toHaveBeenCalled();
    });

    it('uses undici fetch with ProxyAgent when proxy is provided', async () => {
      const proxyUrl = 'http://proxy.example.com';
      const targetUrl = 'https://api.example.com';
      
      await fetchWithProxy(targetUrl, { method: 'POST' }, proxyUrl);

      expect(undiciFetch).toHaveBeenCalledWith(targetUrl, expect.objectContaining({
        method: 'POST',
        dispatcher: expect.any(Object)
      }));
    });
  });
});
