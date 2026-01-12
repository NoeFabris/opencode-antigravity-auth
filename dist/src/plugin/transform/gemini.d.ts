/**
 * Gemini-specific Request Transformations
 *
 * Handles Gemini model-specific request transformations including:
 * - Thinking config (camelCase keys, thinkingLevel for Gemini 3)
 * - Tool normalization (function/custom format)
 */
import type { RequestPayload, ThinkingConfig, ThinkingTier } from "./types";
/**
 * Check if a model is a Gemini model (not Claude).
 */
export declare function isGeminiModel(model: string): boolean;
/**
 * Check if a model is Gemini 3 (uses thinkingLevel string).
 */
export declare function isGemini3Model(model: string): boolean;
/**
 * Check if a model is Gemini 2.5 (uses numeric thinkingBudget).
 */
export declare function isGemini25Model(model: string): boolean;
/**
 * Build Gemini 3 thinking config with thinkingLevel string.
 */
export declare function buildGemini3ThinkingConfig(includeThoughts: boolean, thinkingLevel: ThinkingTier): ThinkingConfig;
/**
 * Build Gemini 2.5 thinking config with numeric thinkingBudget.
 */
export declare function buildGemini25ThinkingConfig(includeThoughts: boolean, thinkingBudget?: number): ThinkingConfig;
/**
 * Normalize tools for Gemini models.
 * Ensures tools have proper function-style format.
 *
 * @returns Debug info about tool normalization
 */
export declare function normalizeGeminiTools(payload: RequestPayload): {
    toolDebugMissing: number;
    toolDebugSummaries: string[];
};
/**
 * Apply all Gemini-specific transformations to a request payload.
 */
export interface GeminiTransformOptions {
    /** The effective model name (resolved) */
    model: string;
    /** Tier-based thinking budget (from model suffix, for Gemini 2.5) */
    tierThinkingBudget?: number;
    /** Tier-based thinking level (from model suffix, for Gemini 3) */
    tierThinkingLevel?: ThinkingTier;
    /** Normalized thinking config from user settings */
    normalizedThinking?: {
        includeThoughts?: boolean;
        thinkingBudget?: number;
    };
}
export interface GeminiTransformResult {
    toolDebugMissing: number;
    toolDebugSummaries: string[];
}
/**
 * Apply all Gemini-specific transformations.
 */
export declare function applyGeminiTransforms(payload: RequestPayload, options: GeminiTransformOptions): GeminiTransformResult;
//# sourceMappingURL=gemini.d.ts.map