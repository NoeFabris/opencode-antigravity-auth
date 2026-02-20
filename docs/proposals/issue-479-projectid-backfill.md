# Proposal: Auto-resolve and persist missing project IDs

## Problem
`ensureProjectContext` already attempts managed-project resolution, but the behavior is not fully specified for retry-noise suppression, manual-ID preservation, and verification coverage.

## Implementation
- Run in the existing request-time project path (`ensureProjectContext` in `src/plugin/project.ts`), synchronously for the current account/request.
- Trigger when OAuth `refreshToken` exists and `managedProjectId` is missing (whether `projectId` exists or not).
- Keep the existing resolution flow (`loadManagedProject` then `onboardManagedProject`) as the backfill mechanism.
- Persist resolved IDs through existing auth/account persistence (`updateFromAuth` + save path in `src/plugin.ts`).

### Delta vs Current Behavior
- Add explicit retry-noise suppression contract for project-context failures:
  - scope: per-account
  - threshold/duration: 5 consecutive failures -> 30s cooldown
  - state location: existing account cooldown fields (`coolingDownUntil`, `cooldownReason`)
  - reset: successful backfill clears failure/cooldown state for that account only
- Add required, structured warn-log schema on backfill failure:
  - `event`: literal `project_backfill_failed`
  - `account_fingerprint`: string
  - `email_hash`: SHA-256 hex of normalized email (`trim` + lowercase)
  - `endpoint`: string
  - `failure_class`: one of `invalid_grant | network_error | timeout | partial_response | unknown`
  - `cooldown_state`: `{ coolingDownUntil, consecutiveFailures }`
  - `next_action`: string
- Add manual-ID protection rule: introduce source semantics per field (`projectIdSource`, `managedProjectIdSource`, values `manual | auto`) so manually provided values are authoritative and not overwritten by auto-backfill.

## Edge Cases
- `invalid_grant` while refreshing:
  - set persisted backfill-block state `backfillBlockedReason=invalid_grant`
  - skip backfill and do not increment consecutive-failure cooldown counters
  - clear blocked state only after next successful OAuth login
- Partial `loadCodeAssist` failures: continue endpoint ladder and fall back safely if all fail.
- Manual `projectId` without `managedProjectId`: still allow managed-project backfill, but do not overwrite manual-source fields.

## Verify
- Fixture with missing `managedProjectId` backfills on first request path through `ensureProjectContext`.
- Persisted account record contains resolved IDs after restart.
- `invalid_grant` fixture is handled without crash, logs one clear structured failure event, and persists backfill-block state.
- Partial endpoint failure does not leave inconsistent partial project context.
- Cooldown behavior matches the explicit contract (5 failures -> 30s per-account cooldown; success clears same-account state).
- Manual-source IDs remain unchanged after backfill attempts.
