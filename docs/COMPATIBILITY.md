# Plugin Compatibility Guide

This document covers compatibility considerations when using opencode-antigravity-auth with other OpenCode plugins.

## Plugin Order

**Plugin order matters.** This plugin must run **AFTER** any plugin that modifies conversation history or request messages.

### Quick Reference

```json
{
  "plugin": [
    "@tarquinen/opencode-dcp@latest",
    "oh-my-opencode@latest",
    "opencode-antigravity-auth@latest"
  ]
}
```

## Known Plugin Interactions

### @tarquinen/opencode-dcp (Dynamic Context Pruning)

**Issue:** DCP creates synthetic assistant messages to summarize pruned tool outputs. These synthetic messages lack the `thinking` block that Claude's API requires for thinking-enabled models.

**Error you'll see:**
```
Expected 'thinking' or 'redacted_thinking', but found 'text'
```

**Solution:** Ensure DCP loads **before** this plugin. We inject `redacted_thinking` blocks into any assistant message that lacks one.

| Order | Result |
|-------|--------|
| DCP → antigravity | Works - we fix DCP's synthetic messages |
| antigravity → DCP | Broken - DCP creates messages after our fix runs |

**Correct:**
```json
{
  "plugin": [
    "@tarquinen/opencode-dcp@latest",
    "opencode-antigravity-auth@latest"
  ]
}
```

**Incorrect:**
```json
{
  "plugin": [
    "opencode-antigravity-auth@latest",
    "@tarquinen/opencode-dcp@latest"
  ]
}
```

---

### oh-my-opencode (Subagent Orchestration)

**Issue:** When oh-my-opencode spawns multiple subagents in parallel, each subagent runs as a separate OpenCode process. Without coordination, multiple processes may select the same Antigravity account simultaneously, causing rate limit errors (429).

**Error you'll see:**
```
429 Too Many Requests
```

**Solution:** We implement a file-based reservation system that coordinates account selection across processes.

**How it works:**
1. Before using an account, a process reserves it in `~/.config/opencode/antigravity-reservations.json`
2. Other processes see the reservation and select a different account
3. Reservations auto-expire after 30 seconds (handles crashed processes)
4. Startup jitter (0-300ms) staggers parallel subagent starts

**Configuration:** No configuration needed. The reservation system is automatic.

**Tuning:** If you still hit rate limits with many parallel subagents:
- Increase your account pool (add more OAuth accounts)
- Reduce parallel subagent count
- Constants in `src/plugin/reservation.ts`:
  - `RESERVATION_TTL_MS` - How long reservations last (default: 30s)
  - `JITTER_MAX_MS` - Max startup delay (default: 300ms)

See [RESERVATION_SYSTEM.md](./RESERVATION_SYSTEM.md) for detailed documentation.

---

## Troubleshooting

### "Expected 'thinking' or 'redacted_thinking', but found 'text'"

1. Check plugin order - DCP must be before antigravity-auth
2. Restart OpenCode after changing plugin order

### Rate limit errors with subagents

1. Check `~/.config/opencode/antigravity-reservations.json` for stale reservations
2. Delete the file to reset reservations
3. Add more OAuth accounts to increase pool size

### Debugging

Enable debug logging:
```bash
DEBUG=antigravity:* opencode
```

Check reservation state:
```bash
cat ~/.config/opencode/antigravity-reservations.json
```
