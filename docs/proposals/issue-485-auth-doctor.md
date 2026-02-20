# Proposal: Add auth doctor diagnostics command

## Problem
Users must manually inspect files/logs to diagnose account readiness.

## Implementation
- Add opencode auth doctor command.
- Report per account: enabled, refresh validity, project presence, eligibility hints, cooldown status, next action.
- Add --json output and non-zero exit when no account is request-ready.

## Verify
- Mixed fixture set (healthy + missing_project + ineligible + expired refresh + cooling down) returns deterministic diagnostics.
