import type { HeaderStyle } from "../../constants";

export type ModelFamily = "claude" | "gemini-flash" | "gemini-pro";

export type ThinkingTier = "low" | "medium" | "high";

/**
 * Context for request transformation.
 * Contains all information needed to transform a request payload.
 */
export interface TransformContext {
  /** The resolved project ID for the API call */
  projectId: string;
  /** The resolved model name (after alias resolution) */
  model: string;
  /** The original model name from the request */
  requestedModel: string;
  /** Model family for routing decisions */
  family: ModelFamily;
  /** Whether this is a streaming request */
  streaming: boolean;
  /** Unique request ID for tracking */
  requestId: string;
  /** Session ID for signature caching */
  sessionId?: string;
  /** Thinking tier if specified via model suffix */
  thinkingTier?: ThinkingTier;
  /** Thinking budget for Claude models (derived from tier) */
  thinkingBudget?: number;
  /** Thinking level for Gemini 3 models (derived from tier) */
  thinkingLevel?: string;
}

/**
 * Result of request transformation.
 */
export interface TransformResult {
  /** The transformed request body as JSON string */
  body: string;
  /** Debug information about the transformation */
  debugInfo: TransformDebugInfo;
}

/**
 * Debug information from transformation.
 */
export interface TransformDebugInfo {
  /** Which transformer was used */
  transformer: "claude" | "gemini";
  /** Number of tools in the request */
  toolCount: number;
  /** Whether tools were transformed */
  toolsTransformed?: boolean;
  /** Thinking tier if resolved */
  thinkingTier?: string;
  /** Thinking budget if set */
  thinkingBudget?: number;
  /** Thinking level if set (Gemini 3) */
  thinkingLevel?: string;
}

/**
 * Generic request payload type.
 * The actual structure varies between Claude and Gemini.
 */
export type RequestPayload = Record<string, unknown>;

/**
 * Thinking configuration normalized from various input formats.
 */
export interface ThinkingConfig {
  /** Numeric thinking budget (for Claude and Gemini 2.5) */
  thinkingBudget?: number;
  /** String thinking level (for Gemini 3: 'low', 'medium', 'high') */
  thinkingLevel?: string;
  /** Whether to include thinking in the response */
  includeThoughts?: boolean;
  /** Snake_case variant for Antigravity backend */
  include_thoughts?: boolean;
}

/**
 * Google Search Grounding configuration.
 *
 * Note: The new googleSearch API for Gemini 2.0+ does not support threshold
 * configuration. The model automatically decides when to search.
 * The threshold field is kept for backward compatibility but is ignored.
 */
export interface GoogleSearchConfig {
  mode?: 'auto' | 'off';
  /** @deprecated No longer used - kept for backward compatibility */
  threshold?: number;
}

/**
 * Model resolution result with tier information.
 */
export interface ResolvedModel {
  /** The actual model name for the API call */
  actualModel: string;
  /** Thinking level for Gemini 3 models */
  thinkingLevel?: string;
  /** Thinking budget for Claude/Gemini 2.5 */
  thinkingBudget?: number;
  /** The tier suffix that was extracted */
  tier?: ThinkingTier;
  /** Whether this is a thinking-capable model */
  isThinkingModel?: boolean;
  /** Whether this is an image generation model */
  isImageModel?: boolean;
  /** Quota preference - all models default to antigravity, with CLI as fallback */
  quotaPreference?: HeaderStyle;
  /** Whether user explicitly specified quota via suffix (vs default selection) */
  explicitQuota?: boolean;
  /** Source of thinking config: "variant" (providerOptions) or "tier" (model suffix) */
  configSource?: "variant" | "tier";
  /** Google Search configuration from variant or global config */
  googleSearch?: GoogleSearchConfig;
}
