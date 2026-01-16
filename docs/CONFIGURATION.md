# Configuration

Full configuration reference for the Antigravity Auth plugin.

Create `~/.config/opencode/antigravity.json` (or `.opencode/antigravity.json` in project root):

```json
{
  "$schema": "https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/main/assets/antigravity.schema.json"
}
```

---

## General Settings

| Option | Default | Description |
|--------|---------|-------------|
| `quiet_mode` | `false` | Suppress toast notifications (except recovery) |
| `debug` | `false` | Enable debug logging to file |
| `log_dir` | OS default | Custom directory for debug logs |
| `auto_update` | `true` | Enable automatic plugin updates |
| `keep_thinking` | `false` | ⚠️ **Experimental.** Preserve Claude's thinking blocks via signature caching. Required for conversation continuity when using thinking models. See [Signature Cache](#signature-cache). |

---

## Session Recovery

| Option | Default | Description |
|--------|---------|-------------|
| `session_recovery` | `true` | Auto-recover from tool_result_missing errors |
| `auto_resume` | `true` | Auto-send resume prompt after recovery |
| `resume_text` | `"continue"` | Text to send when auto-resuming |

---

## Error Recovery

| Option | Default | Description |
|--------|---------|-------------|
| `empty_response_max_attempts` | `4` | Retries for empty API responses |
| `empty_response_retry_delay_ms` | `2000` | Delay between retries |
| `tool_id_recovery` | `true` | Fix mismatched tool IDs from context compaction |
| `claude_tool_hardening` | `true` | Prevent tool parameter hallucination |

---

## Signature Cache

> ⚠️ **Experimental Feature** — Signature caching is experimental and may have edge cases. Please report issues.

When `keep_thinking` is enabled, the plugin caches thinking block signatures to preserve conversation continuity across requests.

| Option | Default | Description |
|--------|---------|-------------|
| `signature_cache.enabled` | `true` | Enable disk caching of thinking block signatures |
| `signature_cache.memory_ttl_seconds` | `3600` | In-memory cache TTL (1 hour) |
| `signature_cache.disk_ttl_seconds` | `172800` | Disk cache TTL (48 hours) |
| `signature_cache.write_interval_seconds` | `60` | Background write interval |

---

## Token Management

| Option | Default | Description |
|--------|---------|-------------|
| `proactive_token_refresh` | `true` | Refresh tokens before expiry |
| `proactive_refresh_buffer_seconds` | `1800` | Refresh 30min before expiry |
| `max_rate_limit_wait_seconds` | `300` | Max wait time when rate limited (0=unlimited) |
| `quota_fallback` | `false` | **Gemini only.** When rate-limited on primary quota pool, try alternate pool before switching accounts. See [Dual Quota Pools](MULTI-ACCOUNT.md#dual-quota-pools). |
| `switch_on_first_rate_limit` | `true` | Switch account immediately on first 429 (after 1s) |

---

## Account Selection

| Option | Default | Description |
|--------|---------|-------------|
| `account_selection_strategy` | `"hybrid"` | Strategy for distributing requests across accounts |
| `pid_offset_enabled` | `false` | Use PID-based offset for multi-session distribution |

### Available Strategies

| Strategy | Behavior | Best For |
|----------|----------|----------|
| `sticky` | Same account until rate-limited | Prompt cache preservation |
| `round-robin` | Rotate to next account on every request | Maximum throughput |
| `hybrid` | Touch all fresh accounts first, then sticky | Sync reset timers + cache |

### Error Handling

| Error Type | Behavior |
|------------|----------|
| `MODEL_CAPACITY_EXHAUSTED` | Wait (escalating 5s→60s) and retry same account |
| `QUOTA_EXCEEDED` | Switch to next available account immediately |

This prevents unnecessary account switching when server-side capacity issues affect all accounts equally.

---

## Health Score

Advanced rate-limiting behavior using a health score per account.

| Option | Default | Description |
|--------|---------|-------------|
| `health_score.initial` | `70` | Starting health score for new accounts |
| `health_score.success_reward` | `1` | Points added on successful request |
| `health_score.rate_limit_penalty` | `-10` | Points removed on rate limit |
| `health_score.failure_penalty` | `-20` | Points removed on failure |
| `health_score.recovery_rate_per_hour` | `2` | Points recovered per hour |
| `health_score.min_usable` | `50` | Minimum score to use account |
| `health_score.max_score` | `100` | Maximum health score |

---

## Token Bucket

Rate limiting using token bucket algorithm.

| Option | Default | Description |
|--------|---------|-------------|
| `token_bucket.max_tokens` | `50` | Maximum tokens in bucket |
| `token_bucket.regeneration_rate_per_minute` | `6` | Tokens regenerated per minute |
| `token_bucket.initial_tokens` | `50` | Starting tokens |

---

## Web Search (Google Search Grounding)

Enable Google Search grounding for Gemini models.

| Option | Default | Description |
|--------|---------|-------------|
| `web_search.default_mode` | `"off"` | `"auto"` or `"off"` |
| `web_search.grounding_threshold` | `0.3` | Dynamic retrieval threshold (0.0-1.0). Higher = search less often. Only applies in `auto` mode. |

---

## Environment Overrides

All options can be set via environment variables

```bash
OPENCODE_ANTIGRAVITY_QUIET=1                              # quiet_mode
OPENCODE_ANTIGRAVITY_DEBUG=1                              # debug (1=basic, 2=verbose)
OPENCODE_ANTIGRAVITY_LOG_DIR=/path                        # log_dir
OPENCODE_ANTIGRAVITY_ACCOUNT_SELECTION_STRATEGY=round-robin  # account_selection_strategy
OPENCODE_ANTIGRAVITY_PID_OFFSET_ENABLED=1                 # pid_offset_enabled
```

---

## Full Example

```json
{
  "$schema": "https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/main/assets/antigravity.schema.json",
  "quiet_mode": false,
  "debug": false,
  "log_dir": "/custom/log/path",
  "auto_update": true,
  "keep_thinking": false,
  "session_recovery": true,
  "auto_resume": true,
  "resume_text": "continue",
  "empty_response_max_attempts": 4,
  "empty_response_retry_delay_ms": 2000,
  "tool_id_recovery": true,
  "claude_tool_hardening": true,
  "proactive_token_refresh": true,
  "proactive_refresh_buffer_seconds": 1800,
  "proactive_refresh_check_interval_seconds": 300,
  "max_rate_limit_wait_seconds": 300,
  "quota_fallback": false,
  "account_selection_strategy": "hybrid",
  "pid_offset_enabled": false,
  "switch_on_first_rate_limit": true,
  "signature_cache": {
    "enabled": true,
    "memory_ttl_seconds": 3600,
    "disk_ttl_seconds": 172800,
    "write_interval_seconds": 60
  },
  "health_score": {
    "initial": 70,
    "success_reward": 1,
    "rate_limit_penalty": -10,
    "failure_penalty": -20,
    "recovery_rate_per_hour": 2,
    "min_usable": 50,
    "max_score": 100
  },
  "token_bucket": {
    "max_tokens": 50,
    "regeneration_rate_per_minute": 6,
    "initial_tokens": 50
  },
  "web_search": {
    "default_mode": "off",
    "grounding_threshold": 0.3
  }
}
```
