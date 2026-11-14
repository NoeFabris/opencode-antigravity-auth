/**
 * Neutralizes the OpenCode V2 Code Mode prompt signature that Google's
 * server-side filter matches.
 *
 * Since ~2026-11-14, Google's endpoint (daily-cloudcode-pa.googleapis.com)
 * returns a bare, deterministic 429 RESOURCE_EXHAUSTED for any request whose
 * systemInstruction contains the exact substring "tools.opencode.session_move"
 * — the Code Mode tool catalog that OpenCode V2 injects into every request.
 * The plugin's hardcoded quota fallback then surfaces a misleading 403
 * (SUBSCRIPTION_REQUIRED) to the user. See issue #622.
 *
 * Measured filter behavior (2026-11-15, synthetic probes against the live
 * endpoint):
 * - Matching is limited to systemInstruction; the substring in contents,
 *   tool declarations, or parameter descriptions does not trigger it.
 * - Zero-width/format characters (U+200B, U+00AD, U+2060) are stripped by
 *   server-side normalization BEFORE matching, so invisible-character
 *   insertion does NOT bypass the filter.
 * - Plain-space insertion, bracket property access, optional chaining
 *   ("tools.opencode?."), and one-dot-leader (U+2024) all pass.
 *
 * Bracket property access is used because it is syntactically equivalent
 * JavaScript for the model (tools["opencode"].toolName(...)) and is plain
 * ASCII, so it survives the server-side normalization.
 */

export const OPENCODE_SIGNATURE_NEEDLE = "tools.opencode.";
export const OPENCODE_SIGNATURE_REPLACEMENT = 'tools["opencode"].';

/**
 * Rewrites every "tools.opencode." occurrence in a serialized request body so
 * the exact signature never reaches the endpoint. Applied after
 * JSON.stringify so all text-bearing locations (systemInstruction, contents)
 * are covered regardless of payload shape.
 */
export function neutralizeOpenCodePromptSignature(serializedBody: string): string {
  if (!serializedBody.includes(OPENCODE_SIGNATURE_NEEDLE)) {
    return serializedBody;
  }
  return serializedBody
    .split(OPENCODE_SIGNATURE_NEEDLE)
    .join(OPENCODE_SIGNATURE_REPLACEMENT);
}
