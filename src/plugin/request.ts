import crypto from "node:crypto";
import {
  ANTIGRAVITY_HEADERS,
  ANTIGRAVITY_ENDPOINT,
} from "../constants";
import { logAntigravityDebugResponse, type AntigravityDebugContext } from "./debug";
import {
  extractThinkingConfig,
  extractUsageFromSsePayload,
  extractUsageMetadata,
  filterUnsignedThinkingBlocks,
  isThinkingCapableModel,
  normalizeThinkingConfig,
  parseAntigravityApiBody,
  resolveThinkingConfig,
  rewriteAntigravityPreviewAccessError,
  transformThinkingParts,
  type AntigravityApiBody,
} from "./request-helpers";

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
 * transforming each line as it arrives for true streaming support.
 */
function createStreamingTransformer(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // Process complete lines
      const lines = buffer.split("\n");
      // Keep the last incomplete line in buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        const transformedLine = transformSseLine(line);
        controller.enqueue(encoder.encode(transformedLine + "\n"));
      }
    },
    flush(controller) {
      // Process any remaining data in buffer
      if (buffer) {
        const transformedLine = transformSseLine(buffer);
        controller.enqueue(encoder.encode(transformedLine));
      }
    },
  });
}

/**
 * Transforms a single SSE line, extracting and transforming the inner response.
 */
function transformSseLine(line: string): string {
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
): { request: RequestInfo; init: RequestInit; streaming: boolean; requestedModel?: string; effectiveModel?: string; projectId?: string; endpoint?: string; toolDebugMissing?: number; toolDebugSummary?: string; toolDebugPayload?: string } {
  const baseInit: RequestInit = { ...init };
  const headers = new Headers(init?.headers ?? {});
  let resolvedProjectId = projectId?.trim() || "";
  let toolDebugMissing = 0;
  const toolDebugSummaries: string[] = [];
  let toolDebugPayload: string | undefined;

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
  const effectiveModel = rawModel;
  const upstreamModel = rawModel;
  const streaming = rawAction === STREAM_ACTION;
  const baseEndpoint = endpointOverride ?? ANTIGRAVITY_ENDPOINT;
  const transformedUrl = `${baseEndpoint}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""
    }`;
  const isClaudeModel = upstreamModel.toLowerCase().includes("claude");

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
        body = JSON.stringify(wrappedBody);
      } else {
        const requestPayload: Record<string, unknown> = { ...parsedBody };

        const rawGenerationConfig = requestPayload.generationConfig as Record<string, unknown> | undefined;
        const extraBody = requestPayload.extra_body as Record<string, unknown> | undefined;

        // Resolve thinking configuration based on user settings and model capabilities
        const userThinkingConfig = extractThinkingConfig(requestPayload, rawGenerationConfig, extraBody);
        const hasAssistantHistory = Array.isArray(requestPayload.contents) &&
          requestPayload.contents.some((c: any) => c?.role === "model" || c?.role === "assistant");

        const finalThinkingConfig = resolveThinkingConfig(
          userThinkingConfig,
          isThinkingCapableModel(upstreamModel),
          isClaudeModel,
          hasAssistantHistory,
        );

        const normalizedThinking = normalizeThinkingConfig(finalThinkingConfig);
        if (normalizedThinking) {
          if (rawGenerationConfig) {
            rawGenerationConfig.thinkingConfig = normalizedThinking;
            requestPayload.generationConfig = rawGenerationConfig;
          } else {
            requestPayload.generationConfig = { thinkingConfig: normalizedThinking };
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

            // Normalizes JSON schemas for Claude models via Antigravity.
            // Preserves anyOf/allOf/oneOf (supported by Anthropic API/JSON Schema Draft 2020-12).
            const normalizeSchemaRecursive = (schema: any): any => {
              if (!schema || typeof schema !== "object") {
                return schema;
              }

              const result: any = {};

              for (const [key, value] of Object.entries(schema)) {
                if (key === "properties" && value && typeof value === "object") {
                  result.properties = {};
                  for (const [propKey, propValue] of Object.entries(value)) {
                    result.properties[propKey] = normalizeSchemaRecursive(propValue);
                  }
                } else if (key === "items" && value && typeof value === "object") {
                  result.items = normalizeSchemaRecursive(value);
                } else if (key === "additionalProperties" && value && typeof value === "object") {
                  result.additionalProperties = normalizeSchemaRecursive(value);
                } else if ((key === "anyOf" || key === "allOf" || key === "oneOf") && Array.isArray(value)) {
                  result[key] = value.map((item: any) =>
                    typeof item === "object" ? normalizeSchemaRecursive(item) : item
                  );
                } else {
                  result[key] = value;
                }
              }
              return result;
            };

            const normalizeSchema = (schema: any) => {
              // Handle missing or invalid schemas
              if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) {
                toolDebugMissing += 1;
                // Proper void schema: accepts no parameters
                return {
                  type: "object",
                  properties: {},
                  additionalProperties: false
                };
              }

              // Handle schemas with only 'type: object' (effectively void)
              if (schema.type === "object" && !schema.properties && !schema.additionalProperties) {
                return {
                  ...schema,
                  properties: {},
                  additionalProperties: false
                };
              }

              const normalized = structuredClone(schema);
              return normalizeSchemaRecursive(normalized);
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
        if (isClaudeModel && Array.isArray(requestPayload.contents)) {
          requestPayload.contents = filterUnsignedThinkingBlocks(requestPayload.contents);
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
          (wrappedBody.request as any).sessionId = "-" + Math.floor(Math.random() * 9000000000000000000).toString();
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
    requestedModel: rawModel,
    effectiveModel: upstreamModel,
    projectId: resolvedProjectId,
    endpoint: transformedUrl,
    toolDebugMissing,
    toolDebugSummary: toolDebugSummaries.slice(0, 20).join(" | "),
    toolDebugPayload,
  };
}

/**
 * Normalizes Antigravity responses: applies retry headers, extracts cache usage into headers,
 * rewrites preview errors, flattens streaming payloads, and logs debug metadata.
 *
 * For streaming SSE responses, uses TransformStream for true incremental streaming.
 */
export async function transformAntigravityResponse(
  response: Response,
  streaming: boolean,
  debugContext?: AntigravityDebugContext | null,
  requestedModel?: string,
  projectId?: string,
  endpoint?: string,
  effectiveModel?: string,
  toolDebugMissing?: number,
  toolDebugSummary?: string,
  toolDebugPayload?: string,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");

  if (!isJsonResponse && !isEventStreamResponse) {
    logAntigravityDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)",
    });
    return response;
  }

  // For successful streaming responses, use TransformStream to transform SSE events
  // while maintaining real-time streaming (no buffering of entire response)
  if (streaming && response.ok && isEventStreamResponse && response.body) {
    const headers = new Headers(response.headers);

    // Buffer for partial SSE events that span chunks
    let buffer = "";
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const transformStream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // Decode chunk with stream: true to handle multi-byte characters
        buffer += decoder.decode(chunk, { stream: true });

        // Split on double newline (SSE event delimiter)
        const events = buffer.split("\n\n");

        // Keep last part in buffer (may be incomplete)
        buffer = events.pop() || "";

        // Process and forward complete events immediately
        for (const event of events) {
          if (event.trim()) {
            const transformed = transformStreamingPayload(event);
            controller.enqueue(encoder.encode(transformed + "\n\n"));
          }
        }
      },
      flush(controller) {
        // Flush any remaining bytes from TextDecoder
        buffer += decoder.decode();

        // Handle any remaining data at stream end
        if (buffer.trim()) {
          const transformed = transformStreamingPayload(buffer);
          controller.enqueue(encoder.encode(transformed));
        }
      }
    });

    logAntigravityDebugResponse(debugContext, response, {
      note: "Streaming SSE response (transformed)",
    });

    return new Response(response.body.pipeThrough(transformStream), {
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
        const debugInfo = `\n\n[Debug Info]\nRequested Model: ${requestedModel || "Unknown"}\nEffective Model: ${effectiveModel || "Unknown"}\nProject: ${projectId || "Unknown"}\nEndpoint: ${endpoint || "Unknown"}\nStatus: ${response.status}\nRequest ID: ${headers.get('x-request-id') || "N/A"}${toolDebugMissing !== undefined ? `\nTool Debug Missing: ${toolDebugMissing}` : ""}${toolDebugSummary ? `\nTool Debug Summary: ${toolDebugSummary}` : ""}${toolDebugPayload ? `\nTool Debug Payload: ${toolDebugPayload}` : ""}`;
        errorBody.error.message = (errorBody.error.message || "Unknown error") + debugInfo;

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
      const transformed = transformThinkingParts(effectiveBody.response);
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
