# Antigravity + Gemini CLI OAuth Plugin for Opencode

[![npm version](https://img.shields.io/npm/v/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![npm beta](https://img.shields.io/npm/v/opencode-antigravity-auth/beta.svg?label=beta)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Enable Opencode to authenticate against **Antigravity** (Google's IDE) via OAuth so you can use Antigravity rate limits and access models like `gemini-3-pro` and `claude-opus-4-5-thinking` with your Google credentials.

## What you get

- **Google OAuth sign-in** with automatic token refresh via `opencode auth login`
- **Dual Quota System** - Access both Antigravity quota (Claude, Gemini 3) and Gemini CLI quota from a single plugin
- **Multi-Account Rotation** - Add multiple Google accounts; automatically rotates when one is rate-limited
- **Real-time SSE streaming** including thinking blocks and incremental output
- **Model Variants** - Configure thinking budget dynamically via OpenCode's variant system
- **Extended Thinking** - Native support for Claude thinking budgets and Gemini 3 thinking levels
- **Auto Recovery** - Automatic session recovery from Claude tool_result_missing errors
- **Plugin Compatible** - Works alongside other OpenCode plugins (opencodesync, etc.)

## Installation

### For Humans

**Option A: Let an LLM do it**

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the opencode-antigravity-auth plugin and add the Antigravity model definitions to ~/.config/opencode/opencode.json by following: https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/dev/README.md
```

**Option B: Manual setup**

1. **Add the plugin to your config** (`~/.config/opencode/opencode.json`):

   ```json
   {
     "plugin": ["opencode-antigravity-auth@beta"]
   }
   ```

2. **Authenticate:**

   ```bash
   opencode auth login
   ```

3. **Add models** (see [Available Models](#available-models) for full list):

   ```json
   {
     "plugin": ["opencode-antigravity-auth@beta"],
     "provider": {
       "google": {
         "models": {
            "antigravity-claude-sonnet-4-5-thinking": {
              "name": "Claude Sonnet 4.5 Thinking",
              "limit": { "context": 200000, "output": 64000 },
              "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
              "variants": {
                "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
                "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
              }
            }
         }
       }
     }
   }
   ```

4. **Use it:**

   ```bash
   opencode run "Hello" --model=google/antigravity-claude-sonnet-4-5-thinking --variant=max
   ```

<details>
<summary><b>Installation Guide for LLM Agents</b></summary>

### Step-by-Step Instructions

1. Edit the OpenCode configuration file:
   - Linux/Mac/Windows: `~/.config/opencode/opencode.json`
   > **Note**: On Windows, `~` resolves to your User Home directory (e.g., `C:\Users\YourName`).

2. Add the plugin to the `plugins` array

3. Set `provider` to `"google"` and choose a model

### Complete Configuration Example

Create `~/.config/opencode/opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-antigravity-auth@beta"],
  "provider": {
    "google": {
      "models": {
        "antigravity-gemini-3-pro": {
          "name": "Gemini 3 Pro (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingLevel": "low" },
            "high": { "thinkingLevel": "high" }
          }
        },
        "antigravity-gemini-3-flash": {
          "name": "Gemini 3 Flash (Antigravity)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "minimal": { "thinkingLevel": "minimal" },
            "low": { "thinkingLevel": "low" },
            "medium": { "thinkingLevel": "medium" },
            "high": { "thinkingLevel": "high" }
          }
        },
        "antigravity-claude-sonnet-4-5": {
          "name": "Claude Sonnet 4.5 (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-sonnet-4-5-thinking": {
          "name": "Claude Sonnet 4.5 Thinking (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "antigravity-claude-opus-4-5-thinking": {
          "name": "Claude Opus 4.5 Thinking (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "gemini-2.5-flash": {
          "name": "Gemini 2.5 Flash (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-2.5-pro": {
          "name": "Gemini 2.5 Pro (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-flash-preview": {
          "name": "Gemini 3 Flash Preview (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-pro-preview": {
          "name": "Gemini 3 Pro Preview (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        }
      }
    }
  }
}
```

### Verification

```bash
opencode run "Hello" --model=google/antigravity-claude-sonnet-4-5-thinking --variant=max
```

</details>

## Available Models

### Antigravity Quota (with Variants)

Models with `antigravity-` prefix use Antigravity quota. **Thinking models support variants** for dynamic thinking budget configuration:

| Model | Variants | Description |
|-------|----------|-------------|
| `google/antigravity-gemini-3-pro` | low, high | Gemini 3 Pro with configurable thinking |
| `google/antigravity-gemini-3-flash` | minimal, low, medium, high | Gemini 3 Flash with configurable thinking |
| `google/antigravity-claude-sonnet-4-5` | - | Claude Sonnet 4.5 (no thinking) |
| `google/antigravity-claude-sonnet-4-5-thinking` | low, max | Claude Sonnet with configurable thinking |
| `google/antigravity-claude-opus-4-5-thinking` | low, max | Claude Opus with configurable thinking |

**Variant configuration:**
- **Gemini 3**: Uses `thinkingLevel` string (`"low"`, `"medium"`, `"high"`)
- **Claude**: Uses `thinkingBudget` number (8192, 32768 tokens)

**Usage:**
```bash
opencode run "Hello" --model=google/antigravity-claude-sonnet-4-5-thinking --variant=max
```

### Gemini CLI Quota

Models with `-preview` suffix use Gemini CLI quota:

| Model | Description |
|-------|-------------|
| `google/gemini-2.5-flash` | Gemini 2.5 Flash |
| `google/gemini-2.5-pro` | Gemini 2.5 Pro |
| `google/gemini-3-flash-preview` | Gemini 3 Flash (preview) |
| `google/gemini-3-pro-preview` | Gemini 3 Pro (preview) |

<details>
<summary><b>Full models configuration (copy-paste ready)</b></summary>

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-antigravity-auth@beta"],
  "provider": {
    "google": {
      "models": {
        "antigravity-gemini-3-pro": {
          "name": "Gemini 3 Pro (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingLevel": "low" },
            "high": { "thinkingLevel": "high" }
          }
        },
        "antigravity-gemini-3-flash": {
          "name": "Gemini 3 Flash (Antigravity)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "minimal": { "thinkingLevel": "minimal" },
            "low": { "thinkingLevel": "low" },
            "medium": { "thinkingLevel": "medium" },
            "high": { "thinkingLevel": "high" }
          }
        },
        "antigravity-claude-sonnet-4-5": {
          "name": "Claude Sonnet 4.5 (no thinking) (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-sonnet-4-5-thinking": {
          "name": "Claude Sonnet 4.5 Thinking (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "antigravity-claude-opus-4-5-thinking": {
          "name": "Claude Opus 4.5 Thinking (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "gemini-2.5-flash": {
          "name": "Gemini 2.5 Flash (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-2.5-pro": {
          "name": "Gemini 2.5 Pro (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-flash-preview": {
          "name": "Gemini 3 Flash Preview (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-pro-preview": {
          "name": "Gemini 3 Pro Preview (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        }
      }
    }
  }
}
```

</details>

## Model Variants

OpenCode's variant system allows you to configure thinking budget dynamically instead of defining separate models for each thinking level.

### How Variants Work

When you define a model with `variants`, OpenCode will show variant options in the model picker. Selecting a variant passes the `providerOptions` to the plugin, which extracts the thinking configuration.

### Variant Configuration

```json
{
  "antigravity-claude-sonnet-4-5-thinking": {
    "name": "Claude Sonnet 4.5 Thinking",
    "limit": { "context": 200000, "output": 64000 },
    "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
    "variants": {
      "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
      "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
    }
  }
}
```

### Supported Variant Formats

The plugin accepts different variant formats depending on the model family:

| Model Family | Variant Format |
|--------------|----------------|
| **Gemini 3** | `{ "thinkingLevel": "low" \| "medium" \| "high" }` |
| **Claude** | `{ "thinkingConfig": { "thinkingBudget": N } }` |
| **Gemini 2.5** | `{ "thinkingConfig": { "thinkingBudget": N } }` |

### Gemini 3 Thinking Levels

Gemini 3 models use string-based thinking levels. Available levels differ by model:

| Level | Flash | Pro | Description |
|-------|-------|-----|-------------|
| `minimal` | Yes | No | Minimal thinking, lowest latency |
| `low` | Yes | Yes | Light thinking |
| `medium` | Yes | No | Balanced thinking |
| `high` | Yes | Yes | Maximum thinking (default for both Pro and Flash) |

> **Note:** The API will reject invalid levels (e.g., `"minimal"` on Pro). Configure variants accordingly.

### Legacy Budget Format (Deprecated)

For Gemini 3 models, the old `thinkingBudget` format is still supported but deprecated:

| Budget Range | Maps to Level |
|--------------|---------------|
| ≤ 8192 | low |
| ≤ 16384 | medium |
| > 16384 | high |

### Backward Compatibility

Legacy tier-suffixed models still work:
- `antigravity-claude-sonnet-4-5-thinking-low`
- `antigravity-claude-sonnet-4-5-thinking-medium`
- `antigravity-claude-sonnet-4-5-thinking-high`
- `antigravity-gemini-3-pro-low`
- `antigravity-gemini-3-pro-high`

However, **we recommend using variants** for a cleaner model picker and more flexibility.

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
| `keep_thinking` | `false` | ⚠️ **Experimental.** Preserve Claude's thinking blocks via signature caching. Required for conversation continuity when using thinking models. See [Signature Cache](#signature-cache) for cache settings. |

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

### Signature Cache

> ⚠️ **Experimental Feature** - Signature caching is experimental and may have edge cases. Please report issues.

When `keep_thinking` is enabled, the plugin caches thinking block signatures to preserve conversation continuity across requests.

| Option | Default | Description |
|--------|---------|-------------|
| `signature_cache.enabled` | `true` | Enable disk caching of thinking block signatures |
| `signature_cache.memory_ttl_seconds` | `3600` | In-memory cache TTL (1 hour) |
| `signature_cache.disk_ttl_seconds` | `172800` | Disk cache TTL (48 hours) |
| `signature_cache.write_interval_seconds` | `60` | Background write interval |

### Token Management

| Option | Default | Description |
|--------|---------|-------------|
| `proactive_token_refresh` | `true` | Refresh tokens before expiry |
| `proactive_refresh_buffer_seconds` | `1800` | Refresh 30min before expiry |
| `max_rate_limit_wait_seconds` | `300` | Max wait time when rate limited (0=unlimited) |
| `quota_fallback` | `false` | **Gemini only.** When rate-limited on primary quota pool (Antigravity or Gemini CLI), automatically try the alternate pool before switching accounts. Effectively doubles retry attempts per account. See [Dual Quota Pools](#dual-quota-pools-gemini-only). |
| `switch_on_first_rate_limit` | `true` | Switch account immediately on first 429 (after 1s) |

### Account Selection

| Option | Default | Description |
|--------|---------|-------------|
| `account_selection_strategy` | `"sticky"` | Strategy for distributing requests across accounts |
| `pid_offset_enabled` | `false` | Use PID-based offset for multi-session distribution |

**Available strategies:**

| Strategy | Behavior | Best For |
|----------|----------|----------|
| `sticky` | Same account until rate-limited | Prompt cache preservation |
| `round-robin` | Rotate to next account on every request | Maximum throughput |
| `hybrid` | Touch all fresh accounts first, then sticky | Sync reset timers + cache |

**Error handling:**

| Error Type | Behavior |
|------------|----------|
| `MODEL_CAPACITY_EXHAUSTED` | Wait (escalating 5s→60s) and retry same account |
| `QUOTA_EXCEEDED` | Switch to next available account immediately |

This prevents unnecessary account switching when server-side capacity issues affect all accounts equally.

### Environment Overrides

```bash
OPENCODE_ANTIGRAVITY_QUIET=1                              # quiet_mode
OPENCODE_ANTIGRAVITY_DEBUG=1                              # debug
OPENCODE_ANTIGRAVITY_LOG_DIR=/path                        # log_dir
OPENCODE_ANTIGRAVITY_KEEP_THINKING=1                      # keep_thinking
OPENCODE_ANTIGRAVITY_ACCOUNT_SELECTION_STRATEGY=round-robin  # account_selection_strategy
OPENCODE_ANTIGRAVITY_PID_OFFSET_ENABLED=1                 # pid_offset_enabled
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
  "account_selection_strategy": "sticky",
  "pid_offset_enabled": false,
  "signature_cache": {
    "enabled": true,
    "memory_ttl_seconds": 3600,
    "disk_ttl_seconds": 172800,
    "write_interval_seconds": 60
  }
}
```

</details>

## Troubleshoot

### Multi account auth issues
If you encounter auth issue please try remove `antigravity-account.json` and auth again

### Gemini model not found
Try add this line to in `google` field under `provider`
`"npm": "@ai-sdk/google"`

### Error during the session
If you encounter error during the session, try chat `continue` the recover session mechanism should be trigger and you can continue the session, if the error blocked the session please workaround by use command `/undo` to revert to the state before the error and try again it should work

### Error using Gemini CLI models
When using Gemini CLI models, you may come across an error with the below text: 
> Permission 'cloudaicompanion.companions.generateChat' denied on resource '//cloudaicompanion.googleapis.com/projects/rising-fact-p41fc/locations/global' (or it may not exist).

The plugin attempts to provision or find a suitable Google Cloud project when authenticating with Antigravity. If none is found, it defaults to a predefined project ID set by the `ANTIGRAVITY_DEFAULT_PROJECT_ID` variable in this project. While this works for Antigravity, Gemini CLI throws an error because this project ID does not exist in your Google Cloud account.

For it to work, you can follow similar steps in [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth?tab=readme-ov-file#manual-google-cloud-setup):
* Go to the [Google Cloud Console](https://console.cloud.google.com/).
* Create or select a project.
* Enable the Gemini for Google Cloud API (cloudaicompanion.googleapis.com).
* Configure the projectId in your Opencode config as shown above. 

Then you add the project ID to your `~/.config/opencode/antigravity-accounts.json` setup under your account, you can add it as a `projectId` field:
```json
{
  "version": 3,
  "accounts": [
    {
      "email": "<<your email>>",
      "refreshToken": "<<your refresher token>>",
      "projectId": "<<place project ID here>>"
    }
  ],
  "activeIndex": 0,
  "activeIndexByFamily": {
    "claude": 0,
    "gemini": 0
  }
}
```

**Note**: This would have to be done per account if you have a multi-account setup. 

<details>
<summary><b>Safari OAuth Callback Fails (macOS)</b></summary>

**Symptoms:**
- "fail to authorize" after successful Google login in browser
- Safari shows "Safari can't open the page" or connection refused
- Callback appears to succeed in browser but plugin reports failure

**Cause:** Safari's "HTTPS-Only Mode" (enabled by default in recent macOS versions) blocks the `http://localhost` callback URL used during OAuth authentication.

**Solutions (choose one):**

1. **Use a different browser** (easiest):
   Copy the URL printed by `opencode auth login` and paste it into Chrome or Firefox instead of Safari.

2. **Temporarily disable HTTPS-Only Mode:**
   - Safari > Settings (⌘,) > Privacy
   - Uncheck "Enable HTTPS-Only Mode"
   - Run `opencode auth login`
   - Re-enable after successful authentication

3. **Manual callback URL extraction** (advanced):
   - When Safari shows the error, look at the address bar
   - The URL should contain `?code=...&scope=...`
   - This auth code can be used manually (see [issue #119](https://github.com/NoeFabris/opencode-antigravity-auth/issues/119) for updates on manual auth support)

</details>

<details>
<summary><b>Port Already in Use</b></summary>

If OAuth fails with "Address already in use" or similar port binding errors:

**macOS / Linux:**
```bash
# Find what's using the OAuth callback port (usually 8080 or dynamic)
# Try common ports (8080, 3000, 5000) or omit port for a full list
lsof -i :8080  # or: lsof -i -P -n | grep LISTEN

# If a stale process is found, terminate it
kill -9 <PID>

# Retry authentication
opencode auth login
```

**Windows (PowerShell / Command Prompt):**
```powershell
# Find what's using the port
netstat -ano | findstr :8080

# Terminate the process (replace <PID> with the actual process ID)
taskkill /PID <PID> /F

# Retry authentication
opencode auth login
```

</details>

<details>
<summary><b>WSL2 / Remote Development</b></summary>

For users running OpenCode in WSL2 or over SSH:
- The OAuth callback requires the browser to reach `localhost` on the machine running OpenCode
- For WSL2: Ensure port forwarding is configured, or use VS Code's port forwarding
- For SSH: Use SSH port forwarding: `ssh -L 8080:localhost:8080 user@remote`
- For headless servers: See [issue #119](https://github.com/NoeFabris/opencode-antigravity-auth/issues/119) for manual URL auth (in development)

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
When using opencode-antigravity-auth, disable the built-in auth and override agent models in oh-my-opencode.json:
```json
{
  "google_auth": false,
  "agents": {
    "frontend-ui-ux-engineer": { "model": "google/gemini-3-pro-high" },
    "document-writer": { "model": "google/gemini-3-flash" },
    "multimodal-looker": { "model": "google/gemini-3-flash" }
  }
}
```

When spawning parallel subagents, multiple processes may select the same account causing rate limit errors. **Workaround:** Enable `pid_offset_enabled: true` to distribute sessions across accounts, or add more accounts via `opencode auth login`.

### Plugins You Don't Need

- **gemini-auth plugins** - Not needed. This plugin handles all Google OAuth authentication.

<details>
<summary><b>Migration Guide (v1.2.8+ - Variants)</b></summary>

### What Changed

v1.2.8+ introduces **model variants** for dynamic thinking configuration. Instead of separate models for each thinking level, you now define one model with variants.

### Before (v1.2.7)

```json
{
  "antigravity-claude-sonnet-4-5-thinking-low": { ... },
  "antigravity-claude-sonnet-4-5-thinking-medium": { ... },
  "antigravity-claude-sonnet-4-5-thinking-high": { ... }
}
```

### After (v1.2.8+)

```json
{
  "antigravity-claude-sonnet-4-5-thinking": {
    "name": "Claude Sonnet 4.5 Thinking",
    "limit": { "context": 200000, "output": 64000 },
    "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
    "variants": {
      "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
      "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
    }
  }
}
```

### Benefits

- **Cleaner model picker** - 4 models instead of 12+
- **Flexible budgets** - Define any budget, not just low/max
- **Future-proof** - Works with OpenCode's native variant system

### Backward Compatibility

Old tier-suffixed models (`antigravity-claude-sonnet-4-5-thinking-low`, etc.) still work. No action required if you prefer the old style.

</details>

<details>
<summary><b>Migration Guide (v1.2.7 - Prefix)</b></summary>

If upgrading from v1.2.6 or earlier:

### What Changed

v1.2.7+ uses explicit prefixes to distinguish quota sources:

| Model Type | New Name (Recommended) | Old Name (Still Works) |
|------------|------------------------|------------------------|
| Gemini 3 (Antigravity) | `antigravity-gemini-3-pro` | `gemini-3-pro-low` |
| Gemini 3 (CLI) | `gemini-3-pro-preview` | N/A |
| Claude | `antigravity-claude-sonnet-4-5` | `claude-sonnet-4-5` |

### Action Required

**Update your config to use `antigravity-` prefix:**

```diff
- "gemini-3-pro-low": { ... }
+ "antigravity-gemini-3-pro": { ... }
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
