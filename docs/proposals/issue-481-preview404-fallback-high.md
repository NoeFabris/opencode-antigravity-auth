# Proposal: One-hop fallback from gemini-3.1-pro-preview to gemini-3.1-pro-high

## Problem
Preview can 404 while high is available.

## Implementation
- On model-not-found 404 for gemini-3.1-pro-preview, retry once with gemini-3.1-pro-high.
- Keep thinkingLevel high.
- Emit structured debug log of fallback decision.

## Safety
- Single retry only, no loop.
- Trigger only on specific 404 signature.

## Verify
- Repro with preview 404 + high 200 path.
- Non-404 failures do not trigger fallback.
