# Antigravity + Gemini CLI OAuth Plugin for Opencode

[![npm version](https://img.shields.io/npm/v/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![npm beta](https://img.shields.io/npm/v/opencode-antigravity-auth/beta.svg?label=beta)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Enable Opencode to authenticate against **Antigravity** (Google's IDE) via OAuth so you can use Antigravity rate limits and access models like `gemini-3-pro-high` and `claude-opus-4-5-thinking` with your Google credentials.

## What you get

- **Google OAuth sign-in** with automatic token refresh via `opencode auth login`
- **Dual Quota System** - Access both Antigravity quota (Claude, Gemini 3) and Gemini CLI quota from a single plugin
- **Multi-Account Rotation** - Add multiple Google accounts; automatically rotates when one is rate-limited
- **Real-time SSE streaming** including thinking blocks and incremental output
- **Extended Thinking** - Native support for Claude thinking budgets and Gemini 3 thinking levels
- **Auto Recovery** - Automatic session recovery from Claude tool_result_missing errors
- **Plugin Compatible** - Works alongside other OpenCode plugins (opencodesync, etc.)

## Installation

### For Humans

**Option A: Let an LLM do it**

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the opencode-antigravity-auth plugin and add the Antigravity model definitions to ~/.config/opencode/opencode.json by following: https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/main/README.md
```

**Option B: Manual setup**

1. **Add the plugin to your config** (`~/.config/opencode/opencode.json`):

   ```json
   {
     "plugin": ["opencode-antigravity-auth@1.2.7"]
   }
   ```

2. **Authenticate:**

   ```bash
   opencode auth login
   ```

3. **Add models** (see [Available Models](#available-models) for full list):

   ```json
   {
     "plugin": ["opencode-antigravity-auth@1.2.7"],
     "provider": {
       "google": {
         "models": {
           "antigravity-claude-sonnet-4-5": {
             "name": "Claude Sonnet 4.5 (Antigravity)",
             "limit": { "context": 200000, "output": 64000 },
             "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
           }
         }
       }
     }
   }
   ```

4. **Use it:**

   ```bash
   opencode run "Hello" --model=google/antigravity-claude-sonnet-4-5
   ```

<details>
<summary><b>Installation Guide for LLM Agents</b></summary>

### Step-by-Step Instructions

1. Edit the OpenCode configuration file:
   - Linux/Mac: `~/.config/opencode/opencode.json`
   - Windows: `%APPDATA%\opencode\opencode.json`

2. Add the plugin to the `plugins` array

3. Set `provider` to `"google"` and choose a model

### Complete Configuration Example

Create `~/.config/opencode/opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-antigravity-auth@1.2.7"],
  "provider": {
    "google": {
      "models": {
        "antigravity-gemini-3-pro-low": {
          "name": "Gemini 3 Pro Low (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-gemini-3-pro-high": {
          "name": "Gemini 3 Pro High (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-gemini-3-flash": {
          "name": "Gemini 3 Flash (Antigravity)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-pro-low": {
          "name": "Gemini 3 Pro Low",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-pro-high": {
          "name": "Gemini 3 Pro High",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-flash": {
          "name": "Gemini 3 Flash",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-sonnet-4-5": {
          "name": "Claude Sonnet 4.5 (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-sonnet-4-5-thinking-low": {
          "name": "Claude Sonnet 4.5 Think Low (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-sonnet-4-5-thinking-medium": {
          "name": "Claude Sonnet 4.5 Think Medium (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-sonnet-4-5-thinking-high": {
          "name": "Claude Sonnet 4.5 Think High (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-opus-4-5-thinking-low": {
          "name": "Claude Opus 4.5 Think Low (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-opus-4-5-thinking-medium": {
          "name": "Claude Opus 4.5 Think Medium (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-opus-4-5-thinking-high": {
          "name": "Claude Opus 4.5 Think High (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        }
      }
    }
  }
}
```

### Verification

```bash
opencode run "Hello" --model=google/antigravity-claude-sonnet-4-5
```

</details>

## Available Models

### Antigravity Quota

Models with `antigravity-` prefix use Antigravity quota:

| Model | Description |
|-------|-------------|
| `google/antigravity-gemini-3-flash` | Gemini 3 Flash (minimal thinking) |
| `google/antigravity-gemini-3-pro-low` | Gemini 3 Pro with low thinking |
| `google/antigravity-gemini-3-pro-high` | Gemini 3 Pro with high thinking |
| `google/antigravity-claude-sonnet-4-5` | Claude Sonnet 4.5 (no thinking) |
| `google/antigravity-claude-sonnet-4-5-thinking-low` | Sonnet with 8K thinking budget |
| `google/antigravity-claude-sonnet-4-5-thinking-medium` | Sonnet with 16K thinking budget |
| `google/antigravity-claude-sonnet-4-5-thinking-high` | Sonnet with 32K thinking budget |
| `google/antigravity-claude-opus-4-5-thinking-low` | Opus with 8K thinking budget |
| `google/antigravity-claude-opus-4-5-thinking-medium` | Opus with 16K thinking budget |
| `google/antigravity-claude-opus-4-5-thinking-high` | Opus with 32K thinking budget |

> **Backward compatibility:** Old model names (`gemini-3-pro-low`, `gemini-3-pro-high`, `gemini-3-flash`) still work as a fallback. However, you should update to the `antigravity-` prefix for stability. See [Migration Guide](#migration-guide-v127).

### Gemini CLI Quota

Models with `-preview` suffix use Gemini CLI quota:

| Model | Description |
|-------|-------------|
| `google/gemini-2.5-flash` | Gemini 2.5 Flash |
| `google/gemini-2.5-pro` | Gemini 2.5 Pro |
| `google/gemini-3-flash-preview` | Gemini 3 Flash (preview) |
| `google/gemini-3-pro-preview` | Gemini 3 Pro (preview) |

<details>
<summary><b>Full models configuration</b></summary>

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-antigravity-auth@1.2.7"],
  "provider": {
    "google": {
      "models": {
        "antigravity-gemini-3-pro-low": {
          "name": "Gemini 3 Pro Low (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-gemini-3-pro-high": {
          "name": "Gemini 3 Pro High (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-gemini-3-flash": {
          "name": "Gemini 3 Flash (Antigravity)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-pro-low": {
          "name": "Gemini 3 Pro Low (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-pro-high": {
          "name": "Gemini 3 Pro High (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-flash": {
          "name": "Gemini 3 Flash (Antigravity)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-sonnet-4-5": {
          "name": "Claude Sonnet 4.5 (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-sonnet-4-5-thinking-low": {
          "name": "Claude Sonnet 4.5 Think Low (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-sonnet-4-5-thinking-medium": {
          "name": "Claude Sonnet 4.5 Think Medium (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-sonnet-4-5-thinking-high": {
          "name": "Claude Sonnet 4.5 Think High (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-opus-4-5-thinking-low": {
          "name": "Claude Opus 4.5 Think Low (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-opus-4-5-thinking-medium": {
          "name": "Claude Opus 4.5 Think Medium (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-opus-4-5-thinking-high": {
          "name": "Claude Opus 4.5 Think High (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-2.5-flash": {
          "name": "Gemini 2.5 Flash (CLI)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-2.5-pro": {
          "name": "Gemini 2.5 Pro (CLI)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-flash-preview": {
          "name": "Gemini 3 Flash Preview (CLI)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-pro-preview": {
          "name": "Gemini 3 Pro Preview (CLI)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        }
      }
    }
  }
}
```

</details>

## Multi-Account Setup

Add multiple Google accounts for higher combined quotas. The plugin automatically rotates between accounts when one is rate-limited.

```bash
opencode auth login
```

<details>
<summary><b>How multi-account works</b></summary>

### Load Balancing Behavior

- **Sticky account selection** - Sticks to the same account until rate-limited (preserves Anthropic's prompt cache)
- **Per-model-family limits** - Rate limits tracked separately for Claude and Gemini models
- **Dual quota pools for Gemini** - Automatic fallback between Antigravity quota and Gemini CLI quota before switching accounts
- **Smart retry threshold** - Short rate limits (≤5s) are retried on same account
- **Exponential backoff** - Increasing delays for consecutive rate limits

### Dual Quota Pools (Gemini only)

For Gemini models, the plugin accesses **two independent quota pools** per account:

| Quota Pool | When Used |
|------------|-----------|
| **Antigravity** | Primary (tried first) |
| **Gemini CLI** | Fallback when Antigravity is rate-limited |

This effectively **doubles your Gemini quota** per account.

### Adding Accounts

When running `opencode auth login` with existing accounts:

```
2 account(s) saved:
  1. user1@gmail.com
  2. user2@gmail.com

(a)dd new account(s) or (f)resh start? [a/f]:
```

### Account Storage

- Stored in `~/.config/opencode/antigravity-accounts.json`
- Contains OAuth refresh tokens - **treat like a password**
- If Google revokes a token (`invalid_grant`), that account is automatically removed

</details>

## Configuration

Create `~/.config/opencode/antigravity.json` (or `.opencode/antigravity.json` in project root):

### General Settings

| Option | Default | Description |
|--------|---------|-------------|
| `quiet_mode` | `false` | Suppress toast notifications (except recovery) |
| `debug` | `false` | Enable debug logging to file |
| `log_dir` | OS default | Custom directory for debug logs |
| `auto_update` | `true` | Enable automatic plugin updates |

### Session Recovery

| Option | Default | Description |
|--------|---------|-------------|
| `session_recovery` | `true` | Auto-recover from tool_result_missing errors |
| `auto_resume` | `true` | Auto-send resume prompt after recovery |
| `resume_text` | `"continue"` | Text to send when auto-resuming |

### Error Recovery

| Option | Default | Description |
|--------|---------|-------------|
| `empty_response_max_attempts` | `4` | Retries for empty API responses |
| `empty_response_retry_delay_ms` | `2000` | Delay between retries |
| `tool_id_recovery` | `true` | Fix mismatched tool IDs from context compaction |
| `claude_tool_hardening` | `true` | Prevent tool parameter hallucination |

### Token Management

| Option | Default | Description |
|--------|---------|-------------|
| `proactive_token_refresh` | `true` | Refresh tokens before expiry |
| `proactive_refresh_buffer_seconds` | `1800` | Refresh 30min before expiry |
| `max_rate_limit_wait_seconds` | `300` | Max wait time when rate limited (0=unlimited) |
| `quota_fallback` | `false` | Try alternate quota when rate limited |

### Environment Overrides

```bash
OPENCODE_ANTIGRAVITY_QUIET=1         # quiet_mode
OPENCODE_ANTIGRAVITY_DEBUG=1         # debug
OPENCODE_ANTIGRAVITY_LOG_DIR=/path   # log_dir
OPENCODE_ANTIGRAVITY_KEEP_THINKING=1 # keep_thinking
```

<details>
<summary><b>Full configuration example</b></summary>

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
  "signature_cache": {
    "enabled": true,
    "memory_ttl_seconds": 3600,
    "disk_ttl_seconds": 172800,
    "write_interval_seconds": 60
  }
}
```

</details>

## Known Plugin Interactions

### @tarquinen/opencode-dcp

DCP creates synthetic assistant messages that lack thinking blocks. **Our plugin must be listed BEFORE DCP:**

```json
{
  "plugin": [
    "opencode-antigravity-auth@beta",
    "@tarquinen/opencode-dcp@latest",
  ]
}
```

### oh-my-opencode

When spawning parallel subagents, multiple processes may select the same account causing rate limit errors. **Workaround:** Add more accounts via `opencode auth login`.

### Plugins You Don't Need

- **gemini-auth plugins** - Not needed. This plugin handles all Google OAuth authentication.

<details>
<summary><b>Migration Guide (v1.2.7+)</b></summary>

If upgrading from v1.2.6 or earlier:

### What Changed

v1.2.7+ uses explicit prefixes to distinguish quota sources:

| Model Type | New Name (Recommended) | Old Name (Still Works) |
|------------|------------------------|------------------------|
| Gemini 3 (Antigravity) | `antigravity-gemini-3-pro-low` | `gemini-3-pro-low` |
| Gemini 3 (Antigravity) | `antigravity-gemini-3-pro-high` | `gemini-3-pro-high` |
| Gemini 3 (Antigravity) | `antigravity-gemini-3-flash` | `gemini-3-flash` |
| Gemini 3 (CLI) | `gemini-3-pro-preview` | N/A |
| Claude | `antigravity-claude-sonnet-4-5` | `claude-sonnet-4-5` |

### Action Required

**Update your config to use `antigravity-` prefix:**

```diff
- "gemini-3-pro-low": { ... }
+ "antigravity-gemini-3-pro-low": { ... }
```

> **Why update?** Old names work now as a fallback, but this depends on Gemini CLI using `-preview` suffix. If Google removes `-preview` in the future, old names may route to the wrong quota. The `antigravity-` prefix is explicit and stable.

### Step 1: Clear Old Tokens (Optional - do this if you have issues calling models)

```bash
rm -rf ~/.config/opencode/antigravity-account.json
opencode auth login
```

### Step 2: Update opencode.json

Models now use `antigravity-` prefix for Antigravity quota. See [Available Models](#available-models).

### Step 3: Create antigravity.json (Optional)

```json
{
  "$schema": "https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/main/assets/antigravity.schema.json",
  "quiet_mode": false,
  "debug": false
}
```

</details>

<details>
<summary><b>E2E Testing</b></summary>

The plugin includes regression tests for stability verification. Tests consume API quota.

```bash
# Sanity tests (7 tests, ~5 min)
npx tsx script/test-regression.ts --sanity

# Heavy tests (4 tests, ~30 min)
npx tsx script/test-regression.ts --heavy

# Concurrent tests (3 tests)
npx tsx script/test-regression.ts --category concurrency

# Run specific test
npx tsx script/test-regression.ts --test thinking-tool-use

# List tests without running
npx tsx script/test-regression.ts --dry-run
```

</details>

## Debugging

```bash
OPENCODE_ANTIGRAVITY_DEBUG=1 opencode   # Basic logging
OPENCODE_ANTIGRAVITY_DEBUG=2 opencode   # Verbose (full request/response bodies)
```

Logs are written to `~/.config/opencode/antigravity-logs/`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - Plugin internals and request flow
- [API Spec](docs/ANTIGRAVITY_API_SPEC.md) - Antigravity API reference

<details>
<summary><b>Safety, Usage & Legal</b></summary>

### Intended Use

- Personal / internal development only
- Respect internal quotas and data handling policies
- Not for production services or bypassing intended limits

### Warning (Assumption of Risk)

By using this plugin, you acknowledge:

- **Terms of Service risk** - This approach may violate ToS of AI model providers
- **Account risk** - Providers may suspend or ban accounts
- **No guarantees** - APIs may change without notice
- **Assumption of risk** - You assume all legal, financial, and technical risks

### Legal

- Not affiliated with Google. This is an independent open-source project.
- "Antigravity", "Gemini", "Google Cloud", and "Google" are trademarks of Google LLC.
- Software is provided "as is", without warranty.

</details>

## Credits

Built with help from:

- [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) - Gemini OAuth groundwork by [@jenslys](https://github.com/jenslys)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) - Antigravity API reference

## Support

If this plugin helps you, consider supporting its continued maintenance:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/S6S81QBOIR)

## License

MIT
