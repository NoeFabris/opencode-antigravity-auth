import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isGeminiModel,
  isGemini3Model,
  isGemini25Model,
  isImageGenerationModel,
  buildGemini3ThinkingConfig,
  buildGemini25ThinkingConfig,
  buildImageGenerationConfig,
  normalizeGeminiTools,
  applyGeminiTransforms,
  toGeminiSchema,
} from "./gemini";
import type { RequestPayload } from "./types";

describe("transform/gemini", () => {
  describe("isGeminiModel", () => {
    it("returns true for gemini-pro", () => {
      expect(isGeminiModel("gemini-pro")).toBe(true);
    });

    it("returns true for gemini-1.5-pro", () => {
      expect(isGeminiModel("gemini-1.5-pro")).toBe(true);
    });

    it("returns true for gemini-2.5-flash", () => {
      expect(isGeminiModel("gemini-2.5-flash")).toBe(true);
    });

    it("returns true for gemini-3-pro-high", () => {
      expect(isGeminiModel("gemini-3-pro-high")).toBe(true);
    });

    it("returns true for uppercase GEMINI-PRO", () => {
      expect(isGeminiModel("GEMINI-PRO")).toBe(true);
    });

    it("returns true for mixed case Gemini-Pro", () => {
      expect(isGeminiModel("Gemini-Pro")).toBe(true);
    });

    it("returns false for claude-3-opus", () => {
      expect(isGeminiModel("claude-3-opus")).toBe(false);
    });

    it("returns false for gpt-4", () => {
      expect(isGeminiModel("gpt-4")).toBe(false);
    });

    it("returns false for gemini-claude hybrid (contains both)", () => {
      expect(isGeminiModel("gemini-claude-hybrid")).toBe(false);
    });

    it("returns false for claude-on-gemini", () => {
      expect(isGeminiModel("claude-on-gemini")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isGeminiModel("")).toBe(false);
    });
  });

  describe("isGemini3Model", () => {
    it("returns true for gemini-3-pro", () => {
      expect(isGemini3Model("gemini-3-pro")).toBe(true);
    });

    it("returns true for gemini-3-pro-high", () => {
      expect(isGemini3Model("gemini-3-pro-high")).toBe(true);
    });

    it("returns true for gemini-3-flash", () => {
      expect(isGemini3Model("gemini-3-flash")).toBe(true);
    });

    it("returns true for uppercase GEMINI-3-PRO", () => {
      expect(isGemini3Model("GEMINI-3-PRO")).toBe(true);
    });

    it("returns false for gemini-2.5-pro", () => {
      expect(isGemini3Model("gemini-2.5-pro")).toBe(false);
    });

    it("returns false for gemini-pro", () => {
      expect(isGemini3Model("gemini-pro")).toBe(false);
    });

    it("returns false for claude-3-opus", () => {
      expect(isGemini3Model("claude-3-opus")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isGemini3Model("")).toBe(false);
    });
  });

  describe("isGemini25Model", () => {
    it("returns true for gemini-2.5-pro", () => {
      expect(isGemini25Model("gemini-2.5-pro")).toBe(true);
    });

    it("returns true for gemini-2.5-flash", () => {
      expect(isGemini25Model("gemini-2.5-flash")).toBe(true);
    });

    it("returns true for gemini-2.5-pro-preview", () => {
      expect(isGemini25Model("gemini-2.5-pro-preview")).toBe(true);
    });

    it("returns true for uppercase GEMINI-2.5-PRO", () => {
      expect(isGemini25Model("GEMINI-2.5-PRO")).toBe(true);
    });

    it("returns false for gemini-3-pro", () => {
      expect(isGemini25Model("gemini-3-pro")).toBe(false);
    });

    it("returns false for gemini-2.0-flash", () => {
      expect(isGemini25Model("gemini-2.0-flash")).toBe(false);
    });

    it("returns false for gemini-pro", () => {
      expect(isGemini25Model("gemini-pro")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isGemini25Model("")).toBe(false);
    });
  });

  describe("buildGemini3ThinkingConfig", () => {
    it("builds config with includeThoughts true and low tier", () => {
      const config = buildGemini3ThinkingConfig(true, "low");
      expect(config).toEqual({
        includeThoughts: true,
        thinkingLevel: "low",
      });
    });

    it("builds config with includeThoughts true and medium tier", () => {
      const config = buildGemini3ThinkingConfig(true, "medium");
      expect(config).toEqual({
        includeThoughts: true,
        thinkingLevel: "medium",
      });
    });

    it("builds config with includeThoughts true and high tier", () => {
      const config = buildGemini3ThinkingConfig(true, "high");
      expect(config).toEqual({
        includeThoughts: true,
        thinkingLevel: "high",
      });
    });

    it("builds config with includeThoughts false", () => {
      const config = buildGemini3ThinkingConfig(false, "high");
      expect(config).toEqual({
        includeThoughts: false,
        thinkingLevel: "high",
      });
    });
  });

  describe("buildGemini25ThinkingConfig", () => {
    it("builds config with includeThoughts true and budget", () => {
      const config = buildGemini25ThinkingConfig(true, 8192);
      expect(config).toEqual({
        includeThoughts: true,
        thinkingBudget: 8192,
      });
    });

    it("builds config with includeThoughts false and budget", () => {
      const config = buildGemini25ThinkingConfig(false, 16384);
      expect(config).toEqual({
        includeThoughts: false,
        thinkingBudget: 16384,
      });
    });

    it("builds config without budget when undefined", () => {
      const config = buildGemini25ThinkingConfig(true, undefined);
      expect(config).toEqual({
        includeThoughts: true,
      });
      expect(config).not.toHaveProperty("thinkingBudget");
    });

    it("builds config without budget when zero", () => {
      const config = buildGemini25ThinkingConfig(true, 0);
      expect(config).toEqual({
        includeThoughts: true,
      });
      expect(config).not.toHaveProperty("thinkingBudget");
    });

    it("builds config without budget when negative", () => {
      const config = buildGemini25ThinkingConfig(true, -1000);
      expect(config).toEqual({
        includeThoughts: true,
      });
      expect(config).not.toHaveProperty("thinkingBudget");
    });

    it("builds config with large budget", () => {
      const config = buildGemini25ThinkingConfig(true, 100000);
      expect(config).toEqual({
        includeThoughts: true,
        thinkingBudget: 100000,
      });
    });
  });

  describe("normalizeGeminiTools", () => {
    it("returns empty debug info when tools is not an array", () => {
      const payload: RequestPayload = { contents: [] };
      const result = normalizeGeminiTools(payload);
      expect(result).toEqual({
        toolDebugMissing: 0,
        toolDebugSummaries: [],
      });
    });

    it("returns empty debug info when tools is undefined", () => {
      const payload: RequestPayload = { contents: [], tools: undefined };
      const result = normalizeGeminiTools(payload);
      expect(result).toEqual({
        toolDebugMissing: 0,
        toolDebugSummaries: [],
      });
    });

    it("normalizes tool with function.input_schema", () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            function: {
              name: "test_tool",
              description: "A test tool",
              input_schema: { type: "object", properties: { foo: { type: "string" } } },
            },
          },
        ],
      };
      const result = normalizeGeminiTools(payload);
      expect(result.toolDebugMissing).toBe(0);
      expect(result.toolDebugSummaries).toHaveLength(1);
      expect((payload.tools as unknown[])[0]).not.toHaveProperty("custom");
    });

    it("normalizes tool with function.parameters", () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            function: {
              name: "test_tool",
              description: "A test tool",
              parameters: { type: "object", properties: { bar: { type: "number" } } },
            },
          },
        ],
      };
      const result = normalizeGeminiTools(payload);
      expect(result.toolDebugMissing).toBe(0);
    });

    it("creates custom from function and strips it for Gemini", () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            function: {
              name: "my_func",
              description: "My function",
              input_schema: { type: "object" },
            },
          },
        ],
      };
      normalizeGeminiTools(payload);
      expect((payload.tools as unknown[])[0]).not.toHaveProperty("custom");
      expect((payload.tools as unknown[])[0]).toHaveProperty("function");
    });

    it("creates custom when both function and custom are missing", () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            name: "standalone_tool",
            description: "A standalone tool",
            parameters: { type: "object", properties: {} },
          },
        ],
      };
      normalizeGeminiTools(payload);
      expect((payload.tools as unknown[])[0]).not.toHaveProperty("custom");
    });

    it("counts missing schemas", () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          { name: "tool1" },
          { name: "tool2" },
          { function: { name: "tool3", input_schema: { type: "object" } } },
        ],
      };
      const result = normalizeGeminiTools(payload);
      expect(result.toolDebugMissing).toBe(2);
    });

    it("generates debug summaries for each tool", () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          { function: { name: "t1", input_schema: { type: "object" } } },
          { function: { name: "t2", input_schema: { type: "object" } } },
        ],
      };
      const result = normalizeGeminiTools(payload);
      expect(result.toolDebugSummaries).toHaveLength(2);
      expect(result.toolDebugSummaries[0]).toContain("idx=0");
      expect(result.toolDebugSummaries[1]).toContain("idx=1");
    });

    it("uses default tool name when name is missing", () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [{}],
      };
      const result = normalizeGeminiTools(payload);
      expect(result.toolDebugSummaries[0]).toContain("idx=0");
    });

    it("extracts schema from custom.input_schema", () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            custom: {
              name: "custom_tool",
              input_schema: { type: "object", properties: { x: { type: "string" } } },
            },
          },
        ],
      };
      normalizeGeminiTools(payload);
      expect((payload.tools as unknown[])[0]).not.toHaveProperty("custom");
    });

    it("extracts schema from inputSchema (camelCase)", () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            name: "camel_tool",
            inputSchema: { type: "object", properties: { y: { type: "boolean" } } },
          },
        ],
      };
      normalizeGeminiTools(payload);
      expect((payload.tools as unknown[])[0]).not.toHaveProperty("custom");
    });
  });

  describe("applyGeminiTransforms", () => {
    it("applies Gemini 3 thinking config with thinkingLevel", () => {
      const payload: RequestPayload = { contents: [] };
      applyGeminiTransforms(payload, {
        model: "gemini-3-pro-high",
        tierThinkingLevel: "high",
        normalizedThinking: { includeThoughts: true },
      });
      const genConfig = payload.generationConfig as Record<string, unknown>;
      expect(genConfig.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingLevel: "high",
      });
    });

    it("applies Gemini 2.5 thinking config with thinkingBudget", () => {
      const payload: RequestPayload = { contents: [] };
      applyGeminiTransforms(payload, {
        model: "gemini-2.5-flash",
        tierThinkingBudget: 8192,
        normalizedThinking: { includeThoughts: true },
      });
      const genConfig = payload.generationConfig as Record<string, unknown>;
      expect(genConfig.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingBudget: 8192,
      });
    });

    it("prefers tierThinkingBudget over normalizedThinking.thinkingBudget", () => {
      const payload: RequestPayload = { contents: [] };
      applyGeminiTransforms(payload, {
        model: "gemini-2.5-pro",
        tierThinkingBudget: 16384,
        normalizedThinking: { includeThoughts: true, thinkingBudget: 8192 },
      });
      const genConfig = payload.generationConfig as Record<string, unknown>;
      expect((genConfig.thinkingConfig as Record<string, unknown>).thinkingBudget).toBe(16384);
    });

    it("falls back to normalizedThinking.thinkingBudget when tierThinkingBudget is undefined", () => {
      const payload: RequestPayload = { contents: [] };
      applyGeminiTransforms(payload, {
        model: "gemini-2.5-pro",
        normalizedThinking: { includeThoughts: true, thinkingBudget: 4096 },
      });
      const genConfig = payload.generationConfig as Record<string, unknown>;
      expect((genConfig.thinkingConfig as Record<string, unknown>).thinkingBudget).toBe(4096);
    });

    it("does not apply thinking config when normalizedThinking is undefined", () => {
      const payload: RequestPayload = { contents: [] };
      applyGeminiTransforms(payload, {
        model: "gemini-3-pro",
      });
      expect(payload.generationConfig).toBeUndefined();
    });

    it("preserves existing generationConfig properties", () => {
      const payload: RequestPayload = {
        contents: [],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1000 },
      };
      applyGeminiTransforms(payload, {
        model: "gemini-3-pro-medium",
        tierThinkingLevel: "medium",
        normalizedThinking: { includeThoughts: true },
      });
      const genConfig = payload.generationConfig as Record<string, unknown>;
      expect(genConfig.temperature).toBe(0.7);
      expect(genConfig.maxOutputTokens).toBe(1000);
      expect(genConfig.thinkingConfig).toBeDefined();
    });

    it("normalizes tools and returns debug info", () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          { function: { name: "tool1", input_schema: { type: "object" } } },
          { name: "tool2" },
        ],
      };
      const result = applyGeminiTransforms(payload, {
        model: "gemini-2.5-flash",
      });
      expect(result.toolDebugSummaries).toHaveLength(2);
      expect(result.toolDebugMissing).toBe(1);
    });

    it("defaults includeThoughts to true when not specified", () => {
      const payload: RequestPayload = { contents: [] };
      applyGeminiTransforms(payload, {
        model: "gemini-3-pro-low",
        tierThinkingLevel: "low",
        normalizedThinking: {},
      });
      const genConfig = payload.generationConfig as Record<string, unknown>;
      expect((genConfig.thinkingConfig as Record<string, unknown>).includeThoughts).toBe(true);
    });

    it("respects includeThoughts false", () => {
      const payload: RequestPayload = { contents: [] };
      applyGeminiTransforms(payload, {
        model: "gemini-3-pro-high",
        tierThinkingLevel: "high",
        normalizedThinking: { includeThoughts: false },
      });
      const genConfig = payload.generationConfig as Record<string, unknown>;
      expect((genConfig.thinkingConfig as Record<string, unknown>).includeThoughts).toBe(false);
    });

    it("handles Gemini 2.5 without tierThinkingBudget or normalizedThinking.thinkingBudget", () => {
      const payload: RequestPayload = { contents: [] };
      applyGeminiTransforms(payload, {
        model: "gemini-2.5-pro",
        normalizedThinking: { includeThoughts: true },
      });
      const genConfig = payload.generationConfig as Record<string, unknown>;
      const thinkingConfig = genConfig.thinkingConfig as Record<string, unknown>;
      expect(thinkingConfig.includeThoughts).toBe(true);
      expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
    });
  });

  describe("isImageGenerationModel", () => {
    it("returns true for gemini-3-pro-image", () => {
      expect(isImageGenerationModel("gemini-3-pro-image")).toBe(true);
    });

    it("returns true for gemini-3-pro-image-preview", () => {
      expect(isImageGenerationModel("gemini-3-pro-image-preview")).toBe(true);
    });

    it("returns true for gemini-2.5-flash-image", () => {
      expect(isImageGenerationModel("gemini-2.5-flash-image")).toBe(true);
    });

    it("returns true for imagen-3", () => {
      expect(isImageGenerationModel("imagen-3")).toBe(true);
    });

    it("returns true for uppercase GEMINI-3-PRO-IMAGE", () => {
      expect(isImageGenerationModel("GEMINI-3-PRO-IMAGE")).toBe(true);
    });

    it("returns false for gemini-3-pro", () => {
      expect(isImageGenerationModel("gemini-3-pro")).toBe(false);
    });

    it("returns false for gemini-2.5-flash", () => {
      expect(isImageGenerationModel("gemini-2.5-flash")).toBe(false);
    });

    it("returns false for claude-sonnet-4-5", () => {
      expect(isImageGenerationModel("claude-sonnet-4-5")).toBe(false);
    });
  });

  describe("buildImageGenerationConfig", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      // Reset environment before each test
      vi.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("returns default 1:1 aspect ratio when no env var set", () => {
      delete process.env.OPENCODE_IMAGE_ASPECT_RATIO;
      const config = buildImageGenerationConfig();
      expect(config).toEqual({ aspectRatio: "1:1" });
    });

    it("uses OPENCODE_IMAGE_ASPECT_RATIO env var when set to valid value", () => {
      process.env.OPENCODE_IMAGE_ASPECT_RATIO = "16:9";
      const config = buildImageGenerationConfig();
      expect(config).toEqual({ aspectRatio: "16:9" });
    });

    it("accepts all valid aspect ratios", () => {
      const validRatios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
      for (const ratio of validRatios) {
        process.env.OPENCODE_IMAGE_ASPECT_RATIO = ratio;
        const config = buildImageGenerationConfig();
        expect(config.aspectRatio).toBe(ratio);
      }
    });

    it("falls back to 1:1 for invalid aspect ratio", () => {
      process.env.OPENCODE_IMAGE_ASPECT_RATIO = "invalid";
      const config = buildImageGenerationConfig();
      expect(config).toEqual({ aspectRatio: "1:1" });
    });

    it("falls back to 1:1 for unsupported aspect ratio", () => {
      process.env.OPENCODE_IMAGE_ASPECT_RATIO = "5:3";
      const config = buildImageGenerationConfig();
      expect(config).toEqual({ aspectRatio: "1:1" });
    });
  });

  describe("toGeminiSchema", () => {
    it("returns null/undefined as-is", () => {
      expect(toGeminiSchema(null)).toBe(null);
      expect(toGeminiSchema(undefined)).toBe(undefined);
    });

    it("returns primitives as-is", () => {
      expect(toGeminiSchema("string")).toBe("string");
      expect(toGeminiSchema(123)).toBe(123);
      expect(toGeminiSchema(true)).toBe(true);
    });

    it("returns arrays as-is", () => {
      const arr = [1, 2, 3];
      expect(toGeminiSchema(arr)).toBe(arr);
    });

    it("converts type to uppercase", () => {
      expect(toGeminiSchema({ type: "object" })).toEqual({ type: "OBJECT" });
      expect(toGeminiSchema({ type: "string" })).toEqual({ type: "STRING" });
      expect(toGeminiSchema({ type: "boolean" })).toEqual({ type: "BOOLEAN" });
      expect(toGeminiSchema({ type: "number" })).toEqual({ type: "NUMBER" });
      expect(toGeminiSchema({ type: "integer" })).toEqual({ type: "INTEGER" });
      expect(toGeminiSchema({ type: "array" })).toEqual({ type: "ARRAY" });
    });

    it("removes additionalProperties field", () => {
      const schema = {
        type: "object",
        properties: { foo: { type: "string" } },
        additionalProperties: false,
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      expect(result).not.toHaveProperty("additionalProperties");
      expect(result.type).toBe("OBJECT");
    });

    it("removes $schema field", () => {
      const schema = {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      expect(result).not.toHaveProperty("$schema");
      expect(result.type).toBe("OBJECT");
    });

    it("removes $id and $comment fields", () => {
      const schema = {
        $id: "my-schema",
        $comment: "This is a comment",
        type: "object",
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      expect(result).not.toHaveProperty("$id");
      expect(result).not.toHaveProperty("$comment");
      expect(result.type).toBe("OBJECT");
    });

    it("recursively transforms properties", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          active: { type: "boolean" },
        },
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      const props = result.properties as Record<string, Record<string, string>>;
      expect(props["name"]!.type).toBe("STRING");
      expect(props["age"]!.type).toBe("NUMBER");
      expect(props["active"]!.type).toBe("BOOLEAN");
    });

    it("transforms nested objects recursively", () => {
      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              email: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      const props = result.properties as Record<string, Record<string, unknown>>;
      expect(props["user"]!.type).toBe("OBJECT");
      expect(props["user"]).not.toHaveProperty("additionalProperties");
      const userProps = props["user"]!.properties as Record<string, Record<string, string>>;
      expect(userProps["email"]!.type).toBe("STRING");
    });

    it("transforms array items schema", () => {
      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
          },
        },
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      expect(result.type).toBe("ARRAY");
      const items = result.items as Record<string, unknown>;
      expect(items.type).toBe("OBJECT");
      const itemProps = items.properties as Record<string, Record<string, string>>;
      expect(itemProps["id"]!.type).toBe("NUMBER");
    });

    it("transforms anyOf schemas", () => {
      const schema = {
        anyOf: [
          { type: "string" },
          { type: "number" },
        ],
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      const anyOf = result.anyOf as Array<Record<string, string>>;
      expect(anyOf[0]!.type).toBe("STRING");
      expect(anyOf[1]!.type).toBe("NUMBER");
    });

    it("transforms oneOf schemas", () => {
      const schema = {
        oneOf: [
          { type: "boolean" },
          { type: "string" },
        ],
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      const oneOf = result.oneOf as Array<Record<string, string>>;
      expect(oneOf[0]!.type).toBe("BOOLEAN");
      expect(oneOf[1]!.type).toBe("STRING");
    });

    it("transforms allOf schemas", () => {
      const schema = {
        allOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { properties: { b: { type: "number" } } },
        ],
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      const allOf = result.allOf as Array<Record<string, unknown>>;
      expect(allOf[0]!.type).toBe("OBJECT");
      const props0 = allOf[0]!.properties as Record<string, Record<string, string>>;
      expect(props0["a"]!.type).toBe("STRING");
      const props1 = allOf[1]!.properties as Record<string, Record<string, string>>;
      expect(props1["b"]!.type).toBe("NUMBER");
    });

    it("preserves enum values", () => {
      const schema = {
        type: "string",
        enum: ["low", "medium", "high"],
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      expect(result.type).toBe("STRING");
      expect(result.enum).toEqual(["low", "medium", "high"]);
    });

    it("preserves required array when all properties exist", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      expect(result.required).toEqual(["name"]);
    });

    it("filters required array to only include existing properties", () => {
      // This fixes: "parameters.required[X]: property is not defined"
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name", "nonexistent", "age", "alsoMissing"],
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      expect(result.required).toEqual(["name", "age"]);
    });

    it("omits required field when no valid properties remain", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["nonexistent", "alsoMissing"],
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      expect(result).not.toHaveProperty("required");
    });

    it("handles MCP tool with missing properties in required (issue #161)", () => {
      // Simulates the group_execute_tool schema from issue #161
      const schema = {
        type: "object",
        properties: {
          mcp_name: { type: "string", enum: ["exa-mcp-server", "context7"] },
          tool_name: { type: "string" },
          // Note: "arguments" is missing from properties but present in required
        },
        required: ["mcp_name", "tool_name", "arguments"],
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      // Should filter out "arguments" since it doesn't exist in properties
      expect(result.required).toEqual(["mcp_name", "tool_name"]);
      expect(result.type).toBe("OBJECT");
    });

    it("preserves description", () => {
      const schema = {
        type: "string",
        description: "User's full name",
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      expect(result.description).toBe("User's full name");
    });

    it("preserves default value", () => {
      const schema = {
        type: "number",
        default: 42,
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      expect(result.default).toBe(42);
    });

    it("handles complex real-world MCP schema", () => {
      // Simulates a PostHog-like complex schema with enums and nested types
      const schema = {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          event_name: {
            type: "string",
            description: "Event name to track",
          },
          properties: {
            type: "object",
            additionalProperties: true,
            description: "Event properties",
          },
          level: {
            type: "string",
            enum: ["info", "warning", "error"],
          },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                value: { type: "number" },
              },
              additionalProperties: false,
            },
          },
        },
        required: ["event_name"],
        additionalProperties: false,
      };
      const result = toGeminiSchema(schema) as Record<string, unknown>;
      
      // Should remove unsupported fields
      expect(result).not.toHaveProperty("$schema");
      expect(result).not.toHaveProperty("additionalProperties");
      
      // Should uppercase types
      expect(result.type).toBe("OBJECT");
      
      const props = result.properties as Record<string, Record<string, unknown>>;
      expect(props["event_name"]!.type).toBe("STRING");
      expect(props["properties"]!.type).toBe("OBJECT");
      expect(props["properties"]).not.toHaveProperty("additionalProperties");
      expect(props["level"]!.type).toBe("STRING");
      expect(props["level"]!.enum).toEqual(["info", "warning", "error"]);
      expect(props["items"]!.type).toBe("ARRAY");
      
      const itemsSchema = props["items"]!.items as Record<string, unknown>;
      expect(itemsSchema.type).toBe("OBJECT");
      expect(itemsSchema).not.toHaveProperty("additionalProperties");
      
      const itemProps = itemsSchema.properties as Record<string, Record<string, string>>;
      expect(itemProps["id"]!.type).toBe("STRING");
      expect(itemProps["value"]!.type).toBe("NUMBER");
      
      // Should preserve required
      expect(result.required).toEqual(["event_name"]);
    });
  });

  describe("normalizeGeminiTools schema transformation", () => {
    it("transforms tool schemas to Gemini format with uppercase types", () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            function: {
              name: "test_tool",
              description: "A test tool",
              input_schema: { 
                type: "object", 
                properties: { 
                  name: { type: "string" },
                  count: { type: "number" },
                },
              },
            },
          },
        ],
      };
      normalizeGeminiTools(payload);
      
      const tool = (payload.tools as unknown[])[0] as Record<string, unknown>;
      const func = tool.function as Record<string, unknown>;
      const schema = func.input_schema as Record<string, unknown>;
      
      expect(schema.type).toBe("OBJECT");
      const props = schema.properties as Record<string, Record<string, string>>;
      expect(props["name"]!.type).toBe("STRING");
      expect(props["count"]!.type).toBe("NUMBER");
    });

    it("removes additionalProperties from tool schemas", () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            function: {
              name: "strict_tool",
              input_schema: { 
                type: "object", 
                properties: {},
                additionalProperties: false,
              },
            },
          },
        ],
      };
      normalizeGeminiTools(payload);
      
      const tool = (payload.tools as unknown[])[0] as Record<string, unknown>;
      const func = tool.function as Record<string, unknown>;
      const schema = func.input_schema as Record<string, unknown>;
      
      expect(schema).not.toHaveProperty("additionalProperties");
      expect(schema.type).toBe("OBJECT");
    });

    it("uses uppercase placeholder schema for tools without schemas", () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [{ name: "schema_less_tool" }],
      };
      const result = normalizeGeminiTools(payload);
      
      expect(result.toolDebugMissing).toBe(1);
      
      // Check that placeholder uses uppercase types
      const tool = (payload.tools as unknown[])[0] as Record<string, unknown>;
      const params = tool.parameters as Record<string, unknown>;
      expect(params.type).toBe("OBJECT");
      
      const props = params.properties as Record<string, Record<string, string>>;
      expect(props["_placeholder"]!.type).toBe("BOOLEAN");
    });
  });
});
