/**
 * Session recovery hook for handling recoverable errors.
 *
 * Supports:
 * - tool_result_missing: When ESC is pressed during tool execution
 * - thinking_block_order: When thinking blocks are corrupted/stripped
 * - thinking_disabled_violation: Thinking in non-thinking model
 *
 * Based on oh-my-opencode/src/hooks/session-recovery/index.ts
 */
import type { AntigravityConfig } from "./config";
import type { PluginClient } from "./types";
import type { MessageInfo, RecoveryErrorType } from "./recovery/types";
/**
 * Detect the type of recoverable error from an error object.
 */
export declare function detectErrorType(error: unknown): RecoveryErrorType;
/**
 * Check if an error is recoverable.
 */
export declare function isRecoverableError(error: unknown): boolean;
export declare function getRecoveryToastContent(errorType: RecoveryErrorType): {
    title: string;
    message: string;
};
export declare function getRecoverySuccessToast(): {
    title: string;
    message: string;
};
export declare function getRecoveryFailureToast(): {
    title: string;
    message: string;
};
export interface SessionRecoveryHook {
    /**
     * Main recovery handler. Performs the actual fix.
     * Returns true if recovery was successful.
     */
    handleSessionRecovery: (info: MessageInfo) => Promise<boolean>;
    /**
     * Check if the error is recoverable.
     */
    isRecoverableError: (error: unknown) => boolean;
    /**
     * Callback for when a session is being aborted for recovery.
     */
    setOnAbortCallback: (callback: (sessionID: string) => void) => void;
    /**
     * Callback for when recovery is complete (success or failure).
     */
    setOnRecoveryCompleteCallback: (callback: (sessionID: string) => void) => void;
}
export interface SessionRecoveryContext {
    client: PluginClient;
    directory: string;
}
/**
 * Create a session recovery hook with the given configuration.
 */
export declare function createSessionRecoveryHook(ctx: SessionRecoveryContext, config: AntigravityConfig): SessionRecoveryHook | null;
//# sourceMappingURL=recovery.d.ts.map