# Plan: Port opencode-antigravity-auth to OpenClaw

## Overview

This plan describes how to port the existing `opencode-antigravity-auth` plugin (which provides Google Antigravity OAuth for OpenCode) to work with **OpenClaw** — a different AI coding assistant with its own plugin API.

The goal is to create a new package `openclaw-antigravity-auth` that enables OpenClaw users to authenticate via Google Antigravity OAuth and use Gemini/Claude models through Google's Antigravity IDE infrastructure.

---

## What We Know

### Current Plugin (OpenCode)
- Package: `opencode-antigravity-auth`
- Plugin API: `@opencode-ai/plugin`
- Config dir: `~/.config/opencode/`
- Config file: `~/.config/opencode/opencode.json`
- Accounts file: `~/.config/opencode/antigravity-accounts.json`
- Plugin config: `~/.config/opencode/antigravity.json`
- Project config: `.opencode/antigravity.json`
- Env vars: `OPENCODE_CONFIG_DIR`, `OPENCODE_ANTIGRAVITY_DEBUG`, etc.

### Target (OpenClaw)
- Package: `openclaw-antigravity-auth` (new)
- Plugin API: `@openclaw/plugin` (to be confirmed from openclaw/openclaw repo)
- Config dir: `~/.config/openclaw/` (assumed)
- Config file: `~/.config/openclaw/openclaw.json` (assumed)
- Accounts file: `~/.config/openclaw/antigravity-accounts.json`
- Plugin config: `~/.config/openclaw/antigravity.json`
- Project config: `.openclaw/antigravity.json`
- Env vars: `OPENCLAW_CONFIG_DIR`, `OPENCLAW_ANTIGRAVITY_DEBUG`, etc.

---

## Key Differences to Adapt

### 1. Plugin API Package
```
@opencode-ai/plugin  →  @openclaw/plugin
```

The `@opencode-ai/plugin` package provides:
- `tool()` function for defining tools
- `tool.schema.*` for schema definitions
- `PluginInput` type (used for `PluginClient`)

These need to be replaced with OpenClaw equivalents.

### 2. Plugin Function Signature
OpenCode plugin exports a function:
```typescript
export const AntigravityCLIOAuthPlugin = createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID);
// Called as: async ({ client, directory }) => PluginResult
```

OpenClaw likely has a similar but potentially different signature. Need to verify from the openclaw/openclaw repo.

### 3. Client API
The `client` object in OpenCode has:
- `client.tui.showToast({ body: { title, message, variant } })`
- `client.session.prompt({ path: { id }, body: { parts }, query: { directory } })`
- `client.session.abort({ path: { id } })`
- `client.session.messages({ path: { id }, query: { directory } })`
- `client.app.log({ body: { service, level, message, extra } })`

OpenClaw's client API may differ — need to check and adapt.

### 4. Config Paths
All references to `opencode` in paths must change to `openclaw`:
- `~/.config/opencode/` → `~/.config/openclaw/`
- `.opencode/antigravity.json` → `.openclaw/antigravity.json`
- `OPENCODE_CONFIG_DIR` → `OPENCLAW_CONFIG_DIR`

### 5. Environment Variables
All `OPENCODE_ANTIGRAVITY_*` env vars → `OPENCLAW_ANTIGRAVITY_*`

### 6. Auto-Update Checker
The auto-update checker references:
- Package name: `opencode-antigravity-auth` → `openclaw-antigravity-auth`
- Config file parsing to find plugin entry in `opencode.json` → `openclaw.json`

---

## Files to Modify

### New Files to Create
| File | Purpose |
|------|---------|
| `package.json` | New package metadata for `openclaw-antigravity-auth` |
| `README.md` | Updated docs for OpenClaw |

### Files Requiring Changes

#### High Impact (API changes)
| File | Changes Needed |
|------|---------------|
| `src/plugin.ts` | Import from `@openclaw/plugin`, adapt client API calls |
| `src/plugin/types.ts` | Import `PluginInput` from `@openclaw/plugin` |
| `src/hooks/auto-update-checker/index.ts` | Update package name, config file parsing |
| `src/hooks/auto-update-checker/checker.ts` | Update package name, config file path |
| `src/hooks/auto-update-checker/constants.ts` | Update `PACKAGE_NAME` constant |

#### Medium Impact (path/env changes)
| File | Changes Needed |
|------|---------------|
| `src/plugin/storage.ts` | `opencode` → `openclaw` in paths, env vars |
| `src/plugin/config/loader.ts` | `opencode` → `openclaw` in paths, env vars |
| `src/plugin/config/schema.ts` | `OPENCODE_ANTIGRAVITY_*` → `OPENCLAW_ANTIGRAVITY_*` in comments |
| `src/plugin/logger.ts` | `OPENCODE_ANTIGRAVITY_CONSOLE_LOG` → `OPENCLAW_ANTIGRAVITY_CONSOLE_LOG` |
| `src/plugin/debug.ts` | `OPENCODE_ANTIGRAVITY_DEBUG*` → `OPENCLAW_ANTIGRAVITY_DEBUG*` |

#### Low Impact (string references only)
| File | Changes Needed |
|------|---------------|
| `src/plugin/cli.ts` | Update any opencode.json references |
| `src/plugin/version.ts` | Update package name if referenced |
| `src/plugin/recovery.ts` | No API changes needed (uses PluginClient type) |

---

## Architecture Diagram

```
OpenClaw
  │
  ▼
openclaw-antigravity-auth plugin
  │
  ├── Plugin Entry (src/plugin.ts)
  │     ├── Uses @openclaw/plugin API
  │     ├── Registers auth provider "google"
  │     ├── Intercepts fetch() calls to generativelanguage.googleapis.com
  │     └── Transforms requests to Antigravity API format
  │
  ├── OAuth Flow (src/antigravity/oauth.ts)
  │     ├── Google OAuth2 PKCE flow (unchanged)
  │     ├── Token exchange with googleapis.com (unchanged)
  │     └── Project ID discovery via loadCodeAssist (unchanged)
  │
  ├── Account Storage (~/.config/openclaw/antigravity-accounts.json)
  │     ├── Multi-account support (unchanged)
  │     └── Token refresh & rotation (unchanged)
  │
  └── Config (~/.config/openclaw/antigravity.json)
        └── All settings unchanged, just different path
```

---

## Step-by-Step Implementation Plan

### Step 1: Research OpenClaw Plugin API
- Check `https://github.com/openclaw/openclaw` for plugin documentation
- Find the `@openclaw/plugin` npm package and its API
- Identify differences from `@opencode-ai/plugin`
- Document the exact `PluginInput`, `PluginResult`, `tool()` API

### Step 2: Update package.json
```json
{
  "name": "openclaw-antigravity-auth",
  "description": "Google Antigravity IDE OAuth auth plugin for OpenClaw",
  "dependencies": {
    "@openclaw/plugin": "^X.Y.Z",  // Replace @opencode-ai/plugin
    ...
  }
}
```

### Step 3: Update src/plugin/types.ts
```typescript
// Before:
import type { PluginInput } from "@opencode-ai/plugin";
// After:
import type { PluginInput } from "@openclaw/plugin";
```

### Step 4: Update src/plugin.ts
```typescript
// Before:
import { tool } from "@opencode-ai/plugin";
// After:
import { tool } from "@openclaw/plugin";
```

Also update any client API calls that differ between OpenCode and OpenClaw.

### Step 5: Update Config Paths (storage.ts, loader.ts)
```typescript
// Before:
const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
return join(xdgConfig, "opencode");
// After:
const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
return join(xdgConfig, "openclaw");
```

```typescript
// Before:
if (process.env.OPENCODE_CONFIG_DIR) {
  return process.env.OPENCODE_CONFIG_DIR;
}
// After:
if (process.env.OPENCLAW_CONFIG_DIR) {
  return process.env.OPENCLAW_CONFIG_DIR;
}
```

### Step 6: Update Project Config Path (loader.ts)
```typescript
// Before:
return join(directory, ".opencode", "antigravity.json");
// After:
return join(directory, ".openclaw", "antigravity.json");
```

### Step 7: Update Environment Variables (debug.ts, logger.ts, config/schema.ts)
All `OPENCODE_ANTIGRAVITY_*` → `OPENCLAW_ANTIGRAVITY_*`

### Step 8: Update Auto-Update Checker
- `src/hooks/auto-update-checker/constants.ts`: `PACKAGE_NAME = "openclaw-antigravity-auth"`
- `src/hooks/auto-update-checker/checker.ts`: Update config file path from `opencode.json` to `openclaw.json`

### Step 9: Update index.ts Exports
```typescript
export {
  AntigravityCLIOAuthPlugin,
  GoogleOAuthPlugin,
} from "./src/plugin";
// Keep same exports, just different package
```

### Step 10: Update README.md
- Replace all `opencode` references with `openclaw`
- Update installation instructions for OpenClaw
- Update config file paths
- Update model configuration format for OpenClaw

---

## Risk Assessment

### Low Risk (mechanical changes)
- Config path changes (`opencode` → `openclaw`)
- Environment variable renames
- Package name update

### Medium Risk (API compatibility)
- `@openclaw/plugin` API may differ from `@opencode-ai/plugin`
- `client.tui.showToast()` signature may differ
- `client.session.*` methods may have different signatures
- `tool()` function API may differ

### High Risk (unknown)
- OpenClaw plugin system may work fundamentally differently
- The `PluginResult` structure (auth.provider, auth.loader, auth.methods) may differ
- Event system (`session.created`, `session.error`) may have different event names

---

## Questions to Resolve

1. **What is the exact `@openclaw/plugin` package API?**
   - Does it export `tool()` with the same signature?
   - What is `PluginInput` type?
   - What is `PluginResult` type?

2. **How does OpenClaw's plugin registration work?**
   - Same `async ({ client, directory }) => PluginResult` pattern?
   - Different export format?

3. **What is OpenClaw's config file format?**
   - `openclaw.json` with `plugin` array?
   - Different structure?

4. **Does OpenClaw have the same event system?**
   - `session.created`, `session.error` events?
   - Same `client.session.*` API?

5. **Does OpenClaw support the same auth methods?**
   - `type: "oauth"` with `authorize()` callback?
   - `type: "api"` for API keys?

---

## Files NOT Needing Changes

These files contain pure business logic with no OpenCode-specific dependencies:
- `src/antigravity/oauth.ts` - Pure OAuth logic
- `src/plugin/auth.ts` - Token validation utilities
- `src/plugin/accounts.ts` - Account management logic
- `src/plugin/request.ts` - Request transformation
- `src/plugin/request-helpers.ts` - Schema cleaning
- `src/plugin/transform/` - All transform files
- `src/plugin/token.ts` - Token refresh
- `src/plugin/server.ts` - OAuth callback server
- `src/plugin/rotation.ts` - Account rotation
- `src/plugin/quota.ts` - Quota checking
- `src/plugin/fingerprint.ts` - Device fingerprinting
- `src/plugin/errors.ts` - Error types
- `src/plugin/cache/` - Signature caching
- `src/plugin/recovery/` - Recovery storage utilities
- `src/plugin/stores/` - Signature store
- `src/plugin/core/` - Streaming utilities
- `src/constants.ts` - API constants (Google endpoints, unchanged)
