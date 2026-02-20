# Proposal: Quota-aware account rotation for model requests

## Problem
A request can fail on `429` even when other accounts are available for the same route/model, and rotation behavior is not explicitly specified end-to-end.

## Implementation
- On `429`, parse reset hints (`Retry-After`/body delay metadata) and mark the current account rate-limited for the active route/model.
- Rotate to the next eligible account for the same route/model only (exclude disabled, ineligible, and missing-project accounts).
- Enforce once-per-account retry within a single rotation window by tracking attempted account IDs for that request.
- If all eligible accounts are cooling down, return a deterministic exhausted result immediately (surface the latest `429` plus `all_accounts_cooling_down` diagnostic) instead of blocking.
- Persist cooldown and switch metadata via existing account save path so state survives restart.
- Emit structured rotation logs for each decision:
  - `from_account`, `to_account`
  - `skip_reason` (`cooling_down`, `missing_project`, `ineligible`, `disabled`)
  - `retry_after_ms` / cooldown expiry
  - final outcome (`success`, `exhausted`, `single_account_retry`)

## Verify
- Multi-account fixture: account A returns `429`, account B succeeds -> exactly one rotation hop.
- Attempted-account guard: no account is retried more than once in the same rotation window.
- Exhaustion path: all eligible accounts cooling down -> deterministic exhausted response with surfaced `429` context.
- Logging assertions: rotation events include from/to account and skip/cooldown fields.
- Persistence check: cooldown metadata remains consistent after restart.
