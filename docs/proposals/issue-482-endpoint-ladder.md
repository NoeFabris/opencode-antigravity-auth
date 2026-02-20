# Proposal: Endpoint ladder for Antigravity request resilience

## Problem
Antigravity already traverses `daily -> autopush -> prod`, but retryability is broad (`403 || 404 || >=500`) and behavior is underspecified for logging, exhaustion outputs, and capacity-retry interaction.

## Implementation
### Configuration
- Introduce explicit config key `antigravity_endpoint_order`.
- `ANTIGRAVITY_ENDPOINT_FALLBACKS` remains the default order (`daily,autopush,prod`); config acts as runtime override when provided.
- Validate values against known endpoint aliases; reject empty/invalid lists at startup.
- Snapshot endpoint order per request so runtime config edits do not mutate in-flight traversal.

### Retry and Fallback Rules
- Retry/fallback to next endpoint for retryable endpoint failures:
  - `404` where payload indicates model not found on that endpoint
  - `502/503/504`
  - transient network failures (timeout, connection reset/refused)
- `403` is conditionally retryable only when all hold:
  - no verification-required/auth-ineligible signal in parsed error metadata/body
  - status is `403` from endpoint request path (not auth refresh/project bootstrap path)
  - classifier emits `endpoint_transient_403` reason
- Do not endpoint-fallback on `401`, `400`, or `500/501` by default.
- Keep account-rotation logic for quota/capacity handling separate from endpoint traversal.
- Delay/backoff policy:
  - endpoint hop retries (`404 model_missing`, `502/503/504`, `endpoint_transient_403`) are immediate (no extra delay)
  - network-transient errors allow one short same-endpoint retry (`250ms`) before hopping
  - capacity/server-busy retries remain same-endpoint with tiered delays (`5s, 10s, 20s, 30s, 60s`)

### Logging and Exhaustion Contract
- Emit debug logs for each ladder decision with structured fields: `{ endpoint, attempt, status, retryable, reason, next_endpoint }`.
- Define deterministic exhaustion response:
  - `type: "EndpointsExhaustedError"`
  - `attempts[]: { endpoint, status, retryable, retry_rule, attempts, error_summary }`
  - `last_error`
  - `total_attempts`
- Return this error to caller without silent swallow when all endpoints fail.
- `retry_rule` enum values (explicit):
  - `model_missing_404`
  - `gateway_502`
  - `gateway_503`
  - `gateway_504`
  - `network_timeout`
  - `network_connection_reset`
  - `endpoint_transient_403`
  - `capacity_same_endpoint_retry`

### Delta vs Current Behavior
- Replace broad `shouldRetryEndpoint` predicate with the explicit rules above.
- Add formal config parsing/validation and explicit runtime override behavior.
- Add stable exhaustion error shape and required debug observability.

## Edge Cases
- Empty/misconfigured endpoint list: fail fast on config validation and do not start request traversal.
- In-flight concurrency: request uses immutable endpoint snapshot even if config changes mid-flight.
- Attempt limits:
  - endpoint transitions: at most one hop to the next endpoint per failure event
  - capacity/server-busy retries: allow bounded same-endpoint retries with explicit cap `CAPACITY_RETRY_LIMIT = 5` before hopping
- Cascading capacity failures across all endpoints: emit exhaustion error with per-endpoint attempt counts and retry-rule attribution.

## Verify
- Scenario matrix:
  - daily returns model-missing `404`, autopush succeeds -> single fallback hop, success.
  - daily returns `503`, autopush succeeds -> fallback occurs.
  - daily returns capacity/server-busy response -> bounded same-endpoint retries occur before endpoint hop.
  - daily returns transient endpoint `403` (non-verification) -> endpoint fallback occurs; verification-required `403` still does not fallback.
  - daily returns `403` verification/auth failure -> no endpoint fallback.
  - all endpoints return retryable capacity/gateway/network failures -> `EndpointsExhaustedError` includes per-endpoint retry rules and attempt counts.
- Assert debug logs include `endpoint`, `status`, `retryable`, `reason`, and `next_endpoint` for each step.
- Confirm configured order is honored and invalid config is rejected before runtime requests.
