# Proposal: Auto-resolve and persist missing project IDs

## Problem
Some OAuth accounts carry a refresh token but no `projectId`/`managedProjectId` in refresh parts. In the request path, this can cause repeated project-context failures that make the account effectively unusable without manual repair.

## Implementation
- Apply backfill in the existing request-time path (`ensureProjectContext` in `src/plugin/project.ts`) on the first request that detects missing project IDs.
- Run synchronously in that request path (blocking for that account only) so the current request can immediately benefit from resolved IDs.
- Trigger only when `refreshToken` exists and both `projectId` + `managedProjectId` are empty.
- Backfill flow: refresh access token -> call `loadCodeAssist` across configured load endpoints -> extract managed project ID.
- Persist resolved IDs through existing auth/account persistence (`updateFromAuth` + save-to-disk path in `src/plugin.ts`) so manual file edits are unnecessary.
- Cooldown/cache policy (explicit):
  - scope: per-account
  - mechanism: reuse existing in-memory failure tracker (`trackAccountFailure`)
  - threshold/duration: 5 consecutive failures -> 30s cooldown
  - reset: success clears failure state for that same account only; no global reset
- Failure logging: emit one structured warn log per failed attempt with account fingerprint/email hash, endpoint attempted, failure class, and next action.

## Edge Cases
- `invalid_grant` while refreshing: mark auth invalid and skip backfill until next successful login.
- Partial `loadCodeAssist` failures: continue endpoint ladder, then return existing fallback behavior if all endpoints fail.
- Preserve manually configured IDs: treat an account with explicit `projectId` and no managed project as manual input (optionally track `projectIdSource=manual`) and do not overwrite it during backfill.

## Verify
- Fixture account with missing IDs is auto-backfilled on first request path through `ensureProjectContext`.
- Persisted account record contains resolved IDs after restart.
- `invalid_grant` fixture is handled without crash, logs one clear failure, and does not enter tight retry loops.
- Partial `loadCodeAssist` response does not leave partially-written inconsistent project context.
- Repeated failures trigger per-account 30s cooldown after the 5-failure threshold; successful backfill clears that account's failure state.
- Accounts with manual/pre-set IDs retain those values after refresh/backfill attempts.
