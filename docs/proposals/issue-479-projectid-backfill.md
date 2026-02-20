# Proposal: Auto-resolve and persist missing project IDs

## Problem
Some OAuth accounts carry a refresh token but no `projectId`/`managedProjectId` in `refresh` parts. In the request path, `ensureProjectContext` can fail or fall back in ways that keep the account non-functional, and users end up needing manual recovery.

## Implementation
- Add backfill in the existing request-time project path (`ensureProjectContext` in `src/plugin/project.ts`), immediately before returning fallback project context.
- Trigger only for OAuth accounts with `refreshToken` present and missing `projectId` and `managedProjectId`.
- Backfill flow: refresh access token -> call `loadCodeAssist` across configured load endpoints -> extract managed project ID.
- Persist resolved IDs through existing auth/account persistence (`updateFromAuth` + save-to-disk path in `src/plugin.ts`) so no manual file edits are required.
- Cooldown policy: use existing per-account failure tracking (`trackAccountFailure`) with current thresholds (5 consecutive failures, then 30s cooldown) and store cooldown in account state (`coolingDownUntil`, `cooldownReason`).
- Failure logging: emit one structured warn log per failed backfill attempt with account fingerprint/email hash, endpoint attempted, failure class, and next action.

## Edge Cases
- `invalid_grant` while refreshing: mark auth invalid and skip backfill until next successful login.
- Partial `loadCodeAssist` failures: continue endpoint ladder, then return existing fallback behavior if all endpoints fail.
- Preserve manually configured IDs: treat a non-empty, pre-existing `projectId`/`managedProjectId` as authoritative and never overwrite it.

## Verify
- Fixture account with missing IDs is auto-backfilled on first request path through `ensureProjectContext`.
- Persisted account record contains resolved IDs after restart.
- Repeated backfill failures trigger cooldown at the documented threshold and log endpoint + reason without tight retry loops.
- Accounts with pre-set IDs retain those values after refresh/backfill attempts.
