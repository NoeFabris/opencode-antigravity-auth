# Proposal: Add auth doctor diagnostics command

## Problem
Users currently inspect storage and logs manually to understand why accounts are not request-ready.

## Command Contract
- Command: `opencode auth doctor`
- Flags:
  - `--json` output machine-readable diagnostics
  - `--route <antigravity|gemini-cli|all>` scope readiness checks
  - `--account <email|index>` filter to one account
  - `--verbose` include raw reason details
- Exit codes:
  - `0`: at least one account request-ready
  - `1`: no account request-ready
  - `2`: command/runtime failure (parse/storage/read errors)

## Request-Ready Definition
An account is request-ready for a route when all are true:
- enabled
- refresh token exists and is not expired/invalid
- required project context is present for that route
- not cooling down/rate-limited for requested route/model
- not marked verification-required/ineligible

## Implementation
- Add doctor evaluator that computes per-account status and emits deterministic reason codes.
- Reason codes include: `ok`, `disabled`, `missing_refresh`, `refresh_expired`, `missing_project`, `ineligible`, `cooling_down`, `verification_required`.
- Text output shows compact table: account, route, status, reason, next action.
- JSON output schema:
  - `summary`: `{ ready_count, total_count }`
  - `accounts[]`: `{ id, email, route, status, reason_code, cooldown_until, next_action }`
- `next_action` examples: `opencode auth login`, `re-enable account`, `wait_for_cooldown`, `set project id`.

## Edge Cases
- No accounts configured: emit empty summary with actionable next step.
- Malformed account entries: mark row `invalid_record` and continue scanning others.
- Mixed-route readiness: account may be ready for one route and blocked for another; report per-route status.

## Verify
- Fixture matrix (healthy + missing_project + ineligible + expired_refresh + cooling_down) returns stable text and JSON ordering.
- Expected outcomes:
  - healthy -> `status=ok`, `next_action=none`
  - expired refresh -> `reason_code=refresh_expired`, `next_action=opencode auth login`
  - missing project -> `reason_code=missing_project`, `next_action=set project id`
  - cooling down -> includes `cooldown_until` and `next_action=wait_for_cooldown`
- Exit code is `1` when all fixtures are non-ready, `0` when at least one is ready.
