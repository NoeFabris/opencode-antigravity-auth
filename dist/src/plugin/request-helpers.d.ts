/**
 * Cleans a JSON schema for Antigravity API compatibility.
 * Transforms unsupported features into description hints while preserving semantic information.
 *
 * Ported from CLIProxyAPI's CleanJSONSchemaForAntigravity (gemini_schema.go)
 */
export declare function cleanJSONSchemaForAntigravity(schema: any): any;
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
export declare const DEFAULT_THINKING_BUDGET = 16000;
/**
 * Checks if a model name indicates thinking/reasoning capability.
 * Models with "thinking", "gemini-3", or "opus" in their name support extended thinking.
 */
export declare function isThinkingCapableModel(modelName: string): boolean;
/**
 * Extracts thinking configuration from various possible request locations.
 * Supports both Gemini-style thinkingConfig and Anthropic-style thinking options.
 */
export declare function extractThinkingConfig(requestPayload: Record<string, unknown>, rawGenerationConfig: Record<string, unknown> | undefined, extraBody: Record<string, unknown> | undefined): ThinkingConfig | undefined;
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
}
/**
 * Extracts variant thinking config from OpenCode's providerOptions.
 *
 * All Antigravity models route through the Google provider, so we only check
 * providerOptions.google. Supports two formats:
 *
 * 1. Gemini 3 native: { google: { thinkingLevel: "high", includeThoughts: true } }
 * 2. Budget-based (Claude/Gemini 2.5): { google: { thinkingConfig: { thinkingBudget: 32000 } } }
 */
export declare function extractVariantThinkingConfig(providerOptions: Record<string, unknown> | undefined): VariantThinkingConfig | undefined;
/**
 * Determines the final thinking configuration based on model capabilities and user settings.
 * For Claude thinking models, we keep thinking enabled even in multi-turn conversations.
 * The filterUnsignedThinkingBlocks function will handle signature validation/restoration.
 */
export declare function resolveThinkingConfig(userConfig: ThinkingConfig | undefined, isThinkingModel: boolean, _isClaudeModel: boolean, _hasAssistantHistory: boolean): ThinkingConfig | undefined;
/**
 * Filters thinking blocks from contents unless the signature matches our cache.
 * Attempts to restore signatures from cache for thinking blocks that lack signatures.
 *
 * @param contents - The contents array from the request
 * @param sessionId - Optional session ID for signature cache lookup
 * @param getCachedSignatureFn - Optional function to retrieve cached signatures
 */
export declare function filterUnsignedThinkingBlocks(contents: any[], sessionId?: string, getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined, isClaudeModel?: boolean): any[];
/**
 * Filters thinking blocks from Anthropic-style messages[] payloads using cached signatures.
 */
export declare function filterMessagesThinkingBlocks(messages: any[], sessionId?: string, getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined, isClaudeModel?: boolean): any[];
export declare function deepFilterThinkingBlocks(payload: unknown, sessionId?: string, getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined, isClaudeModel?: boolean): unknown;
/**
 * Transforms thinking/reasoning content in response parts to OpenCode's expected format.
 * Handles both Gemini-style (thought: true) and Anthropic-style (type: "thinking") formats.
 * Also extracts reasoning_content for Anthropic-style responses.
 */
export declare function transformThinkingParts(response: unknown): unknown;
/**
 * Ensures thinkingConfig is valid: includeThoughts only allowed when budget > 0.
 */
export declare function normalizeThinkingConfig(config: unknown): ThinkingConfig | undefined;
/**
 * Parses an Antigravity API body; handles array-wrapped responses the API sometimes returns.
 */
export declare function parseAntigravityApiBody(rawText: string): AntigravityApiBody | null;
/**
 * Extracts usageMetadata from a response object, guarding types.
 */
export declare function extractUsageMetadata(body: AntigravityApiBody): AntigravityUsageMetadata | null;
/**
 * Walks SSE lines to find a usage-bearing response chunk.
 */
export declare function extractUsageFromSsePayload(payload: string): AntigravityUsageMetadata | null;
/**
 * Enhances 404 errors for Antigravity models with a direct preview-access message.
 */
export declare function rewriteAntigravityPreviewAccessError(body: AntigravityApiBody, status: number, requestedModel?: string): AntigravityApiBody | null;
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
export declare function isEmptyResponseBody(text: string): boolean;
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
export declare function createStreamingChunkCounter(): StreamingChunkCounter;
/**
 * Checks if an SSE line contains meaningful content.
 *
 * @param line - A single SSE line (e.g., "data: {...}")
 * @returns true if the line contains content worth counting
 */
export declare function isMeaningfulSseLine(line: string): boolean;
export declare function recursivelyParseJsonStrings(obj: unknown, skipParseKeys?: Set<string>, currentKey?: string): unknown;
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
export declare function fixToolResponseGrouping(contents: any[]): any[];
/**
 * Checks if contents have any tool call/response ID mismatches.
 *
 * @param contents - Array of Gemini-style content messages
 * @returns Object with mismatch details
 */
export declare function detectToolIdMismatches(contents: any[]): {
    hasMismatches: boolean;
    expectedIds: string[];
    foundIds: string[];
    missingIds: string[];
    orphanIds: string[];
};
/**
 * Find orphaned tool_use IDs (tool_use without matching tool_result).
 * Works on Claude format messages.
 */
export declare function findOrphanedToolUseIds(messages: any[]): Set<string>;
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
export declare function fixClaudeToolPairing(messages: any[]): any[];
/**
 * Validate and fix tool pairing with fallback nuclear option.
 * Defense in depth: tries gentle fix first, then nuclear removal.
 */
export declare function validateAndFixClaudeToolPairing(messages: any[]): any[];
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
export declare function injectParameterSignatures(tools: any[], promptTemplate?: string): any[];
/**
 * Injects a tool hardening system instruction into the request payload.
 * Port of LLM-API-Key-Proxy's _inject_tool_hardening_instruction()
 *
 * @param payload - The Gemini request payload
 * @param instructionText - The instruction text to inject
 */
export declare function injectToolHardeningInstruction(payload: Record<string, unknown>, instructionText: string): void;
/**
 * Assigns IDs to functionCall parts and returns the pending call IDs by name.
 * This is the first pass of tool ID assignment.
 *
 * @param contents - Gemini-style contents array
 * @returns Object with modified contents and pending call IDs map
 */
export declare function assignToolIdsToContents(contents: any[]): {
    contents: any[];
    pendingCallIdsByName: Map<string, string[]>;
    toolCallCounter: number;
};
/**
 * Matches functionResponse IDs to their corresponding functionCall IDs.
 * This is the second pass of tool ID assignment.
 *
 * @param contents - Gemini-style contents array
 * @param pendingCallIdsByName - Map of function names to pending call IDs
 * @returns Modified contents with matched response IDs
 */
export declare function matchResponseIdsToContents(contents: any[], pendingCallIdsByName: Map<string, string[]>): any[];
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
export declare function applyToolPairingFixes(payload: Record<string, unknown>, isClaude: boolean): {
    contentsFixed: boolean;
    messagesFixed: boolean;
};
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
export declare function createSyntheticErrorResponse(errorMessage: string, requestedModel?: string): Response;
//# sourceMappingURL=request-helpers.d.ts.map