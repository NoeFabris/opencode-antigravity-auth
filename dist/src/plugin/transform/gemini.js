/**
 * Gemini-specific Request Transformations
 *
 * Handles Gemini model-specific request transformations including:
 * - Thinking config (camelCase keys, thinkingLevel for Gemini 3)
 * - Tool normalization (function/custom format)
 */
/**
 * Check if a model is a Gemini model (not Claude).
 */
export function isGeminiModel(model) {
    const lower = model.toLowerCase();
    return lower.includes("gemini") && !lower.includes("claude");
}
/**
 * Check if a model is Gemini 3 (uses thinkingLevel string).
 */
export function isGemini3Model(model) {
    return model.toLowerCase().includes("gemini-3");
}
/**
 * Check if a model is Gemini 2.5 (uses numeric thinkingBudget).
 */
export function isGemini25Model(model) {
    return model.toLowerCase().includes("gemini-2.5");
}
/**
 * Build Gemini 3 thinking config with thinkingLevel string.
 */
export function buildGemini3ThinkingConfig(includeThoughts, thinkingLevel) {
    return {
        includeThoughts,
        thinkingLevel,
    };
}
/**
 * Build Gemini 2.5 thinking config with numeric thinkingBudget.
 */
export function buildGemini25ThinkingConfig(includeThoughts, thinkingBudget) {
    return {
        includeThoughts,
        ...(typeof thinkingBudget === "number" && thinkingBudget > 0 ? { thinkingBudget } : {}),
    };
}
/**
 * Normalize tools for Gemini models.
 * Ensures tools have proper function-style format.
 *
 * @returns Debug info about tool normalization
 */
export function normalizeGeminiTools(payload) {
    let toolDebugMissing = 0;
    const toolDebugSummaries = [];
    if (!Array.isArray(payload.tools)) {
        return { toolDebugMissing, toolDebugSummaries };
    }
    payload.tools = payload.tools.map((tool, toolIndex) => {
        const t = tool;
        const newTool = { ...t };
        const schemaCandidates = [
            newTool.function?.input_schema,
            newTool.function?.parameters,
            newTool.function?.inputSchema,
            newTool.custom?.input_schema,
            newTool.custom?.parameters,
            newTool.parameters,
            newTool.input_schema,
            newTool.inputSchema,
        ].filter(Boolean);
        const placeholderSchema = {
            type: "object",
            properties: {
                _placeholder: {
                    type: "boolean",
                    description: "Placeholder. Always pass true.",
                },
            },
            required: ["_placeholder"],
            additionalProperties: false,
        };
        let schema = schemaCandidates[0];
        const schemaObjectOk = schema && typeof schema === "object" && !Array.isArray(schema);
        if (!schemaObjectOk) {
            schema = placeholderSchema;
            toolDebugMissing += 1;
        }
        const nameCandidate = newTool.name ||
            newTool.function?.name ||
            newTool.custom?.name ||
            `tool-${toolIndex}`;
        // Ensure function has input_schema
        if (newTool.function && !newTool.function.input_schema && schema) {
            newTool.function.input_schema = schema;
        }
        // Ensure custom has input_schema
        if (newTool.custom && !newTool.custom.input_schema && schema) {
            newTool.custom.input_schema = schema;
        }
        // Create custom from function if missing
        if (!newTool.custom && newTool.function) {
            const fn = newTool.function;
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
        // Ensure custom has input_schema
        if (newTool.custom && !newTool.custom.input_schema) {
            newTool.custom.input_schema = {
                type: "object",
                properties: {},
                additionalProperties: false
            };
            toolDebugMissing += 1;
        }
        toolDebugSummaries.push(`idx=${toolIndex}, hasCustom=${!!newTool.custom}, customSchema=${!!newTool.custom?.input_schema}, hasFunction=${!!newTool.function}, functionSchema=${!!newTool.function?.input_schema}`);
        // Strip custom wrappers for Gemini; only function-style is accepted.
        if (newTool.custom) {
            delete newTool.custom;
        }
        return newTool;
    });
    return { toolDebugMissing, toolDebugSummaries };
}
/**
 * Apply all Gemini-specific transformations.
 */
export function applyGeminiTransforms(payload, options) {
    const { model, tierThinkingBudget, tierThinkingLevel, normalizedThinking } = options;
    // 1. Apply thinking config if needed
    if (normalizedThinking) {
        let thinkingConfig;
        if (tierThinkingLevel && isGemini3Model(model)) {
            // Gemini 3 uses thinkingLevel string
            thinkingConfig = buildGemini3ThinkingConfig(normalizedThinking.includeThoughts ?? true, tierThinkingLevel);
        }
        else {
            // Gemini 2.5 and others use numeric budget
            const thinkingBudget = tierThinkingBudget ?? normalizedThinking.thinkingBudget;
            thinkingConfig = buildGemini25ThinkingConfig(normalizedThinking.includeThoughts ?? true, thinkingBudget);
        }
        const generationConfig = (payload.generationConfig ?? {});
        generationConfig.thinkingConfig = thinkingConfig;
        payload.generationConfig = generationConfig;
    }
    // 2. Normalize tools
    return normalizeGeminiTools(payload);
}
//# sourceMappingURL=gemini.js.map