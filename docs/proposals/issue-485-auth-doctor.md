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
  - `0`: at least one account-route is request-ready
  - `1`: no account-route is request-ready
  - `2`: command/runtime failure (parse/storage/read errors)
- `--account` scope rule: when filter is set, exit-code evaluation uses only the filtered account-route rows (other accounts do not satisfy readiness).

## Request-Ready Definition
Readiness is evaluated per `account x route` pair.
- Common requirements:
  - account enabled
  - refresh token present
  - not cooling down/rate-limited for the evaluated route/model
  - `verificationRequired` is false
- Route requirements:
  - `antigravity`: requires project context (`projectId` or `managedProjectId`)
  - `gemini-cli`: project context optional
- Refresh validity note: expiry/invalidity is determined by refresh probe outcome (server/auth error), not local expiry timestamp.

## Implementation
- Add doctor evaluator that computes deterministic per-account-route status rows.
- Output one row per account-route pair (not one row per account).
- Reason codes include: `ok`, `disabled`, `missing_refresh`, `refresh_invalid`, `missing_project`, `ineligible`, `cooling_down`, `verification_required`, `invalid_record`.
- Text output table columns: `account`, `route`, `status`, `reason`, `next_action`.
- JSON output schema:
  - `summary`: `{ ready_count, total_count, invalid_count }`
  - `accounts[]`: `{ id, email, route, status, reason_code, cooldown_until, next_action }`
- Counting rules:
  - `ready_count` counts rows with `status=ok`
  - `total_count` counts all emitted account-route rows
  - `invalid_count` counts rows with `reason_code=invalid_record`

## Edge Cases
- No accounts configured: emit empty summary with actionable next step.
- Malformed account entries: emit `invalid_record` row and continue evaluating remaining accounts/routes.
- Mixed-route readiness: same account can be `ok` on one route and blocked on another; report both rows explicitly.

## Verify
- Fixture matrix (healthy + missing_project + ineligible + refresh_invalid + cooling_down + invalid_record) returns stable text and JSON ordering.
- Expected outcomes:
  - healthy antigravity -> `status=ok`, `next_action=none`
  - refresh invalid -> `reason_code=refresh_invalid`, `next_action=opencode auth login`
  - missing project on antigravity -> `reason_code=missing_project`, `next_action=set project id`
  - cooling down -> includes `cooldown_until` and `next_action=wait_for_cooldown`
  - invalid record -> counted in `invalid_count` and surfaced in `accounts[]`
- Exit code is `1` when all account-route rows are non-ready, `0` when at least one row is ready.
