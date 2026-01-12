/**
 * Storage utilities for reading OpenCode's session data.
 *
 * Based on oh-my-opencode/src/hooks/session-recovery/storage.ts
 */
import type { StoredMessageMeta, StoredPart } from "./types";
export declare function generatePartId(): string;
export declare function getMessageDir(sessionID: string): string;
export declare function readMessages(sessionID: string): StoredMessageMeta[];
export declare function readParts(messageID: string): StoredPart[];
export declare function hasContent(part: StoredPart): boolean;
export declare function messageHasContent(messageID: string): boolean;
export declare function injectTextPart(sessionID: string, messageID: string, text: string): boolean;
export declare function findMessagesWithThinkingBlocks(sessionID: string): string[];
export declare function findMessagesWithThinkingOnly(sessionID: string): string[];
export declare function findMessagesWithOrphanThinking(sessionID: string): string[];
export declare function prependThinkingPart(sessionID: string, messageID: string): boolean;
export declare function stripThinkingParts(messageID: string): boolean;
export declare function findEmptyMessages(sessionID: string): string[];
export declare function findEmptyMessageByIndex(sessionID: string, targetIndex: number): string | null;
export declare function findMessageByIndexNeedingThinking(sessionID: string, targetIndex: number): string | null;
export declare function replaceEmptyTextParts(messageID: string, replacementText: string): boolean;
export declare function findMessagesWithEmptyTextParts(sessionID: string): string[];
//# sourceMappingURL=storage.d.ts.map