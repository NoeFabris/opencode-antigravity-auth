import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccountManager, type ModelFamily, type HeaderStyle } from "./accounts";
import type { AccountStorageV4 } from "./storage";

/**
 * Test: Antigravity-first fallback logic
 * 
 * Requirement: Exhaust Antigravity across ALL accounts before falling back to Gemini CLI
 * 
 * Scenario:
 * - Account 0: antigravity rate-limited, gemini-cli available
 * - Account 1: antigravity available
 * 
 * Expected: Switch to Account 1 (use antigravity), NOT fall back to gemini-cli on Account 0
 */
describe("Antigravity-first fallback", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe("hasOtherAccountWithAntigravityAvailable", () => {
    it("returns true when another account has antigravity available", () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const accounts = manager.getAccounts();
      
      // Mark account 0's antigravity as rate-limited
      manager.markRateLimited(accounts[0]!, 60000, "gemini", "antigravity");

      // Account 1 should have antigravity available
      const hasOther = manager.hasOtherAccountWithAntigravityAvailable(
        accounts[0]!.index,
        "gemini",
        null
      );

      expect(hasOther).toBe(true);
    });

    it("returns false when all other accounts are also rate-limited for antigravity", () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const accounts = manager.getAccounts();
      
      // Mark both accounts' antigravity as rate-limited
      manager.markRateLimited(accounts[0]!, 60000, "gemini", "antigravity");
      manager.markRateLimited(accounts[1]!, 60000, "gemini", "antigravity");

      const hasOther = manager.hasOtherAccountWithAntigravityAvailable(
        accounts[0]!.index,
        "gemini",
        null
      );

      expect(hasOther).toBe(false);
    });

    it("skips disabled accounts", () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0, enabled: false },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const accounts = manager.getAccounts();
      
      // Mark account 0's antigravity as rate-limited
      manager.markRateLimited(accounts[0]!, 60000, "gemini", "antigravity");

      // Account 1 is disabled, so should return false
      const hasOther = manager.hasOtherAccountWithAntigravityAvailable(
        accounts[0]!.index,
        "gemini",
        null
      );

      expect(hasOther).toBe(false);
    });

    it("skips cooling down accounts", () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const accounts = manager.getAccounts();
      
      // Mark account 0's antigravity as rate-limited
      manager.markRateLimited(accounts[0]!, 60000, "gemini", "antigravity");
      // Mark account 1 as cooling down
      manager.markAccountCoolingDown(accounts[1]!, 60000, "auth-failure");

      const hasOther = manager.hasOtherAccountWithAntigravityAvailable(
        accounts[0]!.index,
        "gemini",
        null
      );

      expect(hasOther).toBe(false);
    });

    it("works with model-specific rate limits", () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const accounts = manager.getAccounts();
      
      // Mark account 0's antigravity as rate-limited for gemini-3-pro
      manager.markRateLimited(accounts[0]!, 60000, "gemini", "antigravity", "gemini-3-pro");

      // Account 1 should have antigravity available for gemini-3-pro
      const hasOther = manager.hasOtherAccountWithAntigravityAvailable(
        accounts[0]!.index,
        "gemini",
        "gemini-3-pro"
      );

      expect(hasOther).toBe(true);
    });

    it("returns false for Claude family (no gemini-cli fallback)", () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);

      // For Claude, this method should always return false
      // (Claude has no gemini-cli fallback, only antigravity)
      const hasOther = manager.hasOtherAccountWithAntigravityAvailable(
        0,
        "claude",
        null
      );

      expect(hasOther).toBe(false);
    });
  });

  describe("Pre-check fallback logic", () => {
    it("should switch to account with antigravity rather than fall back to gemini-cli", () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      };

      const manager = new AccountManager(undefined, stored);
      const accounts = manager.getAccounts();
      
      // Account 0's antigravity is rate-limited but gemini-cli is available
      manager.markRateLimited(accounts[0]!, 60000, "gemini", "antigravity");
      
      // Account 1's antigravity is available
      // (not rate-limited for antigravity)

      // When requesting with antigravity headerStyle:
      // Should switch to account 1 (which has antigravity), NOT fall back to gemini-cli
      
      const nextAccount = manager.getCurrentOrNextForFamily(
        "gemini",
        null,
        "sticky",
        "antigravity"
      );

      expect(nextAccount?.index).toBe(1);
      expect(manager.isRateLimitedForHeaderStyle(nextAccount!, "gemini", "antigravity")).toBe(false);
    });

    it("should only fall back to gemini-cli when ALL accounts exhausted antigravity", () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      };

      const manager = new AccountManager(undefined, stored);
      const accounts = manager.getAccounts();
      
      // Both accounts' antigravity are rate-limited
      manager.markRateLimited(accounts[0]!, 60000, "gemini", "antigravity");
      manager.markRateLimited(accounts[1]!, 60000, "gemini", "antigravity");

      // Verify no account has antigravity available
      expect(manager.hasOtherAccountWithAntigravityAvailable(0, "gemini", null)).toBe(false);
      expect(manager.hasOtherAccountWithAntigravityAvailable(1, "gemini", null)).toBe(false);

      // Account 0's gemini-cli should still be available for fallback
      expect(manager.isRateLimitedForHeaderStyle(accounts[0]!, "gemini", "gemini-cli")).toBe(false);
      expect(manager.getAvailableHeaderStyle(accounts[0]!, "gemini")).toBe("gemini-cli");
    });
  });
});
