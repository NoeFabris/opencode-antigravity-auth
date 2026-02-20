import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  prepareAntigravityRequest,
  transformAntigravityResponse,
  getPluginSessionId,
  isGenerativeLanguageRequest,
  __testExports,
} from "./request";
import { DEFAULT_CONFIG, initRuntimeConfig } from "./config";
import { DEBUG_MESSAGE_PREFIX, initializeDebug } from "./debug";
import type { SignatureStore, ThoughtBuffer, StreamingCallbacks, StreamingOptions } from "./core/streaming/types";

const {
  buildSignatureSessionKey,
  hashConversationSeed,
  extractTextFromContent,
  extractConversationSeedFromMessages,
  extractConversationSeedFromContents,
  resolveProjectKey,
  isGeminiToolUsePart,
  isGeminiThinkingPart,
  ensureThoughtSignature,
  hasSignedThinkingPart,
  hasToolUseInContents,
  hasSignedThinkingInContents,
  hasToolUseInMessages,
  hasSignedThinkingInMessages,
  generateSyntheticProjectId,
  MIN_SIGNATURE_LENGTH,
  transformStreamingPayload,
  createStreamingTransformer,
  transformSseLine,
} = __testExports;

function createMockSignatureStore(): SignatureStore {
  const store = new Map<string, { text: string; signature: string }>();
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: { text: string; signature: string }) => store.set(key, value),
    has: (key: string) => store.has(key),
    delete: (key: string) => store.delete(key),
  };
}

function createMockThoughtBuffer(): ThoughtBuffer {
  const buffer = new Map<number, string>();
  return {
    get: (idx: number) => buffer.get(idx),
    set: (idx: number, text: string) => buffer.set(idx, text),
    clear: () => buffer.clear(),
  };
}

const defaultCallbacks: StreamingCallbacks = {};
const defaultOptions: StreamingOptions = {};
const defaultDebugState = { injected: false };

function createTestDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("request.ts", () => {
  describe("getPluginSessionId", () => {
    it("returns consistent session ID across calls", () => {
      const id1 = getPluginSessionId();
      const id2 = getPluginSessionId();
      expect(id1).toBe(id2);
      expect(id1).toBeTruthy();
    });
  });

  describe("isGenerativeLanguageRequest", () => {
    it("returns true for generativelanguage.googleapis.com URLs", () => {
      expect(isGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1/models")).toBe(true);
    });

    it("returns false for other URLs", () => {
      expect(isGenerativeLanguageRequest("https://api.anthropic.com/v1/messages")).toBe(false);
    });

    it("returns false for non-string inputs", () => {
      expect(isGenerativeLanguageRequest({} as any)).toBe(false);
      expect(isGenerativeLanguageRequest(new Request("https://example.com"))).toBe(false);
    });
  });

  describe("buildSignatureSessionKey", () => {
    it("builds key from sessionId, model, project, and conversation", () => {
      const key = buildSignatureSessionKey("session-1", "claude-3", "conv-456", "proj-123");
      expect(key).toBe("session-1:claude-3:proj-123:conv-456");
    });

    it("uses defaults for missing optional params", () => {
      expect(buildSignatureSessionKey("s1", undefined, undefined, undefined)).toBe("s1:unknown:default:default");
      expect(buildSignatureSessionKey("s1", "model", undefined, undefined)).toBe("s1:model:default:default");
    });

    it("handles empty strings as defaults", () => {
      expect(buildSignatureSessionKey("s1", "", "", "")).toBe("s1:unknown:default:default");
    });
  });

  describe("hashConversationSeed", () => {
    it("returns consistent hash for same input", () => {
      const hash1 = hashConversationSeed("test-seed");
      const hash2 = hashConversationSeed("test-seed");
      expect(hash1).toBe(hash2);
    });

    it("returns different hash for different inputs", () => {
      const hash1 = hashConversationSeed("seed-1");
      const hash2 = hashConversationSeed("seed-2");
      expect(hash1).not.toBe(hash2);
    });

    it("handles empty string", () => {
      const hash = hashConversationSeed("");
      expect(hash).toBeTruthy();
    });
  });

  describe("extractTextFromContent", () => {
    it("extracts text from string content", () => {
      expect(extractTextFromContent("hello world")).toBe("hello world");
    });

    it("extracts first text from content array with text blocks", () => {
      const content = [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ];
      expect(extractTextFromContent(content)).toBe("hello");
    });

    it("returns empty string for non-text blocks", () => {
      const content = [{ type: "image", source: {} }];
      expect(extractTextFromContent(content)).toBe("");
    });

    it("returns first text block only (not concatenated)", () => {
      const content = [
        { type: "text", text: "before" },
        { type: "image", source: {} },
        { type: "text", text: "after" },
      ];
      expect(extractTextFromContent(content)).toBe("before");
    });

    it("returns empty string for null/undefined", () => {
      expect(extractTextFromContent(null)).toBe("");
      expect(extractTextFromContent(undefined)).toBe("");
    });
  });

  describe("extractConversationSeedFromMessages", () => {
    it("extracts seed from first user message", () => {
      const messages = [
        { role: "user", content: "first message" },
        { role: "assistant", content: "response" },
      ];
      const seed = extractConversationSeedFromMessages(messages);
      expect(seed).toContain("first message");
    });

    it("returns empty string when no user messages", () => {
      const messages = [{ role: "assistant", content: "response" }];
      expect(extractConversationSeedFromMessages(messages)).toBe("");
    });

    it("handles empty messages array", () => {
      expect(extractConversationSeedFromMessages([])).toBe("");
    });
  });

  describe("extractConversationSeedFromContents", () => {
    it("extracts seed from first user content", () => {
      const contents = [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "hi" }] },
      ];
      const seed = extractConversationSeedFromContents(contents);
      expect(seed).toContain("hello");
    });

    it("returns empty string when no user content", () => {
      const contents = [{ role: "model", parts: [{ text: "hi" }] }];
      expect(extractConversationSeedFromContents(contents)).toBe("");
    });
  });

  describe("resolveProjectKey", () => {
    it("returns candidate if it is a string", () => {
      expect(resolveProjectKey("my-project")).toBe("my-project");
    });

    it("returns fallback if candidate is not a string", () => {
      expect(resolveProjectKey(null, "fallback")).toBe("fallback");
      expect(resolveProjectKey(undefined, "fallback")).toBe("fallback");
      expect(resolveProjectKey({}, "fallback")).toBe("fallback");
    });

    it("returns undefined if no valid candidate or fallback", () => {
      expect(resolveProjectKey(null)).toBeUndefined();
      expect(resolveProjectKey(undefined)).toBeUndefined();
    });
  });

  describe("isGeminiToolUsePart", () => {
    it("returns true for functionCall parts", () => {
      expect(isGeminiToolUsePart({ functionCall: { name: "test" } })).toBe(true);
    });

    it("returns false for non-functionCall parts", () => {
      expect(isGeminiToolUsePart({ text: "hello" })).toBe(false);
      expect(isGeminiToolUsePart({ thought: true })).toBe(false);
    });

    it("returns false for null/undefined", () => {
      expect(isGeminiToolUsePart(null)).toBe(false);
      expect(isGeminiToolUsePart(undefined)).toBe(false);
    });
  });

  describe("isGeminiThinkingPart", () => {
    it("returns true for thought:true parts", () => {
      expect(isGeminiThinkingPart({ thought: true, text: "thinking..." })).toBe(true);
    });

    it("returns false for thought:false parts", () => {
      expect(isGeminiThinkingPart({ thought: false, text: "not thinking" })).toBe(false);
    });

    it("returns false for parts without thought property", () => {
      expect(isGeminiThinkingPart({ text: "hello" })).toBe(false);
    });
  });

  describe("ensureThoughtSignature", () => {
    it("adds sentinel signature when no cached signature exists", () => {
      const part = { thought: true, text: "thinking..." };
      const result = ensureThoughtSignature(part, "no-cache-session");
      // Now uses sentinel fallback to prevent API rejection
      expect(result.thoughtSignature).toBe("skip_thought_signature_validator");
    });

    it("preserves existing thoughtSignature", () => {
      const existingSignature = "a".repeat(MIN_SIGNATURE_LENGTH + 10);
      const part = { thought: true, text: "thinking...", thoughtSignature: existingSignature };
      const result = ensureThoughtSignature(part, "session-key");
      expect(result.thoughtSignature).toBe(existingSignature);
    });

    it("does not modify non-thinking parts", () => {
      const part = { text: "regular text" };
      const result = ensureThoughtSignature(part, "session-key");
      expect(result.thoughtSignature).toBeUndefined();
    });

    it("returns null/undefined inputs unchanged", () => {
      expect(ensureThoughtSignature(null, "key")).toBeNull();
      expect(ensureThoughtSignature(undefined, "key")).toBeUndefined();
    });

    it("returns non-object inputs unchanged", () => {
      expect(ensureThoughtSignature("string", "key")).toBe("string");
      expect(ensureThoughtSignature(123, "key")).toBe(123);
    });
  });

  describe("hasSignedThinkingPart", () => {
    it("returns true for part with valid thoughtSignature", () => {
      const part = { thought: true, thoughtSignature: "a".repeat(MIN_SIGNATURE_LENGTH) };
      expect(hasSignedThinkingPart(part)).toBe(true);
    });

    it("returns true for type:thinking with valid signature field", () => {
      const part = { type: "thinking", thinking: "...", signature: "a".repeat(MIN_SIGNATURE_LENGTH) };
      expect(hasSignedThinkingPart(part)).toBe(true);
    });

    it("returns true for type:reasoning with valid signature field", () => {
      const part = { type: "reasoning", signature: "a".repeat(MIN_SIGNATURE_LENGTH) };
      expect(hasSignedThinkingPart(part)).toBe(true);
    });

    it("returns false for part with short signature", () => {
      const part = { thought: true, thoughtSignature: "short" };
      expect(hasSignedThinkingPart(part)).toBe(false);
    });

    it("returns false for part without signature", () => {
      const part = { thought: true, text: "no signature" };
      expect(hasSignedThinkingPart(part)).toBe(false);
    });
  });

  describe("hasToolUseInContents", () => {
    it("returns true when contents have functionCall", () => {
      const contents = [
        { role: "model", parts: [{ functionCall: { name: "test" } }] },
      ];
      expect(hasToolUseInContents(contents)).toBe(true);
    });

    it("returns false when no functionCall present", () => {
      const contents = [
        { role: "model", parts: [{ text: "hello" }] },
      ];
      expect(hasToolUseInContents(contents)).toBe(false);
    });

    it("handles empty contents", () => {
      expect(hasToolUseInContents([])).toBe(false);
    });
  });

  describe("hasSignedThinkingInContents", () => {
    it("returns true when contents have signed thinking", () => {
      const contents = [
        {
          role: "model",
          parts: [{ thought: true, thoughtSignature: "a".repeat(MIN_SIGNATURE_LENGTH) }],
        },
      ];
      expect(hasSignedThinkingInContents(contents)).toBe(true);
    });

    it("returns false when no signed thinking present", () => {
      const contents = [
        { role: "model", parts: [{ thought: true, text: "unsigned" }] },
      ];
      expect(hasSignedThinkingInContents(contents)).toBe(false);
    });
  });

  describe("hasToolUseInMessages", () => {
    it("returns true when messages have tool_use blocks", () => {
      const messages = [
        { role: "assistant", content: [{ type: "tool_use", id: "123", name: "test" }] },
      ];
      expect(hasToolUseInMessages(messages)).toBe(true);
    });

    it("returns false when no tool_use blocks", () => {
      const messages = [
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ];
      expect(hasToolUseInMessages(messages)).toBe(false);
    });

    it("handles string content", () => {
      const messages = [{ role: "assistant", content: "just text" }];
      expect(hasToolUseInMessages(messages)).toBe(false);
    });
  });

  describe("hasSignedThinkingInMessages", () => {
    it("returns true when messages have signed thinking blocks", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "...", signature: "a".repeat(MIN_SIGNATURE_LENGTH) }],
        },
      ];
      expect(hasSignedThinkingInMessages(messages)).toBe(true);
    });

    it("returns false when thinking blocks are unsigned", () => {
      const messages = [
        { role: "assistant", content: [{ type: "thinking", thinking: "no sig" }] },
      ];
      expect(hasSignedThinkingInMessages(messages)).toBe(false);
    });
  });

  describe("generateSyntheticProjectId", () => {
    it("generates a string in expected format", () => {
      const id = generateSyntheticProjectId();
      expect(id).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{5}$/);
    });

    it("generates unique IDs on each call", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        ids.add(generateSyntheticProjectId());
      }
      expect(ids.size).toBe(10);
    });
  });

  describe("MIN_SIGNATURE_LENGTH", () => {
    it("is 50", () => {
      expect(MIN_SIGNATURE_LENGTH).toBe(50);
    });
  });

  describe("transformSseLine", () => {
    const callTransformSseLine = (line: string) => {
      const store = createMockSignatureStore();
      const buffer = createMockThoughtBuffer();
      const sentBuffer = createMockThoughtBuffer();
      return transformSseLine(line, store, buffer, sentBuffer, defaultCallbacks, defaultOptions, { ...defaultDebugState });
    };

    it("returns empty lines unchanged", () => {
      expect(callTransformSseLine("")).toBe("");
      expect(callTransformSseLine("   ")).toBe("   ");
    });

    it("returns non-data lines unchanged", () => {
      expect(callTransformSseLine("event: message")).toBe("event: message");
      expect(callTransformSseLine(": heartbeat")).toBe(": heartbeat");
    });

    it("handles data: [DONE] unchanged", () => {
      expect(callTransformSseLine("data: [DONE]")).toBe("data: [DONE]");
    });

    it("handles invalid JSON gracefully", () => {
      expect(callTransformSseLine("data: not-json")).toBe("data: not-json");
      expect(callTransformSseLine("data: {invalid}")).toBe("data: {invalid}");
    });

    it("passes through valid JSON without thinking parts", () => {
      const payload = { candidates: [{ content: { parts: [{ text: "hello" }] } }] };
      const line = `data: ${JSON.stringify(payload)}`;
      const result = callTransformSseLine(line);
      expect(result).toContain("data:");
      expect(result).toContain("hello");
    });

    it("transforms thinking parts in streaming data", () => {
      const payload = {
        candidates: [{
          content: {
            parts: [{ thought: true, text: "reasoning..." }]
          }
        }]
      };
      const line = `data: ${JSON.stringify(payload)}`;
      const result = callTransformSseLine(line);
      expect(result).toContain("data:");
    });
  });

  describe("transformStreamingPayload", () => {
    it("handles empty string", () => {
      expect(transformStreamingPayload("")).toBe("");
    });

    it("handles single line without data prefix", () => {
      expect(transformStreamingPayload("event: ping")).toBe("event: ping");
    });

    it("handles multiple lines", () => {
      const input = "event: message\ndata: [DONE]\n";
      const result = transformStreamingPayload(input);
      expect(result).toContain("event: message");
      expect(result).toContain("data: [DONE]");
    });

    it("preserves line structure", () => {
      const input = "line1\nline2\nline3";
      const result = transformStreamingPayload(input);
      const lines = result.split("\n");
      expect(lines.length).toBe(3);
    });
  });

  describe("createStreamingTransformer", () => {
    it("returns a TransformStream", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks);
      expect(transformer).toBeInstanceOf(TransformStream);
      expect(transformer.readable).toBeDefined();
      expect(transformer.writable).toBeDefined();
    });

    it("accepts optional signatureSessionKey", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, { signatureSessionKey: "session-key" });
      expect(transformer).toBeInstanceOf(TransformStream);
    });

    it("accepts optional debugText", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, { signatureSessionKey: "session-key", debugText: "debug info" });
      expect(transformer).toBeInstanceOf(TransformStream);
    });

    it("accepts cacheSignatures flag", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, { signatureSessionKey: "session-key", cacheSignatures: true });
      expect(transformer).toBeInstanceOf(TransformStream);
    });

    it("processes chunks through the stream", async () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      
      const input = encoder.encode("data: [DONE]\n");
      const outputChunks: Uint8Array[] = [];
      
      const writer = transformer.writable.getWriter();
      const reader = transformer.readable.getReader();
      
      const readPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) outputChunks.push(value);
        }
      })();
      
      await writer.write(input);
      await writer.close();
      await readPromise;
      
      const output = outputChunks.map(chunk => decoder.decode(chunk)).join("");
      expect(output).toContain("[DONE]");
    });
  });

  describe("prepareAntigravityRequest", () => {
    const mockAccessToken = "test-token";
    const mockProjectId = "test-project";

    it("returns unchanged request for non-generative-language URLs", () => {
      const result = prepareAntigravityRequest(
        "https://example.com/api",
        { method: "POST" },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
      expect(result.request).toBe("https://example.com/api");
    });

    it("returns unchanged request for URLs without model pattern", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1/models",
        { method: "POST" },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("detects streaming from generateStreamContent action", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(true);
    });

    it("detects non-streaming from generateContent action", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("sets Authorization header with Bearer token", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bearer test-token");
    });

it("removes x-api-key header", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }), headers: { "x-api-key": "old-key" } },
        mockAccessToken,
        mockProjectId
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("x-api-key")).toBeNull();
    });

    it("removes x-goog-user-project header for antigravity headerStyle", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }), headers: { "x-goog-user-project": "my-project" } },
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity"
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("x-goog-user-project")).toBeNull();
    });

    it("preserves x-goog-user-project header for gemini-cli headerStyle", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }), headers: { "x-goog-user-project": "my-project" } },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli"
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("x-goog-user-project")).toBe("my-project");
    });

    it("uses exact Code Assist headers for gemini-cli headerStyle", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli"
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("User-Agent")).toBe("google-api-nodejs-client/9.15.1");
      expect(headers.get("X-Goog-Api-Client")).toBe("gl-node/22.17.0");
      expect(headers.get("Client-Metadata")).toBe("ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI");
    });

    it("builds gemini-cli wrapped body without antigravity-only fields", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }) },
        mockAccessToken,
        "",
        undefined,
        "gemini-cli"
      );
      const parsed = JSON.parse(result.init.body as string);
      expect(parsed).toHaveProperty("project", "");
      expect(parsed).toHaveProperty("model");
      expect(parsed).toHaveProperty("request");
      expect(parsed.requestType).toBeUndefined();
      expect(parsed.userAgent).toBeUndefined();
      expect(parsed.requestId).toBeUndefined();
    });

    it("identifies Claude models correctly", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-sonnet-4-20250514:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.effectiveModel).toContain("claude");
    });

    it("identifies Gemini models correctly", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.effectiveModel).toContain("gemini");
    });

    it("uses custom endpoint override", () => {
      const customEndpoint = "https://custom.api.com";
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        customEndpoint
      );
      expect(result.endpoint).toContain(customEndpoint);
    });

    it("handles wrapped Antigravity body format", () => {
      const wrappedBody = {
        project: "my-project",
        request: { contents: [{ parts: [{ text: "Hello" }] }] }
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify(wrappedBody) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("handles unwrapped body format", () => {
      const unwrappedBody = {
        contents: [{ parts: [{ text: "Hello" }] }]
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("returns requestedModel matching URL model", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.requestedModel).toBe("gemini-2.5-flash");
    });

    it("handles empty body gracefully", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({}) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("handles minimal valid JSON body", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("removes contents entries with empty or invalid parts", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [
              { role: "user", parts: [] },
              { role: "model", parts: [null, { text: "kept" }] },
              { role: "user", parts: null },
            ],
            systemInstruction: {
              role: "user",
              parts: [null, { text: "system kept" }],
            },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli",
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.contents).toHaveLength(1);
      expect(wrapped.request.contents[0]).toEqual({
        role: "model",
        parts: [{ text: "kept" }],
      });
      expect(wrapped.request.systemInstruction.parts).toEqual([{ text: "system kept" }]);
    });

    it("drops systemInstruction when all parts are invalid", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
            systemInstruction: {
              role: "user",
              parts: [null],
            },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli",
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.systemInstruction).toBeUndefined();
    });

    it("preserves headerStyle in response", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli"
      );
      expect(result.headerStyle).toBe("gemini-cli");
    });

    describe("Issue #103: model name transformation during quota fallback", () => {
      it("transforms gemini-3-flash-preview to gemini-3-flash for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3-flash");
      });

      it("transforms gemini-3-pro-preview to gemini-3-pro-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3-pro-low");
      });

      it("transforms gemini-3.1-pro-preview to gemini-3.1-pro-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-low");
      });

      it("transforms gemini-3.1-pro-preview-customtools to gemini-3.1-pro-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview-customtools:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-low");
      });

      it("transforms gemini-3-flash to gemini-3-flash-preview for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3-flash-preview");
      });

      it("transforms gemini-3-pro-low to gemini-3-pro-preview for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-low:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3-pro-preview");
      });

      it("transforms gemini-3.1-pro-low to gemini-3.1-pro-preview for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-low:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-preview");
      });

      it("keeps gemini-3.1-pro-preview-customtools unchanged for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview-customtools:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-preview-customtools");
      });

      it("keeps non-Gemini-3 models unchanged regardless of headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-2.5-flash");
      });
    });
  });

  describe("transformAntigravityResponse", () => {
    const createSuccessResponse = () =>
      new Response(
        JSON.stringify({
          response: {
            candidates: [
              {
                content: {
                  parts: [{ text: "hello" }],
                },
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );

    it("does not inject debug thinking when debug=false and debug_tui=true", async () => {
      const configDir = createTestDir("antigravity-request-config-");
      const logDir = createTestDir("antigravity-request-logs-");
      vi.stubEnv("XDG_CONFIG_HOME", configDir);

      initializeDebug({ ...DEFAULT_CONFIG, debug: false, debug_tui: true, log_dir: logDir });
      initRuntimeConfig({ ...DEFAULT_CONFIG, keep_thinking: false, log_dir: logDir });

      const transformed = await transformAntigravityResponse(
        createSuccessResponse(),
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ["ThinkingResolution: debug line"],
      );

      const body = JSON.parse(await transformed.text());
      expect(body.candidates[0].content.parts).toEqual([{ text: "hello" }]);
      expect(body.candidates[0].reasoning_content).toBeUndefined();
    });

    it("does not inject debug thinking when debug=true and debug_tui=false", async () => {
      const configDir = createTestDir("antigravity-request-config-");
      const logDir = createTestDir("antigravity-request-logs-");
      vi.stubEnv("XDG_CONFIG_HOME", configDir);

      initializeDebug({ ...DEFAULT_CONFIG, debug: true, debug_tui: false, log_dir: logDir });
      initRuntimeConfig({ ...DEFAULT_CONFIG, keep_thinking: false, log_dir: logDir });

      const transformed = await transformAntigravityResponse(
        createSuccessResponse(),
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ["ThinkingResolution: debug line"],
      );

      const body = JSON.parse(await transformed.text());
      expect(body.candidates[0].content.parts).toEqual([{ text: "hello" }]);
      expect(body.candidates[0].reasoning_content).toBeUndefined();
    });

    it("injects debug thinking only when debug=true and debug_tui=true", async () => {
      const configDir = createTestDir("antigravity-request-config-");
      const logDir = createTestDir("antigravity-request-logs-");
      vi.stubEnv("XDG_CONFIG_HOME", configDir);

      initializeDebug({ ...DEFAULT_CONFIG, debug: true, debug_tui: true, log_dir: logDir });
      initRuntimeConfig({ ...DEFAULT_CONFIG, keep_thinking: false, log_dir: logDir });

      const transformed = await transformAntigravityResponse(
        createSuccessResponse(),
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ["ThinkingResolution: debug line"],
      );

      const body = JSON.parse(await transformed.text());
      expect(body.candidates[0].content.parts).toHaveLength(2);
      expect(body.candidates[0].content.parts[0].type).toBe("reasoning");
      expect(body.candidates[0].content.parts[0].text).toContain(DEBUG_MESSAGE_PREFIX);
      expect(body.candidates[0].content.parts[0].text).toContain("ThinkingResolution: debug line");
      expect(body.candidates[0].reasoning_content).toContain(DEBUG_MESSAGE_PREFIX);
    });

    it("does not misclassify generic INVALID_ARGUMENT as thinking recovery from debug metadata", async () => {
      const response = new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "Request contains an invalid argument.",
            status: "INVALID_ARGUMENT",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );

      const transformed = await transformAntigravityResponse(
        response,
        true,
        undefined,
        "antigravity-claude-opus-4-6-thinking",
        "test-project",
        "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        "claude-opus-4-6-thinking",
        "session-1",
        0,
        "expected=1 found=0",
      );

      await expect(transformed.text()).resolves.toContain("Request contains an invalid argument.");
    });

    it("rethrows THINKING_RECOVERY_NEEDED for outer retry handling", async () => {
      const response = new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "Thinking must start with a thinking block before tool use.",
            status: "INVALID_ARGUMENT",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );

      await expect(
        transformAntigravityResponse(
          response,
          true,
          undefined,
          "antigravity-claude-opus-4-6-thinking",
          "test-project",
          "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
          "claude-opus-4-6-thinking",
          "session-1",
        ),
      ).rejects.toMatchObject({ message: "THINKING_RECOVERY_NEEDED" });
    });
  });
});
