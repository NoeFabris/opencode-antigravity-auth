/**
 * Model Resolution with Thinking Tier Support
 *
 * Resolves model names with tier suffixes (e.g., gemini-3-pro-high, claude-sonnet-4-5-thinking-low)
 * to their actual API model names and corresponding thinking configurations.
 */
import type { ResolvedModel } from "./types";
/**
 * Thinking tier budgets by model family.
 * Claude and Gemini 2.5 Pro use numeric budgets.
 */
export declare const THINKING_TIER_BUDGETS: {
    readonly claude: {
        readonly low: 8192;
        readonly medium: 16384;
        readonly high: 32768;
    };
    readonly "gemini-2.5-pro": {
        readonly low: 8192;
        readonly medium: 16384;
        readonly high: 32768;
    };
    readonly "gemini-2.5-flash": {
        readonly low: 6144;
        readonly medium: 12288;
        readonly high: 24576;
    };
    readonly default: {
        readonly low: 4096;
        readonly medium: 8192;
        readonly high: 16384;
    };
};
/**
 * Gemini 3 uses thinkingLevel strings instead of numeric budgets.
 * Flash supports: minimal, low, medium, high
 * Pro supports: low, high (no minimal/medium)
 */
export declare const GEMINI_3_THINKING_LEVELS: readonly ["minimal", "low", "medium", "high"];
/**
 * Model aliases - maps user-friendly names to API model names.
 *
 * Format:
 * - Gemini 3 Pro variants: gemini-3-pro-{low,medium,high}
 * - Claude thinking variants: claude-{model}-thinking-{low,medium,high}
 * - Claude non-thinking: claude-{model} (no -thinking suffix)
 */
export declare const MODEL_ALIASES: Record<string, string>;
/**
 * Model fallbacks when primary model is unavailable.
 */
export declare const MODEL_FALLBACKS: Record<string, string>;
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
export declare function resolveModelWithTier(requestedModel: string): ResolvedModel;
/**
 * Gets the model family for routing decisions.
 */
export declare function getModelFamily(model: string): "claude" | "gemini-flash" | "gemini-pro";
/**
 * Variant config from OpenCode's providerOptions.
 */
export interface VariantConfig {
    thinkingBudget?: number;
}
/**
 * Resolves model with variant config from providerOptions.
 * Variant config takes priority over tier suffix in model name.
 */
export declare function resolveModelWithVariant(requestedModel: string, variantConfig?: VariantConfig): ResolvedModel;
//# sourceMappingURL=model-resolver.d.ts.map