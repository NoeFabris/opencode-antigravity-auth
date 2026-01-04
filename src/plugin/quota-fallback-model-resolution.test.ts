import { describe, it, expect } from "vitest";
import { resolveModelWithTier, MODEL_ALIASES } from "./transform/model-resolver";
import { applyHeaderStyleAliases } from "./quota-fallback";
import { prepareAntigravityRequest } from "./request";

/**
 * Tests for Quota Fallback Model Resolution (Issue #100).
 * Ensures that model aliases are applied correctly when falling back from Antigravity to Gemini CLI.
 */
describe("Quota Fallback Model Resolution (Issue #100)", () => {
  describe("Unit Tests: applyHeaderStyleAliases()", () => {
    it("applies alias when headerStyle is gemini-cli", () => {
      const result = applyHeaderStyleAliases("gemini-3-pro-high", "gemini-cli");
      expect(result).toBe("gemini-3-pro");
    });

    it("keeps model unchanged when headerStyle is antigravity", () => {
      const result = applyHeaderStyleAliases("gemini-3-pro-high", "antigravity");
      expect(result).toBe("gemini-3-pro-high");
    });

    it("handles gemini-3-flash-high with gemini-cli", () => {
      const result = applyHeaderStyleAliases("gemini-3-flash-high", "gemini-cli");
      expect(result).toBe("gemini-3-flash");
    });

    it("handles gemini-3-pro-low with gemini-cli", () => {
      const result = applyHeaderStyleAliases("gemini-3-pro-low", "gemini-cli");
      expect(result).toBe("gemini-3-pro");
    });

    it("handles models without aliases gracefully", () => {
      const result = applyHeaderStyleAliases("gemini-2.5-flash", "gemini-cli");
      expect(result).toBe("gemini-2.5-flash"); // No alias, stays unchanged
    });

    it("does not apply alias for Claude models", () => {
      const result = applyHeaderStyleAliases("claude-opus-4-5-thinking", "antigravity");
      expect(result).toBe("claude-opus-4-5-thinking");
    });
  });

  describe("INTEGRATION TEST: prepareAntigravityRequest() with quota fallback", () => {
    const mockAccessToken = "test-access-token";
    const mockProjectId = "test-project-id";

    it("applies alias when using gemini-cli in prepareAntigravityRequest", () => {
      const requestUrl = "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3-pro-high:generateContent";
      const requestInit: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        }),
      };

      // Simulate quota fallback: using gemini-cli headers
      const prepared = prepareAntigravityRequest(
        requestUrl,
        requestInit,
        mockAccessToken,
        mockProjectId,
        undefined, // endpointOverride
        "gemini-cli", // headerStyle - THIS IS THE FALLBACK
        false, // forceThinkingRecovery
        { claudeToolHardening: false },
      );

      // EXPECTED: effectiveModel should be "gemini-3-pro" (alias applied)
      expect(prepared.effectiveModel).toBe("gemini-3-pro");
    });

    it("handles gemini-3-flash-high in prepareAntigravityRequest", () => {
      const requestUrl = "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3-flash-high:streamGenerateContent";
      const requestInit: RequestInit = {
        method: "POST",
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Test" }] }],
        }),
      };

      const prepared = prepareAntigravityRequest(
        requestUrl,
        requestInit,
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli",
        false,
        {},
      );

      expect(prepared.effectiveModel).toBe("gemini-3-flash");
    });

    it("prepareAntigravityRequest should NOT apply alias when using antigravity", () => {
      const requestUrl = "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3-pro-high:generateContent";
      const requestInit: RequestInit = {
        method: "POST",
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        }),
      };

      const prepared = prepareAntigravityRequest(
        requestUrl,
        requestInit,
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity", // Using Antigravity headers
        false,
        {},
      );

      // When using Antigravity, tier-suffixed models should stay unchanged
      expect(prepared.effectiveModel).toBe("gemini-3-pro-high");
    });

    it("handles models without tier suffixes", () => {
      const requestUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
      const requestInit: RequestInit = {
        method: "POST",
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Test" }] }],
        }),
      };

      const prepared = prepareAntigravityRequest(
        requestUrl,
        requestInit,
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli",
        false,
        {},
      );

      // No alias exists for this model
      expect(prepared.effectiveModel).toBe("gemini-2.5-flash");
    });

    it("BACKWARD FALLBACK: resolves gemini-3-flash-preview to gemini-3-flash (Issue #100)", () => {
      const requestUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent";
      const requestInit: RequestInit = {
        method: "POST",
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Test" }] }],
        }),
      };

      // Simulate backward fallback: CLI model routed to Antigravity headers
      const prepared = prepareAntigravityRequest(
        requestUrl,
        requestInit,
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity", // Routed to Antigravity internal backend
        false,
        {},
      );

      // Should strip -preview suffix via MODEL_ALIASES
      expect(prepared.effectiveModel).toBe("gemini-3-flash");
    });

    it("BACKWARD FALLBACK: resolves gemini-3-pro-preview to gemini-3-pro", () => {
      const requestUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent";
      const requestInit: RequestInit = {
        method: "POST",
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Test" }] }],
        }),
      };

      const prepared = prepareAntigravityRequest(
        requestUrl,
        requestInit,
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity",
        false,
        {},
      );

      expect(prepared.effectiveModel).toBe("gemini-3-pro");
    });
  });
});
