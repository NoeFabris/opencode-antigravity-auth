# Proposal: Improve 404 error classification and messaging

## Problem
404 messages can incorrectly suggest preview access steps when root cause differs.

## Implementation
- Build classifier using model, endpoint, reason/domain, and body details.
- Only show preview-access guidance on matching preview-gating signatures.
- Otherwise show neutral not-found diagnostics with endpoint/model details.

## Verify
- Preview-gated case still shows preview guidance.
- Alias/endpoint mismatch case stays neutral and actionable.
