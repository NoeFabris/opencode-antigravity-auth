import { describe, expect, it } from "vitest";

import {
  isThinkingCapableModel,
  extractThinkingConfig,
  resolveThinkingConfig,
  filterUnsignedThinkingBlocks,
  filterMessagesThinkingBlocks,
  transformThinkingParts,
  normalizeThinkingConfig,
  parseAntigravityApiBody,
  extractUsageMetadata,
  extractUsageFromSsePayload,
  rewriteAntigravityPreviewAccessError,
  DEFAULT_THINKING_BUDGET,
} from "./request-helpers";

describe("sanitizeThinkingPart (covered via filtering)", () => {
  it("extracts wrapped text and strips SDK fields for Gemini-style thought blocks", () => {
    const validSignature = "s".repeat(60);

    const contents = [
      {
        role: "model",
        parts: [
          {
            thought: true,
            text: {
              text: "wrapped thought",
              cache_control: { type: "ephemeral" },
              providerOptions: { injected: true },
            },
            thoughtSignature: validSignature,
            cache_control: { type: "ephemeral" },
            providerOptions: { injected: true },
          },
        ],
      },
    ];

    const result = filterUnsignedThinkingBlocks(contents) as any;
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0]).toEqual({
      thought: true,
      text: "wrapped thought",
      thoughtSignature: validSignature,
    });

    // Ensure injected fields are removed
    expect(result[0].parts[0].cache_control).toBeUndefined();
    expect(result[0].parts[0].providerOptions).toBeUndefined();
  });

  it("extracts wrapped thinking text and strips SDK fields for Anthropic-style thinking blocks", () => {
    const validSignature = "a".repeat(60);

    const contents = [
      {
        role: "model",
        parts: [
          {
            type: "thinking",
            thinking: {
              text: "wrapped thinking",
              cache_control: { type: "ephemeral" },
              providerOptions: { injected: true },
            },
            signature: validSignature,
            cache_control: { type: "ephemeral" },
            providerOptions: { injected: true },
          },
        ],
      },
    ];

    const result = filterUnsignedThinkingBlocks(contents) as any;
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0]).toEqual({
      type: "thinking",
      thinking: "wrapped thinking",
      signature: validSignature,
    });
  });

  it("preserves signatures while dropping cache_control/providerOptions during signature restoration", () => {
    const cachedSignature = "c".repeat(60);
    const getCachedSignatureFn = (_sessionId: string, _text: string) => cachedSignature;

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: {
              thinking: "restore me",
              cache_control: { type: "ephemeral" },
            },
            // no signature present (forces restore)
            providerOptions: { injected: true },
          },
          { type: "text", text: "visible" },
        ],
      },
    ];

    const result = filterMessagesThinkingBlocks(messages, "session-1", getCachedSignatureFn) as any;
    expect(result[0].content[0]).toEqual({
      type: "thinking",
      thinking: "restore me",
      signature: cachedSignature,
    });
  });

  it("falls back to recursive stripping for signed reasoning blocks and removes nested SDK fields", () => {
    const validSignature = "z".repeat(60);

    const contents = [
      {
        role: "model",
        parts: [
          {
            type: "reasoning",
            signature: validSignature,
            cache_control: { type: "ephemeral" },
            providerOptions: { injected: true },
            meta: {
              keep: true,
              cache_control: { nested: true },
              arr: [
                { providerOptions: { nested: true }, keep: 1 },
                { cache_control: { nested: true }, keep: 2 },
              ],
            },
          },
          { type: "text", text: "visible" },
        ],
      },
    ];

    const result = filterUnsignedThinkingBlocks(contents) as any;
    expect(result[0].parts[0]).toEqual({
      type: "reasoning",
      signature: validSignature,
      meta: {
        keep: true,
        arr: [
          { keep: 1 },
          { keep: 2 },
        ],
      },
    });
  });
});

describe("isThinkingCapableModel", () => {
  it("returns true for models with 'thinking' in name", () => {
    expect(isThinkingCapableModel("claude-thinking")).toBe(true);
    expect(isThinkingCapableModel("CLAUDE-THINKING-4")).toBe(true);
    expect(isThinkingCapableModel("model-thinking-v1")).toBe(true);
  });

  it("returns true for models with 'gemini-3' in name", () => {
    expect(isThinkingCapableModel("gemini-3-pro")).toBe(true);
    expect(isThinkingCapableModel("GEMINI-3-flash")).toBe(true);
    expect(isThinkingCapableModel("gemini-3")).toBe(true);
  });

  it("returns true for models with 'opus' in name", () => {
    expect(isThinkingCapableModel("claude-opus")).toBe(true);
    expect(isThinkingCapableModel("claude-4-opus")).toBe(true);
    expect(isThinkingCapableModel("OPUS")).toBe(true);
  });

  it("returns false for non-thinking models", () => {
    expect(isThinkingCapableModel("claude-sonnet")).toBe(false);
    expect(isThinkingCapableModel("gemini-2-pro")).toBe(false);
    expect(isThinkingCapableModel("gpt-4")).toBe(false);
  });
});

describe("extractThinkingConfig", () => {
  it("extracts thinkingConfig from generationConfig", () => {
    const result = extractThinkingConfig(
      {},
      { thinkingConfig: { includeThoughts: true, thinkingBudget: 8000 } },
      undefined,
    );
    expect(result).toEqual({ includeThoughts: true, thinkingBudget: 8000 });
  });

  it("extracts thinkingConfig from extra_body", () => {
    const result = extractThinkingConfig(
      {},
      undefined,
      { thinkingConfig: { includeThoughts: true, thinkingBudget: 4000 } },
    );
    expect(result).toEqual({ includeThoughts: true, thinkingBudget: 4000 });
  });

  it("extracts thinkingConfig from requestPayload directly", () => {
    const result = extractThinkingConfig(
      { thinkingConfig: { includeThoughts: false, thinkingBudget: 2000 } },
      undefined,
      undefined,
    );
    expect(result).toEqual({ includeThoughts: false, thinkingBudget: 2000 });
  });

  it("prioritizes generationConfig over extra_body", () => {
    const result = extractThinkingConfig(
      {},
      { thinkingConfig: { includeThoughts: true, thinkingBudget: 8000 } },
      { thinkingConfig: { includeThoughts: false, thinkingBudget: 4000 } },
    );
    expect(result).toEqual({ includeThoughts: true, thinkingBudget: 8000 });
  });

  it("converts Anthropic-style thinking config", () => {
    const result = extractThinkingConfig(
      { thinking: { type: "enabled", budgetTokens: 10000 } },
      undefined,
      undefined,
    );
    expect(result).toEqual({ includeThoughts: true, thinkingBudget: 10000 });
  });

  it("uses default budget for Anthropic-style without budgetTokens", () => {
    const result = extractThinkingConfig(
      { thinking: { type: "enabled" } },
      undefined,
      undefined,
    );
    expect(result).toEqual({ includeThoughts: true, thinkingBudget: DEFAULT_THINKING_BUDGET });
  });

  it("returns undefined when no config found", () => {
    expect(extractThinkingConfig({}, undefined, undefined)).toBeUndefined();
  });

  it("uses default budget when thinkingBudget not specified", () => {
    const result = extractThinkingConfig(
      {},
      { thinkingConfig: { includeThoughts: true } },
      undefined,
    );
    expect(result).toEqual({ includeThoughts: true });
  });
});

describe("resolveThinkingConfig", () => {
  it("keeps thinking enabled for Claude models with assistant history", () => {
    const result = resolveThinkingConfig(
      { includeThoughts: true, thinkingBudget: 8000 },
      "claude-opus-4-5-thinking",
      true, // isClaudeModel
      true, // hasAssistantHistory
    );
    expect(result).toEqual({ includeThoughts: true, thinkingBudget: 8000 });
  });

  it("enables thinking for thinking-capable models without user config", () => {
    const result = resolveThinkingConfig(
      undefined,
      "claude-opus-4-5-thinking",
      false, // isClaudeModel
      false, // hasAssistantHistory
    );
    expect(result).toEqual({ includeThoughts: true, thinkingBudget: DEFAULT_THINKING_BUDGET });
  });

  it("respects user config for non-Claude models", () => {
    const userConfig = { includeThoughts: false, thinkingBudget: 5000 };
    const result = resolveThinkingConfig(
      userConfig,
      "gemini-2.5-flash",
      false,
      false,
    );
    expect(result).toEqual(userConfig);
  });

  it("returns user config for Claude without history", () => {
    const userConfig = { includeThoughts: true, thinkingBudget: 8000 };
    const result = resolveThinkingConfig(
      userConfig,
      "claude-opus-4-5-thinking",
      true, // isClaudeModel
      false, // no history
    );
    expect(result).toEqual(userConfig);
  });

  it("skips defaults for Gemini 3/2.5 when no user config", () => {
    const gemini3 = resolveThinkingConfig(undefined, "gemini-3-pro", false, false);
    const gemini25 = resolveThinkingConfig(undefined, "gemini-2.5-flash", false, false);
    expect(gemini3).toBeUndefined();
    expect(gemini25).toBeUndefined();
  });

  it("returns undefined for non-thinking model without user config", () => {
    const result = resolveThinkingConfig(
      undefined,
      "gpt-4o", // not thinking model
      false,
      false,
    );
    expect(result).toBeUndefined();
  });
});

describe("filterUnsignedThinkingBlocks", () => {
  it("filters out unsigned thinking parts", () => {
    const contents = [
      {
        role: "model",
        parts: [
          { type: "thinking", text: "thinking without signature" },
          { type: "text", text: "visible text" },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0].type).toBe("text");
  });

  it("keeps signed thinking parts with valid signatures", () => {
    const validSignature = "a".repeat(60);
    const contents = [
      {
        role: "model",
        parts: [
          { type: "thinking", text: "thinking with signature", signature: validSignature },
          { type: "text", text: "visible text" },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result[0].parts).toHaveLength(2);
    expect(result[0].parts[0].signature).toBe(validSignature);
  });

  it("filters thinking parts with short signatures", () => {
    const contents = [
      {
        role: "model",
        parts: [
          { type: "thinking", text: "thinking with short signature", signature: "sig123" },
          { type: "text", text: "visible text" },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0].type).toBe("text");
  });

  it("handles Gemini-style thought parts with valid signatures", () => {
    const validSignature = "b".repeat(55);
    const contents = [
      {
        role: "model",
        parts: [
          { thought: true, text: "no signature" },
          { thought: true, text: "has signature", thoughtSignature: validSignature },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0].thoughtSignature).toBe(validSignature);
  });

  it("filters Gemini-style thought parts with short signatures", () => {
    const contents = [
      {
        role: "model",
        parts: [
          { thought: true, text: "has short signature", thoughtSignature: "sig" },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result[0].parts).toHaveLength(0);
  });

  it("preserves non-thinking parts", () => {
    const contents = [
      {
        role: "user",
        parts: [{ text: "hello" }],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result).toEqual(contents);
  });

  it("handles empty parts array", () => {
    const contents = [{ role: "model", parts: [] }];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result[0].parts).toEqual([]);
  });

  it("handles missing parts", () => {
    const contents = [{ role: "model" }];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result).toEqual(contents);
  });
});

describe("filterMessagesThinkingBlocks", () => {
  it("filters out unsigned thinking blocks in messages[].content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "no signature" },
          { type: "text", text: "visible" },
        ],
      },
    ];

    const result = filterMessagesThinkingBlocks(messages) as any;
    expect(result[0].content).toHaveLength(1);
    expect(result[0].content[0].type).toBe("text");
  });

  it("keeps signed thinking blocks with valid signatures and sanitizes injected fields", () => {
    const validSignature = "a".repeat(60);
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: { text: "wrapped", cache_control: { type: "ephemeral" } },
            signature: validSignature,
            cache_control: { type: "ephemeral" },
            providerOptions: { injected: true },
          },
          { type: "text", text: "visible" },
        ],
      },
    ];

    const result = filterMessagesThinkingBlocks(messages) as any;
    expect(result[0].content[0]).toEqual({
      type: "thinking",
      thinking: "wrapped",
      signature: validSignature,
    });
  });

  it("filters thinking blocks with short signatures", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "short sig", signature: "sig123" },
          { type: "text", text: "visible" },
        ],
      },
    ];

    const result = filterMessagesThinkingBlocks(messages) as any;
    expect(result[0].content).toEqual([{ type: "text", text: "visible" }]);
  });

  it("restores a missing signature from cache and preserves it after sanitization", () => {
    const cachedSignature = "c".repeat(60);
    const getCachedSignatureFn = (_sessionId: string, _text: string) => cachedSignature;

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: { thinking: "restore me", providerOptions: { injected: true } },
            // no signature present (forces restore)
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: "visible" },
        ],
      },
    ];

    const result = filterMessagesThinkingBlocks(messages, "session-1", getCachedSignatureFn) as any;
    expect(result[0].content[0]).toEqual({
      type: "thinking",
      thinking: "restore me",
      signature: cachedSignature,
    });
  });

  it("handles Gemini-style thought blocks inside messages content", () => {
    const validSignature = "b".repeat(60);
    const messages = [
      {
        role: "assistant",
        content: [
          {
            thought: true,
            text: { text: "wrapped thought", cache_control: { type: "ephemeral" } },
            thoughtSignature: validSignature,
            providerOptions: { injected: true },
          },
          { type: "text", text: "visible" },
        ],
      },
    ];

    const result = filterMessagesThinkingBlocks(messages) as any;
    expect(result[0].content[0]).toEqual({
      thought: true,
      text: "wrapped thought",
      thoughtSignature: validSignature,
    });
  });

  it("preserves non-thinking blocks and returns message unchanged when content is missing", () => {
    const messages: any[] = [
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "assistant" },
    ];

    const result = filterMessagesThinkingBlocks(messages) as any;
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
  });

  it("handles non-object messages gracefully", () => {
    const messages: any[] = [null, "string", 123, { role: "assistant", content: [] }];
    const result = filterMessagesThinkingBlocks(messages) as any;
    expect(result).toEqual(messages);
  });
});

describe("transformThinkingParts", () => {
  it("transforms Anthropic-style thinking blocks to reasoning", () => {
    const response = {
      content: [
        { type: "thinking", thinking: "my thoughts" },
        { type: "text", text: "visible" },
      ],
    };
    const result = transformThinkingParts(response) as any;
    expect(result.content[0].type).toBe("reasoning");
    expect(result.content[0].thought).toBe(true);
    expect(result.reasoning_content).toBe("my thoughts");
  });

  it("transforms Gemini-style candidates", () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "thinking here" },
              { text: "output" },
            ],
          },
        },
      ],
    };
    const result = transformThinkingParts(response) as any;
    expect(result.candidates[0].content.parts[0].type).toBe("reasoning");
    expect(result.candidates[0].reasoning_content).toBe("thinking here");
  });

  it("handles non-object input", () => {
    expect(transformThinkingParts(null)).toBeNull();
    expect(transformThinkingParts(undefined)).toBeUndefined();
    expect(transformThinkingParts("string")).toBe("string");
  });

  it("preserves other response properties", () => {
    const response = {
      content: [],
      id: "resp-123",
      model: "claude-4",
    };
    const result = transformThinkingParts(response) as any;
    expect(result.id).toBe("resp-123");
    expect(result.model).toBe("claude-4");
  });
});

describe("normalizeThinkingConfig", () => {
  it("returns undefined for non-object input", () => {
    expect(normalizeThinkingConfig(null)).toBeUndefined();
    expect(normalizeThinkingConfig(undefined)).toBeUndefined();
    expect(normalizeThinkingConfig("string")).toBeUndefined();
  });

  it("normalizes valid config", () => {
    const result = normalizeThinkingConfig({
      thinkingBudget: 8000,
      includeThoughts: true,
    });
    expect(result).toEqual({
      thinkingBudget: 8000,
      includeThoughts: true,
    });
  });

  it("handles snake_case property names", () => {
    const result = normalizeThinkingConfig({
      thinking_budget: 4000,
      include_thoughts: true,
    });
    expect(result).toEqual({
      thinkingBudget: 4000,
      includeThoughts: true,
    });
  });

  it("disables includeThoughts when budget is 0", () => {
    const result = normalizeThinkingConfig({
      thinkingBudget: 0,
      includeThoughts: true,
    });
    expect(result?.includeThoughts).toBe(false);
  });

  it("returns undefined when both values are absent/undefined", () => {
    const result = normalizeThinkingConfig({});
    expect(result).toBeUndefined();
  });

  it("handles non-finite budget values", () => {
    const result = normalizeThinkingConfig({
      thinkingBudget: Infinity,
      includeThoughts: true,
    });
    expect(result).toEqual({ includeThoughts: true });
  });
});

describe("parseAntigravityApiBody", () => {
  it("parses valid JSON object", () => {
    const result = parseAntigravityApiBody('{"response": {"text": "hello"}}');
    expect(result).toEqual({ response: { text: "hello" } });
  });

  it("extracts first object from array", () => {
    const result = parseAntigravityApiBody('[{"response": "first"}, {"response": "second"}]');
    expect(result).toEqual({ response: "first" });
  });

  it("returns null for invalid JSON", () => {
    expect(parseAntigravityApiBody("not json")).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(parseAntigravityApiBody("[]")).toBeNull();
  });

  it("returns null for primitive values", () => {
    expect(parseAntigravityApiBody('"string"')).toBeNull();
    expect(parseAntigravityApiBody("123")).toBeNull();
  });

  it("handles array with null values", () => {
    const result = parseAntigravityApiBody('[null, {"valid": true}]');
    expect(result).toEqual({ valid: true });
  });
});

describe("extractUsageMetadata", () => {
  it("extracts usage from response.usageMetadata", () => {
    const body = {
      response: {
        usageMetadata: {
          totalTokenCount: 1000,
          promptTokenCount: 500,
          candidatesTokenCount: 500,
          cachedContentTokenCount: 100,
        },
      },
    };
    const result = extractUsageMetadata(body);
    expect(result).toEqual({
      totalTokenCount: 1000,
      promptTokenCount: 500,
      candidatesTokenCount: 500,
      cachedContentTokenCount: 100,
    });
  });

  it("returns null when no usageMetadata", () => {
    expect(extractUsageMetadata({ response: {} })).toBeNull();
    expect(extractUsageMetadata({})).toBeNull();
  });

  it("handles partial usage data", () => {
    const body = {
      response: {
        usageMetadata: {
          totalTokenCount: 1000,
        },
      },
    };
    const result = extractUsageMetadata(body);
    expect(result).toEqual({
      totalTokenCount: 1000,
      promptTokenCount: undefined,
      candidatesTokenCount: undefined,
      cachedContentTokenCount: undefined,
    });
  });

  it("filters non-finite numbers", () => {
    const body = {
      response: {
        usageMetadata: {
          totalTokenCount: Infinity,
          promptTokenCount: NaN,
          candidatesTokenCount: 100,
        },
      },
    };
    const result = extractUsageMetadata(body);
    expect(result?.totalTokenCount).toBeUndefined();
    expect(result?.promptTokenCount).toBeUndefined();
    expect(result?.candidatesTokenCount).toBe(100);
  });
});

describe("extractUsageFromSsePayload", () => {
  it("extracts usage from SSE data line", () => {
    const payload = `data: {"response": {"usageMetadata": {"totalTokenCount": 500}}}`;
    const result = extractUsageFromSsePayload(payload);
    expect(result?.totalTokenCount).toBe(500);
  });

  it("handles multiple SSE lines", () => {
    const payload = `data: {"response": {}}
data: {"response": {"usageMetadata": {"totalTokenCount": 1000}}}`;
    const result = extractUsageFromSsePayload(payload);
    expect(result?.totalTokenCount).toBe(1000);
  });

  it("returns null when no usage found", () => {
    const payload = `data: {"response": {"text": "hello"}}`;
    const result = extractUsageFromSsePayload(payload);
    expect(result).toBeNull();
  });

  it("ignores non-data lines", () => {
    const payload = `: keepalive
event: message
data: {"response": {"usageMetadata": {"totalTokenCount": 200}}}`;
    const result = extractUsageFromSsePayload(payload);
    expect(result?.totalTokenCount).toBe(200);
  });

  it("handles malformed JSON gracefully", () => {
    const payload = `data: not json
data: {"response": {"usageMetadata": {"totalTokenCount": 300}}}`;
    const result = extractUsageFromSsePayload(payload);
    expect(result?.totalTokenCount).toBe(300);
  });
});

describe("rewriteAntigravityPreviewAccessError", () => {
  it("returns null for non-404 status", () => {
    const body = { error: { message: "Not found" } };
    expect(rewriteAntigravityPreviewAccessError(body, 400)).toBeNull();
    expect(rewriteAntigravityPreviewAccessError(body, 500)).toBeNull();
  });

  it("rewrites error for Antigravity model on 404", () => {
    const body = { error: { message: "Model not found" } };
    const result = rewriteAntigravityPreviewAccessError(body, 404, "claude-opus");
    expect(result?.error?.message).toContain("Model not found");
    expect(result?.error?.message).toContain("preview access");
  });

  it("rewrites error when error message contains antigravity", () => {
    const body = { error: { message: "antigravity model unavailable" } };
    const result = rewriteAntigravityPreviewAccessError(body, 404);
    expect(result?.error?.message).toContain("preview access");
  });

  it("returns null for 404 with non-antigravity model", () => {
    const body = { error: { message: "Model not found" } };
    const result = rewriteAntigravityPreviewAccessError(body, 404, "gemini-pro");
    expect(result).toBeNull();
  });

  it("provides default message when error message is empty", () => {
    const body = { error: { message: "" } };
    const result = rewriteAntigravityPreviewAccessError(body, 404, "opus-model");
    expect(result?.error?.message).toContain("Antigravity preview features are not enabled");
  });

  it("detects Claude models in requested model name", () => {
    const body = { error: {} };
    const result = rewriteAntigravityPreviewAccessError(body, 404, "claude-3-sonnet");
    expect(result?.error?.message).toContain("preview access");
  });
});
