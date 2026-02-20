import { getKeepThinking } from "./config";
import { createLogger } from "./logger";
import { cacheSignature } from "./cache";
import {
  EMPTY_SCHEMA_PLACEHOLDER_NAME,
  EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
  SKIP_THOUGHT_SIGNATURE,
} from "../constants";
import { processImageData } from "./image-saver";
import type { GoogleSearchConfig } from "./transform/types";

const log = createLogger("request-helpers");

const ANTIGRAVITY_PREVIEW_LINK = "https://goo.gle/enable-preview-features"; // TODO: Update to Antigravity link if available

// ============================================================================
// JSON SCHEMA CLEANING FOR ANTIGRAVITY API
// Ported from CLIProxyAPI's CleanJSONSchemaForAntigravity (gemini_schema.go)
// ============================================================================

/**
 * Unsupported constraint keywords that should be moved to description hints.
 * Claude/Gemini reject these in VALIDATED mode.
 */
const UNSUPPORTED_CONSTRAINTS = [
  "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum",
  "pattern", "minItems", "maxItems", "format",
  "default", "examples",
] as const;

/**
 * Keywords that should be removed after hint extraction.
 */
const UNSUPPORTED_KEYWORDS = [
  ...UNSUPPORTED_CONSTRAINTS,
  "$schema", "$defs", "definitions", "const", "$ref", "additionalProperties",
  "propertyNames", "title", "$id", "$comment",
] as const;

/**
 * Appends a hint to a schema's description field.
 */
function appendDescriptionHint(schema: any, hint: string): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const existing = typeof schema.description === "string" ? schema.description : "";
  const newDescription = existing ? `${existing} (${hint})` : hint;
  return { ...schema, description: newDescription };
}

/**
 * Phase 1a: Converts $ref to description hints.
 * $ref: "#/$defs/Foo" → { type: "object", description: "See: Foo" }
 */
function convertRefsToHints(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => convertRefsToHints(item));
  }

  // If this object has $ref, replace it with a hint
  if (typeof schema.$ref === "string") {
    const refVal = schema.$ref;
    const defName = refVal.includes("/") ? refVal.split("/").pop() : refVal;
    const hint = `See: ${defName}`;
    const existingDesc = typeof schema.description === "string" ? schema.description : "";
    const newDescription = existingDesc ? `${existingDesc} (${hint})` : hint;
    return { type: "object", description: newDescription };
  }

  // Recursively process all properties
  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    result[key] = convertRefsToHints(value);
  }
  return result;
}

/**
 * Phase 1b: Converts const to enum.
 * { const: "foo" } → { enum: ["foo"] }
 */
function convertConstToEnum(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => convertConstToEnum(item));
  }

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "const" && !schema.enum) {
      result.enum = [value];
    } else {
      result[key] = convertConstToEnum(value);
    }
  }
  return result;
}

/**
 * Phase 1c: Adds enum hints to description.
 * { enum: ["a", "b", "c"] } → adds "(Allowed: a, b, c)" to description
 */
function addEnumHints(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => addEnumHints(item));
  }

  let result: any = { ...schema };

  // Add enum hint if enum has 2-10 items
  if (Array.isArray(result.enum) && result.enum.length > 1 && result.enum.length <= 10) {
    const vals = result.enum.map((v: any) => String(v)).join(", ");
    result = appendDescriptionHint(result, `Allowed: ${vals}`);
  }

  // Recursively process nested objects
  for (const [key, value] of Object.entries(result)) {
    if (key !== "enum" && typeof value === "object" && value !== null) {
      result[key] = addEnumHints(value);
    }
  }

  return result;
}

/**
 * Phase 1d: Adds additionalProperties hints.
 * { additionalProperties: false } → adds "(No extra properties allowed)" to description
 */
function addAdditionalPropertiesHints(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => addAdditionalPropertiesHints(item));
  }

  let result: any = { ...schema };

  if (result.additionalProperties === false) {
    result = appendDescriptionHint(result, "No extra properties allowed");
  }

  // Recursively process nested objects
  for (const [key, value] of Object.entries(result)) {
    if (key !== "additionalProperties" && typeof value === "object" && value !== null) {
      result[key] = addAdditionalPropertiesHints(value);
    }
  }

  return result;
}

/**
 * Phase 1e: Moves unsupported constraints to description hints.
 * { minLength: 1, maxLength: 100 } → adds "(minLength: 1) (maxLength: 100)" to description
 */
function moveConstraintsToDescription(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => moveConstraintsToDescription(item));
  }

  let result: any = { ...schema };

  // Move constraint values to description
  for (const constraint of UNSUPPORTED_CONSTRAINTS) {
    if (result[constraint] !== undefined && typeof result[constraint] !== "object") {
      result = appendDescriptionHint(result, `${constraint}: ${result[constraint]}`);
    }
  }

  // Recursively process nested objects
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = moveConstraintsToDescription(value);
    }
  }

  return result;
}

/**
 * Phase 2a: Merges allOf schemas into a single object.
 * { allOf: [{ properties: { a: ... } }, { properties: { b: ... } }] }
 * → { properties: { a: ..., b: ... } }
 */
function mergeAllOf(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => mergeAllOf(item));
  }

  let result: any = { ...schema };

  // If this object has allOf, merge its contents
  if (Array.isArray(result.allOf)) {
    const merged: any = {};
    const mergedRequired: string[] = [];

    for (const item of result.allOf) {
      if (!item || typeof item !== "object") continue;

      // Merge properties
      if (item.properties && typeof item.properties === "object") {
        merged.properties = { ...merged.properties, ...item.properties };
      }

      // Merge required arrays
      if (Array.isArray(item.required)) {
        for (const req of item.required) {
          if (!mergedRequired.includes(req)) {
            mergedRequired.push(req);
          }
        }
      }

      // Copy other fields from allOf items
      for (const [key, value] of Object.entries(item)) {
        if (key !== "properties" && key !== "required" && merged[key] === undefined) {
          merged[key] = value;
        }
      }
    }

    // Apply merged content to result
    if (merged.properties) {
      result.properties = { ...result.properties, ...merged.properties };
    }
    if (mergedRequired.length > 0) {
      const existingRequired = Array.isArray(result.required) ? result.required : [];
      result.required = Array.from(new Set([...existingRequired, ...mergedRequired]));
    }

    // Copy other merged fields
    for (const [key, value] of Object.entries(merged)) {
      if (key !== "properties" && key !== "required" && result[key] === undefined) {
        result[key] = value;
      }
    }

    delete result.allOf;
  }

  // Recursively process nested objects
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = mergeAllOf(value);
    }
  }

  return result;
}

/**
 * Scores a schema option for selection in anyOf/oneOf flattening.
 * Higher score = more preferred.
 */
function scoreSchemaOption(schema: any): { score: number; typeName: string } {
  if (!schema || typeof schema !== "object") {
    return { score: 0, typeName: "unknown" };
  }

  const type = schema.type;

  // Object or has properties = highest priority
  if (type === "object" || schema.properties) {
    return { score: 3, typeName: "object" };
  }

  // Array or has items = second priority
  if (type === "array" || schema.items) {
    return { score: 2, typeName: "array" };
  }

  // Any other non-null type
  if (type && type !== "null") {
    return { score: 1, typeName: type };
  }

  // Null or no type
  return { score: 0, typeName: type || "null" };
}

/**
 * Checks if an anyOf/oneOf array represents enum choices.
 * Returns the merged enum values if so, otherwise null.
 *
 * Handles patterns like:
 * - anyOf: [{ const: "a" }, { const: "b" }]
 * - anyOf: [{ enum: ["a"] }, { enum: ["b"] }]
 * - anyOf: [{ type: "string", const: "a" }, { type: "string", const: "b" }]
 */
function tryMergeEnumFromUnion(options: any[]): string[] | null {
  if (!Array.isArray(options) || options.length === 0) {
    return null;
  }

  const enumValues: string[] = [];

  for (const option of options) {
    if (!option || typeof option !== "object") {
      return null;
    }

    // Check for const value
    if (option.const !== undefined) {
      enumValues.push(String(option.const));
      continue;
    }

    // Check for single-value enum
    if (Array.isArray(option.enum) && option.enum.length === 1) {
      enumValues.push(String(option.enum[0]));
      continue;
    }

    // Check for multi-value enum (merge all values)
    if (Array.isArray(option.enum) && option.enum.length > 0) {
      for (const val of option.enum) {
        enumValues.push(String(val));
      }
      continue;
    }

    // If option has complex structure (properties, items, etc.), it's not a simple enum
    if (option.properties || option.items || option.anyOf || option.oneOf || option.allOf) {
      return null;
    }

    // If option has only type (no const/enum), it's not an enum pattern
    if (option.type && !option.const && !option.enum) {
      return null;
    }
  }

  // Only return if we found actual enum values
  return enumValues.length > 0 ? enumValues : null;
}

/**
 * Phase 2b: Flattens anyOf/oneOf to the best option with type hints.
 * { anyOf: [{ type: "string" }, { type: "number" }] }
 * → { type: "string", description: "(Accepts: string | number)" }
 *
 * Special handling for enum patterns:
 * { anyOf: [{ const: "a" }, { const: "b" }] }
 * → { type: "string", enum: ["a", "b"] }
 */
function flattenAnyOfOneOf(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => flattenAnyOfOneOf(item));
  }

  let result: any = { ...schema };

  // Process anyOf or oneOf
  for (const unionKey of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(result[unionKey]) && result[unionKey].length > 0) {
      const options = result[unionKey];
      const parentDesc = typeof result.description === "string" ? result.description : "";

      // First, check if this is an enum pattern (anyOf with const/enum values)
      // This is crucial for tools like WebFetch where format: anyOf[{const:"text"},{const:"markdown"},{const:"html"}]
      const mergedEnum = tryMergeEnumFromUnion(options);
      if (mergedEnum !== null) {
        // This is an enum pattern - merge all values into a single enum
        const { [unionKey]: _, ...rest } = result;
        result = {
          ...rest,
          type: "string",
          enum: mergedEnum,
        };
        // Preserve parent description
        if (parentDesc) {
          result.description = parentDesc;
        }
        continue;
      }

      // Not an enum pattern - use standard flattening logic
      // Score each option and find the best
      let bestIdx = 0;
      let bestScore = -1;
      const allTypes: string[] = [];

      for (let i = 0; i < options.length; i++) {
        const { score, typeName } = scoreSchemaOption(options[i]);
        if (typeName) {
          allTypes.push(typeName);
        }
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      // Select the best option and flatten it recursively
      let selected = flattenAnyOfOneOf(options[bestIdx]) || { type: "string" };

      // Preserve parent description
      if (parentDesc) {
        const childDesc = typeof selected.description === "string" ? selected.description : "";
        if (childDesc && childDesc !== parentDesc) {
          selected = { ...selected, description: `${parentDesc} (${childDesc})` };
        } else if (!childDesc) {
          selected = { ...selected, description: parentDesc };
        }
      }

      if (allTypes.length > 1) {
        const uniqueTypes = Array.from(new Set(allTypes));
        const hint = `Accepts: ${uniqueTypes.join(" | ")}`;
        selected = appendDescriptionHint(selected, hint);
      }

      // Replace result with selected schema, preserving other fields
      const { [unionKey]: _, description: __, ...rest } = result;
      result = { ...rest, ...selected };
    }
  }

  // Recursively process nested objects
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = flattenAnyOfOneOf(value);
    }
  }

  return result;
}

/**
 * Phase 2c: Flattens type arrays to single type with nullable hint.
 * { type: ["string", "null"] } → { type: "string", description: "(nullable)" }
 */
function flattenTypeArrays(schema: any, nullableFields?: Map<string, string[]>, currentPath?: string): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((item, idx) => flattenTypeArrays(item, nullableFields, `${currentPath || ""}[${idx}]`));
  }

  let result: any = { ...schema };
  const localNullableFields = nullableFields || new Map<string, string[]>();

  // Handle type array
  if (Array.isArray(result.type)) {
    const types = result.type as string[];
    const hasNull = types.includes("null");
    const nonNullTypes = types.filter(t => t !== "null" && t);

    // Select first non-null type, or "string" as fallback
    const firstType = nonNullTypes.length > 0 ? nonNullTypes[0] : "string";
    result.type = firstType;

    // Add hint for multiple types
    if (nonNullTypes.length > 1) {
      result = appendDescriptionHint(result, `Accepts: ${nonNullTypes.join(" | ")}`);
    }

    // Add nullable hint
    if (hasNull) {
      result = appendDescriptionHint(result, "nullable");
    }
  }

  // Recursively process properties
  if (result.properties && typeof result.properties === "object") {
    const newProps: any = {};
    for (const [propKey, propValue] of Object.entries(result.properties)) {
      const propPath = currentPath ? `${currentPath}.properties.${propKey}` : `properties.${propKey}`;
      const processed = flattenTypeArrays(propValue, localNullableFields, propPath);
      newProps[propKey] = processed;

      // Track nullable fields for required array cleanup
      if (processed && typeof processed === "object" && 
          typeof processed.description === "string" && 
          processed.description.includes("nullable")) {
        const objectPath = currentPath || "";
        const existing = localNullableFields.get(objectPath) || [];
        existing.push(propKey);
        localNullableFields.set(objectPath, existing);
      }
    }
    result.properties = newProps;
  }

  // Remove nullable fields from required array
  if (Array.isArray(result.required) && !nullableFields) {
    // Only at root level, filter out nullable fields
    const nullableAtRoot = localNullableFields.get("") || [];
    if (nullableAtRoot.length > 0) {
      result.required = result.required.filter((r: string) => !nullableAtRoot.includes(r));
      if (result.required.length === 0) {
        delete result.required;
      }
    }
  }

  // Recursively process other nested objects
  for (const [key, value] of Object.entries(result)) {
    if (key !== "properties" && typeof value === "object" && value !== null) {
      result[key] = flattenTypeArrays(value, localNullableFields, `${currentPath || ""}.${key}`);
    }
  }

  return result;
}

/**
 * Phase 3: Removes unsupported keywords after hints have been extracted.
 * @param insideProperties - When true, keys are property NAMES (preserve); when false, keys are JSON Schema keywords (filter).
 */
function removeUnsupportedKeywords(schema: any, insideProperties: boolean = false): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => removeUnsupportedKeywords(item, false));
  }

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!insideProperties && (UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
      continue;
    }

    if (typeof value === "object" && value !== null) {
      if (key === "properties") {
        const propertiesResult: any = {};
        for (const [propName, propSchema] of Object.entries(value as object)) {
          propertiesResult[propName] = removeUnsupportedKeywords(propSchema, false);
        }
        result[key] = propertiesResult;
      } else {
        result[key] = removeUnsupportedKeywords(value, false);
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Phase 3b: Cleans up required fields - removes entries that don't exist in properties.
 */
function cleanupRequiredFields(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => cleanupRequiredFields(item));
  }

  let result: any = { ...schema };

  // Clean up required array if properties exist
  if (Array.isArray(result.required) && result.properties && typeof result.properties === "object") {
    const validRequired = result.required.filter((req: string) => 
      Object.prototype.hasOwnProperty.call(result.properties, req)
    );
    if (validRequired.length === 0) {
      delete result.required;
    } else if (validRequired.length !== result.required.length) {
      result.required = validRequired;
    }
  }

  // Recursively process nested objects
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = cleanupRequiredFields(value);
    }
  }

  return result;
}

/**
 * Phase 4: Adds placeholder property for empty object schemas.
 * Claude VALIDATED mode requires at least one property.
 */
function addEmptySchemaPlaceholder(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => addEmptySchemaPlaceholder(item));
  }

  let result: any = { ...schema };

  // Check if this is an empty object schema
  const isObjectType = result.type === "object";

  if (isObjectType) {
    const hasProperties =
      result.properties &&
      typeof result.properties === "object" &&
      Object.keys(result.properties).length > 0;

    if (!hasProperties) {
      result.properties = {
        [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
          type: "boolean",
          description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
        },
      };
      result.required = [EMPTY_SCHEMA_PLACEHOLDER_NAME];
    }
  }

  // Recursively process nested objects
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = addEmptySchemaPlaceholder(value);
    }
  }

  return result;
}

/**
 * Cleans a JSON schema for Antigravity API compatibility.
 * Transforms unsupported features into description hints while preserving semantic information.
 * 
 * Ported from CLIProxyAPI's CleanJSONSchemaForAntigravity (gemini_schema.go)
 */
export function cleanJSONSchemaForAntigravity(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  let result = schema;

  // Phase 1: Convert and add hints
  result = convertRefsToHints(result);
  result = convertConstToEnum(result);
  result = addEnumHints(result);
  result = addAdditionalPropertiesHints(result);
  result = moveConstraintsToDescription(result);

  // Phase 2: Flatten complex structures
  result = mergeAllOf(result);
  result = flattenAnyOfOneOf(result);
  result = flattenTypeArrays(result);

  // Phase 3: Cleanup
  result = removeUnsupportedKeywords(result);
  result = cleanupRequiredFields(result);

  // Phase 4: Add placeholder for empty object schemas
  result = addEmptySchemaPlaceholder(result);

  return result;
}

// ============================================================================
// END JSON SCHEMA CLEANING
// ============================================================================

export interface AntigravityApiError {
  code?: number;
  message?: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * Minimal representation of Antigravity API responses we touch.
 */
export interface AntigravityApiBody {
  response?: unknown;
  error?: AntigravityApiError;
  [key: string]: unknown;
}

/**
 * Usage metadata exposed by Antigravity responses. Fields are optional to reflect partial payloads.
 */
export interface AntigravityUsageMetadata {
  totalTokenCount?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

/**
 * Normalized thinking configuration accepted by Antigravity.
 */
export interface ThinkingConfig {
  thinkingBudget?: number;
  includeThoughts?: boolean;
}

/**
 * Default token budget for thinking/reasoning. 16000 tokens provides sufficient
 * space for complex reasoning while staying within typical model limits.
 */
export const DEFAULT_THINKING_BUDGET = 16000;

/**
 * Checks if a model name indicates thinking/reasoning capability.
 * Models with "thinking", "gemini-3", or "opus" in their name support extended thinking.
 */
export function isThinkingCapableModel(modelName: string): boolean {
  const lowerModel = modelName.toLowerCase();
  return lowerModel.includes("thinking")
    || lowerModel.includes("gemini-3")
    || lowerModel.includes("opus");
}

/**
 * Extracts thinking configuration from various possible request locations.
 * Supports both Gemini-style thinkingConfig and Anthropic-style thinking options.
 */
export function extractThinkingConfig(
  requestPayload: Record<string, unknown>,
  rawGenerationConfig: Record<string, unknown> | undefined,
  extraBody: Record<string, unknown> | undefined,
): ThinkingConfig | undefined {
  const thinkingConfig = rawGenerationConfig?.thinkingConfig
    ?? extraBody?.thinkingConfig
    ?? requestPayload.thinkingConfig;

  if (thinkingConfig && typeof thinkingConfig === "object") {
    const config = thinkingConfig as Record<string, unknown>;
    return {
      includeThoughts: Boolean(config.includeThoughts),
      thinkingBudget: typeof config.thinkingBudget === "number" ? config.thinkingBudget : DEFAULT_THINKING_BUDGET,
    };
  }

  // Convert Anthropic-style "thinking" option: { type: "enabled", budgetTokens: N }
  const anthropicThinking = extraBody?.thinking ?? requestPayload.thinking;
  if (anthropicThinking && typeof anthropicThinking === "object") {
    const thinking = anthropicThinking as Record<string, unknown>;
    if (thinking.type === "enabled" || thinking.budgetTokens) {
      return {
        includeThoughts: true,
        thinkingBudget: typeof thinking.budgetTokens === "number" ? thinking.budgetTokens : DEFAULT_THINKING_BUDGET,
      };
    }
  }

  return undefined;
}

/**
 * Variant thinking config extracted from OpenCode's providerOptions.
 */
export interface VariantThinkingConfig {
  /** Gemini 3 native thinking level (low/medium/high) */
  thinkingLevel?: string;
  /** Numeric thinking budget for Claude and Gemini 2.5 */
  thinkingBudget?: number;
  /** Whether to include thoughts in output */
  includeThoughts?: boolean;
  /** Google Search configuration */
  googleSearch?: GoogleSearchConfig;
}

/**
 * Extracts variant thinking config from OpenCode's providerOptions.
 * 
 * All Antigravity models route through the Google provider, so we only check
 * providerOptions.google. Supports two formats:
 * 
 * 1. Gemini 3 native: { google: { thinkingLevel: "high", includeThoughts: true } }
 * 2. Budget-based (Claude/Gemini 2.5): { google: { thinkingConfig: { thinkingBudget: 32000 } } }
 * 
 * When providerOptions is missing or has no thinking config (common with OpenCode
 * model variants), falls back to extracting from generationConfig directly:
 * 3. generationConfig fallback: { thinkingConfig: { thinkingBudget: 8192 } }
 */
export function extractVariantThinkingConfig(
  providerOptions: Record<string, unknown> | undefined,
  generationConfig?: Record<string, unknown> | undefined
): VariantThinkingConfig | undefined {
  const result: VariantThinkingConfig = {};

  // Primary path: extract from providerOptions.google
  const google = (providerOptions?.google) as Record<string, unknown> | undefined;
  if (google) {
    // Gemini 3 native format: { google: { thinkingLevel: "high", includeThoughts: true } }
    // thinkingLevel takes priority over thinkingBudget - they are mutually exclusive
    if (typeof google.thinkingLevel === "string") {
      result.thinkingLevel = google.thinkingLevel;
      result.includeThoughts = typeof google.includeThoughts === "boolean" ? google.includeThoughts : undefined;
    } else if (google.thinkingConfig && typeof google.thinkingConfig === "object") {
      // Budget-based format (Claude/Gemini 2.5): { google: { thinkingConfig: { thinkingBudget } } }
      // Only used when thinkingLevel is not present
      const tc = google.thinkingConfig as Record<string, unknown>;
      if (typeof tc.thinkingBudget === "number") {
        result.thinkingBudget = tc.thinkingBudget;
      }
    }

    // Extract Google Search config
    if (google.googleSearch && typeof google.googleSearch === "object") {
      const search = google.googleSearch as Record<string, unknown>;
      result.googleSearch = {
        mode: search.mode === 'auto' || search.mode === 'off' ? search.mode : undefined,
        threshold: typeof search.threshold === 'number' ? search.threshold : undefined,
      };
    }
  }

  // Fallback: OpenCode may pass thinking config in generationConfig
  // instead of providerOptions (common when using model variants)
  if (result.thinkingBudget === undefined && !result.thinkingLevel && generationConfig) {
    if (generationConfig.thinkingConfig && typeof generationConfig.thinkingConfig === "object") {
      const tc = generationConfig.thinkingConfig as Record<string, unknown>;
      if (typeof tc.thinkingLevel === "string") {
        // Gemini 3 native format sent via generationConfig
        result.thinkingLevel = tc.thinkingLevel;
        result.includeThoughts = typeof tc.includeThoughts === "boolean" ? tc.includeThoughts : undefined;
      } else if (typeof tc.thinkingBudget === "number") {
        result.thinkingBudget = tc.thinkingBudget;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Determines the final thinking configuration based on model capabilities and user settings.
 * For Claude thinking models, we keep thinking enabled even in multi-turn conversations.
 * The filterUnsignedThinkingBlocks function will handle signature validation/restoration.
 */
export function resolveThinkingConfig(
  userConfig: ThinkingConfig | undefined,
  isThinkingModel: boolean,
  _isClaudeModel: boolean,
  _hasAssistantHistory: boolean,
): ThinkingConfig | undefined {
  // For thinking-capable models (including Claude thinking models), enable thinking by default
  // The signature validation/restoration is handled by filterUnsignedThinkingBlocks
  if (isThinkingModel && !userConfig) {
    return { includeThoughts: true, thinkingBudget: DEFAULT_THINKING_BUDGET };
  }

  return userConfig;
}

/**
 * Checks if a part is a thinking/reasoning block (Anthropic or Gemini style).
 */
function isThinkingPart(part: Record<string, unknown>): boolean {
  return part.type === "thinking"
    || part.type === "redacted_thinking"
    || part.type === "reasoning"
    || part.thinking !== undefined
    || part.thought === true;
}

/**
 * Checks if a part has a signature field (thinking block signature).
 * Used to detect foreign thinking blocks that might have unknown type values.
 */
function hasSignatureField(part: Record<string, unknown>): boolean {
  return part.signature !== undefined || part.thoughtSignature !== undefined;
}

/**
 * Checks if a part is a tool block (tool_use or tool_result).
 * Tool blocks must never be filtered - they're required for tool call/result pairing.
 * Handles multiple formats:
 * - Anthropic: { type: "tool_use" }, { type: "tool_result", tool_use_id }
 * - Nested: { tool_result: { tool_use_id } }, { tool_use: { id } }
 * - Gemini: { functionCall }, { functionResponse }
 */
function isToolBlock(part: Record<string, unknown>): boolean {
  return part.type === "tool_use"
    || part.type === "tool_result"
    || part.tool_use_id !== undefined
    || part.tool_call_id !== undefined
    || part.tool_result !== undefined
    || part.tool_use !== undefined
    || part.toolUse !== undefined
    || part.functionCall !== undefined
    || part.functionResponse !== undefined;
}

/**
 * Unconditionally strips ALL thinking/reasoning blocks from a content array.
 * Used for Claude models to avoid signature validation errors entirely.
 * Claude will generate fresh thinking for each turn.
 */
function stripAllThinkingBlocks(contentArray: any[]): any[] {
  return contentArray.filter(item => {
    if (!item || typeof item !== "object") return true;
    if (isToolBlock(item)) return true;
    if (isThinkingPart(item)) return false;
    if (hasSignatureField(item)) return false;
    return true;
  });
}

/**
 * Removes trailing thinking blocks from a content array.
 * Claude API requires that assistant messages don't end with thinking blocks.
 * Only removes unsigned thinking blocks; preserves those with valid signatures.
 */
function removeTrailingThinkingBlocks(
  contentArray: any[],
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
): any[] {
  const result = [...contentArray];

  while (result.length > 0 && isThinkingPart(result[result.length - 1])) {
    const part = result[result.length - 1];
    const isValid = sessionId && getCachedSignatureFn
      ? isOurCachedSignature(part as Record<string, unknown>, sessionId, getCachedSignatureFn)
      : hasValidSignature(part as Record<string, unknown>);
    if (isValid) {
      break;
    }
    result.pop();
  }

  return result;
}

/**
 * Checks if a thinking part has a valid signature.
 * A valid signature is a non-empty string with at least 50 characters.
 */
function hasValidSignature(part: Record<string, unknown>): boolean {
  const signature = part.thought === true ? part.thoughtSignature : part.signature;
  return typeof signature === "string" && signature.length >= 50;
}

/**
 * Gets the signature from a thinking part, if present.
 */
function getSignature(part: Record<string, unknown>): string | undefined {
  const signature = part.thought === true ? part.thoughtSignature : part.signature;
  return typeof signature === "string" ? signature : undefined;
}

/**
 * Checks if a thinking part's signature was generated by our plugin (exists in our cache).
 * This prevents accepting signatures from other providers (e.g., direct Anthropic API, OpenAI)
 * which would cause "Invalid signature" errors when sent to Antigravity Claude.
 */
function isOurCachedSignature(
  part: Record<string, unknown>,
  sessionId: string | undefined,
  getCachedSignatureFn: ((sessionId: string, text: string) => string | undefined) | undefined,
): boolean {
  if (!sessionId || !getCachedSignatureFn) {
    return false;
  }

  const text = getThinkingText(part);
  if (!text) {
    return false;
  }

  const partSignature = getSignature(part);
  if (!partSignature) {
    return false;
  }

  const cachedSignature = getCachedSignatureFn(sessionId, text);
  return cachedSignature === partSignature;
}

/**
 * Gets the text content from a thinking part.
 */
function getThinkingText(part: Record<string, unknown>): string {
  if (typeof part.text === "string") return part.text;
  if (typeof part.thinking === "string") return part.thinking;

  if (part.text && typeof part.text === "object") {
    const maybeText = (part.text as any).text;
    if (typeof maybeText === "string") return maybeText;
  }

  if (part.thinking && typeof part.thinking === "object") {
    const maybeText = (part.thinking as any).text ?? (part.thinking as any).thinking;
    if (typeof maybeText === "string") return maybeText;
  }

  return "";
}

/**
 * Recursively strips cache_control and providerOptions from any object.
 * These fields can be injected by SDKs, but Claude rejects them inside thinking blocks.
 */
function stripCacheControlRecursively(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(item => stripCacheControlRecursively(item));

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === "cache_control" || key === "providerOptions") continue;
    result[key] = stripCacheControlRecursively(value);
  }
  return result;
}

/**
 * Sanitizes a thinking part by keeping only the allowed fields.
 * In particular, ensures `thinking` is a string (not an object with cache_control).
 * Returns null if the thinking block has no valid content.
 */
function sanitizeThinkingPart(part: Record<string, unknown>): Record<string, unknown> | null {
  // Gemini-style thought blocks: { thought: true, text, thoughtSignature }
  if (part.thought === true) {
    let textContent: unknown = part.text;
    if (typeof textContent === "object" && textContent !== null) {
      const maybeText = (textContent as any).text;
      textContent = typeof maybeText === "string" ? maybeText : undefined;
    }

    const hasContent = typeof textContent === "string" && textContent.trim().length > 0;
    if (!hasContent && !part.thoughtSignature) {
      return null;
    }

    const sanitized: Record<string, unknown> = { thought: true };
    if (textContent !== undefined) sanitized.text = textContent;
    if (part.thoughtSignature !== undefined) sanitized.thoughtSignature = part.thoughtSignature;
    return sanitized;
  }

  // Anthropic-style thinking/redacted_thinking blocks: { type: "thinking"|"redacted_thinking", thinking, signature }
  if (part.type === "thinking" || part.type === "redacted_thinking" || part.thinking !== undefined) {
    let thinkingContent: unknown = part.thinking ?? part.text;
    if (thinkingContent !== undefined && typeof thinkingContent === "object" && thinkingContent !== null) {
      const maybeText = (thinkingContent as any).text ?? (thinkingContent as any).thinking;
      thinkingContent = typeof maybeText === "string" ? maybeText : undefined;
    }

    const hasContent = typeof thinkingContent === "string" && thinkingContent.trim().length > 0;
    if (!hasContent && !part.signature) {
      return null;
    }

    const sanitized: Record<string, unknown> = { type: part.type === "redacted_thinking" ? "redacted_thinking" : "thinking" };
    if (thinkingContent !== undefined) sanitized.thinking = thinkingContent;
    if (part.signature !== undefined) sanitized.signature = part.signature;
    return sanitized;
  }

  // Reasoning blocks (OpenCode format): { type: "reasoning", text, signature }
  if (part.type === "reasoning") {
    let textContent: unknown = part.text;
    if (typeof textContent === "object" && textContent !== null) {
      const maybeText = (textContent as any).text;
      textContent = typeof maybeText === "string" ? maybeText : undefined;
    }

    const hasContent = typeof textContent === "string" && textContent.trim().length > 0;
    if (!hasContent && !part.signature) {
      return null;
    }

    const sanitized: Record<string, unknown> = { type: "reasoning" };
    if (textContent !== undefined) sanitized.text = textContent;
    if (part.signature !== undefined) sanitized.signature = part.signature;
    return sanitized;
  }

  // Fallback: strip cache_control recursively.
  return stripCacheControlRecursively(part) as Record<string, unknown>;
}

function findLastAssistantIndex(contents: any[], roleValue: "model" | "assistant"): number {
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content && typeof content === "object" && content.role === roleValue) {
      return i;
    }
  }
  return -1;
}

function filterContentArray(
  contentArray: any[],
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
  isClaudeModel?: boolean,
  isLastAssistantMessage: boolean = false,
): any[] {
  // For Claude models, strip thinking blocks by default for reliability
  // User can opt-in to keep thinking via config: { "keep_thinking": true }
  if (isClaudeModel && !getKeepThinking()) {
    return stripAllThinkingBlocks(contentArray);
  }

  const filtered: any[] = [];

  for (const item of contentArray) {
    if (!item || typeof item !== "object") {
      filtered.push(item);
      continue;
    }

    if (isToolBlock(item)) {
      if (!isClaudeModel) {
        filtered.push(item);
        continue;
      }

      const sanitizedToolBlock = { ...(item as Record<string, unknown>) };
      delete (sanitizedToolBlock as any).signature;
      delete (sanitizedToolBlock as any).thoughtSignature;
      delete (sanitizedToolBlock as any).thought_signature;
      delete (sanitizedToolBlock as any).thought;
      filtered.push(sanitizedToolBlock);
      continue;
    }

    const isThinking = isThinkingPart(item);
    const hasSignature = hasSignatureField(item);

    if (!isThinking && !hasSignature) {
      filtered.push(item);
      continue;
    }

    if (isClaudeModel && (isThinking || hasSignature)) {
      const thinkingText = getThinkingText(item) || "";
      const sentinelPart = {
        type: item.type === "redacted_thinking" ? "redacted_thinking" : "thinking",
        thinking: thinkingText,
        signature: SKIP_THOUGHT_SIGNATURE,
      };
      filtered.push(sentinelPart);
      continue;
    }

    // For the LAST assistant message with thinking blocks:
    // - If signature is OUR cached signature, pass through unchanged
    // - Otherwise inject sentinel to bypass Antigravity validation
    // NOTE: We can't trust signatures just because they're >= 50 chars - Claude returns
    // its own signatures which are long but invalid for Antigravity.
    if (isLastAssistantMessage && (isThinking || hasSignature)) {
      // First check if it's our cached signature
      if (isOurCachedSignature(item, sessionId, getCachedSignatureFn)) {
        const sanitized = sanitizeThinkingPart(item);
        if (sanitized) filtered.push(sanitized);
        continue;
      }
      
      // Not our signature (or no signature) - inject sentinel
      const thinkingText = getThinkingText(item) || "";
      const existingSignature = item.signature || item.thoughtSignature;
      const signatureInfo = existingSignature ? `foreign signature (${String(existingSignature).length} chars)` : "no signature";
      log.debug(`Injecting sentinel for last-message thinking block with ${signatureInfo}`);
      const sentinelPart = {
        type: item.type || "thinking",
        thinking: thinkingText,
        signature: SKIP_THOUGHT_SIGNATURE,
      };
      filtered.push(sentinelPart);
      continue;
    }

    if (isOurCachedSignature(item, sessionId, getCachedSignatureFn)) {
      const sanitized = sanitizeThinkingPart(item);
      if (sanitized) filtered.push(sanitized);
      continue;
    }

    if (sessionId && getCachedSignatureFn) {
      const text = getThinkingText(item);
      if (text) {
        const cachedSignature = getCachedSignatureFn(sessionId, text);
        if (cachedSignature && cachedSignature.length >= 50) {
          const restoredPart = { ...item };
          if ((item as any).thought === true) {
            (restoredPart as any).thoughtSignature = cachedSignature;
          } else {
            (restoredPart as any).signature = cachedSignature;
          }
          const sanitized = sanitizeThinkingPart(restoredPart as Record<string, unknown>);
          if (sanitized) filtered.push(sanitized);
          continue;
        }
      }
    }
  }

  return filtered;
}

/**
 * Filters thinking blocks from contents unless the signature matches our cache.
 * Attempts to restore signatures from cache for thinking blocks that lack signatures.
 *
 * @param contents - The contents array from the request
 * @param sessionId - Optional session ID for signature cache lookup
 * @param getCachedSignatureFn - Optional function to retrieve cached signatures
 */
export function filterUnsignedThinkingBlocks(
  contents: any[],
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
  isClaudeModel?: boolean,
): any[] {
  const lastAssistantIdx = findLastAssistantIndex(contents, "model");

  return contents.map((content: any, idx: number) => {
    if (!content || typeof content !== "object") {
      return content;
    }

    const isLastAssistant = idx === lastAssistantIdx;

    if (Array.isArray((content as any).parts)) {
      const filteredParts = filterContentArray(
        (content as any).parts,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel,
        isLastAssistant,
      );

      const trimmedParts = (content as any).role === "model" && !isClaudeModel
        ? removeTrailingThinkingBlocks(filteredParts, sessionId, getCachedSignatureFn)
        : filteredParts;

      return { ...content, parts: trimmedParts };
    }

    if (Array.isArray((content as any).content)) {
      const isAssistantRole = (content as any).role === "assistant";
      const isLastAssistantContent = idx === lastAssistantIdx || 
        (isAssistantRole && idx === findLastAssistantIndex(contents, "assistant"));
      
      const filteredContent = filterContentArray(
        (content as any).content,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel,
        isLastAssistantContent,
      );

      const trimmedContent = isAssistantRole && !isClaudeModel
        ? removeTrailingThinkingBlocks(filteredContent, sessionId, getCachedSignatureFn)
        : filteredContent;

      return { ...content, content: trimmedContent };
    }

    return content;
  });
}

/**
 * Filters thinking blocks from Anthropic-style messages[] payloads using cached signatures.
 */
export function filterMessagesThinkingBlocks(
  messages: any[],
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
  isClaudeModel?: boolean,
): any[] {
  const lastAssistantIdx = findLastAssistantIndex(messages, "assistant");

  return messages.map((message: any, idx: number) => {
    if (!message || typeof message !== "object") {
      return message;
    }

    if (Array.isArray((message as any).content)) {
      const isAssistantRole = (message as any).role === "assistant";
      const isLastAssistant = isAssistantRole && idx === lastAssistantIdx;
      
      const filteredContent = filterContentArray(
        (message as any).content,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel,
        isLastAssistant,
      );

      const trimmedContent = isAssistantRole && !isClaudeModel
        ? removeTrailingThinkingBlocks(filteredContent, sessionId, getCachedSignatureFn)
        : filteredContent;

      return { ...message, content: trimmedContent };
    }

    return message;
  });
}

export function deepFilterThinkingBlocks(
  payload: unknown,
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
  isClaudeModel?: boolean,
): unknown {
  const visited = new WeakSet<object>();

  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }

    if (visited.has(value as object)) {
      return;
    }

    visited.add(value as object);

    if (Array.isArray(value)) {
      value.forEach((item) => walk(item));
      return;
    }

    const obj = value as Record<string, unknown>;

    if (Array.isArray(obj.contents)) {
      obj.contents = filterUnsignedThinkingBlocks(
        obj.contents as any[],
        sessionId,
        getCachedSignatureFn,
        isClaudeModel,
      );
    }

    if (Array.isArray(obj.messages)) {
      obj.messages = filterMessagesThinkingBlocks(
        obj.messages as any[],
        sessionId,
        getCachedSignatureFn,
        isClaudeModel,
      );
    }

    Object.keys(obj).forEach((key) => walk(obj[key]));
  };

  walk(payload);
  return payload;
}

/**
 * Transforms Gemini-style thought parts (thought: true) and Anthropic-style
 * thinking parts (type: "thinking") to reasoning format.
 * Claude responses through Antigravity may use candidates structure with Anthropic-style parts.
 */
function transformGeminiCandidate(candidate: any): any {
  if (!candidate || typeof candidate !== "object") {
    return candidate;
  }

  const content = candidate.content;
  if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
    return candidate;
  }

  const thinkingTexts: string[] = [];
  const transformedParts = content.parts.map((part: any) => {
    if (!part || typeof part !== "object") {
      return part;
    }

    // Handle Gemini-style: thought: true
    if (part.thought === true) {
      const thinkingText = part.text || "";
      thinkingTexts.push(thinkingText);
      const transformed: Record<string, unknown> = { ...part, type: "reasoning" };
      if (part.cache_control) transformed.cache_control = part.cache_control;

      // Convert signature to providerMetadata format for OpenCode
      const sig = part.signature || part.thoughtSignature;
      if (sig) {
        transformed.providerMetadata = {
          anthropic: { signature: sig }
        };
        delete (transformed as any).signature;
        delete (transformed as any).thoughtSignature;
      }

      return transformed;
    }

    // Handle Anthropic-style in candidates: type: "thinking"
    if (part.type === "thinking") {
      const thinkingText = part.thinking || part.text || "";
      thinkingTexts.push(thinkingText);
      const transformed: Record<string, unknown> = {
        ...part,
        type: "reasoning",
        text: thinkingText,
        thought: true,
      };
      if (part.cache_control) transformed.cache_control = part.cache_control;

      // Convert signature to providerMetadata format for OpenCode
      const sig = part.signature || part.thoughtSignature;
      if (sig) {
        transformed.providerMetadata = {
          anthropic: { signature: sig }
        };
        delete (transformed as any).signature;
        delete (transformed as any).thoughtSignature;
      }

      return transformed;
    }

    // Handle functionCall: parse JSON strings in args and ensure args is always defined
    // (Ported from LLM-API-Key-Proxy's _extract_tool_call)
    // Fix: When Claude calls a tool with no parameters, args may be undefined.
    // opencode expects state.input to be a record, so we must ensure args: {} as fallback.
    if (part.functionCall) {
      const parsedArgs = part.functionCall.args
        ? recursivelyParseJsonStrings(part.functionCall.args)
        : {};
      return {
        ...part,
        functionCall: {
          ...part.functionCall,
          args: parsedArgs,
        },
      };
    }

    // Handle image data (inlineData) - save to disk and return file path
    if (part.inlineData) {
      const result = processImageData({
        mimeType: part.inlineData.mimeType,
        data: part.inlineData.data,
      });
      if (result) {
        return { text: result };
      }
    }

    return part;
  });

  return {
    ...candidate,
    content: { ...content, parts: transformedParts },
    ...(thinkingTexts.length > 0 ? { reasoning_content: thinkingTexts.join("\n\n") } : {}),
  };
}

/**
 * Transforms thinking/reasoning content in response parts to OpenCode's expected format.
 * Handles both Gemini-style (thought: true) and Anthropic-style (type: "thinking") formats.
 * Also extracts reasoning_content for Anthropic-style responses.
 */
export function transformThinkingParts(response: unknown): unknown {
  if (!response || typeof response !== "object") {
    return response;
  }

  const resp = response as Record<string, unknown>;
  const result: Record<string, unknown> = { ...resp };
  const reasoningTexts: string[] = [];

  // Handle Anthropic-style content array (type: "thinking")
  if (Array.isArray(resp.content)) {
    const transformedContent: any[] = [];
    for (const block of resp.content) {
      if (block && typeof block === "object" && (block as any).type === "thinking") {
        const thinkingText = (block as any).thinking || (block as any).text || "";
        reasoningTexts.push(thinkingText);
        const transformed: Record<string, unknown> = {
          ...block,
          type: "reasoning",
          text: thinkingText,
          thought: true,
        };

        // Convert signature to providerMetadata format for OpenCode
        const sig = (block as any).signature || (block as any).thoughtSignature;
        if (sig) {
          transformed.providerMetadata = {
            anthropic: { signature: sig }
          };
          delete (transformed as any).signature;
          delete (transformed as any).thoughtSignature;
        }

        transformedContent.push(transformed);
      } else {
        transformedContent.push(block);
      }
    }
    result.content = transformedContent;
  }

  // Handle Gemini-style candidates array
  if (Array.isArray(resp.candidates)) {
    result.candidates = resp.candidates.map(transformGeminiCandidate);
  }

  // Add reasoning_content if we found any thinking blocks (for Anthropic-style)
  if (reasoningTexts.length > 0 && !result.reasoning_content) {
    result.reasoning_content = reasoningTexts.join("\n\n");
  }

  return result;
}

/**
 * Ensures thinkingConfig is valid: includeThoughts only allowed when budget > 0.
 */
export function normalizeThinkingConfig(config: unknown): ThinkingConfig | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const record = config as Record<string, unknown>;
  const budgetRaw = record.thinkingBudget ?? record.thinking_budget;
  const includeRaw = record.includeThoughts ?? record.include_thoughts;

  const thinkingBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : undefined;
  const includeThoughts = typeof includeRaw === "boolean" ? includeRaw : undefined;

  const enableThinking = thinkingBudget !== undefined && thinkingBudget > 0;
  const finalInclude = enableThinking ? includeThoughts ?? false : false;

  if (!enableThinking && finalInclude === false && thinkingBudget === undefined && includeThoughts === undefined) {
    return undefined;
  }

  const normalized: ThinkingConfig = {};
  if (thinkingBudget !== undefined) {
    normalized.thinkingBudget = thinkingBudget;
  }
  if (finalInclude !== undefined) {
    normalized.includeThoughts = finalInclude;
  }
  return normalized;
}

/**
 * Parses an Antigravity API body; handles array-wrapped responses the API sometimes returns.
 */
export function parseAntigravityApiBody(rawText: string): AntigravityApiBody | null {
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      const firstObject = parsed.find((item: unknown) => typeof item === "object" && item !== null);
      if (firstObject && typeof firstObject === "object") {
        return firstObject as AntigravityApiBody;
      }
      return null;
    }

    if (parsed && typeof parsed === "object") {
      return parsed as AntigravityApiBody;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts usageMetadata from a response object, guarding types.
 */
export function extractUsageMetadata(body: AntigravityApiBody): AntigravityUsageMetadata | null {
  const usage = (body.response && typeof body.response === "object"
    ? (body.response as { usageMetadata?: unknown }).usageMetadata
    : undefined) as AntigravityUsageMetadata | undefined;

  if (!usage || typeof usage !== "object") {
    return null;
  }

  const asRecord = usage as Record<string, unknown>;
  const toNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  return {
    totalTokenCount: toNumber(asRecord.totalTokenCount),
    promptTokenCount: toNumber(asRecord.promptTokenCount),
    candidatesTokenCount: toNumber(asRecord.candidatesTokenCount),
    cachedContentTokenCount: toNumber(asRecord.cachedContentTokenCount),
    thoughtsTokenCount: toNumber(asRecord.thoughtsTokenCount),
  };
}

/**
 * Walks SSE lines to find a usage-bearing response chunk.
 */
export function extractUsageFromSsePayload(payload: string): AntigravityUsageMetadata | null {
  const lines = payload.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const jsonText = line.slice(5).trim();
    if (!jsonText) {
      continue;
    }
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === "object") {
        const usage = extractUsageMetadata({ response: (parsed as Record<string, unknown>).response });
        if (usage) {
          return usage;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Enhances 404 errors for Antigravity models with a direct preview-access message.
 */
export function rewriteAntigravityPreviewAccessError(
  body: AntigravityApiBody,
  status: number,
  requestedModel?: string,
): AntigravityApiBody | null {
  if (!needsPreviewAccessOverride(status, body, requestedModel)) {
    return null;
  }

  const error: AntigravityApiError = body.error ?? {};
  const trimmedMessage = typeof error.message === "string" ? error.message.trim() : "";
  const messagePrefix = trimmedMessage.length > 0
    ? trimmedMessage
    : "Antigravity preview features are not enabled for this account.";
  const enhancedMessage = `${messagePrefix} Request preview access at ${ANTIGRAVITY_PREVIEW_LINK} before using this model.`;

  return {
    ...body,
    error: {
      ...error,
      message: enhancedMessage,
    },
  };
}

function needsPreviewAccessOverride(
  status: number,
  body: AntigravityApiBody,
  requestedModel?: string,
): boolean {
  if (status !== 404) {
    return false;
  }

  if (isAntigravityModel(requestedModel)) {
    return true;
  }

  const errorMessage = typeof body.error?.message === "string" ? body.error.message : "";
  return isAntigravityModel(errorMessage);
}

function isAntigravityModel(target?: string): boolean {
  if (!target) {
    return false;
  }

  // Check for Antigravity models instead of Gemini 3
  return /antigravity/i.test(target) || /opus/i.test(target) || /claude/i.test(target);
}

// ============================================================================
// EMPTY RESPONSE DETECTION (Ported from LLM-API-Key-Proxy)
// ============================================================================

/**
 * Checks if a JSON response body represents an empty response.
 * 
 * Empty responses occur when:
 * - No candidates in Gemini format
 * - No choices in OpenAI format
 * - Candidates/choices exist but have no content
 * 
 * @param text - The response body text (should be valid JSON)
 * @returns true if the response is empty
 */
export function isEmptyResponseBody(text: string): boolean {
  if (!text || !text.trim()) {
    return true;
  }

  try {
    const parsed = JSON.parse(text);
    
    // Check for empty candidates (Gemini/Antigravity format)
    if (parsed.candidates !== undefined) {
      if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
        return true;
      }
      
      // Check if first candidate has empty content
      const firstCandidate = parsed.candidates[0];
      if (!firstCandidate) {
        return true;
      }
      
      // Check for empty parts in content
      const content = firstCandidate.content;
      if (!content || typeof content !== "object") {
        return true;
      }
      
      const parts = content.parts;
      if (!Array.isArray(parts) || parts.length === 0) {
        return true;
      }
      
      // Check if all parts are empty (no text, no functionCall)
      const hasContent = parts.some((part: any) => {
        if (!part || typeof part !== "object") return false;
        if (typeof part.text === "string" && part.text.length > 0) return true;
        if (part.functionCall) return true;
        if (part.thought === true && typeof part.text === "string") return true;
        return false;
      });
      
      if (!hasContent) {
        return true;
      }
    }
    
    // Check for empty choices (OpenAI format - shouldn't occur but handle it)
    if (parsed.choices !== undefined) {
      if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) {
        return true;
      }
      
      const firstChoice = parsed.choices[0];
      if (!firstChoice) {
        return true;
      }
      
      // Check for empty message/delta
      const message = firstChoice.message || firstChoice.delta;
      if (!message) {
        return true;
      }
      
      // Check if message has content or tool_calls
      if (!message.content && !message.tool_calls && !message.reasoning_content) {
        return true;
      }
    }
    
    // Check response wrapper (Antigravity envelope)
    if (parsed.response !== undefined) {
      const response = parsed.response;
      if (!response || typeof response !== "object") {
        return true;
      }
      return isEmptyResponseBody(JSON.stringify(response));
    }
    
    return false;
  } catch {
    // JSON parse error - treat as empty
    return true;
  }
}

/**
 * Checks if a streaming SSE response yielded zero meaningful chunks.
 * 
 * This is used after consuming a streaming response to determine if retry is needed.
 */
export interface StreamingChunkCounter {
  increment: () => void;
  getCount: () => number;
  hasContent: () => boolean;
}

export function createStreamingChunkCounter(): StreamingChunkCounter {
  let count = 0;
  let hasRealContent = false;

  return {
    increment: () => {
      count++;
    },
    getCount: () => count,
    hasContent: () => hasRealContent || count > 0,
  };
}

/**
 * Checks if an SSE line contains meaningful content.
 * 
 * @param line - A single SSE line (e.g., "data: {...}")
 * @returns true if the line contains content worth counting
 */
export function isMeaningfulSseLine(line: string): boolean {
  if (!line.startsWith("data: ")) {
    return false;
  }

  const data = line.slice(6).trim();
  
  if (data === "[DONE]") {
    return false;
  }

  if (!data) {
    return false;
  }

  try {
    const parsed = JSON.parse(data);
    
    // Check for candidates with content
    if (parsed.candidates && Array.isArray(parsed.candidates)) {
      for (const candidate of parsed.candidates) {
        const parts = candidate?.content?.parts;
        if (Array.isArray(parts) && parts.length > 0) {
          for (const part of parts) {
            if (typeof part?.text === "string" && part.text.length > 0) return true;
            if (part?.functionCall) return true;
          }
        }
      }
    }
    
    // Check response wrapper
    if (parsed.response?.candidates) {
      return isMeaningfulSseLine(`data: ${JSON.stringify(parsed.response)}`);
    }
    
    return false;
  } catch {
    return false;
  }
}

// ============================================================================
// RECURSIVE JSON STRING AUTO-PARSING (Ported from LLM-API-Key-Proxy)
// ============================================================================

/**
 * Recursively parses JSON strings in nested data structures.
 * 
 * This is a port of LLM-API-Key-Proxy's _recursively_parse_json_strings() function.
 * 
 * Handles:
 * - JSON-stringified values: {"files": "[{...}]"} → {"files": [{...}]}
 * - Malformed double-encoded JSON (extra trailing chars)
 * - Escaped control characters (\\n → \n, \\t → \t)
 * 
 * This is useful because Antigravity sometimes returns JSON-stringified values
 * in tool arguments, which can cause downstream parsing issues.
 * 
 * @param obj - The object to recursively parse
 * @param skipParseKeys - Set of keys whose values should NOT be parsed as JSON (preserved as strings)
 * @param currentKey - The current key being processed (internal use)
 * @returns The parsed object with JSON strings expanded
 */
// Keys whose string values should NOT be parsed as JSON - they contain literal text content
const SKIP_PARSE_KEYS = new Set([
  "oldString",
  "newString",
  "content",
  "filePath",
  "path",
  "text",
  "code",
  "source",
  "data",
  "body",
  "message",
  "prompt",
  "input",
  "output",
  "result",
  "value",
  "query",
  "pattern",
  "replacement",
  "template",
  "script",
  "command",
  "snippet",
]);

export function recursivelyParseJsonStrings(
  obj: unknown,
  skipParseKeys: Set<string> = SKIP_PARSE_KEYS,
  currentKey?: string,
): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => recursivelyParseJsonStrings(item, skipParseKeys));
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = recursivelyParseJsonStrings(value, skipParseKeys, key);
    }
    return result;
  }

  if (typeof obj !== "string") {
    return obj;
  }

  if (currentKey && skipParseKeys.has(currentKey)) {
    return obj;
  }

  const stripped = obj.trim();

  // Check if string contains control character escape sequences
  // that need unescaping (\\n, \\t but NOT \\" or \\\\)
  const hasControlCharEscapes = obj.includes("\\n") || obj.includes("\\t");
  const hasIntentionalEscapes = obj.includes('\\"') || obj.includes("\\\\");

  if (hasControlCharEscapes && !hasIntentionalEscapes) {
    try {
      // Use JSON.parse with quotes to unescape the string
      return JSON.parse(`"${obj}"`);
    } catch {
      // Continue with original processing
    }
  }

  // Check if it looks like JSON (starts with { or [)
  if (stripped && (stripped[0] === "{" || stripped[0] === "[")) {
    // Try standard parsing first
    if (
      (stripped.startsWith("{") && stripped.endsWith("}")) ||
      (stripped.startsWith("[") && stripped.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(obj);
        return recursivelyParseJsonStrings(parsed);
      } catch {
        // Continue
      }
    }

    // Handle malformed JSON: array that doesn't end with ]
    if (stripped.startsWith("[") && !stripped.endsWith("]")) {
      try {
        const lastBracket = stripped.lastIndexOf("]");
        if (lastBracket > 0) {
          const cleaned = stripped.slice(0, lastBracket + 1);
          const parsed = JSON.parse(cleaned);
          log.debug("Auto-corrected malformed JSON array", {
            truncatedChars: stripped.length - cleaned.length,
          });
          return recursivelyParseJsonStrings(parsed);
        }
      } catch {
        // Continue
      }
    }

    // Handle malformed JSON: object that doesn't end with }
    if (stripped.startsWith("{") && !stripped.endsWith("}")) {
      try {
        const lastBrace = stripped.lastIndexOf("}");
        if (lastBrace > 0) {
          const cleaned = stripped.slice(0, lastBrace + 1);
          const parsed = JSON.parse(cleaned);
          log.debug("Auto-corrected malformed JSON object", {
            truncatedChars: stripped.length - cleaned.length,
          });
          return recursivelyParseJsonStrings(parsed);
        }
      } catch {
        // Continue
      }
    }
  }

  return obj;
}

// ============================================================================
// TOOL ID ORPHAN RECOVERY (Ported from LLM-API-Key-Proxy)
// ============================================================================

/**
 * Groups function calls with their responses, handling ID mismatches.
 * 
 * This is a port of LLM-API-Key-Proxy's _fix_tool_response_grouping() function.
 * 
 * When context compaction or other processes strip tool responses, the tool call
 * IDs become orphaned. This function attempts to recover by:
 * 
 * 1. Pass 1: Match by exact ID (normal case)
 * 2. Pass 2: Match by function name (for ID mismatches)
 * 3. Pass 3: Match "unknown_function" orphans or take first available
 * 4. Fallback: Create placeholder responses for missing tool results
 * 
 * @param contents - Array of Gemini-style content messages
 * @returns Fixed contents array with matched tool responses
 */
export function fixToolResponseGrouping(contents: any[]): any[] {
  if (!Array.isArray(contents) || contents.length === 0) {
    return contents;
  }

  const newContents: any[] = [];
  
  // Track pending tool call groups that need responses
  const pendingGroups: Array<{
    ids: string[];
    funcNames: string[];
    insertAfterIdx: number;
  }> = [];
  
  // Collected orphan responses (by ID)
  const collectedResponses = new Map<string, any>();
  
  for (const content of contents) {
    const role = content.role;
    const parts = content.parts || [];
    
    // Check if this is a tool response message
    const responseParts = parts.filter((p: any) => p?.functionResponse);
    
    if (responseParts.length > 0) {
      // Collect responses by ID (skip duplicates)
      for (const resp of responseParts) {
        const respId = resp.functionResponse?.id || "";
        if (respId && !collectedResponses.has(respId)) {
          collectedResponses.set(respId, resp);
        }
      }
      
      // Try to satisfy the most recent pending group
      for (let i = pendingGroups.length - 1; i >= 0; i--) {
        const group = pendingGroups[i]!;
        if (group.ids.every(id => collectedResponses.has(id))) {
          // All IDs found - build the response group
          const groupResponses = group.ids.map(id => {
            const resp = collectedResponses.get(id);
            collectedResponses.delete(id);
            return resp;
          });
          newContents.push({ parts: groupResponses, role: "user" });
          pendingGroups.splice(i, 1);
          break; // Only satisfy one group at a time
        }
      }
      continue; // Don't add the original response message
    }
    
    if (role === "model") {
      // Check for function calls in this model message
      const funcCalls = parts.filter((p: any) => p?.functionCall);
      newContents.push(content);
      
      if (funcCalls.length > 0) {
        const callIds = funcCalls
          .map((fc: any) => fc.functionCall?.id || "")
          .filter(Boolean);
        const funcNames = funcCalls
          .map((fc: any) => fc.functionCall?.name || "");
        
        if (callIds.length > 0) {
          pendingGroups.push({
            ids: callIds,
            funcNames,
            insertAfterIdx: newContents.length - 1,
          });
        }
      }
    } else {
      newContents.push(content);
    }
  }
  
  // Handle remaining pending groups with orphan recovery
  // Process in reverse order so insertions don't shift indices
  pendingGroups.sort((a, b) => b.insertAfterIdx - a.insertAfterIdx);
  
  for (const group of pendingGroups) {
    const groupResponses: any[] = [];
    
    for (let i = 0; i < group.ids.length; i++) {
      const expectedId = group.ids[i]!;
      const expectedName = group.funcNames[i] || "";
      
      if (collectedResponses.has(expectedId)) {
        // Direct ID match - ideal case
        groupResponses.push(collectedResponses.get(expectedId));
        collectedResponses.delete(expectedId);
      } else if (collectedResponses.size > 0) {
        // Need to find an orphan response
        let matchedId: string | null = null;
        
        // Pass 1: Match by function name
        for (const [orphanId, orphanResp] of collectedResponses) {
          const orphanName = orphanResp.functionResponse?.name || "";
          if (orphanName === expectedName) {
            matchedId = orphanId;
            break;
          }
        }
        
        // Pass 2: Match "unknown_function" orphans
        if (!matchedId) {
          for (const [orphanId, orphanResp] of collectedResponses) {
            if (orphanResp.functionResponse?.name === "unknown_function") {
              matchedId = orphanId;
              break;
            }
          }
        }
        
        // Pass 3: Take first available
        if (!matchedId) {
          matchedId = collectedResponses.keys().next().value ?? null;
        }
        
        if (matchedId) {
          const orphanResp = collectedResponses.get(matchedId)!;
          collectedResponses.delete(matchedId);
          
          // Fix the ID and name to match expected
          orphanResp.functionResponse.id = expectedId;
          if (orphanResp.functionResponse.name === "unknown_function" && expectedName) {
            orphanResp.functionResponse.name = expectedName;
          }
          
          log.debug("Auto-repaired tool ID mismatch", {
            mappedFrom: matchedId,
            mappedTo: expectedId,
            functionName: expectedName,
          });
          
          groupResponses.push(orphanResp);
        }
      } else {
        // No responses available - create placeholder
        const placeholder = {
          functionResponse: {
            name: expectedName || "unknown_function",
            response: {
              result: {
                error: "Tool response was lost during context processing. " +
                       "This is a recovered placeholder.",
                recovered: true,
              },
            },
            id: expectedId,
          },
        };
        
        log.debug("Created placeholder response for missing tool", {
          id: expectedId,
          name: expectedName,
        });
        
        groupResponses.push(placeholder);
      }
    }
    
    if (groupResponses.length > 0) {
      // Insert at correct position (after the model message that made the calls)
      newContents.splice(group.insertAfterIdx + 1, 0, {
        parts: groupResponses,
        role: "user",
      });
    }
  }
  
  return newContents;
}

/**
 * Checks if contents have any tool call/response ID mismatches.
 * 
 * @param contents - Array of Gemini-style content messages
 * @returns Object with mismatch details
 */
export function detectToolIdMismatches(contents: any[]): {
  hasMismatches: boolean;
  expectedIds: string[];
  foundIds: string[];
  missingIds: string[];
  orphanIds: string[];
} {
  const expectedIds: string[] = [];
  const foundIds: string[] = [];
  
  for (const content of contents) {
    const parts = content.parts || [];
    
    for (const part of parts) {
      if (part?.functionCall?.id) {
        expectedIds.push(part.functionCall.id);
      }
      if (part?.functionResponse?.id) {
        foundIds.push(part.functionResponse.id);
      }
    }
  }
  
  const expectedSet = new Set(expectedIds);
  const foundSet = new Set(foundIds);
  
  const missingIds = expectedIds.filter(id => !foundSet.has(id));
  const orphanIds = foundIds.filter(id => !expectedSet.has(id));
  
  return {
    hasMismatches: missingIds.length > 0 || orphanIds.length > 0,
    expectedIds,
    foundIds,
    missingIds,
    orphanIds,
  };
}

// ============================================================================
// CLAUDE FORMAT TOOL PAIRING (Defense in Depth)
// ============================================================================

/**
 * Find orphaned tool_use IDs (tool_use without matching tool_result).
 * Works on Claude format messages.
 */
export function findOrphanedToolUseIds(messages: any[]): Set<string> {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) {
          toolUseIds.add(block.id);
        }
        if (block.type === "tool_result" && block.tool_use_id) {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  return new Set([...toolUseIds].filter((id) => !toolResultIds.has(id)));
}

/**
 * Fix orphaned tool_use blocks in Claude format messages.
 * Mirrors fixToolResponseGrouping() but for Claude's messages[] format.
 *
 * Claude format:
 * - assistant message with content[]: { type: 'tool_use', id, name, input }
 * - user message with content[]: { type: 'tool_result', tool_use_id, content }
 *
 * @param messages - Claude format messages array
 * @returns Fixed messages with placeholder tool_results for orphans
 */
export function fixClaudeToolPairing(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  // 1. Collect all tool_use IDs from assistant messages
  const toolUseMap = new Map<string, { name: string; msgIndex: number }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) {
          toolUseMap.set(block.id, { name: block.name || `tool-${toolUseMap.size}`, msgIndex: i });
        }
      }
    }
  }

  // 2. Collect all tool_result IDs from user messages
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  // 3. Find orphaned tool_use (no matching tool_result)
  const orphans: Array<{ id: string; name: string; msgIndex: number }> = [];

  for (const [id, info] of toolUseMap) {
    if (!toolResultIds.has(id)) {
      orphans.push({ id, ...info });
    }
  }

  if (orphans.length === 0) {
    return messages;
  }

  // 4. Group orphans by message index (insert after each assistant message)
  const orphansByMsgIndex = new Map<number, typeof orphans>();
  for (const orphan of orphans) {
    const existing = orphansByMsgIndex.get(orphan.msgIndex) || [];
    existing.push(orphan);
    orphansByMsgIndex.set(orphan.msgIndex, existing);
  }

  // 5. Build new messages array with injected tool_results
  const result: any[] = [];

  for (let i = 0; i < messages.length; i++) {
    result.push(messages[i]);

    const orphansForMsg = orphansByMsgIndex.get(i);
    if (orphansForMsg && orphansForMsg.length > 0) {
      // Check if next message is user with tool_result - if so, merge into it
      const nextMsg = messages[i + 1];
      if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
        // Will be handled when we push nextMsg - add to its content
        const placeholders = orphansForMsg.map((o) => ({
          type: "tool_result",
          tool_use_id: o.id,
          content: `[Tool "${o.name}" execution was cancelled or failed]`,
          is_error: true,
        }));
        // Prepend placeholders to next message's content
        nextMsg.content = [...placeholders, ...nextMsg.content];
      } else {
        // Inject new user message with placeholder tool_results
        result.push({
          role: "user",
          content: orphansForMsg.map((o) => ({
            type: "tool_result",
            tool_use_id: o.id,
            content: `[Tool "${o.name}" execution was cancelled or failed]`,
            is_error: true,
          })),
        });
      }
    }
  }

  return result;
}

/**
 * Nuclear option: Remove orphaned tool_use blocks entirely.
 * Called when fixClaudeToolPairing() fails to pair all tools.
 */
function removeOrphanedToolUse(messages: any[], orphanIds: Set<string>): any[] {
  return messages
    .map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.filter(
            (block: any) => block.type !== "tool_use" || !orphanIds.has(block.id)
          ),
        };
      }
      return msg;
    })
    .filter(
      (msg) =>
        // Remove empty assistant messages
        !(msg.role === "assistant" && Array.isArray(msg.content) && msg.content.length === 0)
    );
}

/**
 * Validate and fix tool pairing with fallback nuclear option.
 * Defense in depth: tries gentle fix first, then nuclear removal.
 */
export function validateAndFixClaudeToolPairing(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  // First: Try gentle fix (inject placeholder tool_results)
  let fixed = fixClaudeToolPairing(messages);

  // Second: Validate - find any remaining orphans
  const orphanIds = findOrphanedToolUseIds(fixed);

  if (orphanIds.size === 0) {
    return fixed;
  }

  // Third: Nuclear option - remove orphaned tool_use entirely
  // This should rarely happen, but provides defense in depth
  console.warn("[antigravity] fixClaudeToolPairing left orphans, applying nuclear option", {
    orphanIds: [...orphanIds],
  });

  return removeOrphanedToolUse(fixed, orphanIds);
}

// ============================================================================
// TOOL HALLUCINATION PREVENTION (Ported from LLM-API-Key-Proxy)
// ============================================================================

/**
 * Formats a type hint for a property schema.
 * Port of LLM-API-Key-Proxy's _format_type_hint()
 */
function formatTypeHint(propData: Record<string, unknown>, depth = 0): string {
  const type = propData.type as string ?? "unknown";

  // Handle enum values
  if (propData.enum && Array.isArray(propData.enum)) {
    const enumVals = propData.enum as unknown[];
    if (enumVals.length <= 5) {
      return `string ENUM[${enumVals.map(v => JSON.stringify(v)).join(", ")}]`;
    }
    return `string ENUM[${enumVals.length} options]`;
  }

  // Handle const values
  if (propData.const !== undefined) {
    return `string CONST=${JSON.stringify(propData.const)}`;
  }

  if (type === "array") {
    const items = propData.items as Record<string, unknown> | undefined;
    if (items && typeof items === "object") {
      const itemType = items.type as string ?? "unknown";
      if (itemType === "object") {
        const nestedProps = items.properties as Record<string, unknown> | undefined;
        const nestedReq = items.required as string[] | undefined ?? [];
        if (nestedProps && depth < 1) {
          const nestedList = Object.entries(nestedProps).map(([n, d]) => {
            const t = (d as Record<string, unknown>).type as string ?? "unknown";
            const req = nestedReq.includes(n) ? " REQUIRED" : "";
            return `${n}: ${t}${req}`;
          });
          return `ARRAY_OF_OBJECTS[${nestedList.join(", ")}]`;
        }
        return "ARRAY_OF_OBJECTS";
      }
      return `ARRAY_OF_${itemType.toUpperCase()}`;
    }
    return "ARRAY";
  }

  if (type === "object") {
    const nestedProps = propData.properties as Record<string, unknown> | undefined;
    const nestedReq = propData.required as string[] | undefined ?? [];
    if (nestedProps && depth < 1) {
      const nestedList = Object.entries(nestedProps).map(([n, d]) => {
        const t = (d as Record<string, unknown>).type as string ?? "unknown";
        const req = nestedReq.includes(n) ? " REQUIRED" : "";
        return `${n}: ${t}${req}`;
      });
      return `object{${nestedList.join(", ")}}`;
    }
  }

  return type;
}

/**
 * Injects parameter signatures into tool descriptions.
 * Port of LLM-API-Key-Proxy's _inject_signature_into_descriptions()
 * 
 * This helps prevent tool hallucination by explicitly listing parameters
 * in the description, making it harder for the model to hallucinate
 * parameters from its training data.
 * 
 * @param tools - Array of tool definitions (Gemini format)
 * @param promptTemplate - Template for the signature (default: "\\n\\nSTRICT PARAMETERS: {params}.")
 * @returns Modified tools array with signatures injected
 */
export function injectParameterSignatures(
  tools: any[],
  promptTemplate = "\n\n⚠️ STRICT PARAMETERS: {params}.",
): any[] {
  if (!tools || !Array.isArray(tools)) return tools;

  return tools.map((tool) => {
    const declarations = tool.functionDeclarations;
    if (!Array.isArray(declarations)) return tool;

    const newDeclarations = declarations.map((decl: any) => {
      // Skip if signature already injected (avoids duplicate injection)
      if (decl.description?.includes("STRICT PARAMETERS:")) {
        return decl;
      }

      const schema = decl.parameters || decl.parametersJsonSchema;
      if (!schema) return decl;

      const required = schema.required as string[] ?? [];
      const properties = schema.properties as Record<string, unknown> ?? {};

      if (Object.keys(properties).length === 0) return decl;

      const paramList = Object.entries(properties).map(([propName, propData]) => {
        const typeHint = formatTypeHint(propData as Record<string, unknown>);
        const isRequired = required.includes(propName);
        return `${propName} (${typeHint}${isRequired ? ", REQUIRED" : ""})`;
      });

      const sigStr = promptTemplate.replace("{params}", paramList.join(", "));
      
      return {
        ...decl,
        description: (decl.description || "") + sigStr,
      };
    });

    return { ...tool, functionDeclarations: newDeclarations };
  });
}

/**
 * Injects a tool hardening system instruction into the request payload.
 * Port of LLM-API-Key-Proxy's _inject_tool_hardening_instruction()
 * 
 * @param payload - The Gemini request payload
 * @param instructionText - The instruction text to inject
 */
export function injectToolHardeningInstruction(
  payload: Record<string, unknown>,
  instructionText: string,
): void {
  if (!instructionText) return;

  // Skip if instruction already present (avoids duplicate injection)
  const existing = payload.systemInstruction as Record<string, unknown> | undefined;
  if (existing && typeof existing === "object" && "parts" in existing) {
    const parts = existing.parts as Array<{ text?: string }>;
    if (Array.isArray(parts) && parts.some(p => p.text?.includes("CRITICAL TOOL USAGE INSTRUCTIONS"))) {
      return;
    }
  }

  const instructionPart = { text: instructionText };

  if (payload.systemInstruction) {
    if (existing && typeof existing === "object" && "parts" in existing) {
      const parts = existing.parts as unknown[];
      if (Array.isArray(parts)) {
        parts.unshift(instructionPart);
      }
    } else if (typeof existing === "string") {
      payload.systemInstruction = {
        role: "user",
        parts: [instructionPart, { text: existing }],
      };
    } else {
      payload.systemInstruction = {
        role: "user",
        parts: [instructionPart],
      };
    }
  } else {
    payload.systemInstruction = {
      role: "user",
      parts: [instructionPart],
    };
  }
}

// ============================================================================
// TOOL PROCESSING FOR WRAPPED REQUESTS
// Shared logic for assigning tool IDs and fixing tool pairing
// ============================================================================

/**
 * Assigns IDs to functionCall parts and returns the pending call IDs by name.
 * This is the first pass of tool ID assignment.
 * 
 * @param contents - Gemini-style contents array
 * @returns Object with modified contents and pending call IDs map
 */
export function assignToolIdsToContents(
  contents: any[]
): { contents: any[]; pendingCallIdsByName: Map<string, string[]>; toolCallCounter: number } {
  if (!Array.isArray(contents)) {
    return { contents, pendingCallIdsByName: new Map(), toolCallCounter: 0 };
  }

  let toolCallCounter = 0;
  const pendingCallIdsByName = new Map<string, string[]>();

  const newContents = contents.map((content: any) => {
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
        const queue = pendingCallIdsByName.get(nameKey) || [];
        queue.push(call.id);
        pendingCallIdsByName.set(nameKey, queue);
        return { ...part, functionCall: call };
      }
      return part;
    });

    return { ...content, parts: newParts };
  });

  return { contents: newContents, pendingCallIdsByName, toolCallCounter };
}

/**
 * Matches functionResponse IDs to their corresponding functionCall IDs.
 * This is the second pass of tool ID assignment.
 * 
 * @param contents - Gemini-style contents array
 * @param pendingCallIdsByName - Map of function names to pending call IDs
 * @returns Modified contents with matched response IDs
 */
export function matchResponseIdsToContents(
  contents: any[],
  pendingCallIdsByName: Map<string, string[]>
): any[] {
  if (!Array.isArray(contents)) {
    return contents;
  }

  return contents.map((content: any) => {
    if (!content || !Array.isArray(content.parts)) {
      return content;
    }

    const newParts = content.parts.map((part: any) => {
      if (part && typeof part === "object" && part.functionResponse) {
        const resp = { ...part.functionResponse };
        if (!resp.id && typeof resp.name === "string") {
          const queue = pendingCallIdsByName.get(resp.name);
          if (queue && queue.length > 0) {
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

/**
 * Applies all tool fixes to a request payload for Claude models.
 * This includes:
 * 1. Tool ID assignment for functionCalls
 * 2. Response ID matching for functionResponses
 * 3. Orphan recovery via fixToolResponseGrouping
 * 4. Claude format pairing fix via validateAndFixClaudeToolPairing
 * 
 * @param payload - Request payload object
 * @param isClaude - Whether this is a Claude model request
 * @returns Object with fix applied status
 */
export function applyToolPairingFixes(
  payload: Record<string, unknown>,
  isClaude: boolean
): { contentsFixed: boolean; messagesFixed: boolean } {
  let contentsFixed = false;
  let messagesFixed = false;

  if (!isClaude) {
    return { contentsFixed, messagesFixed };
  }

  // Fix Gemini format (contents[])
  if (Array.isArray(payload.contents)) {
    // First pass: assign IDs to functionCalls
    const { contents: contentsWithIds, pendingCallIdsByName } = assignToolIdsToContents(
      payload.contents as any[]
    );

    // Second pass: match functionResponse IDs
    const contentsWithMatchedIds = matchResponseIdsToContents(contentsWithIds, pendingCallIdsByName);

    // Third pass: fix orphan recovery
    payload.contents = fixToolResponseGrouping(contentsWithMatchedIds);
    contentsFixed = true;

    log.debug("Applied tool pairing fixes to contents[]", {
      originalLength: (payload.contents as any[]).length,
    });
  }

  // Fix Claude format (messages[])
  if (Array.isArray(payload.messages)) {
    payload.messages = validateAndFixClaudeToolPairing(payload.messages as any[]);
    messagesFixed = true;

    log.debug("Applied tool pairing fixes to messages[]", {
      originalLength: (payload.messages as any[]).length,
    });
  }

  return { contentsFixed, messagesFixed };
}

// ============================================================================
// SYNTHETIC CLAUDE SSE RESPONSE
// Used to return error messages as "successful" responses to avoid locking
// the OpenCode session when unrecoverable errors (like 400 Prompt Too Long) occur.
// ============================================================================

/**
 * Creates a synthetic Claude SSE streaming response with error content.
 * 
 * When returning HTTP 400/500 errors to OpenCode, the session becomes locked
 * and the user cannot use /compact or other commands. This function creates
 * a fake "successful" SSE response (200 OK) with the error message as text content,
 * allowing the user to continue using the session.
 * 
 * @param errorMessage - The error message to include in the response
 * @param requestedModel - The model that was requested
 * @returns A Response object with synthetic SSE stream
 */
export function createSyntheticErrorResponse(
  errorMessage: string,
  requestedModel: string = "unknown",
): Response {
  // Generate a unique message ID
  const messageId = `msg_synthetic_${Date.now()}`;
  
  // Build Claude SSE events that represent a complete message with error text
  const events: string[] = [];
  
  // 1. message_start event
  events.push(`event: message_start
data: ${JSON.stringify({
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: requestedModel,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })}

`);

  // 2. content_block_start event
  events.push(`event: content_block_start
data: ${JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  })}

`);

  // 3. content_block_delta event with the error message
  events.push(`event: content_block_delta
data: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: errorMessage },
  })}

`);

  // 4. content_block_stop event
  events.push(`event: content_block_stop
data: ${JSON.stringify({
    type: "content_block_stop",
    index: 0,
  })}

`);

  // 5. message_delta event (end_turn)
  events.push(`event: message_delta
data: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: Math.ceil(errorMessage.length / 4) },
  })}

`);

  // 6. message_stop event
  events.push(`event: message_stop
data: ${JSON.stringify({ type: "message_stop" })}

`);

  const body = events.join("");

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Antigravity-Synthetic": "true",
      "X-Antigravity-Error-Type": "prompt_too_long",
    },
  });
}
