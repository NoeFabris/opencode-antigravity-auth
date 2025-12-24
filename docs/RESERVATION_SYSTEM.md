# Cross-Process Account Reservation System

Prevents rate limit collisions when multiple OpenCode processes (subagents) compete for the same Antigravity account.

## Problem

When oh-my-opencode spawns parallel subagents, each process loads its own `AccountManager` instance. Without coordination:

```
Process A                    Process B
    |                            |
    | selects account 0          | selects account 0  ← COLLISION
    |                            |
    | 429 rate limit             | 429 rate limit
```

## Solution

File-based reservation system at `~/.config/opencode/antigravity-reservations.json`:

```
Process A                    Process B
    |                            |
    | reserve(0) → writes file   |
    |                            | isReserved(0) → true, skip
    |                            | reserve(1) → uses account 1
    |                            |
    | release(0) → on complete   |
```

## Configuration

Constants in `src/plugin/reservation.ts`:

| Constant | Default | Purpose |
|----------|---------|---------|
| `RESERVATION_TTL_MS` | 30,000 | Auto-expire reservations after 30s |
| `CACHE_TTL_MS` | 2,000 | Re-read file every 2s max |
| `JITTER_MAX_MS` | 300 | Random 0-300ms startup delay |

## Reservation File Format

```json
{
  "reservations": {
    "0": {
      "pid": 12345,
      "timestamp": 1735012345678,
      "family": "gemini",
      "expiresAt": 1735012375678
    },
    "2": {
      "pid": 12346,
      "timestamp": 1735012345680,
      "family": "claude",
      "expiresAt": 1735012375680
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `pid` | Process ID that holds the reservation |
| `timestamp` | When reservation was created |
| `family` | Model family (`claude` or `gemini`) - separate quotas |
| `expiresAt` | Auto-expiry time (timestamp + TTL) |

## Behavior

### Reservation Logic

1. **Check current account**: If not rate-limited and not reserved by another process, use it
2. **Find available**: Skip accounts that are rate-limited OR reserved by other processes
3. **Fallback**: If all accounts are reserved, fall back to any non-rate-limited account (shared usage is better than blocking)

### Stale Reservation Cleanup

Reservations are considered stale and ignored if:
- `expiresAt` has passed (TTL expired)
- Owning process is dead (`kill(pid, 0)` fails)

### Process Exit Cleanup

Reservations are released on:
- `SIGINT` (Ctrl+C)
- `SIGTERM` (kill)
- Normal `exit`

## Troubleshooting

### View Current Reservations

```bash
cat ~/.config/opencode/antigravity-reservations.json | jq
```

### Manual Cleanup

If reservations get stuck (shouldn't happen normally):

```bash
rm ~/.config/opencode/antigravity-reservations.json
```

### Debug Logging

The plugin logs reservation activity. Look for `[opencode-antigravity-auth]` prefixed messages.

### Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| Still hitting 429s | More subagents than accounts | Add more accounts or reduce parallelism |
| Reservations not clearing | Process crashed without cleanup | Wait 30s for TTL or delete file |
| All accounts reserved | Many parallel processes | Increase account pool |

## API Reference

### Exported Functions

```typescript
isAccountReserved(accountIndex: number, family: ModelFamily): Promise<boolean>
reserveAccount(accountIndex: number, family: ModelFamily): Promise<void>
releaseAccount(accountIndex: number): Promise<void>
releaseAllReservations(): Promise<void>
getAvailableAccountIndices(totalAccounts: number, family: ModelFamily): Promise<number[]>
applyStartupJitter(): Promise<void>
```

### AccountManager Methods

```typescript
getCurrentOrNextForFamilyWithReservation(family: ModelFamily): Promise<ManagedAccount | null>
getNextForFamilyWithReservation(family: ModelFamily): Promise<ManagedAccount | null>
releaseAccountReservation(accountIndex: number): Promise<void>
```
