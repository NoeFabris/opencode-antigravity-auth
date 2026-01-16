/**
 * Gemini-specific Request Transformations
 * 
 * Handles Gemini model-specific request transformations including:
 * - Thinking config (camelCase keys, thinkingLevel for Gemini 3)
 * - Tool normalization (function/custom format)
 * - Schema transformation (JSON Schema -> Gemini Schema format)
 */

import type { RequestPayload, ThinkingConfig, ThinkingTier, GoogleSearchConfig } from "./types";

/**
 * Transform a JSON Schema to Gemini-compatible format.
 * Based on @google/genai SDK's processJsonSchema() function.
 * 
 * Key transformations:
 * - Converts type values to uppercase (object -> OBJECT)
 * - Removes unsupported fields like additionalProperties, $schema
 * - Recursively processes nested schemas (properties, items, anyOf, etc.)
 * 
 * @param schema - A JSON Schema object or primitive value
 * @returns Gemini-compatible schema
 */
/**
 * Fields that Gemini API rejects and must be removed from schemas.
 * Antigravity uses strict protobuf-backed JSON validation.
 */
const UNSUPPORTED_SCHEMA_FIELDS = new Set([
  "additionalProperties",
  "$schema",
  "$id", 
  "$comment",
  "$ref",
  "$defs",
  "definitions",
  "const",
  "contentMediaType",
  "contentEncoding",
  "if",
  "then",
  "else",
  "not",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "minContains",
  "maxContains",
]);

export function toGeminiSchema(schema: unknown): unknown {
  // Return primitives and arrays as-is
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }

  const inputSchema = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  // First pass: collect all property names for required validation
  const propertyNames = new Set<string>();
  if (inputSchema.properties && typeof inputSchema.properties === "object") {
    for (const propName of Object.keys(inputSchema.properties as Record<string, unknown>)) {
      propertyNames.add(propName);
    }
  }

  for (const [key, value] of Object.entries(inputSchema)) {
    // Skip unsupported fields that Gemini API rejects
    if (UNSUPPORTED_SCHEMA_FIELDS.has(key)) {
      continue;
    }

    if (key === "type" && typeof value === "string") {
      // Convert type to uppercase for Gemini API
      result[key] = value.toUpperCase();
    } else if (key === "properties" && typeof value === "object" && value !== null) {
      // Recursively transform nested property schemas
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propName] = toGeminiSchema(propSchema);
      }
      result[key] = props;
    } else if (key === "items" && typeof value === "object") {
      // Transform array items schema
      result[key] = toGeminiSchema(value);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      // Transform union type schemas
      result[key] = value.map((item) => toGeminiSchema(item));
    } else if (key === "enum" && Array.isArray(value)) {
      // Keep enum values as-is
      result[key] = value;
    } else if (key === "default" || key === "examples") {
      // Keep default and examples as-is
      result[key] = value;
    } else if (key === "required" && Array.isArray(value)) {
      // Filter required array to only include properties that exist
      // This fixes: "parameters.required[X]: property is not defined"
      if (propertyNames.size > 0) {
        const validRequired = value.filter((prop) => 
          typeof prop === "string" && propertyNames.has(prop)
        );
        if (validRequired.length > 0) {
          result[key] = validRequired;
        }
        // If no valid required properties, omit the required field entirely
      } else {
        // If there are no properties, keep required as-is (might be a schema without properties)
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  // Issue #80: Ensure array schemas have an 'items' field
  // Gemini API requires: "parameters.properties[X].items: missing field"
  if (result.type === "ARRAY" && !result.items) {
    result.items = { type: "STRING" };
  }

  return result;
}

/**
 * Check if a model is a Gemini model (not Claude).
 */
export function isGeminiModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("gemini") && !lower.includes("claude");
}

/**
 * Check if a model is Gemini 3 (uses thinkingLevel string).
 */
export function isGemini3Model(model: string): boolean {
  return model.toLowerCase().includes("gemini-3");
}

/**
 * Check if a model is Gemini 2.5 (uses numeric thinkingBudget).
 */
export function isGemini25Model(model: string): boolean {
  return model.toLowerCase().includes("gemini-2.5");
}

/**
 * Check if a model is an image generation model.
 * Image models don't support thinking and require imageConfig.
 */
export function isImageGenerationModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("image") ||
    lower.includes("imagen")
  );
}

/**
 * Build Gemini 3 thinking config with thinkingLevel string.
 */
export function buildGemini3ThinkingConfig(
  includeThoughts: boolean,
  thinkingLevel: ThinkingTier,
): ThinkingConfig {
  return {
    includeThoughts,
    thinkingLevel,
  };
}

/**
 * Build Gemini 2.5 thinking config with numeric thinkingBudget.
 */
export function buildGemini25ThinkingConfig(
  includeThoughts: boolean,
  thinkingBudget?: number,
): ThinkingConfig {
  return {
    includeThoughts,
    ...(typeof thinkingBudget === "number" && thinkingBudget > 0 ? { thinkingBudget } : {}),
  };
}

/**
 * Image generation config for Gemini image models.
 * 
 * Supported aspect ratios: "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
 */
export interface ImageConfig {
  aspectRatio?: string;
}

/**
 * Valid aspect ratios for image generation.
 */
const VALID_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

/**
 * Build image generation config for Gemini image models.
 * 
 * Configuration is read from environment variables:
 * - OPENCODE_IMAGE_ASPECT_RATIO: Aspect ratio (e.g., "16:9", "4:3")
 * 
 * Defaults to 1:1 aspect ratio if not specified.
 * 
 * Note: Resolution setting is not currently supported by the Antigravity API.
 */
export function buildImageGenerationConfig(): ImageConfig {
  // Read aspect ratio from environment or default to 1:1
  const aspectRatio = process.env.OPENCODE_IMAGE_ASPECT_RATIO || "1:1";
  
  if (VALID_ASPECT_RATIOS.includes(aspectRatio)) {
    return { aspectRatio };
  }
  
  console.warn(`[gemini] Invalid aspect ratio "${aspectRatio}". Using default "1:1". Valid values: ${VALID_ASPECT_RATIOS.join(", ")}`);
  
  // Default to 1:1 square aspect ratio
  return { aspectRatio: "1:1" };
}

/**
 * Normalize tools for Gemini models.
 * Ensures tools have proper function-style format.
 * 
 * @returns Debug info about tool normalization
 */
export function normalizeGeminiTools(
  payload: RequestPayload,
): { toolDebugMissing: number; toolDebugSummaries: string[] } {
  let toolDebugMissing = 0;
  const toolDebugSummaries: string[] = [];

  if (!Array.isArray(payload.tools)) {
    return { toolDebugMissing, toolDebugSummaries };
  }

  payload.tools = (payload.tools as unknown[]).map((tool: unknown, toolIndex: number) => {
    const t = tool as Record<string, unknown>;
    
    // Skip normalization for Google Search Retrieval tool
    if (t.googleSearchRetrieval) {
      return t;
    }

    const newTool = { ...t };

    const schemaCandidates = [
      (newTool.function as Record<string, unknown> | undefined)?.input_schema,
      (newTool.function as Record<string, unknown> | undefined)?.parameters,
      (newTool.function as Record<string, unknown> | undefined)?.inputSchema,
      (newTool.custom as Record<string, unknown> | undefined)?.input_schema,
      (newTool.custom as Record<string, unknown> | undefined)?.parameters,
      newTool.parameters,
      newTool.input_schema,
      newTool.inputSchema,
    ].filter(Boolean);

    const placeholderSchema: Record<string, unknown> = {
      type: "OBJECT",
      properties: {
        _placeholder: {
          type: "BOOLEAN",
          description: "Placeholder. Always pass true.",
        },
      },
      required: ["_placeholder"],
    };

    let schema = schemaCandidates[0] as Record<string, unknown> | undefined;
    const schemaObjectOk = schema && typeof schema === "object" && !Array.isArray(schema);
    if (!schemaObjectOk) {
      schema = placeholderSchema;
      toolDebugMissing += 1;
    } else {
      // Transform existing schema to Gemini-compatible format
      schema = toGeminiSchema(schema) as Record<string, unknown>;
    }

    const nameCandidate =
      newTool.name ||
      (newTool.function as Record<string, unknown> | undefined)?.name ||
      (newTool.custom as Record<string, unknown> | undefined)?.name ||
      `tool-${toolIndex}`;

    // Always update function.input_schema with transformed schema
    if (newTool.function && schema) {
      (newTool.function as Record<string, unknown>).input_schema = schema;
    }
    
    // Always update custom.input_schema with transformed schema
    if (newTool.custom && schema) {
      (newTool.custom as Record<string, unknown>).input_schema = schema;
    }
    
    // Create custom from function if missing
    if (!newTool.custom && newTool.function) {
      const fn = newTool.function as Record<string, unknown>;
      newTool.custom = {
        name: fn.name || nameCandidate,
        description: fn.description,
        input_schema: schema,
      };
    }

    // Create custom if both missing
    if (!newTool.custom && !newTool.function) {
      newTool.custom = {
        name: nameCandidate,
        description: newTool.description,
        input_schema: schema,
      };

      if (!newTool.parameters && !newTool.input_schema && !newTool.inputSchema) {
        newTool.parameters = schema;
      }
    }
    
    if (newTool.custom && !(newTool.custom as Record<string, unknown>).input_schema) {
      (newTool.custom as Record<string, unknown>).input_schema = { 
        type: "OBJECT", 
        properties: {}, 
      };
      toolDebugMissing += 1;
    }

    toolDebugSummaries.push(
      `idx=${toolIndex}, hasCustom=${!!newTool.custom}, customSchema=${!!(newTool.custom as Record<string, unknown> | undefined)?.input_schema}, hasFunction=${!!newTool.function}, functionSchema=${!!(newTool.function as Record<string, unknown> | undefined)?.input_schema}`,
    );

    // Strip custom wrappers for Gemini; only function-style is accepted.
    if (newTool.custom) {
      delete newTool.custom;
    }

    return newTool;
  });

  return { toolDebugMissing, toolDebugSummaries };
}

/**
 * Apply all Gemini-specific transformations to a request payload.
 */
export interface GeminiTransformOptions {
  /** The effective model name (resolved) */
  model: string;
  /** Tier-based thinking budget (from model suffix, for Gemini 2.5) */
  tierThinkingBudget?: number;
  /** Tier-based thinking level (from model suffix, for Gemini 3) */
  tierThinkingLevel?: ThinkingTier;
  /** Normalized thinking config from user settings */
  normalizedThinking?: { includeThoughts?: boolean; thinkingBudget?: number };
  /** Google Search configuration */
  googleSearch?: GoogleSearchConfig;
}

export interface GeminiTransformResult {
  toolDebugMissing: number;
  toolDebugSummaries: string[];
  /** Number of function declarations after wrapping */
  wrappedFunctionCount: number;
  /** Number of passthrough tools (googleSearchRetrieval, codeExecution) */
  passthroughToolCount: number;
}

/**
 * Apply all Gemini-specific transformations.
 */
export function applyGeminiTransforms(
  payload: RequestPayload,
  options: GeminiTransformOptions,
): GeminiTransformResult {
  const { model, tierThinkingBudget, tierThinkingLevel, normalizedThinking, googleSearch } = options;

  // 1. Apply thinking config if needed
  if (normalizedThinking) {
    let thinkingConfig: ThinkingConfig;

    if (tierThinkingLevel && isGemini3Model(model)) {
      // Gemini 3 uses thinkingLevel string
      thinkingConfig = buildGemini3ThinkingConfig(
        normalizedThinking.includeThoughts ?? true,
        tierThinkingLevel,
      );
    } else {
      // Gemini 2.5 and others use numeric budget
      const thinkingBudget = tierThinkingBudget ?? normalizedThinking.thinkingBudget;
      thinkingConfig = buildGemini25ThinkingConfig(
        normalizedThinking.includeThoughts ?? true,
        thinkingBudget,
      );
    }

    const generationConfig = (payload.generationConfig ?? {}) as Record<string, unknown>;
    generationConfig.thinkingConfig = thinkingConfig;
    payload.generationConfig = generationConfig;
  }

  // 2. Apply Google Search (Grounding) if enabled
  if (googleSearch && googleSearch.mode === 'auto') {
    const tools = (payload.tools as unknown[]) || [];
    if (!payload.tools) {
      payload.tools = tools;
    }

    // Add Google Search tool
    // We cast to any[] to avoid TypeScript issues with the loose RequestPayload type
    (payload.tools as any[]).push({
      googleSearchRetrieval: {
        dynamicRetrievalConfig: {
          mode: "MODE_DYNAMIC",
          dynamicThreshold: googleSearch.threshold ?? 0.3,
        },
      },
    });
  }

  // 3. Normalize tools
  const result = normalizeGeminiTools(payload);
  
  // 4. Wrap tools in functionDeclarations format (fixes #203, #206)
  // Antigravity strict protobuf validation rejects wrapper-level 'parameters' field
  // Must be: [{ functionDeclarations: [{ name, description, parameters }] }]
  const wrapResult = wrapToolsAsFunctionDeclarations(payload);
  
  return {
    ...result,
    wrappedFunctionCount: wrapResult.wrappedFunctionCount,
    passthroughToolCount: wrapResult.passthroughToolCount,
  };
}

export interface WrapToolsResult {
  wrappedFunctionCount: number;
  passthroughToolCount: number;
}

/**
 * Wrap tools array in Gemini's required functionDeclarations format.
 * 
 * Gemini/Antigravity API expects:
 *   { tools: [{ functionDeclarations: [{ name, description, parameters }] }] }
 * 
 * NOT:
 *   { tools: [{ function: {...}, parameters: {...} }] }
 * 
 * The wrapper-level 'parameters' field causes:
 *   "Unknown name 'parameters' at 'request.tools[0]'"
 */
export function wrapToolsAsFunctionDeclarations(payload: RequestPayload): WrapToolsResult {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
    return { wrappedFunctionCount: 0, passthroughToolCount: 0 };
  }
  
  const functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> = [];
  
  const passthroughTools: unknown[] = [];
  
  for (const tool of payload.tools as Array<Record<string, unknown>>) {
    if (tool.googleSearchRetrieval || tool.codeExecution) {
      passthroughTools.push(tool);
      continue;
    }
    
    if (tool.functionDeclarations) {
      if (Array.isArray(tool.functionDeclarations)) {
        for (const decl of tool.functionDeclarations as Array<Record<string, unknown>>) {
          functionDeclarations.push({
            name: String(decl.name || `tool-${functionDeclarations.length}`),
            description: String(decl.description || ""),
            parameters: (decl.parameters as Record<string, unknown>) || { type: "OBJECT", properties: {} },
          });
        }
      }
      continue;
    }
    
    const fn = tool.function as Record<string, unknown> | undefined;
    const custom = tool.custom as Record<string, unknown> | undefined;
    
    const name = String(
      tool.name ||
      fn?.name ||
      custom?.name ||
      `tool-${functionDeclarations.length}`
    );
    
    const description = String(
      tool.description ||
      fn?.description ||
      custom?.description ||
      ""
    );
    
    const schema = (
      fn?.input_schema ||
      fn?.parameters ||
      fn?.inputSchema ||
      custom?.input_schema ||
      custom?.parameters ||
      tool.parameters ||
      tool.input_schema ||
      tool.inputSchema ||
      { type: "OBJECT", properties: {} }
    ) as Record<string, unknown>;
    
    functionDeclarations.push({
      name,
      description,
      parameters: schema,
    });
  }
  
  const finalTools: unknown[] = [];
  
  if (functionDeclarations.length > 0) {
    finalTools.push({ functionDeclarations });
  }
  
  finalTools.push(...passthroughTools);
  
  payload.tools = finalTools;
  
  return {
    wrappedFunctionCount: functionDeclarations.length,
    passthroughToolCount: passthroughTools.length,
  };
}
