# Antigravity Phase 0 Baseline

**Recorded:** May 20, 2026
**Plugin version:** 1.6.0
**Status:** Evidence snapshot — no code changes in this phase

This document records the current plugin behavior and official Antigravity CLI (`agy`) signals before Phase 1 (OAuth alignment). Use it to compare before/after changes.

**Related:** [ANTIGRAVITY_CLI_MIGRATION_PLAN.md](./ANTIGRAVITY_CLI_MIGRATION_PLAN.md)

---

## Summary

| Area | Plugin (current) | Official `agy` CLI (observed) | Drift risk |
|------|------------------|-------------------------------|------------|
| OAuth redirect | `http://localhost:51121/oauth-callback` | `https://antigravity.google/oauth-callback` | **High** |
| OAuth auth URL | `https://accounts.google.com/o/oauth2/v2/auth` | `https://accounts.google.com/o/oauth2/auth` | Medium |
| Scope `openid` | Not requested | Requested | Medium |
| Daily endpoint host | `daily-cloudcode-pa.sandbox.googleapis.com` | `daily-cloudcode-pa.googleapis.com` | **High** |
| Antigravity version (UA) | Fallback `1.18.3` | Binary `1.0.0` (CLI product version) | Medium |
| Transport | OpenCode fetch shim → `/v1internal:*` | Full agent runtime (Go binary) | Architectural |
| Auth completion via chat | N/A | 30s timeout; impractical | N/A |

---

## Plugin Architecture (baseline)

### Request path

```text
OpenCode
  └─ fetch() to generativelanguage.googleapis.com
      └─ plugin.ts: isGenerativeLanguageRequest()
          └─ prepareAntigravityRequest() in request.ts
              └─ {baseEndpoint}/v1internal:{action}[?alt=sse]
                  └─ CloudCode / Antigravity gateway
```

### Interception (`src/plugin/request.ts`)

- `isGenerativeLanguageRequest`: URL contains `generativelanguage.googleapis.com`
- `prepareAntigravityRequest` (lines ~727+):
  - Sets `Authorization: Bearer {accessToken}`
  - Strips `x-api-key`, `x-goog-user-project`
  - Parses `/models/{model}:{action}`
  - Default endpoint: `gemini-cli` → `GEMINI_CLI_ENDPOINT` (prod); `antigravity` → `ANTIGRAVITY_ENDPOINT` (daily sandbox)
  - Transformed URL: `${baseEndpoint}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""}`

### Fetch interceptor (`src/plugin.ts`)

- Account selection, token refresh, endpoint fallback loop over `ANTIGRAVITY_ENDPOINT_FALLBACKS`
- Dual header styles: `antigravity` | `gemini-cli` with quota rotation
- Retries on 429/503/529, fingerprint regeneration, account switching
- `verifyAccountAccess` uses prod `/v1internal:streamGenerateContent?alt=sse`

---

## OAuth Baseline (plugin)

**Source:** `src/constants.ts`, `src/antigravity/oauth.ts`

| Field | Value |
|-------|-------|
| Client ID | `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` |
| Redirect URI | `http://localhost:51121/oauth-callback` |
| Auth endpoint | `https://accounts.google.com/o/oauth2/v2/auth` |
| Token endpoint | `https://oauth2.googleapis.com/token` |
| Scopes | `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs` |
| PKCE | S256 via `@openauthjs/openauth/pkce` |
| Refresh storage | `refreshToken\|projectId` in account store |

**Not present vs official CLI:** `openid` scope, hosted redirect URI.

### Project discovery

- `fetchProjectID` POSTs `/v1internal:loadCodeAssist` with `GEMINI_CLI_HEADERS` UA + Antigravity `Client-Metadata`
- Endpoint order: `ANTIGRAVITY_LOAD_ENDPOINTS` then `ANTIGRAVITY_ENDPOINT_FALLBACKS`

---

## Endpoints Baseline (plugin)

**Source:** `src/constants.ts`

| Constant | URL |
|----------|-----|
| `ANTIGRAVITY_ENDPOINT_DAILY` | `https://daily-cloudcode-pa.sandbox.googleapis.com` |
| `ANTIGRAVITY_ENDPOINT_AUTOPUSH` | `https://autopush-cloudcode-pa.sandbox.googleapis.com` |
| `ANTIGRAVITY_ENDPOINT_PROD` | `https://cloudcode-pa.googleapis.com` |
| Default (`ANTIGRAVITY_ENDPOINT`) | Daily sandbox |
| `GEMINI_CLI_ENDPOINT` | Production (`cloudcode-pa.googleapis.com`) |

**Fallback order (requests):** daily → autopush → prod
**Load order (project discovery):** prod → daily → autopush

**API actions used:** `generateContent`, `streamGenerateContent`, `loadCodeAssist`, `onboardUser`

---

## Headers Baseline (plugin)

| Style | User-Agent | X-Goog-Api-Client | Client-Metadata |
|-------|------------|-------------------|-----------------|
| `antigravity` (static) | Electron-style `Antigravity/{version}` | `google-cloud-sdk vscode_cloudshelleditor/0.1` | JSON: `ideType=ANTIGRAVITY`, platform MACOS/WINDOWS, `pluginType=GEMINI` |
| `antigravity` (randomized) | `antigravity/{version} {platform}` | Random from vscode_cloudshelleditor variants | Same JSON shape |
| `gemini-cli` | `google-api-nodejs-client/9.15.1` | `gl-node/22.17.0` | `ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI` |

- Version fallback: `ANTIGRAVITY_VERSION_FALLBACK = "1.18.3"`
- Default project fallback: `rising-fact-p41fc`

---

## Account Storage (plugin)

**Source:** `src/plugin/storage.ts`

- Primary: `~/.config/opencode/antigravity-accounts.json` (via `XDG_CONFIG_HOME` or `~/.config`)
- Legacy migration paths supported
- OpenCode auth also present: `~/.config/opencode/auth.json` (separate from antigravity accounts)

**No tokens or refresh strings are recorded in this baseline document.**

---

## Official `agy` CLI Baseline

**Environment (May 20, 2026):**

| Item | Value |
|------|-------|
| Binary path | `/Users/rubenbeuker/.local/bin/agy` |
| CLI version (`agy changelog`) | `1.0.0` (initial release) |
| App data | `~/.gemini/antigravity-cli/` |
| Config | `~/.gemini/config/` (projects, mcp_config.json) |
| Project symlink | `~/.antigravitycli/` → project JSON under `.gemini/config/projects/` |

### OAuth (observed from `agy --print` and prior research)

| Field | Official `agy` |
|-------|----------------|
| Auth endpoint | `https://accounts.google.com/o/oauth2/auth` |
| Redirect URI | `https://antigravity.google/oauth-callback` |
| Client ID | Same as plugin |
| Scopes | Same five + `openid` |
| Interactive timeout | **30 seconds** (independent of `--print-timeout`) |
| Stdin fallback | "Or, paste the authorization code here and press Enter:" |

**Auth via chat/automation:** Unreliable — 30s timeout, hosted callback may consume code, PKCE verifier must match the running process.

### Endpoints (from `agy` logs on this machine)

Authenticated `agy` session logs show:

```text
https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels
https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
```

**Note:** Plugin uses `daily-cloudcode-pa.sandbox.googleapis.com`; official CLI uses `daily-cloudcode-pa.googleapis.com` (no `.sandbox.`). This is a primary endpoint drift candidate.

### Binary strings (selected)

From `strings` on `agy` binary (truncated scan):

- `cloudcode-pa.googleapis.com`
- `https://antigravity.google/oauth-callback`
- `https://antigravity.google/auth-success?app=%s`
- Protobuf/gRPC-style names: `GenerateChat`, `StreamGenerateChat`, `LoadCodeAssist`, `OnboardUser`, etc.

Suggests CLI may use richer protocol surface than plugin's REST `/v1internal:generateContent` shim.

---

## API Surface Beyond Plugin

The plugin currently uses these `/v1internal:*` actions:

| Action | Where | Purpose |
|--------|-------|---------|
| `generateContent` | `request.ts`, `search.ts` | Non-streaming model call |
| `streamGenerateContent?alt=sse` | `request.ts`, `plugin.ts:verifyAccountAccess` | Streaming model call |
| `loadCodeAssist` | `oauth.ts:fetchProjectID`, `project.ts:loadManagedProject` | Project discovery |
| `onboardUser` | `project.ts:onboardManagedProject` | First-time onboarding |
| `fetchAvailableModels` | `quota.ts:fetchAvailableModels` | Quota / model availability |

Official `agy` logs additionally show `fetchAvailableModels` at `daily-cloudcode-pa.googleapis.com`. Binary strings hint at richer protobuf surface (`GenerateChat`, `StreamGenerateChat`, `InternalAtomicAgenticChat`, `ListAgents`, `ListModelConfigs`, `RecordClientEvent`) that the plugin does not call.

---

## Models Baseline

**Source:** `src/plugin/transform/model-resolver.ts`

### Tier-suffix routing

- Gemini: `gemini-3-pro-{low,medium,high}`, `gemini-3.1-pro-{low,high}`, `gemini-3-flash-{low,medium,high}`
- Claude: `gemini-claude-opus-4-6-thinking-{low,medium,high}`, `gemini-claude-sonnet-4-6`
- Image: `gemini-3-pro-image` (Antigravity-only)

### Quota preference

- Default model (`gemini-3-pro-preview`) → `antigravity` quota pool
- `antigravity-` prefix → `antigravity` (explicit)
- Implies dual quota pools still relevant for multi-account rotation

**Live availability matrix:** Not captured in Phase 0. Requires authenticated `fetchAvailableModels` call.

---

## Fingerprint System

**Source:** `src/plugin/fingerprint.ts`

- Per-account `Fingerprint`: `deviceId`, `sessionToken`, `userAgent`, reduced `clientMetadata`
- Stored in `antigravity-accounts.json`; max 5 history entries; restorable on capacity exhaustion
- Only header composed is `User-Agent` (via `buildFingerprintHeaders()` in `fingerprint.ts`)
- Applied on the antigravity request path in `request.ts`

---

## Recovery and Retry Behavior

**Source:** `src/plugin/recovery.ts`, `src/plugin.ts`

- `tool_result_missing`: ESC during tool execution → injects synthetic `tool_result` blocks
- HTTP retries: `429`, `503`, `529` trigger capacity retry, backoff, fingerprint regeneration, account switching
- Endpoint fallback iterates `ANTIGRAVITY_ENDPOINT_FALLBACKS` per request
- Header-style fallback: `antigravity` ↔ `gemini-cli` on quota exhaustion per model family

---

## Configuration Knobs

**Source:** `src/plugin/config/schema.ts`, env scan

### Config file (Zod schema, `AntigravityConfigSchema`)

| Key | Default | Effect |
|-----|---------|--------|
| `debug` | `false` | File logging |
| `debug_tui` | `false` | TUI panel logging |
| `claude_prompt_auto_caching` | `false` | Inject Claude `cache_control: ephemeral` |
| `signature_cache.*` | — | Disk-backed thinking signature cache |
| `health_score`, `token_bucket` | — | Quota tracking primitives |

### Environment variables

| Variable | Effect |
|----------|--------|
| `OPENCODE_ANTIGRAVITY_DEBUG` | Force-enable debug log file |
| `OPENCODE_ANTIGRAVITY_DEBUG_TUI` | Force-enable TUI debug panel |
| `OPENCODE_ANTIGRAVITY_OAUTH_BIND` | Override OAuth callback bind host (`server.ts`) |
| `OPENCODE_CONFIG_DIR` | Override config dir (overrides `XDG_CONFIG_HOME`) |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME` | Standard XDG paths |
| `APPDATA`, `LOCALAPPDATA` | Windows path resolution |
| `OPENCODE_HEADLESS` / `SSH_*` / `REMOTE_CONTAINERS` / `CODESPACES` | Environment detection (skip browser, etc.) |
| `OPENCODE_IMAGE_ASPECT_RATIO` | Image generation aspect (default `1:1`) |
| `DISPLAY`, `WAYLAND_DISPLAY` | Linux GUI detection |

---

## OAuth Callback Server

**Source:** `src/plugin/server.ts`

| Aspect | Value |
|--------|-------|
| Port | `51121` (from `ANTIGRAVITY_REDIRECT_URI`) |
| Bind address | `127.0.0.1` (OrbStack compatibility) or `0.0.0.0` fallback |
| Protocol | HTTP (no TLS on local callback) |
| Success page | HTML with viewport meta, inline styles |
| Timeout | Rejects with error if no callback received |
| Path matching | Exact match against `redirectUri.pathname` |
| Env override | `OPENCODE_ANTIGRAVITY_OAUTH_BIND` |
| Environment detection | SSH, OrbStack, WSL, headless, remote containers |

**Phase 1 impact:** If redirect mode changes to official hosted callback, this server may become optional or unused.

---

## Caching Baseline

**Source:** `src/plugin/cache.ts`, `src/plugin/cache/signature-cache.ts`

### Auth cache

- In-memory `Map<string, OAuthAuthDetails>` keyed by normalized refresh token
- Favors unexpired tokens over expired ones
- No disk persistence for auth cache

### Signature cache

- Disk-backed thinking signature cache
- Path: `~/.config/opencode/` (XDG) or platform equivalent
- Used for Claude thinking block signature validation
- Supports cache miss fallback to `SKIP_THOUGHT_SIGNATURE` sentinel

---

## Error Handling Baseline

**Source:** `src/plugin/errors.ts`, `src/plugin.ts`

### HTTP status codes handled

| Code | Meaning | Plugin response |
|------|---------|-----------------|
| 400 | Invalid argument | Logged, may trigger recovery |
| 401 | Unauthorized | Token refresh attempt |
| 403 | Forbidden | Validation check, may trigger account switch |
| 429 | Rate limit | Exponential backoff, account rotation, header-style fallback |
| 503 | Service overloaded | Capacity retry with backoff |
| 529 | Service overloaded (Google-specific) | Capacity retry with backoff |

### Rate limit behavior

- First retry: 1s quick retry on same account
- Account switch: 5s delay before switching
- Consecutive 429 deduplication window: 120s
- Exponential backoff tiers: 5s, 10s, 20s, 30s, 60s
- Fingerprint regeneration on capacity exhaustion
- Toast notification cooldown: 5s

### Recovery triggers

- `tool_result_missing`: ESC during tool execution
- Response transform fallback: cloned responses, recovery signaling
- Thought signature validation: foreign signatures replaced with sentinels

---

## Config File Structure

**Source:** `src/plugin/config/loader.ts`, `src/plugin/storage.ts`

### Config directory precedence

1. `OPENCODE_CONFIG_DIR` (env override)
2. `XDG_CONFIG_HOME/opencode` (if set)
3. `~/.config/opencode` (all platforms including Windows)

### Config files

| File | Purpose |
|------|---------|
| `antigravity-accounts.json` | Account pool (OAuth tokens, fingerprints) |
| `antigravity.json` or similar | User-level plugin config (debug, claude_prompt_auto_caching, etc.) |
| Project-level config | Per-project overrides (via `.gemini/config/projects/`) |

### Gitignore

- Plugin ensures `.gitignore` in config dir excludes `antigravity-accounts.json*`
- Legacy Windows migration: `%APPDATA%/opencode` → `~/.config/opencode`

---

## Security Baseline

**Source:** codebase-wide

| Aspect | Current state |
|--------|---------------|
| Client secret | Hardcoded in `src/constants.ts` (public repo) |
| PKCE | S256, generated per auth flow |
| Token storage | `antigravity-accounts.json` (file, no encryption) |
| File permissions | Account file created with default umask |
| HTTPS | Only for Google API calls; local callback is HTTP |
| State encoding | Base64url JSON with PKCE verifier + projectId |
| Secret logging | Redaction policy in baseline doc; no automated secret scrubbing |

**Phase 1 impact:** Adding official redirect URI does not change client secret exposure. Consider whether client secret should be moved to env var or keyring in future.

---

## OAuth Test Coverage

**Source:** `src/plugin/auth.test.ts`, `src/constants.test.ts`

### Already covered

- `isOAuthAuth` discrimination
- `parseRefreshParts` (token + project parsing)
- `GEMINI_CLI_HEADERS` shape
- `getRandomizedHeaders` (antigravity / gemini-cli)
- Platform alignment between UA and `Client-Metadata`

### Not covered (gap, target Phase 1)

- `authorizeAntigravity()` URL construction (auth endpoint, redirect URI, scopes, PKCE challenge, state encoding)
- `exchangeAntigravity()` request body (grant_type, redirect_uri, code_verifier)
- State encode/decode round-trip
- Scope set parity with `agy`

---

## Build and Type-check Baseline

| Command | Result |
|---------|--------|
| `npm run typecheck` | ✅ Pass (no output, exit 0) |
| `npm run build` | ✅ Pass (`tsc -p tsconfig.build.json`) |
| `npm test` | ✅ 997 passed, 25 todo |

E2E suites (`test:e2e:models`, `test:e2e:regression`) not run in Phase 0 — require live credentials.

---

## Recent Changes Snapshot

**Source:** `CHANGELOG.md` v1.6.0 (2026-02-20)

Most recent fixes touch the same surface Phase 1+ will modify:

- Gemini `thought_signature` enforcement on tool-call payloads
- Request sanitization (empty `contents.parts`, invalid `systemInstruction.parts`)
- Response transform fallback (cloned responses, recovery signaling)
- Claude thinking/signature handling: foreign signatures replaced with sentinels
- `x-goog-user-project` stripped across both header styles
- Debug sink split: `debug` (file) vs `debug_tui` (panel)
- Optional `claude_prompt_auto_caching` flag

These constrain Phase 2/3 work — endpoint and transport changes must preserve these recent fixes.

---

## Sunset Timeline (External)

| Date | Event | Plugin impact |
|------|-------|---------------|
| 2026-05-19 | Antigravity CLI `1.0.0` GA, replaces Gemini CLI | Drift reference established |
| **2026-06-18** | **Gemini CLI + Code Assist IDE extensions stop serving** for Pro/Ultra/free Code Assist | `gemini-cli` header style may lose its quota pool; verification before this date is critical |
| Ongoing | Enterprise/paid API keys remain | Managed Agents API path (Phase 5) viable for paid users |

**Implication:** Phase 1–2 should land before 2026-06-18 if `gemini-cli` quota pool changes shape.

---

## Secrets / Redaction Policy

For all phases:

- **Never log:** access tokens, refresh tokens, OAuth authorization codes, PKCE verifiers, full callback URLs containing `code=`
- **OK to log:** account email, project ID (already in account store), endpoint host, header style, model name, HTTP status codes, error categories
- **Local-only artifacts:** debug request/response samples should live in `.gitignore`d `docs/evidence/` if needed; never commit raw payloads
- **This document:** Contains only structural facts (URLs, scopes, paths, code references). No secret values.

---

## Rollback Strategy

| Phase | Rollback path |
|-------|--------------|
| Phase 1 (OAuth) | Keep current `ANTIGRAVITY_REDIRECT_URI` constant as fallback; new redirect mode is additive. Revert by removing new mode and reverting scope list. |
| Phase 2 (endpoints/headers) | Endpoint constants are append-only. Keep current sandbox host until non-sandbox is verified live. Header-style toggle stays additive. |
| Phase 3 (transport boundary) | Refactor in feature branch only. Default path must remain `GatewayTransport`. |
| Phase 4 (`agy` adapter) | Opt-in only. Disable feature flag to revert. |
| Phase 5 (Managed Agents) | Opt-in only. Requires API key, no impact on OAuth path. |

---

## Drift Matrix (with priorities)

| Concern | Plugin | Official `agy` | Phase | Priority |
|---------|--------|----------------|-------|----------|
| Daily endpoint host | `.sandbox.googleapis.com` | `.googleapis.com` | 2 | **P0** |
| OAuth redirect URI | `http://localhost:51121` | `https://antigravity.google/oauth-callback` | 1 | **P0** |
| `openid` scope | Missing | Present | 1 | **P0** |
| Header-style quota pool (post 2026-06-18) | `gemini-cli` style still in use | Gemini CLI service sunset | 2 | **P0** |
| Auth URL path | `/oauth2/v2/auth` | `/oauth2/auth` | 1 | P1 |
| Antigravity UA version | Fallback `1.18.3` | CLI product `1.0.0` | 2 | P1 |
| `fetchAvailableModels` host alignment | Inherits ENDPOINTS_FALLBACKS | Non-sandbox daily | 2 | P1 |
| Integration model | Gateway shim | Full agent runtime | 3–4 | P2 (optional) |

**Priority key:** P0 = blocking risk pre-2026-06-18 sunset; P1 = drift cleanup; P2 = optional/strategic.

---

## Test Baseline

**Command:** `npm test` (after `npm install`)

| Metric | Result |
|--------|--------|
| Test files | 35 passed |
| Tests | 997 passed, 25 todo (1022 total) |
| Duration | ~3s |

No functional regressions detected at baseline. Tests cover OAuth helpers, request transform, accounts, quota, recovery, headers.

**Not run in Phase 0:** E2E model availability (`npm run test:e2e:models`), live API calls with user credentials.

---

## Live API / Model Behavior

**Not captured in Phase 0** (requires authenticated OpenCode session + debug logging):

- [ ] Per-model success/failure matrix (Claude vs Gemini variants)
- [ ] Debug-logged request/response samples (redacted)
- [ ] Endpoint fallback traces under rate limit
- [ ] Thinking signature / Claude tool-call edge cases

**Recommendation:** Enable plugin debug logging in a local OpenCode run and append samples to this doc or a gitignored `docs/evidence/` folder before Phase 1 merges.

---

## Shared Points: CLI ↔ Antigravity 2.0

From Google blog, `agy` README, and Managed Agents docs (research phase):

- Same **core agent harness** / server-side engine
- Shared concepts: skills, hooks, subagents, plugins/extensions
- Settings/permissions sync (official docs claim)
- Session export CLI → GUI
- Managed Agents API exposes `antigravity-preview-05-2026` via public `/v1beta/interactions` (API key, not OAuth gateway)

**Not equivalent to plugin transport:** Managed Agents and `agy --print` are agent-level APIs, not drop-in replacements for OpenCode's `generativelanguage.googleapis.com` shim.

---

## Known Failure Modes (pre-Phase 1)

Documented from prior auth investigation (no secrets repeated):

1. **OAuth code without matching PKCE verifier** → `invalid_grant` / "Invalid code verifier"
2. **Copying callback URL from browser** → `antigravity.google/oauth-callback` may not expose `code` for manual exchange
3. **`agy` auth timeout** → 30s hard limit; chat/browser automation too slow
4. **Endpoint mismatch** → sandbox vs non-sandbox daily host may cause 403/404 or quota routing differences (unverified live)

---

### `agy` plugin import (signals shared protocol)

`agy plugin help` exposes:

```
import [source]   Import plugins from gemini or claude
install <target>  Install a plugin (supports plugin@marketplace)
link <mp> <target>  Generate link to a marketplace
```

Implication: official CLI accepts plugin format from Gemini CLI and Claude tooling, confirming format-level continuity. Plugin migration tooling could be reused if we later mirror the Antigravity plugin spec.

### `agy` subcommands relevant to migration

| Subcommand | Use for migration |
|------------|-------------------|
| `install` | Idempotent shell-env install; reproducible setup |
| `update` | Test version drift |
| `plugin import` | Pull existing skills/hooks definitions |
| `changelog` | Track upstream protocol changes |

---

## Open Questions (carry to Phase 1+)

1. Does hosted redirect work for plugin-owned PKCE flows, or only for `agy`?
2. Is `daily-cloudcode-pa.sandbox.googleapis.com` deprecated for consumer accounts?
3. Are `antigravity` and `gemini-cli` header styles still separate quota pools after 2026-06-18?
4. Should auth URL use `/oauth2/auth` or stay on `/oauth2/v2/auth`?
5. Does `agy` expose machine-readable tool-call streams suitable for OpenCode?
6. Does `loadCodeAssist` still return the same project ID shape on non-sandbox daily host?
7. Will the Antigravity client ID/secret rotate when plugin migrates redirect URI?
8. Are `fetchAvailableModels` payloads the same shape across sandbox vs non-sandbox?
9. Are `antigravity` UA versions enforced server-side, or accepted leniently?
10. Does the `agy plugin import` format overlap with any plugin format we should mirror?

---

## Phase 0 Acceptance Checklist

| Criterion | Status |
|-----------|--------|
| Plugin OAuth/endpoints/headers inventoried from code | ✅ |
| Plugin API surface (`/v1internal:*` actions) inventoried | ✅ |
| Plugin model routing and quota preference rules recorded | ✅ |
| Plugin fingerprint/recovery/retry behavior documented | ✅ |
| Configuration knobs and env vars listed | ✅ |
| OAuth test coverage gaps identified | ✅ |
| Build (`tsc`) and typecheck baseline recorded | ✅ |
| Recent CHANGELOG fixes summarized as Phase 1+ constraints | ✅ |
| Sunset timeline (Gemini CLI 2026-06-18) documented | ✅ |
| Secrets / redaction policy stated | ✅ |
| Per-phase rollback strategy stated | ✅ |
| Drift matrix prioritized (P0/P1/P2) | ✅ |
| Official `agy` signals recorded (version, paths, logs) | ✅ |
| `agy` plugin/subcommand surface inventoried | ✅ |
| No secrets in docs | ✅ |
| No code changes | ✅ |
| Live per-model matrix | ⏳ Deferred (needs user session) |
| Live debug request/response samples | ⏳ Deferred (gitignored evidence dir) |
| Live endpoint fallback traces | ⏳ Deferred (rate-limit dependent) |

**Next step:** [Phase 1: OAuth Alignment](./ANTIGRAVITY_CLI_MIGRATION_PLAN.md#phase-1-oauth-alignment)
