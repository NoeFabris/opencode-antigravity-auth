# Proposal: One-hop fallback from gemini-3.1-pro-preview to gemini-3.1-pro-high

## Problem
`gemini-3.1-pro-preview` can return model-not-found on Antigravity even when `gemini-3.1-pro-high` is available.

## Implementation
- Scope this logic to the Antigravity request route/handler only (the endpoint traversal path in `src/plugin.ts`), not global request rewriting.
- Add predicate `isPreviewModelNotFound404`:
  - HTTP status is `404`
  - error payload indicates `NOT_FOUND`
  - error message or code references the requested preview model (`gemini-3.1-pro-preview`)
  - exclude auth/routing failures that are also 404-shaped
- When predicate matches and requested model is preview, perform exactly one retry using `gemini-3.1-pro-high`.
- Thinking policy:
  - if caller explicitly set `thinkingLevel`, preserve it
  - if caller did not set it, default to `high` on fallback request
- Respect explicit overrides: if caller explicitly targeted a different model/tier than preview, do not apply this fallback.
- Emit structured info log on fallback: `{ event: "preview_404_fallback", original_model, fallback_model, endpoint, request_id }`.

## Safety
- Single retry only (no loop, no chained model substitutions).
- Trigger only on the defined `isPreviewModelNotFound404` predicate.
- Non-matching 404s and non-404 failures must follow existing handling.

## Verify
- Preview request with matching 404 signature retries once to high and succeeds when high is available.
- Preview request with non-matching 404 signature does not fallback.
- Explicit caller `thinkingLevel` is preserved; missing `thinkingLevel` defaults to high.
- Log output includes original/fallback model and endpoint context for each fallback event.
