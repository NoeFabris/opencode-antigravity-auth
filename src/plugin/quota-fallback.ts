import { MODEL_ALIASES } from "./transform/model-resolver";
import type { HeaderStyle } from "../constants";

/**
 * Applies Gemini CLI model aliases when necessary.
 * 
 * Background:
 * - Antigravity accepts tier-suffixed models: "gemini-3-pro-high", "gemini-3-flash-low", etc.
 * - Gemini CLI uses base models: "gemini-3-pro", "gemini-3-flash"
 * - MODEL_ALIASES maps tier-suffixed → base models
 * 
 * When quota_fallback is enabled and we switch from Antigravity → Gemini CLI,
 * we need to apply MODEL_ALIASES to convert the model name.
 * 
 * @param effectiveModel - The resolved model name (e.g., "gemini-3-pro-high")
 * @param headerStyle - The header style being used ("antigravity" or "gemini-cli")
 * @returns The model name appropriate for the header style
 * 
 * @example
 * // When using Gemini CLI headers
 * applyHeaderStyleAliases("gemini-3-pro-high", "gemini-cli")
 * // Returns: "gemini-3-pro"
 * 
 * @example
 * // When using Antigravity headers
 * applyHeaderStyleAliases("gemini-3-pro-high", "antigravity")
 * // Returns: "gemini-3-pro-high" (unchanged)
 */
export function applyHeaderStyleAliases(
  effectiveModel: string,
  headerStyle: HeaderStyle
): string {
  // BUG: Original behavior - no alias application
  // This causes 500 errors when falling back to Gemini CLI
  // because Gemini CLI doesn't recognize tier-suffixed models like "gemini-3-pro-high"
  return effectiveModel;
}
