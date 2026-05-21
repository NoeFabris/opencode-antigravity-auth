# Antigravity Auth Recovery / Login Hardening Plan

**Status:** Phase 7 plan and implementation checklist
**Goal:** ensure users can authenticate reliably before live gateway smoke tests or PR merge.

This phase exists because live testing showed the main risk is not request transformation anymore, but getting a valid OAuth session without being blocked by Google, `agy` timeouts, hosted callback behavior, or lost PKCE verifier state.

---

## Core constraint

A Google OAuth authorization code is only redeemable when all of these match the original authorization request:

- authorization code
- PKCE `code_verifier`
- OAuth `state`
- `redirect_uri`
- client ID / client secret

A code copied from Antigravity CLI (`agy`) is not enough unless the plugin also owns the matching PKCE verifier. The plugin must therefore own the OAuth flow or import a verified refresh token from a local credential store. It should not rely on `agy` as a chat-driven auth broker.

---

## Desired strategy

1. **Default:** plugin-owned local OAuth callback.
2. **Fallback:** manual paste of callback URL or authorization code, still using plugin-owned PKCE verifier.
3. **Experimental:** hosted Antigravity callback only if proven usable outside `agy`.
4. **Opt-in:** import existing local `agy`/Antigravity credentials only after explicit user consent and validation.
5. **Last resort:** `CliTransport` uses `agy` as an agent backend, not as the gateway provider.

---

## Phase 7A — Plugin-owned OAuth state store

### Problem

The current implementation embeds the PKCE verifier inside OAuth `state`. That makes manual fallback easy, but it increases leakage risk: anyone who sees the authorization URL also sees a recoverable verifier.

### Implementation

- Generate an opaque random `state` nonce.
- Store `{ state, verifier, projectId, redirectMode, expiresAt }` in plugin memory with a short TTL.
- Keep manual fallback working by extracting `state` from the generated authorization URL.
- Resolve the verifier from the in-memory store during token exchange.
- Delete state after exchange attempt to avoid replay.
- Keep a legacy decoder only for test/backward compatibility during this PR.
- Redact `state`, `code`, `code_verifier`, `code_challenge`, `access_token`, `refresh_token`, `id_token`, and `client_secret` from errors.

### Acceptance

- Authorization URL no longer contains a decodable verifier.
- Manual paste of only the code still works while the same plugin process owns the state.
- Full callback URL paste still works.
- Legacy base64 state exchange remains test-covered but is not generated anymore.

---

## Phase 7B — Local callback reliability

### Problem

The best path is local callback, but it must fail gracefully when the browser cannot reach localhost or the port is occupied.

### Implementation

- Start listener before opening the browser.
- Keep `127.0.0.1` default bind for local security.
- Keep environment override `OPENCODE_ANTIGRAVITY_OAUTH_BIND` for WSL/remote/OrbStack.
- On listener failure, immediately fall back to manual paste mode.
- Wait 120 seconds by default for browser consent/2FA before falling back to manual input.
- Allow `OPENCODE_ANTIGRAVITY_OAUTH_CALLBACK_TIMEOUT_MS` for slow consent flows; clamp between 10 seconds and 10 minutes.
- On soft timeout, keep instructions actionable and repeat the OAuth URL.
- Preserve callback server full timeout for slower users where the flow supports it.

### Acceptance

- Busy port does not block login permanently.
- Headless/remote environments produce manual instructions.
- Timeout error explains the next action instead of returning a black-box failure.

---

## Phase 7C — Hosted Antigravity callback experiment

### Problem

Official `agy` uses `https://antigravity.google/oauth-callback`, but browser testing showed the hosted page may consume or hide the code. That means the plugin may not be able to redeem it even with its own verifier.

### Implementation

- Keep `official-callback` mode available for experiments only.
- Do not make it the default.
- Document that hosted callback may be non-redeemable outside `agy`.
- If no `code` is visible, report that the hosted callback consumed the code and recommend local callback.

### Acceptance

- Users are not directed to the hosted callback as the normal login path.
- Failure is explained as a hosted callback limitation, not generic `invalid_grant`.

---

## Phase 7D — `agy` credential import investigation

### Problem

If the user is already logged in with Antigravity CLI, importing credentials may avoid another browser login. But storage may be in OS keychain and is not documented.

### Implementation plan

- Detect `agy` binary and version.
- Inspect non-secret config paths only:
  - `~/.gemini/antigravity-cli`
  - `~/.gemini/config`
  - macOS Keychain item names only if user opts in.
- Never print token values.
- If a refresh token can be found, validate it before storing:
  - refresh access token
  - fetch userinfo
  - call `loadCodeAssist`
- Back up `antigravity-accounts.json` before importing.

### Acceptance

- Import is opt-in.
- No token is logged.
- Only validated credentials are persisted.

---

## Phase 7E — Live smoke gate

Only after Phase 7A/7B passes:

1. Run a fresh OAuth login.
2. Refresh token once.
3. Resolve project with `loadCodeAssist`.
4. Run one low-risk gateway model smoke:

```bash
npx tsx script/test-models.ts --model google/antigravity-gemini-3.5-flash-low --timeout 120000
```

5. Then run one Claude/tool smoke:

```bash
npx tsx script/test-regression.ts --test thinking-bash-tool
```

---

## PR gate

Do not create the PR until:

- plugin-owned local OAuth login works end-to-end or has a documented manual fallback,
- OAuth errors are redacted and actionable,
- one gateway model smoke passes,
- no OAuth code, token, state, or verifier appears in logs/docs/tests.
