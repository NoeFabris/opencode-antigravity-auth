import crypto from "node:crypto";
import {
  ANTIGRAVITY_HEADERS,
  GEMINI_CLI_HEADERS,
  ANTIGRAVITY_ENDPOINT,
  GEMINI_CLI_ENDPOINT,
  EMPTY_SCHEMA_PLACEHOLDER_NAME,
  EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
  SKIP_THOUGHT_SIGNATURE,
  getRandomizedHeaders,
  type HeaderStyle,
} from "../constants";
import { cacheSignature, getCachedSignature } from "./cache";
import { getKeepThinking } from "./config";
import {
  createStreamingTransformer,
  transformSseLine,
  transformStreamingPayload,
} from "./core/streaming";
import { defaultSignatureStore } from "./stores/signature-store";
import {
  DEBUG_MESSAGE_PREFIX,
  isDebugEnabled,
  logAntigravityDebugResponse,
  logCacheStats,
  type AntigravityDebugContext,
} from "./debug";
import { createLogger } from "./logger";
import {
  cleanJSONSchemaForAntigravity,
  DEFAULT_THINKING_BUDGET,
  deepFilterThinkingBlocks,
  extractThinkingConfig,
  extractVariantThinkingConfig,
  extractUsageFromSsePayload,
  extractUsageMetadata,
  fixToolResponseGrouping,
  validateAndFixClaudeToolPairing,
  applyToolPairingFixes,
  injectParameterSignatures,
  injectToolHardeningInstruction,
  isThinkingCapableModel,
  normalizeThinkingConfig,
  parseAntigravityApiBody,
  resolveThinkingConfig,
  rewriteAntigravityPreviewAccessError,
  transformThinkingParts,
  type AntigravityApiBody,
} from "./request-helpers";
import {
  CLAUDE_TOOL_SYSTEM_INSTRUCTION,
  CLAUDE_DESCRIPTION_PROMPT,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
} from "../constants";
import {
  analyzeConversationState,
  closeToolLoopForThinking,
  needsThinkingRecovery,
} from "./thinking-recovery";
import { sanitizeCrossModelPayloadInPlace } from "./transform/cross-model-sanitizer";
import { isGemini3Model, isImageGenerationModel, buildImageGenerationConfig, applyGeminiTransforms } from "./transform";
import {
  resolveModelWithTier,
  resolveModelWithVariant,
  resolveModelForHeaderStyle,
  isClaudeModel,
  isClaudeThinkingModel,
  CLAUDE_THINKING_MAX_OUTPUT_TOKENS,
  type ThinkingTier,
} from "./transform";
import { detectErrorType } from "./recovery";
import { getSessionFingerprint, buildFingerprintHeaders, type Fingerprint } from "./fingerprint";
import type { GoogleSearchConfig } from "./transform/types";

const log = createLogger("request");

const PLUGIN_SESSION_ID = `-${crypto.randomUUID()}`;

const sessionDisplayedThinkingHashes = new Set<string>();

const MIN_SIGNATURE_LENGTH = 50;

function buildSignatureSessionKey(
  sessionId: string,
  model?: string,
  conversationKey?: string,
  projectKey?: string,
): string {
  const modelKey = typeof model === "string" && model.trim() ? model.toLowerCase() : "unknown";
  const projectPart = typeof projectKey === "string" && projectKey.trim()
    ? projectKey.trim()
    : "default";
  const conversationPart = typeof conversationKey === "string" && conversationKey.trim()
    ? conversationKey.trim()
    : "default";
  return `${sessionId}:${modelKey}:${projectPart}:${conversationPart}`;
}







function shouldCacheThinkingSignatures(model?: string): boolean {
  if (typeof model !== "string") return false;
  const lower = model.toLowerCase();
  // Both Claude and Gemini 3 models require thought signature caching
  // for multi-turn conversations with function calling
  return lower.includes("claude") || lower.includes("gemini-3");
}

function hashConversationSeed(seed: string): string {
  return crypto.createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const anyBlock = block as any;
    if (typeof anyBlock.text === "string") {
      return anyBlock.text;
    }
    if (anyBlock.text && typeof anyBlock.text === "object" && typeof anyBlock.text.text === "string") {
      return anyBlock.text.text;
    }
  }
  return "";
}

function extractConversationSeedFromMessages(messages: any[]): string {
  const system = messages.find((message) => message?.role === "system");
  const users = messages.filter((message) => message?.role === "user");
  const firstUser = users[0];
  const lastUser = users.length > 0 ? users[users.length - 1] : undefined;
  const systemText = system ? extractTextFromContent(system.content) : "";
  const userText = firstUser ? extractTextFromContent(firstUser.content) : "";
  const fallbackUserText = !userText && lastUser ? extractTextFromContent(lastUser.content) : "";
  return [systemText, userText || fallbackUserText].filter(Boolean).join("|");
}

function extractConversationSeedFromContents(contents: any[]): string {
  const users = contents.filter((content) => content?.role === "user");
  const firstUser = users[0];
  const lastUser = users.length > 0 ? users[users.length - 1] : undefined;
  const primaryUser = firstUser && Array.isArray(firstUser.parts) ? extractTextFromContent(firstUser.parts) : "";
  if (primaryUser) {
    return primaryUser;
  }
  if (lastUser && Array.isArray(lastUser.parts)) {
    return extractTextFromContent(lastUser.parts);
  }
  return "";
}

function resolveConversationKey(requestPayload: Record<string, unknown>): string | undefined {
  const anyPayload = requestPayload as any;
  const candidates = [
    anyPayload.conversationId,
    anyPayload.conversation_id,
    anyPayload.thread_id,
    anyPayload.threadId,
    anyPayload.chat_id,
    anyPayload.chatId,
    anyPayload.sessionId,
    anyPayload.session_id,
    anyPayload.metadata?.conversation_id,
    anyPayload.metadata?.conversationId,
    anyPayload.metadata?.thread_id,
    anyPayload.metadata?.threadId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const systemSeed = extractTextFromContent(
    (anyPayload.systemInstruction as any)?.parts
    ?? anyPayload.systemInstruction
    ?? anyPayload.system
    ?? anyPayload.system_instruction,
  );
  const messageSeed = Array.isArray(anyPayload.messages)
    ? extractConversationSeedFromMessages(anyPayload.messages)
    : Array.isArray(anyPayload.contents)
      ? extractConversationSeedFromContents(anyPayload.contents)
      : "";
  const seed = [systemSeed, messageSeed].filter(Boolean).join("|");
  if (!seed) {
    return undefined;
  }
  return `seed-${hashConversationSeed(seed)}`;
}

function resolveConversationKeyFromRequests(requestObjects: Array<Record<string, unknown>>): string | undefined {
  for (const req of requestObjects) {
    const key = resolveConversationKey(req);
    if (key) {
      return key;
    }
  }
  return undefined;
}

function resolveProjectKey(candidate?: unknown, fallback?: string): string | undefined {
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return undefined;
}

function formatDebugLinesForThinking(lines: string[]): string {
  const cleaned = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-50);
  return `${DEBUG_MESSAGE_PREFIX}\n${cleaned.map((line) => `- ${line}`).join("\n")}`;
}

function injectDebugThinking(response: unknown, debugText: string): unknown {
  if (!response || typeof response !== "object") {
    return response;
  }

  const resp = response as any;

  if (Array.isArray(resp.candidates) && resp.candidates.length > 0) {
    const candidates = resp.candidates.slice();
    const first = candidates[0];

    if (
      first &&
      typeof first === "object" &&
      first.content &&
      typeof first.content === "object" &&
      Array.isArray(first.content.parts)
    ) {
      const parts = [{ thought: true, text: debugText }, ...first.content.parts];
      candidates[0] = { ...first, content: { ...first.content, parts } };
      return { ...resp, candidates };
    }

    return resp;
  }

  if (Array.isArray(resp.content)) {
    const content = [{ type: "thinking", thinking: debugText }, ...resp.content];
    return { ...resp, content };
  }

  if (!resp.reasoning_content) {
    return { ...resp, reasoning_content: debugText };
  }

  return resp;
}

/**
 * Synthetic thinking placeholder text used when keep_thinking=true but debug mode is off.
 * Injected via the same path as debug text (injectDebugThinking) to ensure consistent
 * signature caching and multi-turn handling.
 */
const SYNTHETIC_THINKING_PLACEHOLDER = "[Thinking preserved]\n";

function stripInjectedDebugFromParts(parts: unknown): unknown {
  if (!Array.isArray(parts)) {
    return parts;
  }

  return parts.filter((part) => {
    if (!part || typeof part !== "object") {
      return true;
    }

    const record = part as any;
    const text =
      typeof record.text === "string"
        ? record.text
        : typeof record.thinking === "string"
          ? record.thinking
          : undefined;

    // Strip debug blocks and synthetic thinking placeholders
    if (text && (text.startsWith(DEBUG_MESSAGE_PREFIX) || text.startsWith(SYNTHETIC_THINKING_PLACEHOLDER.trim()))) {
      return false;
    }

    return true;
  });
}

function stripInjectedDebugFromRequestPayload(payload: Record<string, unknown>): void {
  const anyPayload = payload as any;

  if (Array.isArray(anyPayload.contents)) {
    anyPayload.contents = anyPayload.contents.map((content: any) => {
      if (!content || typeof content !== "object") {
        return content;
      }

      if (Array.isArray(content.parts)) {
        return { ...content, parts: stripInjectedDebugFromParts(content.parts) };
      }

      if (Array.isArray(content.content)) {
        return { ...content, content: stripInjectedDebugFromParts(content.content) };
      }

      return content;
    });
  }

  if (Array.isArray(anyPayload.messages)) {
    anyPayload.messages = anyPayload.messages.map((message: any) => {
      if (!message || typeof message !== "object") {
        return message;
      }

      if (Array.isArray(message.content)) {
        return { ...message, content: stripInjectedDebugFromParts(message.content) };
      }

      return message;
    });
  }
}

function isGeminiToolUsePart(part: any): boolean {
  return !!(part && typeof part === "object" && (part.functionCall || part.tool_use || part.toolUse));
}

function isGeminiThinkingPart(part: any): boolean {
  return !!(
    part &&
    typeof part === "object" &&
    (part.thought === true || part.type === "thinking" || part.type === "reasoning")
  );
}

// Sentinel value used when signature recovery fails - allows Claude to handle gracefully
// by redacting the thinking block instead of rejecting the request entirely.
// Reference: LLM-API-Key-Proxy uses this pattern for Gemini 3 tool calls.
const SENTINEL_SIGNATURE = "skip_thought_signature_validator";

function ensureThoughtSignature(part: any, sessionId: string): any {
  if (!part || typeof part !== "object") {
    return part;
  }

  const text = typeof part.text === "string" ? part.text : typeof part.thinking === "string" ? part.thinking : "";
  if (!text) {
    return part;
  }

  if (part.thought === true) {
    if (!part.thoughtSignature) {
      const cached = getCachedSignature(sessionId, text);
      if (cached) {
        return { ...part, thoughtSignature: cached };
      }
      // Fallback: use sentinel signature to prevent API rejection
      // This allows Claude to redact the thinking block instead of failing
      return { ...part, thoughtSignature: SENTINEL_SIGNATURE };
    }
    return part;
  }

  if ((part.type === "thinking" || part.type === "reasoning") && !part.signature) {
    const cached = getCachedSignature(sessionId, text);
    if (cached) {
      return { ...part, signature: cached };
    }
    // Fallback: use sentinel signature to prevent API rejection
    return { ...part, signature: SENTINEL_SIGNATURE };
  }

  return part;
}

function hasSignedThinkingPart(part: any): boolean {
  if (!part || typeof part !== "object") {
    return false;
  }

  if (part.thought === true) {
    return typeof part.thoughtSignature === "string" && part.thoughtSignature.length >= MIN_SIGNATURE_LENGTH;
  }

  if (part.type === "thinking" || part.type === "reasoning") {
    return typeof part.signature === "string" && part.signature.length >= MIN_SIGNATURE_LENGTH;
  }

  return false;
}

function ensureThinkingBeforeToolUseInContents(contents: any[], signatureSessionKey: string): any[] {
  return contents.map((content: any) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return content;
    }

    const role = content.role;
    if (role !== "model" && role !== "assistant") {
      return content;
    }

    const parts = content.parts as any[];
    const hasToolUse = parts.some(isGeminiToolUsePart);
    if (!hasToolUse) {
      return content;
    }

    const thinkingParts = parts.filter(isGeminiThinkingPart).map((p) => ensureThoughtSignature(p, signatureSessionKey));
    const otherParts = parts.filter((p) => !isGeminiThinkingPart(p));
    const hasSignedThinking = thinkingParts.some(hasSignedThinkingPart);

    if (hasSignedThinking) {
      return { ...content, parts: [...thinkingParts, ...otherParts] };
    }

    const lastThinking = defaultSignatureStore.get(signatureSessionKey);
    if (!lastThinking) {
      // No cached signature available - strip thinking blocks entirely
      // Claude requires valid signatures, and we can't fake them
      // Return only tool_use parts without any thinking to avoid signature validation errors
      log.debug("Stripping thinking from tool_use content (no valid cached signature)", { signatureSessionKey });
      return { ...content, parts: otherParts };
    }

    const injected = {
      thought: true,
      text: lastThinking.text,
      thoughtSignature: lastThinking.signature,
    };

    return { ...content, parts: [injected, ...otherParts] };
  });
}

function ensureMessageThinkingSignature(block: any, sessionId: string): any {
  if (!block || typeof block !== "object") {
    return block;
  }

  if (block.type !== "thinking" && block.type !== "redacted_thinking") {
    return block;
  }

  if (typeof block.signature === "string" && block.signature.length >= MIN_SIGNATURE_LENGTH) {
    return block;
  }

  const text = typeof block.thinking === "string" ? block.thinking : typeof block.text === "string" ? block.text : "";
  if (!text) {
    return block;
  }

  const cached = getCachedSignature(sessionId, text);
  if (cached) {
    return { ...block, signature: cached };
  }

  return block;
}

function hasToolUseInContents(contents: any[]): boolean {
  return contents.some((content: any) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return false;
    }
    return (content.parts as any[]).some(isGeminiToolUsePart);
  });
}

function hasSignedThinkingInContents(contents: any[]): boolean {
  return contents.some((content: any) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return false;
    }
    return (content.parts as any[]).some(hasSignedThinkingPart);
  });
}

function hasToolUseInMessages(messages: any[]): boolean {
  return messages.some((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return false;
    }
    return (message.content as any[]).some(
      (block) => block && typeof block === "object" && (block.type === "tool_use" || block.type === "tool_result"),
    );
  });
}

function hasSignedThinkingInMessages(messages: any[]): boolean {
  return messages.some((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return false;
    }
    return (message.content as any[]).some(
      (block) =>
        block &&
        typeof block === "object" &&
        (block.type === "thinking" || block.type === "redacted_thinking") &&
        typeof block.signature === "string" &&
        block.signature.length >= MIN_SIGNATURE_LENGTH,
    );
  });
}

function ensureThinkingBeforeToolUseInMessages(messages: any[], signatureSessionKey: string): any[] {
  return messages.map((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return message;
    }

    if (message.role !== "assistant") {
      return message;
    }

    const blocks = message.content as any[];
    const hasToolUse = blocks.some((b) => b && typeof b === "object" && (b.type === "tool_use" || b.type === "tool_result"));
    if (!hasToolUse) {
      return message;
    }

    const thinkingBlocks = blocks
      .filter((b) => b && typeof b === "object" && (b.type === "thinking" || b.type === "redacted_thinking"))
      .map((b) => ensureMessageThinkingSignature(b, signatureSessionKey));

    const otherBlocks = blocks.filter((b) => !(b && typeof b === "object" && (b.type === "thinking" || b.type === "redacted_thinking")));
    const hasSignedThinking = thinkingBlocks.some((b) => typeof b.signature === "string" && b.signature.length >= MIN_SIGNATURE_LENGTH);

    if (hasSignedThinking) {
      return { ...message, content: [...thinkingBlocks, ...otherBlocks] };
    }

    const lastThinking = defaultSignatureStore.get(signatureSessionKey);
    if (!lastThinking) {
      // No cached signature available - use sentinel to bypass validation
      // This handles cache miss scenarios (restart, session mismatch, expiry)
      const existingThinking = thinkingBlocks[0];
      const thinkingText = existingThinking?.thinking || existingThinking?.text || "";
      log.debug("Injecting sentinel signature (cache miss)", { signatureSessionKey });
      const sentinelBlock = {
        type: "thinking",
        thinking: thinkingText,
        signature: SKIP_THOUGHT_SIGNATURE,
      };
      return { ...message, content: [sentinelBlock, ...otherBlocks] };
    }

    const injected = {
      type: "thinking",
      thinking: lastThinking.text,
      signature: lastThinking.signature,
    };

    return { ...message, content: [injected, ...otherBlocks] };
  });
}

/**
 * Gets the stable session ID for this plugin instance.
 */
export function getPluginSessionId(): string {
  return PLUGIN_SESSION_ID;
}

function generateSyntheticProjectId(): string {
  const adjectives = ["useful", "bright", "swift", "calm", "bold"];
  const nouns = ["fuze", "wave", "spark", "flow", "core"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const randomPart = crypto.randomUUID().slice(0, 5).toLowerCase();
  return `${adj}-${noun}-${randomPart}`;
}

const STREAM_ACTION = "streamGenerateContent";

/**
 * Detects requests headed to the Google Generative Language API so we can intercept them.
 */
export function isGenerativeLanguageRequest(input: RequestInfo): input is string {
  return typeof input === "string" && input.includes("generativelanguage.googleapis.com");
}

/**
 * Options for request preparation.
 */
export interface PrepareRequestOptions {
  /** Enable Claude tool hardening (parameter signatures + system instruction). Default: true */
  claudeToolHardening?: boolean;
  /** Google Search configuration (global default) */
  googleSearch?: GoogleSearchConfig;
  /** Per-account fingerprint for rate limit mitigation. Falls back to session fingerprint if not provided. */
  fingerprint?: Fingerprint;
}

export function prepareAntigravityRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
  endpointOverride?: string,
  headerStyle: HeaderStyle = "antigravity",
  forceThinkingRecovery = false,
  options?: PrepareRequestOptions,
): {
  request: RequestInfo;
  init: RequestInit;
  streaming: boolean;
  requestedModel?: string;
  effectiveModel?: string;
  projectId?: string;
  endpoint?: string;
  sessionId?: string;
  toolDebugMissing?: number;
  toolDebugSummary?: string;
  toolDebugPayload?: string;
  needsSignedThinkingWarmup?: boolean;
  headerStyle: HeaderStyle;
  thinkingRecoveryMessage?: string;
} {
  const baseInit: RequestInit = { ...init };
  const headers = new Headers(init?.headers ?? {});
  let resolvedProjectId = projectId?.trim() || "";
  let toolDebugMissing = 0;
  const toolDebugSummaries: string[] = [];
  let toolDebugPayload: string | undefined;
  let sessionId: string | undefined;
  let needsSignedThinkingWarmup = false;
  let thinkingRecoveryMessage: string | undefined;

  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
      headerStyle,
    };
  }

  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");

  const match = input.match(/\/models\/([^:]+):(\w+)/);
  if (!match) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
      headerStyle,
    };
  }

  const [, rawModel = "", rawAction = ""] = match;
  const requestedModel = rawModel;

  const resolved = resolveModelForHeaderStyle(rawModel, headerStyle);
  const effectiveModel = resolved.actualModel;

  const streaming = rawAction === STREAM_ACTION;
  const defaultEndpoint = headerStyle === "gemini-cli" ? GEMINI_CLI_ENDPOINT : ANTIGRAVITY_ENDPOINT;
  const baseEndpoint = endpointOverride ?? defaultEndpoint;
  const transformedUrl = `${baseEndpoint}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""}`;

  const isClaude = isClaudeModel(resolved.actualModel);
  const isClaudeThinking = isClaudeThinkingModel(resolved.actualModel);

  // Tier-based thinking configuration from model resolver (can be overridden by variant config)
  let tierThinkingBudget = resolved.thinkingBudget;
  let tierThinkingLevel = resolved.thinkingLevel;
  let signatureSessionKey = buildSignatureSessionKey(
    PLUGIN_SESSION_ID,
    effectiveModel,
    undefined,
    resolveProjectKey(projectId),
  );

  let body = baseInit.body;
  if (typeof baseInit.body === "string" && baseInit.body) {
    try {
      const parsedBody = JSON.parse(baseInit.body) as Record<string, unknown>;
      const isWrapped = typeof parsedBody.project === "string" && "request" in parsedBody;

      if (isWrapped) {
        const wrappedBody = {
          ...parsedBody,
          model: effectiveModel,
        } as Record<string, unknown>;

        // Some callers may already send an Antigravity-wrapped body.
        // We still need to sanitize Claude thinking blocks (remove cache_control)
        // and attach a stable sessionId so multi-turn signature caching works.
        const requestRoot = wrappedBody.request;
        const requestObjects: Array<Record<string, unknown>> = [];

        if (requestRoot && typeof requestRoot === "object") {
          requestObjects.push(requestRoot as Record<string, unknown>);
          const nested = (requestRoot as any).request;
          if (nested && typeof nested === "object") {
            requestObjects.push(nested as Record<string, unknown>);
          }
        }

        const conversationKey = resolveConversationKeyFromRequests(requestObjects);
        // Strip tier suffix from model for cache key to prevent cache misses on tier change
        // e.g., "claude-opus-4-5-thinking-high" -> "claude-opus-4-5-thinking"
        const modelForCacheKey = effectiveModel.replace(/-(minimal|low|medium|high)$/i, "");
        signatureSessionKey = buildSignatureSessionKey(PLUGIN_SESSION_ID, modelForCacheKey, conversationKey, resolveProjectKey(parsedBody.project));

        if (requestObjects.length > 0) {
          sessionId = signatureSessionKey;
        }

        for (const req of requestObjects) {
          // Use stable session ID for signature caching across multi-turn conversations
          (req as any).sessionId = signatureSessionKey;
          stripInjectedDebugFromRequestPayload(req as Record<string, unknown>);

          if (isClaude) {
            // Step 0: Sanitize cross-model metadata (strips Gemini signatures when sending to Claude)
            sanitizeCrossModelPayloadInPlace(req, { targetModel: effectiveModel });

            // Step 1: Strip corrupted/unsigned thinking blocks FIRST
            deepFilterThinkingBlocks(req, signatureSessionKey, getCachedSignature, true);

            // Step 2: THEN inject signed thinking from cache (after stripping)
            if (isClaudeThinking && Array.isArray((req as any).contents)) {
              (req as any).contents = ensureThinkingBeforeToolUseInContents((req as any).contents, signatureSessionKey);
            }
            if (isClaudeThinking && Array.isArray((req as any).messages)) {
              (req as any).messages = ensureThinkingBeforeToolUseInMessages((req as any).messages, signatureSessionKey);
            }

            // Step 3: Apply tool pairing fixes (ID assignment, response matching, orphan recovery)
            applyToolPairingFixes(req as Record<string, unknown>, true);
          }
        }

        if (isClaudeThinking && sessionId) {
          const hasToolUse = requestObjects.some((req) =>
            (Array.isArray((req as any).contents) && hasToolUseInContents((req as any).contents)) ||
            (Array.isArray((req as any).messages) && hasToolUseInMessages((req as any).messages)),
          );
          const hasSignedThinking = requestObjects.some((req) =>
            (Array.isArray((req as any).contents) && hasSignedThinkingInContents((req as any).contents)) ||
            (Array.isArray((req as any).messages) && hasSignedThinkingInMessages((req as any).messages)),
          );
          const hasCachedThinking = defaultSignatureStore.has(signatureSessionKey);
          needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking;
        }

        body = JSON.stringify(wrappedBody);
      } else {
        const requestPayload: Record<string, unknown> = { ...parsedBody };

        const rawGenerationConfig = requestPayload.generationConfig as Record<string, unknown> | undefined;
        const extraBody = requestPayload.extra_body as Record<string, unknown> | undefined;

        const variantConfig = extractVariantThinkingConfig(
          requestPayload.providerOptions as Record<string, unknown> | undefined
        );
        const isGemini3 = effectiveModel.toLowerCase().includes("gemini-3");

        if (variantConfig?.thinkingLevel && isGemini3) {
          // Gemini 3 native format - use thinkingLevel directly
          tierThinkingLevel = variantConfig.thinkingLevel;
          tierThinkingBudget = undefined;
        } else if (variantConfig?.thinkingBudget) {
          if (isGemini3) {
            // Legacy format for Gemini 3 - convert with deprecation warning
            log.warn("[Deprecated] Using thinkingBudget for Gemini 3 model. Use thinkingLevel instead.");
            tierThinkingLevel = variantConfig.thinkingBudget <= 8192 ? "low"
              : variantConfig.thinkingBudget <= 16384 ? "medium" : "high";
            tierThinkingBudget = undefined;
          } else {
            // Claude / Gemini 2.5 - use budget directly
            tierThinkingBudget = variantConfig.thinkingBudget;
            tierThinkingLevel = undefined;
          }
        }

        if (isClaude) {
          if (!requestPayload.toolConfig) {
            requestPayload.toolConfig = {};
          }
          if (typeof requestPayload.toolConfig === "object" && requestPayload.toolConfig !== null) {
            const toolConfig = requestPayload.toolConfig as Record<string, unknown>;
            if (!toolConfig.functionCallingConfig) {
              toolConfig.functionCallingConfig = {};
            }
            if (typeof toolConfig.functionCallingConfig === "object" && toolConfig.functionCallingConfig !== null) {
              (toolConfig.functionCallingConfig as Record<string, unknown>).mode = "VALIDATED";
            }
          }
        }

        // Resolve thinking configuration based on user settings and model capabilities
        // Image generation models don't support thinking - skip thinking config entirely
        const isImageModel = isImageGenerationModel(effectiveModel);
        const userThinkingConfig = isImageModel ? undefined : extractThinkingConfig(requestPayload, rawGenerationConfig, extraBody);
        const hasAssistantHistory = Array.isArray(requestPayload.contents) &&
          requestPayload.contents.some((c: any) => c?.role === "model" || c?.role === "assistant");

        // For claude-sonnet-4-5 (without -thinking suffix), ignore client's thinkingConfig
        // Only claude-sonnet-4-5-thinking-* variants should have thinking enabled
        const isClaudeSonnetNonThinking = effectiveModel.toLowerCase() === "claude-sonnet-4-5";
        const effectiveUserThinkingConfig = (isClaudeSonnetNonThinking || isImageModel) ? undefined : userThinkingConfig;

        // For image models, add imageConfig instead of thinkingConfig
        if (isImageModel) {
          const imageConfig = buildImageGenerationConfig();
          const generationConfig = (rawGenerationConfig ?? {}) as Record<string, unknown>;
          generationConfig.imageConfig = imageConfig;
          // Remove any thinkingConfig that might have been set
          delete generationConfig.thinkingConfig;
          // Set reasonable defaults for image generation
          if (!generationConfig.candidateCount) {
            generationConfig.candidateCount = 1;
          }
          requestPayload.generationConfig = generationConfig;

          // Add safety settings for image generation (permissive to allow creative content)
          if (!requestPayload.safetySettings) {
            requestPayload.safetySettings = [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_ONLY_HIGH" },
            ];
          }

          // Image models don't support tools - remove them entirely
          delete requestPayload.tools;
          delete requestPayload.toolConfig;

          // Replace system instruction with a simple image generation prompt
          // Image models should not receive agentic coding assistant instructions
          requestPayload.systemInstruction = {
            parts: [{ text: "You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request." }]
          };
        } else {
          const finalThinkingConfig = resolveThinkingConfig(
            effectiveUserThinkingConfig,
            isClaudeSonnetNonThinking ? false : (resolved.isThinkingModel ?? isThinkingCapableModel(effectiveModel)),
            isClaude,
            hasAssistantHistory,
          );

          const normalizedThinking = normalizeThinkingConfig(finalThinkingConfig);
          if (normalizedThinking) {
            // Use tier-based thinking budget if specified via model suffix, otherwise fall back to user config
            const thinkingBudget = tierThinkingBudget ?? normalizedThinking.thinkingBudget;

            // Build thinking config based on model type
            let thinkingConfig: Record<string, unknown>;

            if (isClaudeThinking) {
              // Claude uses snake_case keys
              thinkingConfig = {
                include_thoughts: normalizedThinking.includeThoughts ?? true,
                ...(typeof thinkingBudget === "number" && thinkingBudget > 0
                  ? { thinking_budget: thinkingBudget }
                  : {}),
              };
            } else if (tierThinkingLevel) {
              // Gemini 3 uses thinkingLevel string (low/medium/high)
              thinkingConfig = {
                includeThoughts: normalizedThinking.includeThoughts,
                thinkingLevel: tierThinkingLevel,
              };
            } else {
              // Gemini 2.5 and others use numeric budget
              thinkingConfig = {
                includeThoughts: normalizedThinking.includeThoughts,
                ...(typeof thinkingBudget === "number" && thinkingBudget > 0 ? { thinkingBudget } : {}),
              };
            }

            if (rawGenerationConfig) {
              rawGenerationConfig.thinkingConfig = thinkingConfig;

              if (isClaudeThinking && typeof thinkingBudget === "number" && thinkingBudget > 0) {
                const currentMax = (rawGenerationConfig.maxOutputTokens ?? rawGenerationConfig.max_output_tokens) as number | undefined;
                if (!currentMax || currentMax <= thinkingBudget) {
                  rawGenerationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
                  if (rawGenerationConfig.max_output_tokens !== undefined) {
                    delete rawGenerationConfig.max_output_tokens;
                  }
                }
              }

              requestPayload.generationConfig = rawGenerationConfig;
            } else {
              const generationConfig: Record<string, unknown> = { thinkingConfig };

              if (isClaudeThinking && typeof thinkingBudget === "number" && thinkingBudget > 0) {
                generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
              }

              requestPayload.generationConfig = generationConfig;
            }
          } else if (rawGenerationConfig?.thinkingConfig) {
            delete rawGenerationConfig.thinkingConfig;
            requestPayload.generationConfig = rawGenerationConfig;
          }
        } // End of else block for non-image models

        // Clean up thinking fields from extra_body
        if (extraBody) {
          delete extraBody.thinkingConfig;
          delete extraBody.thinking;
        }
        delete requestPayload.thinkingConfig;
        delete requestPayload.thinking;

        if ("system_instruction" in requestPayload) {
          requestPayload.systemInstruction = requestPayload.system_instruction;
          delete requestPayload.system_instruction;
        }

        if (isClaudeThinking && Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0) {
          const hint = "Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.";
          const existing = requestPayload.systemInstruction;

          if (typeof existing === "string") {
            requestPayload.systemInstruction = existing.trim().length > 0 ? `${existing}\n\n${hint}` : hint;
          } else if (existing && typeof existing === "object") {
            const sys = existing as Record<string, unknown>;
            const partsValue = sys.parts;

            if (Array.isArray(partsValue)) {
              const parts = partsValue as unknown[];
              let appended = false;

              for (let i = parts.length - 1; i >= 0; i--) {
                const part = parts[i];
                if (part && typeof part === "object") {
                  const partRecord = part as Record<string, unknown>;
                  const text = partRecord.text;
                  if (typeof text === "string") {
                    partRecord.text = `${text}\n\n${hint}`;
                    appended = true;
                    break;
                  }
                }
              }

              if (!appended) {
                parts.push({ text: hint });
              }
            } else {
              sys.parts = [{ text: hint }];
            }

            requestPayload.systemInstruction = sys;
          } else if (Array.isArray(requestPayload.contents)) {
            requestPayload.systemInstruction = { parts: [{ text: hint }] };
          }
        }

        const cachedContentFromExtra =
          typeof requestPayload.extra_body === "object" && requestPayload.extra_body
            ? (requestPayload.extra_body as Record<string, unknown>).cached_content ??
            (requestPayload.extra_body as Record<string, unknown>).cachedContent
            : undefined;
        const cachedContent =
          (requestPayload.cached_content as string | undefined) ??
          (requestPayload.cachedContent as string | undefined) ??
          (cachedContentFromExtra as string | undefined);
        if (cachedContent) {
          requestPayload.cachedContent = cachedContent;
        }

        delete requestPayload.cached_content;
        delete requestPayload.cachedContent;
        if (requestPayload.extra_body && typeof requestPayload.extra_body === "object") {
          delete (requestPayload.extra_body as Record<string, unknown>).cached_content;
          delete (requestPayload.extra_body as Record<string, unknown>).cachedContent;
          if (Object.keys(requestPayload.extra_body as Record<string, unknown>).length === 0) {
            delete requestPayload.extra_body;
          }
        }

        // Normalize tools. For Claude models, keep full function declarations (names + schemas).
        const hasTools = Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0;

        if (hasTools) {
          if (isClaude) {
            const functionDeclarations: any[] = [];
            const passthroughTools: any[] = [];

            const normalizeSchema = (schema: any) => {
              const createPlaceholderSchema = (base: any = {}) => ({
                ...base,
                type: "object",
                properties: {
                  [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                    type: "boolean",
                    description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
                  },
                },
                required: [EMPTY_SCHEMA_PLACEHOLDER_NAME],
              });

              if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
                toolDebugMissing += 1;
                return createPlaceholderSchema();
              }

              const cleaned = cleanJSONSchemaForAntigravity(schema);

              if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
                toolDebugMissing += 1;
                return createPlaceholderSchema();
              }

              // Claude VALIDATED mode requires tool parameters to be an object schema
              // with at least one property.
              const hasProperties =
                cleaned.properties &&
                typeof cleaned.properties === "object" &&
                Object.keys(cleaned.properties).length > 0;

              cleaned.type = "object";

              if (!hasProperties) {
                cleaned.properties = {
                  [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                    type: "boolean",
                    description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
                  },
                };
                cleaned.required = Array.isArray(cleaned.required)
                  ? Array.from(new Set([...cleaned.required, EMPTY_SCHEMA_PLACEHOLDER_NAME]))
                  : [EMPTY_SCHEMA_PLACEHOLDER_NAME];
              }

              return cleaned;
            };

            (requestPayload.tools as any[]).forEach((tool: any) => {
              const pushDeclaration = (decl: any, source: string) => {
                const schema =
                  decl?.parameters ||
                  decl?.parametersJsonSchema ||
                  decl?.input_schema ||
                  decl?.inputSchema ||
                  tool.parameters ||
                  tool.parametersJsonSchema ||
                  tool.input_schema ||
                  tool.inputSchema ||
                  tool.function?.parameters ||
                  tool.function?.parametersJsonSchema ||
                  tool.function?.input_schema ||
                  tool.function?.inputSchema ||
                  tool.custom?.parameters ||
                  tool.custom?.parametersJsonSchema ||
                  tool.custom?.input_schema;

                let name =
                  decl?.name ||
                  tool.name ||
                  tool.function?.name ||
                  tool.custom?.name ||
                  `tool-${functionDeclarations.length}`;

                // Sanitize tool name: must be alphanumeric with underscores, no special chars
                name = String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

                const description =
                  decl?.description ||
                  tool.description ||
                  tool.function?.description ||
                  tool.custom?.description ||
                  "";

                functionDeclarations.push({
                  name,
                  description: String(description || ""),
                  parameters: normalizeSchema(schema),
                });

                toolDebugSummaries.push(
                  `decl=${name},src=${source},hasSchema=${schema ? "y" : "n"}`,
                );
              };

              if (Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0) {
                tool.functionDeclarations.forEach((decl: any) => pushDeclaration(decl, "functionDeclarations"));
                return;
              }

              // Fall back to function/custom style definitions.
              if (
                tool.function ||
                tool.custom ||
                tool.parameters ||
                tool.input_schema ||
                tool.inputSchema
              ) {
                pushDeclaration(tool.function ?? tool.custom ?? tool, "function/custom");
                return;
              }

              // Preserve any non-function tool entries (e.g., codeExecution) untouched.
              passthroughTools.push(tool);
            });

            const finalTools: any[] = [];
            if (functionDeclarations.length > 0) {
              finalTools.push({ functionDeclarations });
            }
            requestPayload.tools = finalTools.concat(passthroughTools);
          } else {
            // Gemini-specific tool normalization and feature injection
            const geminiResult = applyGeminiTransforms(requestPayload, {
              model: effectiveModel,
              normalizedThinking: undefined, // Thinking config already applied above (lines 816-880)
              tierThinkingBudget,
              tierThinkingLevel: tierThinkingLevel as ThinkingTier | undefined,
            });

            toolDebugMissing = geminiResult.toolDebugMissing;
            toolDebugSummaries.push(...geminiResult.toolDebugSummaries);
          }

          try {
            toolDebugPayload = JSON.stringify(requestPayload.tools);
          } catch {
            toolDebugPayload = undefined;
          }

          // Apply Claude tool hardening (ported from LLM-API-Key-Proxy)
          // Injects parameter signatures into descriptions and adds system instruction
          // Can be disabled via config.claude_tool_hardening = false to reduce context size
          const enableToolHardening = options?.claudeToolHardening ?? true;
          if (enableToolHardening && isClaude && Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0) {
            // Inject parameter signatures into tool descriptions
            requestPayload.tools = injectParameterSignatures(
              requestPayload.tools,
              CLAUDE_DESCRIPTION_PROMPT,
            );

            // Inject tool hardening system instruction
            injectToolHardeningInstruction(
              requestPayload as Record<string, unknown>,
              CLAUDE_TOOL_SYSTEM_INSTRUCTION,
            );
          }
        }

        const conversationKey = resolveConversationKey(requestPayload);
        signatureSessionKey = buildSignatureSessionKey(PLUGIN_SESSION_ID, effectiveModel, conversationKey, resolveProjectKey(projectId));

        // For Claude models, filter out unsigned thinking blocks (required by Claude API)
        // Attempts to restore signatures from cache for multi-turn conversations
        // Handle both Gemini-style contents[] and Anthropic-style messages[] payloads.
        if (isClaude) {
          // Step 0: Sanitize cross-model metadata (strips Gemini signatures when sending to Claude)
          sanitizeCrossModelPayloadInPlace(requestPayload, { targetModel: effectiveModel });

          // Step 1: Strip corrupted/unsigned thinking blocks FIRST
          deepFilterThinkingBlocks(requestPayload, signatureSessionKey, getCachedSignature, true);

          // Step 2: THEN inject signed thinking from cache (after stripping)
          if (isClaudeThinking && Array.isArray(requestPayload.contents)) {
            requestPayload.contents = ensureThinkingBeforeToolUseInContents(requestPayload.contents, signatureSessionKey);
          }
          if (isClaudeThinking && Array.isArray(requestPayload.messages)) {
            requestPayload.messages = ensureThinkingBeforeToolUseInMessages(requestPayload.messages, signatureSessionKey);
          }

          // Step 3: Check if warmup needed (AFTER injection attempt)
          if (isClaudeThinking) {
            const hasToolUse =
              (Array.isArray(requestPayload.contents) && hasToolUseInContents(requestPayload.contents)) ||
              (Array.isArray(requestPayload.messages) && hasToolUseInMessages(requestPayload.messages));
            const hasSignedThinking =
              (Array.isArray(requestPayload.contents) && hasSignedThinkingInContents(requestPayload.contents)) ||
              (Array.isArray(requestPayload.messages) && hasSignedThinkingInMessages(requestPayload.messages));
            const hasCachedThinking = defaultSignatureStore.has(signatureSessionKey);
            needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking;
          }
        }

        // For Claude models, ensure functionCall/tool use parts carry IDs (required by Anthropic).
        // We use a two-pass approach: first collect all functionCalls and assign IDs,
        // then match functionResponses to their corresponding calls using a FIFO queue per function name.
        if (isClaude && Array.isArray(requestPayload.contents)) {
          let toolCallCounter = 0;
          // Track pending call IDs per function name as a FIFO queue
          const pendingCallIdsByName = new Map<string, string[]>();

          // First pass: assign IDs to all functionCalls and collect them
          requestPayload.contents = requestPayload.contents.map((content: any) => {
            if (!content || !Array.isArray(content.parts)) {
              return content;
            }

            const newParts = content.parts.map((part: any) => {
              if (part && typeof part === "object" && part.functionCall) {
                const call = { ...part.functionCall };
                if (!call.id) {
                  call.id = `tool-call-${++toolCallCounter}`;
                }
                const nameKey = typeof call.name === "string" ? call.name : `tool-${toolCallCounter}`;
                // Push to the queue for this function name
                const queue = pendingCallIdsByName.get(nameKey) || [];
                queue.push(call.id);
                pendingCallIdsByName.set(nameKey, queue);
                return { ...part, functionCall: call };
              }
              return part;
            });

            return { ...content, parts: newParts };
          });

          // Second pass: match functionResponses to their corresponding calls (FIFO order)
          requestPayload.contents = (requestPayload.contents as any[]).map((content: any) => {
            if (!content || !Array.isArray(content.parts)) {
              return content;
            }

            const newParts = content.parts.map((part: any) => {
              if (part && typeof part === "object" && part.functionResponse) {
                const resp = { ...part.functionResponse };
                if (!resp.id && typeof resp.name === "string") {
                  const queue = pendingCallIdsByName.get(resp.name);
                  if (queue && queue.length > 0) {
                    // Consume the first pending ID (FIFO order)
                    resp.id = queue.shift();
                    pendingCallIdsByName.set(resp.name, queue);
                  }
                }
                return { ...part, functionResponse: resp };
              }
              return part;
            });

            return { ...content, parts: newParts };
          });

          // Third pass: Apply orphan recovery for mismatched tool IDs
          // This handles cases where context compaction or other processes
          // create ID mismatches between calls and responses.
          // Ported from LLM-API-Key-Proxy's _fix_tool_response_grouping()
          requestPayload.contents = fixToolResponseGrouping(requestPayload.contents as any[]);
        }

        // Fourth pass: Fix Claude format tool pairing (defense in depth)
        // Handles orphaned tool_use blocks in Claude's messages[] format
        if (Array.isArray(requestPayload.messages)) {
          requestPayload.messages = validateAndFixClaudeToolPairing(requestPayload.messages);
        }

        // =====================================================================
        // LAST RESORT RECOVERY: "Let it crash and start again"
        // =====================================================================
        // If after all our processing we're STILL in a bad state (tool loop without
        // thinking at turn start), don't try to fix it - just close the turn and
        // start fresh. This prevents permanent session breakage.
        //
        // This handles cases where:
        // - Context compaction stripped thinking blocks
        // - Signature cache miss
        // - Any other corruption we couldn't repair
        // - API error indicated thinking_block_order issue (forceThinkingRecovery=true)
        //
        // The synthetic messages allow Claude to generate fresh thinking on the
        // new turn instead of failing with "Expected thinking but found text".
        if (isClaudeThinking && Array.isArray(requestPayload.contents)) {
          const conversationState = analyzeConversationState(requestPayload.contents);

          // Force recovery if API returned thinking_block_order error (retry case)
          // or if proactive check detects we need recovery
          if (forceThinkingRecovery || needsThinkingRecovery(conversationState)) {
            // Set message for toast notification (shown in plugin.ts, respects quiet mode)
            thinkingRecoveryMessage = forceThinkingRecovery
              ? "Thinking recovery: retrying with fresh turn (API error)"
              : "Thinking recovery: restarting turn (corrupted context)";

            requestPayload.contents = closeToolLoopForThinking(requestPayload.contents);

            defaultSignatureStore.delete(signatureSessionKey);
          }
        }

        if ("model" in requestPayload) {
          delete requestPayload.model;
        }

        stripInjectedDebugFromRequestPayload(requestPayload);

        const effectiveProjectId = projectId?.trim() || generateSyntheticProjectId();
        resolvedProjectId = effectiveProjectId;

        // Inject Antigravity system instruction with role "user" (CLIProxyAPI v6.6.89 compatibility)
        // This sets request.systemInstruction.role = "user" and request.systemInstruction.parts[0].text
        if (headerStyle === "antigravity") {
          const existingSystemInstruction = requestPayload.systemInstruction;
          if (existingSystemInstruction && typeof existingSystemInstruction === "object") {
            const sys = existingSystemInstruction as Record<string, unknown>;
            sys.role = "user";
            if (Array.isArray(sys.parts) && sys.parts.length > 0) {
              const firstPart = sys.parts[0] as Record<string, unknown>;
              if (firstPart && typeof firstPart.text === "string") {
                firstPart.text = ANTIGRAVITY_SYSTEM_INSTRUCTION + "\n\n" + firstPart.text;
              } else {
                sys.parts = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...sys.parts];
              }
            } else {
              sys.parts = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }];
            }
          } else if (typeof existingSystemInstruction === "string") {
            requestPayload.systemInstruction = {
              role: "user",
              parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION + "\n\n" + existingSystemInstruction }],
            };
          } else {
            requestPayload.systemInstruction = {
              role: "user",
              parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }],
            };
          }
        }

        const wrappedBody = {
          project: effectiveProjectId,
          model: effectiveModel,
          request: requestPayload,
          requestType: "agent",
        };

        Object.assign(wrappedBody, {
          userAgent: "antigravity",
          requestId: "agent-" + crypto.randomUUID(),
        });
        if (wrappedBody.request && typeof wrappedBody.request === 'object') {
          // Use stable session ID for signature caching across multi-turn conversations
          sessionId = signatureSessionKey;
          (wrappedBody.request as any).sessionId = signatureSessionKey;
        }

        body = JSON.stringify(wrappedBody);
      }
    } catch (error) {
      throw error;
    }
  }

  if (streaming) {
    headers.set("Accept", "text/event-stream");
  }

  // Add interleaved thinking header for Claude thinking models
  // This enables real-time streaming of thinking tokens
  if (isClaudeThinking) {
    const existing = headers.get("anthropic-beta");
    const interleavedHeader = "interleaved-thinking-2025-05-14";

    if (existing) {
      if (!existing.includes(interleavedHeader)) {
        headers.set("anthropic-beta", `${existing},${interleavedHeader}`);
      }
    } else {
      headers.set("anthropic-beta", interleavedHeader);
    }
  }

  // Use randomized headers as the fallback pool
  const selectedHeaders = getRandomizedHeaders(headerStyle);

  if (headerStyle === "antigravity") {
    // Antigravity mode: Use fingerprint headers for device identity and quota tracking
    // Fingerprint headers override randomized headers for User-Agent, X-Goog-Api-Client, Client-Metadata
    // and add X-Goog-QuotaUser, X-Client-Device-Id for unique device identity
    const fingerprint = options?.fingerprint ?? getSessionFingerprint();
    const fingerprintHeaders = buildFingerprintHeaders(fingerprint);

    // Apply fingerprint headers (override randomized with fingerprint if available)
    headers.set("User-Agent", fingerprintHeaders["User-Agent"] || selectedHeaders["User-Agent"]);
    headers.set("X-Goog-Api-Client", fingerprintHeaders["X-Goog-Api-Client"] || selectedHeaders["X-Goog-Api-Client"]);
    headers.set("Client-Metadata", fingerprintHeaders["Client-Metadata"] || selectedHeaders["Client-Metadata"]);

    // Add fingerprint-specific headers for device identity (Antigravity only)
    if (fingerprintHeaders["X-Goog-QuotaUser"]) {
      headers.set("X-Goog-QuotaUser", fingerprintHeaders["X-Goog-QuotaUser"]);
    }
    if (fingerprintHeaders["X-Client-Device-Id"]) {
      headers.set("X-Client-Device-Id", fingerprintHeaders["X-Client-Device-Id"]);
    }
  } else {
    // Gemini CLI mode: Use simple static headers matching opencode-gemini-auth
    // NO fingerprint headers, NO X-Goog-QuotaUser, NO X-Client-Device-Id
    // This mirrors exactly what https://github.com/jenslys/opencode-gemini-auth does
    headers.set("User-Agent", selectedHeaders["User-Agent"]);
    headers.set("X-Goog-Api-Client", selectedHeaders["X-Goog-Api-Client"]);
    headers.set("Client-Metadata", selectedHeaders["Client-Metadata"]);
  }
  // Optional debug header to observe tool normalization on the backend if surfaced
  if (toolDebugMissing > 0) {
    headers.set("X-Opencode-Tools-Debug", String(toolDebugMissing));
  }

  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body,
    },
    streaming,
    requestedModel,
    effectiveModel: effectiveModel,
    projectId: resolvedProjectId,
    endpoint: transformedUrl,
    sessionId,
    toolDebugMissing,
    toolDebugSummary: toolDebugSummaries.slice(0, 20).join(" | "),
    toolDebugPayload,
    needsSignedThinkingWarmup,
    headerStyle,
    thinkingRecoveryMessage,
  };
}

export function buildThinkingWarmupBody(
  bodyText: string | undefined,
  isClaudeThinking: boolean,
): string | null {
  if (!bodyText || !isClaudeThinking) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return null;
  }

  const warmupPrompt = "Warmup request for thinking signature.";

  const updateRequest = (req: Record<string, unknown>) => {
    req.contents = [{ role: "user", parts: [{ text: warmupPrompt }] }];
    delete req.tools;
    delete (req as any).toolConfig;

    const generationConfig = (req.generationConfig ?? {}) as Record<string, unknown>;
    generationConfig.thinkingConfig = {
      include_thoughts: true,
      thinking_budget: DEFAULT_THINKING_BUDGET,
    };
    generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
    req.generationConfig = generationConfig;
  };

  if (parsed.request && typeof parsed.request === "object") {
    updateRequest(parsed.request as Record<string, unknown>);
    const nested = (parsed.request as any).request;
    if (nested && typeof nested === "object") {
      updateRequest(nested as Record<string, unknown>);
    }
  } else {
    updateRequest(parsed);
  }

  return JSON.stringify(parsed);
}

/**
 * Normalizes Antigravity responses: applies retry headers, extracts cache usage into headers,
 * rewrites preview errors, flattens streaming payloads, and logs debug metadata.
 *
 * For streaming SSE responses, uses TransformStream for true real-time incremental streaming.
 * Thinking/reasoning tokens are transformed and forwarded immediately as they arrive.
 */
export async function transformAntigravityResponse(
  response: Response,
  streaming: boolean,
  debugContext?: AntigravityDebugContext | null,
  requestedModel?: string,
  projectId?: string,
  endpoint?: string,
  effectiveModel?: string,
  sessionId?: string,
  toolDebugMissing?: number,
  toolDebugSummary?: string,
  toolDebugPayload?: string,
  debugLines?: string[],
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");

  // Generate text for thinking injection:
  // - If debug=true: inject full debug logs
  // - If keep_thinking=true (but no debug): inject placeholder to trigger signature caching
  // Both use the same injection path (injectDebugThinking) for consistent behavior
  const debugText =
    isDebugEnabled() && Array.isArray(debugLines) && debugLines.length > 0
      ? formatDebugLinesForThinking(debugLines)
      : getKeepThinking()
        ? SYNTHETIC_THINKING_PLACEHOLDER
        : undefined;
  const cacheSignatures = shouldCacheThinkingSignatures(effectiveModel);

  if (!isJsonResponse && !isEventStreamResponse) {
    logAntigravityDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)",
    });
    return response;
  }

  // For successful streaming responses, use TransformStream to transform SSE events
  // while maintaining real-time streaming (no buffering of entire response).
  // This enables thinking tokens to be displayed as they arrive, like the Codex plugin.
  if (streaming && response.ok && isEventStreamResponse && response.body) {
    const headers = new Headers(response.headers);

    logAntigravityDebugResponse(debugContext, response, {
      note: "Streaming SSE response (real-time transform)",
    });

    const streamingTransformer = createStreamingTransformer(
      defaultSignatureStore,
      {
        onCacheSignature: cacheSignature,
        onInjectDebug: injectDebugThinking,
        // onInjectSyntheticThinking removed - keep_thinking now uses debugText path
        transformThinkingParts,
      },
      {
        signatureSessionKey: sessionId,
        debugText,
        cacheSignatures,
        displayedThinkingHashes: effectiveModel && isGemini3Model(effectiveModel) ? sessionDisplayedThinkingHashes : undefined,
        // injectSyntheticThinking removed - keep_thinking now unified with debug via debugText
      },
    );
    return new Response(response.body.pipeThrough(streamingTransformer), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  try {
    const headers = new Headers(response.headers);
    const text = await response.text();

    if (!response.ok) {
      let errorBody;
      try {
        errorBody = JSON.parse(text);
      } catch {
        errorBody = { error: { message: text } };
      }

      // Inject Debug Info
      if (errorBody?.error) {
        const debugInfo = `\n\n[Debug Info]\nRequested Model: ${requestedModel || "Unknown"}\nEffective Model: ${effectiveModel || "Unknown"}\nProject: ${projectId || "Unknown"}\nEndpoint: ${endpoint || "Unknown"}\nStatus: ${response.status}\nRequest ID: ${headers.get("x-request-id") || "N/A"}${toolDebugMissing !== undefined ? `\nTool Debug Missing: ${toolDebugMissing}` : ""}${toolDebugSummary ? `\nTool Debug Summary: ${toolDebugSummary}` : ""}${toolDebugPayload ? `\nTool Debug Payload: ${toolDebugPayload}` : ""}`;
        const injectedDebug = debugText ? `\n\n${debugText}` : "";
        errorBody.error.message = (errorBody.error.message || "Unknown error") + debugInfo + injectedDebug;

        // Check if this is a recoverable thinking error - throw to trigger retry
        const errorType = detectErrorType(errorBody.error.message || "");
        if (errorType === "thinking_block_order") {
          const recoveryError = new Error("THINKING_RECOVERY_NEEDED");
          (recoveryError as any).recoveryType = errorType;
          (recoveryError as any).originalError = errorBody;
          (recoveryError as any).debugInfo = debugInfo;
          throw recoveryError;
        }

        // Detect context length / prompt too long errors - signal to caller for toast
        const errorMessage = errorBody.error.message?.toLowerCase() || "";
        if (
          errorMessage.includes("prompt is too long") ||
          errorMessage.includes("context length exceeded") ||
          errorMessage.includes("context_length_exceeded") ||
          errorMessage.includes("maximum context length")
        ) {
          headers.set("x-antigravity-context-error", "prompt_too_long");
        }

        // Detect tool pairing errors - signal to caller for toast
        if (
          errorMessage.includes("tool_use") &&
          errorMessage.includes("tool_result") &&
          (errorMessage.includes("without") || errorMessage.includes("immediately after"))
        ) {
          headers.set("x-antigravity-context-error", "tool_pairing");
        }

        return new Response(JSON.stringify(errorBody), {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }

      if (errorBody?.error?.details && Array.isArray(errorBody.error.details)) {
        const retryInfo = errorBody.error.details.find(
          (detail: any) => detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
        );

        if (retryInfo?.retryDelay) {
          const match = retryInfo.retryDelay.match(/^([\d.]+)s$/);
          if (match && match[1]) {
            const retrySeconds = parseFloat(match[1]);
            if (!isNaN(retrySeconds) && retrySeconds > 0) {
              const retryAfterSec = Math.ceil(retrySeconds).toString();
              const retryAfterMs = Math.ceil(retrySeconds * 1000).toString();
              headers.set('Retry-After', retryAfterSec);
              headers.set('retry-after-ms', retryAfterMs);
            }
          }
        }
      }
    }

    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    };

    const usageFromSse = streaming && isEventStreamResponse ? extractUsageFromSsePayload(text) : null;
    const parsed: AntigravityApiBody | null = !streaming || !isEventStreamResponse ? parseAntigravityApiBody(text) : null;
    const patched = parsed ? rewriteAntigravityPreviewAccessError(parsed, response.status, requestedModel) : null;
    const effectiveBody = patched ?? parsed ?? undefined;

    const usage = usageFromSse ?? (effectiveBody ? extractUsageMetadata(effectiveBody) : null);
    
    // Log cache stats when available
    if (usage && effectiveModel) {
      logCacheStats(
        effectiveModel,
        usage.cachedContentTokenCount ?? 0,
        0, // API doesn't provide cache write tokens separately
        usage.promptTokenCount ?? usage.totalTokenCount ?? 0,
      );
    }
    
    if (usage?.cachedContentTokenCount !== undefined) {
      headers.set("x-antigravity-cached-content-token-count", String(usage.cachedContentTokenCount));
      if (usage.totalTokenCount !== undefined) {
        headers.set("x-antigravity-total-token-count", String(usage.totalTokenCount));
      }
      if (usage.promptTokenCount !== undefined) {
        headers.set("x-antigravity-prompt-token-count", String(usage.promptTokenCount));
      }
      if (usage.candidatesTokenCount !== undefined) {
        headers.set("x-antigravity-candidates-token-count", String(usage.candidatesTokenCount));
      }
    }

    logAntigravityDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload (buffered fallback)" : undefined,
      headersOverride: headers,
    });

    // Note: successful streaming responses are handled above via TransformStream.
    // This path only handles non-streaming responses or failed streaming responses.

    if (!parsed) {
      return new Response(text, init);
    }

    if (effectiveBody?.response !== undefined) {
      let responseBody: unknown = effectiveBody.response;
      // Inject thinking text (debug logs or "[Thinking preserved]" placeholder)
      // Both debug=true and keep_thinking=true use the same path now
      if (debugText) {
        responseBody = injectDebugThinking(responseBody, debugText);
      }
      const transformed = transformThinkingParts(responseBody);
      return new Response(JSON.stringify(transformed), init);
    }

    if (patched) {
      return new Response(JSON.stringify(patched), init);
    }

    return new Response(text, init);
  } catch (error) {
    logAntigravityDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Antigravity response",
    });
    return response;
  }
}

export const __testExports = {
  buildSignatureSessionKey,
  hashConversationSeed,
  extractTextFromContent,
  extractConversationSeedFromMessages,
  extractConversationSeedFromContents,
  resolveConversationKey,
  resolveProjectKey,
  isGeminiToolUsePart,
  isGeminiThinkingPart,
  ensureThoughtSignature,
  hasSignedThinkingPart,
  hasSignedThinkingInContents,
  hasSignedThinkingInMessages,
  hasToolUseInContents,
  hasToolUseInMessages,
  ensureThinkingBeforeToolUseInContents,
  ensureThinkingBeforeToolUseInMessages,
  generateSyntheticProjectId,
  MIN_SIGNATURE_LENGTH,
  transformSseLine,
  transformStreamingPayload,
  createStreamingTransformer,
};

