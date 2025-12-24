/**
 * Third-party plugin compatibility layer.
 * Handles workarounds for known issues with other OpenCode plugins.
 */

/**
 * DCP (Dynamic Context Pruning) Workaround
 * 
 * DCP creates synthetic assistant messages that lack thinking blocks,
 * causing Claude API to reject with "Expected 'thinking', but found 'text'".
 * We inject redacted_thinking blocks to satisfy Claude's requirements.
 */
const DCP_SYNTHETIC_REDACTED_THINKING = {
  type: "redacted_thinking",
  data: "W0RDUF0=",
} as const;

function isThinkingBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const type = (block as Record<string, unknown>).type;
  return type === "thinking" || type === "redacted_thinking";
}

function ensureThinkingBlockInContent(content: unknown[]): unknown[] {
  if (content.length === 0) return content;
  
  const firstBlock = content[0];
  if (isThinkingBlock(firstBlock)) return content;
  
  return [DCP_SYNTHETIC_REDACTED_THINKING, ...content];
}

export function fixDcpSyntheticMessages(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    
    const msg = message as Record<string, unknown>;
    if (msg.role !== "assistant") return message;
    
    const content = msg.content;
    if (!Array.isArray(content)) return message;
    
    const fixedContent = ensureThinkingBlockInContent(content);
    if (fixedContent === content) return message;
    
    return { ...msg, content: fixedContent };
  });
}

export function applyCompatibilityFixes(
  messages: unknown[],
  options: { isClaudeThinkingModel: boolean },
): unknown[] {
  if (!options.isClaudeThinkingModel) return messages;
  
  return fixDcpSyntheticMessages(messages);
}
