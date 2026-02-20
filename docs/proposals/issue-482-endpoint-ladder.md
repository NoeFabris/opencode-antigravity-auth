# Proposal: Endpoint ladder for Antigravity request resilience

## Problem
Model availability differs by endpoint.

## Implementation
- Add configurable endpoint order: daily, autopush, prod.
- Retry only on retryable conditions (404 model missing, selected 5xx, transient network).
- Stop on auth/eligibility failures (401/403).

## Verify
- Simulate endpoint-level failure and confirm successful fallback.
- Confirm no unnecessary retries on non-retryable classes.
