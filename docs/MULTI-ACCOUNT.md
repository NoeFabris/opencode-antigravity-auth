# Multi-Account Setup

Add multiple Google accounts to increase your combined quota and improve availability. The plugin automatically rotates between accounts when one is rate-limited.

```bash
opencode auth login  # Run again to add more accounts
```

---

## Load Balancing Behavior

- **Sticky account selection** — Sticks to the same account until rate-limited (preserves Anthropic's prompt cache)
- **Per-model-family limits** — Rate limits tracked separately for Claude and Gemini models
- **Antigravity-first for Gemini** — Current default models use Antigravity quota first; legacy Gemini CLI fallback remains only for existing Gemini CLI model configs
- **Smart retry threshold** — Short rate limits (≤5s) are retried on same account
- **Exponential backoff** — Increasing delays for consecutive rate limits

---

## Quota Pools

For current Antigravity models, the plugin uses the Antigravity quota pool. Legacy Gemini CLI fallback still exists for users with older Gemini CLI model configs, but those models are no longer listed by default because individual Gemini CLI access sunsets on **2026-06-18**.

| Quota Pool | When Used |
|------------|-----------|
| **Antigravity** | Default for all requests |
| **Gemini CLI** | Legacy fallback only for existing configs that still use Gemini CLI-capable model IDs |

Do not rely on Gemini CLI quota for new setups.

### How Quota Fallback Works

1. Request uses Antigravity quota on current account
2. If rate-limited, plugin checks if ANY other account has Antigravity available
3. If yes → switch to that account (stay on Antigravity)
4. If no (all accounts exhausted) → wait/back off or use legacy Gemini CLI fallback only when the request/model config allows it
5. Current model names stay on Antigravity (for example `antigravity-gemini-3.5-flash-low`)

Automatic fallback remains enabled for backward compatibility. Current recommended configs use Antigravity-only model IDs.

---

## Checking Quotas

Check your current API usage across all accounts:

```bash
opencode auth login
# Select "Check quotas" from the menu
```

This shows remaining quota percentages and reset times for each model family:
- **Claude** - Claude Opus/Sonnet quota
- **Gemini 3.1 Pro** - Gemini 3.1 Pro quota
- **Gemini 3.5 Flash** - Gemini 3.5 Flash quota
- **GPT-OSS 120B** - GPT-OSS quota, when exposed by the quota API

### Standalone Quota Script

For checking quotas outside of OpenCode (for debugging, CI, etc.):

```bash
node scripts/check-quota.mjs                    # Check all accounts
node scripts/check-quota.mjs --account 2        # Check specific account
node scripts/check-quota.mjs --path /path/to/accounts.json  # Custom path
```

---

## Managing Accounts

Enable or disable specific accounts to control which ones are used for requests:

```bash
opencode auth login
# Select "Manage accounts (enable/disable)"
```

Or select an account from the list and choose "Enable/Disable account".

**Disabled accounts:**
- Are excluded from automatic rotation
- Still appear in quota checks (marked `[disabled]`)
- Can be re-enabled at any time

Useful when:
- An account is temporarily banned or rate-limited for an extended period
- You want to reserve certain accounts for specific use cases
- Testing with a subset of accounts

---

## Adding Accounts

When running `opencode auth login` with existing accounts:

```
2 account(s) saved:
  1. user1@gmail.com
  2. user2@gmail.com

(a)dd new account(s) or (f)resh start? [a/f]:
```

Choose `a` to add more accounts while keeping existing ones.

---

## Account Storage

Accounts are stored in `~/.config/opencode/antigravity-accounts.json`:

```json
{
  "version": 3,
  "accounts": [
    {
      "email": "user1@gmail.com",
      "refreshToken": "1//0abc...",
      "projectId": "my-gcp-project",
      "enabled": true
    },
    {
      "email": "user2@gmail.com",
      "refreshToken": "1//0xyz...",
      "enabled": false
    }
  ],
  "activeIndex": 0,
  "activeIndexByFamily": {
    "claude": 0,
    "gemini": 0
  }
}
```

> ⚠️ **Security:** This file contains OAuth refresh tokens. Treat it like a password file.

### Fields

| Field | Description |
|-------|-------------|
| `email` | Google account email |
| `refreshToken` | OAuth refresh token (auto-managed) |
| `projectId` | Optional. Required for Gemini CLI models. See [Troubleshooting](TROUBLESHOOTING.md#gemini-cli-permission-error). |
| `enabled` | Optional. Set to `false` to disable account rotation. Defaults to `true`. |
| `activeIndex` | Currently active account index |
| `activeIndexByFamily` | Per-model-family active account (claude/gemini tracked separately) |

---

## Token Revocation

If Google revokes a token (e.g., password change, security event), you'll see `invalid_grant` errors. The plugin automatically removes invalid accounts.

To manually reset:

```bash
rm ~/.config/opencode/antigravity-accounts.json
opencode auth login
```

---

## Parallel Sessions (oh-my-opencode)

When using oh-my-opencode with parallel subagents, multiple processes may select the same account, causing rate limit errors.

**Solution:** Enable PID-based offset in `antigravity.json`:

```json
{
  "pid_offset_enabled": true
}
```

This distributes sessions across accounts based on process ID.

Alternatively, add more accounts via `opencode auth login`.

---

## Account Selection Strategies

Configure in `antigravity.json`:

```json
{
  "account_selection_strategy": "hybrid"
}
```

| Strategy | Behavior | Best For |
|----------|----------|----------|
| `sticky` | Same account until rate-limited | Prompt cache preservation |
| `round-robin` | Rotate to next account on every request | Maximum throughput |
| `hybrid` | Deterministic selection based on health score + token bucket + LRU | Best overall distribution |

See [Configuration](CONFIGURATION.md#account-selection) for more details.
