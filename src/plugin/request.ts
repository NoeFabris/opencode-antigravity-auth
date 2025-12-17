import crypto from "node:crypto";
import {
  ANTIGRAVITY_HEADERS,
  ANTIGRAVITY_ENDPOINT,
} from "../constants";
import { cacheSignature, getCachedSignature } from "./cache";
import {
  DEBUG_MESSAGE_PREFIX,
  isDebugEnabled,
  logAntigravityDebugResponse,
  type AntigravityDebugContext,
} from "./debug";
import {
  DEFAULT_THINKING_BUDGET,
  extractThinkingConfig,
  extractUsageFromSsePayload,
  extractUsageMetadata,
  filterUnsignedThinkingBlocks,
  filterMessagesThinkingBlocks,
  isGemini3Model,
  normalizeThinkingConfig,
  parseAntigravityApiBody,
  resolveThinkingConfig,
  rewriteAntigravityPreviewAccessError,
  transformThinkingParts,
  type AntigravityApiBody,
} from "./request-helpers";

/**
 * Stable session ID for the plugin's lifetime.
 * This is used for caching thinking signatures across multi-turn conversations.
 * Generated once at plugin load time and reused for all requests.
 */
const PLUGIN_SESSION_ID = `-${crypto.randomUUID()}`;

// Claude thinking models need a sufficiently large max output token limit when thinking is enabled.
const CLAUDE_THINKING_MAX_OUTPUT_TOKENS = 64_000;

type SignedThinking = {
  text: string;
  signature: string;
};

const MIN_SIGNATURE_LENGTH = 50;
const lastSignedThinkingBySessionId = new Map<string, SignedThinking>();

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

    if (text && text.startsWith(DEBUG_MESSAGE_PREFIX)) {
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
    }
    return part;
  }

  if ((part.type === "thinking" || part.type === "reasoning") && !part.signature) {
    const cached = getCachedSignature(sessionId, text);
    if (cached) {
      return { ...part, signature: cached };
    }
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

function ensureThinkingBeforeToolUseInContents(contents: any[], sessionId: string): any[] {
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

    const thinkingParts = parts.filter(isGeminiThinkingPart).map((p) => ensureThoughtSignature(p, sessionId));
    const otherParts = parts.filter((p) => !isGeminiThinkingPart(p));
    const hasSignedThinking = thinkingParts.some(hasSignedThinkingPart);

    if (hasSignedThinking) {
      return { ...content, parts: [...thinkingParts, ...otherParts] };
    }

    const lastThinking = lastSignedThinkingBySessionId.get(sessionId);
    if (!lastThinking) {
      return content;
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

function ensureThinkingBeforeToolUseInMessages(messages: any[], sessionId: string): any[] {
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
      .map((b) => ensureMessageThinkingSignature(b, sessionId));

    const otherBlocks = blocks.filter((b) => !(b && typeof b === "object" && (b.type === "thinking" || b.type === "redacted_thinking")));
    const hasSignedThinking = thinkingBlocks.some((b) => typeof b.signature === "string" && b.signature.length >= MIN_SIGNATURE_LENGTH);

    if (hasSignedThinking) {
      return { ...message, content: [...thinkingBlocks, ...otherBlocks] };
    }

    const lastThinking = lastSignedThinkingBySessionId.get(sessionId);
    if (!lastThinking) {
      return message;
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
 * Rewrites SSE payloads so downstream consumers see only the inner `response` objects,
 * with thinking/reasoning blocks transformed to OpenCode's expected format.
 */
function transformStreamingPayload(payload: string): string {
  return payload
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) {
        return line;
      }
      const json = line.slice(5).trim();
      if (!json) {
        return line;
      }
      try {
        const parsed = JSON.parse(json) as { response?: unknown };
        if (parsed.response !== undefined) {
          const transformed = transformThinkingParts(parsed.response);
          return `data: ${JSON.stringify(transformed)}`;
        }
      } catch (_) { }
      return line;
    })
    .join("\n");
}

/**
 * Creates a TransformStream that processes SSE chunks incrementally,
 * transforming each line as it arrives for true real-time streaming support.
 * Optionally caches thinking signatures for Claude multi-turn conversations.
 */
function createStreamingTransformer(sessionId?: string, debugText?: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  // Buffer for accumulating thinking text per candidate index (for signature caching)
  const thoughtBuffer = new Map<number, string>();
  const debugState = { injected: false };

  return new TransformStream({
    transform(chunk, controller) {
      // Decode chunk with stream: true to handle multi-byte characters correctly
      buffer += decoder.decode(chunk, { stream: true });

      // Process complete lines immediately for real-time streaming
      const lines = buffer.split("\n");
      // Keep the last incomplete line in buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        // Transform and forward each line immediately
        const transformedLine = transformSseLine(line, sessionId, thoughtBuffer, debugText, debugState);
        controller.enqueue(encoder.encode(transformedLine + "\n"));
      }
    },
    flush(controller) {
      // Flush any remaining bytes from TextDecoder
      buffer += decoder.decode();

      // Process any remaining data in buffer
      if (buffer) {
        const transformedLine = transformSseLine(buffer, sessionId, thoughtBuffer, debugText, debugState);
        controller.enqueue(encoder.encode(transformedLine));
      }
    },
  });
}

/**
 * Transforms a single SSE line, extracting and transforming the inner response.
 * Optionally caches thinking signatures for Claude multi-turn support.
 */
function transformSseLine(
  line: string,
  sessionId?: string,
  thoughtBuffer?: Map<number, string>,
  debugText?: string,
  debugState?: { injected: boolean },
): string {
  if (!line.startsWith("data:")) {
    return line;
  }
  const json = line.slice(5).trim();
  if (!json) {
    return line;
  }
  try {
    const parsed = JSON.parse(json) as { response?: unknown };
    if (parsed.response !== undefined) {
      if (sessionId && thoughtBuffer) {
        cacheThinkingSignatures(parsed.response, sessionId, thoughtBuffer);
      }

      let response: unknown = parsed.response;
      if (debugText && debugState && !debugState.injected) {
        response = injectDebugThinking(response, debugText);
        debugState.injected = true;
      }

      const transformed = transformThinkingParts(response);
      return `data: ${JSON.stringify(transformed)}`;
    }
  } catch (_) { }
  return line;
}

/**
 * Extracts and caches thinking signatures from a response for Claude multi-turn support.
 */
function cacheThinkingSignatures(
  response: unknown,
  sessionId: string,
  thoughtBuffer: Map<number, string>,
): void {
  if (!response || typeof response !== "object") return;

  const resp = response as Record<string, unknown>;

  // Handle Gemini-style candidates array (Claude through Antigravity uses this format)
  if (Array.isArray(resp.candidates)) {
    resp.candidates.forEach((candidate: any, index: number) => {
      if (!candidate?.content?.parts) return;

      candidate.content.parts.forEach((part: any) => {
        // Collect thinking text
        if (part.thought === true || part.type === "thinking") {
          const text = part.text || part.thinking || "";
          if (text) {
            const current = thoughtBuffer.get(index) ?? "";
            thoughtBuffer.set(index, current + text);
          }
        }

        // Cache signature when we receive it
        if (part.thoughtSignature) {
          const fullText = thoughtBuffer.get(index) ?? "";
          if (fullText && sessionId) {
            cacheSignature(sessionId, fullText, part.thoughtSignature);
            lastSignedThinkingBySessionId.set(sessionId, { text: fullText, signature: part.thoughtSignature });
          }
        }
      });
    });
  }

  // Handle Anthropic-style content array
  if (Array.isArray(resp.content)) {
    let thinkingText = "";
    resp.content.forEach((block: any) => {
      if (block?.type === "thinking") {
        thinkingText += block.thinking || block.text || "";
      }
      if (block?.signature && thinkingText && sessionId) {
        cacheSignature(sessionId, thinkingText, block.signature);
        lastSignedThinkingBySessionId.set(sessionId, { text: thinkingText, signature: block.signature });
      }
    });
  }
}

/**
 * Rewrites OpenAI-style requests into Antigravity shape, normalizing model, headers,
 * optional cached_content, and thinking config. Also toggles streaming mode for SSE actions.
 */
export function prepareAntigravityRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
  endpointOverride?: string,
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
} {
  const baseInit: RequestInit = { ...init };
  const headers = new Headers(init?.headers ?? {});
  let resolvedProjectId = projectId?.trim() || "";
  let toolDebugMissing = 0;
  const toolDebugSummaries: string[] = [];
  let toolDebugPayload: string | undefined;
  let sessionId: string | undefined;
  let needsSignedThinkingWarmup = false;

  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
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
    };
  }

  const [, rawModel = "", rawAction = ""] = match;
  const requestedModel = rawModel;

  let upstreamModel = rawModel;
  if (upstreamModel === "gemini-2.5-flash-image") {
    upstreamModel = "gemini-2.5-flash";
  }

  const effectiveModel = upstreamModel;
  const streaming = rawAction === STREAM_ACTION;
  const baseEndpoint = endpointOverride ?? ANTIGRAVITY_ENDPOINT;
  const transformedUrl = `${baseEndpoint}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""}`;
  const isClaudeModel = upstreamModel.toLowerCase().includes("claude");
  const isClaudeThinkingModel = isClaudeModel && upstreamModel.toLowerCase().includes("thinking");

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

        if (requestObjects.length > 0) {
          sessionId = PLUGIN_SESSION_ID;
        }

        for (const req of requestObjects) {
          // Use stable session ID for signature caching across multi-turn conversations
          (req as any).sessionId = PLUGIN_SESSION_ID;
          stripInjectedDebugFromRequestPayload(req as Record<string, unknown>);

          if (isClaudeModel) {
            if (isClaudeThinkingModel && Array.isArray((req as any).contents)) {
              (req as any).contents = ensureThinkingBeforeToolUseInContents((req as any).contents, PLUGIN_SESSION_ID);
            }
            if (isClaudeThinkingModel && Array.isArray((req as any).messages)) {
              (req as any).messages = ensureThinkingBeforeToolUseInMessages((req as any).messages, PLUGIN_SESSION_ID);
            }

            if (Array.isArray((req as any).contents)) {
              (req as any).contents = filterUnsignedThinkingBlocks(
                (req as any).contents,
                PLUGIN_SESSION_ID,
                getCachedSignature,
              );
            }
            if (Array.isArray((req as any).messages)) {
              (req as any).messages = filterMessagesThinkingBlocks(
                (req as any).messages,
                PLUGIN_SESSION_ID,
                getCachedSignature,
              );
            }
          }
        }

        if (isClaudeThinkingModel && sessionId) {
          const hasToolUse = requestObjects.some((req) =>
            (Array.isArray((req as any).contents) && hasToolUseInContents((req as any).contents)) ||
            (Array.isArray((req as any).messages) && hasToolUseInMessages((req as any).messages)),
          );
          const hasSignedThinking = requestObjects.some((req) =>
            (Array.isArray((req as any).contents) && hasSignedThinkingInContents((req as any).contents)) ||
            (Array.isArray((req as any).messages) && hasSignedThinkingInMessages((req as any).messages)),
          );
          const hasCachedThinking = lastSignedThinkingBySessionId.has(sessionId);
          needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking;
        }

        body = JSON.stringify(wrappedBody);
      } else {
        const requestPayload: Record<string, unknown> = { ...parsedBody };

        const rawGenerationConfig = requestPayload.generationConfig as Record<string, unknown> | undefined;
        const extraBody = requestPayload.extra_body as Record<string, unknown> | undefined;

        if (isClaudeModel) {
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
        const userThinkingConfig = extractThinkingConfig(requestPayload, rawGenerationConfig, extraBody);
        const hasAssistantHistory = Array.isArray(requestPayload.contents) &&
          requestPayload.contents.some((c: any) => c?.role === "model" || c?.role === "assistant");

        const finalThinkingConfig = resolveThinkingConfig(
          userThinkingConfig,
          upstreamModel,
          isClaudeModel,
          hasAssistantHistory,
        );

        const normalizedThinking = normalizeThinkingConfig(finalThinkingConfig);
        if (normalizedThinking) {
          const thinkingBudget = normalizedThinking.thinkingBudget;
          const thinkingLevel = normalizedThinking.thinkingLevel;
          const isGemini3 = isGemini3Model(upstreamModel);
          const thinkingConfig: Record<string, unknown> = isClaudeThinkingModel
            ? {
              include_thoughts: normalizedThinking.includeThoughts ?? true,
              ...(typeof thinkingBudget === "number" && thinkingBudget > 0
                ? { thinking_budget: thinkingBudget }
                : {}),
            }
            : {
              includeThoughts: normalizedThinking.includeThoughts,
              ...(isGemini3
                ? (thinkingLevel
                  ? { thinkingLevel }
                  : typeof thinkingBudget === "number" && thinkingBudget > 0
                    ? { thinkingBudget }
                    : {})
                : typeof thinkingBudget === "number" && thinkingBudget > 0
                  ? { thinkingBudget }
                  : {}),
            };

          if (rawGenerationConfig) {
            rawGenerationConfig.thinkingConfig = thinkingConfig;

            if (isClaudeThinkingModel && typeof thinkingBudget === "number" && thinkingBudget > 0) {
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

            if (isClaudeThinkingModel && typeof thinkingBudget === "number" && thinkingBudget > 0) {
              generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
            }

            requestPayload.generationConfig = generationConfig;
          }
        } else if (rawGenerationConfig?.thinkingConfig) {
          delete rawGenerationConfig.thinkingConfig;
          requestPayload.generationConfig = rawGenerationConfig;
        }

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

        if (isClaudeThinkingModel && Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0) {
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
        if (Array.isArray(requestPayload.tools)) {
          if (isClaudeModel) {
            const functionDeclarations: any[] = [];
            const passthroughTools: any[] = [];

            // Sanitize schema using ALLOWLIST approach - only keep basic features needed for function calling
            // This is more aggressive than blocklisting, ensuring any unknown/unsupported features are stripped
            // See docs/ANTIGRAVITY_API_SPEC.md for full list of unsupported features
            const sanitizeSchema = (schema: any): any => {
              if (!schema || typeof schema !== "object") {
                return schema;
              }

              // Only keep these basic schema features (allowlist approach)
              // Everything else gets stripped automatically
              const ALLOWED_KEYS = new Set([
                "type",
                "properties",
                "required",
                "description",
                "enum",
                "items",
                "additionalProperties",
              ]);

              const sanitized: any = {};

              for (const key of Object.keys(schema)) {
                // Convert "const" to "enum: [value]" (const is not supported but enum is)
                if (key === "const") {
                  sanitized.enum = [schema[key]];
                  continue;
                }

                // Skip keys not in allowlist
                if (!ALLOWED_KEYS.has(key)) {
                  continue;
                }

                const value = schema[key];

                if (key === "items" && value && typeof value === "object") {
                  const sanitizedItems = sanitizeSchema(value);
                  // Empty items schema {} is invalid - convert to permissive string type
                  if (Object.keys(sanitizedItems).length === 0) {
                    sanitized.items = { type: "string" };
                  } else {
                    sanitized.items = sanitizedItems;
                  }
                } else if (key === "properties" && value && typeof value === "object") {
                  // Recursively sanitize properties
                  sanitized.properties = {};
                  for (const propKey of Object.keys(value)) {
                    sanitized.properties[propKey] = sanitizeSchema(value[propKey]);
                  }
                } else if (key === "additionalProperties" && value && typeof value === "object") {
                  sanitized.additionalProperties = sanitizeSchema(value);
                } else {
                  sanitized[key] = value;
                }
              }

              return sanitized;
            };

            const normalizeSchema = (schema: any) => {
              // Helper to create a placeholder schema for empty parameter tools
              // Antigravity API in VALIDATED mode cannot handle truly empty schemas
              // The placeholder must be REQUIRED so the model sends a non-empty args object
              const createPlaceholderSchema = (base: any = {}) => ({
                ...base,
                type: "object",
                properties: {
                  reason: {
                    type: "string",
                    description: "Brief explanation of why you are calling this tool",
                  },
                },
                required: ["reason"],
              });

              if (!schema || typeof schema !== "object") {
                toolDebugMissing += 1;
                // Fallback for tools without schemas - add dummy property for Antigravity API
                return createPlaceholderSchema();
              }

              const sanitized = sanitizeSchema(schema);

              // Check if schema is effectively empty (type: object with no properties)
              if (
                sanitized.type === "object" &&
                (!sanitized.properties || Object.keys(sanitized.properties).length === 0)
              ) {
                return createPlaceholderSchema(sanitized);
              }

              return sanitized;
            };

            requestPayload.tools.forEach((tool: any, idx: number) => {
              const pushDeclaration = (decl: any, source: string) => {
                const schema =
                  decl?.parameters ||
                  decl?.input_schema ||
                  decl?.inputSchema ||
                  tool.parameters ||
                  tool.input_schema ||
                  tool.inputSchema ||
                  tool.function?.parameters ||
                  tool.function?.input_schema ||
                  tool.function?.inputSchema ||
                  tool.custom?.parameters ||
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
            // Default normalization for non-Claude models
            requestPayload.tools = requestPayload.tools.map((tool: any, toolIndex: number) => {
              const newTool = { ...tool };

              const schemaCandidates = [
                newTool.function?.input_schema,
                newTool.function?.parameters,
                newTool.function?.inputSchema,
                newTool.custom?.input_schema,
                newTool.custom?.parameters,
                newTool.parameters,
                newTool.input_schema,
                newTool.inputSchema,
              ].filter(Boolean);
              const schema = schemaCandidates[0];

              const nameCandidate =
                newTool.name ||
                newTool.function?.name ||
                newTool.custom?.name ||
                `tool-${toolIndex}`;

              if (newTool.function && !newTool.function.input_schema && schema) {
                newTool.function.input_schema = schema;
              }
              if (newTool.custom && !newTool.custom.input_schema && schema) {
                newTool.custom.input_schema = schema;
              }
              if (!newTool.custom && newTool.function) {
                newTool.custom = {
                  name: newTool.function.name || nameCandidate,
                  description: newTool.function.description,
                  input_schema: schema ?? { type: "object", properties: {}, additionalProperties: false },
                };
              }
              if (!newTool.custom && !newTool.function) {
                newTool.custom = {
                  name: nameCandidate,
                  description: newTool.description,
                  input_schema: schema ?? { type: "object", properties: {}, additionalProperties: false },
                };
              }
              if (newTool.custom && !newTool.custom.input_schema) {
                newTool.custom.input_schema = { type: "object", properties: {}, additionalProperties: false };
                toolDebugMissing += 1;
              }

              toolDebugSummaries.push(
                `idx=${toolIndex}, hasCustom=${!!newTool.custom}, customSchema=${!!newTool.custom?.input_schema}, hasFunction=${!!newTool.function}, functionSchema=${!!newTool.function?.input_schema}`,
              );

              // Strip custom wrappers for Gemini; only function-style is accepted.
              if (newTool.custom) {
                delete newTool.custom;
              }

              return newTool;
            });
          }

          try {
            toolDebugPayload = JSON.stringify(requestPayload.tools);
          } catch {
            toolDebugPayload = undefined;
          }
        }

        // For Claude models, filter out unsigned thinking blocks (required by Claude API)
        // Attempts to restore signatures from cache for multi-turn conversations
        // Handle both Gemini-style contents[] and Anthropic-style messages[] payloads.
        if (isClaudeModel) {
          if (isClaudeThinkingModel && Array.isArray(requestPayload.contents)) {
            requestPayload.contents = ensureThinkingBeforeToolUseInContents(requestPayload.contents, PLUGIN_SESSION_ID);
          }
          if (isClaudeThinkingModel && Array.isArray(requestPayload.messages)) {
            requestPayload.messages = ensureThinkingBeforeToolUseInMessages(requestPayload.messages, PLUGIN_SESSION_ID);
          }

          if (isClaudeThinkingModel) {
            const sessionKey = PLUGIN_SESSION_ID;
            const hasToolUse =
              (Array.isArray(requestPayload.contents) && hasToolUseInContents(requestPayload.contents)) ||
              (Array.isArray(requestPayload.messages) && hasToolUseInMessages(requestPayload.messages));
            const hasSignedThinking =
              (Array.isArray(requestPayload.contents) && hasSignedThinkingInContents(requestPayload.contents)) ||
              (Array.isArray(requestPayload.messages) && hasSignedThinkingInMessages(requestPayload.messages));
            const hasCachedThinking = lastSignedThinkingBySessionId.has(sessionKey);
            needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking;
          }

          if (Array.isArray(requestPayload.contents)) {
            requestPayload.contents = filterUnsignedThinkingBlocks(
              requestPayload.contents,
              PLUGIN_SESSION_ID,
              getCachedSignature,
            );
          }
          if (Array.isArray(requestPayload.messages)) {
            requestPayload.messages = filterMessagesThinkingBlocks(
              requestPayload.messages,
              PLUGIN_SESSION_ID,
              getCachedSignature,
            );
          }
        }

        // For Claude models, ensure functionCall/tool use parts carry IDs (required by Anthropic).
        // We use a two-pass approach: first collect all functionCalls and assign IDs,
        // then match functionResponses to their corresponding calls using a FIFO queue per function name.
        if (isClaudeModel && Array.isArray(requestPayload.contents)) {
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
        }

        if ("model" in requestPayload) {
          delete requestPayload.model;
        }

        stripInjectedDebugFromRequestPayload(requestPayload);

        const effectiveProjectId = projectId?.trim() || generateSyntheticProjectId();
        resolvedProjectId = effectiveProjectId;

        const wrappedBody = {
          project: effectiveProjectId,
          model: upstreamModel,
          request: requestPayload,
        };

        // Add additional Antigravity fields
        Object.assign(wrappedBody, {
          userAgent: "antigravity",
          requestId: "agent-" + crypto.randomUUID(),
        });
        if (wrappedBody.request && typeof wrappedBody.request === 'object') {
          // Use stable session ID for signature caching across multi-turn conversations
          sessionId = PLUGIN_SESSION_ID;
          (wrappedBody.request as any).sessionId = sessionId;
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
  if (isClaudeThinkingModel) {
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

  headers.set("User-Agent", ANTIGRAVITY_HEADERS["User-Agent"]);
  headers.set("X-Goog-Api-Client", ANTIGRAVITY_HEADERS["X-Goog-Api-Client"]);
  headers.set("Client-Metadata", ANTIGRAVITY_HEADERS["Client-Metadata"]);
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
    effectiveModel: upstreamModel,
    projectId: resolvedProjectId,
    endpoint: transformedUrl,
    sessionId,
    toolDebugMissing,
    toolDebugSummary: toolDebugSummaries.slice(0, 20).join(" | "),
    toolDebugPayload,
    needsSignedThinkingWarmup,
  };
}

export function buildThinkingWarmupBody(
  bodyText: string | undefined,
  isClaudeThinkingModel: boolean,
): string | null {
  if (!bodyText || !isClaudeThinkingModel) {
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

  const debugText =
    isDebugEnabled() && Array.isArray(debugLines) && debugLines.length > 0
      ? formatDebugLinesForThinking(debugLines)
      : undefined;

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

    // Use the optimized line-by-line transformer for immediate forwarding
    // This ensures thinking/reasoning content streams in real-time
    return new Response(response.body.pipeThrough(createStreamingTransformer(sessionId, debugText)), {
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
      const responseBody = debugText ? injectDebugThinking(effectiveBody.response, debugText) : effectiveBody.response;
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
