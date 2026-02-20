# Proposal: Enforce per-email uniqueness and robust delete semantics

## Problem
Current dedupe uses exact email string matching (`deduplicateAccountsByEmail` in `src/plugin/storage.ts`), and account removal is reference/index-based (`removeAccount` in `src/plugin/accounts.ts`). This allows logical duplicates and incomplete delete-by-email outcomes.

## Implementation
### Normalization Contract
- Define `normalizedEmail` as: `trim(email)` -> Unicode `NFC` normalization -> lowercase.
- Preserve plus-addressing (`user+tag@example.com` remains distinct).
- Apply normalization before dedupe map lookup in `deduplicateAccountsByEmail`.

### Deterministic Merge Rule
- Group by `normalizedEmail`.
- Primary record selection order:
  - highest `lastUsed`
  - then highest `addedAt`
  - then has non-empty `refreshToken`
  - then lexicographic `refreshToken` (stable across restarts)
- Merge policy: keep primary values and fill only missing/empty fields from secondaries.
- Preserve auth-critical fields (`refreshToken`, `projectId`, `managedProjectId`) unless missing in primary.

### Delete-All-By-Email Semantics
- Add `deleteAllByEmail(normalizedEmail)` behavior to remove all matching rows, not just one reference.
- Clear active references consistently: `cursor`, `currentAccountIndexByFamily`, and stale in-memory account selections.
- Hard-delete account rows and persist atomically before returning success.

### Save-Path Contract
- Run dedupe on every account write path (including normal save and migration/merge saves), not only on startup load.

## Edge Cases
- Legacy case/whitespace variants are canonicalized on next load/save.
- Stale cache reintroduction is prevented by rebuilding account selection state from canonicalized storage after merge/delete.
- Concurrent writes are serialized through existing save sequencing; dedupe executes immediately before commit.

## Verify
- Seed fixtures with case/whitespace variants and overlapping fields; confirm one canonical merged row with deterministic winner.
- Confirm no lossy merge for critical fields.
- Concurrent insert simulation for same logical email results in one canonical row.
- Delete by email removes all normalized matches in memory and persisted storage after restart.
- Re-run save paths and migrations to confirm dedupe is enforced on each write path.
