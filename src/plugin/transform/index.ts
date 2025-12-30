/**
 * Transform Module Index
 * 
 * Re-exports transform functions and types for request transformation.
 */

// Types
export type {
  ModelFamily,
  ThinkingTier,
  TransformContext,
  TransformResult,
  TransformDebugInfo,
  RequestPayload,
  ThinkingConfig,
  ResolvedModel,
} from "./types";

// Model resolution
export {
  resolveModelWithTier,
  getModelFamily,
  MODEL_ALIASES,
  MODEL_FALLBACKS,
  THINKING_TIER_BUDGETS,
  GEMINI_3_THINKING_LEVELS,
} from "./model-resolver";

// Claude transforms
export {
  isClaudeModel,
  isClaudeThinkingModel,
  configureClaudeToolConfig,
  buildClaudeThinkingConfig,
  ensureClaudeMaxOutputTokens,
  appendClaudeThinkingHint,
  normalizeClaudeTools,
  applyClaudeTransforms,
  CLAUDE_THINKING_MAX_OUTPUT_TOKENS,
  CLAUDE_INTERLEAVED_THINKING_HINT,
} from "./claude";
export type { ClaudeTransformOptions, ClaudeTransformResult } from "./claude";

// Gemini transforms
export {
  isGeminiModel,
  isGemini3Model,
  isGemini25Model,
  buildGemini3ThinkingConfig,
  buildGemini25ThinkingConfig,
  normalizeGeminiTools,
  applyGeminiTransforms,
} from "./gemini";
export type { GeminiTransformOptions, GeminiTransformResult } from "./gemini";

// Cross-model sanitization
export {
  sanitizeCrossModelPayload,
  sanitizeCrossModelPayloadInPlace,
  getModelFamily as getCrossModelFamily,
  stripGeminiThinkingMetadata,
  stripClaudeThinkingFields,
} from "./cross-model-sanitizer";
export type { SanitizerOptions } from "./cross-model-sanitizer";
