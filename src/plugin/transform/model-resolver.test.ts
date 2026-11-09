import { describe, it, expect } from "vitest";
import {
  ADVERTISED_TIER_SUFFIX_MODEL_IDS,
  getCollapsedModelBaseId,
  getThinkingTierBudget,
  getThinkingTierSuffix,
  isAdvertisedTierSuffixModel,
  normalizeReasoningLabel,
  parseDisplayReasoning,
  registerCollapsedModelFamily,
  resetCollapsedModelFamilies,
  resolveCollapsedModelTarget,
  resolveModelWithTier,
  resolveModelWithVariant,
  resolveModelForHeaderStyle,
} from "./model-resolver";

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
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("gemini-3-flash-preview gets default thinkingLevel 'low' with antigravity quota", () => {
      const result = resolveModelWithTier("gemini-3-flash-preview");
      expect(result.actualModel).toBe("gemini-3-flash-preview");
      expect(result.thinkingLevel).toBe("low");
      // All Gemini models now default to antigravity
      expect(result.quotaPreference).toBe("antigravity");
    });
  });

  describe("Gemini 3 preview models (Issue #115)", () => {
    it("gemini-3-pro-preview gets default thinkingLevel 'low' with antigravity quota", () => {
      const result = resolveModelWithTier("gemini-3-pro-preview");
      expect(result.actualModel).toBe("gemini-3-pro-preview");
      expect(result.thinkingLevel).toBe("low");
      // All Gemini models now default to antigravity
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("gemini-3.1-pro-preview gets default thinkingLevel 'low' with antigravity quota", () => {
      const result = resolveModelWithTier("gemini-3.1-pro-preview");
      expect(result.actualModel).toBe("gemini-3.1-pro-preview");
      expect(result.thinkingLevel).toBe("low");
      expect(result.quotaPreference).toBe("antigravity");
    });
  });

  describe("All Gemini models default to antigravity quota", () => {
    it("gemini-2.5-flash defaults to antigravity", () => {
      const result = resolveModelWithTier("gemini-2.5-flash");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("gemini-2.5-pro defaults to antigravity", () => {
      const result = resolveModelWithTier("gemini-2.5-pro");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("gemini-2.0-flash defaults to antigravity", () => {
      const result = resolveModelWithTier("gemini-2.0-flash");
      expect(result.quotaPreference).toBe("antigravity");
    });
  });

  describe("cli_first quota preference", () => {
    it("prefers gemini-cli when cli_first is true and no prefix is set", () => {
      const result = resolveModelWithTier("gemini-3-flash", { cli_first: true });
      expect(result.quotaPreference).toBe("gemini-cli");
      expect(result.explicitQuota).toBe(false);
    });

    it("keeps antigravity when antigravity prefix is explicit", () => {
      const result = resolveModelWithTier("antigravity-gemini-3-flash", { cli_first: true });
      expect(result.quotaPreference).toBe("antigravity");
      expect(result.explicitQuota).toBe(true);
    });

    it("keeps antigravity for Claude models when cli_first is true", () => {
      const result = resolveModelWithTier("claude-opus-4-6-thinking", { cli_first: true });
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("keeps antigravity for image models when cli_first is true", () => {
      const result = resolveModelWithTier("gemini-3-pro-image", { cli_first: true });
      expect(result.quotaPreference).toBe("antigravity");
      expect(result.explicitQuota).toBe(true);
    });

    it("defaults to antigravity when cli_first is false", () => {
      const result = resolveModelWithTier("gemini-3-flash", { cli_first: false });
      expect(result.quotaPreference).toBe("antigravity");
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

    it("antigravity-gemini-3.1-pro gets default -low model", () => {
      const result = resolveModelWithTier("antigravity-gemini-3.1-pro");
      expect(result.actualModel).toBe("gemini-3.1-pro-low");
      expect(result.thinkingLevel).toBe("low");
    });
  });

  describe("Claude thinking models default budget", () => {
    it("antigravity-claude-opus-4-6-thinking gets default max budget (32768)", () => {
      const result = resolveModelWithTier("antigravity-claude-opus-4-6-thinking");
      expect(result.actualModel).toBe("claude-opus-4-6-thinking");
      expect(result.thinkingBudget).toBe(32768);
      expect(result.isThinkingModel).toBe(true);
      expect(result.quotaPreference).toBe("antigravity");
    });
  });

  describe("Claude Sonnet 4.6 (non-thinking)", () => {
    it("claude-sonnet-4-6 resolves as non-thinking model", () => {
      const result = resolveModelWithTier("claude-sonnet-4-6");
      expect(result.actualModel).toBe("claude-sonnet-4-6");
      expect(result.isThinkingModel).toBe(false);
      expect(result.thinkingBudget).toBeUndefined();
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("antigravity-claude-sonnet-4-6 resolves as non-thinking model with explicit quota", () => {
      const result = resolveModelWithTier("antigravity-claude-sonnet-4-6");
      expect(result.actualModel).toBe("claude-sonnet-4-6");
      expect(result.isThinkingModel).toBe(false);
      expect(result.thinkingBudget).toBeUndefined();
      expect(result.quotaPreference).toBe("antigravity");
      expect(result.explicitQuota).toBe(true);
    });

    it("gemini-claude-sonnet-4-6 alias resolves to claude-sonnet-4-6", () => {
      const result = resolveModelWithTier("gemini-claude-sonnet-4-6");
      expect(result.actualModel).toBe("claude-sonnet-4-6");
      expect(result.isThinkingModel).toBe(false);
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
      const result = resolveModelWithVariant("claude-opus-4-6-thinking-low");
      expect(result.actualModel).toBe("claude-opus-4-6-thinking");
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
      const result = resolveModelWithVariant("antigravity-claude-opus-4-6-thinking", {
        thinkingBudget: 24000,
      });
      expect(result.actualModel).toBe("claude-opus-4-6-thinking");
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
      const lowResult = resolveModelWithVariant("claude-opus-4-6-thinking-low");
      expect(lowResult.thinkingBudget).toBe(8192);

      const medResult = resolveModelWithVariant("claude-opus-4-6-thinking-medium");
      expect(medResult.thinkingBudget).toBe(16384);

      const highResult = resolveModelWithVariant("claude-opus-4-6-thinking-high");
      expect(highResult.thinkingBudget).toBe(32768);
    });

    it("variant config overrides tier suffix", () => {
      const result = resolveModelWithVariant("claude-opus-4-6-thinking-low", {
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

    it("transforms gemini-3.1-pro-preview to gemini-3.1-pro-low for antigravity", () => {
      const result = resolveModelForHeaderStyle("gemini-3.1-pro-preview", "antigravity");
      expect(result.actualModel).toBe("gemini-3.1-pro-low");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("transforms gemini-3.1-pro-preview-customtools to gemini-3.1-pro-low for antigravity", () => {
      const result = resolveModelForHeaderStyle("gemini-3.1-pro-preview-customtools", "antigravity");
      expect(result.actualModel).toBe("gemini-3.1-pro-low");
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

    it("transforms gemini-3.1-pro-low to gemini-3.1-pro-preview for gemini-cli", () => {
      const result = resolveModelForHeaderStyle("gemini-3.1-pro-low", "gemini-cli");
      expect(result.actualModel).toBe("gemini-3.1-pro-preview");
      expect(result.quotaPreference).toBe("gemini-cli");
    });

    it("keeps gemini-3.1-pro-preview-customtools unchanged for gemini-cli", () => {
      const result = resolveModelForHeaderStyle("gemini-3.1-pro-preview-customtools", "gemini-cli");
      expect(result.actualModel).toBe("gemini-3.1-pro-preview-customtools");
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
      const result = resolveModelForHeaderStyle("claude-opus-4-6-thinking", "antigravity");
      expect(result.actualModel).toBe("claude-opus-4-6-thinking");
    });
  });
});

describe("advertised tier-suffix model IDs", () => {
  const advertised = [
    "claude-opus-5-5-high",
    "claude-sonnet-5-5-high",
    "gemini-4-argon-high",
    "gemini-3.8-flash-high",
    "gpt-oss-120b-medium",
  ];

  it("includes the known advertised IDs and current Flash tiers", () => {
    expect([...ADVERTISED_TIER_SUFFIX_MODEL_IDS]).toEqual(expect.arrayContaining([...advertised, "gemini-3.8-flash-low", "gemini-3.8-flash-medium"]));
  });

  it.each(advertised)("keeps %s intact for antigravity routing", (modelId) => {
    expect(resolveModelForHeaderStyle(modelId, "antigravity").actualModel).toBe(modelId);
    expect(resolveModelForHeaderStyle(`antigravity-${modelId}`, "antigravity").actualModel).toBe(modelId);
    expect(resolveModelWithTier(modelId).actualModel).toBe(modelId);
    expect(resolveModelWithTier(`antigravity-${modelId}`).actualModel).toBe(modelId);
  });

  it("matches with or without the quota prefix, case-insensitively", () => {
    expect(isAdvertisedTierSuffixModel("gemini-3.8-flash-high")).toBe(true);
    expect(isAdvertisedTierSuffixModel("antigravity-GEMINI-3.8-FLASH-HIGH")).toBe(true);
    expect(isAdvertisedTierSuffixModel("gemini-3.8-flash")).toBe(false);
    expect(isAdvertisedTierSuffixModel("gemini-3-flash-high")).toBe(false);
  });

  it("still derives the Gemini 3 thinking level from an advertised suffix", () => {
    const result = resolveModelForHeaderStyle("gemini-3.8-flash-high", "antigravity");
    expect(result.actualModel).toBe("gemini-3.8-flash-high");
    expect(result.thinkingLevel).toBe("high");
    expect(result.quotaPreference).toBe("antigravity");
  });

  it("does not rewrite an advertised ID when a variant thinking budget is applied", () => {
    const result = resolveModelWithVariant("antigravity-gemini-3.8-flash-high", { thinkingBudget: 4096 });
    expect(result.actualModel).toBe("gemini-3.8-flash-high");
    expect(result.thinkingLevel).toBe("low");
  });

  it("keeps legacy tier stripping for non-advertised aliases", () => {
    expect(resolveModelForHeaderStyle("gemini-3-flash-high", "antigravity").actualModel).toBe("gemini-3-flash");
    expect(resolveModelWithTier("claude-opus-4-6-thinking-high").actualModel).toBe("claude-opus-4-6-thinking");
    expect(resolveModelWithTier("gemini-3-pro-high").actualModel).toBe("gemini-3-pro");
    expect(resolveModelForHeaderStyle("gemini-3-pro-high", "antigravity").actualModel).toBe("gemini-3-pro-high");
  });
});

describe("display-name reasoning labels", () => {
  it("extracts arbitrary effort labels", () => {
    expect(parseDisplayReasoning("Gemini 9 Flash (Extra Low)"))
      .toEqual({ familyName: "Gemini 9 Flash", label: "Extra Low", id: "extra-low" });
    expect(parseDisplayReasoning("Claude Opus 5.5 [Max]"))
      .toEqual({ familyName: "Claude Opus 5.5", label: "Max", id: "max" });
  });

  it("ignores parentheticals that describe the model", () => {
    expect(parseDisplayReasoning("Claude Opus 4.6 (Thinking)")).toBeUndefined();
    expect(parseDisplayReasoning("Gemini 3 Flash (Preview)")).toBeUndefined();
    expect(parseDisplayReasoning("Gemini 3 Flash")).toBeUndefined();
  });

  it("normalizes labels into stable slugs", () => {
    expect(normalizeReasoningLabel(" Extra Low ")).toBe("extra-low");
    expect(normalizeReasoningLabel("Thinking High")).toBe("thinking-high");
  });
});

describe("collapsed model families", () => {
  it("extracts tier suffixes only for thinking-capable model families", () => {
    expect(getThinkingTierSuffix("gemini-3.8-flash-high")).toEqual({ baseId: "gemini-3.8-flash", tier: "high" });
    expect(getThinkingTierSuffix("antigravity-gemini-3.8-flash-low")).toEqual({ baseId: "gemini-3.8-flash", tier: "low" });
    expect(getThinkingTierSuffix("claude-opus-4-6-thinking-medium")).toEqual({ baseId: "claude-opus-4-6-thinking", tier: "medium" });
    expect(getThinkingTierSuffix("gemini-2.5-pro-minimal")).toEqual({ baseId: "gemini-2.5-pro", tier: "minimal" });
    expect(getThinkingTierSuffix("gpt-oss-120b-medium")).toBeUndefined();
    expect(getThinkingTierSuffix("claude-sonnet-5-5-high")).toBeUndefined();
    expect(getThinkingTierSuffix("gemini-3.8-flash")).toBeUndefined();
  });

  it("resolves the base ID for both the base model and its members", () => {
    registerCollapsedModelFamily({
      baseId: "gemini-9-flash",
      tiers: { low: "gemini-9-flash-low", medium: "gemini-9-flash-medium", high: "gemini-9-flash-high" },
      defaultTier: "low",
      thinking: "level",
    });

    expect(getCollapsedModelBaseId("gemini-9-flash")).toBe("gemini-9-flash");
    expect(getCollapsedModelBaseId("antigravity-GEMINI-9-FLASH-MEDIUM")).toBe("gemini-9-flash");
    expect(getCollapsedModelBaseId("gemini-9-flash-high")).toBe("gemini-9-flash");
    expect(getCollapsedModelBaseId("gemini-9-flash-ultra")).toBeUndefined();
  });

  it("replaces a family's member index when it is registered again", () => {
    registerCollapsedModelFamily({
      baseId: "gemini-9-pro",
      tiers: { low: "gemini-9-pro-low", high: "gemini-9-pro-high" },
      thinking: "level",
    });
    registerCollapsedModelFamily({
      baseId: "gemini-9-pro",
      tiers: { medium: "gemini-9-pro-medium" },
      thinking: "level",
    });

    expect(getCollapsedModelBaseId("gemini-9-pro-medium")).toBe("gemini-9-pro");
    expect(getCollapsedModelBaseId("gemini-9-pro-high")).toBeUndefined();
  });

  describe("resolveCollapsedModelTarget", () => {
    registerCollapsedModelFamily({
      baseId: "gemini-10-flash",
      tiers: { low: "gemini-10-flash-low", medium: "gemini-10-flash-medium", high: "gemini-10-flash-high" },
      defaultTier: "low",
      thinking: "level",
    });
    registerCollapsedModelFamily({
      baseId: "gemini-10-pro",
      tiers: { low: "gemini-10-pro-low", high: "gemini-10-pro-high" },
      baseModelId: "gemini-10-pro",
      thinking: "level",
    });
    registerCollapsedModelFamily({
      baseId: "claude-9-thinking",
      tiers: { low: "claude-9-thinking-low", high: "claude-9-thinking-high" },
      thinking: "budget",
    });

    it("returns undefined for unrelated models", () => {
      expect(resolveCollapsedModelTarget("gemini-11-flash")).toBeUndefined();
    });

    it("uses the selected variant tier and reports its thinking level", () => {
      expect(resolveCollapsedModelTarget("antigravity-gemini-10-flash", { thinkingLevel: "high" }))
        .toEqual({ model: "gemini-10-flash-high", thinkingLevel: "high" });
    });

    it("falls back to the family default when the variant does not match", () => {
      expect(resolveCollapsedModelTarget("antigravity-gemini-10-flash", { thinkingLevel: "minimal" }))
        .toEqual({ model: "gemini-10-flash-low", thinkingLevel: "low" });
      expect(resolveCollapsedModelTarget("antigravity-gemini-10-flash"))
        .toEqual({ model: "gemini-10-flash-low", thinkingLevel: "low" });
    });

    it("keeps the tier of an explicitly requested member without a variant", () => {
      expect(resolveCollapsedModelTarget("antigravity-gemini-10-flash-medium"))
        .toEqual({ model: "gemini-10-flash-medium", thinkingLevel: "medium" });
    });

    it("prefers an existing backend base ID when no variant is selected", () => {
      expect(resolveCollapsedModelTarget("antigravity-gemini-10-pro"))
        .toEqual({ model: "gemini-10-pro" });
    });

    it("still selects a tier when a variant is provided for a base-ID family", () => {
      expect(resolveCollapsedModelTarget("antigravity-gemini-10-pro", { thinkingLevel: "high" }))
        .toEqual({ model: "gemini-10-pro-high", thinkingLevel: "high" });
    });

    it("maps a numeric thinking budget onto a budget family tier", () => {
      expect(resolveCollapsedModelTarget("antigravity-claude-9-thinking", { thinkingBudget: 20000 }))
        .toEqual({ model: "claude-9-thinking-high", thinkingBudget: 32768 });
      expect(resolveCollapsedModelTarget("antigravity-claude-9-thinking", { thinkingBudget: 4096 }))
        .toEqual({ model: "claude-9-thinking-low", thinkingBudget: 8192 });
    });

    it("exposes tier budgets by model family", () => {
      expect(getThinkingTierBudget("claude-opus-4-6-thinking", "low")).toBe(8192);
      expect(getThinkingTierBudget("gemini-2.5-flash", "high")).toBe(24576);
      expect(getThinkingTierBudget("gemini-3.8-flash", "minimal")).toBe(4096);
    });

    it("uses an explicit variant ID instead of inferring a tier from settings", () => {
      registerCollapsedModelFamily({
        baseId: "gemini-10-pro",
        tiers: {
          minimal: "gemini-10-pro-minimal",
          low: "gemini-10-pro-low",
          high: "gemini-10-pro-high",
        },
        thinking: "budget",
      });

      // Both minimal and low share a budget, so only the marker keeps minimal
      // on its own backend ID.
      expect(resolveCollapsedModelTarget("antigravity-gemini-10-pro", undefined, "minimal"))
        .toEqual({ model: "gemini-10-pro-minimal", thinkingBudget: 4096 });
      expect(resolveCollapsedModelTarget("antigravity-gemini-10-pro", { thinkingBudget: 8192 }, "minimal"))
        .toEqual({ model: "gemini-10-pro-minimal", thinkingBudget: 4096 });
    });

    it("does not forward a nonstandard effort as a thinking level", () => {
      registerCollapsedModelFamily({
        baseId: "gemini-10-ultra",
        tiers: { turbo: "gemini-10-ultra-turbo", high: "gemini-10-ultra-high" },
        thinking: "level",
      });

      expect(resolveCollapsedModelTarget("antigravity-gemini-10-ultra", { thinkingLevel: "turbo" }, "turbo"))
        .toEqual({ model: "gemini-10-ultra-turbo", suppressThinking: true });
    });
  });

  it("drops obsolete families without touching kept ones", () => {
    registerCollapsedModelFamily({
      baseId: "gemini-12-flash",
      tiers: { low: "gemini-12-flash-low", high: "gemini-12-flash-high" },
      thinking: "level",
    });
    registerCollapsedModelFamily({
      baseId: "gemini-12-pro",
      tiers: { low: "gemini-12-pro-low", high: "gemini-12-pro-high" },
      thinking: "level",
    });

    resetCollapsedModelFamilies(["gemini-12-pro"]);

    expect(getCollapsedModelBaseId("gemini-12-flash-high")).toBeUndefined();
    expect(getCollapsedModelBaseId("gemini-12-pro-high")).toBe("gemini-12-pro");
  });
});
