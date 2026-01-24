# Changelog

## [1.3.1] - 2026-01-21

### Added

- **New `google_search` tool for web search** - Implements Google Search grounding as a callable tool that the model can invoke explicitly
  - Makes separate API calls with only `{ googleSearch: {} }` tool, avoiding Gemini API limitation where grounding tools cannot be combined with function declarations
  - Returns formatted markdown with search results, sources with URLs, and search queries used
  - Supports optional URL analysis via `urlContext` when URLs are provided
  - Configurable thinking mode (deep vs fast) for search operations
  - Uses `gemini-3-flash` model for fast, cost-effective search operations

### Changed

- Upgraded to Zod v4 and adjusted schema generation for compatibility
- **Deprecated `web_search` config** - The `web_search.default_mode` and `web_search.grounding_threshold` config options are now deprecated. Google Search is now implemented as a dedicated tool rather than automatic grounding injection

### Fixed

- **`keep_thinking=true` now works without debug mode** - Fixed Claude multi-turn conversations failing with "Failed to process error response" when `keep_thinking=true` after tool calls, unless debug mode was enabled
  - Root cause: `filterContentArray` trusted any signature >= 50 chars for last assistant messages, but Claude returns its own signatures that Antigravity doesn't recognize
  - Fix: Now verifies signatures against our cache via `isOurCachedSignature()` before passing through. Foreign/missing signatures get replaced with `SKIP_THOUGHT_SIGNATURE` sentinel
  - Why debug worked: Debug mode injects synthetic thinking with no signature, triggering sentinel injection correctly

- **Fixed tool calls failing for tools with no parameters** - Tools like `hive_plan_read`, `hive_status`, and `hive_feature_list` that have no required parameters would fail with Zod validation error `state.input: expected record, received undefined`
  - Root cause: When Claude calls a tool with no parameters, it returns `functionCall` without an `args` field. The response transformation only processed parts where `functionCall.args` was defined, leaving `args` as `undefined`
  - Fix: Changed condition to handle all `functionCall` parts, defaulting `args` to `{}` when missing, ensuring opencode's `state.input` always receives a valid record

- **Auth headers aligned with official Gemini CLI** - Updated authentication headers to match the official Antigravity/Gemini CLI behavior, reducing "account ineligible" errors and potential bans ([#178](https://github.com/shay-wong/opencode-antigravity-auth/issues/178))
  - `GEMINI_CLI_HEADERS["User-Agent"]`: `9.15.1` → `10.3.0`
  - `GEMINI_CLI_HEADERS["X-Goog-Api-Client"]`: `gl-node/22.17.0` → `gl-node/22.18.0`
  - `ANTIGRAVITY_HEADERS["User-Agent"]`: Updated to full Chrome/Electron user agent string
  - Token exchange now includes `Accept`, `Accept-Encoding`, `User-Agent`, `X-Goog-Api-Client` headers
  - Userinfo fetch now includes `User-Agent`, `X-Goog-Api-Client` headers
  - `fetchProjectID` now uses centralized constants instead of hardcoded strings

- **`quiet_mode` now properly suppresses all toast notifications** - Fixed `quiet_mode: true` in `antigravity.json` not suppressing "Status dialog dismissed" and other toast notifications ([#207](https://github.com/shay-wong/opencode-antigravity-auth/issues/207))
  - Root cause: The `showToast` helper function didn't check `quietMode`, and only some call sites had manual `!quietMode &&` guards
  - Fix: Moved `quietMode` check inside `showToast` helper so all toasts are automatically suppressed when `quiet_mode: true`

### Removed

- **Removed automatic `googleSearch` injection** - Previously attempted to inject `{ googleSearch: {} }` into all Gemini requests, which never worked due to API limitations. Now uses the explicit tool approach instead

## [1.3.0] - Previous Release

See [releases](https://github.com/shay-wong/opencode-antigravity-auth/releases) for previous versions.
