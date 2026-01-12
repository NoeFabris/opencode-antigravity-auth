/**
 * Types for session recovery.
 *
 * Based on oh-my-opencode/src/hooks/session-recovery/types.ts
 */
export type ThinkingPartType = "thinking" | "redacted_thinking" | "reasoning";
export type MetaPartType = "step-start" | "step-finish";
export type ContentPartType = "text" | "tool" | "tool_use" | "tool_result";
export interface StoredMessageMeta {
    id: string;
    sessionID: string;
    role: "user" | "assistant";
    parentID?: string;
    time?: {
        created: number;
        completed?: number;
    };
    error?: unknown;
}
export interface StoredTextPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: "text";
    text: string;
    synthetic?: boolean;
    ignored?: boolean;
}
export interface StoredToolPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: "tool";
    callID: string;
    tool: string;
    state: {
        status: "pending" | "running" | "completed" | "error";
        input: Record<string, unknown>;
        output?: string;
        error?: string;
    };
}
export interface StoredReasoningPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: "reasoning";
    text: string;
}
export interface StoredStepPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: "step-start" | "step-finish";
}
export type StoredPart = StoredTextPart | StoredToolPart | StoredReasoningPart | StoredStepPart | {
    id: string;
    sessionID: string;
    messageID: string;
    type: string;
    [key: string]: unknown;
};
export interface MessagePart {
    type: string;
    id?: string;
    text?: string;
    thinking?: string;
    name?: string;
    input?: Record<string, unknown>;
    callID?: string;
}
export interface MessageData {
    info?: {
        id?: string;
        role?: string;
        sessionID?: string;
        parentID?: string;
        error?: unknown;
        agent?: string;
        model?: {
            providerID: string;
            modelID: string;
        };
        system?: string;
        tools?: Record<string, boolean>;
    };
    parts?: MessagePart[];
}
export interface MessageInfo {
    id?: string;
    role?: string;
    sessionID?: string;
    parentID?: string;
    error?: unknown;
}
export interface ResumeConfig {
    sessionID: string;
    agent?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
}
export type RecoveryErrorType = "tool_result_missing" | "thinking_block_order" | "thinking_disabled_violation" | null;
export interface ToolUsePart {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
}
export interface ToolResultPart {
    type: "tool_result";
    tool_use_id: string;
    content: string;
}
//# sourceMappingURL=types.d.ts.map