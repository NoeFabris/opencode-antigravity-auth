# Troubleshooting

Common issues and solutions for the Antigravity Auth plugin.

> **Quick Reset**: Most issues can be resolved by deleting `~/.config/opencode/antigravity-accounts.json` and running `opencode auth login` again.

---

## Configuration Paths (All Platforms)

OpenCode uses `~/.config/opencode/` on **all platforms** including Windows.

| File | Path |
|------|------|
| Main config | `~/.config/opencode/opencode.json` |
| Accounts | `~/.config/opencode/antigravity-accounts.json` |
| Plugin config | `~/.config/opencode/antigravity.json` |
| Debug logs | `~/.config/opencode/antigravity-logs/` |

> **Windows users**: `~` resolves to your user home directory (e.g., `C:\Users\YourName`). Do NOT use `%APPDATA%`.

---

## Quick Fixes

### Auth problems
Delete the token file and re-login:
```bash
rm ~/.config/opencode/antigravity-accounts.json
opencode auth login
```

### "This version of Antigravity is no longer supported"
This almost always means an outdated Antigravity `User-Agent` is still being used.

1) Stop any running OpenCode processes (stale processes can overwrite your accounts file):

**macOS/Linux:**
```bash
pkill -f opencode || true
```

**Windows (PowerShell):**
```powershell
Stop-Process -Name "opencode" -Force -ErrorAction SilentlyContinue
```

2) Clear the plugin caches and re-login:

**macOS/Linux:**
```bash
rm -f ~/.config/opencode/antigravity-accounts.json
rm -rf ~/.cache/opencode/node_modules/opencode-antigravity-auth
rm -rf ~/.bun/install/cache/opencode-antigravity-auth*
opencode auth login
```

**Windows (PowerShell):**
```powershell
Remove-Item "$env:APPDATA\opencode\antigravity-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\opencode\Cache\node_modules\opencode-antigravity-auth" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.bun\install\cache\opencode-antigravity-auth*" -Recurse -Force -ErrorAction SilentlyContinue
opencode auth login
```

### "Model not found"
Add this to your `google` provider config:
```json
"npm": "@ai-sdk/google"
```

### Session errors
Type `continue` to trigger auto-recovery, or use `/undo` to rollback.

### Configuration Key Typo

The correct key is `plugin` (singular):

```json
{
  "plugin": ["opencode-antigravity-auth@latest"]
}
```

**Not** `"plugins"` (will cause "Unrecognized key" error).

### "Invalid SemVer: beta"

**Error:**
```
Invalid SemVer
{
  "name": "UnknownError",
  "data": {
    "message": "Error: Invalid SemVer: beta ... isOutdated (src/bun/registry.ts:...)"
  }
}
```

**Why this happens:** OpenCode's cache may keep the plugin dependency as a dist-tag (`"beta"`) in `~/.cache/opencode/package.json` and `~/.cache/opencode/bun.lock`. Some OpenCode versions compare plugin versions as strict semver and fail on non-numeric tags.

**Fix (recommended):** Re-resolve the dependency in OpenCode cache so it is pinned to a real version.

**macOS / Linux:**
```bash
cd ~/.cache/opencode
bun add opencode-antigravity-auth@latest
```

**Windows (PowerShell):**
```powershell
Set-Location "$env:USERPROFILE\.cache\opencode"
bun add opencode-antigravity-auth@latest
```

Then restart OpenCode.

> If you intentionally run beta channel, use `bun add opencode-antigravity-auth@beta` instead.

---

## Gemini CLI Permission Error

When using Gemini CLI models, you may see:
> Permission 'cloudaicompanion.companions.generateChat' denied on resource '//cloudaicompanion.googleapis.com/projects/...'

**Why this happens:** The plugin defaults to a predefined project ID that doesn't exist in your Google Cloud account. Antigravity models work, but Gemini CLI models need your own project.

**Solution:**

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the **Gemini for Google Cloud API** (`cloudaicompanion.googleapis.com`)
4. Add `projectId` to your account in `~/.config/opencode/antigravity-accounts.json`:

```json
{
  "version": 3,
  "accounts": [
    {
      "email": "you@gmail.com",
      "refreshToken": "...",
      "projectId": "your-project-id"
    }
  ]
}
```

> **Note:** For multi-account setups, add `projectId` to each account.

---

## Gemini 3 Models 400 Error ("Unknown name 'parameters'")

**Error:**
```
Invalid JSON payload received. Unknown name "parameters" at 'request.tools[0]'
```

**Causes:**
- Tool schema incompatibility with Gemini's strict protobuf validation
- MCP servers with malformed schemas
- Plugin version regression

**Solutions:**
1. **Update to latest beta:**
   ```json
   { "plugin": ["opencode-antigravity-auth@beta"] }
   ```

2. **Disable MCP servers** one-by-one to find the problematic one

3. **Add npm override:**
   ```json
   { "provider": { "google": { "npm": "@ai-sdk/google" } } }
   ```

---

## MCP Servers Causing Errors

Some MCP servers have schemas incompatible with Antigravity's strict JSON format.

**Diagnosis:**
1. Disable all MCP servers in your config
2. Enable one-by-one until error reappears
3. Report the specific MCP in a [GitHub issue](https://github.com/NoeFabris/opencode-antigravity-auth/issues)

---

## Rate Limits, Shadow Bans, and Hanging Prompts

**Symptoms:**
- Prompts hang indefinitely (200 OK in logs but no response)
- 403 "Permission Denied" errors even with fresh accounts
- "All accounts rate-limited" but quota looks available
- New accounts get rate-limited immediately after adding

**Why this happens:**

Google has significantly tightened quota and rate-limit enforcement. This affects ALL users, not just this plugin. Key factors:

1. **Stricter enforcement** — Even when quota "looks available," Google may throttle or soft-ban accounts that trigger their abuse detection
2. **OpenCode's request pattern** — OpenCode makes more API calls than native apps (tool calls, retries, streaming, multi-turn chains), which triggers limits faster than "normal" usage
3. **Shadow bans** — Some accounts become effectively unusable for extended periods once flagged, while others continue working normally

> ⚠️ **Important:** Using this plugin may increase the chance of triggering automated abuse/rate-limit protections. The upstream provider can restrict, suspend, or terminate access at their discretion. **USE AT YOUR OWN RISK.**

**Solutions:**

<details>
<summary><b>1. Wait it out (most reliable)</b></summary>

Rate limits typically reset after a few hours. If you're seeing persistent issues:
- Stop using the affected account for 24-48 hours
- Use a different account in the meantime
- Check `rateLimitResetTimes` in your accounts file to see when limits expire

</details>

<details>
<summary><b>2. "Warm up" accounts in Antigravity IDE (community tip)</b></summary>

Users have reported success with this approach:

1. Open [Antigravity IDE](https://idx.google.com/) directly in your browser
2. Log in with the affected Google account
3. Run a few simple prompts (e.g., "Hello", "What's 2+2?")
4. After 5-10 successful prompts, try using the account with the plugin again

**Why this might work:** Using the account through the "official" interface may reset some internal flags or make the account appear less suspicious.

</details>

<details>
<summary><b>3. Reduce request volume and burstiness</b></summary>

- Use shorter sessions
- Avoid parallel/retry-heavy workflows (e.g., spawning many subagents at once)
- If using oh-my-opencode, consider reducing concurrent agent spawns
- Set `max_rate_limit_wait_seconds: 0` to fail fast instead of retrying

</details>

<details>
<summary><b>4. Use Antigravity IDE directly (single account users)</b></summary>

If you only have one account, you'll likely have a better experience using [Antigravity IDE](https://idx.google.com/) directly instead of routing through OpenCode, since OpenCode's request pattern triggers limits faster.

</details>

<details>
<summary><b>5. Fresh account setup</b></summary>

If adding new accounts:
1. Delete accounts file: `rm ~/.config/opencode/antigravity-accounts.json`
2. Re-authenticate: `opencode auth login`
3. Update to latest beta: `"plugin": ["opencode-antigravity-auth@beta"]`
4. Consider "warming up" the account in Antigravity IDE first

</details>

**What to report:**

If you're seeing unusual rate limit behavior, please share in a [GitHub issue](https://github.com/NoeFabris/opencode-antigravity-auth/issues):
- Status codes from debug logs (403, 429, etc.)
- How long the rate-limit state persists
- Number of accounts and selection strategy used

---

## Infinite `.tmp` Files Created

**Cause:** When account is rate-limited and plugin retries infinitely, it creates many temp files.

**Workaround:**
1. Stop OpenCode
2. Clean up: `rm ~/.config/opencode/*.tmp`
3. Add more accounts or wait for rate limit to expire

---

## Safari OAuth Callback Fails (macOS)

**Symptoms:**
- "fail to authorize" after successful Google login
- Safari shows "Safari can't open the page" or connection refused

**Cause:** Safari's "HTTPS-Only Mode" blocks the `http://localhost` callback URL.

**Solutions:**

1. **Use a different browser** (easiest):
   Copy the URL from `opencode auth login` and paste it into Chrome or Firefox.

2. **Temporarily disable HTTPS-Only Mode:**
   - Safari > Settings (⌘,) > Privacy
   - Uncheck "Enable HTTPS-Only Mode"
   - Run `opencode auth login`
   - Re-enable after authentication

3. **Manual callback extraction** (advanced):
   - When Safari shows the error, the address bar contains `?code=...&scope=...`
   - See [issue #119](https://github.com/NoeFabris/opencode-antigravity-auth/issues/119) for manual auth support

---

## Port Already in Use

If OAuth fails with "Address already in use":

**macOS / Linux:**
```bash
lsof -i :51121
kill -9 <PID>
opencode auth login
```

**Windows:**
```powershell
netstat -ano | findstr :51121
taskkill /PID <PID> /F
opencode auth login
```

---

## WSL2 / Docker / Remote Development

The OAuth callback requires the browser to reach `localhost` on the machine running OpenCode.

<details>
<summary><b>WSL2</b></summary>

- Use VS Code's port forwarding, or
- Configure Windows → WSL port forwarding

</details>

<details>
<summary><b>SSH / Remote</b></summary>

```bash
ssh -L 51121:localhost:51121 user@remote
```

</details>

<details>
<summary><b>Docker / Containers</b></summary>

- OAuth with localhost redirect doesn't work in containers
- Wait 30s for manual URL flow, or use SSH port forwarding

</details>

---

## Migrating Accounts Between Machines

When copying `antigravity-accounts.json` to a new machine:
1. Ensure the plugin is installed: `"plugin": ["opencode-antigravity-auth@beta"]`
2. Copy `~/.config/opencode/antigravity-accounts.json`
3. If you get "API key missing" error, the refresh token may be invalid — re-authenticate

---

## Plugin Compatibility Issues

### @tarquinen/opencode-dcp

DCP creates synthetic assistant messages that lack thinking blocks. **List this plugin BEFORE DCP:**

```json
{
  "plugin": [
    "opencode-antigravity-auth@latest",
    "@tarquinen/opencode-dcp@latest"
  ]
}
```

### oh-my-opencode

Disable built-in auth:
```json
{
  "google_auth": false
}
```

When spawning parallel subagents, multiple processes may hit the same account. **Workaround:** Enable `pid_offset_enabled: true` or add more accounts.

### Other gemini-auth plugins

You don't need them. This plugin handles all Google OAuth.

---

## Migration Guides

### v1.2.8+ (Variants)

v1.2.8+ introduces **model variants** for dynamic thinking configuration.

**Before (v1.2.7):**
```json
{
  "antigravity-claude-opus-4-6-thinking-low": { ... },
  "antigravity-claude-opus-4-6-thinking-max": { ... }
}
```

**After (v1.2.8+):**
```json
{
  "antigravity-claude-opus-4-6-thinking": {
    "variants": {
      "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
      "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
    }
  }
}
```

Use canonical model names from current docs. Deprecated model names are sent as requested and may fail if the upstream API has removed them.

### v1.2.7 (Prefix)

v1.2.7+ uses explicit `antigravity-` prefix:

| Old Name | New Name |
|----------|----------|
| `gemini-3-pro-low` | `antigravity-gemini-3-pro` |
| `claude-sonnet-4-6` | `antigravity-claude-sonnet-4-6` |

Use the `antigravity-` prefixed model names shown above.

---

## Debugging

Enable debug logging:
```json
{
  "debug": true,
  "debug_tui": true
}
```

Logs are in `~/.config/opencode/antigravity-logs/`.

---

## E2E Testing

The plugin includes regression tests (consume API quota):

```bash
npx tsx script/test-regression.ts --sanity      # 7 tests, ~5 min
npx tsx script/test-regression.ts --heavy       # 4 tests, ~30 min
npx tsx script/test-regression.ts --dry-run     # List tests
```

---

## Still stuck?

Open an issue on [GitHub](https://github.com/NoeFabris/opencode-antigravity-auth/issues).
