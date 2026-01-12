/**
 * Storage utilities for reading OpenCode's session data.
 *
 * Based on oh-my-opencode/src/hooks/session-recovery/storage.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGE_STORAGE, PART_STORAGE, THINKING_TYPES, META_TYPES } from "./constants";
// =============================================================================
// ID Generation
// =============================================================================
export function generatePartId() {
    const timestamp = Date.now().toString(16);
    const random = Math.random().toString(36).substring(2, 10);
    return `prt_${timestamp}${random}`;
}
// =============================================================================
// Directory Helpers
// =============================================================================
export function getMessageDir(sessionID) {
    if (!existsSync(MESSAGE_STORAGE))
        return "";
    const directPath = join(MESSAGE_STORAGE, sessionID);
    if (existsSync(directPath)) {
        return directPath;
    }
    // Search in subdirectories
    try {
        for (const dir of readdirSync(MESSAGE_STORAGE)) {
            const sessionPath = join(MESSAGE_STORAGE, dir, sessionID);
            if (existsSync(sessionPath)) {
                return sessionPath;
            }
        }
    }
    catch {
        // Ignore read errors
    }
    return "";
}
// =============================================================================
// Message Reading
// =============================================================================
export function readMessages(sessionID) {
    const messageDir = getMessageDir(sessionID);
    if (!messageDir || !existsSync(messageDir))
        return [];
    const messages = [];
    try {
        for (const file of readdirSync(messageDir)) {
            if (!file.endsWith(".json"))
                continue;
            try {
                const content = readFileSync(join(messageDir, file), "utf-8");
                messages.push(JSON.parse(content));
            }
            catch {
                continue;
            }
        }
    }
    catch {
        return [];
    }
    return messages.sort((a, b) => {
        const aTime = a.time?.created ?? 0;
        const bTime = b.time?.created ?? 0;
        if (aTime !== bTime)
            return aTime - bTime;
        return a.id.localeCompare(b.id);
    });
}
// =============================================================================
// Part Reading
// =============================================================================
export function readParts(messageID) {
    const partDir = join(PART_STORAGE, messageID);
    if (!existsSync(partDir))
        return [];
    const parts = [];
    try {
        for (const file of readdirSync(partDir)) {
            if (!file.endsWith(".json"))
                continue;
            try {
                const content = readFileSync(join(partDir, file), "utf-8");
                parts.push(JSON.parse(content));
            }
            catch {
                continue;
            }
        }
    }
    catch {
        return [];
    }
    return parts;
}
// =============================================================================
// Content Helpers
// =============================================================================
export function hasContent(part) {
    if (THINKING_TYPES.has(part.type))
        return false;
    if (META_TYPES.has(part.type))
        return false;
    if (part.type === "text") {
        const textPart = part;
        return !!(textPart.text?.trim());
    }
    if (part.type === "tool" || part.type === "tool_use") {
        return true;
    }
    if (part.type === "tool_result") {
        return true;
    }
    return false;
}
export function messageHasContent(messageID) {
    const parts = readParts(messageID);
    return parts.some(hasContent);
}
// =============================================================================
// Part Injection (for recovery)
// =============================================================================
export function injectTextPart(sessionID, messageID, text) {
    const partDir = join(PART_STORAGE, messageID);
    try {
        if (!existsSync(partDir)) {
            mkdirSync(partDir, { recursive: true });
        }
        const partId = generatePartId();
        const part = {
            id: partId,
            sessionID,
            messageID,
            type: "text",
            text,
            synthetic: true,
        };
        writeFileSync(join(partDir, `${partId}.json`), JSON.stringify(part, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
// =============================================================================
// Thinking Block Recovery
// =============================================================================
export function findMessagesWithThinkingBlocks(sessionID) {
    const messages = readMessages(sessionID);
    const result = [];
    for (const msg of messages) {
        if (msg.role !== "assistant")
            continue;
        const parts = readParts(msg.id);
        const hasThinking = parts.some((p) => THINKING_TYPES.has(p.type));
        if (hasThinking) {
            result.push(msg.id);
        }
    }
    return result;
}
export function findMessagesWithThinkingOnly(sessionID) {
    const messages = readMessages(sessionID);
    const result = [];
    for (const msg of messages) {
        if (msg.role !== "assistant")
            continue;
        const parts = readParts(msg.id);
        if (parts.length === 0)
            continue;
        const hasThinking = parts.some((p) => THINKING_TYPES.has(p.type));
        const hasTextContent = parts.some(hasContent);
        // Has thinking but no text content = orphan thinking
        if (hasThinking && !hasTextContent) {
            result.push(msg.id);
        }
    }
    return result;
}
export function findMessagesWithOrphanThinking(sessionID) {
    const messages = readMessages(sessionID);
    const result = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || msg.role !== "assistant")
            continue;
        const parts = readParts(msg.id);
        if (parts.length === 0)
            continue;
        const sortedParts = [...parts].sort((a, b) => a.id.localeCompare(b.id));
        const firstPart = sortedParts[0];
        if (!firstPart)
            continue;
        const firstIsThinking = THINKING_TYPES.has(firstPart.type);
        // If first part is not thinking, it's orphan
        if (!firstIsThinking) {
            result.push(msg.id);
        }
    }
    return result;
}
export function prependThinkingPart(sessionID, messageID) {
    const partDir = join(PART_STORAGE, messageID);
    try {
        if (!existsSync(partDir)) {
            mkdirSync(partDir, { recursive: true });
        }
        const partId = "prt_0000000000_thinking";
        const part = {
            id: partId,
            sessionID,
            messageID,
            type: "thinking",
            thinking: "",
            synthetic: true,
        };
        writeFileSync(join(partDir, `${partId}.json`), JSON.stringify(part, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
export function stripThinkingParts(messageID) {
    const partDir = join(PART_STORAGE, messageID);
    if (!existsSync(partDir))
        return false;
    let anyRemoved = false;
    try {
        for (const file of readdirSync(partDir)) {
            if (!file.endsWith(".json"))
                continue;
            try {
                const filePath = join(partDir, file);
                const content = readFileSync(filePath, "utf-8");
                const part = JSON.parse(content);
                if (THINKING_TYPES.has(part.type)) {
                    unlinkSync(filePath);
                    anyRemoved = true;
                }
            }
            catch {
                continue;
            }
        }
    }
    catch {
        return false;
    }
    return anyRemoved;
}
// =============================================================================
// Empty Message Recovery
// =============================================================================
export function findEmptyMessages(sessionID) {
    const messages = readMessages(sessionID);
    const emptyIds = [];
    for (const msg of messages) {
        if (!messageHasContent(msg.id)) {
            emptyIds.push(msg.id);
        }
    }
    return emptyIds;
}
export function findEmptyMessageByIndex(sessionID, targetIndex) {
    const messages = readMessages(sessionID);
    // API index may differ from storage index due to system messages
    const indicesToTry = [targetIndex, targetIndex - 1, targetIndex - 2];
    for (const idx of indicesToTry) {
        if (idx < 0 || idx >= messages.length)
            continue;
        const targetMsg = messages[idx];
        if (!targetMsg)
            continue;
        if (!messageHasContent(targetMsg.id)) {
            return targetMsg.id;
        }
    }
    return null;
}
export function findMessageByIndexNeedingThinking(sessionID, targetIndex) {
    const messages = readMessages(sessionID);
    if (targetIndex < 0 || targetIndex >= messages.length)
        return null;
    const targetMsg = messages[targetIndex];
    if (!targetMsg || targetMsg.role !== "assistant")
        return null;
    const parts = readParts(targetMsg.id);
    if (parts.length === 0)
        return null;
    const sortedParts = [...parts].sort((a, b) => a.id.localeCompare(b.id));
    const firstPart = sortedParts[0];
    if (!firstPart)
        return null;
    const firstIsThinking = THINKING_TYPES.has(firstPart.type);
    if (!firstIsThinking) {
        return targetMsg.id;
    }
    return null;
}
export function replaceEmptyTextParts(messageID, replacementText) {
    const partDir = join(PART_STORAGE, messageID);
    if (!existsSync(partDir))
        return false;
    let anyReplaced = false;
    try {
        for (const file of readdirSync(partDir)) {
            if (!file.endsWith(".json"))
                continue;
            try {
                const filePath = join(partDir, file);
                const content = readFileSync(filePath, "utf-8");
                const part = JSON.parse(content);
                if (part.type === "text") {
                    const textPart = part;
                    if (!textPart.text?.trim()) {
                        textPart.text = replacementText;
                        textPart.synthetic = true;
                        writeFileSync(filePath, JSON.stringify(textPart, null, 2));
                        anyReplaced = true;
                    }
                }
            }
            catch {
                continue;
            }
        }
    }
    catch {
        return false;
    }
    return anyReplaced;
}
export function findMessagesWithEmptyTextParts(sessionID) {
    const messages = readMessages(sessionID);
    const result = [];
    for (const msg of messages) {
        const parts = readParts(msg.id);
        const hasEmptyTextPart = parts.some((p) => {
            if (p.type !== "text")
                return false;
            const textPart = p;
            return !textPart.text?.trim();
        });
        if (hasEmptyTextPart) {
            result.push(msg.id);
        }
    }
    return result;
}
//# sourceMappingURL=storage.js.map