# Antigravity + Gemini CLI OAuth Plugin for Opencode

[![npm version](https://img.shields.io/npm/v/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/opencode-antigravity-auth)

Enable Opencode to authenticate against **Antigravity** (Google's IDE) via OAuth so you can use Antigravity rate limits and access models like `gemini-3-pro-high` and `claude-opus-4-5-thinking` with your Google credentials.

## What you get

- **Google OAuth sign-in** (multi-account via `opencode auth login`) with automatic token refresh
- **Multi-account load balancing** Automatically cycle through multiple Google accounts to maximize throughput
- **Two quota sources for Gemini** Automatic fallback between **Antigravity quota** and **Gemini CLI quota** (same account) before switching accounts
- **Real-time SSE streaming** including thinking blocks and incremental output
- **Advanced Claude support** Interleaved thinking, stable multi-turn signatures, and validated tool calling
- **Automatic endpoint fallback** between Antigravity API endpoints (daily → autopush → prod)
- **Antigravity API compatibility** for OpenAI-style requests
- **Debug logging** for requests and responses
- **Drop-in setup** Opencode auto-installs the plugin from config

## Installation

### For Humans

**Option A: Let an LLM do it for you**

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the opencode-antigravity-auth plugin and add the Antigravity model definitions (see "Available models") to ~/.config/opencode/opencode.json by following: https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/main/README.md
```

If the agent only installs the plugin, ask it to also add models under `provider.google.models`.

**Option B: Do it yourself**

1. **Add the plugin to your config:**

   ```bash
   mkdir -p ~/.config/opencode
   ```

   Create or edit `~/.config/opencode/opencode.json`:

   ```json
   {
     "plugin": ["opencode-antigravity-auth@1.2.4"]
   }
   ```

2. **Authenticate:**

   ```bash
   opencode auth login
   ```

   Select **Google** → **OAuth with Google (Antigravity)** → Press Enter to skip Project ID → Sign in via browser.

3. **Add models to your config:**

   Add the models you want to use to the same config file:

   ```json
   {
     "plugin": ["opencode-antigravity-auth@1.2.4"],
     "provider": {
       "google": {
         "models": {
           "gemini-3-pro-high": {
             "name": "Gemini 3 Pro High (Antigravity)",
             "limit": { "context": 1048576, "output": 65535 },
             "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
           },
           "claude-sonnet-4-5": {
             "name": "Claude Sonnet 4.5 (Antigravity)",
             "limit": { "context": 200000, "output": 64000 },
             "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
           }
         }
       }
     }
   }
   ```

   > See [Available models](#available-models) for the full list.

4. **Use it:**

   ```bash
   opencode run "Hello" --model=google/gemini-3-pro-high
   ```

---

### For LLMs

<details>
<summary><b>🤖 Detailed Installation Guide for LLM Agents</b> (click to expand)</summary>

If you're an LLM agent helping a user set up this plugin, follow these steps:

#### Step 1: Verify OpenCode is installed

```bash
command -v opencode && opencode --version || echo "OpenCode not installed - see https://opencode.ai/docs"
```

#### Step 2: Create or update the config

```bash
mkdir -p ~/.config/opencode

if [ -f ~/.config/opencode/opencode.json ]; then
    if command -v jq &> /dev/null; then
        jq '.plugin = ((.plugin // []) + ["opencode-antigravity-auth@1.2.4"] | unique)' \
            ~/.config/opencode/opencode.json > /tmp/oc.json && \
            mv /tmp/oc.json ~/.config/opencode/opencode.json
    else
        echo "Add \"opencode-antigravity-auth@1.2.4\" to the plugin array manually"
    fi
else
    echo '{"plugin":["opencode-antigravity-auth@1.2.4"]}' > ~/.config/opencode/opencode.json
fi
```

#### Step 3: Ask user about multi-account setup

Before running `opencode auth login`, ask the user:

> **Do you want to add multiple Google accounts for load balancing?**
> - Adding 2-10 accounts maximizes rate limits and provides automatic failover
> - You can always add more accounts later

Based on their answer:
- **Yes, multiple accounts** → After first login, prompt: "Sign in complete. Add another account? (up to 10 supported)"
- **No, just one** → Single account is fine, they can add more later with `opencode auth login`

#### Step 4: Run authentication

Tell the user to run:

```bash
opencode auth login
```

Guide them through the prompts:
1. Select **Google** as the provider
2. Select **OAuth with Google (Antigravity)**
3. **Project ID prompt** → Tell user: "Press Enter to skip (most users don't need this)"
4. Browser opens for Google sign-in
5. If multi-account: repeat for additional accounts, or press Enter to finish

#### Step 5: Add models to config

Merge model definitions into the user's config file (`~/.config/opencode/opencode.json`):

```bash
# If jq is available, merge models programmatically
if command -v jq &> /dev/null; then
    jq '.provider.google.models = {
      "gemini-3-pro-high": {"name": "Gemini 3 Pro High (Antigravity)", "limit": {"context": 1048576, "output": 65535}, "modalities": {"input": ["text", "image", "pdf"], "output": ["text"]}},
      "gemini-3-pro-low": {"name": "Gemini 3 Pro Low (Antigravity)", "limit": {"context": 1048576, "output": 65535}, "modalities": {"input": ["text", "image", "pdf"], "output": ["text"]}},
      "gemini-3-flash": {"name": "Gemini 3 Flash (Antigravity)", "limit": {"context": 1048576, "output": 65536}, "modalities": {"input": ["text", "image", "pdf"], "output": ["text"]}},
      "claude-sonnet-4-5": {"name": "Claude Sonnet 4.5 (Antigravity)", "limit": {"context": 200000, "output": 64000}, "modalities": {"input": ["text", "image", "pdf"], "output": ["text"]}},
      "claude-sonnet-4-5-thinking": {"name": "Claude Sonnet 4.5 Thinking (Antigravity)", "limit": {"context": 200000, "output": 64000}, "modalities": {"input": ["text", "image", "pdf"], "output": ["text"]}},
      "claude-opus-4-5-thinking": {"name": "Claude Opus 4.5 Thinking (Antigravity)", "limit": {"context": 200000, "output": 64000}, "modalities": {"input": ["text", "image", "pdf"], "output": ["text"]}},
      "gpt-oss-120b-medium": {"name": "GPT-OSS 120B Medium (Antigravity)", "limit": {"context": 131072, "output": 32768}, "modalities": {"input": ["text", "image", "pdf"], "output": ["text"]}}
    } + (.provider.google.models // {})' ~/.config/opencode/opencode.json > /tmp/oc.json && mv /tmp/oc.json ~/.config/opencode/opencode.json
fi
```

Or edit the file manually and add the models from the [Available models](#available-models) section.

#### Step 6: Verify setup

```bash
opencode run "Hello" --model=google/gemini-3-pro-high
```

If successful, tell the user: **"Setup complete! You can now use Antigravity models in OpenCode."**

</details>

---

## Available models

Add these models to your `~/.config/opencode/opencode.json` under `provider.google.models`:

| Model ID | Description |
|----------|-------------|
| `gemini-3-pro-high` | Gemini 3 Pro High |
| `gemini-3-pro-low` | Gemini 3 Pro Low |
| `gemini-3-flash` | Gemini 3 Flash |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 |
| `claude-sonnet-4-5-thinking` | Claude Sonnet 4.5 with thinking |
| `claude-opus-4-5-thinking` | Claude Opus 4.5 with thinking |
| `gpt-oss-120b-medium` | GPT-OSS 120B Medium |

<details>
<summary><b>Full model configuration</b> (click to expand)</summary>

```json
{
  "provider": {
    "google": {
      "models": {
        "gemini-3-pro-high": {
          "name": "Gemini 3 Pro High (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-pro-low": {
          "name": "Gemini 3 Pro Low (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-flash": {
          "name": "Gemini 3 Flash (Antigravity)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "claude-sonnet-4-5": {
          "name": "Claude Sonnet 4.5 (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "claude-sonnet-4-5-thinking": {
          "name": "Claude Sonnet 4.5 Thinking (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "claude-opus-4-5-thinking": {
          "name": "Claude Opus 4.5 Thinking (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gpt-oss-120b-medium": {
          "name": "GPT-OSS 120B Medium (Antigravity)",
          "limit": { "context": 131072, "output": 32768 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        }
      }
    }
  }
}
```

</details>

## Multi-account load balancing

The plugin supports multiple Google accounts to maximize rate limits and provide automatic failover.

### How it works

- **Sticky account selection:** The plugin sticks to the same account for all requests until it hits a rate limit. This preserves Anthropic's prompt cache, which is organization-scoped.
- **Per-model-family rate limits:** Rate limits are tracked separately for Claude and Gemini models. If an account is rate-limited for Claude, it can still be used for Gemini requests.
- **Dual quota pools for Gemini:** Gemini models have access to two separate quota pools (Antigravity and Gemini CLI). When one pool is exhausted, the plugin automatically switches to the other before trying a different account.
- **Smart retry threshold:** Short rate limits (≤5s) are retried on the same account to avoid unnecessary switching.
- **Exponential backoff:** Consecutive rate limits trigger exponential backoff with increasing delays.
- **Quota-aware messages:** Rate limit toasts show quota reset times when available from the API.
- **Automatic failover:** On HTTP `429` (rate limit), the plugin automatically switches to the next available account for that model family.
- **Smart cooldown:** Rate-limited accounts are temporarily cooled down and automatically become available again after the cooldown expires.
- **Single-account retry:** If you only have one account, the plugin waits for the rate limit to reset and retries automatically.
- **Debounced notifications:** Toast notifications are debounced to avoid spam during streaming responses.

### Dual quota pools (Gemini only)

For Gemini models, the plugin can access **two independent quota pools** using the same Google account:

| Quota Pool | Headers Used | When Used |
|------------|--------------|-----------|
| **Antigravity** | Antigravity headers | Primary (tried first) |
| **Gemini CLI** | Gemini CLI headers | Fallback when Antigravity is rate-limited |

This effectively **doubles your Gemini quota** per account. 

**How it works:**
1. Plugin tries Antigravity quota first
2. If rate-limited (429), it automatically retries using Gemini CLI headers
3. Only if **both** pools are exhausted does it switch to the next account
4. This happens seamlessly — conversation context is preserved when switching between quota pools.

> **Note:** Claude models only work with Antigravity headers, so this dual-pool fallback only applies to Gemini models.

### Quiet mode

To suppress account-related toast notifications (useful for streaming/recording):

```bash
export OPENCODE_ANTIGRAVITY_QUIET=1
```

### Adding accounts

**CLI flow (`opencode auth login`):**

When you run `opencode auth login` and already have accounts saved, you'll be prompted:

```
2 account(s) saved:
  1. user1@gmail.com
  2. user2@gmail.com

(a)dd new account(s) or (f)resh start? [a/f]:
```

- Press `a` to add more accounts to your existing pool
- Press `f` to clear all existing accounts and start fresh

**TUI flow (`/connect`):**

The `/connect` command in the TUI adds accounts non-destructively — it will never clear your existing accounts. To start fresh via TUI, run `opencode auth logout` first, then `/connect`.

### Account storage

- Account pool is stored in `~/.config/opencode/antigravity-accounts.json` (or `%APPDATA%\opencode\antigravity-accounts.json` on Windows)
- This file contains OAuth refresh tokens; **treat it like a password** and don't share or commit it
- The plugin automatically syncs with OpenCode's auth state — if you log out via OpenCode, stale account storage is cleared automatically

### Automatic account recovery

- If Google revokes a refresh token (`invalid_grant`), that account is automatically removed from the pool
- Rerun `opencode auth login` to re-add the account

## Architecture & Flow

For contributors and advanced users, see the detailed documentation:

- **[Claude Model Flow](docs/CLAUDE_MODEL_FLOW.md)** - Full request/response flow, improvements, and fixes
- **[Antigravity API Spec](docs/ANTIGRAVITY_API_SPEC.md)** - API reference and schema support matrix

## Streaming & thinking

This plugin supports **real-time SSE streaming**, meaning you see thinking blocks and text output incrementally as they are generated.

### Claude Thinking & Tools

For models like `claude-opus-4-5-thinking`:

- **Interleaved Thinking:** The plugin automatically enables `anthropic-beta: interleaved-thinking-2025-05-14`. This allows Claude to think *between* tool calls and after tool results, improving complex reasoning.
- **Smart System Hints:** A system instruction is silently added to encourage the model to "think" before and during tool use.
- **Multi-turn Stability:** Thinking signatures are cached and restored using a stable `sessionId`, preventing "invalid signature" errors in long conversations.
- **Thinking Budget Safety:** If a thinking budget is enabled, the plugin ensures output token limits are high enough to avoid budget-related errors.
- **Tool Use:** Tool calls and responses are assigned proper IDs, and tool calling is set to validated mode for better Claude compatibility.

**Troubleshooting:** If you see signature errors in multi-turn tool loops, restart `opencode` to reset the plugin session/signature cache.

## Debugging

Enable debug logging via environment variable:

```bash
export OPENCODE_ANTIGRAVITY_DEBUG=1
```

- **Level 1 (`1` or `true`):** Basic logging of URLs, headers, status codes, and request/response previews.
- **Level 2 (`2` or `verbose`):** Verbose logging including full request and response bodies (up to 50KB).
- **TUI Reasoning View:** Debug logs are injected into the model's "thinking/reasoning" blocks in the Opencode TUI (requires thinking-capable models).
- **Log Files:** Logs are written to `~/.config/opencode/antigravity-logs/antigravity-debug-<timestamp>.log`. Override with `OPENCODE_ANTIGRAVITY_LOG_DIR`.
- **Auto-Stripping:** Injected debug blocks are automatically stripped from outgoing requests to prevent leaking into conversation history.

## Development

```bash
npm install
```

## Safety, usage, and risk notices

### Intended use

- Personal / internal development only
- Respect internal quotas and data handling policies
- Not for production services or bypassing intended limits

### Not suitable for

- Production application traffic
- High-volume automated extraction
- Any use that violates Acceptable Use Policies

### ⚠️ Warning (assumption of risk)

By using this plugin, you acknowledge and accept the following:

- **Terms of Service risk:** This approach may violate the Terms of Service of AI model providers (Anthropic, OpenAI, etc.). You are solely responsible for ensuring compliance with all applicable terms and policies.
- **Account risk:** Providers may detect this usage pattern and take punitive action, including suspension, permanent ban, or loss of access to paid subscriptions.
- **No guarantees:** Providers may change APIs, authentication, or policies at any time, which can break this method without notice.
- **Assumption of risk:** You assume all legal, financial, and technical risks. The authors and contributors of this project bear no responsibility for any consequences arising from your use.

Use at your own risk. Proceed only if you understand and accept these risks.

## Legal

- Not affiliated with Google. This is an independent open-source project and is not endorsed by, sponsored by, or affiliated with Google LLC.
- "Antigravity", "Gemini", "Google Cloud", and "Google" are trademarks of Google LLC.
- Software is provided "as is", without warranty. You are responsible for complying with Google's Terms of Service and Acceptable Use Policy.

## Credits

Built with help and inspiration from:

- [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) — Gemini OAuth groundwork by [@jenslys](https://github.com/jenslys)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) — Helpful reference for Antigravity API

## Support

If this plugin helps you, consider supporting its continued maintenance:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/S6S81QBOIR)


