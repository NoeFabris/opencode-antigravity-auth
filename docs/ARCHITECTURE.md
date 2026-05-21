# Architecture Guide

**Last Updated:** April 2026

This document explains how the Antigravity plugin works: request/response flow, Claude-specific handling, and session recovery.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  OpenCode ──▶ Plugin ──▶ Antigravity API ──▶ Claude/Gemini      │
│     │           │              │                   │            │
│     │           │              │                   └─ Model     │
│     │           │              └─ Google's gateway (Gemini fmt) │
│     │           └─ THIS PLUGIN (auth, transform, recovery)      │
│     └─ AI coding assistant                                      │
└─────────────────────────────────────────────────────────────────┘
```

The plugin intercepts requests to `generativelanguage.googleapis.com`, transforms them for the Antigravity API, and handles authentication, rate limits, and error recovery.

---

## Module Structure

```
src/
├── index.ts                 # Plugin exports
├── plugin.ts                # Main entry, fetch interceptor
├── constants.ts             # Endpoints, headers, config
├── antigravity/
│   └── oauth.ts             # OAuth token exchange
└── plugin/
    ├── auth.ts              # Token validation & refresh
    ├── request.ts           # Request transformation (main logic)
    ├── request-helpers.ts   # Schema cleaning, thinking filters
    ├── thinking-recovery.ts # Turn boundary detection, crash recovery
    ├── recovery.ts          # Session recovery (tool_result_missing)
    ├── quota.ts             # Quota checking (API usage stats)
    ├── cache.ts             # Auth & signature caching
    ├── cache/
    │   └── signature-cache.ts # Disk-based signature persistence
    ├── config/
    │   ├── schema.ts        # Zod config schema
    │   └── loader.ts        # Config file loading
    ├── accounts.ts          # Multi-account management
    ├── server.ts            # OAuth callback server
    ├── transport/
    │   ├── types.ts              # Transport interface and related types
    │   ├── gateway-transport.ts  # GatewayTransport (default)
    │   ├── cli-transport.ts      # CliTransport (opt-in agy --print)
    │   ├── managed-agent-transport.ts # ManagedAgentTransport (opt-in API)
    │   ├── agy-cli.ts            # agy binary detection, auth, execution
    │   ├── gateway-transport.test.ts
    │   ├── cli-transport.test.ts
    │   ├── managed-agent-transport.test.ts
    │   └── agy-cli.test.ts
    └── debug.ts             # Debug logging
```

---

## Transport Boundary (Phase 3)

The plugin uses a **transport interface** to separate request/response logic from the fetch interceptor's orchestration concerns.

```
OpenCode request
  └─ plugin.ts (fetch interceptor)
      ├─ account selection, quota rotation, rate limiting, retries
      └─ gatewayTransport
          ├─ matches()          — request recognition
          ├─ getRequestMetadata() — model/family extraction
          ├─ prepareRequest()   — delegates to prepareAntigravityRequest()
          └─ transformResponse() — delegates to transformAntigravityResponse()
```

### Transport responsibilities

| Concern | Owner |
|---------|-------|
| Request recognition | Transport (`matches()`) |
| Model/family extraction | Transport (`getRequestMetadata()`) |
| Request body transformation | Transport (`prepareRequest()`) |
| Response/stream transformation | Transport (`transformResponse()`) |
| Account selection | Fetch interceptor (`plugin.ts`) |
| Quota rotation | Fetch interceptor (`plugin.ts`) |
| Rate limit backoff | Fetch interceptor (`plugin.ts`) |
| Endpoint fallback loop | Fetch interceptor (`plugin.ts`) |
| Auth token refresh | Fetch interceptor (`plugin.ts`) |

### Adding a new transport

1. Add a new `TransportId` value to `src/plugin/transport/types.ts`.
2. Implement the `Transport` interface in a new file under `src/plugin/transport/`.
3. Select the transport in `plugin.ts` based on config or request shape.
4. The fetch interceptor's orchestration loop does not need to change.

`GatewayTransport` is the default transport. Two opt-in alternatives are now available:

### CliTransport (`transport.id: "cli"`)

Runs `agy --print` as a subprocess. The plugin extracts the text prompt from the request body, passes it to the Antigravity CLI, and wraps the stdout response in Gemini text format.

**Limitations (double-agent):**
- OpenCode is an agent; `agy` is also an agent. This creates a nested agent stack where OpenCode's tool calls are NOT forwarded to `agy`.
- Only text prompts are supported. Tool calls, streaming, and multi-turn conversation history are NOT passed through.
- Auth must be completed separately: run `agy` in a terminal and complete browser OAuth before enabling this transport.
- No quota rotation, no multi-account, no endpoint fallback.

**When to use:** Experimental high-level agent tasks where you want the official Antigravity agent runtime instead of the raw model gateway.

### ManagedAgentTransport (`transport.id: "managed-agent"`)

Uses the public Gemini Managed Agents / Interactions API (`/v1beta/interactions`) with a Gemini API key. Sends text input to the `antigravity-preview-05-2026` base agent and returns the response in Gemini format.

**Limitations:**
- Requires a Gemini API key with appropriate billing.
- Uses the public API, not the internal CloudCode gateway — separate from OAuth accounts.
- Preview API: behavior, pricing, and availability may change without notice.
- Streaming support is conservative (SSE passed as-is until real payloads are observed).
- No quota rotation, no multi-account.

**When to use:** When you have a Gemini API key and want to use the official Managed Agents harness without OAuth.

---

## Request Flow

### 1. Interception (`plugin.ts`)

```typescript
fetch() intercepted → gatewayTransport.matches() → gatewayTransport.prepareRequest()
```

- Account selection (round-robin, rate-limit aware)
- Token refresh if expired
- Endpoint fallback (daily → autopush → prod)

### 2. Request Transformation (`request.ts`)

| Step | What Happens |
|------|--------------|
| Model detection | Detect Claude/Gemini from URL |
| Thinking config | Add `thinkingConfig` for thinking models |
| Thinking strip | Remove ALL thinking blocks (Claude) |
| Tool normalization | Convert to `functionDeclarations[]` |
| Schema cleaning | Remove unsupported JSON Schema fields |
| ID assignment | Assign IDs to tool calls (FIFO matching) |
| Wrap request | `{ project, model, request: {...} }` |

### 3. Response Transformation (`request.ts`)

| Step | What Happens |
|------|--------------|
| SSE streaming | Real-time line-by-line TransformStream |
| Signature caching | Cache `thoughtSignature` for display |
| Format transform | `thought: true` → `type: "reasoning"` |
| Envelope unwrap | Extract inner `response` object |

---

## Claude-Specific Handling

### Why Special Handling?

Claude through Antigravity requires:
1. **Gemini format** - `contents[].parts[]` not `messages[].content[]`
2. **Thinking signatures** - Multi-turn needs signed blocks or errors
3. **Schema restrictions** - Rejects `const`, `$ref`, `$defs`, etc.
4. **Tool validation** - `VALIDATED` mode requires proper schemas

### Thinking Block Strategy (v2.0)

**Problem:** OpenCode stores thinking blocks, but may corrupt signatures.

**Solution:** Strip ALL thinking blocks from outgoing requests.

```
Turn 1 Response: { thought: true, text: "...", thoughtSignature: "abc" }
                 ↓ (stored by OpenCode, possibly corrupted)
Turn 2 Request:  Plugin STRIPS all thinking blocks
                 ↓
Claude API:      Generates fresh thinking
```

**Why this works:**
- Zero signature errors (impossible to have invalid signatures)
- Same quality (Claude sees full conversation, re-thinks fresh)
- Simpler code (no complex validation/restoration)

### Thinking Injection for Tool Use

Claude API requires thinking before `tool_use` blocks. The plugin:

1. Caches signed thinking from responses (`lastSignedThinkingBySessionKey`)
2. On subsequent requests, injects cached thinking before tool_use
3. Only injects for the **first** assistant message of a turn (not every message)

**Turn boundary detection** (`thinking-recovery.ts`):
```typescript
// A "turn" starts after a real user message (not tool_result)
// Only inject thinking into first assistant message after that
```

---

## Session Recovery

### Tool Result Missing Error

When a tool execution is interrupted (ESC, timeout, crash):

```
Error: tool_use ids were found without tool_result blocks immediately after
```

**Recovery flow** (`recovery.ts`):

1. Detect error via `session.error` event
2. Fetch session messages via `client.session.messages()`
3. Extract `tool_use` IDs from failed message
4. Inject synthetic `tool_result` blocks:
   ```typescript
   { type: "tool_result", tool_use_id: id, content: "Operation cancelled" }
   ```
5. Send via `client.session.prompt()`
6. Optionally auto-resume with "continue"

### Thinking Block Order Error

```
Error: Expected thinking but found text
```

**Recovery** (`thinking-recovery.ts`):

1. Detect conversation is in tool loop without thinking at turn start
2. Close the corrupted turn with synthetic messages
3. Start fresh turn where Claude can generate new thinking

---

## Schema Cleaning

Claude rejects unsupported JSON Schema features. The plugin uses an **allowlist approach**:

**Kept:** `type`, `properties`, `required`, `description`, `enum`, `items`

**Removed:** `const`, `$ref`, `$defs`, `default`, `examples`, `additionalProperties`, `$schema`, `title`

**Transformations:**
- `const: "value"` → `enum: ["value"]`
- Empty object schema → Add placeholder `reason` property

---

## Multi-Account Load Balancing

### How It Works

1. **Sticky selection** - Same account until rate limited (preserves cache)
2. **Per-model-family** - Claude/Gemini rate limits tracked separately
3. **Dual quota (Gemini)** - Antigravity + Gemini CLI headers
4. **Automatic failover** - On 429, switch to next available account

### Account Storage

Location: `~/.config/opencode/antigravity-accounts.json`

Contains OAuth refresh tokens - treat as sensitive.

---

## Configuration

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENCODE_ANTIGRAVITY_DEBUG` | `1` or `2` for file debug logging |
| `OPENCODE_ANTIGRAVITY_DEBUG_TUI` | `1` or `true` for TUI log panel debug output |
| `OPENCODE_ANTIGRAVITY_QUIET` | Suppress toast notifications |

`debug` and `debug_tui` are independent sinks: `debug` controls file logs, while `debug_tui` controls TUI logs.

### Config File

Location: `~/.config/opencode/antigravity.json`

```json
{
  "session_recovery": true,
  "auto_resume": true,
  "resume_text": "continue",
  "keep_thinking": false
}
```

---

## Key Functions Reference

### `request.ts`

| Function | Purpose |
|----------|---------|
| `prepareAntigravityRequest()` | Main request transformation |
| `transformAntigravityResponse()` | SSE streaming, format conversion |
| `ensureThinkingBeforeToolUseInContents()` | Inject cached thinking |
| `createStreamingTransformer()` | Real-time SSE processing |

### `request-helpers.ts`

| Function | Purpose |
|----------|---------|
| `deepFilterThinkingBlocks()` | Recursive thinking block removal |
| `cleanJSONSchemaForAntigravity()` | Schema sanitization |
| `transformThinkingParts()` | `thought` → `reasoning` format |

### `thinking-recovery.ts`

| Function | Purpose |
|----------|---------|
| `analyzeConversationState()` | Detect turn boundaries, tool loops |
| `needsThinkingRecovery()` | Check if recovery needed |
| `closeToolLoopForThinking()` | Inject synthetic messages |

### `recovery.ts`

| Function | Purpose |
|----------|---------|
| `handleSessionRecovery()` | Main recovery orchestration |
| `createSessionRecoveryHook()` | Hook factory for plugin |

---

## Debugging

### Enable Logging

```bash
export OPENCODE_ANTIGRAVITY_DEBUG=2      # Verbose file logs
export OPENCODE_ANTIGRAVITY_DEBUG_TUI=1  # TUI log panel output
```

### Log Location

`~/.config/opencode/antigravity-logs/`

### What To Check

1. Is `isClaudeModel` true for Claude models?
2. Are thinking blocks being stripped?
3. Are tool schemas being cleaned?
4. Is session recovery triggering?

---

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| `invalid signature` | Corrupted thinking block | Update plugin (strips all thinking) |
| `Unknown field: const` | Schema uses `const` | Plugin auto-converts to `enum` |
| `tool_use without tool_result` | Interrupted execution | Session recovery injects results |
| `Expected thinking but found text` | Turn started without thinking | Thinking recovery closes turn |
| `429 Too Many Requests` | Rate limited | Plugin auto-rotates accounts |

---

## See Also

- [ANTIGRAVITY_API_SPEC.md](./ANTIGRAVITY_API_SPEC.md) - API reference
- [README.md](../README.md) - Installation & usage
