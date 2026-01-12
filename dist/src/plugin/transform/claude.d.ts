/**
 * Claude-specific Request Transformations
 *
 * Handles Claude model-specific request transformations including:
 * - Tool config (VALIDATED mode)
 * - Thinking config (snake_case keys)
 * - System instruction hints for interleaved thinking
 * - Tool normalization (functionDeclarations format)
 */
import type { RequestPayload, ThinkingConfig } from "./types";
/** Claude thinking models need a sufficiently large max output token limit when thinking is enabled */
export declare const CLAUDE_THINKING_MAX_OUTPUT_TOKENS = 64000;
/** Interleaved thinking hint appended to system instructions */
export declare const CLAUDE_INTERLEAVED_THINKING_HINT = "Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.";
/**
 * Check if a model is a Claude model.
 */
export declare function isClaudeModel(model: string): boolean;
/**
 * Check if a model is a Claude thinking model.
 */
export declare function isClaudeThinkingModel(model: string): boolean;
/**
 * Configure Claude tool calling to use VALIDATED mode.
 * This ensures proper tool call validation on the backend.
 */
export declare function configureClaudeToolConfig(payload: RequestPayload): void;
/**
 * Build Claude thinking config with snake_case keys.
 */
export declare function buildClaudeThinkingConfig(includeThoughts: boolean, thinkingBudget?: number): ThinkingConfig;
/**
 * Ensure maxOutputTokens is sufficient for Claude thinking models.
 * If thinking budget is set, max output must be larger than the budget.
 */
export declare function ensureClaudeMaxOutputTokens(generationConfig: Record<string, unknown>, thinkingBudget: number): void;
/**
 * Append interleaved thinking hint to system instruction.
 * Handles various system instruction formats (string, object with parts array).
 */
export declare function appendClaudeThinkingHint(payload: RequestPayload, hint?: string): void;
/**
 * Normalize tools for Claude models.
 * Converts various tool formats to functionDeclarations format.
 *
 * @returns Debug info about tool normalization
 */
export declare function normalizeClaudeTools(payload: RequestPayload, cleanJSONSchema: (schema: unknown) => Record<string, unknown>): {
    toolDebugMissing: number;
    toolDebugSummaries: string[];
};
/**
 * Convert snake_case stop_sequences to camelCase stopSequences.
 */
export declare function convertStopSequences(generationConfig: Record<string, unknown>): void;
/**
 * Apply all Claude-specific transformations to a request payload.
 */
export interface ClaudeTransformOptions {
    /** The effective model name (resolved) */
    model: string;
    /** Tier-based thinking budget (from model suffix) */
    tierThinkingBudget?: number;
    /** Normalized thinking config from user settings */
    normalizedThinking?: {
        includeThoughts?: boolean;
        thinkingBudget?: number;
    };
    /** Function to clean JSON schema for Antigravity */
    cleanJSONSchema: (schema: unknown) => Record<string, unknown>;
}
export interface ClaudeTransformResult {
    toolDebugMissing: number;
    toolDebugSummaries: string[];
}
/**
 * Apply all Claude-specific transformations.
 */
export declare function applyClaudeTransforms(payload: RequestPayload, options: ClaudeTransformOptions): ClaudeTransformResult;
//# sourceMappingURL=claude.d.ts.map