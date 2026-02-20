# Proposal: Enforce per-email uniqueness and robust delete semantics

## Problem
The current dedupe path keeps one record per exact email string (`deduplicateAccountsByEmail`), so logical duplicates such as case/whitespace variants can survive and later reappear after partial deletes.

## Implementation
### Normalization Contract
- Define `normalizedEmail` as: `trim(email)` -> Unicode `NFC` normalization -> lowercase.
- Preserve plus-addressing (`user+tag@example.com` remains distinct) to avoid provider-specific assumptions.
- Use `normalizedEmail` as the unique key for account dedupe in load/save paths.

### Deterministic Merge Rule
- Group records by `normalizedEmail`.
- Pick a primary record by: highest `lastUsed`, then highest `addedAt`, then non-empty `refreshToken`, then stable original index.
- Merge fields deterministically: keep primary values, fill only missing/empty fields from secondaries.
- Preserve auth-critical fields (`refreshToken`, `projectId`, `managedProjectId`) unless the primary is missing them.

### Delete-All-By-Email Semantics
- Add delete-by-email behavior that removes all records whose `normalizedEmail` matches the target.
- Invalidate in-memory selection/cursor state and clear any active references to removed account IDs in the same operation.
- Use hard-delete semantics for account rows (no tombstone restore path), and ensure persisted storage reflects the full removal before returning success.

## Edge Cases
- Case-variant legacy rows: normalize and re-key during dedupe migration on load.
- Stale cache reintroduction: after any merge/delete write, rebuild in-memory account list from the deduped canonical set.
- Concurrent writes: guard account writes with existing save serialization and re-run dedupe immediately before write commit.

## Verify
- Seed fixtures: `User@Example.com` and ` user@example.com ` with different `lastUsed`/`addedAt`/field completeness; confirm one canonical merged record with deterministic winner and retained critical fields.
- Confirm no lossy merge: every non-empty pre-merge critical field is present in canonical output unless deterministically superseded by higher-priority source.
- Run concurrent write simulation (two inserts for same logical email) and confirm single canonical record after save.
- Delete by email and verify all matching rows are gone in memory and persisted storage after restart.
