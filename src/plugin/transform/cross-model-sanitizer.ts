/**
 * Cross-Model Metadata Sanitization
 *
 * Fixes: "Invalid `signature` in `thinking` block" error when switching models mid-session.
 * 
 * Root cause: Gemini stores thoughtSignature in metadata.google, Claude stores signature
 * in top-level thinking blocks. Foreign signatures fail validation on the target model.
 */

import { isClaudeModel } from "./claude";
import { isGeminiModel } from "./gemini";

export type ModelFamily = "claude" | "gemini" | "unknown";

export interface SanitizerOptions {
  targetModel: string;
  sourceModel?: string;
  preserveNonSignatureMetadata?: boolean;
}

export interface SanitizationResult {
  payload: unknown;
  modified: boolean;
  signaturesStripped: number;
}

const GEMINI_SIGNATURE_FIELDS = ["thoughtSignature", "thinkingMetadata"] as const;
const CLAUDE_SIGNATURE_FIELDS = ["signature"] as const;

export function getModelFamily(model: string): ModelFamily {
  if (isClaudeModel(model)) return "claude";
  if (isGeminiModel(model)) return "gemini";
  return "unknown";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stripGeminiThinkingMetadata(
  part: Record<string, unknown>,
  preserveNonSignature = true
): { part: Record<string, unknown>; stripped: number } {
  let stripped = 0;

  if ("thoughtSignature" in part) {
    delete part.thoughtSignature;
    stripped++;
  }

  if ("thinkingMetadata" in part) {
    delete part.thinkingMetadata;
    stripped++;
  }

  if (isPlainObject(part.metadata)) {
    const metadata = part.metadata as Record<string, unknown>;
    if (isPlainObject(metadata.google)) {
      const google = metadata.google as Record<string, unknown>;

      for (const field of GEMINI_SIGNATURE_FIELDS) {
        if (field in google) {
          delete google[field];
          stripped++;
        }
      }

      if (!preserveNonSignature || Object.keys(google).length === 0) {
        delete metadata.google;
      }

      if (Object.keys(metadata).length === 0) {
        delete part.metadata;
      }
    }
  }

  return { part, stripped };
}

export function stripClaudeThinkingFields(
  part: Record<string, unknown>
): { part: Record<string, unknown>; stripped: number } {
  let stripped = 0;

  if (part.type === "thinking" || part.type === "redacted_thinking") {
    for (const field of CLAUDE_SIGNATURE_FIELDS) {
      if (field in part) {
        delete part[field];
        stripped++;
      }
    }
  }

  if ("signature" in part && typeof part.signature === "string") {
    if ((part.signature as string).length >= 50) {
      delete part.signature;
      stripped++;
    }
  }

  return { part, stripped };
}

function sanitizePart(
  part: unknown,
  targetFamily: ModelFamily,
  preserveNonSignature: boolean
): { part: unknown; stripped: number } {
  if (!isPlainObject(part)) {
    return { part, stripped: 0 };
  }

  let totalStripped = 0;
  const partObj = { ...part } as Record<string, unknown>;

  if (targetFamily === "claude") {
    const result = stripGeminiThinkingMetadata(partObj, preserveNonSignature);
    totalStripped += result.stripped;
  } else if (targetFamily === "gemini") {
    const result = stripClaudeThinkingFields(partObj);
    totalStripped += result.stripped;
  }

  return { part: partObj, stripped: totalStripped };
}

function sanitizeParts(
  parts: unknown[],
  targetFamily: ModelFamily,
  preserveNonSignature: boolean
): { parts: unknown[]; stripped: number } {
  let totalStripped = 0;

  const sanitizedParts = parts.map((part) => {
    const result = sanitizePart(part, targetFamily, preserveNonSignature);
    totalStripped += result.stripped;
    return result.part;
  });

  return { parts: sanitizedParts, stripped: totalStripped };
}

function sanitizeContents(
  contents: unknown[],
  targetFamily: ModelFamily,
  preserveNonSignature: boolean
): { contents: unknown[]; stripped: number } {
  let totalStripped = 0;

  const sanitizedContents = contents.map((content) => {
    if (!isPlainObject(content)) return content;

    const contentObj = { ...content } as Record<string, unknown>;

    if (Array.isArray(contentObj.parts)) {
      const result = sanitizeParts(
        contentObj.parts,
        targetFamily,
        preserveNonSignature
      );
      contentObj.parts = result.parts;
      totalStripped += result.stripped;
    }

    return contentObj;
  });

  return { contents: sanitizedContents, stripped: totalStripped };
}

function sanitizeMessages(
  messages: unknown[],
  targetFamily: ModelFamily,
  preserveNonSignature: boolean
): { messages: unknown[]; stripped: number } {
  let totalStripped = 0;

  const sanitizedMessages = messages.map((message) => {
    if (!isPlainObject(message)) return message;

    const messageObj = { ...message } as Record<string, unknown>;

    if (Array.isArray(messageObj.content)) {
      const result = sanitizeParts(
        messageObj.content,
        targetFamily,
        preserveNonSignature
      );
      messageObj.content = result.parts;
      totalStripped += result.stripped;
    }

    return messageObj;
  });

  return { messages: sanitizedMessages, stripped: totalStripped };
}

export function deepSanitizeCrossModelMetadata(
  obj: unknown,
  targetFamily: ModelFamily,
  preserveNonSignature = true
): { obj: unknown; stripped: number } {
  if (!isPlainObject(obj)) {
    return { obj, stripped: 0 };
  }

  let totalStripped = 0;
  const result = { ...obj } as Record<string, unknown>;

  if (Array.isArray(result.contents)) {
    const sanitized = sanitizeContents(
      result.contents,
      targetFamily,
      preserveNonSignature
    );
    result.contents = sanitized.contents;
    totalStripped += sanitized.stripped;
  }

  if (Array.isArray(result.messages)) {
    const sanitized = sanitizeMessages(
      result.messages,
      targetFamily,
      preserveNonSignature
    );
    result.messages = sanitized.messages;
    totalStripped += sanitized.stripped;
  }

  if (isPlainObject(result.extra_body)) {
    const extraBody = { ...result.extra_body } as Record<string, unknown>;
    if (Array.isArray(extraBody.messages)) {
      const sanitized = sanitizeMessages(
        extraBody.messages,
        targetFamily,
        preserveNonSignature
      );
      extraBody.messages = sanitized.messages;
      totalStripped += sanitized.stripped;
    }
    result.extra_body = extraBody;
  }

  if (Array.isArray(result.requests)) {
    const sanitizedRequests = result.requests.map((req) => {
      const sanitized = deepSanitizeCrossModelMetadata(
        req,
        targetFamily,
        preserveNonSignature
      );
      totalStripped += sanitized.stripped;
      return sanitized.obj;
    });
    result.requests = sanitizedRequests;
  }

  return { obj: result, stripped: totalStripped };
}

export function sanitizeCrossModelPayload(
  payload: unknown,
  options: SanitizerOptions
): SanitizationResult {
  const targetFamily = getModelFamily(options.targetModel);

  if (targetFamily === "unknown") {
    return {
      payload,
      modified: false,
      signaturesStripped: 0,
    };
  }

  const preserveNonSignature = options.preserveNonSignatureMetadata ?? true;
  const result = deepSanitizeCrossModelMetadata(
    payload,
    targetFamily,
    preserveNonSignature
  );

  return {
    payload: result.obj,
    modified: result.stripped > 0,
    signaturesStripped: result.stripped,
  };
}

export function sanitizeCrossModelPayloadInPlace(
  payload: Record<string, unknown>,
  options: SanitizerOptions
): number {
  const targetFamily = getModelFamily(options.targetModel);

  if (targetFamily === "unknown") {
    return 0;
  }

  const preserveNonSignature = options.preserveNonSignatureMetadata ?? true;
  let totalStripped = 0;

  const sanitizePartsInPlace = (parts: unknown[]): void => {
    for (const part of parts) {
      if (!isPlainObject(part)) continue;

      if (targetFamily === "claude") {
        const result = stripGeminiThinkingMetadata(
          part as Record<string, unknown>,
          preserveNonSignature
        );
        totalStripped += result.stripped;
      } else if (targetFamily === "gemini") {
        const result = stripClaudeThinkingFields(
          part as Record<string, unknown>
        );
        totalStripped += result.stripped;
      }
    }
  };

  if (Array.isArray(payload.contents)) {
    for (const content of payload.contents) {
      if (isPlainObject(content) && Array.isArray(content.parts)) {
        sanitizePartsInPlace(content.parts);
      }
    }
  }

  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (isPlainObject(message) && Array.isArray(message.content)) {
        sanitizePartsInPlace(message.content);
      }
    }
  }

  if (isPlainObject(payload.extra_body)) {
    const extraBody = payload.extra_body as Record<string, unknown>;
    if (Array.isArray(extraBody.messages)) {
      for (const message of extraBody.messages) {
        if (isPlainObject(message) && Array.isArray(message.content)) {
          sanitizePartsInPlace(message.content);
        }
      }
    }
  }

  return totalStripped;
}
