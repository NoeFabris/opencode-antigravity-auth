# Support Matrix

**Last Updated:** May 2026
**Plugin Version:** 1.7.0-beta.0

This document describes what each transport mode supports, which models work, how credentials are stored, and how rate limits behave.

---

## Transport Decision

| Transport | Default | Status | When to use |
|-----------|---------|--------|-------------|
| `gateway` | ✅ Yes | Stable | All normal use. Full streaming, tool calls, multi-account, quota rotation. |
| `cli` | No | Experimental / opt-in | High-level agent tasks via official Antigravity CLI. No tool calls. |
| `managed-agent` | No | Experimental / opt-in | API-key billing path via public Managed Agents API. No tool calls. |

**Recommendation:** Keep `gateway` as default. The gateway transport is the only mode that supports OpenCode's full tool-call and streaming protocol. The other transports are opt-in experiments.

---

## Feature Support by Transport

| Feature | `gateway` | `cli` | `managed-agent` |
|---------|-----------|-------|-----------------|
| Streaming (SSE) | ✅ | ❌ | ⚠️ passthrough only |
| Tool calls | ✅ | ❌ | ❌ |
| Multi-turn conversation | ✅ | ❌ | ⚠️ via `previous_interaction_id` |
| Thinking blocks (Claude) | ✅ | ❌ | ❌ |
| Google Search grounding | ✅ | ❌ | ✅ (agent built-in) |
| Multi-account rotation | ✅ | ❌ | ❌ |
| Quota fallback (dual pool) | ✅ | ❌ | ❌ |
| Endpoint fallback | ✅ | ❌ | ❌ |
| OAuth auth | ✅ | ❌ (agy handles own auth) | ❌ |
| API key auth | ❌ | ❌ | ✅ |
| Rate limit backoff | ✅ | ❌ | ❌ |
| Session recovery | ✅ | ❌ | ❌ |
| Schema sanitization | ✅ | ❌ | ❌ |
| Debug logging | ✅ | ⚠️ partial | ⚠️ partial |

---

## Model Support by Transport

### `gateway` transport

| Model family | Variants | Notes |
|---|---|---|
| Gemini 3.1 Pro | `antigravity-gemini-3.1-pro-low`, `antigravity-gemini-3.1-pro-high` | Current quota rows |
| Gemini 3.5 Flash | `antigravity-gemini-3.5-flash-low`, `antigravity-gemini-3.5-flash-low` | Current quota rows |
| Claude Sonnet 4.6 | `antigravity-claude-sonnet-4-6` | Current quota row |
| Claude Opus 4.6 Thinking | `antigravity-claude-opus-4-6-thinking` | Current quota row |
| GPT-OSS 120B Medium | `antigravity-gpt-oss-120b-medium` | Current quota row |
| Google Search grounding | Via `google_search` tool | Gemini models only |
| Image generation | ❌ | Not supported via gateway |

Gemini CLI models are not listed by default because individual/free Gemini CLI access sunsets on **2026-06-18**. Legacy resolver support remains for existing configs only.

### `cli` transport

| Model | Support | Notes |
|---|---|---|
| Any model `agy` supports | ⚠️ Text only | agy selects model internally; no model routing from OpenCode |
| Tool calls | ❌ | Not forwarded |
| Streaming | ❌ | stdout collected after completion |

### `managed-agent` transport

| Model | Support | Notes |
|---|---|---|
| `antigravity-preview-05-2026` | ✅ Text | Base agent only (preview) |
| Custom managed agents | ❌ | Not yet supported |
| Tool calls | ❌ | Agent handles tools internally |
| Streaming | ⚠️ passthrough | SSE passed as-is; normalization pending |

---

## Credential and Account Storage

### `gateway` transport

| Item | Location | Format |
|---|---|---|
| OAuth refresh tokens | `~/.config/opencode/antigravity-accounts.json` | JSON, unencrypted |
| Access tokens | In-memory only | Refreshed automatically |
| Device fingerprints | `~/.config/opencode/antigravity-accounts.json` | Per-account, max 5 history |
| Project IDs | `~/.config/opencode/antigravity-accounts.json` | Resolved via `loadCodeAssist` |
| Signature cache | `~/.config/opencode/antigravity-signatures/` | Disk-backed, TTL 48h |

Multiple accounts are supported. Accounts rotate automatically on rate limits.

### `cli` transport

| Item | Location | Notes |
|---|---|---|
| OAuth credentials | System keyring (managed by `agy`) | Plugin has no access |
| Config | `~/.gemini/config/` | Managed by `agy` |
| Logs | `~/.gemini/antigravity-cli/log/` | Or custom `log_file` |

The plugin does **not** read, write, or manage `agy` credentials.

### `managed-agent` transport

| Item | Location | Notes |
|---|---|---|
| API key | Config file only (`transport.managed_agent.api_key`) | Never stored by plugin |
| No accounts | — | Single API key, no rotation |

---

## Rate Limit Behavior

### `gateway` transport

| Scenario | Behavior |
|---|---|
| 429 rate limit | Exponential backoff (5s → 60s), account rotation |
| 503 overloaded | Backoff + retry |
| 529 capacity | Fingerprint regeneration + retry |
| All accounts rate-limited | Wait for shortest cooldown, show toast |
| Gemini CLI quota exhausted | Legacy fallback only; new default configs avoid Gemini CLI models |
| Soft quota threshold | Skip account until quota refreshes |

Deduplication window: 120s. Max wait: configurable via `max_rate_limit_wait_seconds` (default 300s).

### `cli` transport

| Scenario | Behavior |
|---|---|
| agy timeout | 504 `DEADLINE_EXCEEDED` |
| agy not authenticated | 401 `UNAUTHENTICATED` |
| agy process error | 502 `AGY_PROCESS_ERROR` |
| Rate limits | Handled internally by `agy` — plugin has no visibility |

### `managed-agent` transport

| Scenario | Behavior |
|---|---|
| API error | HTTP status forwarded as-is |
| Rate limits | No retry, no rotation — single API key |
| Billing exceeded | API returns error, forwarded to OpenCode |

---

## Migration Notes for Existing Users

### Upgrading from v1.6.x to 1.7.0-beta.0

**No breaking changes.** The default transport is still `gateway`. All existing accounts, tokens, and config continue to work.

**New in this release:**
- OAuth now includes `openid` scope (harmless addition, no re-auth required)
- Primary endpoint updated to `daily-cloudcode-pa.googleapis.com` (non-sandbox, matches official `agy` CLI)
- Transport boundary introduced — behavior unchanged, but architecture is now extensible
- Two new opt-in transports: `cli` and `managed-agent` (both disabled by default)

**If you were using `gemini-cli` header style:**
The `gemini-cli` quota pool is at risk after the Gemini CLI sunset on **2026-06-18**. If requests start failing after that date, disable `quota_fallback` and rely on the `antigravity` header style only.

**If you stored accounts before this release:**
Existing accounts load without changes. The new `openid` scope is only requested on new OAuth flows.

---

## Rollback

| Scenario | Action |
|---|---|
| New endpoint breaks | Set `OPENCODE_ANTIGRAVITY_ENDPOINT_OVERRIDE` or revert to previous npm version |
| OAuth fails after update | Re-run `opencode auth login` to get a fresh token with updated scopes |
| Transport experiment fails | Set `transport.id: "gateway"` in config |
| Full rollback | `npm install opencode-antigravity-auth@1.6.0` |
