/**
 * Model Resolution with Thinking Tier Support
 * 
 * Resolves model names with tier suffixes (e.g., gemini-3-pro-high, claude-sonnet-4-5-thinking-low)
 * to their actual API model names and corresponding thinking configurations.
 */

import type { ResolvedModel, ThinkingTier } from "./types";

/**
 * Thinking tier budgets by model family.
 * Claude and Gemini 2.5 Pro use numeric budgets.
 */
export const THINKING_TIER_BUDGETS = {
  claude: { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-pro": { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-flash": { low: 6144, medium: 12288, high: 24576 },
  default: { low: 4096, medium: 8192, high: 16384 },
} as const;

/**
 * Gemini 3 uses thinkingLevel strings instead of numeric budgets.
 * Flash supports: low, medium, high
 * Pro supports: low, high
 */
export const GEMINI_3_THINKING_LEVELS = ["low", "medium", "high"] as const;

/**
 * Model aliases - maps user-friendly names to API model names.
 * 
 * Format:
 * - Gemini 3 Pro variants: gemini-3-pro-{low,medium,high}
 * - Claude thinking variants: claude-{model}-thinking-{low,medium,high}
 * - Claude non-thinking: claude-{model} (no -thinking suffix)
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Gemini 3 variants - for Gemini CLI only (tier stripped, thinkingLevel used)
  // For Antigravity, these are bypassed and full model name is kept
  "gemini-3-pro-low": "gemini-3-pro",
  "gemini-3-pro-high": "gemini-3-pro",
  "gemini-3-flash-low": "gemini-3-flash",
  "gemini-3-flash-medium": "gemini-3-flash",
  "gemini-3-flash-high": "gemini-3-flash",

  // Claude proxy names (gemini- prefix for compatibility)
  "gemini-claude-sonnet-4-5": "claude-sonnet-4-5",
  "gemini-claude-sonnet-4-5-thinking-low": "claude-sonnet-4-5-thinking",
  "gemini-claude-sonnet-4-5-thinking-medium": "claude-sonnet-4-5-thinking",
  "gemini-claude-sonnet-4-5-thinking-high": "claude-sonnet-4-5-thinking",
  "gemini-claude-opus-4-5-thinking-low": "claude-opus-4-5-thinking",
  "gemini-claude-opus-4-5-thinking-medium": "claude-opus-4-5-thinking",
  "gemini-claude-opus-4-5-thinking-high": "claude-opus-4-5-thinking",

  // Image variants
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
};

/**
 * Model fallbacks when primary model is unavailable.
 */
export const MODEL_FALLBACKS: Record<string, string> = {
  "gemini-2.5-flash-image": "gemini-2.5-flash",
};

const TIER_REGEX = /-(minimal|low|medium|high)$/;
const QUOTA_PREFIX_REGEX = /^antigravity-/i;

/**
 * Models that only exist on Antigravity (not on Gemini CLI).
 * These automatically route to Antigravity even without the prefix.
 */
const ANTIGRAVITY_ONLY_MODELS = /^(claude|gpt)/i;

/**
 * Legacy Gemini 3 model names that should route to Antigravity quota.
 *
 * Backward compatibility: Since Gemini CLI now uses -preview suffix
 * (gemini-3-pro-preview, gemini-3-flash-preview), old model names
 * without -preview can safely route to Antigravity quota.
 *
 * Matches:
 * - gemini-3-pro-low, gemini-3-pro-high
 * - gemini-3-flash, gemini-3-flash-low, gemini-3-flash-medium, gemini-3-flash-high
 *
 * Does NOT match:
 * - gemini-3-pro-preview (Gemini CLI)
 * - gemini-3-flash-preview (Gemini CLI)
 * - antigravity-gemini-3-* (already handled by prefix)
 *
 * WARNING: This may break if Google/Opencode removes the -preview suffix.
 */
const LEGACY_ANTIGRAVITY_GEMINI3 = /^gemini-3-(pro-(low|high)|flash(-low|-medium|-high)?)$/i;

/**
 * Models that support thinking tier suffixes.
 * Only these models should have -low/-medium/-high stripped as thinking tiers.
 * GPT models like gpt-oss-120b-medium should NOT have -medium stripped.
 */
function supportsThinkingTiers(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("gemini-3") ||
    lower.includes("gemini-2.5") ||
    (lower.includes("claude") && lower.includes("thinking"))
  );
}

/**
 * Extracts thinking tier from model name suffix.
 * Only extracts tier for models that support thinking tiers.
 */
function extractThinkingTierFromModel(model: string): ThinkingTier | undefined {
  // Only extract tier for models that support thinking tiers
  if (!supportsThinkingTiers(model)) {
    return undefined;
  }
  const tierMatch = model.match(TIER_REGEX);
  return tierMatch?.[1] as ThinkingTier | undefined;
}

/**
 * Determines the budget family for a model.
 */
function getBudgetFamily(model: string): keyof typeof THINKING_TIER_BUDGETS {
  if (model.includes("claude")) {
    return "claude";
  }
  if (model.includes("gemini-2.5-pro")) {
    return "gemini-2.5-pro";
  }
  if (model.includes("gemini-2.5-flash")) {
    return "gemini-2.5-flash";
  }
  return "default";
}

/**
 * Checks if a model is a thinking-capable model.
 */
function isThinkingCapableModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("thinking") ||
    lower.includes("gemini-3") ||
    lower.includes("gemini-2.5")
  );
}

/**
 * Resolves a model name with optional tier suffix and quota prefix to its actual API model name
 * and corresponding thinking configuration.
 *
 * Quota routing:
 * - "antigravity-" prefix → Antigravity quota
 * - Claude/GPT models → Antigravity quota (auto, these only exist on Antigravity)
 * - Legacy Gemini 3 names (gemini-3-pro-low, gemini-3-flash, etc.) → Antigravity quota (backward compat)
 * - Other models → Gemini CLI quota (default)
 *
 * Examples:
 * - "gemini-2.5-flash" → { quotaPreference: "gemini-cli" }
 * - "gemini-3-pro-preview" → { quotaPreference: "gemini-cli" } (Gemini CLI uses -preview)
 * - "gemini-3-pro-low" → { quotaPreference: "antigravity" } (legacy name, backward compat)
 * - "antigravity-gemini-3-pro-high" → { quotaPreference: "antigravity" } (explicit prefix)
 * - "claude-sonnet-4-5-thinking-medium" → { quotaPreference: "antigravity" } (Claude only on Antigravity)
 *
 * @param requestedModel - The model name from the request
 * @returns Resolved model with thinking configuration
 */
export function resolveModelWithTier(requestedModel: string): ResolvedModel {
  const isAntigravity = QUOTA_PREFIX_REGEX.test(requestedModel);
  const modelWithoutQuota = requestedModel.replace(QUOTA_PREFIX_REGEX, "");

  const tier = extractThinkingTierFromModel(modelWithoutQuota);
  const baseName = tier ? modelWithoutQuota.replace(TIER_REGEX, "") : modelWithoutQuota;

  const isAntigravityOnly = ANTIGRAVITY_ONLY_MODELS.test(modelWithoutQuota);
  const isLegacyAntigravity = LEGACY_ANTIGRAVITY_GEMINI3.test(modelWithoutQuota);
  const quotaPreference = isAntigravity || isAntigravityOnly || isLegacyAntigravity ? "antigravity" : "gemini-cli";
  const explicitQuota = isAntigravity;

  const isGemini3 = modelWithoutQuota.toLowerCase().startsWith("gemini-3");
  const skipAlias = isAntigravity && isGemini3;

  const actualModel = skipAlias
    ? modelWithoutQuota
    : MODEL_ALIASES[modelWithoutQuota] || MODEL_ALIASES[baseName] || baseName;

  const resolvedModel = MODEL_FALLBACKS[actualModel] || actualModel;
  const isThinking = isThinkingCapableModel(resolvedModel);

  if (!tier) {
    if (resolvedModel === "gemini-3-flash" && !skipAlias) {
      return {
        actualModel: resolvedModel,
        thinkingLevel: "minimal",
        isThinkingModel: true,
        quotaPreference,
        explicitQuota,
      };
    }
    return { actualModel: resolvedModel, isThinkingModel: isThinking, quotaPreference, explicitQuota };
  }

  if (resolvedModel.includes("gemini-3") && !skipAlias) {
    return {
      actualModel: resolvedModel,
      thinkingLevel: tier,
      tier,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  if (skipAlias) {
    return {
      actualModel: resolvedModel,
      tier,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  const budgetFamily = getBudgetFamily(resolvedModel);
  const budgets = THINKING_TIER_BUDGETS[budgetFamily];
  const thinkingBudget = budgets[tier];

  return {
    actualModel: resolvedModel,
    thinkingBudget,
    tier,
    isThinkingModel: isThinking,
    quotaPreference,
    explicitQuota,
  };
}

/**
 * Gets the model family for routing decisions.
 */
export function getModelFamily(model: string): "claude" | "gemini-flash" | "gemini-pro" {
  const lower = model.toLowerCase();
  if (lower.includes("claude")) {
    return "claude";
  }
  if (lower.includes("flash")) {
    return "gemini-flash";
  }
  return "gemini-pro";
}
