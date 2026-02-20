import { describe, expect, it } from "vitest";

import {
  isThinkingCapableModel,
  extractThinkingConfig,
  extractVariantThinkingConfig,
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
  injectParameterSignatures,
  injectToolHardeningInstruction,
  cleanJSONSchemaForAntigravity,
  createSyntheticErrorResponse,
  recursivelyParseJsonStrings,
} from "./request-helpers";
import { deduplicateThinkingText, createThoughtBuffer } from "./core/streaming/transformer";

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
      { role: "model", parts: [{ text: "trailing" }] },
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
      { role: "model", parts: [{ text: "trailing" }] },
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
            providerOptions: { injected: true },
          },
          { type: "text", text: "visible" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
      { role: "assistant", content: [{ type: "text", text: "last" }] },
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
      { role: "user", parts: [{ text: "next" }] },
      { role: "model", parts: [{ text: "last" }] },
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
      { role: "user", parts: [{ text: "next" }] },
      { role: "model", parts: [{ text: "last" }] },
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
      { role: "user", parts: [{ text: "next" }] },
      { role: "model", parts: [{ text: "last" }] },
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
      { role: "user", parts: [{ text: "next" }] },
      { role: "model", parts: [{ text: "last" }] },
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
      { role: "user", parts: [{ text: "next" }] },
      { role: "model", parts: [{ text: "last" }] },
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
      { role: "user", parts: [{ text: "next" }] },
      { role: "model", parts: [{ text: "last" }] },
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
          { role: "assistant", content: [{ type: "text", text: "last" }] },
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
      { role: "assistant", content: [{ type: "text", text: "last" }] },
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
      { role: "assistant", content: [{ type: "text", text: "last" }] },
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
      { role: "assistant", content: [{ type: "text", text: "last" }] },
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
      { role: "assistant", content: [{ type: "text", text: "last" }] },
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
      { role: "assistant", content: [{ type: "text", text: "last" }] },
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
      { role: "assistant", content: [{ type: "text", text: "last" }] },
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

  it("converts Gemini-style thoughtSignature to providerMetadata.anthropic.signature", () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "thinking here", thoughtSignature: "sig123abc" },
              { text: "output" },
            ],
          },
        },
      ],
    };
    const result = transformThinkingParts(response) as any;
    expect(result.candidates[0].content.parts[0].providerMetadata).toEqual({
      anthropic: { signature: "sig123abc" }
    });
    expect(result.candidates[0].content.parts[0].thoughtSignature).toBeUndefined();
  });

  it("converts Anthropic-style signature to providerMetadata.anthropic.signature", () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              { type: "thinking", text: "thinking here", signature: "anthro_sig_xyz" },
              { text: "output" },
            ],
          },
        },
      ],
    };
    const result = transformThinkingParts(response) as any;
    expect(result.candidates[0].content.parts[0].providerMetadata).toEqual({
      anthropic: { signature: "anthro_sig_xyz" }
    });
    expect(result.candidates[0].content.parts[0].signature).toBeUndefined();
  });

  it("converts signature in content array (Anthropic-style)", () => {
    const response = {
      content: [
        { type: "thinking", thinking: "my thoughts", signature: "content_sig" },
        { type: "text", text: "visible" },
      ],
    };
    const result = transformThinkingParts(response) as any;
    expect(result.content[0].providerMetadata).toEqual({
      anthropic: { signature: "content_sig" }
    });
    expect(result.content[0].signature).toBeUndefined();
    expect(result.content[0].thoughtSignature).toBeUndefined();
  });

  it("prefers signature over thoughtSignature when both present", () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "thinking", signature: "sig_primary", thoughtSignature: "sig_fallback" },
            ],
          },
        },
      ],
    };
    const result = transformThinkingParts(response) as any;
    expect(result.candidates[0].content.parts[0].providerMetadata).toEqual({
      anthropic: { signature: "sig_primary" }
    });
  });

  it("does not add providerMetadata when no signature present", () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "thinking without signature" },
              { text: "output" },
            ],
          },
        },
      ],
    };
    const result = transformThinkingParts(response) as any;
    expect(result.candidates[0].content.parts[0].providerMetadata).toBeUndefined();
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

describe("injectParameterSignatures", () => {
  it("injects signatures into tool descriptions", () => {
    const tools = [
      {
        functionDeclarations: [
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "File path" },
              },
              required: ["path"],
            },
          },
        ],
      },
    ];

    const result = injectParameterSignatures(tools);
    expect(result[0].functionDeclarations[0].description).toContain("STRICT PARAMETERS:");
    expect(result[0].functionDeclarations[0].description).toContain("path");
    expect(result[0].functionDeclarations[0].description).toContain("REQUIRED");
  });

  it("skips injection if STRICT PARAMETERS already present", () => {
    const tools = [
      {
        functionDeclarations: [
          {
            name: "read",
            description: "Read a file\n\nSTRICT PARAMETERS: path (string, REQUIRED)",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          },
        ],
      },
    ];

    const result = injectParameterSignatures(tools);
    const matches = result[0].functionDeclarations[0].description.match(/STRICT PARAMETERS/g);
    expect(matches).toHaveLength(1);
  });

  it("skips tools without properties", () => {
    const tools = [
      {
        functionDeclarations: [
          {
            name: "empty_tool",
            description: "A tool with no params",
            parameters: {
              type: "object",
              properties: {},
            },
          },
        ],
      },
    ];

    const result = injectParameterSignatures(tools);
    expect(result[0].functionDeclarations[0].description).toBe("A tool with no params");
  });

  it("handles missing parameters gracefully", () => {
    const tools = [
      {
        functionDeclarations: [
          {
            name: "no_params",
            description: "No parameters defined",
          },
        ],
      },
    ];

    const result = injectParameterSignatures(tools);
    expect(result[0].functionDeclarations[0].description).toBe("No parameters defined");
  });

  it("returns empty array for empty input", () => {
    expect(injectParameterSignatures([])).toEqual([]);
  });

  it("returns null/undefined as-is", () => {
    expect(injectParameterSignatures(null as any)).toBeNull();
    expect(injectParameterSignatures(undefined as any)).toBeUndefined();
  });
});

describe("injectToolHardeningInstruction", () => {
  it("injects system instruction when none exists", () => {
    const payload: Record<string, unknown> = {};
    injectToolHardeningInstruction(payload, "CRITICAL TOOL USAGE INSTRUCTIONS: Test");
    
    expect(payload.systemInstruction).toBeDefined();
    const instruction = payload.systemInstruction as any;
    expect(instruction.parts[0].text).toBe("CRITICAL TOOL USAGE INSTRUCTIONS: Test");
  });

  it("prepends to existing system instruction parts", () => {
    const payload: Record<string, unknown> = {
      systemInstruction: {
        parts: [{ text: "Existing instruction" }],
      },
    };
    injectToolHardeningInstruction(payload, "CRITICAL TOOL USAGE INSTRUCTIONS: New");
    
    const instruction = payload.systemInstruction as any;
    expect(instruction.parts).toHaveLength(2);
    expect(instruction.parts[0].text).toBe("CRITICAL TOOL USAGE INSTRUCTIONS: New");
    expect(instruction.parts[1].text).toBe("Existing instruction");
  });

  it("skips injection if CRITICAL TOOL USAGE INSTRUCTIONS already present", () => {
    const payload: Record<string, unknown> = {
      systemInstruction: {
        parts: [{ text: "CRITICAL TOOL USAGE INSTRUCTIONS: Already here" }],
      },
    };
    injectToolHardeningInstruction(payload, "CRITICAL TOOL USAGE INSTRUCTIONS: New");
    
    const instruction = payload.systemInstruction as any;
    expect(instruction.parts).toHaveLength(1);
    expect(instruction.parts[0].text).toBe("CRITICAL TOOL USAGE INSTRUCTIONS: Already here");
  });

  it("handles string systemInstruction", () => {
    const payload: Record<string, unknown> = {
      systemInstruction: "Existing string instruction",
    };
    injectToolHardeningInstruction(payload, "CRITICAL TOOL USAGE INSTRUCTIONS: Test");
    
    const instruction = payload.systemInstruction as any;
    expect(instruction.parts).toHaveLength(2);
    expect(instruction.parts[0].text).toBe("CRITICAL TOOL USAGE INSTRUCTIONS: Test");
    expect(instruction.parts[1].text).toBe("Existing string instruction");
  });

  it("does nothing when instructionText is empty", () => {
    const payload: Record<string, unknown> = {};
    injectToolHardeningInstruction(payload, "");
    expect(payload.systemInstruction).toBeUndefined();
  });
});

describe("placeholder parameter for empty schemas", () => {
  it("uses _placeholder boolean instead of reason string", () => {
    const tools = [
      {
        functionDeclarations: [
          {
            name: "todoread",
            description: "Read todo list",
            parameters: {
              type: "object",
              properties: {
                _placeholder: { type: "boolean", description: "Placeholder. Always pass true." },
              },
              required: ["_placeholder"],
            },
          },
        ],
      },
    ];

    const result = injectParameterSignatures(tools);
    expect(result[0].functionDeclarations[0].description).toContain("STRICT PARAMETERS:");
    expect(result[0].functionDeclarations[0].description).toContain("_placeholder (boolean");
  });
});

describe("cleanJSONSchemaForAntigravity", () => {
  describe("enum merging from anyOf/oneOf", () => {
    it("merges anyOf with const values into enum (WebFetch format pattern)", () => {
      const schema = {
        type: "object",
        properties: {
          format: {
            anyOf: [
              { const: "text" },
              { const: "markdown" },
              { const: "html" },
            ],
          },
        },
      };

      const result = cleanJSONSchemaForAntigravity(schema);

      expect(result.properties.format.enum).toEqual(["text", "markdown", "html"]);
      expect(result.properties.format.anyOf).toBeUndefined();
      expect(result.properties.format.type).toBe("string");
    });

    it("merges oneOf with const values into enum", () => {
      const schema = {
        type: "object",
        properties: {
          status: {
            oneOf: [
              { const: "pending" },
              { const: "active" },
              { const: "completed" },
            ],
          },
        },
      };

      const result = cleanJSONSchemaForAntigravity(schema);

      expect(result.properties.status.enum).toEqual(["pending", "active", "completed"]);
      expect(result.properties.status.oneOf).toBeUndefined();
    });

    it("merges anyOf with single-value enums into combined enum", () => {
      const schema = {
        type: "object",
        properties: {
          level: {
            anyOf: [
              { enum: ["low"] },
              { enum: ["medium"] },
              { enum: ["high"] },
            ],
          },
        },
      };

      const result = cleanJSONSchemaForAntigravity(schema);

      expect(result.properties.level.enum).toEqual(["low", "medium", "high"]);
    });

    it("merges anyOf with multi-value enums", () => {
      const schema = {
        type: "object",
        properties: {
          color: {
            anyOf: [
              { enum: ["red", "blue"] },
              { enum: ["green", "yellow"] },
            ],
          },
        },
      };

      const result = cleanJSONSchemaForAntigravity(schema);

      expect(result.properties.color.enum).toEqual(["red", "blue", "green", "yellow"]);
    });

    it("does not merge anyOf with complex types (not enum pattern)", () => {
      const schema = {
        type: "object",
        properties: {
          data: {
            anyOf: [
              { type: "string" },
              { type: "number" },
            ],
          },
        },
      };

      const result = cleanJSONSchemaForAntigravity(schema);

      expect(result.properties.data.enum).toBeUndefined();
      expect(result.properties.data.type).toBe("string");
    });

    it("preserves parent description when merging enum", () => {
      const schema = {
        type: "object",
        properties: {
          format: {
            description: "Output format for the content",
            anyOf: [
              { const: "text" },
              { const: "markdown" },
            ],
          },
        },
      };

      const result = cleanJSONSchemaForAntigravity(schema);

      expect(result.properties.format.enum).toEqual(["text", "markdown"]);
      expect(result.properties.format.description).toContain("Output format");
    });
  });

  it("adds enum hints to description", () => {
    const schema = {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["active", "inactive", "pending"],
        },
      },
    };

    const result = cleanJSONSchemaForAntigravity(schema);

    expect(result.properties.status.description).toContain("Allowed:");
    expect(result.properties.status.description).toContain("active");
    expect(result.properties.status.description).toContain("inactive");
    expect(result.properties.status.description).toContain("pending");
  });

  it("preserves existing enum array", () => {
    const schema = {
      type: "object",
      properties: {
        level: {
          type: "string",
          enum: ["low", "medium", "high"],
        },
      },
    };

    const result = cleanJSONSchemaForAntigravity(schema);

    expect(result.properties.level.enum).toEqual(["low", "medium", "high"]);
  });
});

describe("createSyntheticErrorResponse", () => {
  it("returns a Response with 200 OK status", async () => {
    const response = createSyntheticErrorResponse("Test error", "claude-sonnet");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  it("includes error message in SSE stream content", async () => {
    const response = createSyntheticErrorResponse("Context too long", "claude-sonnet");
    const text = await response.text();

    expect(text).toContain("Context too long");
    expect(text).toContain("data:");
    expect(text).toContain("message_start");
    expect(text).toContain("message_stop");
  });

  it("uses provided model in message_start event", async () => {
    const response = createSyntheticErrorResponse("Error", "claude-opus-4");
    const text = await response.text();

    expect(text).toContain("claude-opus-4");
  });

  it("generates valid Claude SSE event structure", async () => {
    const response = createSyntheticErrorResponse("Test", "test-model");
    const text = await response.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));

    expect(lines.length).toBeGreaterThanOrEqual(5);

    const events = lines.map((l) => JSON.parse(l.replace("data: ", "")));
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("message_start");
    expect(eventTypes).toContain("content_block_start");
    expect(eventTypes).toContain("content_block_delta");
    expect(eventTypes).toContain("content_block_stop");
    expect(eventTypes).toContain("message_stop");
  });

  it("includes error message in content_block_delta", async () => {
    const response = createSyntheticErrorResponse("Something failed", "model");
    const text = await response.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    const events = lines.map((l) => JSON.parse(l.replace("data: ", "")));
    const delta = events.find((e) => e.type === "content_block_delta");

    expect(delta?.delta?.text).toBe("Something failed");
  });

  it("sets end_turn stop reason in message_delta", async () => {
    const response = createSyntheticErrorResponse("Error", "model");
    const text = await response.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    const events = lines.map((l) => JSON.parse(l.replace("data: ", "")));
    const messageDelta = events.find((e) => e.type === "message_delta");

    expect(messageDelta?.delta?.stop_reason).toBe("end_turn");
  });
});

describe("extractVariantThinkingConfig", () => {
  it("returns undefined for undefined input", () => {
    expect(extractVariantThinkingConfig(undefined)).toBeUndefined();
  });

  it("returns undefined for empty object", () => {
    expect(extractVariantThinkingConfig({})).toBeUndefined();
  });

  it("returns undefined when google key is missing", () => {
    expect(extractVariantThinkingConfig({ other: {} })).toBeUndefined();
  });

  it("extracts thinkingLevel from Gemini 3 native format", () => {
    const result = extractVariantThinkingConfig({
      google: { thinkingLevel: "high" },
    });
    expect(result).toEqual({ thinkingLevel: "high", includeThoughts: undefined });
  });

  it("extracts thinkingLevel with includeThoughts", () => {
    const result = extractVariantThinkingConfig({
      google: { thinkingLevel: "medium", includeThoughts: true },
    });
    expect(result).toEqual({ thinkingLevel: "medium", includeThoughts: true });
  });

  it("extracts thinkingLevel with includeThoughts false", () => {
    const result = extractVariantThinkingConfig({
      google: { thinkingLevel: "low", includeThoughts: false },
    });
    expect(result).toEqual({ thinkingLevel: "low", includeThoughts: false });
  });

  it("extracts thinkingBudget from budget-based format (Claude/Gemini 2.5)", () => {
    const result = extractVariantThinkingConfig({
      google: { thinkingConfig: { thinkingBudget: 16384 } },
    });
    expect(result).toEqual({ thinkingBudget: 16384 });
  });

  it("prioritizes thinkingLevel over thinkingBudget", () => {
    const result = extractVariantThinkingConfig({
      google: { 
        thinkingLevel: "high",
        thinkingConfig: { thinkingBudget: 8192 },
      },
    });
    expect(result).toEqual({ thinkingLevel: "high", includeThoughts: undefined });
  });

  it("returns undefined for invalid thinkingLevel type", () => {
    expect(extractVariantThinkingConfig({
      google: { thinkingLevel: 123 },
    })).toBeUndefined();
  });

  it("returns undefined for invalid thinkingBudget type", () => {
    expect(extractVariantThinkingConfig({
      google: { thinkingConfig: { thinkingBudget: "high" } },
    })).toBeUndefined();
  });

  it("extracts thinkingBudget from generationConfig when providerOptions is undefined", () => {
    const result = extractVariantThinkingConfig(undefined, {
      thinkingConfig: { thinkingBudget: 8192 },
    });
    expect(result).toEqual({ thinkingBudget: 8192 });
  });

  it("extracts thinkingBudget from generationConfig when providerOptions has no google key", () => {
    const result = extractVariantThinkingConfig({}, {
      thinkingConfig: { thinkingBudget: 4096 },
    });
    expect(result).toEqual({ thinkingBudget: 4096 });
  });

  it("extracts thinkingLevel from generationConfig when providerOptions is undefined", () => {
    const result = extractVariantThinkingConfig(undefined, {
      thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
    });
    expect(result).toEqual({ thinkingLevel: "high", includeThoughts: true });
  });

  it("extracts thinkingLevel from generationConfig when providerOptions has no google key", () => {
    const result = extractVariantThinkingConfig({}, {
      thinkingConfig: { thinkingLevel: "low", includeThoughts: false },
    });
    expect(result).toEqual({ thinkingLevel: "low", includeThoughts: false });
  });

  it("prefers providerOptions over generationConfig", () => {
    const result = extractVariantThinkingConfig(
      { google: { thinkingConfig: { thinkingBudget: 32000 } } },
      { thinkingConfig: { thinkingBudget: 8192 } },
    );
    expect(result).toEqual({ thinkingBudget: 32000 });
  });

  it("prefers providerOptions thinkingLevel over generationConfig budget", () => {
    const result = extractVariantThinkingConfig(
      { google: { thinkingLevel: "low" } },
      { thinkingConfig: { thinkingBudget: 8192 } },
    );
    expect(result).toEqual({ thinkingLevel: "low" });
  });

  it("ignores generationConfig when providerOptions has googleSearch only", () => {
    const result = extractVariantThinkingConfig(
      { google: { googleSearch: { mode: "auto" } } },
      { thinkingConfig: { thinkingBudget: 8192 } },
    );
    expect(result).toEqual({
      googleSearch: { mode: "auto" },
      thinkingBudget: 8192,
    });
  });

  it("does not overwrite thinkingBudget: 0 from providerOptions with generationConfig fallback", () => {
    const result = extractVariantThinkingConfig(
      { google: { thinkingConfig: { thinkingBudget: 0 } } },
      { thinkingConfig: { thinkingBudget: 8192 } },
    );
    expect(result).toEqual({ thinkingBudget: 0 });
  });

  it("returns undefined when both sources have no thinking config", () => {
    expect(extractVariantThinkingConfig(undefined, {})).toBeUndefined();
    expect(extractVariantThinkingConfig(undefined, { temperature: 0.5 })).toBeUndefined();
  });
});

describe("deduplicateThinkingText", () => {
  function createTestBuffer() {
    return createThoughtBuffer();
  }

  it("returns non-object input unchanged", () => {
    const buffer = createTestBuffer();
    expect(deduplicateThinkingText(null, buffer)).toBeNull();
    expect(deduplicateThinkingText(undefined, buffer)).toBeUndefined();
    expect(deduplicateThinkingText("string", buffer)).toBe("string");
  });

  it("extracts delta from accumulated Gemini thinking text", () => {
    const buffer = createTestBuffer();
    
    const chunk1 = {
      candidates: [{
        content: {
          parts: [{ thought: true, text: "Hello " }],
        },
      }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result1 = deduplicateThinkingText(chunk1, buffer) as any;
    expect(result1.candidates[0].content.parts[0].text).toBe("Hello ");
    
    const chunk2 = {
      candidates: [{
        content: {
          parts: [{ thought: true, text: "Hello world" }],
        },
      }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result2 = deduplicateThinkingText(chunk2, buffer) as any;
    expect(result2.candidates[0].content.parts[0].text).toBe("world");
  });

  it("filters out empty delta parts", () => {
    const buffer = createTestBuffer();
    
    const chunk1 = {
      candidates: [{
        content: {
          parts: [{ thought: true, text: "Complete thought" }],
        },
      }],
    };
    deduplicateThinkingText(chunk1, buffer);
    
    const chunk2 = {
      candidates: [{
        content: {
          parts: [
            { thought: true, text: "Complete thought" },
            { text: "Regular text" },
          ],
        },
      }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result2 = deduplicateThinkingText(chunk2, buffer) as any;
    expect(result2.candidates[0].content.parts).toHaveLength(1);
    expect(result2.candidates[0].content.parts[0].text).toBe("Regular text");
  });

  it("extracts delta from accumulated Claude thinking blocks", () => {
    const buffer = createTestBuffer();
    
    const chunk1 = {
      content: [{ type: "thinking", thinking: "First " }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result1 = deduplicateThinkingText(chunk1, buffer) as any;
    expect(result1.content[0].thinking).toBe("First ");
    
    const chunk2 = {
      content: [{ type: "thinking", thinking: "First part" }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result2 = deduplicateThinkingText(chunk2, buffer) as any;
    expect(result2.content[0].thinking).toBe("part");
  });

  it("handles new thinking content that does not start with sent text", () => {
    const buffer = createTestBuffer();
    
    const chunk1 = {
      candidates: [{
        content: {
          parts: [{ thought: true, text: "Old thought" }],
        },
      }],
    };
    deduplicateThinkingText(chunk1, buffer);
    
    const chunk2 = {
      candidates: [{
        content: {
          parts: [{ thought: true, text: "New thought" }],
        },
      }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result2 = deduplicateThinkingText(chunk2, buffer) as any;
    expect(result2.candidates[0].content.parts[0].text).toBe("New thought");
  });

  it("preserves non-thinking parts unchanged", () => {
    const buffer = createTestBuffer();
    
    const chunk = {
      candidates: [{
        content: {
          parts: [
            { thought: true, text: "Thinking" },
            { text: "Regular text" },
            { functionCall: { name: "test" } },
          ],
        },
      }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = deduplicateThinkingText(chunk, buffer) as any;
    expect(result.candidates[0].content.parts[1].text).toBe("Regular text");
    expect(result.candidates[0].content.parts[2].functionCall.name).toBe("test");
  });


});

describe("recursivelyParseJsonStrings", () => {
  it("parses JSON strings in non-protected keys", () => {
    const input = { metadata: '{"key": "value"}' };
    const result = recursivelyParseJsonStrings(input);
    expect(result).toEqual({ metadata: { key: "value" } });
  });

  it("preserves oldString/newString even when they contain valid JSON", () => {
    const input = {
      oldString: '{"name": "test"}',
      newString: '{"name": "updated"}',
    };
    const result = recursivelyParseJsonStrings(input);
    expect(result).toEqual({
      oldString: '{"name": "test"}',
      newString: '{"name": "updated"}',
    });
  });

  it("preserves content parameter even when it contains valid JSON", () => {
    const input = {
      content: '{"dependencies": {"lodash": "^4.0.0"}}',
      filePath: "/path/to/package.json",
    };
    const result = recursivelyParseJsonStrings(input);
    expect(result).toEqual({
      content: '{"dependencies": {"lodash": "^4.0.0"}}',
      filePath: "/path/to/package.json",
    });
  });

  it("parses JSON in non-protected keys", () => {
    const input = {
      metadata: '{"version": 1}',
      oldString: '{"should": "stay"}',
    };
    const result = recursivelyParseJsonStrings(input);
    expect(result).toEqual({
      metadata: { version: 1 },
      oldString: '{"should": "stay"}',
    });
  });

  it("handles nested objects with protected keys", () => {
    const input = {
      tool: {
        name: "edit",
        args: {
          oldString: '["item1", "item2"]',
          newString: '["item1", "item2", "item3"]',
        },
      },
    };
    const result = recursivelyParseJsonStrings(input);
    expect(result).toEqual({
      tool: {
        name: "edit",
        args: {
          oldString: '["item1", "item2"]',
          newString: '["item1", "item2", "item3"]',
        },
      },
    });
  });
});
