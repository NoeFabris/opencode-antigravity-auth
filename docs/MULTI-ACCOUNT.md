# Multi-Account Setup

Add multiple Google accounts to increase your combined quota and improve availability. The plugin automatically rotates between accounts when one is rate-limited.

```bash
opencode auth login  # Run again to add more accounts
```

---

## Load Balancing Behavior

- **Sticky account selection** — Sticks to the same account until rate-limited (preserves Anthropic's prompt cache)
- **Per-model-family limits** — Rate limits tracked separately for Claude and Gemini models
- **Antigravity-first for Gemini** — All Gemini requests use Antigravity quota first, then automatically fall back to Gemini CLI when exhausted across all accounts
- **Smart retry threshold** — Short rate limits (≤5s) are retried on same account
- **Exponential backoff** — Increasing delays for consecutive rate limits

---

## Dual Quota Pools

For Gemini models, the plugin accesses **two independent quota pools** per account:

| Quota Pool | When Used |
|------------|-----------|
| **Antigravity** | Default for all requests |
| **Gemini CLI** | Automatic fallback between Antigravity and Gemini CLI in both directions |

This effectively **doubles your Gemini quota** through automatic fallback between Antigravity and Gemini CLI pools.

### How Quota Fallback Works

1. Request uses Antigravity quota on current account
2. If rate-limited, plugin checks if ANY other account has Antigravity available
3. If yes → switch to that account (stay on Antigravity)
4. If no (all accounts exhausted) → fall back to Gemini CLI quota on current account
5. Model names are automatically transformed (e.g., `gemini-3-flash` → `gemini-3-flash-preview`)

Automatic fallback between pools is always enabled for Gemini requests.

---

## Checking Quotas

Check your current API usage across all accounts:

```bash
opencode auth login
# Select "Check quotas" from the menu
```

This shows remaining quota percentages and reset times for each model family:
- **Claude** - Claude Opus/Sonnet quota
- **Gemini 3 Pro** - Gemini 3 Pro quota
- **Gemini 3 Flash** - Gemini 3 Flash quota

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

## Pinning Models to Accounts

Use `model_account_affinity` when you want specific models to prefer specific Google accounts.

Configure it in `antigravity.json`:

```json
{
  "model_account_affinity": {
    "antigravity-claude-sonnet-4-6": "work@gmail.com",
    "antigravity-gemini-3.5-flash-low": "personal@gmail.com"
  },
  "account_affinity_strict": false
}
```

The value must be the Google account email, not an account index. Emails stay stable when accounts are removed or reordered.

Model keys are normalized before lookup. These examples match the same affinity entry:

```text
claude-sonnet-4-6
antigravity-claude-sonnet-4-6

gemini-3.5-flash
gemini-3.5-flash-low
antigravity-gemini-3.5-flash-low
```

When `account_affinity_strict` is `false`, the pinned account is preferred but not mandatory. If that account is disabled, cooling down, rate-limited, or over the soft quota threshold, the plugin falls back to the normal account selection strategy.

When `account_affinity_strict` is `true`, the request fails with a clear error if the pinned account is unavailable.

Example error:

```text
Account affinity: antigravity-claude-sonnet-4-6 is pinned to work@gmail.com, but the account is rate-limited.
```

### SDD Agent Example

OpenCode does not always expose the agent name to plugin `fetch()` calls, so the reliable approach is to give each SDD agent a distinct model and pin that model to an account.

```json
{
  "agent": {
    "sdd-design": {
      "model": "google/antigravity-claude-sonnet-4-6"
    },
    "sdd-apply": {
      "model": "google/antigravity-gemini-3.5-flash-low"
    }
  }
}
```

Then configure Antigravity account affinity:

```json
{
  "model_account_affinity": {
    "antigravity-claude-sonnet-4-6": "work@gmail.com",
    "antigravity-gemini-3.5-flash-low": "personal@gmail.com"
  },
  "account_affinity_strict": false
}
```

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
