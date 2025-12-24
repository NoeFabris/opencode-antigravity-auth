# OpenCode Antigravity Plugin - Comprehensive Guide

**For AI Agents and Human Contributors**

This guide is the single source of truth for understanding, debugging, and contributing to the OpenCode Antigravity Auth plugin.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Key Concepts](#key-concepts)
3. [Request/Response Flow](#requestresponse-flow)
4. [Model-Specific Behaviors](#model-specific-behaviors)
5. [Known Quirks & Solutions](#known-quirks--solutions)
6. [Common Failure Modes](#common-failure-modes)
7. [Debugging Guide](#debugging-guide)
8. [Contributing Guidelines](#contributing-guidelines)
9. [Testing Strategy](#testing-strategy)
10. [Reference Documentation](#reference-documentation)

---

## Architecture Overview

### What This Plugin Does

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              REQUEST FLOW                                    │
│                                                                              │
│  OpenCode ──▶ Plugin ──▶ Antigravity API ──▶ Claude/Gemini                  │
│     │           │              │                   │                         │
│     │           │              │                   └─ Actual model           │
│     │           │              └─ Google's proxy (Gemini format)             │
│     │           └─ THIS PLUGIN (transforms, auth, quirks)                    │
│     └─ AI coding assistant                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### What This Plugin Is NOT

We are **not** CLIProxyAPI. Understanding this distinction is critical:

| Aspect | CLIProxyAPI | This Plugin |
|--------|-------------|-------------|
| **Role** | Stateless proxy server | Request interceptor |
| **Runs** | As a separate server | Inside OpenCode process |
| **History** | Client stores history | OpenCode stores history, we intercept |
| **Signatures** | Pass-through | Must handle corrupted signatures |

### Module Map

```
src/
├── plugin.ts              # Main entry point, orchestrates everything
├── constants.ts           # Provider IDs, endpoints, config
├── antigravity/
│   └── oauth.ts           # OAuth token exchange
└── plugin/
    ├── auth.ts            # Token validation & refresh
    ├── request.ts         # Request transformation (THE BIG ONE)
    ├── request-helpers.ts # Thinking block filtering, sanitization
    ├── response.ts        # Response transformation
    ├── cache.ts           # Signature caching (for debug display)
    ├── accounts.ts        # Multi-account management
    ├── cli.ts             # CLI integration
    ├── server.ts          # OAuth callback server
    └── debug.ts           # Debug logging
```

---

## Key Concepts

### 1. Antigravity API

Google's internal API that proxies requests to various models (Claude, Gemini, GPT). It uses **Gemini-style format** for all models.

**Key characteristics:**
- Endpoint: `https://{env}-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent`
- Format: Gemini-style (`contents[].parts[]` not `messages[].content[]`)
- Auth: OAuth bearer token
- Streaming: Server-Sent Events (SSE)

### 2. Model Families

| Family | Models | Special Handling |
|--------|--------|------------------|
| **Gemini** | `gemini-3-pro-high`, `gemini-3-flash` | Native format, dual quota pools |
| **Claude** | `claude-sonnet-4-5`, `claude-opus-4-5-thinking` | Thinking blocks, signatures, tool validation |
| **GPT** | `gpt-oss-120b-medium` | Minimal transformation |

### 3. Thinking Blocks

Claude thinking models generate "thinking" content that shows reasoning. These have **signatures** that validate authenticity.

**Problem:** OpenCode stores thinking blocks in conversation history. When sent back, signatures may be:
- Missing (SDK stripped them)
- Invalid (content was modified)
- Foreign (from different session/provider)

**Solution (v2.0):** Strip ALL thinking blocks from outgoing requests to Claude. Claude generates fresh thinking each turn.

### 4. Signature Flow

```
Turn 1:
  Request  → [no thinking]
  Response ← { thought: true, text: "...", thoughtSignature: "abc123" }
  OpenCode stores this in history

Turn 2:
  OpenCode sends → { thought: true, text: "...", thoughtSignature: ??? }
  Plugin STRIPS → { ...no thinking blocks... }
  Claude API   → generates fresh thinking
```

---

## Request/Response Flow

### Full Request Lifecycle

```
1. OpenCode sends request
   ↓
2. Plugin intercepts (plugin.ts)
   ↓
3. Check auth, refresh token if needed (auth.ts)
   ↓
4. Detect model type (isClaudeModel, isGeminiModel)
   ↓
5. Transform request (request.ts)
   ├── Convert messages to Gemini format
   ├── Add thinking config (Claude)
   ├── Strip thinking blocks (Claude)
   ├── Sanitize tool schemas
   └── Add required headers
   ↓
6. Send to Antigravity API
   ↓
7. Stream response (response.ts)
   ├── Parse SSE chunks
   ├── Cache signatures (for debug)
   ├── Transform to OpenCode format
   └── Handle errors
   ↓
8. Return to OpenCode
```

### Key Transformation Points

| Stage | File | What Happens |
|-------|------|--------------|
| Request body | `request.ts` | Messages → Gemini format, thinking config |
| Thinking blocks | `request-helpers.ts` | Strip for Claude, filter for others |
| Tool schemas | `request.ts` | Remove unsupported JSON schema fields |
| Response | `response.ts` | SSE parsing, format conversion |

---

## Model-Specific Behaviors

### Claude Models

**Detection:**
```typescript
const isClaudeModel = modelId.includes("claude");
```

**Special handling:**
1. **Thinking config** - Add `thinkingConfig.includeThoughts: true`
2. **Beta headers** - Add `anthropic-beta: interleaved-thinking-2025-05-14`
3. **Strip thinking blocks** - Remove ALL thinking from outgoing requests
4. **Tool validation** - Set `functionCallingConfig.mode: "VALIDATED"`
5. **Tool ID assignment** - Ensure all tool calls have unique IDs

**Why strip thinking?**
- OpenCode may corrupt signatures (add `cache_control`, wrap in objects)
- Signature validation had too many edge cases
- Claude re-thinks each turn anyway - no quality loss

### Gemini Models

**Detection:**
```typescript
const isGeminiModel = modelId.includes("gemini");
```

**Special handling:**
1. **Native format** - Already in Gemini format, minimal transformation
2. **Dual quota pools** - Can use both Antigravity and Gemini CLI quotas
3. **Thinking** - Uses `thought: true` format (Gemini-style)

### GPT Models

**Detection:**
```typescript
const isGPTModel = modelId.includes("gpt");
```

**Special handling:**
- Minimal - mostly pass-through with format conversion

---

## Known Quirks & Solutions

### Category 1: SDK Injection

| Quirk | What SDK Does | Our Fix |
|-------|---------------|---------|
| `cache_control` injection | Adds `{ cache_control: { type: "ephemeral" } }` to parts | `stripCacheControlRecursively()` |
| `providerOptions` injection | Adds provider-specific options | Strip in `sanitizeThinkingPart()` |
| Wrapped thinking | Wraps text in objects | Extract inner text |

### Category 2: Thinking Signatures

| Quirk | Problem | Our Fix |
|-------|---------|---------|
| Invalid signatures | OpenCode modifies thinking blocks | Strip ALL thinking (v2.0) |
| Missing signatures | SDK strips them | Strip ALL thinking (v2.0) |
| Foreign signatures | Different session/provider | Strip ALL thinking (v2.0) |
| Trailing thinking | Assistant can't end with unsigned thinking | Strip ALL thinking (v2.0) |

### Category 3: Tool Calling

| Quirk | Problem | Our Fix |
|-------|---------|---------|
| Missing tool IDs | Claude requires unique IDs | `assignToolIds()` |
| Unsupported schema fields | `additionalProperties`, `$schema`, etc. | `cleanJsonSchema()` |
| Invalid function names | Must match `[a-zA-Z_][a-zA-Z0-9_]*` | Sanitize names |

### Category 4: Format Conversion

| Quirk | Problem | Our Fix |
|-------|---------|---------|
| Anthropic vs Gemini format | Different structure | Convert in `prepareAntigravityRequest()` |
| Role mapping | `assistant` vs `model` | Map roles during conversion |
| Content array vs string | Some expect string, some array | Normalize to array |

---

## Common Failure Modes

### Error: `Invalid signature in thinking block`

**Cause:** Thinking block with invalid/missing signature sent to Claude API.

**Solution:** Update plugin to v2.0+ (strips all thinking blocks).

**If still occurring:** Check if `isClaudeModel` detection is working correctly.

### Error: `400 Bad Request` with tool calls

**Cause:** Usually unsupported JSON schema fields.

**Debug:**
1. Enable `OPENCODE_ANTIGRAVITY_DEBUG=2`
2. Check request payload for `additionalProperties`, `$schema`, `title`, `default`
3. These should be stripped by `cleanJsonSchema()`

**Solution:** Ensure `cleanJsonSchema()` is being called on tool definitions.

### Error: `429 Too Many Requests`

**Cause:** Rate limited.

**Solution:** Plugin handles automatically with account rotation. If single account, waits for reset.

### Error: `invalid_grant`

**Cause:** OAuth refresh token revoked by Google.

**Solution:** Re-authenticate with `opencode auth login`.

---

## Debugging Guide

### Enable Debug Logging

```bash
# Basic logging
export OPENCODE_ANTIGRAVITY_DEBUG=1

# Verbose logging (full payloads)
export OPENCODE_ANTIGRAVITY_DEBUG=2
```

### Log Locations

- Default: `~/.config/opencode/antigravity-logs/`
- Override: `OPENCODE_ANTIGRAVITY_LOG_DIR=/path/to/logs`

### What To Look For

**In request logs:**
- Is `isClaudeModel` true for Claude models?
- Are thinking blocks being stripped?
- Are tool schemas cleaned?

**In response logs:**
- Are signatures being cached?
- Are SSE chunks parsing correctly?

### Debug Checklist

1. [ ] Check model detection (`isClaudeModel`, `isGeminiModel`)
2. [ ] Check thinking config being applied
3. [ ] Check thinking blocks being stripped (Claude)
4. [ ] Check tool schemas being cleaned
5. [ ] Check request/response format

---

## Contributing Guidelines

### Before Making Changes

1. **Read this guide** - Understand the architecture
2. **Check existing quirks** - Your issue might already be handled
3. **Run tests** - `npm test` must pass

### Code Patterns

**DO:**
```typescript
// Check model type explicitly
if (isClaudeModel) {
  // Claude-specific logic
}

// Use existing helper functions
const cleaned = cleanJsonSchema(schema);
const filtered = filterContentArray(parts, sessionId, getCachedSignature, isClaudeModel);
```

**DON'T:**
```typescript
// Don't use type assertions to silence errors
const x = something as any;  // ❌

// Don't suppress type errors
// @ts-ignore  // ❌
// @ts-expect-error  // ❌

// Don't modify thinking blocks - just strip them
thinkingBlock.signature = newSignature;  // ❌ - just strip instead
```

### Adding New Quirk Handling

1. **Document the quirk** - Add to this guide and `CLAUDE_MODEL_FLOW.md`
2. **Write a test** - Add to `*.test.ts` files
3. **Implement fix** - Usually in `request-helpers.ts` or `request.ts`
4. **Verify** - Run full test suite

### Testing Requirements

- All tests must pass: `npm test`
- Add tests for new quirks
- Test with real API if possible (manual)

---

## Testing Strategy

### Unit Tests

Located in `src/plugin/*.test.ts`:

| File | Coverage |
|------|----------|
| `request-helpers.test.ts` | Thinking block filtering, sanitization |
| `auth.test.ts` | Token validation, refresh |
| `accounts.test.ts` | Multi-account management |
| `cache.test.ts` | Signature caching |

### Running Tests

```bash
# All tests
npm test

# Specific file
npm test -- request-helpers

# Watch mode
npm test -- --watch
```

### Manual Testing

For full integration testing:

```bash
# Enable debug
export OPENCODE_ANTIGRAVITY_DEBUG=2

# Test Claude
opencode run "Hello" --model=google/claude-sonnet-4-5

# Test Claude thinking
opencode run "Think step by step: what is 2+2?" --model=google/claude-opus-4-5-thinking

# Test Gemini
opencode run "Hello" --model=google/gemini-3-pro-high
```

---

## Reference Documentation

| Document | Purpose |
|----------|---------|
| [CLAUDE_MODEL_FLOW.md](./CLAUDE_MODEL_FLOW.md) | Detailed Claude request/response flow |
| [ANTIGRAVITY_API_SPEC.md](./ANTIGRAVITY_API_SPEC.md) | Antigravity API reference |
| [THINKING_SIGNATURE_SAFEGUARDS.md](./THINKING_SIGNATURE_SAFEGUARDS.md) | Thinking block handling details |
| [CHANGELOG.md](../CHANGELOG.md) | Version history |

---

## Quick Reference

### Model Detection

```typescript
const isClaudeModel = modelId.includes("claude");
const isGeminiModel = modelId.includes("gemini");
const isThinkingModel = modelId.includes("thinking");
```

### Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `prepareAntigravityRequest()` | `request.ts` | Main request transformation |
| `deepFilterThinkingBlocks()` | `request-helpers.ts` | Strip thinking from payload |
| `stripAllThinkingBlocks()` | `request-helpers.ts` | Unconditional thinking strip |
| `cleanJsonSchema()` | `request.ts` | Remove unsupported schema fields |
| `assignToolIds()` | `request.ts` | Ensure tool calls have IDs |

### Environment Variables

| Variable | Values | Purpose |
|----------|--------|---------|
| `OPENCODE_ANTIGRAVITY_DEBUG` | `1`, `2` | Debug logging level |
| `OPENCODE_ANTIGRAVITY_QUIET` | `1` | Suppress toast notifications |
| `OPENCODE_ANTIGRAVITY_LOG_DIR` | path | Custom log directory |
| `OPENCODE_ANTIGRAVITY_KEEP_THINKING` | `1` | Preserve thinking blocks for Claude (experimental, may cause signature errors) |

---

## Version History

| Version | Key Changes |
|---------|-------------|
| 2.0 | Strip all thinking blocks for Claude (eliminates signature errors) |
| 1.x | Signature caching/restoration approach (had edge cases) |

---

*Last updated: December 2025*
