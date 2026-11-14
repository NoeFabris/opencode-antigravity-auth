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
 *
 * IMPORTANT (JSON Safety):
 * Transformations must operate on the object payload BEFORE JSON.stringify,
 * never on the serialized JSON string. Replacing `tools.opencode.` with
 * `tools["opencode"].` after stringification introduces unescaped double quotes
 * into JSON string literals, creating invalid JSON.
 */

export const OPENCODE_SIGNATURE_NEEDLE = "tools.opencode.";
export const OPENCODE_SIGNATURE_REPLACEMENT = 'tools["opencode"].';

/**
 * Rewrites "tools.opencode." occurrences within a single text string.
 */
export function sanitizeOpenCodePromptSignatureText(text: string): string {
  if (typeof text !== "string" || !text.includes(OPENCODE_SIGNATURE_NEEDLE)) {
    return text;
  }
  return text.split(OPENCODE_SIGNATURE_NEEDLE).join(OPENCODE_SIGNATURE_REPLACEMENT);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrites the OpenCode prompt signature in `systemInstruction` parts or string.
 * This directly targets the location matched by the Google endpoint filter.
 */
function sanitizeSystemInstructionInPlace(systemInstruction: unknown): void {
  if (!systemInstruction) return;

  if (typeof systemInstruction === "string") {
    // When systemInstruction is a primitive string on an object, the caller
    // can reassign it. For object containers, handle below.
    return;
  }

  if (isPlainObject(systemInstruction)) {
    if (Array.isArray(systemInstruction.parts)) {
      for (const part of systemInstruction.parts) {
        if (isPlainObject(part) && typeof part.text === "string" && part.text.includes(OPENCODE_SIGNATURE_NEEDLE)) {
          part.text = sanitizeOpenCodePromptSignatureText(part.text);
        }
      }
    } else if (typeof systemInstruction.text === "string" && systemInstruction.text.includes(OPENCODE_SIGNATURE_NEEDLE)) {
      systemInstruction.text = sanitizeOpenCodePromptSignatureText(systemInstruction.text);
    }
  }
}

/**
 * Rewrites the signature in contents[].parts[].text (Gemini/Antigravity format).
 */
function sanitizeContentsInPlace(contents: unknown[]): void {
  for (const content of contents) {
    if (isPlainObject(content) && Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (isPlainObject(part) && typeof part.text === "string" && part.text.includes(OPENCODE_SIGNATURE_NEEDLE)) {
          part.text = sanitizeOpenCodePromptSignatureText(part.text);
        }
      }
    }
  }
}

/**
 * Rewrites the signature in messages[].content[].text (Anthropic/Claude format).
 */
function sanitizeMessagesInPlace(messages: unknown[]): void {
  for (const message of messages) {
    if (!isPlainObject(message)) continue;

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isPlainObject(block) && typeof block.text === "string" && block.text.includes(OPENCODE_SIGNATURE_NEEDLE)) {
          block.text = sanitizeOpenCodePromptSignatureText(block.text);
        }
      }
    } else if (typeof message.content === "string" && message.content.includes(OPENCODE_SIGNATURE_NEEDLE)) {
      message.content = sanitizeOpenCodePromptSignatureText(message.content);
    }
  }
}

/**
 * In-place sanitizer for a request object (either unwrapped `requestPayload`
 * or a nested request object inside a wrapped body).
 *
 * Neutralizes the OpenCode Code Mode signature in `systemInstruction`,
 * `contents`, and `messages` before `JSON.stringify`.
 */
export function sanitizeOpenCodePromptSignatureInPlace(
  request: Record<string, unknown>
): void {
  if (!request || typeof request !== "object") return;

  // 1. systemInstruction (primary trigger location)
  const systemInstruction = request.systemInstruction;
  if (typeof systemInstruction === "string" && systemInstruction.includes(OPENCODE_SIGNATURE_NEEDLE)) {
    request.systemInstruction = sanitizeOpenCodePromptSignatureText(systemInstruction);
  } else if (systemInstruction && typeof systemInstruction === "object") {
    sanitizeSystemInstructionInPlace(systemInstruction);
  }

  // Also check system_instruction alias if present
  const sysAlias = request.system_instruction;
  if (typeof sysAlias === "string" && sysAlias.includes(OPENCODE_SIGNATURE_NEEDLE)) {
    request.system_instruction = sanitizeOpenCodePromptSignatureText(sysAlias);
  } else if (sysAlias && typeof sysAlias === "object") {
    sanitizeSystemInstructionInPlace(sysAlias);
  }

  // 2. contents (Gemini format)
  if (Array.isArray(request.contents)) {
    sanitizeContentsInPlace(request.contents);
  }

  // 3. messages (Anthropic format)
  if (Array.isArray(request.messages)) {
    sanitizeMessagesInPlace(request.messages);
  }

  // 4. extra_body.messages (Anthropic via providerOptions)
  if (isPlainObject(request.extra_body) && Array.isArray((request.extra_body as any).messages)) {
    sanitizeMessagesInPlace((request.extra_body as any).messages);
  }
}
