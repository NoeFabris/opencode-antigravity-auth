/**
 * Claude-specific Request Transformations
 * 
 * Handles Claude model-specific request transformations including:
 * - Tool config (VALIDATED mode)
 * - Thinking config (snake_case keys)
 * - System instruction hints for interleaved thinking
 * - Tool normalization (functionDeclarations format)
 */

import type { RequestPayload, ThinkingConfig } from "./types";
import {
  EMPTY_SCHEMA_PLACEHOLDER_NAME,
  EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
} from "../../constants";

/** Claude thinking models need a sufficiently large max output token limit when thinking is enabled */
export const CLAUDE_THINKING_MAX_OUTPUT_TOKENS = 64_000;

/** Interleaved thinking hint appended to system instructions */
export const CLAUDE_INTERLEAVED_THINKING_HINT = 
  "Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.";

/**
 * Check if a model is a Claude model.
 */
export function isClaudeModel(model: string): boolean {
  return model.toLowerCase().includes("claude");
}

/**
 * Check if a model is a Claude thinking model.
 */
export function isClaudeThinkingModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("claude") && lower.includes("thinking");
}

/**
 * Configure Claude tool calling to use VALIDATED mode.
 * This ensures proper tool call validation on the backend.
 */
export function configureClaudeToolConfig(payload: RequestPayload): void {
  if (!payload.toolConfig) {
    payload.toolConfig = {};
  }
  
  if (typeof payload.toolConfig === "object" && payload.toolConfig !== null) {
    const toolConfig = payload.toolConfig as Record<string, unknown>;
    if (!toolConfig.functionCallingConfig) {
      toolConfig.functionCallingConfig = {};
    }
    if (typeof toolConfig.functionCallingConfig === "object" && toolConfig.functionCallingConfig !== null) {
      (toolConfig.functionCallingConfig as Record<string, unknown>).mode = "VALIDATED";
    }
  }
}

/**
 * Build Claude thinking config with snake_case keys.
 */
export function buildClaudeThinkingConfig(
  includeThoughts: boolean,
  thinkingBudget?: number,
): ThinkingConfig {
  return {
    include_thoughts: includeThoughts,
    ...(typeof thinkingBudget === "number" && thinkingBudget > 0
      ? { thinking_budget: thinkingBudget }
      : {}),
  } as unknown as ThinkingConfig;
}

/**
 * Ensure maxOutputTokens is sufficient for Claude thinking models.
 * If thinking budget is set, max output must be larger than the budget.
 */
export function ensureClaudeMaxOutputTokens(
  generationConfig: Record<string, unknown>,
  thinkingBudget: number,
): void {
  const currentMax = (generationConfig.maxOutputTokens ?? generationConfig.max_output_tokens) as number | undefined;
  
  if (!currentMax || currentMax <= thinkingBudget) {
    generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
    if (generationConfig.max_output_tokens !== undefined) {
      delete generationConfig.max_output_tokens;
    }
  }
}

/**
 * Append interleaved thinking hint to system instruction.
 * Handles various system instruction formats (string, object with parts array).
 */
export function appendClaudeThinkingHint(
  payload: RequestPayload,
  hint: string = CLAUDE_INTERLEAVED_THINKING_HINT,
): void {
  const existing = payload.systemInstruction;

  if (typeof existing === "string") {
    payload.systemInstruction = existing.trim().length > 0 ? `${existing}\n\n${hint}` : hint;
  } else if (existing && typeof existing === "object") {
    const sys = existing as Record<string, unknown>;
    const partsValue = sys.parts;

    if (Array.isArray(partsValue)) {
      const parts = partsValue as unknown[];
      let appended = false;

      // Find the last text part and append to it
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i];
        if (part && typeof part === "object") {
          const partRecord = part as Record<string, unknown>;
          const text = partRecord.text;
          if (typeof text === "string") {
            partRecord.text = `${text}\n\n${hint}`;
            appended = true;
            break;
          }
        }
      }

      if (!appended) {
        parts.push({ text: hint });
      }
    } else {
      sys.parts = [{ text: hint }];
    }

    payload.systemInstruction = sys;
  } else if (Array.isArray(payload.contents)) {
    // No existing system instruction, create one
    payload.systemInstruction = { parts: [{ text: hint }] };
  }
}

/**
 * Normalize tools for Claude models.
 * Converts various tool formats to functionDeclarations format.
 * 
 * @returns Debug info about tool normalization
 */
export function normalizeClaudeTools(
  payload: RequestPayload,
  cleanJSONSchema: (schema: unknown) => Record<string, unknown>,
): { toolDebugMissing: number; toolDebugSummaries: string[] } {
  let toolDebugMissing = 0;
  const toolDebugSummaries: string[] = [];

  if (!Array.isArray(payload.tools)) {
    return { toolDebugMissing, toolDebugSummaries };
  }

  const functionDeclarations: unknown[] = [];
  const passthroughTools: unknown[] = [];

  const normalizeSchema = (schema: unknown): Record<string, unknown> => {
    const createPlaceholderSchema = (base: Record<string, unknown> = {}): Record<string, unknown> => ({
      ...base,
      type: "object",
      properties: {
        [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
          type: "boolean",
          description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
        },
      },
      required: [EMPTY_SCHEMA_PLACEHOLDER_NAME],
    });

    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      toolDebugMissing += 1;
      return createPlaceholderSchema();
    }

    const cleaned = cleanJSONSchema(schema);

    if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
      toolDebugMissing += 1;
      return createPlaceholderSchema();
    }

    // Claude VALIDATED mode requires tool parameters to be an object schema
    // with at least one property.
    const hasProperties =
      cleaned.properties &&
      typeof cleaned.properties === "object" &&
      Object.keys(cleaned.properties as Record<string, unknown>).length > 0;

    cleaned.type = "object";

    if (!hasProperties) {
      cleaned.properties = {
        _placeholder: {
          type: "boolean",
          description: "Placeholder. Always pass true.",
        },
      };
      cleaned.required = Array.isArray(cleaned.required)
        ? Array.from(new Set([...(cleaned.required as string[]), "_placeholder"]))
        : ["_placeholder"];
    }

    return cleaned;
  };

  (payload.tools as unknown[]).forEach((tool: unknown) => {
    const t = tool as Record<string, unknown>;

    const pushDeclaration = (decl: Record<string, unknown> | undefined, source: string): void => {
      const schema =
        decl?.parameters ||
        decl?.parametersJsonSchema ||
        decl?.input_schema ||
        decl?.inputSchema ||
        t.parameters ||
        t.parametersJsonSchema ||
        t.input_schema ||
        t.inputSchema ||
        (t.function as Record<string, unknown> | undefined)?.parameters ||
        (t.function as Record<string, unknown> | undefined)?.parametersJsonSchema ||
        (t.function as Record<string, unknown> | undefined)?.input_schema ||
        (t.function as Record<string, unknown> | undefined)?.inputSchema ||
        (t.custom as Record<string, unknown> | undefined)?.parameters ||
        (t.custom as Record<string, unknown> | undefined)?.parametersJsonSchema ||
        (t.custom as Record<string, unknown> | undefined)?.input_schema;

      let name =
        decl?.name ||
        t.name ||
        (t.function as Record<string, unknown> | undefined)?.name ||
        (t.custom as Record<string, unknown> | undefined)?.name ||
        `tool-${functionDeclarations.length}`;

      // Sanitize tool name: must be alphanumeric with underscores, no special chars
      name = String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

      const description =
        decl?.description ||
        t.description ||
        (t.function as Record<string, unknown> | undefined)?.description ||
        (t.custom as Record<string, unknown> | undefined)?.description ||
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

    // Check for functionDeclarations array first
    if (Array.isArray(t.functionDeclarations) && (t.functionDeclarations as unknown[]).length > 0) {
      (t.functionDeclarations as Record<string, unknown>[]).forEach((decl) => 
        pushDeclaration(decl, "functionDeclarations")
      );
      return;
    }

    // Fall back to function/custom style definitions
    if (t.function || t.custom || t.parameters || t.input_schema || t.inputSchema) {
      pushDeclaration(
        (t.function as Record<string, unknown> | undefined) ?? 
        (t.custom as Record<string, unknown> | undefined) ?? 
        t,
        "function/custom"
      );
      return;
    }

    // Preserve any non-function tool entries (e.g., codeExecution) untouched
    passthroughTools.push(tool);
  });

  const finalTools: unknown[] = [];
  if (functionDeclarations.length > 0) {
    finalTools.push({ functionDeclarations });
  }
  payload.tools = finalTools.concat(passthroughTools);

  return { toolDebugMissing, toolDebugSummaries };
}

/**
 * Convert snake_case stop_sequences to camelCase stopSequences.
 */
export function convertStopSequences(
  generationConfig: Record<string, unknown>,
): void {
  if (Array.isArray(generationConfig.stop_sequences)) {
    generationConfig.stopSequences = generationConfig.stop_sequences;
    delete generationConfig.stop_sequences;
  }
}

/**
 * Apply all Claude-specific transformations to a request payload.
 */
export interface ClaudeTransformOptions {
  /** The effective model name (resolved) */
  model: string;
  /** Tier-based thinking budget (from model suffix) */
  tierThinkingBudget?: number;
  /** Normalized thinking config from user settings */
  normalizedThinking?: { includeThoughts?: boolean; thinkingBudget?: number };
  /** Function to clean JSON schema for Antigravity */
  cleanJSONSchema: (schema: unknown) => Record<string, unknown>;
}

export interface ClaudeTransformResult {
  toolDebugMissing: number;
  toolDebugSummaries: string[];
}

/**
 * Apply all Claude-specific transformations.
 */
export function applyClaudeTransforms(
  payload: RequestPayload,
  options: ClaudeTransformOptions,
): ClaudeTransformResult {
  const { model, tierThinkingBudget, normalizedThinking, cleanJSONSchema } = options;
  const isThinking = isClaudeThinkingModel(model);

  // 1. Configure tool calling mode
  configureClaudeToolConfig(payload);

  if (payload.generationConfig) {
    convertStopSequences(payload.generationConfig as Record<string, unknown>);
  }

  // 2. Apply thinking config if needed
  if (normalizedThinking) {
    const thinkingBudget = tierThinkingBudget ?? normalizedThinking.thinkingBudget;
    
    if (isThinking) {
      const thinkingConfig = buildClaudeThinkingConfig(
        normalizedThinking.includeThoughts ?? true,
        thinkingBudget,
      );

      const generationConfig = (payload.generationConfig ?? {}) as Record<string, unknown>;
      generationConfig.thinkingConfig = thinkingConfig;

      if (typeof thinkingBudget === "number" && thinkingBudget > 0) {
        ensureClaudeMaxOutputTokens(generationConfig, thinkingBudget);
      }

      payload.generationConfig = generationConfig;
    }
  }

  // 3. Append interleaved thinking hint for thinking models with tools
  if (isThinking && Array.isArray(payload.tools) && (payload.tools as unknown[]).length > 0) {
    appendClaudeThinkingHint(payload);
  }

  // 4. Normalize tools
  return normalizeClaudeTools(payload, cleanJSONSchema);
}
