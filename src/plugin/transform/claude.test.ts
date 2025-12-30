import { describe, it, expect } from "vitest";
import {
  isClaudeModel,
  isClaudeThinkingModel,
  configureClaudeToolConfig,
  buildClaudeThinkingConfig,
  ensureClaudeMaxOutputTokens,
  appendClaudeThinkingHint,
  normalizeClaudeTools,
  applyClaudeTransforms,
  CLAUDE_THINKING_MAX_OUTPUT_TOKENS,
  CLAUDE_INTERLEAVED_THINKING_HINT,
} from "./claude";
import type { RequestPayload } from "./types";

describe("isClaudeModel", () => {
  it("returns true for claude model names", () => {
    expect(isClaudeModel("claude-sonnet-4-5")).toBe(true);
    expect(isClaudeModel("claude-opus-4-5")).toBe(true);
    expect(isClaudeModel("claude-3-opus")).toBe(true);
    expect(isClaudeModel("claude-3-5-sonnet")).toBe(true);
  });

  it("returns true for case-insensitive matches", () => {
    expect(isClaudeModel("CLAUDE-SONNET-4-5")).toBe(true);
    expect(isClaudeModel("Claude-Opus-4-5")).toBe(true);
    expect(isClaudeModel("cLaUdE-3-opus")).toBe(true);
  });

  it("returns true for prefixed claude models", () => {
    expect(isClaudeModel("antigravity-claude-sonnet-4-5")).toBe(true);
    expect(isClaudeModel("google/claude-opus-4-5")).toBe(true);
  });

  it("returns false for non-claude models", () => {
    expect(isClaudeModel("gemini-3-pro")).toBe(false);
    expect(isClaudeModel("gpt-4")).toBe(false);
    expect(isClaudeModel("llama-3")).toBe(false);
    expect(isClaudeModel("")).toBe(false);
  });

  it("returns false for similar but non-claude names", () => {
    expect(isClaudeModel("claudia-model")).toBe(false);
    expect(isClaudeModel("clade-model")).toBe(false);
  });
});

describe("isClaudeThinkingModel", () => {
  it("returns true for claude thinking models", () => {
    expect(isClaudeThinkingModel("claude-sonnet-4-5-thinking")).toBe(true);
    expect(isClaudeThinkingModel("claude-opus-4-5-thinking")).toBe(true);
    expect(isClaudeThinkingModel("claude-sonnet-4-5-thinking-high")).toBe(true);
    expect(isClaudeThinkingModel("claude-opus-4-5-thinking-low")).toBe(true);
  });

  it("returns true for case-insensitive matches", () => {
    expect(isClaudeThinkingModel("CLAUDE-SONNET-4-5-THINKING")).toBe(true);
    expect(isClaudeThinkingModel("Claude-Opus-4-5-Thinking")).toBe(true);
  });

  it("returns true for prefixed thinking models", () => {
    expect(isClaudeThinkingModel("antigravity-claude-sonnet-4-5-thinking")).toBe(true);
    expect(isClaudeThinkingModel("google/claude-opus-4-5-thinking-high")).toBe(true);
  });

  it("returns false for non-thinking claude models", () => {
    expect(isClaudeThinkingModel("claude-sonnet-4-5")).toBe(false);
    expect(isClaudeThinkingModel("claude-opus-4-5")).toBe(false);
    expect(isClaudeThinkingModel("claude-3-opus")).toBe(false);
  });

  it("returns false for non-claude models", () => {
    expect(isClaudeThinkingModel("gemini-3-pro-thinking")).toBe(false);
    expect(isClaudeThinkingModel("gpt-4-thinking")).toBe(false);
  });

  it("requires both claude and thinking keywords", () => {
    expect(isClaudeThinkingModel("thinking-model")).toBe(false);
    expect(isClaudeThinkingModel("claude-model")).toBe(false);
  });
});

describe("configureClaudeToolConfig", () => {
  it("creates toolConfig if not present", () => {
    const payload: RequestPayload = {};
    configureClaudeToolConfig(payload);
    
    expect(payload.toolConfig).toBeDefined();
    expect((payload.toolConfig as any).functionCallingConfig).toBeDefined();
    expect((payload.toolConfig as any).functionCallingConfig.mode).toBe("VALIDATED");
  });

  it("adds functionCallingConfig to existing toolConfig", () => {
    const payload: RequestPayload = {
      toolConfig: { someOtherConfig: true },
    };
    configureClaudeToolConfig(payload);
    
    expect((payload.toolConfig as any).someOtherConfig).toBe(true);
    expect((payload.toolConfig as any).functionCallingConfig.mode).toBe("VALIDATED");
  });

  it("sets mode to VALIDATED on existing functionCallingConfig", () => {
    const payload: RequestPayload = {
      toolConfig: {
        functionCallingConfig: { existingKey: "value" },
      },
    };
    configureClaudeToolConfig(payload);
    
    expect((payload.toolConfig as any).functionCallingConfig.existingKey).toBe("value");
    expect((payload.toolConfig as any).functionCallingConfig.mode).toBe("VALIDATED");
  });

  it("overwrites existing mode", () => {
    const payload: RequestPayload = {
      toolConfig: {
        functionCallingConfig: { mode: "AUTO" },
      },
    };
    configureClaudeToolConfig(payload);
    
    expect((payload.toolConfig as any).functionCallingConfig.mode).toBe("VALIDATED");
  });

  it("handles null toolConfig gracefully", () => {
    const payload: RequestPayload = { toolConfig: null };
    configureClaudeToolConfig(payload);
    
    expect(payload.toolConfig).toBeDefined();
  });
});

describe("buildClaudeThinkingConfig", () => {
  it("builds config with include_thoughts only", () => {
    const config = buildClaudeThinkingConfig(true);
    
    expect(config).toEqual({ include_thoughts: true });
  });

  it("builds config with include_thoughts false", () => {
    const config = buildClaudeThinkingConfig(false);
    
    expect(config).toEqual({ include_thoughts: false });
  });

  it("includes thinking_budget when provided and positive", () => {
    const config = buildClaudeThinkingConfig(true, 8192);
    
    expect(config).toEqual({
      include_thoughts: true,
      thinking_budget: 8192,
    });
  });

  it("excludes thinking_budget when zero", () => {
    const config = buildClaudeThinkingConfig(true, 0);
    
    expect(config).toEqual({ include_thoughts: true });
  });

  it("excludes thinking_budget when negative", () => {
    const config = buildClaudeThinkingConfig(true, -100);
    
    expect(config).toEqual({ include_thoughts: true });
  });

  it("excludes thinking_budget when undefined", () => {
    const config = buildClaudeThinkingConfig(true, undefined);
    
    expect(config).toEqual({ include_thoughts: true });
  });

  it("handles various budget values", () => {
    expect(buildClaudeThinkingConfig(true, 8192)).toHaveProperty("thinking_budget", 8192);
    expect(buildClaudeThinkingConfig(true, 16384)).toHaveProperty("thinking_budget", 16384);
    expect(buildClaudeThinkingConfig(true, 32768)).toHaveProperty("thinking_budget", 32768);
  });
});

describe("ensureClaudeMaxOutputTokens", () => {
  it("sets maxOutputTokens when not present", () => {
    const config: Record<string, unknown> = {};
    ensureClaudeMaxOutputTokens(config, 8192);
    
    expect(config.maxOutputTokens).toBe(CLAUDE_THINKING_MAX_OUTPUT_TOKENS);
  });

  it("sets maxOutputTokens when current is less than budget", () => {
    const config: Record<string, unknown> = { maxOutputTokens: 4096 };
    ensureClaudeMaxOutputTokens(config, 8192);
    
    expect(config.maxOutputTokens).toBe(CLAUDE_THINKING_MAX_OUTPUT_TOKENS);
  });

  it("sets maxOutputTokens when current equals budget", () => {
    const config: Record<string, unknown> = { maxOutputTokens: 8192 };
    ensureClaudeMaxOutputTokens(config, 8192);
    
    expect(config.maxOutputTokens).toBe(CLAUDE_THINKING_MAX_OUTPUT_TOKENS);
  });

  it("does not change maxOutputTokens when current is greater than budget", () => {
    const config: Record<string, unknown> = { maxOutputTokens: 100000 };
    ensureClaudeMaxOutputTokens(config, 8192);
    
    expect(config.maxOutputTokens).toBe(100000);
  });

  it("handles snake_case max_output_tokens", () => {
    const config: Record<string, unknown> = { max_output_tokens: 4096 };
    ensureClaudeMaxOutputTokens(config, 8192);
    
    expect(config.maxOutputTokens).toBe(CLAUDE_THINKING_MAX_OUTPUT_TOKENS);
    expect(config.max_output_tokens).toBeUndefined();
  });

  it("removes max_output_tokens when setting maxOutputTokens", () => {
    const config: Record<string, unknown> = { 
      max_output_tokens: 4096,
      maxOutputTokens: 4096,
    };
    ensureClaudeMaxOutputTokens(config, 8192);
    
    expect(config.maxOutputTokens).toBe(CLAUDE_THINKING_MAX_OUTPUT_TOKENS);
    expect(config.max_output_tokens).toBeUndefined();
  });

  it("prefers maxOutputTokens over max_output_tokens for comparison", () => {
    const config: Record<string, unknown> = { 
      maxOutputTokens: 100000,
      max_output_tokens: 4096,
    };
    ensureClaudeMaxOutputTokens(config, 8192);
    
    expect(config.maxOutputTokens).toBe(100000);
  });
});

describe("appendClaudeThinkingHint", () => {
  describe("with string systemInstruction", () => {
    it("appends hint to existing string instruction", () => {
      const payload: RequestPayload = {
        systemInstruction: "You are a helpful assistant.",
      };
      appendClaudeThinkingHint(payload);
      
      expect(payload.systemInstruction).toBe(
        `You are a helpful assistant.\n\n${CLAUDE_INTERLEAVED_THINKING_HINT}`
      );
    });

    it("uses hint alone when existing instruction is empty", () => {
      const payload: RequestPayload = {
        systemInstruction: "",
      };
      appendClaudeThinkingHint(payload);
      
      expect(payload.systemInstruction).toBe(CLAUDE_INTERLEAVED_THINKING_HINT);
    });

    it("uses hint alone when existing instruction is whitespace", () => {
      const payload: RequestPayload = {
        systemInstruction: "   ",
      };
      appendClaudeThinkingHint(payload);
      
      expect(payload.systemInstruction).toBe(CLAUDE_INTERLEAVED_THINKING_HINT);
    });

    it("accepts custom hint", () => {
      const payload: RequestPayload = {
        systemInstruction: "Base instruction.",
      };
      appendClaudeThinkingHint(payload, "Custom hint.");
      
      expect(payload.systemInstruction).toBe("Base instruction.\n\nCustom hint.");
    });
  });

  describe("with object systemInstruction (parts array)", () => {
    it("appends hint to last text part", () => {
      const payload: RequestPayload = {
        systemInstruction: {
          parts: [{ text: "First part." }, { text: "Last part." }],
        },
      };
      appendClaudeThinkingHint(payload);
      
      const sys = payload.systemInstruction as any;
      expect(sys.parts[0].text).toBe("First part.");
      expect(sys.parts[1].text).toBe(`Last part.\n\n${CLAUDE_INTERLEAVED_THINKING_HINT}`);
    });

    it("appends hint to single text part", () => {
      const payload: RequestPayload = {
        systemInstruction: {
          parts: [{ text: "Only part." }],
        },
      };
      appendClaudeThinkingHint(payload);
      
      const sys = payload.systemInstruction as any;
      expect(sys.parts[0].text).toBe(`Only part.\n\n${CLAUDE_INTERLEAVED_THINKING_HINT}`);
    });

    it("creates new text part when no text parts exist", () => {
      const payload: RequestPayload = {
        systemInstruction: {
          parts: [{ image: "base64data" }],
        },
      };
      appendClaudeThinkingHint(payload);
      
      const sys = payload.systemInstruction as any;
      expect(sys.parts).toHaveLength(2);
      expect(sys.parts[1].text).toBe(CLAUDE_INTERLEAVED_THINKING_HINT);
    });

    it("creates parts array when not present", () => {
      const payload: RequestPayload = {
        systemInstruction: { role: "system" },
      };
      appendClaudeThinkingHint(payload);
      
      const sys = payload.systemInstruction as any;
      expect(sys.parts).toEqual([{ text: CLAUDE_INTERLEAVED_THINKING_HINT }]);
    });
  });

  describe("with no systemInstruction", () => {
    it("creates systemInstruction when contents array exists", () => {
      const payload: RequestPayload = {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      };
      appendClaudeThinkingHint(payload);
      
      expect(payload.systemInstruction).toEqual({
        parts: [{ text: CLAUDE_INTERLEAVED_THINKING_HINT }],
      });
    });

    it("does not create systemInstruction when no contents", () => {
      const payload: RequestPayload = {};
      appendClaudeThinkingHint(payload);
      
      expect(payload.systemInstruction).toBeUndefined();
    });
  });
});

describe("normalizeClaudeTools", () => {
  const identityClean = (schema: unknown) => schema as Record<string, unknown>;
  
  const realClean = (schema: unknown): Record<string, unknown> => {
    if (!schema || typeof schema !== "object") return {};
    const cleaned = { ...schema as Record<string, unknown> };
    delete cleaned.$schema;
    delete cleaned.$id;
    return cleaned;
  };

  it("returns empty result when no tools", () => {
    const payload: RequestPayload = {};
    const result = normalizeClaudeTools(payload, identityClean);
    
    expect(result.toolDebugMissing).toBe(0);
    expect(result.toolDebugSummaries).toEqual([]);
  });

  it("returns empty result when tools is not an array", () => {
    const payload: RequestPayload = { tools: "not an array" };
    const result = normalizeClaudeTools(payload, identityClean);
    
    expect(result.toolDebugMissing).toBe(0);
    expect(result.toolDebugSummaries).toEqual([]);
  });

  describe("functionDeclarations format", () => {
    it("normalizes tools with functionDeclarations array", () => {
      const payload: RequestPayload = {
        tools: [{
          functionDeclarations: [{
            name: "get_weather",
            description: "Get weather for a location",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
              required: ["location"],
            },
          }],
        }],
      };
      
      const result = normalizeClaudeTools(payload, identityClean);
      
      expect(result.toolDebugMissing).toBe(0);
      expect(result.toolDebugSummaries).toContain("decl=get_weather,src=functionDeclarations,hasSchema=y");
      
      const tools = payload.tools as any[];
      expect(tools).toHaveLength(1);
      expect(tools[0].functionDeclarations).toHaveLength(1);
      expect(tools[0].functionDeclarations[0].name).toBe("get_weather");
    });

    it("handles multiple functionDeclarations", () => {
      const payload: RequestPayload = {
        tools: [{
          functionDeclarations: [
            { name: "tool1", description: "First tool" },
            { name: "tool2", description: "Second tool" },
          ],
        }],
      };
      
      normalizeClaudeTools(payload, identityClean);
      
      const tools = payload.tools as any[];
      expect(tools[0].functionDeclarations).toHaveLength(2);
    });
  });

  describe("function/custom format", () => {
    it("normalizes OpenAI-style function tools", () => {
      const payload: RequestPayload = {
        tools: [{
          type: "function",
          function: {
            name: "search",
            description: "Search the web",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          },
        }],
      };
      
      const result = normalizeClaudeTools(payload, identityClean);
      
      expect(result.toolDebugSummaries).toContain("decl=search,src=function/custom,hasSchema=y");
      
      const tools = payload.tools as any[];
      expect(tools[0].functionDeclarations[0].name).toBe("search");
    });

    it("normalizes custom-style tools", () => {
      const payload: RequestPayload = {
        tools: [{
          custom: {
            name: "custom_tool",
            description: "A custom tool",
            input_schema: {
              type: "object",
              properties: { arg: { type: "string" } },
            },
          },
        }],
      };
      
      const result = normalizeClaudeTools(payload, identityClean);
      
      expect(result.toolDebugSummaries).toContain("decl=custom_tool,src=function/custom,hasSchema=y");
    });

    it("normalizes tools with top-level name/parameters", () => {
      const payload: RequestPayload = {
        tools: [{
          name: "direct_tool",
          description: "Direct definition",
          parameters: {
            type: "object",
            properties: { value: { type: "number" } },
          },
        }],
      };
      
      normalizeClaudeTools(payload, identityClean);
      
      const tools = payload.tools as any[];
      expect(tools[0].functionDeclarations[0].name).toBe("direct_tool");
    });
  });

  describe("schema normalization", () => {
    it("adds placeholder when schema is missing", () => {
      const payload: RequestPayload = {
        tools: [{
          function: {
            name: "no_schema_tool",
            description: "Tool without schema",
          },
        }],
      };
      
      const result = normalizeClaudeTools(payload, identityClean);
      
      expect(result.toolDebugMissing).toBe(1);
      
      const tools = payload.tools as any[];
      const params = tools[0].functionDeclarations[0].parameters;
      expect(params.type).toBe("object");
      expect(params.properties._placeholder).toBeDefined();
      expect(params.required).toContain("_placeholder");
    });

    it("adds placeholder when schema has no properties", () => {
      const payload: RequestPayload = {
        tools: [{
          function: {
            name: "empty_schema_tool",
            parameters: { type: "object" },
          },
        }],
      };
      
      normalizeClaudeTools(payload, identityClean);
      
      const tools = payload.tools as any[];
      const params = tools[0].functionDeclarations[0].parameters;
      expect(params.properties._placeholder).toBeDefined();
    });

    it("preserves existing properties", () => {
      const payload: RequestPayload = {
        tools: [{
          function: {
            name: "has_props_tool",
            parameters: {
              type: "object",
              properties: {
                existingProp: { type: "string" },
              },
            },
          },
        }],
      };
      
      normalizeClaudeTools(payload, identityClean);
      
      const tools = payload.tools as any[];
      const params = tools[0].functionDeclarations[0].parameters;
      expect(params.properties.existingProp).toBeDefined();
      expect(params.properties._placeholder).toBeUndefined();
    });

    it("cleans schema using provided function", () => {
      const payload: RequestPayload = {
        tools: [{
          function: {
            name: "needs_cleaning",
            parameters: {
              $schema: "http://json-schema.org/draft-07/schema#",
              type: "object",
              properties: { arg: { type: "string" } },
            },
          },
        }],
      };
      
      normalizeClaudeTools(payload, realClean);
      
      const tools = payload.tools as any[];
      const params = tools[0].functionDeclarations[0].parameters;
      expect(params.$schema).toBeUndefined();
      expect(params.properties.arg).toBeDefined();
    });
  });

  describe("tool name sanitization", () => {
    it("removes special characters from tool names", () => {
      const payload: RequestPayload = {
        tools: [{
          function: {
            name: "tool@with#special$chars!",
            parameters: { type: "object", properties: { x: { type: "string" } } },
          },
        }],
      };
      
      normalizeClaudeTools(payload, identityClean);
      
      const tools = payload.tools as any[];
      expect(tools[0].functionDeclarations[0].name).toBe("tool_with_special_chars_");
    });

    it("truncates long tool names to 64 characters", () => {
      const longName = "a".repeat(100);
      const payload: RequestPayload = {
        tools: [{
          function: {
            name: longName,
            parameters: { type: "object", properties: { x: { type: "string" } } },
          },
        }],
      };
      
      normalizeClaudeTools(payload, identityClean);
      
      const tools = payload.tools as any[];
      expect(tools[0].functionDeclarations[0].name).toHaveLength(64);
    });

    it("generates name when missing", () => {
      const payload: RequestPayload = {
        tools: [{
          function: {
            description: "Nameless tool",
            parameters: { type: "object", properties: { x: { type: "string" } } },
          },
        }],
      };
      
      normalizeClaudeTools(payload, identityClean);
      
      const tools = payload.tools as any[];
      expect(tools[0].functionDeclarations[0].name).toBe("tool-0");
    });
  });

  describe("passthrough tools", () => {
    it("preserves non-function tools like codeExecution", () => {
      const payload: RequestPayload = {
        tools: [
          { codeExecution: {} },
          {
            function: {
              name: "regular_tool",
              parameters: { type: "object", properties: { x: { type: "string" } } },
            },
          },
        ],
      };
      
      normalizeClaudeTools(payload, identityClean);
      
      const tools = payload.tools as any[];
      expect(tools).toHaveLength(2);
      expect(tools[0].functionDeclarations).toBeDefined();
      expect(tools[1].codeExecution).toBeDefined();
    });
  });
});

describe("applyClaudeTransforms", () => {
  const mockCleanJSONSchema = (schema: unknown) => schema as Record<string, unknown>;

  it("applies tool config for all Claude models", () => {
    const payload: RequestPayload = {};
    
    applyClaudeTransforms(payload, {
      model: "claude-sonnet-4-5",
      cleanJSONSchema: mockCleanJSONSchema,
    });
    
    expect((payload.toolConfig as any)?.functionCallingConfig?.mode).toBe("VALIDATED");
  });

  it("applies thinking config for thinking models", () => {
    const payload: RequestPayload = {};
    
    applyClaudeTransforms(payload, {
      model: "claude-sonnet-4-5-thinking",
      normalizedThinking: { includeThoughts: true, thinkingBudget: 8192 },
      cleanJSONSchema: mockCleanJSONSchema,
    });
    
    const genConfig = payload.generationConfig as any;
    expect(genConfig.thinkingConfig.include_thoughts).toBe(true);
    expect(genConfig.thinkingConfig.thinking_budget).toBe(8192);
  });

  it("uses tierThinkingBudget over normalizedThinking.thinkingBudget", () => {
    const payload: RequestPayload = {};
    
    applyClaudeTransforms(payload, {
      model: "claude-sonnet-4-5-thinking",
      tierThinkingBudget: 32768,
      normalizedThinking: { includeThoughts: true, thinkingBudget: 8192 },
      cleanJSONSchema: mockCleanJSONSchema,
    });
    
    const genConfig = payload.generationConfig as any;
    expect(genConfig.thinkingConfig.thinking_budget).toBe(32768);
  });

  it("ensures maxOutputTokens for thinking models with budget", () => {
    const payload: RequestPayload = {
      generationConfig: { maxOutputTokens: 4096 },
    };
    
    applyClaudeTransforms(payload, {
      model: "claude-sonnet-4-5-thinking",
      normalizedThinking: { includeThoughts: true, thinkingBudget: 8192 },
      cleanJSONSchema: mockCleanJSONSchema,
    });
    
    const genConfig = payload.generationConfig as any;
    expect(genConfig.maxOutputTokens).toBe(CLAUDE_THINKING_MAX_OUTPUT_TOKENS);
  });

  it("does not apply thinking config for non-thinking models", () => {
    const payload: RequestPayload = {};
    
    applyClaudeTransforms(payload, {
      model: "claude-sonnet-4-5",
      normalizedThinking: { includeThoughts: true, thinkingBudget: 8192 },
      cleanJSONSchema: mockCleanJSONSchema,
    });
    
    const genConfig = payload.generationConfig as any;
    expect(genConfig?.thinkingConfig).toBeUndefined();
  });

  it("appends thinking hint for thinking models with tools", () => {
    const payload: RequestPayload = {
      systemInstruction: "You are helpful.",
      tools: [{ function: { name: "test", parameters: { type: "object", properties: { x: { type: "string" } } } } }],
    };
    
    applyClaudeTransforms(payload, {
      model: "claude-sonnet-4-5-thinking",
      cleanJSONSchema: mockCleanJSONSchema,
    });
    
    expect((payload.systemInstruction as string)).toContain(CLAUDE_INTERLEAVED_THINKING_HINT);
  });

  it("does not append thinking hint for thinking models without tools", () => {
    const payload: RequestPayload = {
      systemInstruction: "You are helpful.",
    };
    
    applyClaudeTransforms(payload, {
      model: "claude-sonnet-4-5-thinking",
      cleanJSONSchema: mockCleanJSONSchema,
    });
    
    expect((payload.systemInstruction as string)).not.toContain(CLAUDE_INTERLEAVED_THINKING_HINT);
  });

  it("does not append thinking hint for non-thinking models with tools", () => {
    const payload: RequestPayload = {
      systemInstruction: "You are helpful.",
      tools: [{ function: { name: "test", parameters: { type: "object", properties: { x: { type: "string" } } } } }],
    };
    
    applyClaudeTransforms(payload, {
      model: "claude-sonnet-4-5",
      cleanJSONSchema: mockCleanJSONSchema,
    });
    
    expect((payload.systemInstruction as string)).not.toContain(CLAUDE_INTERLEAVED_THINKING_HINT);
  });

  it("normalizes tools and returns debug info", () => {
    const payload: RequestPayload = {
      tools: [{ function: { name: "my_tool" } }],
    };
    
    const result = applyClaudeTransforms(payload, {
      model: "claude-sonnet-4-5",
      cleanJSONSchema: mockCleanJSONSchema,
    });
    
    expect(result.toolDebugMissing).toBe(1);
    expect(result.toolDebugSummaries).toContain("decl=my_tool,src=function/custom,hasSchema=n");
  });

  it("converts stop_sequences in generationConfig", () => {
    const payload: RequestPayload = {
      generationConfig: { stop_sequences: ["END"] },
    };
    
    applyClaudeTransforms(payload, {
      model: "claude-sonnet-4-5",
      cleanJSONSchema: mockCleanJSONSchema,
    });
    
    const genConfig = payload.generationConfig as any;
    expect(genConfig.stopSequences).toEqual(["END"]);
    expect(genConfig.stop_sequences).toBeUndefined();
  });
});

describe("constants", () => {
  it("exports CLAUDE_THINKING_MAX_OUTPUT_TOKENS", () => {
    expect(CLAUDE_THINKING_MAX_OUTPUT_TOKENS).toBe(64_000);
  });

  it("exports CLAUDE_INTERLEAVED_THINKING_HINT", () => {
    expect(CLAUDE_INTERLEAVED_THINKING_HINT).toContain("Interleaved thinking is enabled");
  });
});
