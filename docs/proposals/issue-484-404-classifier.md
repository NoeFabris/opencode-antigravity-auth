# Proposal: Improve 404 error classification and messaging

## Problem
Current 404 handling can over-apply preview-access guidance when the true cause is endpoint/model mismatch or generic not-found.

## Current Behavior
- `rewriteAntigravityPreviewAccessError` currently keys mainly on 404 + model pattern matching.
- This can classify unrelated 404s as preview-gated and produce misleading guidance.

## Implementation
### Classifier Inputs
- `status`
- requested/effective `model`
- `endpoint`
- error fields (`code`, `status`, `reason`, `domain`, `message`)
- response body text (bounded preview)

### Decision Rules
- `preview_access_required` when all hold:
  - HTTP `404`
  - model is preview-eligible target
  - payload includes preview-gating signature (for example: enable-preview link text, preview-access wording, or explicit preview-required reason code)
- `neutral_not_found` otherwise.

### Decision Sketch
- `if status != 404 -> passthrough`
- `else if isPreviewTarget(model) && hasPreviewGatingSignature(error/body) -> preview_access_required`
- `else -> neutral_not_found`

### Output Contract
- Preview guidance output: `{ type: "preview_access_required", model, endpoint, reason, message, help_link }`
- Neutral output: `{ type: "not_found", model, endpoint, reason, message }`

### Traceability Logging
- Emit debug/trace structured log for classifier decisions with fields:
  `{ classifier_type, model, endpoint, status, reason_code, domain, signature_match, decision_reason }`

## Edge Cases
- Ambiguous 404 containing both preview-style text and alias mismatch hints: classifier must prioritize explicit reason/code over substring heuristics.
- Empty/malformed error body: default to `neutral_not_found` with safe reason.
- Unknown model aliases: treat as neutral unless explicit preview signature is present.

## Verify
- Preview-gated fixture yields `preview_access_required` with preview help link.
- Alias/endpoint mismatch fixture yields `neutral_not_found` and no preview instruction.
- Malformed/empty 404 body still returns neutral diagnostic shape.
- Debug output includes classifier input fields and final decision reason for traceability.
