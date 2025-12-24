# Thinking Signature Safeguards

## Problem

Switching from non-Claude providers to Antigravity Claude can carry foreign thinking signatures. Claude rejects those with "Invalid signature in thinking block."

## Solution: Unconditional Stripping for Claude Models (Default)

For Claude models, all thinking/reasoning blocks are **unconditionally stripped** from outgoing requests by default. This eliminates signature validation errors entirely.

### Opt-in: Preserve Thinking Blocks

If you want to preserve thinking blocks (for maximum context), you can opt-in:

```bash
export OPENCODE_ANTIGRAVITY_KEEP_THINKING=1
```

**Trade-offs:**

| Mode | Reliability | Context | Token Usage |
|------|-------------|---------|-------------|
| **Strip (default)** | 100% | Slightly reduced | ~5-15% more |
| **Keep (opt-in)** | ~80-90% | Full | Normal |

**When to use `KEEP_THINKING=1`:**
- You need maximum context across multi-turn conversations
- Your OpenCode setup doesn't modify thinking blocks
- You're willing to accept occasional signature errors

### Why Stripping is the Default

Previous attempts to validate/restore signatures had too many edge cases:
- Session IDs can differ between requests
- Text matching requires exact match (slight changes break it)
- Foreign signatures from other providers can slip through
- Signature cache TTL may expire, leaving valid thinking blocks without restorable signatures

The nuclear option is simpler and more robust: just strip all thinking blocks from requests. Claude generates fresh thinking for each turn anyway.

### What Gets Preserved vs Stripped

| Content Type | Preserved? |
|-------------|-----------|
| Text blocks | Yes |
| Tool calls (functionCall) | Yes |
| Tool results (functionResponse) | Yes |
| Thinking blocks (type: "thinking") | Stripped |
| Reasoning blocks (type: "reasoning") | Stripped |
| Blocks with signature field | Stripped |

### Impact

- **Quality**: None - Claude sees actual conversation (text, tools), re-thinks fresh each turn
- **Token usage**: ~5-15% more per turn (thinking not reused from history)
- **Reliability**: 100% - impossible to have invalid signature errors

## Core Behaviors

1. **Claude models**: Use `stripAllThinkingBlocks()` to unconditionally remove all thinking/reasoning blocks
2. **Non-Claude models**: Legacy signature validation/restoration logic still applies
3. **Deep filtering**: Payload is walked recursively; nested `messages[]` or `contents[]` arrays are filtered
4. **Tool block preservation**: Tool blocks are always preserved to maintain tool call/result pairing

## Strip-Then-Inject Order (Critical for Tool Use)

For Claude thinking models with tool_use, operations MUST follow this order:

```
Step 1: deepFilterThinkingBlocks()     // Strip ALL thinking from request
Step 2: ensureThinkingBeforeToolUse()  // Inject signed thinking from cache
Step 3: Check needsSignedThinkingWarmup // Trigger warmup if no cache
```

**Why this order matters:**
- Claude API requires assistant messages with tool_use to START with a thinking block
- Incoming requests may have corrupted/unsigned thinking (from SDK transformations)
- We strip first (clean slate), then inject valid cached signatures
- If cache is empty, warmup request populates it before the real request

**Wrong order causes:** `Expected 'thinking' or 'redacted_thinking', but found 'text'`

## Implementation

```typescript
function stripAllThinkingBlocks(contentArray: any[]): any[] {
  return contentArray.filter(item => {
    if (!item || typeof item !== "object") return true;
    if (isToolBlock(item)) return true;
    if (isThinkingPart(item)) return false;
    if (hasSignatureField(item)) return false;
    return true;
  });
}
```

The `isClaudeModel` flag is passed through the filter chain:
- `deepFilterThinkingBlocks(payload, sessionId, getCachedSignatureFn, isClaudeModel)`
- `filterUnsignedThinkingBlocks(contents, sessionId, getCachedSignatureFn, isClaudeModel)`
- `filterMessagesThinkingBlocks(messages, sessionId, getCachedSignatureFn, isClaudeModel)`
- `filterContentArray(contentArray, sessionId, getCachedSignatureFn, isClaudeModel)`

## Architecture: Plugin vs CLIProxyAPI

Understanding the difference helps explain why stripping is the right approach.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLIProxyAPI (Reference)                            │
│                                                                              │
│  Client App ←→ CLIProxyAPI ←→ Antigravity ←→ Claude                         │
│     │              │                                                         │
│     │              └─ Stateless proxy, no signature caching                  │
│     └─ Client responsible for preserving signatures in history              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           Our Plugin                                         │
│                                                                              │
│  OpenCode ←→ OUR PLUGIN ←→ Antigravity ←→ Claude                            │
│     │           │                                                            │
│     │           └─ Must handle corrupted signatures from OpenCode            │
│     └─ Stores history BUT may transform/corrupt signatures                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Why OpenCode corrupts signatures:**
- SDK injects `cache_control` into thinking blocks
- SDK wraps thinking in nested objects
- Session restarts lose in-memory state
- Multi-provider switching carries foreign signatures

**Why CLIProxyAPI doesn't have this problem:**
- It's a stateless proxy - doesn't store conversation history
- Client apps that work with CLIProxyAPI either:
  1. Strip thinking blocks themselves (like we now do)
  2. Preserve exact signatures (which OpenCode can't guarantee)

## Related Files

- `src/plugin/request-helpers.ts` - Filter functions
- `src/plugin/request.ts` - Request handling with isClaudeModel detection
- `src/plugin/cache.ts` - Signature caching (still used for response display)
