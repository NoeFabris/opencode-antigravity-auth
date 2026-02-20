# Proposal: Quota-aware account rotation for model requests

## Problem
Requests can hit `429` on one account while other accounts still have quota, and rotation behavior needs an explicit contract aligned with existing quota-key and scheduler logic.

## Implementation
### Quota Scope and Tracking
- Reuse existing quota tracking primitives (`markRateLimitedWithReason`, `isRateLimitedForHeaderStyle`, `getQuotaKey`) rather than adding a parallel limiter.
- Define "same route/model" as the exact quota key from `getQuotaKey(family, headerStyle, model)` (for example `gemini-antigravity:<model>`).

### Reset Hint Resolution
- Resolve reset hint in this priority order:
  - server-provided body delay/reset signal (`retryDelayMs` / `quotaResetTime`)
  - `Retry-After` header
  - computed fallback backoff from `markRateLimitedWithReason`
- Persist resolved reset time in existing `rateLimitResetTimes` state keyed by quota key.

### Rotation Rules
- On `429`, mark current account rate-limited for the active quota key and rotate to next eligible account.
- Eligibility requires: account enabled, not verification-required, and usable project context (`parts.projectId || parts.managedProjectId`).
- Define `missing_project` as both project fields empty after project-context resolution.
- Define `ineligible` as disabled, verification-required, or auth-invalid account state.
- Enforce once-per-account retry in one rotation window by tracking attempted account IDs for the request.

### Exhaustion and Logging
- If all accounts for a quota key are rate-limited, follow existing wait policy (`getMinWaitTimeForFamily`) and respect `max_rate_limit_wait_seconds` cutoff behavior.
- Emit structured rotation logs for each decision:
  - `quota_key`, `from_account`, `to_account`
  - `skip_reason` (`cooling_down`, `missing_project`, `ineligible`, `disabled`)
  - `retry_after_ms`, `cooldown_until`
  - outcome (`rotated`, `wait_all_limited`, `max_wait_exceeded`, `single_account_retry`)

## Edge Cases
- Gemini dual quota pools (`antigravity` vs `gemini-cli`): rotation preserves current pool semantics and interacts cleanly with existing pool fallback logic.
- Soft quota threshold gating: honor `isOverSoftQuotaThreshold` protections before selecting rotation candidates.
- Health/token controls: rotation events should remain compatible with `HealthScoreTracker` penalties and `TokenBucketTracker` pacing.

## Verify
- Multi-account fixture: account A returns `429`, account B succeeds -> exactly one rotation hop.
- Attempted-account guard: no account retried more than once in one rotation window.
- `switch_on_first_rate_limit` on/off behavior remains correct under rotation.
- `cache_first` scheduling mode still preserves same-account wait behavior when configured threshold allows.
- Soft-quota scenario: all accounts over threshold -> expected quota-protection behavior (no invalid rotation).
- All accounts rate-limited -> wait time derived from quota state; max-wait cutoff path produces expected surfaced error.
- Logging assertions confirm `quota_key`, from/to account, skip reason, and retry timing fields.
