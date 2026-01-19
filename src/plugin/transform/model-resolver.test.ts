import { describe, it, expect } from "vitest";
import { resolveModelWithTier, resolveModelWithVariant, resolveModelForHeaderStyle } from "./model-resolver";

describe("resolveModelWithTier", () => {
  describe("Gemini 3 flash models (Issue #109)", () => {
    it("antigravity-gemini-3-flash gets default thinkingLevel 'low'", () => {
      const result = resolveModelWithTier("antigravity-gemini-3-flash");
      expect(result.actualModel).toBe("gemini-3-flash");
      expect(result.thinkingLevel).toBe("low");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("gemini-3-flash gets default thinkingLevel 'low'", () => {
      const result = resolveModelWithTier("gemini-3-flash");
      expect(result.actualModel).toBe("gemini-3-flash");
      expect(result.thinkingLevel).toBe("low");
    });

    it("gemini-3-flash-preview gets default thinkingLevel 'low'", () => {
      const result = resolveModelWithTier("gemini-3-flash-preview");
      expect(result.actualModel).toBe("gemini-3-flash-preview");
      expect(result.thinkingLevel).toBe("low");
      expect(result.quotaPreference).toBe("gemini-cli");
    });
  });

  describe("Gemini 3 preview models (Issue #115)", () => {
    it("gemini-3-pro-preview gets default thinkingLevel 'low'", () => {
      const result = resolveModelWithTier("gemini-3-pro-preview");
      expect(result.actualModel).toBe("gemini-3-pro-preview");
      expect(result.thinkingLevel).toBe("low");
      expect(result.quotaPreference).toBe("gemini-cli");
    });
  });

  describe("Antigravity Gemini 3 with tier suffix", () => {
    it("antigravity-gemini-3-pro-low gets thinkingLevel from tier", () => {
      const result = resolveModelWithTier("antigravity-gemini-3-pro-low");
      expect(result.actualModel).toBe("gemini-3-pro-low");
      expect(result.thinkingLevel).toBe("low");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("antigravity-gemini-3-pro-high gets thinkingLevel from tier", () => {
      const result = resolveModelWithTier("antigravity-gemini-3-pro-high");
      expect(result.actualModel).toBe("gemini-3-pro-high");
      expect(result.thinkingLevel).toBe("high");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("antigravity-gemini-3-flash-medium gets thinkingLevel from tier", () => {
      const result = resolveModelWithTier("antigravity-gemini-3-flash-medium");
      expect(result.actualModel).toBe("gemini-3-flash");
      expect(result.thinkingLevel).toBe("medium");
    });
  });

  describe("Claude thinking models default budget", () => {
    it("antigravity-claude-sonnet-4-5-thinking gets default max budget (32768)", () => {
      const result = resolveModelWithTier("antigravity-claude-sonnet-4-5-thinking");
      expect(result.actualModel).toBe("claude-sonnet-4-5-thinking");
      expect(result.thinkingBudget).toBe(32768);
      expect(result.isThinkingModel).toBe(true);
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("antigravity-claude-opus-4-5-thinking gets default max budget (32768)", () => {
      const result = resolveModelWithTier("antigravity-claude-opus-4-5-thinking");
      expect(result.actualModel).toBe("claude-opus-4-5-thinking");
      expect(result.thinkingBudget).toBe(32768);
      expect(result.isThinkingModel).toBe(true);
      expect(result.quotaPreference).toBe("antigravity");
    });
  });

  describe("Image models", () => {
    it("marks antigravity-gemini-3-pro-image as explicit quota", () => {
      const result = resolveModelWithTier("antigravity-gemini-3-pro-image");
      expect(result.actualModel).toBe("gemini-3-pro-image");
      expect(result.isImageModel).toBe(true);
      expect(result.explicitQuota).toBe(true);
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("marks gemini-3-pro-image as explicit quota", () => {
      const result = resolveModelWithTier("gemini-3-pro-image");
      expect(result.actualModel).toBe("gemini-3-pro-image");
      expect(result.isImageModel).toBe(true);
      expect(result.explicitQuota).toBe(true);
      expect(result.quotaPreference).toBe("antigravity");
    });
  });
});

describe("resolveModelWithVariant", () => {
  describe("without variant config", () => {
    it("falls back to tier resolution for Claude thinking models", () => {
      const result = resolveModelWithVariant("claude-sonnet-4-5-thinking-low");
      expect(result.actualModel).toBe("claude-sonnet-4-5-thinking");
      expect(result.thinkingBudget).toBe(8192);
      expect(result.configSource).toBeUndefined();
    });

    it("falls back to tier resolution for Gemini 3 models", () => {
      const result = resolveModelWithVariant("gemini-3-pro-high");
      expect(result.actualModel).toBe("gemini-3-pro");
      expect(result.thinkingLevel).toBe("high");
      expect(result.configSource).toBeUndefined();
    });
  });

  describe("with variant config", () => {
    it("overrides tier budget for Claude models", () => {
      const result = resolveModelWithVariant("antigravity-claude-sonnet-4-5-thinking", {
        thinkingBudget: 24000,
      });
      expect(result.actualModel).toBe("claude-sonnet-4-5-thinking");
      expect(result.thinkingBudget).toBe(24000);
      expect(result.configSource).toBe("variant");
    });

    it("maps budget to thinkingLevel for Gemini 3 - low", () => {
      const result = resolveModelWithVariant("antigravity-gemini-3-pro", {
        thinkingBudget: 8000,
      });
      expect(result.actualModel).toBe("gemini-3-pro-low");
      expect(result.thinkingLevel).toBe("low");
      expect(result.thinkingBudget).toBeUndefined();
      expect(result.configSource).toBe("variant");
    });

    it("maps budget to thinkingLevel for Gemini 3 Flash - medium (no tier suffix)", () => {
      const result = resolveModelWithVariant("antigravity-gemini-3-flash", {
        thinkingBudget: 12000,
      });
      expect(result.actualModel).toBe("gemini-3-flash");
      expect(result.thinkingLevel).toBe("medium");
      expect(result.configSource).toBe("variant");
    });

    it("maps budget to thinkingLevel for Gemini 3 - high", () => {
      const result = resolveModelWithVariant("antigravity-gemini-3-pro", {
        thinkingBudget: 32000,
      });
      expect(result.thinkingLevel).toBe("high");
      expect(result.configSource).toBe("variant");
    });

    it("uses budget directly for non-Gemini 3 models", () => {
      const result = resolveModelWithVariant("gemini-2.5-pro", {
        thinkingBudget: 20000,
      });
      expect(result.thinkingBudget).toBe(20000);
      expect(result.thinkingLevel).toBeUndefined();
      expect(result.configSource).toBe("variant");
    });
  });

  describe("backward compatibility", () => {
    it("tier-suffixed models work without variant config", () => {
      const lowResult = resolveModelWithVariant("claude-opus-4-5-thinking-low");
      expect(lowResult.thinkingBudget).toBe(8192);

      const medResult = resolveModelWithVariant("claude-opus-4-5-thinking-medium");
      expect(medResult.thinkingBudget).toBe(16384);

      const highResult = resolveModelWithVariant("claude-opus-4-5-thinking-high");
      expect(highResult.thinkingBudget).toBe(32768);
    });

    it("variant config overrides tier suffix", () => {
      const result = resolveModelWithVariant("claude-sonnet-4-5-thinking-low", {
        thinkingBudget: 50000,
      });
      expect(result.thinkingBudget).toBe(50000);
      expect(result.configSource).toBe("variant");
    });
  });
});

describe("Issue #103: resolveModelForHeaderStyle", () => {
  describe("quota fallback from gemini-cli to antigravity", () => {
    it("transforms gemini-3-flash-preview to gemini-3-flash for antigravity", () => {
      const result = resolveModelForHeaderStyle("gemini-3-flash-preview", "antigravity");
      expect(result.actualModel).toBe("gemini-3-flash");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("transforms gemini-3-pro-preview to gemini-3-pro-low for antigravity", () => {
      const result = resolveModelForHeaderStyle("gemini-3-pro-preview", "antigravity");
      expect(result.actualModel).toBe("gemini-3-pro-low");
      expect(result.quotaPreference).toBe("antigravity");
    });
  });

  describe("quota fallback from antigravity to gemini-cli", () => {
    it("transforms gemini-3-flash to gemini-3-flash-preview for gemini-cli", () => {
      const result = resolveModelForHeaderStyle("gemini-3-flash", "gemini-cli");
      expect(result.actualModel).toBe("gemini-3-flash-preview");
      expect(result.quotaPreference).toBe("gemini-cli");
    });

    it("transforms gemini-3-pro-low to gemini-3-pro-preview for gemini-cli", () => {
      const result = resolveModelForHeaderStyle("gemini-3-pro-low", "gemini-cli");
      expect(result.actualModel).toBe("gemini-3-pro-preview");
      expect(result.quotaPreference).toBe("gemini-cli");
    });
  });

  describe("no transformation needed", () => {
    it("keeps gemini-2.5-flash unchanged for both header styles", () => {
      const antigravity = resolveModelForHeaderStyle("gemini-2.5-flash", "antigravity");
      const cli = resolveModelForHeaderStyle("gemini-2.5-flash", "gemini-cli");
      expect(antigravity.actualModel).toBe("gemini-2.5-flash");
      expect(cli.actualModel).toBe("gemini-2.5-flash");
    });

    it("keeps claude models unchanged (antigravity only)", () => {
      const result = resolveModelForHeaderStyle("claude-sonnet-4-5-thinking", "antigravity");
      expect(result.actualModel).toBe("claude-sonnet-4-5-thinking");
    });
  });
});
