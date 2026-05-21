# Antigravity CLI Migration Plan

**Last Updated:** May 2026
**Status:** Detailed roadmap for review
**Phase 0 Baseline:** [ANTIGRAVITY_PHASE0_BASELINE.md](./ANTIGRAVITY_PHASE0_BASELINE.md)

This document is the central implementation roadmap for adapting this plugin to Google's Antigravity CLI and Antigravity 2.0 direction.

Phase 0 is intentionally **not duplicated here**. The complete evidence snapshot lives in [ANTIGRAVITY_PHASE0_BASELINE.md](./ANTIGRAVITY_PHASE0_BASELINE.md). This file describes the forward plan: phases, gates, tests, rollback paths, and decision criteria.

---

## Executive Direction

Use a hybrid strategy:

1. Keep the current OpenCode-compatible gateway shim as the default path.
2. Patch the highest-risk drift first: OAuth and endpoint/header alignment.
3. Add transport boundaries only after behavior is stable.
4. Treat `agy` and Managed Agents as optional agent-level experiments, not default low-level replacements.

Do **not** make `agy` the default backend unless it exposes a stable machine-readable protocol that can faithfully represent OpenCode streaming and tool calls.

---

## Current Architecture Constraint

The plugin currently behaves as a low-level provider shim:

```text
OpenCode
  └─ fetch() to generativelanguage.googleapis.com
      └─ plugin fetch interceptor
          └─ /v1internal:generateContent or /v1internal:streamGenerateContent
              └─ CloudCode / Antigravity gateway
```

Antigravity CLI (`agy`) is a full agent runtime, not a raw model API. Using it directly as the default backend would likely create a double-agent stack:

```text
OpenCode agent
  └─ agy agent
      └─ Antigravity agent runtime
```

That mode may be useful later, but it should be explicit and opt-in.

---

## What CLI Shares With Antigravity 2.0

Official public material indicates Antigravity CLI and Antigravity 2.0 share the same core agent harness / server-side engine, including:

- skills
- hooks
- subagents
- plugins / extensions
- persistent history
- permission and settings concepts
- multi-step reasoning and tool execution

This shared harness is relevant for future optional agent modes, but it does not automatically replace the low-level OpenCode provider interface.

---

## Phase Overview

| Phase | Name | Status | Primary outcome |
|-------|------|--------|-----------------|
| 0 | Evidence and Baseline | ✅ Complete | Baseline doc, drift matrix, tests, open questions |
| 1 | OAuth Alignment | Ready | Auth flow matches official CLI where safe |
| 2 | Endpoint and Header Reconciliation | ✅ Complete | Current gateway path uses verified endpoints/headers |
| 3 | Transport Boundary | ✅ Complete | Gateway logic isolated behind an interface |
| 4 | Optional `agy` Adapter | ✅ Complete (experimental) | Opt-in agent backend via CliTransport |
| 5 | Optional Managed Agents Adapter | ✅ Complete (experimental) | API-key-based public Antigravity harness via ManagedAgentTransport |
| 6 | Decision and Hardening | ✅ Complete | Default strategy documented, support matrix published |

---

## Global Non-Goals

- Do not automate Google passwords or 2FA.
- Do not commit OAuth codes, access tokens, refresh tokens, PKCE verifiers, or keyring material.
- Do not replace the default gateway shim with `agy` without a stable structured protocol.
- Do not rewrite auth, request transformation, endpoint routing, and transport architecture in one phase.
- Do not remove existing account storage until migration is proven and reversible.
- Do not assume preview Managed Agents APIs are stable or free-tier compatible.

---

## Global Validation Policy

Every implementation phase must run:

```bash
npm run typecheck
npm run build
npm test
```

Live tests are separate because they require user credentials:

```bash
npm run test:e2e:models
npm run test:e2e:regression
```

Live tests should only run when the user explicitly wants authenticated validation.

---

## Phase 0: Evidence and Baseline

**Status:** ✅ Complete
**Owner doc:** [ANTIGRAVITY_PHASE0_BASELINE.md](./ANTIGRAVITY_PHASE0_BASELINE.md)

### Purpose

Record current behavior before changing anything.

### Completed Outputs

- Plugin OAuth/endpoints/headers inventory.
- Official `agy` version, paths, auth shape, logs, and endpoint observations.
- API surface inventory for `/v1internal:*` actions.
- Model routing and quota-preference baseline.
- Fingerprint, recovery, retry, and header-style fallback baseline.
- Config and environment-variable inventory.
- OAuth test coverage gap list.
- `npm run typecheck`, `npm run build`, and `npm test` baseline.
- Recent `CHANGELOG.md` constraints.
- Gemini CLI sunset risk: **2026-06-18**.
- Secrets/redaction policy.
- Rollback strategy per phase.
- Prioritized drift matrix.

### Deferred Evidence

These are intentionally deferred because they require live authenticated sessions:

- Per-model availability matrix.
- Redacted debug request/response samples.
- Endpoint fallback traces under rate-limit conditions.

### Phase Gate

Phase 1 may start because Phase 0 has enough non-secret evidence to justify OAuth changes.

---

## Phase 1: OAuth Alignment

**Status:** ✅ Complete
**Risk level:** High impact, moderate implementation risk
**Primary drift addressed:** official callback URI, `openid`, auth URL shape

### Goal

Align the plugin's OAuth behavior with official `agy` signals while preserving current account storage and the existing local callback fallback.

### Baseline Drift

| Field | Current plugin | Official `agy` observed |
|-------|----------------|-------------------------|
| Auth endpoint | `https://accounts.google.com/o/oauth2/v2/auth` | `https://accounts.google.com/o/oauth2/auth` |
| Redirect URI | `http://localhost:51121/oauth-callback` | `https://antigravity.google/oauth-callback` |
| Scopes | 5 Google scopes | Same 5 + `openid` |
| PKCE | S256 | S256 |
| Client ID | Same as `agy` | Same as plugin |

### Implementation Tasks

1. Add an explicit redirect-mode concept:
   - `local-callback` for existing behavior.
   - `official-callback` for hosted callback experiments.
2. Add `openid` to the OAuth scope set.
3. Preserve the current local callback path as the default unless hosted callback is proven live.
4. Make OAuth URL construction testable without launching browser flows.
5. Add tests for:
   - authorization endpoint
   - redirect URI per mode
   - scope set including `openid`
   - PKCE challenge presence
   - opaque state storage and legacy state compatibility
   - token exchange body uses the same redirect URI and verifier
6. Ensure all OAuth error handling redacts:
   - authorization codes
   - OAuth state
   - PKCE verifiers
   - callback URLs containing `code=`
   - access/refresh/id tokens
   - client secrets
7. Document manual auth behavior and why `agy` cannot be used as a reliable chat-driven auth broker.

### Additional Phase 2 Considerations (from baseline)

- Error handling baseline: 429/503/529 backoff tiers, account rotation, fingerprint regeneration must remain functional after endpoint changes.
- Caching: signature cache path and auth cache behavior should not change.
- Rate limit deduplication window (120s) and exponential backoff tiers are tied to endpoint behavior.
- `gemini-cli` header style currently restricted to prod endpoint — verify this rule remains correct after endpoint reconciliation.

### Files Likely Touched

- `src/constants.ts`
- `src/antigravity/oauth.ts`
- `src/plugin/server.ts` (bind address, port, optional if hosted callback)
- `src/plugin/auth.test.ts` or new colocated OAuth tests
- `docs/CONFIGURATION.md`
- `docs/TROUBLESHOOTING.md`
- `docs/ANTIGRAVITY_API_SPEC.md`

### Additional Phase 1 Considerations (from baseline)

- OAuth callback server (`server.ts`) may become optional if hosted callback is proven.
- Client secret is currently hardcoded in `constants.ts` — consider env var or keyring if redirect URI changes.
- Auth cache is in-memory only; no disk persistence changes needed.
- OAuth state should be opaque; the PKCE verifier belongs in plugin-owned state storage, with legacy base64url state support only for backward-compatible exchange tests.

### Tests

Required:

```bash
npm run typecheck
npm run build
npm test
```

Targeted tests to add or expand:

```bash
npx vitest run src/antigravity/oauth.test.ts
npx vitest run src/plugin/auth.test.ts
```

### Live Validation

Only with user approval:

- Generate local callback auth URL and confirm existing login still works.
- Generate official callback URL and determine whether hosted callback can be used outside `agy`.
- Confirm token exchange succeeds only when redirect URI and PKCE verifier match.

### Acceptance Criteria

- Existing stored accounts still load.
- Local callback auth still works or has a documented fallback.
- The plugin can generate an OAuth URL matching official CLI fields.
- OAuth tests cover scope, redirect, endpoint, PKCE, opaque state storage, and legacy state behavior.
- Failed OAuth attempts return actionable redacted errors.
- No tokens, codes, or PKCE verifiers are logged.

### Rollback

- Keep current `ANTIGRAVITY_REDIRECT_URI` path intact.
- If official callback fails, disable official mode and retain only local callback + `openid` if harmless.
- Revert scope list only if Google rejects `openid` for this client.

### Phase Gate

Proceed to Phase 2 only after OAuth tests pass and the selected default redirect mode is documented.

---

## Phase 2: Endpoint and Header Reconciliation

**Status:** ✅ Complete
**Risk level:** High impact, high runtime risk
**Primary drift addressed:** sandbox daily host vs official non-sandbox daily host, quota headers, Gemini CLI sunset

### Goal

Reconcile gateway endpoints and request headers with official `agy` runtime observations while preserving the current working fallback path.

### Baseline Drift

| Concern | Current plugin | Official `agy` observed | Priority |
|---------|----------------|-------------------------|----------|
| Daily endpoint | `daily-cloudcode-pa.sandbox.googleapis.com` | `daily-cloudcode-pa.googleapis.com` | P0 |
| Gemini CLI header pool | Still used | Gemini CLI service sunset 2026-06-18 | P0 |
| `fetchAvailableModels` host | Inherits plugin endpoints | Non-sandbox daily in logs | P1 |
| Antigravity version | `1.18.3` fallback | `agy` product version `1.0.0` | P1 |

### Implementation Tasks

1. Add non-sandbox daily endpoint as a candidate endpoint without deleting existing sandbox endpoint.
2. Decide endpoint order by live evidence, not binary strings alone.
3. Ensure all endpoint consumers are inventoried and aligned:
   - generate/stream requests
   - `loadCodeAssist`
   - `onboardUser`
   - `fetchAvailableModels`
   - Google Search grounding path
   - account verification path
4. Add debug logging for every outbound gateway request:
   - endpoint host
   - action name
   - header style
   - model family
   - selected account index/email hash or redacted email
   - HTTP status
5. Keep both header styles until live evidence proves one is invalid:
   - `antigravity`
   - `gemini-cli`
6. Add tests for endpoint selection and fallback order.
7. Add tests that `gemini-cli` style never uses non-prod endpoints if that rule remains intended.
8. Verify fingerprint header composition remains limited and compatible.
9. Update API spec docs with endpoint status:
   - verified live
   - observed in `agy`
   - legacy fallback
   - unavailable

### Additional Phase 2 Considerations (from baseline)

- Error handling baseline: 429/503/529 backoff tiers, account rotation, fingerprint regeneration must remain functional after endpoint changes.
- Caching: signature cache path and auth cache behavior should not change.
- Rate limit deduplication window (120s) and exponential backoff tiers are tied to endpoint behavior.
- `gemini-cli` header style currently restricted to prod endpoint — verify this rule remains correct after endpoint reconciliation.

### Files Likely Touched

- `src/constants.ts`
- `src/plugin/request.ts`
- `src/plugin.ts`
- `src/plugin/project.ts`
- `src/plugin/quota.ts`
- `src/plugin/search.ts`
- `src/plugin/fingerprint.ts`
- `docs/ANTIGRAVITY_API_SPEC.md`
- `docs/TROUBLESHOOTING.md`

### Tests

Required:

```bash
npm run typecheck
npm run build
npm test
```

Targeted:

```bash
npx vitest run src/constants.test.ts
npx vitest run src/plugin/request.test.ts
npx vitest run src/plugin/quota-fallback.test.ts
npx vitest run src/plugin/antigravity-first-fallback.test.ts
npx vitest run src/plugin/model-specific-quota.test.ts
```

### Live Validation

Only with user approval:

- Test `loadCodeAssist` on prod, sandbox daily, and non-sandbox daily.
- Test `fetchAvailableModels` on all candidates.
- Test one Gemini model and one Claude model per header style.
- Capture redacted endpoint fallback traces.

### Acceptance Criteria

- Endpoint order is explicitly justified in docs.
- Endpoint fallback behavior is deterministic and test-covered.
- Header style behavior remains explicit.
- Debug logs can explain every selected endpoint/header/account decision.
- The existing gateway path remains default.

### Rollback

- Keep current sandbox daily endpoint until non-sandbox daily is proven.
- Make new endpoint order additive and reversible.
- If non-sandbox daily fails, demote it behind sandbox/prod or disable it.
- If `gemini-cli` header style stops working after sunset, disable it via routing rather than deleting code immediately.

### Phase Gate

Proceed to Phase 3 only after endpoint/header behavior is stable and covered by tests.

---

## Phase 3: Transport Boundary

**Status:** ✅ Complete
**Risk level:** High refactor risk
**Primary purpose:** make future transports possible without destabilizing the gateway shim

### Goal

Isolate the existing gateway shim behind a transport boundary while preserving behavior.

### Proposed Shape

```text
OpenCode request
  └─ Provider adapter
      ├─ GatewayTransport      current /v1internal gateway shim
      ├─ CliTransport          optional agy process adapter
      └─ ManagedAgentTransport optional public interactions API adapter
```

### Design Rules

- First refactor must be behavior-preserving.
- Do not move auth, endpoint reconciliation, and transport extraction in the same PR.
- Keep Claude thinking/signature logic covered before and after extraction.
- Keep recovery semantics unchanged.
- Keep quota/account rotation outside optional transports where possible.

### Implementation Tasks

1. Define the smallest useful transport interface around:
   - request recognition
   - request preparation
   - response transformation
   - streaming transformation
   - model capability metadata
   - auth requirements
2. Wrap the current logic as `GatewayTransport`.
3. Keep default path unchanged.
4. Add fixture tests before moving complex request transformation code.
5. Move code in small chunks:
   - endpoint/header selection
   - request body transformation
   - response transformation
   - streaming transformation
   - recovery hooks
6. Add debug labels showing active transport.
7. Document transport responsibilities and non-responsibilities.

### Additional Phase 2 Considerations (from baseline)

- Error handling baseline: 429/503/529 backoff tiers, account rotation, fingerprint regeneration must remain functional after endpoint changes.
- Caching: signature cache path and auth cache behavior should not change.
- Rate limit deduplication window (120s) and exponential backoff tiers are tied to endpoint behavior.
- `gemini-cli` header style currently restricted to prod endpoint — verify this rule remains correct after endpoint reconciliation.

### Files Likely Touched

- `src/plugin.ts`
- `src/plugin/request.ts`
- `src/plugin/core/*`
- possible new `src/plugin/transport/*`
- tests around request/response/streaming transforms
- `docs/ARCHITECTURE.md`

### Tests

Required:

```bash
npm run typecheck
npm run build
npm test
```

Targeted:

```bash
npx vitest run src/plugin/request.test.ts
npx vitest run src/plugin/transform/gemini.test.ts
npx vitest run src/plugin/request-helpers.test.ts
npx vitest run src/plugin/recovery.test.ts
npx vitest run src/plugin/thinking-recovery.test.ts
```

### Acceptance Criteria

- No default behavior change.
- All existing tests pass.
- `GatewayTransport` is the only default transport.
- Future transports can be added without deeply editing the fetch interceptor.
- Architecture docs explain the boundary.

### Rollback

- Refactor must be decomposable.
- If tests regress, revert the extraction and keep Phase 1–2 changes.
- Do not merge partial extraction that changes runtime behavior without explicit acceptance.

### Phase Gate

Proceed to Phase 4/5 only after the gateway transport is stable and documented.

---

## Phase 4: Optional `agy` Process Adapter

**Status:** ✅ Complete (experimental / opt-in only)
**Risk level:** Medium implementation risk, high UX ambiguity
**Primary purpose:** expose official Antigravity agent runtime as an optional mode

### Goal

Explore `agy` as a high-level agent backend, not as a replacement for raw model streaming.

### Intended Use

```text
OpenCode high-level prompt
  └─ CliTransport
      └─ agy --print / --prompt
          └─ Antigravity agent runtime
```

This mode should be explicit, for example:

- provider option: `antigravity-agent`
- model alias: `agy-agent`
- command-only integration outside normal model list

### Implementation Tasks

1. Detect `agy` binary path.
2. Detect version via `agy changelog` or another stable command.
3. Detect authentication state without triggering a blocking auth flow if possible.
4. Add an opt-in config flag.
5. Run controlled `agy --print` smoke tests.
6. Capture stdout/stderr/log-file behavior.
7. Define what can be mapped back:
   - final text
   - process error
   - timeout
   - auth-required message
8. Do **not** map internal `agy` tool calls into OpenCode tool calls unless `agy` exposes a stable machine-readable event stream.
9. Document double-agent limitations clearly.

### Additional Phase 2 Considerations (from baseline)

- Error handling baseline: 429/503/529 backoff tiers, account rotation, fingerprint regeneration must remain functional after endpoint changes.
- Caching: signature cache path and auth cache behavior should not change.
- Rate limit deduplication window (120s) and exponential backoff tiers are tied to endpoint behavior.
- `gemini-cli` header style currently restricted to prod endpoint — verify this rule remains correct after endpoint reconciliation.

### Files Likely Touched

- new `src/plugin/transport/cli-transport.ts` or equivalent
- config schema
- docs/config/troubleshooting
- tests using mocked child processes

### Tests

Required:

```bash
npm run typecheck
npm run build
npm test
```

Targeted:

- process adapter tests with mocked `agy`
- timeout tests
- auth-required output tests
- missing-binary tests

### Live Validation

Only with user approval:

- `agy --print "Say hi"` with already-authenticated CLI.
- Missing-auth behavior.
- Timeout behavior.

### Acceptance Criteria

- Mode is disabled by default.
- Missing `agy` produces a clear error.
- Unauthenticated `agy` produces a clear error and does not hang.
- No Google auth automation is attempted.
- Documentation states this is an agent backend, not a raw model backend.

### Rollback

- Disable feature flag.
- Remove provider alias without affecting `GatewayTransport`.
- Keep all code paths opt-in until proven stable.

### Phase Gate

Proceed to Phase 6 decision only after the adapter's UX limitations are measured.

---

## Phase 5: Optional Managed Agents API Adapter

**Status:** ✅ Complete (experimental / opt-in only)
**Risk level:** Medium implementation risk, external API instability risk
**Primary purpose:** evaluate official public Antigravity harness API

### Goal

Evaluate Google's public Managed Agents / Interactions API as a more official Antigravity-compatible path.

### Public API Signals

```text
Base agent:      antigravity-preview-05-2026
API surface:     /v1beta/interactions and /v1beta/agents
Required header: Api-Revision: 2026-05-20
Auth style:      Gemini API key
```

### Key Constraint

This is an API-key path, not the current free OAuth gateway path. It should never silently replace OAuth accounts.

### Implementation Tasks

1. Add an opt-in feature flag and config block.
2. Use API-key auth only.
3. Prototype single-turn interactions.
4. Prototype multi-turn interactions via `previous_interaction_id` if supported.
5. Prototype streaming if available.
6. Compare tool behavior with OpenCode expectations.
7. Document pricing/billing/API-key implications.
8. Keep Managed Agents separate from OAuth account rotation.
9. Avoid mixing this path with internal `/v1internal:*` state.

### Additional Phase 2 Considerations (from baseline)

- Error handling baseline: 429/503/529 backoff tiers, account rotation, fingerprint regeneration must remain functional after endpoint changes.
- Caching: signature cache path and auth cache behavior should not change.
- Rate limit deduplication window (120s) and exponential backoff tiers are tied to endpoint behavior.
- `gemini-cli` header style currently restricted to prod endpoint — verify this rule remains correct after endpoint reconciliation.

### Files Likely Touched

- new `ManagedAgentTransport`
- config schema
- provider/model registration
- docs/config/troubleshooting/API spec
- tests with mocked HTTP responses

### Tests

Required:

```bash
npm run typecheck
npm run build
npm test
```

Targeted:

- API-key missing tests
- request shape tests
- response mapping tests
- streaming parser tests if supported

### Live Validation

Only with user approval and user-provided API key:

- single-turn prompt
- multi-turn prompt
- failure behavior with invalid key
- rate-limit behavior

### Acceptance Criteria

- Disabled by default.
- Requires explicit API key.
- Does not affect OAuth gateway mode.
- Docs clearly separate gateway mode from managed-agent mode.
- Preview limitations are documented.

### Rollback

- Disable feature flag.
- Remove API-key config without touching OAuth gateway.
- Keep implementation isolated behind transport boundary.

### Phase Gate

Proceed to Phase 6 only after cost, UX, and protocol fit are clear.

---

## Phase 6: Decision and Hardening

**Status:** ✅ Complete
**Risk level:** Strategic decision point

### Goal

Decide which path should be default, which should remain opt-in, and what should be deprecated.

### Decision Inputs

- Phase 1 OAuth reliability.
- Phase 2 endpoint/header live stability.
- Gemini CLI sunset impact after 2026-06-18.
- GatewayTransport test stability.
- `agy` adapter UX and protocol limitations.
- Managed Agents API pricing, stability, and protocol fit.
- User feedback from real OpenCode sessions.

### Decision Options

| Option | Description | Choose when |
|--------|-------------|-------------|
| Keep GatewayTransport default | Continue current OpenCode-native gateway shim | Low-level streaming/tool-call behavior remains stable |
| Hardened hybrid default | Use updated OAuth/endpoints/headers with gateway transform | Auth/endpoints were the main breakage |
| `agy` opt-in only | Keep agent backend as explicit mode | Users value official runtime but semantics differ |
| Managed Agents opt-in | Offer API-key public harness path | Users accept billing/preview limitations |
| Full replacement | Remove gateway shim | Only if official low-level protocol becomes available |

### Hardening Tasks

1. Finalize support matrix:
   - OAuth gateway mode
   - `agy` mode
   - Managed Agents mode
2. Document model support:
   - Gemini variants
   - Claude variants
   - image generation
   - Google Search grounding
3. Document account/credential storage per mode.
4. Document rate-limit behavior per mode.
5. Add migration notes for existing users.
6. Add troubleshooting entries for common auth/endpoint failures.
7. Update README installation and usage.
8. Add CHANGELOG entry.
9. Consider release candidate tag before final release.

### Acceptance Criteria

- Default path is documented and justified.
- Optional paths are explicitly marked experimental or stable.
- Tests pass.
- Live smoke tests are recorded if credentials are available.
- Rollback instructions are documented.
- README and configuration docs match implementation.

### Rollback

- Keep previous release branch/tag.
- Keep old endpoint/header defaults behind fallback when possible.
- Disable optional transports via config.
- Revert only the decision-layer changes if gateway remains healthy.

---

## Cross-Phase Dependency Map

```text
Phase 0 baseline
  └─ Phase 1 OAuth alignment
      └─ Phase 2 endpoint/header reconciliation
          └─ Phase 3 transport boundary
              ├─ Phase 4 agy adapter
              └─ Phase 5 Managed Agents adapter
                  └─ Phase 6 decision/hardening
```

Phase 4 and Phase 5 can be explored in parallel after Phase 3, but neither should become default before Phase 6.

---

## Completeness Checklist

Use this checklist before starting implementation:

| Area | Covered |
|------|---------|
| Phase 0 is single-sourced in baseline doc | ✅ |
| OAuth drift and tests planned | ✅ |
| Endpoint/header drift and live validation planned | ✅ |
| Gateway transport extraction planned after stabilization | ✅ |
| `agy` adapter explicitly opt-in | ✅ |
| Managed Agents adapter explicitly opt-in and API-key-only | ✅ |
| Build/typecheck/test requirements stated | ✅ |
| Live credential-dependent validation separated | ✅ |
| Secrets/redaction rules inherited from baseline | ✅ |
| Rollback path for every phase | ✅ |
| Gemini CLI sunset risk included | ✅ |
| Documentation update targets included | ✅ |
| Decision criteria for final default strategy included | ✅ |

---

## Recommended Immediate Next Step

Start Phase 1 with tests first:

1. Add OAuth URL/body tests for current behavior.
2. Add `openid` and redirect-mode support.
3. Verify local callback still works.
4. Only then experiment with official hosted callback.

This keeps the highest-risk auth change small, testable, and reversible.
