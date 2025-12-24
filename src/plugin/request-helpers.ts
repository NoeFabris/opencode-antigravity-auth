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
 * Phase 2b: Flattens anyOf/oneOf to the best option with type hints.
 * { anyOf: [{ type: "string" }, { type: "number" }] }
 * → { type: "string", description: "(Accepts: string | number)" }
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
 */
function removeUnsupportedKeywords(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => removeUnsupportedKeywords(item));
  }

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    // Skip unsupported keywords
    if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
      continue;
    }

    // Recursively process nested objects
    if (typeof value === "object" && value !== null) {
      result[key] = removeUnsupportedKeywords(value);
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
  if (result.type === "object") {
    const hasProperties = result.properties && 
      typeof result.properties === "object" && 
      Object.keys(result.properties).length > 0;

    if (!hasProperties) {
      result.properties = {
        reason: {
          type: "string",
          description: "Brief explanation of why you are calling this tool",
        },
      };
      result.required = ["reason"];
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
 */
function sanitizeThinkingPart(part: Record<string, unknown>): Record<string, unknown> {
  // Gemini-style thought blocks: { thought: true, text, thoughtSignature }
  if (part.thought === true) {
    const sanitized: Record<string, unknown> = { thought: true };

    if (part.text !== undefined) {
      if (typeof part.text === "object" && part.text !== null) {
        const maybeText = (part.text as any).text;
        sanitized.text = typeof maybeText === "string" ? maybeText : part.text;
      } else {
        sanitized.text = part.text;
      }
    }

    if (part.thoughtSignature !== undefined) sanitized.thoughtSignature = part.thoughtSignature;
    return sanitized;
  }

  // Anthropic-style thinking/redacted_thinking blocks: { type: "thinking"|"redacted_thinking", thinking, signature }
  if (part.type === "thinking" || part.type === "redacted_thinking" || part.thinking !== undefined) {
    const sanitized: Record<string, unknown> = { type: part.type === "redacted_thinking" ? "redacted_thinking" : "thinking" };

    let thinkingContent: unknown = part.thinking ?? part.text;
    if (thinkingContent !== undefined && typeof thinkingContent === "object" && thinkingContent !== null) {
      const maybeText = (thinkingContent as any).text ?? (thinkingContent as any).thinking;
      thinkingContent = typeof maybeText === "string" ? maybeText : "";
    }

    if (thinkingContent !== undefined) sanitized.thinking = thinkingContent;
    if (part.signature !== undefined) sanitized.signature = part.signature;
    return sanitized;
  }

  // Reasoning blocks (OpenCode format): { type: "reasoning", text, signature }
  if (part.type === "reasoning") {
    const sanitized: Record<string, unknown> = { type: "reasoning" };

    if (part.text !== undefined) {
      if (typeof part.text === "object" && part.text !== null) {
        const maybeText = (part.text as any).text;
        sanitized.text = typeof maybeText === "string" ? maybeText : part.text;
      } else {
        sanitized.text = part.text;
      }
    }

    if (part.signature !== undefined) sanitized.signature = part.signature;
    return sanitized;
  }

  // Fallback: strip cache_control recursively.
  return stripCacheControlRecursively(part) as Record<string, unknown>;
}

function filterContentArray(
  contentArray: any[],
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
  isClaudeModel?: boolean,
): any[] {
  if (isClaudeModel) {
    return stripAllThinkingBlocks(contentArray);
  }

  const filtered: any[] = [];

  for (const item of contentArray) {
    if (!item || typeof item !== "object") {
      filtered.push(item);
      continue;
    }

    if (isToolBlock(item)) {
      filtered.push(item);
      continue;
    }

    const isThinking = isThinkingPart(item);
    const hasSignature = hasSignatureField(item);

    if (!isThinking && !hasSignature) {
      filtered.push(item);
      continue;
    }

    if (isOurCachedSignature(item, sessionId, getCachedSignatureFn)) {
      filtered.push(sanitizeThinkingPart(item));
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
          filtered.push(sanitizeThinkingPart(restoredPart as Record<string, unknown>));
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
  return contents.map((content: any) => {
    if (!content || typeof content !== "object") {
      return content;
    }

    if (Array.isArray((content as any).parts)) {
      const filteredParts = filterContentArray(
        (content as any).parts,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel,
      );

      const trimmedParts = (content as any).role === "model" && !isClaudeModel
        ? removeTrailingThinkingBlocks(filteredParts, sessionId, getCachedSignatureFn)
        : filteredParts;

      return { ...content, parts: trimmedParts };
    }

    if (Array.isArray((content as any).content)) {
      const isAssistantRole = (content as any).role === "assistant";
      const filteredContent = filterContentArray(
        (content as any).content,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel,
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
 * Ensures all assistant messages start with a thinking block for Claude thinking models.
 * DCP (Dynamic Context Pruning) creates synthetic assistant messages that lack thinking blocks,
 * which causes Claude API to reject with "Expected 'thinking', but found 'text'".
 * 
 * This function injects a redacted_thinking block at the start of any assistant message
 * that doesn't already begin with a thinking/redacted_thinking block.
 */
export function ensureAssistantMessagesHaveThinking(messages: any[]): any[] {
  return messages.map((message: any) => {
    if (!message || typeof message !== "object") {
      return message;
    }

    if (message.role !== "assistant") {
      return message;
    }

    const content = message.content;
    if (!Array.isArray(content) || content.length === 0) {
      return message;
    }

    const firstBlock = content[0];
    if (!firstBlock || typeof firstBlock !== "object") {
      return message;
    }

    if (firstBlock.type === "thinking" || firstBlock.type === "redacted_thinking") {
      return message;
    }

    const syntheticThinking = {
      type: "redacted_thinking",
      data: "W0RDUF0=",
    };

    return {
      ...message,
      content: [syntheticThinking, ...content],
    };
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
  return messages.map((message: any) => {
    if (!message || typeof message !== "object") {
      return message;
    }

    if (Array.isArray((message as any).content)) {
      const isAssistantRole = (message as any).role === "assistant";
      const filteredContent = filterContentArray(
        (message as any).content,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel,
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
      thinkingTexts.push(part.text || "");
      return { ...part, type: "reasoning" };
    }

    // Handle Anthropic-style in candidates: type: "thinking"
    if (part.type === "thinking") {
      const thinkingText = part.thinking || part.text || "";
      thinkingTexts.push(thinkingText);
      return {
        ...part,
        type: "reasoning",
        text: thinkingText,
        thought: true,
      };
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
        transformedContent.push({
          ...block,
          type: "reasoning",
          text: thinkingText,
          thought: true,
        });
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
