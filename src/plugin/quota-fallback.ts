import { MODEL_ALIASES } from "./transform/model-resolver";
import type { HeaderStyle } from "../constants";

/**
 * Applies Gemini CLI model aliases when quota_fallback is enabled.
 * Converts tier-suffixed models (e.g., "gemini-3-pro-high") to base models
 * used by Gemini CLI (e.g., "gemini-3-pro").
 */
export function applyHeaderStyleAliases(
  effectiveModel: string,
  headerStyle: HeaderStyle
): string {
  if (headerStyle === "gemini-cli") {
    return MODEL_ALIASES[effectiveModel] || effectiveModel;
  }
  return effectiveModel;
}
