import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AccountManager, type ManagedAccount } from "./accounts";
import type { AccountStorageV3 } from "./storage";

describe("AccountManager - Verification Progressive Cooldown", () => {
  let manager: AccountManager;
  let account: ManagedAccount;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000000)); // Fixed start time

    const stored: AccountStorageV3 = {
      version: 3,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    };

    manager = new AccountManager(undefined, stored);
    const accounts = manager.getAccounts();
    if (!accounts[0]) throw new Error("No account found");
    account = accounts[0];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first attempt uses 10-minute cooldown (plus jitter)", () => {
    const cooldownMs = manager.markVerificationRequired(account, "https://verify.me");
    
    expect(account.verificationAttemptCount).toBe(1);
    expect(account.verificationUrl).toBe("https://verify.me");
    expect(account.verificationUrlCapturedAt).toBe(1000000);
    expect(account.cooldownReason).toBe("verification-required");
    
    // 10 mins = 600,000ms. With jitter (max 60s), range is 600,000 - 660,000
    expect(cooldownMs).toBeGreaterThanOrEqual(600000);
    expect(cooldownMs).toBeLessThan(600000 + 60000 + 1);
    expect(account.coolingDownUntil).toBe(1000000 + cooldownMs);
  });

  it("repeat during cooldown escalates to next tier", () => {
    // First attempt (10m)
    manager.markVerificationRequired(account);
    expect(account.verificationAttemptCount).toBe(1);

    // Second attempt (immediate repeat) - should be 1h
    const cooldownMs = manager.markVerificationRequired(account);
    
    expect(account.verificationAttemptCount).toBe(2);
    // 1h = 3,600,000ms
    expect(cooldownMs).toBeGreaterThanOrEqual(3600000);
    expect(cooldownMs).toBeLessThan(3600000 + 60000 + 1);
  });

  it("repeat after cooldown expires resets to tier 1", () => {
    // First attempt
    manager.markVerificationRequired(account);
    expect(account.verificationAttemptCount).toBe(1);

    // Advance time past cooldown (approx 24h to be safe, though 10m is enough for tier 1)
    vi.advanceTimersByTime(24 * 60 * 60 * 1000); 

    // Should clear cooldown state naturally when checking or when re-marking
    // However, markVerificationRequired calls isAccountCoolingDown which clears expired cooldowns
    
    // Next attempt should be fresh
    const cooldownMs = manager.markVerificationRequired(account);
    
    expect(account.verificationAttemptCount).toBe(1);
    expect(cooldownMs).toBeGreaterThanOrEqual(600000); // Back to 10m
  });

  it("caps at 24 hours", () => {
    // Tier 1: 10m
    manager.markVerificationRequired(account);
    // Tier 2: 1h
    manager.markVerificationRequired(account);
    // Tier 3: 6h
    manager.markVerificationRequired(account);
    // Tier 4: 24h
    const cooldownMs4 = manager.markVerificationRequired(account);
    expect(cooldownMs4).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    
    // Tier 5: 24h (capped)
    const cooldownMs5 = manager.markVerificationRequired(account);
    expect(cooldownMs5).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(cooldownMs5).toBeLessThan(24 * 60 * 60 * 1000 + 60000 + 1);
  });

  it("clearVerificationCooldown resets counter and clears URL", () => {
    manager.markVerificationRequired(account, "https://verify.me");
    expect(account.verificationAttemptCount).toBe(1);
    expect(account.verificationUrl).toBeDefined();

    const result = manager.clearVerificationCooldown(0);
    expect(result).toBe(true);
    
    expect(account.verificationAttemptCount).toBe(0);
    expect(account.verificationUrl).toBeUndefined();
    expect(account.coolingDownUntil).toBeUndefined();
  });

  it("clearVerificationStateOnSuccess resets counter on success", () => {
     manager.markVerificationRequired(account, "https://verify.me");
     
     manager.clearVerificationStateOnSuccess(account);
     
     expect(account.verificationAttemptCount).toBe(0);
     expect(account.verificationUrl).toBeUndefined();
     // Should NOT clear active cooldown
     expect(account.coolingDownUntil).toBeDefined();
  });
  
  it("getVerificationUrl returns stored URL", () => {
    manager.markVerificationRequired(account, "https://verify.me");
    expect(manager.getVerificationUrl(0)).toBe("https://verify.me");
  });
});
