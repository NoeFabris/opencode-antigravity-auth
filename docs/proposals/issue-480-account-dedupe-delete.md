# Proposal: Enforce per-email uniqueness and robust delete semantics

## Problem
Duplicate records for the same email cause deleted accounts to reappear.

## Implementation
- Add normalization pass on account load/save with unique key = normalized email.
- Merge duplicates by deterministic rule (most recent + most complete fields).
- Delete-by-email removes all matching records.

## Edge Cases
- case-variant emails
- stale cached accounts merged back in

## Verify
- Seed duplicates in storage, run load/save, confirm single canonical row.
- Delete email removes all rows and remains deleted after restart.
