# Proposal: Quota-aware account rotation for model requests

## Problem
Requests fail on 429 even when alternate accounts are available.

## Implementation
- On 429, mark current account cooling down using reset hint.
- Rotate to next eligible account for the same route/model.
- Skip missing_project and ineligible accounts.

## Verify
- Multi-account test where first account 429 and second succeeds.
- Ensure loop guard prevents infinite retries.
