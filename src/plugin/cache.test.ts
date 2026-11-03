import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireDiskSignatureCache,
  getDiskSignatureCache,
  resolveCachedAuth,
  storeCachedAuth,
  clearCachedAuth,
  cacheSignature,
  getCachedSignature,
  clearSignatureCache,
} from "./cache";
import type { OAuthAuthDetails } from "./types";

function createAuth(overrides: Partial<OAuthAuthDetails> = {}): OAuthAuthDetails {
  return {
    type: "oauth",
    refresh: "refresh-token|project-id",
    access: "access-token",
    expires: Date.now() + 3600000,
    ...overrides,
  };
}

describe("Auth Cache", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearCachedAuth();
  });

  afterEach(() => {
    clearCachedAuth();
  });

  describe("resolveCachedAuth", () => {
    it("returns input auth when no cache exists and caches it", () => {
      const auth = createAuth();
      const result = resolveCachedAuth(auth);
      expect(result).toEqual(auth);
    });

    it("returns input auth when refresh key is empty", () => {
      const auth = createAuth({ refresh: "" });
      const result = resolveCachedAuth(auth);
      expect(result).toEqual(auth);
    });

    it("returns input auth when it has valid (unexpired) access token", () => {
      const oldAuth = createAuth({ access: "old-access", expires: Date.now() + 3600000 });
      resolveCachedAuth(oldAuth); // cache it

      const newAuth = createAuth({ access: "new-access", expires: Date.now() + 7200000 });
      const result = resolveCachedAuth(newAuth);
      expect(result.access).toBe("new-access");
    });

    it("returns cached auth when input auth is expired but cached is valid", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));

      const validAuth = createAuth({
        access: "valid-access",
        expires: 3600000, // expires at t=3600000
      });
      resolveCachedAuth(validAuth); // cache it

      // Now create an expired auth with the same refresh token
      const expiredAuth = createAuth({
        access: "expired-access",
        expires: 30000, // expires within buffer (60s)
      });

      const result = resolveCachedAuth(expiredAuth);
      expect(result.access).toBe("valid-access");
    });

    it("returns input auth when both are expired (updates cache)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));

      const expiredCached = createAuth({
        access: "cached-expired",
        expires: 30000, // expired within buffer
      });
      resolveCachedAuth(expiredCached);

      const expiredNew = createAuth({
        access: "new-expired",
        expires: 20000, // also expired within buffer
      });

      const result = resolveCachedAuth(expiredNew);
      expect(result.access).toBe("new-expired");
    });
  });

  describe("storeCachedAuth", () => {
    it("stores auth in cache", () => {
      const auth = createAuth({ access: "stored-access" });
      storeCachedAuth(auth);

      const expiredAuth = createAuth({ access: "expired", expires: Date.now() - 1000 });
      const result = resolveCachedAuth(expiredAuth);
      expect(result.access).toBe("stored-access");
    });

    it("does nothing when refresh key is empty", () => {
      const auth = createAuth({ refresh: "", access: "no-key-access" });
      storeCachedAuth(auth);

      // Should not be retrievable since key was empty
      const testAuth = createAuth({ refresh: "", access: "test" });
      const result = resolveCachedAuth(testAuth);
      expect(result.access).toBe("test"); // returns the input, not cached
    });

    it("does nothing when refresh key is whitespace only", () => {
      const auth = createAuth({ refresh: "   ", access: "whitespace-access" });
      storeCachedAuth(auth);

      const testAuth = createAuth({ refresh: "   ", access: "test" });
      const result = resolveCachedAuth(testAuth);
      expect(result.access).toBe("test");
    });
  });

  describe("clearCachedAuth", () => {
    it("clears all cache when no argument provided", () => {
      storeCachedAuth(createAuth({ refresh: "token1|p", access: "access1" }));
      storeCachedAuth(createAuth({ refresh: "token2|p", access: "access2" }));

      clearCachedAuth();

      const auth1 = createAuth({ refresh: "token1|p", access: "new1" });
      const auth2 = createAuth({ refresh: "token2|p", access: "new2" });

      expect(resolveCachedAuth(auth1).access).toBe("new1");
      expect(resolveCachedAuth(auth2).access).toBe("new2");
    });

    it("clears specific refresh token from cache", () => {
      storeCachedAuth(createAuth({ refresh: "token1|p", access: "access1" }));
      storeCachedAuth(createAuth({ refresh: "token2|p", access: "access2" }));

      clearCachedAuth("token1|p");

      // token1 should be cleared
      const expiredAuth1 = createAuth({ refresh: "token1|p", access: "new1", expires: Date.now() - 1000 });
      expect(resolveCachedAuth(expiredAuth1).access).toBe("new1");

      // token2 should still be cached
      const expiredAuth2 = createAuth({ refresh: "token2|p", access: "new2", expires: Date.now() - 1000 });
      expect(resolveCachedAuth(expiredAuth2).access).toBe("access2");
    });
  });
});

describe("Signature Cache", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearSignatureCache();
  });

  afterEach(() => {
    clearSignatureCache();
  });

  describe("cacheSignature", () => {
    it("caches a signature for session and text", () => {
      cacheSignature("session1", "thinking text", "sig123");
      const result = getCachedSignature("session1", "thinking text");
      expect(result).toBe("sig123");
    });

    it("does nothing when sessionId is empty", () => {
      cacheSignature("", "text", "sig");
      expect(getCachedSignature("", "text")).toBeUndefined();
    });

    it("does nothing when text is empty", () => {
      cacheSignature("session", "", "sig");
      expect(getCachedSignature("session", "")).toBeUndefined();
    });

    it("does nothing when signature is empty", () => {
      cacheSignature("session", "text", "");
      expect(getCachedSignature("session", "text")).toBeUndefined();
    });

    it("stores multiple signatures per session", () => {
      cacheSignature("session1", "text1", "sig1");
      cacheSignature("session1", "text2", "sig2");

      expect(getCachedSignature("session1", "text1")).toBe("sig1");
      expect(getCachedSignature("session1", "text2")).toBe("sig2");
    });

    it("stores signatures for different sessions independently", () => {
      cacheSignature("session1", "text", "sig1");
      cacheSignature("session2", "text", "sig2");

      expect(getCachedSignature("session1", "text")).toBe("sig1");
      expect(getCachedSignature("session2", "text")).toBe("sig2");
    });
  });

  describe("getCachedSignature", () => {
    it("returns undefined when session not found", () => {
      expect(getCachedSignature("unknown", "text")).toBeUndefined();
    });

    it("returns undefined when text not found in session", () => {
      cacheSignature("session", "known-text", "sig");
      expect(getCachedSignature("session", "unknown-text")).toBeUndefined();
    });

    it("returns undefined when sessionId is empty", () => {
      expect(getCachedSignature("", "text")).toBeUndefined();
    });

    it("returns undefined when text is empty", () => {
      expect(getCachedSignature("session", "")).toBeUndefined();
    });

    it("returns undefined when signature is expired", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));

      cacheSignature("session", "text", "sig");

      // Advance time past TTL (1 hour = 3600000ms)
      vi.setSystemTime(new Date(3600001));

      expect(getCachedSignature("session", "text")).toBeUndefined();
    });

    it("returns signature when not expired", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));

      cacheSignature("session", "text", "sig");

      // Advance time but stay within TTL
      vi.setSystemTime(new Date(3599999));

      expect(getCachedSignature("session", "text")).toBe("sig");
    });
  });

  describe("clearSignatureCache", () => {
    it("clears all signature cache when no argument provided", () => {
      cacheSignature("session1", "text", "sig1");
      cacheSignature("session2", "text", "sig2");

      clearSignatureCache();

      expect(getCachedSignature("session1", "text")).toBeUndefined();
      expect(getCachedSignature("session2", "text")).toBeUndefined();
    });

    it("clears specific session from cache", () => {
      cacheSignature("session1", "text", "sig1");
      cacheSignature("session2", "text", "sig2");

      clearSignatureCache("session1");

      expect(getCachedSignature("session1", "text")).toBeUndefined();
      expect(getCachedSignature("session2", "text")).toBe("sig2");
    });
  });

  describe("cache eviction", () => {
    it("evicts entries when at capacity", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));

      // Fill cache with 100 entries (MAX_ENTRIES_PER_SESSION)
      for (let i = 0; i < 100; i++) {
        vi.setSystemTime(new Date(i * 1000)); // stagger timestamps
        cacheSignature("session", `text-${i}`, `sig-${i}`);
      }

      // Reset time to check entries
      vi.setSystemTime(new Date(100 * 1000));

      // Adding one more should trigger eviction
      cacheSignature("session", "new-text", "new-sig");

      // New entry should exist
      expect(getCachedSignature("session", "new-text")).toBe("new-sig");

      // Some old entries should have been evicted (oldest 25%)
      // Entry at index 0 (timestamp 0) should be evicted
      expect(getCachedSignature("session", "text-0")).toBeUndefined();
    });
  });
});


describe("shared disk signature cache lifecycle", () => {
  it("stops shared timers only after the final plugin releases the cache", () => {
    vi.useFakeTimers()
    vi.stubEnv("XDG_DATA_HOME", "/tmp/antigravity-signature-cache-lifecycle-test")
    const config = { enabled: true, memory_ttl_seconds: 3600, disk_ttl_seconds: 86400, write_interval_seconds: 30 }
    const initialTimers = vi.getTimerCount()
    const first = acquireDiskSignatureCache(config)
    const cache = getDiskSignatureCache()
    const second = acquireDiskSignatureCache(config)
    try {
      expect(vi.getTimerCount()).toBe(initialTimers + 2)
      first()
      first()
      expect(getDiskSignatureCache()).toBe(cache)
      expect(vi.getTimerCount()).toBe(initialTimers + 2)
      second()
      expect(getDiskSignatureCache()).toBeNull()
      expect(vi.getTimerCount()).toBe(initialTimers)
    } finally {
      first()
      second()
      vi.unstubAllEnvs()
      vi.useRealTimers()
    }
  })
})
