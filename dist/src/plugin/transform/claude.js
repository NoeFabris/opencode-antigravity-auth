/**
 * Claude-specific Request Transformations
 *
 * Handles Claude model-specific request transformations including:
 * - Tool config (VALIDATED mode)
 * - Thinking config (snake_case keys)
 * - System instruction hints for interleaved thinking
 * - Tool normalization (functionDeclarations format)
 */
import { EMPTY_SCHEMA_PLACEHOLDER_NAME, EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION, } from "../../constants";
/** Claude thinking models need a sufficiently large max output token limit when thinking is enabled */
export const CLAUDE_THINKING_MAX_OUTPUT_TOKENS = 64_000;
/** Interleaved thinking hint appended to system instructions */
export const CLAUDE_INTERLEAVED_THINKING_HINT = "Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.";
/**
 * Check if a model is a Claude model.
 */
export function isClaudeModel(model) {
    return model.toLowerCase().includes("claude");
}
/**
 * Check if a model is a Claude thinking model.
 */
export function isClaudeThinkingModel(model) {
    const lower = model.toLowerCase();
    return lower.includes("claude") && lower.includes("thinking");
}
/**
 * Configure Claude tool calling to use VALIDATED mode.
 * This ensures proper tool call validation on the backend.
 */
export function configureClaudeToolConfig(payload) {
    if (!payload.toolConfig) {
        payload.toolConfig = {};
    }
    if (typeof payload.toolConfig === "object" && payload.toolConfig !== null) {
        const toolConfig = payload.toolConfig;
        if (!toolConfig.functionCallingConfig) {
            toolConfig.functionCallingConfig = {};
        }
        if (typeof toolConfig.functionCallingConfig === "object" && toolConfig.functionCallingConfig !== null) {
            toolConfig.functionCallingConfig.mode = "VALIDATED";
        }
    }
}
/**
 * Build Claude thinking config with snake_case keys.
 */
export function buildClaudeThinkingConfig(includeThoughts, thinkingBudget) {
    return {
        include_thoughts: includeThoughts,
        ...(typeof thinkingBudget === "number" && thinkingBudget > 0
            ? { thinking_budget: thinkingBudget }
            : {}),
    };
}
/**
 * Ensure maxOutputTokens is sufficient for Claude thinking models.
 * If thinking budget is set, max output must be larger than the budget.
 */
export function ensureClaudeMaxOutputTokens(generationConfig, thinkingBudget) {
    const currentMax = (generationConfig.maxOutputTokens ?? generationConfig.max_output_tokens);
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
export function appendClaudeThinkingHint(payload, hint = CLAUDE_INTERLEAVED_THINKING_HINT) {
    const existing = payload.systemInstruction;
    if (typeof existing === "string") {
        payload.systemInstruction = existing.trim().length > 0 ? `${existing}\n\n${hint}` : hint;
    }
    else if (existing && typeof existing === "object") {
        const sys = existing;
        const partsValue = sys.parts;
        if (Array.isArray(partsValue)) {
            const parts = partsValue;
            let appended = false;
            // Find the last text part and append to it
            for (let i = parts.length - 1; i >= 0; i--) {
                const part = parts[i];
                if (part && typeof part === "object") {
                    const partRecord = part;
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
        }
        else {
            sys.parts = [{ text: hint }];
        }
        payload.systemInstruction = sys;
    }
    else if (Array.isArray(payload.contents)) {
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
export function normalizeClaudeTools(payload, cleanJSONSchema) {
    let toolDebugMissing = 0;
    const toolDebugSummaries = [];
    if (!Array.isArray(payload.tools)) {
        return { toolDebugMissing, toolDebugSummaries };
    }
    const functionDeclarations = [];
    const passthroughTools = [];
    const normalizeSchema = (schema) => {
        const createPlaceholderSchema = (base = {}) => ({
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
        const hasProperties = cleaned.properties &&
            typeof cleaned.properties === "object" &&
            Object.keys(cleaned.properties).length > 0;
        cleaned.type = "object";
        if (!hasProperties) {
            cleaned.properties = {
                _placeholder: {
                    type: "boolean",
                    description: "Placeholder. Always pass true.",
                },
            };
            cleaned.required = Array.isArray(cleaned.required)
                ? Array.from(new Set([...cleaned.required, "_placeholder"]))
                : ["_placeholder"];
        }
        return cleaned;
    };
    payload.tools.forEach((tool) => {
        const t = tool;
        const pushDeclaration = (decl, source) => {
            const schema = decl?.parameters ||
                decl?.parametersJsonSchema ||
                decl?.input_schema ||
                decl?.inputSchema ||
                t.parameters ||
                t.parametersJsonSchema ||
                t.input_schema ||
                t.inputSchema ||
                t.function?.parameters ||
                t.function?.parametersJsonSchema ||
                t.function?.input_schema ||
                t.function?.inputSchema ||
                t.custom?.parameters ||
                t.custom?.parametersJsonSchema ||
                t.custom?.input_schema;
            let name = decl?.name ||
                t.name ||
                t.function?.name ||
                t.custom?.name ||
                `tool-${functionDeclarations.length}`;
            // Sanitize tool name: must be alphanumeric with underscores, no special chars
            name = String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
            const description = decl?.description ||
                t.description ||
                t.function?.description ||
                t.custom?.description ||
                "";
            functionDeclarations.push({
                name,
                description: String(description || ""),
                parameters: normalizeSchema(schema),
            });
            toolDebugSummaries.push(`decl=${name},src=${source},hasSchema=${schema ? "y" : "n"}`);
        };
        // Check for functionDeclarations array first
        if (Array.isArray(t.functionDeclarations) && t.functionDeclarations.length > 0) {
            t.functionDeclarations.forEach((decl) => pushDeclaration(decl, "functionDeclarations"));
            return;
        }
        // Fall back to function/custom style definitions
        if (t.function || t.custom || t.parameters || t.input_schema || t.inputSchema) {
            pushDeclaration(t.function ??
                t.custom ??
                t, "function/custom");
            return;
        }
        // Preserve any non-function tool entries (e.g., codeExecution) untouched
        passthroughTools.push(tool);
    });
    const finalTools = [];
    if (functionDeclarations.length > 0) {
        finalTools.push({ functionDeclarations });
    }
    payload.tools = finalTools.concat(passthroughTools);
    return { toolDebugMissing, toolDebugSummaries };
}
/**
 * Convert snake_case stop_sequences to camelCase stopSequences.
 */
export function convertStopSequences(generationConfig) {
    if (Array.isArray(generationConfig.stop_sequences)) {
        generationConfig.stopSequences = generationConfig.stop_sequences;
        delete generationConfig.stop_sequences;
    }
}
/**
 * Apply all Claude-specific transformations.
 */
export function applyClaudeTransforms(payload, options) {
    const { model, tierThinkingBudget, normalizedThinking, cleanJSONSchema } = options;
    const isThinking = isClaudeThinkingModel(model);
    // 1. Configure tool calling mode
    configureClaudeToolConfig(payload);
    if (payload.generationConfig) {
        convertStopSequences(payload.generationConfig);
    }
    // 2. Apply thinking config if needed
    if (normalizedThinking) {
        const thinkingBudget = tierThinkingBudget ?? normalizedThinking.thinkingBudget;
        if (isThinking) {
            const thinkingConfig = buildClaudeThinkingConfig(normalizedThinking.includeThoughts ?? true, thinkingBudget);
            const generationConfig = (payload.generationConfig ?? {});
            generationConfig.thinkingConfig = thinkingConfig;
            if (typeof thinkingBudget === "number" && thinkingBudget > 0) {
                ensureClaudeMaxOutputTokens(generationConfig, thinkingBudget);
            }
            payload.generationConfig = generationConfig;
        }
    }
    // 3. Append interleaved thinking hint for thinking models with tools
    if (isThinking && Array.isArray(payload.tools) && payload.tools.length > 0) {
        appendClaudeThinkingHint(payload);
    }
    // 4. Normalize tools
    return normalizeClaudeTools(payload, cleanJSONSchema);
}
//# sourceMappingURL=claude.js.map