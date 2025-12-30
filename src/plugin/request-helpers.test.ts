import { describe, expect, it } from "vitest";

import {
  isThinkingCapableModel,
  extractThinkingConfig,
  resolveThinkingConfig,
  filterUnsignedThinkingBlocks,
  filterMessagesThinkingBlocks,
  deepFilterThinkingBlocks,
  transformThinkingParts,
  normalizeThinkingConfig,
  parseAntigravityApiBody,
  extractUsageMetadata,
  extractUsageFromSsePayload,
  rewriteAntigravityPreviewAccessError,
  DEFAULT_THINKING_BUDGET,
  findOrphanedToolUseIds,
  fixClaudeToolPairing,
  validateAndFixClaudeToolPairing,
} from "./request-helpers";

describe("sanitizeThinkingPart (covered via filtering)", () => {
  it("extracts wrapped text and strips SDK fields for Gemini-style thought blocks", () => {
    const validSignature = "s".repeat(60);
    const thinkingText = "wrapped thought";
    const getCachedSignatureFn = (_sessionId: string, text: string) =>
      text === thinkingText ? validSignature : undefined;

    const contents = [
      {
        role: "model",
        parts: [
          {
            thought: true,
            text: {
              text: thinkingText,
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

    const result = filterUnsignedThinkingBlocks(contents, "session-1", getCachedSignatureFn) as any;
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0]).toEqual({
      thought: true,
      text: thinkingText,
      thoughtSignature: validSignature,
    });

    expect(result[0].parts[0].cache_control).toBeUndefined();
    expect(result[0].parts[0].providerOptions).toBeUndefined();
  });

  it("extracts wrapped thinking text and strips SDK fields for Anthropic-style thinking blocks", () => {
    const validSignature = "a".repeat(60);
    const thinkingText = "wrapped thinking";
    const getCachedSignatureFn = (_sessionId: string, text: string) =>
      text === thinkingText ? validSignature : undefined;

    const contents = [
      {
        role: "model",
        parts: [
          {
            type: "thinking",
            thinking: {
              text: thinkingText,
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

    const result = filterUnsignedThinkingBlocks(contents, "session-1", getCachedSignatureFn) as any;
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0]).toEqual({
      type: "thinking",
      thinking: thinkingText,
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

  it("sanitizes reasoning blocks keeping only allowed fields (type, text, signature)", () => {
    const validSignature = "z".repeat(60);
    const getCachedSignatureFn = (_sessionId: string, _text: string) => validSignature;

    const contents = [
      {
        role: "model",
        parts: [
          {
            type: "reasoning",
            text: "reasoning text",
            signature: validSignature,
            cache_control: { type: "ephemeral" },
            providerOptions: { injected: true },
            meta: { keep: true },
          },
          { type: "text", text: "visible" },
        ],
      },
    ];

    const result = filterUnsignedThinkingBlocks(contents, "session-1", getCachedSignatureFn) as any;
    expect(result[0].parts[0]).toEqual({
      type: "reasoning",
      text: "reasoning text",
      signature: validSignature,
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
    expect(result).toEqual({ includeThoughts: true, thinkingBudget: DEFAULT_THINKING_BUDGET });
  });
});

describe("resolveThinkingConfig", () => {
  it("keeps thinking enabled for Claude models with assistant history", () => {
    const result = resolveThinkingConfig(
      { includeThoughts: true, thinkingBudget: 8000 },
      true, // isThinkingModel
      true, // isClaudeModel
      true, // hasAssistantHistory
    );
    expect(result).toEqual({ includeThoughts: true, thinkingBudget: 8000 });
  });

  it("enables thinking for thinking-capable models without user config", () => {
    const result = resolveThinkingConfig(
      undefined,
      true, // isThinkingModel
      false, // isClaudeModel
      false, // hasAssistantHistory
    );
    expect(result).toEqual({ includeThoughts: true, thinkingBudget: DEFAULT_THINKING_BUDGET });
  });

  it("respects user config for non-Claude models", () => {
    const userConfig = { includeThoughts: false, thinkingBudget: 5000 };
    const result = resolveThinkingConfig(
      userConfig,
      true,
      false,
      false,
    );
    expect(result).toEqual(userConfig);
  });

  it("returns user config for Claude without history", () => {
    const userConfig = { includeThoughts: true, thinkingBudget: 8000 };
    const result = resolveThinkingConfig(
      userConfig,
      true,
      true, // isClaudeModel
      false, // no history
    );
    expect(result).toEqual(userConfig);
  });

  it("returns undefined for non-thinking model without user config", () => {
    const result = resolveThinkingConfig(
      undefined,
      false, // not thinking model
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

  it("keeps signed thinking parts with valid signatures from our cache", () => {
    const validSignature = "a".repeat(60);
    const thinkingText = "thinking with signature";
    const getCachedSignatureFn = (_sessionId: string, text: string) =>
      text === thinkingText ? validSignature : undefined;

    const contents = [
      {
        role: "model",
        parts: [
          { type: "thinking", text: thinkingText, signature: validSignature },
          { type: "text", text: "visible text" },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents, "session-1", getCachedSignatureFn);
    expect(result[0].parts).toHaveLength(2);
    expect(result[0].parts[0].signature).toBe(validSignature);
  });

  it("strips thinking parts with foreign signatures not in our cache", () => {
    const foreignSignature = "f".repeat(60);
    const contents = [
      {
        role: "model",
        parts: [
          { type: "thinking", text: "foreign thinking", signature: foreignSignature },
          { type: "text", text: "visible text" },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0].type).toBe("text");
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

  it("handles Gemini-style thought parts with valid signatures from our cache", () => {
    const validSignature = "b".repeat(55);
    const thinkingText = "has signature";
    const getCachedSignatureFn = (_sessionId: string, text: string) =>
      text === thinkingText ? validSignature : undefined;

    const contents = [
      {
        role: "model",
        parts: [
          { thought: true, text: "no signature" },
          { thought: true, text: thinkingText, thoughtSignature: validSignature },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents, "session-1", getCachedSignatureFn);
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

  it("strips blocks with signature field even if type is unknown", () => {
    const foreignSignature = "x".repeat(60);
    const contents = [
      {
        role: "model",
        parts: [
          { type: "unknown_thinking_type", text: "foreign block", signature: foreignSignature },
          { type: "text", text: "visible" },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0].type).toBe("text");
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

  it("preserves tool_use and tool_result blocks intact", () => {
    const contents = [
      {
        role: "model",
        parts: [
          { type: "tool_use", id: "tool_123", name: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        parts: [
          { type: "tool_result", tool_use_id: "tool_123", content: "file1.txt" },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result[0].parts[0]).toEqual({ type: "tool_use", id: "tool_123", name: "bash", input: { command: "ls" } });
    expect(result[1].parts[0]).toEqual({ type: "tool_result", tool_use_id: "tool_123", content: "file1.txt" });
  });

  it("strips google thoughtSignature from tool metadata for Claude", () => {
    const contents = [
      {
        role: "model",
        parts: [
          {
            type: "tool",
            tool: "bash",
            state: { status: "completed" },
            metadata: {
              google: { thoughtSignature: "sig", other: "keep" },
              source: "client",
            },
          },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents, undefined, undefined, true);
    expect(result[0].parts[0].metadata).toEqual({
      google: { other: "keep" },
      source: "client",
    });
  });

  it("strips top-level thoughtSignature from tool blocks for Claude", () => {
    const contents = [
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "bash", args: { command: "ls" }, id: "tool-call-1" },
            thoughtSignature: "sig",
          },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents, undefined, undefined, true);
    expect(result[0].parts[0].functionCall).toBeDefined();
    expect(result[0].parts[0].thoughtSignature).toBeUndefined();
  });

  it("removes empty google metadata after stripping thoughtSignature", () => {
    const contents = [
      {
        role: "model",
        parts: [
          {
            type: "tool_result",
            tool_use_id: "tool_789",
            content: "ok",
            metadata: { google: { thoughtSignature: "sig" } },
          },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents, undefined, undefined, true);
    expect(result[0].parts[0].metadata).toBeUndefined();
  });

  it("preserves tool blocks even if they have signature-like fields", () => {
    const contents = [
      {
        role: "user",
        parts: [
          { type: "tool_result", tool_use_id: "tool_456", content: "result", signature: "some_random_value" },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0].tool_use_id).toBe("tool_456");
  });

  it("preserves nested tool_result format", () => {
    const contents = [
      {
        role: "user",
        parts: [
          { tool_result: { tool_use_id: "tool_789", content: "nested result" } },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0].tool_result.tool_use_id).toBe("tool_789");
  });

  it("preserves functionCall and functionResponse blocks", () => {
    const contents = [
      {
        role: "model",
        parts: [
          { functionCall: { name: "get_weather", args: { city: "NYC" } } },
        ],
      },
      {
        role: "function",
        parts: [
          { functionResponse: { name: "get_weather", response: { temp: 72 } } },
        ],
      },
    ];
    const result = filterUnsignedThinkingBlocks(contents);
    expect(result[0].parts[0].functionCall).toBeDefined();
    expect(result[1].parts[0].functionResponse).toBeDefined();
  });
});

describe("deepFilterThinkingBlocks", () => {
  it("removes nested thinking blocks in extra_body messages", () => {
    const payload = {
      extra_body: {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "foreign", signature: "x".repeat(60) },
              { type: "text", text: "visible" },
            ],
          },
        ],
      },
    };

    deepFilterThinkingBlocks(payload);
    const filtered = (payload as any).extra_body.messages[0].content;
    expect(filtered).toHaveLength(1);
    expect(filtered[0].type).toBe("text");
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

  it("keeps signed thinking blocks with valid signatures from our cache and sanitizes injected fields", () => {
    const validSignature = "a".repeat(60);
    const thinkingText = "wrapped";
    const getCachedSignatureFn = (_sessionId: string, text: string) =>
      text === thinkingText ? validSignature : undefined;

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: { text: thinkingText, cache_control: { type: "ephemeral" } },
            signature: validSignature,
            cache_control: { type: "ephemeral" },
            providerOptions: { injected: true },
          },
          { type: "text", text: "visible" },
        ],
      },
    ];

    const result = filterMessagesThinkingBlocks(messages, "session-1", getCachedSignatureFn) as any;
    expect(result[0].content[0]).toEqual({
      type: "thinking",
      thinking: thinkingText,
      signature: validSignature,
    });
  });

  it("strips thinking blocks with foreign signatures not in our cache", () => {
    const foreignSignature = "f".repeat(60);
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "foreign thinking",
            signature: foreignSignature,
          },
          { type: "text", text: "visible" },
        ],
      },
    ];

    const result = filterMessagesThinkingBlocks(messages) as any;
    expect(result[0].content).toHaveLength(1);
    expect(result[0].content[0].type).toBe("text");
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

  it("handles Gemini-style thought blocks inside messages content with cached signatures", () => {
    const validSignature = "b".repeat(60);
    const thinkingText = "wrapped thought";
    const getCachedSignatureFn = (_sessionId: string, text: string) =>
      text === thinkingText ? validSignature : undefined;

    const messages = [
      {
        role: "assistant",
        content: [
          {
            thought: true,
            text: { text: thinkingText, cache_control: { type: "ephemeral" } },
            thoughtSignature: validSignature,
            providerOptions: { injected: true },
          },
          { type: "text", text: "visible" },
        ],
      },
    ];

    const result = filterMessagesThinkingBlocks(messages, "session-1", getCachedSignatureFn) as any;
    expect(result[0].content[0]).toEqual({
      thought: true,
      text: thinkingText,
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
    // When budget is non-finite (undefined), includeThoughts is forced to false
    expect(result).toEqual({ includeThoughts: false });
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

describe("findOrphanedToolUseIds", () => {
  it("returns empty set when no tool_use blocks", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const result = findOrphanedToolUseIds(messages);
    expect(result.size).toBe(0);
  });

  it("returns empty set when all tool_use have matching tool_result", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
      },
    ];
    const result = findOrphanedToolUseIds(messages);
    expect(result.size).toBe(0);
  });

  it("finds orphaned tool_use without matching tool_result", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "read", input: {} },
          { type: "tool_use", id: "tool-2", name: "bash", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
      },
    ];
    const result = findOrphanedToolUseIds(messages);
    expect(result.size).toBe(1);
    expect(result.has("tool-2")).toBe(true);
  });
});

describe("fixClaudeToolPairing", () => {
  it("does not modify messages without tool_use", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const result = fixClaudeToolPairing(messages);
    expect(result).toEqual(messages);
  });

  it("does not modify properly paired tool calls", () => {
    const messages = [
      { role: "user", content: "Check file" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check..." },
          { type: "tool_use", id: "tool-1", name: "read", input: { path: "/foo" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file contents" }],
      },
    ];
    const result = fixClaudeToolPairing(messages);
    expect(result).toEqual(messages);
  });

  it("injects placeholder for single orphaned tool_use", () => {
    const messages = [
      { role: "user", content: "Check file" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "read", input: {} }],
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ];

    const result = fixClaudeToolPairing(messages);

    expect(result.length).toBe(3);
    expect(result[2].content[0].type).toBe("tool_result");
    expect(result[2].content[0].tool_use_id).toBe("tool-1");
    expect(result[2].content[0].is_error).toBe(true);
    expect(result[2].content[1].type).toBe("text");
  });

  it("handles multiple orphaned tools in same message", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "read", input: {} },
          { type: "tool_use", id: "tool-2", name: "bash", input: {} },
        ],
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ];

    const result = fixClaudeToolPairing(messages);

    expect(result[1].content.length).toBe(3);
    expect(result[1].content[0].tool_use_id).toBe("tool-1");
    expect(result[1].content[1].tool_use_id).toBe("tool-2");
    expect(result[1].content[2].type).toBe("text");
  });

  it("handles empty messages array", () => {
    expect(fixClaudeToolPairing([])).toEqual([]);
  });

  it("handles non-array input", () => {
    expect(fixClaudeToolPairing(null as any)).toEqual(null);
    expect(fixClaudeToolPairing(undefined as any)).toEqual(undefined);
  });
});

describe("validateAndFixClaudeToolPairing", () => {
  it("returns messages unchanged when no orphans", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ];
    const result = validateAndFixClaudeToolPairing(messages);
    expect(result).toEqual(messages);
  });

  it("fixes orphaned tool_use with placeholder", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "bash", input: {} }],
      },
      { role: "user", content: [{ type: "text", text: "skip that" }] },
    ];

    const result = validateAndFixClaudeToolPairing(messages);
    const orphans = findOrphanedToolUseIds(result);
    expect(orphans.size).toBe(0);
  });

  it("handles empty array", () => {
    expect(validateAndFixClaudeToolPairing([])).toEqual([]);
  });
});
