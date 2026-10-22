# Antigravity + Gemini CLI OAuth Plugin for Opencode

[![npm version](https://img.shields.io/npm/v/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![npm beta](https://img.shields.io/npm/v/opencode-antigravity-auth/beta.svg?label=beta)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![npm downloads](https://img.shields.io/npm/dw/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![X (Twitter)](https://img.shields.io/badge/X-@dopesalmon-000000?style=flat&logo=x)](https://x.com/dopesalmon)

Enable Opencode to authenticate against **Antigravity** (Google's IDE) via OAuth so you can use Antigravity rate limits and access models like `gemini-3.1-pro` and `claude-opus-4-6-thinking` with your Google credentials.

Unofficial plugin. Google may restrict accounts using third-party clients.

## Setup

Requires OpenCode **2.1.2+** and Node.js **20+**.

Add to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-antigravity-auth@2.1.1"]
}
```

Then run:

```sh
opencode auth login google
```

Choose **Google OAuth (Antigravity)**. Existing accounts are reused.

To use a local checkout, run `npm ci && npm run build` and replace the package name above with the checkout's absolute path.

## Use

```sh
opencode models
opencode run --model=google/antigravity-gemini-3.8-flash-high "Hello"
opencode run --model=google/antigravity-claude-opus-4-6-thinking#max "Hello"
```

Models are discovered from your enabled accounts and cached for an hour. Availability depends on your Google plan. Select an `antigravity-*` model for Google OAuth. Native Google API-key models are hidden while Antigravity OAuth is selected and return when you switch to an API-key connection.

Inside OpenCode, open **`/antigravity`** (or **`/ag`**) to:

- See logged-in accounts and the current selection.
- Check Antigravity and Gemini CLI quotas and reset times.
- Add, select, enable, disable, re-authenticate, or delete an account.
- Refresh the model list.

Accounts are stored in `~/.config/opencode/antigravity-accounts.json`. Back up this file before moving machines; it contains credentials. Disabling an account excludes it from rotation and routine quota checks.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
OPENCODE_BIN=/path/to/opencode npm run test:e2e:v2
```

The runtime test uses synthetic credentials. Authenticated model and menu checks require a logged-in Google account.

[V2 migration and verification](docs/OPENCODE-V2.md) · [Configuration](docs/CONFIGURATION.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

OpenCode 1.18.29+ remains supported through the legacy entrypoint; its account menu opens from `opencode auth login`.
