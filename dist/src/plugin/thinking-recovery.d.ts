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
/**
 * Conversation state for thinking mode analysis
 */
export interface ConversationState {
    /** True if we're in an incomplete tool use loop (ends with functionResponse) */
    inToolLoop: boolean;
    /** Index of first model message in current turn */
    turnStartIdx: number;
    /** Whether the TURN started with thinking */
    turnHasThinking: boolean;
    /** Index of last model message */
    lastModelIdx: number;
    /** Whether last model msg has thinking */
    lastModelHasThinking: boolean;
    /** Whether last model msg has tool calls */
    lastModelHasToolCalls: boolean;
}
/**
 * Analyzes conversation state to detect tool use loops and thinking mode issues.
 *
 * Key insight: A "turn" can span multiple assistant messages in a tool-use loop.
 * We need to find the TURN START (first assistant message after last real user message)
 * and check if THAT message had thinking, not just the last assistant message.
 */
export declare function analyzeConversationState(contents: any[]): ConversationState;
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
export declare function closeToolLoopForThinking(contents: any[]): any[];
/**
 * Checks if conversation state requires tool loop closure for thinking recovery.
 *
 * Returns true if:
 * - We're in a tool loop (state.inToolLoop)
 * - The turn didn't start with thinking (state.turnHasThinking === false)
 *
 * This is the trigger for the "let it crash and start again" recovery.
 */
export declare function needsThinkingRecovery(state: ConversationState): boolean;
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
export declare function looksLikeCompactedThinkingTurn(msg: any): boolean;
/**
 * Checks if any message in the current turn looks like it was compacted.
 *
 * @param contents - Full conversation contents
 * @param turnStartIdx - Index of the first model message in current turn
 * @returns true if any model message in the turn looks compacted
 */
export declare function hasPossibleCompactedThinking(contents: any[], turnStartIdx: number): boolean;
//# sourceMappingURL=thinking-recovery.d.ts.map