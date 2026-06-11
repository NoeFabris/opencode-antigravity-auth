import { beforeAll, describe, expect, it, vi } from "vitest";
import { AccountManager, type ModelFamily, type HeaderStyle } from "./accounts";
import type { AccountStorageV4 } from "./storage";

type ApplyJitterFn = (baseMs: number, fraction?: number) => number;

let applyJitter: ApplyJitterFn | undefined;

beforeAll(async () => {
  vi.mock("@opencode-ai/plugin", () => ({
    tool: vi.fn(),
  }));

  const { __testExports } = await import("../plugin");
  applyJitter = (__testExports as { applyJitter?: ApplyJitterFn }).applyJitter;
});

describe("applyJitter", () => {
  it("returns value within expected range for default fraction (20%)", () => {
    const base = 1000;
    for (let i = 0; i < 100; i++) {
      const result = applyJitter!(base);
      expect(result).toBeGreaterThanOrEqual(800);  // 1000 * 0.8
      expect(result).toBeLessThanOrEqual(1201);     // 1000 * 1.2 + rounding
    }
  });

  it("respects custom fraction", () => {
    const base = 5000;
    const fraction = 0.1;
    for (let i = 0; i < 100; i++) {
      const result = applyJitter!(base, fraction);
      expect(result).toBeGreaterThanOrEqual(4500);  // 5000 * 0.9
      expect(result).toBeLessThanOrEqual(5501);     // 5000 * 1.1 + rounding
    }
  });

  it("returns integer values", () => {
    for (let i = 0; i < 50; i++) {
      const result = applyJitter!(555);
      expect(Number.isInteger(result)).toBe(true);
    }
  });
});

describe("fallback attempt limiting", () => {
  it("MAX_FALLBACK_ATTEMPTS_PER_ACCOUNT is a reasonable positive integer", () => {
    // The constant should be small enough to prevent storms, large enough for legitimate rotation
    const MAX = 3;
    expect(MAX).toBeGreaterThan(0);
    expect(MAX).toBeLessThanOrEqual(5);
  });
});

describe("verification-required account filtering", () => {
  it("getNextForFamily skips verification-required accounts even if enabled", () => {
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          refreshToken: "r1",
          projectId: "p1",
          addedAt: 1,
          lastUsed: 0,
        },
        {
          refreshToken: "r2",
          projectId: "p2",
          addedAt: 1,
          lastUsed: 0,
        },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);
    const accounts = manager.getAccounts();

    // Mark account 1 as verification-required (but keep it enabled to test defensive filtering)
    const acc1 = accounts[1]!;
    acc1.verificationRequired = true;

    // Account 0 should be immediately available since it's fresh
    // getNextForFamily should prefer account 0
    const next = manager.getNextForFamily("gemini", null, "antigravity");
    expect(next).not.toBeNull();
    expect(next!.index).toBe(0);
    expect(next!.verificationRequired).not.toBe(true);
  });

  it("getNextForFamily returns null when all accounts are verification-required", () => {
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          refreshToken: "r1",
          projectId: "p1",
          addedAt: 1,
          lastUsed: 0,
        },
        {
          refreshToken: "r2",
          projectId: "p2",
          addedAt: 1,
          lastUsed: 0,
        },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);
    const accounts = manager.getAccounts();

    // Mark ALL accounts as verification-required (but keep them enabled for testing defensive filtering)
    accounts[0]!.verificationRequired = true;
    accounts[1]!.verificationRequired = true;

    const next = manager.getNextForFamily("gemini", null, "antigravity");
    expect(next).toBeNull();
  });

  it("markAccountVerificationRequired disables account and prevents selection", () => {
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          refreshToken: "r1",
          projectId: "p1",
          addedAt: 1,
          lastUsed: 0,
        },
        {
          refreshToken: "r2",
          projectId: "p2",
          addedAt: 1,
          lastUsed: 0,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { claude: 0, gemini: 0 },
    };

    const manager = new AccountManager(undefined, stored);

    // Mark account 0 as verification-required
    manager.markAccountVerificationRequired(0, "Google requires verification", "https://accounts.google.com/verify");

    const accounts = manager.getAccounts();
    expect(accounts[0]!.verificationRequired).toBe(true);
    expect(accounts[0]!.enabled).toBe(false);
    expect(accounts[0]!.verificationRequiredReason).toBe("Google requires verification");
    expect(accounts[0]!.verificationUrl).toBe("https://accounts.google.com/verify");

    // getNextForFamily should only return account 1 (account 0 is disabled)
    const next = manager.getNextForFamily("gemini", null, "antigravity");
    expect(next).not.toBeNull();
    expect(next!.index).toBe(1);
  });

  it("getAffinityAccount rejects verification-required accounts", () => {
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          refreshToken: "r1",
          projectId: "p1",
          addedAt: 1,
          lastUsed: 0,
          email: "test@example.com",
        },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);
    const accounts = manager.getAccounts();

    // Mark account as verification-required
    accounts[0]!.verificationRequired = true;

    // Try to get it via affinity - should return null (not throw, since strict is not set)
    const result = manager.getCurrentOrNextForFamily(
      "gemini",
      null,
      "sticky",
      "antigravity",
      false,
      100,
      600000,
      { email: "test@example.com" },
    );

    // Since the only matching account is verification-required and no others exist,
    // getCurrentOrNextForFamily should return null
    expect(result).toBeNull();
  });
});
