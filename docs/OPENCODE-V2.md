# OpenCode V2 migration

Target runtime: OpenCode 2.1.2, using `@opencode/plugin` 2.1.2 and the Google AI
SDK 3 adapter. `@opencode-ai/plugin` and the older SDK's `/v2` import are separate
APIs; upgrading that SDK alone does not make a V1 plugin run in V2.

## Installation and configuration

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-antigravity-auth@latest"]
}
```

Published V2 releases use this package entry. To test an unreleased
checkout, run `npm ci && npm run build` and put its absolute directory in
`plugins` instead of the npm package name.

Models are discovered from the enabled accounts' `fetchAvailableModels` response.
The catalog follows `agentModelSorts` and `tieredModelIds`, excluding disabled,
internal, image-generation, and retired alias entries. Names and token limits
come from Google; backend tier suffixes are preserved. Model routing selects only
accounts advertising the requested model. Results are cached for an
hour, keyed to the enabled account pool. `/antigravity` → **Refresh available
models** updates the catalog immediately. If discovery fails, the last known
catalog or a small fallback catalog remains usable.

Manual overrides belong under `providers`:

```json
{
  "providers": {
    "google": {
      "models": {
        "antigravity-claude-opus-4-6-thinking": {
          "capabilities": {
            "tools": true,
            "input": ["text", "image", "pdf"],
            "output": ["text"]
          },
          "variants": [
            { "id": "max", "settings": { "thinkingConfig": { "thinkingBudget": 32768 } } }
          ]
        }
      }
    }
  }
}
```

V2 uses `plugins` and `providers`, capability arrays, and variant arrays with
`settings` overlays. A model reference selects a variant with `#high` or `#max`.
Use `opencode models` to inspect the effective catalog.

Connect Google using its **Google OAuth (Antigravity)** method. Repeat login to
add accounts; the existing account pool, quota tracking, and rotation remain in
use. Selecting a different Google authentication method keeps that method's
credentials separate from Antigravity. The plugin does not delete its account
pool when another method is selected. The pool is independent of V2 credentials:
removing a Google connection does not erase saved accounts. Disable accounts in
the pool or remove the plugin to stop pool-based access; keep a backup before
editing account storage.

## Account and quota menu

Run `/antigravity` (alias `/ag`) inside OpenCode, or choose **Antigravity accounts
and quotas** from the command palette. The package exports `./tui`; local
checkouts also include a `tui.js` loader shim, so no extra CLI configuration is
needed.

The menu lists every saved account, including disabled accounts and the active
selection. It supports adding accounts, checking quotas and reset times,
verifying access, enabling/disabling accounts, selecting an account,
re-authentication, and confirmed deletion. Deletion removes matching native
OpenCode credentials before removing the pool entry. Routine checks skip
disabled accounts; explicitly checking one still verifies its access. Opening
the menu itself does not refresh saved credentials.

Quota details show one account at a time. Both Antigravity and Gemini CLI quotas
are displayed when available. In V2, `antigravity-*` inference uses Antigravity
OAuth. Native Google API-key models are hidden while an Antigravity OAuth
connection is selected. Switching to an API-key connection restores those models.

## Runtime changes

The package's default export provides `id` and `setup(ctx)` for V2, plus a
`server` entrypoint for V1.18.29+. V2 registration uses integration, provider,
model, AI SDK, and tool domains. The AI SDK adapter sends requests through the
existing Antigravity transport, retaining request transformation, streaming,
OAuth refresh, account rotation, quota handling, and thinking signatures.

The adapter scopes transport changes to `antigravity-*` models and retains the
native Google models and their pricing. It resolves the installed Google SDK to
a local module URL because OpenCode 2.1.2 converts the standard SDK package name
to its native transport. The final model transform keeps Antigravity requests on
the SDK hook.

The V2 config writer updates plugin entries and preserves provider objects. Core
migrates legacy `provider` settings; adding a competing `providers.google` object
can hide the entire legacy Google provider, including custom models. V2 owns session repair and package updates; the V1
filesystem recovery and config updater do not run in a V2 instance. Plugin
cleanup aborts in-flight work and stops refresh resources.

## Current Antigravity protocol

The migration also updates the Hub identity and version manifest, uses the
non-sandbox daily endpoint for consumer Antigravity requests, removes unsupported
project metadata, and strips the Google SDK API key before OAuth requests.
The legacy V1 entrypoint keeps Gemini CLI's separate production endpoint and
OAuth behavior. In V2, ordinary Gemini model IDs retain OpenCode's native Google
transport; use `antigravity-*` IDs for this plugin's OAuth account pool.

The Google OAuth client, scopes, and callback remain those of the existing Hub
integration. The newer `agy` CLI is a different client identity; its hosted
callback and CLI transport are not interchangeable with this plugin's flow.

Backend model availability depends on the signed-in account. A successful
plugin-load or mocked transport test does not prove that an account has access
to a particular model. Google's `invalid_grant` response means the refresh token
is no longer usable and a fresh login is needed.

## Verification

```bash
npm run typecheck
npm test
npm run build
OPENCODE_BIN=/absolute/path/to/opencode npm run test:e2e:v2
```

The V2 runtime test runs the actual CLI in temporary config, data, state, and
cache directories with synthetic accounts and controlled Google responses. It
checks both model families, streaming, thinking variants, tool execution and
tool-result round trips, the daily endpoint, Hub identity, and API key stripping.
It also checks that Antigravity OAuth hides native Google API-key models.
It never reads the user's account files. Pass a built package directory as the
script's argument to verify an unpacked npm archive. The default test includes
the migrated V1 credential shape. Set `OPENCODE_V2_TEST_AUTH=pool` for pool-only
auth or `OPENCODE_V2_TEST_AUTH=v2` for an expired native V2 OAuth connection. CI
checks all three modes against a freshly installed npm archive. Set
`KEEP_OPENCODE_V2_FIXTURE=1` to retain temporary evidence after a failure.

Authenticated checks are separate:

```bash
opencode run --model=google/antigravity-gemini-3.8-flash-high "Reply exactly WORKING"
opencode run --model=google/antigravity-claude-opus-4-6-thinking#max "Reply exactly WORKING"
```

## Sources and compatibility mention

### Verification on October 21, 2026

- OpenCode 2.1.2: typecheck and build pass; 1,182 automated tests pass.
- Seven models from the signed-in account's selectable inventory return actual
  assistant text: Gemini 3.8 Flash low/medium/high, Gemini 3.5 Flash Lite,
  Claude Sonnet 4.6, Claude Opus 4.6 Thinking, and GPT-OSS 120B Medium.
  A later Claude rerun reached the default 90% soft quota guard; the guard was
  kept enabled. Both Claude models had passed authenticated checks earlier.
- Four authenticated tool round trips pass, including two session continuations
  switching between Gemini and Claude with tool history intact.
- The `google_search` tool returns actual search results and grounded source URLs
  through an authenticated OpenCode session.
- The native `/ag` menu lists all saved accounts and displays live quota
  percentages and reset times. Disabled accounts are skipped during routine
  checks; their entries remain visible in the account list. The installed archive's
  enable/disable round trip preserves all 13 saved accounts and restores the
  enabled account and current selection. Canceling deletion preserves the pool;
  confirming deletion removes only the selected account from the temporary copy.
- Retired model entries from an existing config are disabled in the native model
  picker and rejected before inference, rather than falling through to Google's
  native API-key transport.
- A freshly installed npm archive passes Node ESM imports, public declaration
  checks, and twelve real CLI cases using controlled Google responses across
  migrated V1, pool-only, and native V2 OAuth modes. These controlled tests are
  separate from the authenticated checks above.

Global OpenCode configuration and saved credentials were left unchanged; live
checks used isolated temporary copies.

- [Official V1-to-V2 plugin migration](https://dev.opencode.ai/v2/docs/build/plugins/migrate-v1)
- [Official V2 plugin API](https://dev.opencode.ai/v2/docs/build/plugins)
- [V2 AI SDK transport bridge](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/aisdk.ts)
- [Current Hub identity and version discovery in CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/misc/antigravity_version.go)
- [Consumer endpoint investigation](https://github.com/router-for-me/CLIProxyAPI/issues/5209)
- [Current request protocol investigation](https://github.com/router-for-me/CLIProxyAPI/issues/6619)
- [Community compatibility ping, October 17, 2026](https://github.com/Heretek-AI/awesome-opencode/issues/514#issuecomment-6237678849)

The ping came from the community catalog, which labels the existing release
`V1 only`. It was not a plugin-specific incompatibility notice in the official
OpenCode docs. The catalog's compatibility metadata can be updated after a
V2-capable release is available.
