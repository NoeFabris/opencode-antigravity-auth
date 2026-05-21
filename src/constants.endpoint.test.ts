import { describe, it, expect } from "vitest";

import {
  ANTIGRAVITY_ENDPOINT_DAILY_NONSANDBOX,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_LOAD_ENDPOINTS,
  ANTIGRAVITY_ENDPOINT,
  GEMINI_CLI_ENDPOINT,
} from "./constants";

describe("endpoint constants", () => {
  it("non-sandbox daily endpoint has no .sandbox. subdomain", () => {
    expect(ANTIGRAVITY_ENDPOINT_DAILY_NONSANDBOX).not.toContain(".sandbox.");
    expect(ANTIGRAVITY_ENDPOINT_DAILY_NONSANDBOX).toBe(
      "https://daily-cloudcode-pa.googleapis.com",
    );
  });

  it("sandbox daily endpoint contains .sandbox. subdomain", () => {
    expect(ANTIGRAVITY_ENDPOINT_DAILY).toContain(".sandbox.");
    expect(ANTIGRAVITY_ENDPOINT_DAILY).toBe(
      "https://daily-cloudcode-pa.sandbox.googleapis.com",
    );
  });

  it("prod endpoint has no .sandbox. subdomain", () => {
    expect(ANTIGRAVITY_ENDPOINT_PROD).not.toContain(".sandbox.");
    expect(ANTIGRAVITY_ENDPOINT_PROD).toBe("https://cloudcode-pa.googleapis.com");
  });

  it("ANTIGRAVITY_ENDPOINT (primary) is the non-sandbox daily endpoint", () => {
    // Phase 2: primary endpoint updated to match official agy CLI behavior
    expect(ANTIGRAVITY_ENDPOINT).toBe(ANTIGRAVITY_ENDPOINT_DAILY_NONSANDBOX);
  });

  it("GEMINI_CLI_ENDPOINT is the prod endpoint", () => {
    expect(GEMINI_CLI_ENDPOINT).toBe(ANTIGRAVITY_ENDPOINT_PROD);
  });
});

describe("ANTIGRAVITY_ENDPOINT_FALLBACKS order", () => {
  it("has exactly 3 entries", () => {
    expect(ANTIGRAVITY_ENDPOINT_FALLBACKS).toHaveLength(3);
  });

  it("non-sandbox daily is first (matches official agy CLI behavior)", () => {
    expect(ANTIGRAVITY_ENDPOINT_FALLBACKS[0]).toBe(ANTIGRAVITY_ENDPOINT_DAILY_NONSANDBOX);
  });

  it("sandbox daily is second (kept as fallback until non-sandbox is proven)", () => {
    expect(ANTIGRAVITY_ENDPOINT_FALLBACKS[1]).toBe(ANTIGRAVITY_ENDPOINT_DAILY);
  });

  it("prod is last", () => {
    expect(ANTIGRAVITY_ENDPOINT_FALLBACKS[2]).toBe(ANTIGRAVITY_ENDPOINT_PROD);
  });

  it("does not include autopush sandbox (consistently unavailable)", () => {
    expect(ANTIGRAVITY_ENDPOINT_FALLBACKS).not.toContain(ANTIGRAVITY_ENDPOINT_AUTOPUSH);
  });

  it("all entries are unique", () => {
    const unique = new Set(ANTIGRAVITY_ENDPOINT_FALLBACKS);
    expect(unique.size).toBe(ANTIGRAVITY_ENDPOINT_FALLBACKS.length);
  });

  it("all entries are HTTPS", () => {
    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
      expect(endpoint).toMatch(/^https:\/\//);
    }
  });
});

describe("ANTIGRAVITY_LOAD_ENDPOINTS order", () => {
  it("prod is first (best supported for loadCodeAssist)", () => {
    expect(ANTIGRAVITY_LOAD_ENDPOINTS[0]).toBe(ANTIGRAVITY_ENDPOINT_PROD);
  });

  it("non-sandbox daily is second", () => {
    expect(ANTIGRAVITY_LOAD_ENDPOINTS[1]).toBe(ANTIGRAVITY_ENDPOINT_DAILY_NONSANDBOX);
  });

  it("sandbox daily is third", () => {
    expect(ANTIGRAVITY_LOAD_ENDPOINTS[2]).toBe(ANTIGRAVITY_ENDPOINT_DAILY);
  });

  it("does not include autopush sandbox", () => {
    expect(ANTIGRAVITY_LOAD_ENDPOINTS).not.toContain(ANTIGRAVITY_ENDPOINT_AUTOPUSH);
  });
});

describe("gemini-cli endpoint routing rule", () => {
  /**
   * The gemini-cli header style must only use the prod endpoint.
   * Both sandbox and non-sandbox daily endpoints are skipped for gemini-cli.
   * This test documents the invariant so it cannot silently regress.
   */
  it("GEMINI_CLI_ENDPOINT is the only non-daily endpoint in fallbacks", () => {
    // Prod is the only endpoint that gemini-cli is allowed to use
    const nonDailyEndpoints = Array.from(ANTIGRAVITY_ENDPOINT_FALLBACKS).filter(
      (e) => !e.includes("daily"),
    );
    expect(nonDailyEndpoints).toHaveLength(1);
    expect(nonDailyEndpoints[0]).toBe(ANTIGRAVITY_ENDPOINT_PROD);
  });

  it("gemini-cli endpoint is prod, not any daily variant", () => {
    expect(GEMINI_CLI_ENDPOINT).not.toContain("daily");
    expect(GEMINI_CLI_ENDPOINT).not.toContain("sandbox");
  });

  it("all daily endpoints in fallbacks would be skipped for gemini-cli", () => {
    // Simulate the plugin.ts skip logic: skip if not prod
    const allowedForGeminiCli = Array.from(ANTIGRAVITY_ENDPOINT_FALLBACKS).filter(
      (e) => e === ANTIGRAVITY_ENDPOINT_PROD,
    );
    expect(allowedForGeminiCli).toHaveLength(1);
    expect(allowedForGeminiCli[0]).toBe(ANTIGRAVITY_ENDPOINT_PROD);
  });
});
