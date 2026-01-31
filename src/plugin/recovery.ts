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
import { createLogger } from "./logger";
import { logToast } from "./debug";
import type { PluginClient } from "./types";
import {
  readParts,
  findMessagesWithThinkingBlocks,
  findMessagesWithOrphanThinking,
  findMessageByIndexNeedingThinking,
  prependThinkingPart,
  stripThinkingParts,
} from "./recovery/storage";
import type {
  MessageInfo,
  MessageData,
  MessagePart,
  RecoveryErrorType,
  ResumeConfig,
} from "./recovery/types";

// =============================================================================
// Constants
// =============================================================================

const RECOVERY_RESUME_TEXT = "[session recovered - continuing previous task]";

// =============================================================================
// Error Detection
// =============================================================================

/**
 * Extract a normalized error message string from an unknown error.
 */
function getErrorMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error.toLowerCase();

  const errorObj = error as Record<string, unknown>;
  const paths = [
    errorObj.data,
    errorObj.error,
    errorObj,
    (errorObj.data as Record<string, unknown>)?.error,
  ];

  for (const obj of paths) {
    if (obj && typeof obj === "object") {
      const msg = (obj as Record<string, unknown>).message;
      if (typeof msg === "string" && msg.length > 0) {
        return msg.toLowerCase();
      }
    }
  }

  try {
    return JSON.stringify(error).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Extract the message index from an error message (e.g., "messages.79").
 */
function extractMessageIndex(error: unknown): number | null {
  const message = getErrorMessage(error);
  const match = message.match(/messages\.(\d+)/);
  if (!match || !match[1]) return null;
  return parseInt(match[1], 10);
}

/**
 * Detect the type of recoverable error from an error object.
 */
export function detectErrorType(error: unknown): RecoveryErrorType {
  const message = getErrorMessage(error);

  // tool_result_missing: Happens when ESC is pressed during tool execution
  if (message.includes("tool_use") && message.includes("tool_result")) {
    return "tool_result_missing";
  }

  // thinking_block_order: Happens when thinking blocks are corrupted
  if (
    message.includes("thinking") &&
    (message.includes("first block") ||
      message.includes("must start with") ||
      message.includes("preceeding") ||
      (message.includes("expected") && message.includes("found")))
  ) {
    return "thinking_block_order";
  }

  // thinking_disabled_violation: Thinking in non-thinking model
  if (message.includes("thinking is disabled") && message.includes("cannot contain")) {
    return "thinking_disabled_violation";
  }

  return null;
}

/**
 * Check if an error is recoverable.
 */
export function isRecoverableError(error: unknown): boolean {
  return detectErrorType(error) !== null;
}

// =============================================================================
// Tool Use Extraction
// =============================================================================

interface ToolUsePart {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function extractToolUseIds(parts: MessagePart[]): string[] {
  return parts
    .filter((p): p is ToolUsePart & MessagePart => p.type === "tool_use" && !!p.id)
    .map((p) => p.id!);
}

// =============================================================================
// Recovery Functions
// =============================================================================

/**
 * Recover from tool_result_missing error by injecting synthetic tool_result blocks.
 */
async function recoverToolResultMissing(
  client: PluginClient,
  sessionID: string,
  failedMsg: MessageData
): Promise<boolean> {
  // Try API parts first, fallback to filesystem if empty
  let parts = failedMsg.parts || [];
  if (parts.length === 0 && failedMsg.info?.id) {
    const storedParts = readParts(failedMsg.info.id);
    parts = storedParts.map((p) => ({
      type: p.type === "tool" ? "tool_use" : p.type,
      id: "callID" in p ? (p as { callID?: string }).callID : p.id,
      name: "tool" in p ? (p as { tool?: string }).tool : undefined,
      input: "state" in p ? (p as { state?: { input?: Record<string, unknown> } }).state?.input : undefined,
    }));
  }

  const toolUseIds = extractToolUseIds(parts);

  if (toolUseIds.length === 0) {
    return false;
  }

  const toolResultParts = toolUseIds.map((id) => ({
    type: "tool_result" as const,
    tool_use_id: id,
    content: "Operation cancelled by user (ESC pressed)",
  }));

  try {
    await client.session.prompt({
      path: { id: sessionID },
      // @ts-expect-error - SDK types may not include tool_result parts
      body: { parts: toolResultParts },
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Recover from thinking_block_order error by prepending thinking parts.
 */
async function recoverThinkingBlockOrder(
  sessionID: string,
  _failedMsg: MessageData,
  error: unknown
): Promise<boolean> {
  // Try to find the target message index from error
  const targetIndex = extractMessageIndex(error);
  if (targetIndex !== null) {
    const targetMessageID = findMessageByIndexNeedingThinking(sessionID, targetIndex);
    if (targetMessageID) {
      return prependThinkingPart(sessionID, targetMessageID);
    }
  }

  // Fallback: find all orphan thinking messages
  const orphanMessages = findMessagesWithOrphanThinking(sessionID);

  if (orphanMessages.length === 0) {
    return false;
  }

  let anySuccess = false;
  for (const messageID of orphanMessages) {
    if (prependThinkingPart(sessionID, messageID)) {
      anySuccess = true;
    }
  }

  return anySuccess;
}

/**
 * Recover from thinking_disabled_violation by stripping thinking parts.
 */
async function recoverThinkingDisabledViolation(
  sessionID: string,
  _failedMsg: MessageData
): Promise<boolean> {
  const messagesWithThinking = findMessagesWithThinkingBlocks(sessionID);

  if (messagesWithThinking.length === 0) {
    return false;
  }

  let anySuccess = false;
  for (const messageID of messagesWithThinking) {
    if (stripThinkingParts(messageID)) {
      anySuccess = true;
    }
  }

  return anySuccess;
}

// =============================================================================
// Resume Session Helper
// =============================================================================

function findLastUserMessage(messages: MessageData[]): MessageData | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info?.role === "user") {
      return messages[i];
    }
  }
  return undefined;
}

function extractResumeConfig(userMessage: MessageData | undefined, sessionID: string): ResumeConfig {
  return {
    sessionID,
    agent: userMessage?.info?.agent,
    model: userMessage?.info?.model,
  };
}

async function resumeSession(
  client: PluginClient,
  config: ResumeConfig,
  directory: string
): Promise<boolean> {
  try {
    await client.session.prompt({
      path: { id: config.sessionID },
      body: {
        parts: [{ type: "text", text: RECOVERY_RESUME_TEXT }],
        agent: config.agent,
        model: config.model,
      },
      query: { directory },
    });
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Toast Messages
// =============================================================================

const TOAST_TITLES: Record<string, string> = {
  tool_result_missing: "Tool Crash Recovery",
  thinking_block_order: "Thinking Block Recovery",
  thinking_disabled_violation: "Thinking Strip Recovery",
};

const TOAST_MESSAGES: Record<string, string> = {
  tool_result_missing: "Injecting cancelled tool results...",
  thinking_block_order: "Fixing message structure...",
  thinking_disabled_violation: "Stripping thinking blocks...",
};

export function getRecoveryToastContent(errorType: RecoveryErrorType): {
  title: string;
  message: string;
} {
  if (!errorType) {
    return {
      title: "Session Recovery",
      message: "Attempting to recover session...",
    };
  }
  return {
    title: TOAST_TITLES[errorType] || "Session Recovery",
    message: TOAST_MESSAGES[errorType] || "Attempting to recover session...",
  };
}

export function getRecoverySuccessToast(): {
  title: string;
  message: string;
} {
  return {
    title: "Session Recovered",
    message: "Continuing where you left off...",
  };
}

export function getRecoveryFailureToast(): {
  title: string;
  message: string;
} {
  return {
    title: "Recovery Failed",
    message: "Please retry or start a new session.",
  };
}

// =============================================================================
// Session Recovery Hook
// =============================================================================

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
export function createSessionRecoveryHook(
  ctx: SessionRecoveryContext,
  config: AntigravityConfig
): SessionRecoveryHook | null {
  // If session recovery is disabled, return null
  if (!config.session_recovery) {
    return null;
  }

  const { client, directory } = ctx;
  const processingErrors = new Set<string>();
  let onAbortCallback: ((sessionID: string) => void) | null = null;
  let onRecoveryCompleteCallback: ((sessionID: string) => void) | null = null;

  const setOnAbortCallback = (callback: (sessionID: string) => void): void => {
    onAbortCallback = callback;
  };

  const setOnRecoveryCompleteCallback = (callback: (sessionID: string) => void): void => {
    onRecoveryCompleteCallback = callback;
  };

  const handleSessionRecovery = async (info: MessageInfo): Promise<boolean> => {
    // Validate input
    if (!info || info.role !== "assistant" || !info.error) return false;

    const errorType = detectErrorType(info.error);
    if (!errorType) return false;

    const sessionID = info.sessionID;
    if (!sessionID) return false;

    // OpenCode's session.error event may not include messageID
    // In that case, we need to fetch messages and find the latest assistant with error
    let assistantMsgID = info.id;
    let msgs: MessageData[] | undefined;
    const log = createLogger("session-recovery");

    log.debug("Recovery attempt started", {
      errorType,
      sessionID,
      providedMsgID: assistantMsgID ?? "none",
    });

    // Notify abort callback early
    if (onAbortCallback) {
      onAbortCallback(sessionID);
    }

    // Abort current request
    await client.session.abort({ path: { id: sessionID } }).catch(() => {});

    // Fetch messages - needed to find the failed message
    const messagesResp = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    });
    msgs = (messagesResp as { data?: MessageData[] }).data;

    // If messageID wasn't provided, find the latest assistant message with an error
    if (!assistantMsgID && msgs && msgs.length > 0) {
      // Find the last assistant message (most recent is typically last in array)
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.info?.role === "assistant" && m.info?.id) {
          assistantMsgID = m.info.id;
          log.debug("Found assistant message ID from session messages", {
            msgID: assistantMsgID,
            msgIndex: i,
          });
          break;
        }
      }
    }

    if (!assistantMsgID) {
      log.debug("No assistant message ID found, cannot recover");
      return false;
    }
    if (processingErrors.has(assistantMsgID)) return false;
    processingErrors.add(assistantMsgID);

    try {
      const failedMsg = msgs?.find((m) => m.info?.id === assistantMsgID);
      if (!failedMsg) {
        return false;
      }

      // Show toast notification
      const toastContent = getRecoveryToastContent(errorType);
      logToast(`${toastContent.title}: ${toastContent.message}`, "warning");
      await client.tui
        .showToast({
          body: {
            title: toastContent.title,
            message: toastContent.message,
            variant: "warning",
          },
        })
        .catch(() => {});

      // Perform recovery based on error type
      let success = false;

      if (errorType === "tool_result_missing") {
        success = await recoverToolResultMissing(client, sessionID, failedMsg);
      } else if (errorType === "thinking_block_order") {
        success = await recoverThinkingBlockOrder(sessionID, failedMsg, info.error);
        if (success && config.auto_resume) {
          const lastUser = findLastUserMessage(msgs ?? []);
          const resumeConfig = extractResumeConfig(lastUser, sessionID);
          await resumeSession(client, resumeConfig, directory);
        }
      } else if (errorType === "thinking_disabled_violation") {
        success = await recoverThinkingDisabledViolation(sessionID, failedMsg);
        if (success && config.auto_resume) {
          const lastUser = findLastUserMessage(msgs ?? []);
          const resumeConfig = extractResumeConfig(lastUser, sessionID);
          await resumeSession(client, resumeConfig, directory);
        }
      }

      return success;
    } catch (err) {
      log.error("Recovery failed", { error: String(err) });
      return false;
    } finally {
      processingErrors.delete(assistantMsgID);

      // Always notify recovery complete
      if (sessionID && onRecoveryCompleteCallback) {
        onRecoveryCompleteCallback(sessionID);
      }
    }
  };

  return {
    handleSessionRecovery,
    isRecoverableError,
    setOnAbortCallback,
    setOnRecoveryCompleteCallback,
  };
}
