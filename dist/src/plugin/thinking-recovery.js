/**
 * Thinking Recovery Module
 *
 * Minimal implementation for recovering from corrupted thinking state.
 * When Claude's conversation history gets corrupted (thinking blocks stripped/malformed),
 * this module provides a "last resort" recovery by closing the current turn and starting fresh.
 *
 * Philosophy: "Let it crash and start again" - Instead of trying to fix corrupted state,
 * we abandon the corrupted turn and let Claude generate fresh thinking.
 */
// ============================================================================
// DETECTION HELPERS
// ============================================================================
/**
 * Checks if a message part is a thinking/reasoning block.
 */
function isThinkingPart(part) {
    if (!part || typeof part !== "object")
        return false;
    return (part.thought === true ||
        part.type === "thinking" ||
        part.type === "redacted_thinking");
}
/**
 * Checks if a message part is a function response (tool result).
 */
function isFunctionResponsePart(part) {
    return part && typeof part === "object" && "functionResponse" in part;
}
/**
 * Checks if a message part is a function call.
 */
function isFunctionCallPart(part) {
    return part && typeof part === "object" && "functionCall" in part;
}
/**
 * Checks if a message is a tool result container (user role with functionResponse).
 */
function isToolResultMessage(msg) {
    if (!msg || msg.role !== "user")
        return false;
    const parts = msg.parts || [];
    return parts.some(isFunctionResponsePart);
}
/**
 * Checks if a message contains thinking/reasoning content.
 */
function messageHasThinking(msg) {
    if (!msg || typeof msg !== "object")
        return false;
    // Gemini format: parts array
    if (Array.isArray(msg.parts)) {
        return msg.parts.some(isThinkingPart);
    }
    // Anthropic format: content array
    if (Array.isArray(msg.content)) {
        return msg.content.some((block) => block?.type === "thinking" || block?.type === "redacted_thinking");
    }
    return false;
}
/**
 * Checks if a message contains tool calls.
 */
function messageHasToolCalls(msg) {
    if (!msg || typeof msg !== "object")
        return false;
    // Gemini format: parts array with functionCall
    if (Array.isArray(msg.parts)) {
        return msg.parts.some(isFunctionCallPart);
    }
    // Anthropic format: content array with tool_use
    if (Array.isArray(msg.content)) {
        return msg.content.some((block) => block?.type === "tool_use");
    }
    return false;
}
// ============================================================================
// CONVERSATION STATE ANALYSIS
// ============================================================================
/**
 * Analyzes conversation state to detect tool use loops and thinking mode issues.
 *
 * Key insight: A "turn" can span multiple assistant messages in a tool-use loop.
 * We need to find the TURN START (first assistant message after last real user message)
 * and check if THAT message had thinking, not just the last assistant message.
 */
export function analyzeConversationState(contents) {
    const state = {
        inToolLoop: false,
        turnStartIdx: -1,
        turnHasThinking: false,
        lastModelIdx: -1,
        lastModelHasThinking: false,
        lastModelHasToolCalls: false,
    };
    if (!Array.isArray(contents) || contents.length === 0) {
        return state;
    }
    // First pass: Find the last "real" user message (not a tool result)
    let lastRealUserIdx = -1;
    for (let i = 0; i < contents.length; i++) {
        const msg = contents[i];
        if (msg?.role === "user" && !isToolResultMessage(msg)) {
            lastRealUserIdx = i;
        }
    }
    // Second pass: Analyze conversation and find turn boundaries
    for (let i = 0; i < contents.length; i++) {
        const msg = contents[i];
        const role = msg?.role;
        if (role === "model" || role === "assistant") {
            const hasThinking = messageHasThinking(msg);
            const hasToolCalls = messageHasToolCalls(msg);
            // Track if this is the turn start
            if (i > lastRealUserIdx && state.turnStartIdx === -1) {
                state.turnStartIdx = i;
                state.turnHasThinking = hasThinking;
            }
            state.lastModelIdx = i;
            state.lastModelHasToolCalls = hasToolCalls;
            state.lastModelHasThinking = hasThinking;
        }
    }
    // Determine if we're in a tool loop
    // We're in a tool loop if the conversation ends with a tool result
    if (contents.length > 0) {
        const lastMsg = contents[contents.length - 1];
        if (lastMsg?.role === "user" && isToolResultMessage(lastMsg)) {
            state.inToolLoop = true;
        }
    }
    return state;
}
// ============================================================================
// RECOVERY FUNCTIONS
// ============================================================================
/**
 * Strips all thinking blocks from messages.
 * Used before injecting synthetic messages to avoid invalid thinking patterns.
 */
function stripAllThinkingBlocks(contents) {
    return contents.map((content) => {
        if (!content || typeof content !== "object")
            return content;
        // Handle Gemini-style parts
        if (Array.isArray(content.parts)) {
            const filteredParts = content.parts.filter((part) => !isThinkingPart(part));
            // Keep at least one part to avoid empty messages
            if (filteredParts.length === 0 && content.parts.length > 0) {
                return content;
            }
            return { ...content, parts: filteredParts };
        }
        // Handle Anthropic-style content
        if (Array.isArray(content.content)) {
            const filteredContent = content.content.filter((block) => block?.type !== "thinking" && block?.type !== "redacted_thinking");
            if (filteredContent.length === 0 && content.content.length > 0) {
                return content;
            }
            return { ...content, content: filteredContent };
        }
        return content;
    });
}
/**
 * Counts tool results at the end of the conversation.
 */
function countTrailingToolResults(contents) {
    let count = 0;
    for (let i = contents.length - 1; i >= 0; i--) {
        const msg = contents[i];
        if (msg?.role === "user") {
            const parts = msg.parts || [];
            const functionResponses = parts.filter(isFunctionResponsePart);
            if (functionResponses.length > 0) {
                count += functionResponses.length;
            }
            else {
                break; // Real user message, stop counting
            }
        }
        else if (msg?.role === "model" || msg?.role === "assistant") {
            break; // Stop at the model that made the tool calls
        }
    }
    return count;
}
/**
 * Closes an incomplete tool loop by injecting synthetic messages to start a new turn.
 *
 * This is the "let it crash and start again" recovery mechanism.
 *
 * When we detect:
 * - We're in a tool loop (conversation ends with functionResponse)
 * - The tool call was made WITHOUT thinking (thinking was stripped/corrupted)
 * - We NOW want to enable thinking
 *
 * Instead of trying to fix the corrupted state, we:
 * 1. Strip ALL thinking blocks (removes any corrupted ones)
 * 2. Add synthetic MODEL message to complete the non-thinking turn
 * 3. Add synthetic USER message to start a NEW turn
 *
 * This allows Claude to generate fresh thinking for the new turn.
 */
export function closeToolLoopForThinking(contents) {
    // Strip any old/corrupted thinking first
    const strippedContents = stripAllThinkingBlocks(contents);
    // Count tool results from the end of the conversation
    const toolResultCount = countTrailingToolResults(strippedContents);
    // Build synthetic model message content based on tool count
    let syntheticModelContent;
    if (toolResultCount === 0) {
        syntheticModelContent = "[Processing previous context.]";
    }
    else if (toolResultCount === 1) {
        syntheticModelContent = "[Tool execution completed.]";
    }
    else {
        syntheticModelContent = `[${toolResultCount} tool executions completed.]`;
    }
    // Step 1: Inject synthetic MODEL message to complete the non-thinking turn
    const syntheticModel = {
        role: "model",
        parts: [{ text: syntheticModelContent }],
    };
    // Step 2: Inject synthetic USER message to start a NEW turn
    const syntheticUser = {
        role: "user",
        parts: [{ text: "[Continue]" }],
    };
    return [...strippedContents, syntheticModel, syntheticUser];
}
/**
 * Checks if conversation state requires tool loop closure for thinking recovery.
 *
 * Returns true if:
 * - We're in a tool loop (state.inToolLoop)
 * - The turn didn't start with thinking (state.turnHasThinking === false)
 *
 * This is the trigger for the "let it crash and start again" recovery.
 */
export function needsThinkingRecovery(state) {
    return state.inToolLoop && !state.turnHasThinking;
}
// ============================================================================
// COMPACTED THINKING TURN DETECTION (Ported from LLM-API-Key-Proxy)
// ============================================================================
/**
 * Detects if a message looks like it was compacted from a thinking-enabled turn.
 *
 * This is a heuristic to distinguish between:
 * - "Never had thinking" (model didn't use thinking mode)
 * - "Thinking was stripped" (context compaction removed thinking blocks)
 *
 * Port of LLM-API-Key-Proxy's _looks_like_compacted_thinking_turn()
 *
 * Heuristics:
 * 1. Has functionCall parts (typical thinking flow produces tool calls)
 * 2. No thinking parts (thought: true)
 * 3. No text content before functionCall (thinking responses usually have text)
 *
 * @param msg - A single message from the conversation
 * @returns true if the message looks like thinking was stripped
 */
export function looksLikeCompactedThinkingTurn(msg) {
    if (!msg || typeof msg !== "object")
        return false;
    const parts = msg.parts || [];
    if (parts.length === 0)
        return false;
    // Check if message has function calls
    const hasFunctionCall = parts.some((p) => p && typeof p === "object" && p.functionCall);
    if (!hasFunctionCall)
        return false;
    // Check for thinking blocks
    const hasThinking = parts.some((p) => p &&
        typeof p === "object" &&
        (p.thought === true || p.type === "thinking" || p.type === "redacted_thinking"));
    if (hasThinking)
        return false;
    // Check for text content (not thinking)
    const hasTextBeforeFunctionCall = parts.some((p, idx) => {
        if (!p || typeof p !== "object")
            return false;
        // Only check parts before the first functionCall
        const firstFuncIdx = parts.findIndex((fp) => fp && typeof fp === "object" && fp.functionCall);
        if (idx >= firstFuncIdx)
            return false;
        // Check for non-thinking text
        return ("text" in p &&
            typeof p.text === "string" &&
            p.text.trim().length > 0 &&
            !p.thought);
    });
    // If we have functionCall but no text before it, likely compacted
    return !hasTextBeforeFunctionCall;
}
/**
 * Checks if any message in the current turn looks like it was compacted.
 *
 * @param contents - Full conversation contents
 * @param turnStartIdx - Index of the first model message in current turn
 * @returns true if any model message in the turn looks compacted
 */
export function hasPossibleCompactedThinking(contents, turnStartIdx) {
    if (!Array.isArray(contents) || turnStartIdx < 0)
        return false;
    for (let i = turnStartIdx; i < contents.length; i++) {
        const msg = contents[i];
        if (msg?.role === "model" && looksLikeCompactedThinkingTurn(msg)) {
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=thinking-recovery.js.map