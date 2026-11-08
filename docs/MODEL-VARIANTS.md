# Model Variants

OpenCode's variant system lets you configure the thinking budget dynamically without defining separate models for each thinking level.

---

## How Variants Work

When you define a model with `variants`, OpenCode shows variant options in the model picker. Selecting a variant passes the `providerOptions` to the plugin, which extracts the thinking configuration.

```bash
opencode run "Hello" --model=google/antigravity-claude-opus-4-6-thinking --variant=max
```

---

## Variant Configuration

Define variants in your model configuration:

```json
{
  "antigravity-claude-opus-4-6-thinking": {
    "name": "Claude Opus 4.6 Thinking",
    "limit": { "context": 200000, "output": 64000 },
    "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
    "variants": {
      "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
      "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
    }
  }
}
```

---

## Supported Variant Formats

The plugin accepts different variant formats depending on the model family:

| Model Family | Variant Format | Example |
|--------------|----------------|---------|
| **Claude** | `thinkingConfig.thinkingBudget` | `{ "thinkingConfig": { "thinkingBudget": 8192 } }` |
| **Gemini 3** | `thinkingLevel` | `{ "thinkingLevel": "high" }` |
| **Gemini 2.5** | `thinkingConfig.thinkingBudget` | `{ "thinkingConfig": { "thinkingBudget": 8192 } }` |

---

## Gemini 3 Thinking Levels

Gemini 3 models use string-based thinking levels. Available levels differ by model:

| Level | Flash | Pro | Description |
|-------|-------|-----|-------------|
| `minimal` | ✅ | ❌ | Minimal thinking, lowest latency |
| `low` | ✅ | ✅ | Light thinking |
| `medium` | ✅ | ❌ | Balanced thinking |
| `high` | ✅ | ✅ | Maximum thinking (default) |

> **Note:** The API rejects invalid levels (e.g., `"minimal"` on Pro). Configure variants accordingly.

### Gemini 3 Pro Example

```json
{
  "antigravity-gemini-3-pro": {
    "name": "Gemini 3 Pro (Antigravity)",
    "limit": { "context": 1048576, "output": 65535 },
    "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
    "variants": {
      "low": { "thinkingLevel": "low" },
      "high": { "thinkingLevel": "high" }
    }
  }
}
```

### Gemini 3 Flash Example

```json
{
  "antigravity-gemini-3-flash": {
    "name": "Gemini 3 Flash (Antigravity)",
    "limit": { "context": 1048576, "output": 65536 },
    "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
    "variants": {
      "minimal": { "thinkingLevel": "minimal" },
      "low": { "thinkingLevel": "low" },
      "medium": { "thinkingLevel": "medium" },
      "high": { "thinkingLevel": "high" }
    }
  }
}
```

---

## Claude Thinking Budget

Claude models use token-based thinking budgets (in tokens):

| Variant | Budget | Description |
|---------|--------|-------------|
| `low` | 8192 | Light thinking |
| `max` | 32768 | Maximum thinking |

### Claude Example

```json
{
  "antigravity-claude-opus-4-6-thinking": {
    "name": "Claude Opus 4.6 Thinking (Antigravity)",
    "limit": { "context": 200000, "output": 64000 },
    "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
    "variants": {
      "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
      "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
    }
  }
}
```

You can define custom budgets:

```json
{
  "variants": {
    "minimal": { "thinkingConfig": { "thinkingBudget": 4096 } },
    "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
    "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
    "high": { "thinkingConfig": { "thinkingBudget": 24576 } },
    "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
  }
}
```

---

## Advertised Reasoning Tiers

Some models are advertised by the backend as one entry per reasoning tier, for
example `gemini-3.8-flash-low`, `gemini-3.8-flash-medium`, and
`gemini-3.8-flash-high`. The plugin collapses those siblings into a single
OpenCode model (`antigravity-gemini-3.8-flash`) and synthesizes one variant per
discovered tier:

```json
{
  "antigravity-gemini-3.8-flash": {
    "variants": [
      { "id": "low", "settings": { "thinkingConfig": { "thinkingLevel": "low" } } },
      { "id": "medium", "settings": { "thinkingConfig": { "thinkingLevel": "medium" } } },
      { "id": "high", "settings": { "thinkingConfig": { "thinkingLevel": "high" } } }
    ]
  }
}
```

Selecting `#high` retargets the request to `gemini-3.8-flash-high`. Variant
names come from the effort label in each model's `displayName`
(`"Gemini 3.8 Flash (High)"` → `#high`), not from the backend ID suffix. That
means renamed or newly added efforts (`Extra Low`, `Turbo`, `Ultra`, ...) work
without a code change, and the backend ID remains authoritative for routing.
When the label is a level Antigravity understands (`minimal`/`low`/`medium`/
`high`) the request also sends `thinkingLevel`; other labels ride the selected
backend ID. If a catalog omits `displayName`, the plugin falls back to the
legacy ID-suffix parser for known thinking families.

With no variant selected, the family default is used (normally `low` for Gemini
and `high` for Claude budget families, or the real base ID when Google
advertises one). An explicit display-name effort always forms a family, even
when it is the only one advertised — `GPT-OSS 120B (Medium)` becomes
`antigravity-gpt-oss-120b` with a single `medium` variant, so the model key
stays stable if Google later adds more efforts. The two-sibling rule only
applies when the effort comes from an ID suffix with no display label; a lone
suffix-only ID such as `gpt-oss-120b-medium` (no parenthetical) keeps its own
entry. Parentheticals that describe the model rather than an effort
(`(Thinking)`, `(Preview)`, image/video variants) are never treated as tiers.

---

## Legacy Budget Format (Deprecated)

For Gemini 3 models, the old `thinkingBudget` format is still supported but deprecated:

| Budget Range | Maps to Level |
|--------------|---------------|
| ≤ 8192 | low |
| ≤ 16384 | medium |
| > 16384 | high |

**Recommended:** Use `thinkingLevel` directly for Gemini 3 models.

---

## Tier-Suffixed Names

Tier-suffixed model names are still accepted:

- `antigravity-claude-opus-4-6-thinking-low`
- `antigravity-claude-opus-4-6-thinking-medium`
- `antigravity-claude-opus-4-6-thinking-high`
- `antigravity-gemini-3-pro-low`
- `antigravity-gemini-3-pro-high`
- `gemini-3-pro-low`
- `gemini-3-flash-medium`

However, **we recommend using simplified model names with variants** for:

- **Cleaner model picker** — 7 models instead of 12+
- **Simpler config** — No need to configure both `antigravity-` and `-preview` versions
- **Automatic quota routing** — Plugin handles model name transformation
- **Flexible budgets** — Define any budget, not just preset tiers
- **Future-proof** — Works with OpenCode's native variant system

Discovered families already collapse automatically; the advice above applies to
manual model overrides and other tier-suffixed aliases.

---

## Benefits of Variants

| Before (tier-suffixed) | After (variants) |
|------------------------|------------------|
| 12+ separate models | 4 models with variants |
| Fixed thinking budgets | Customizable budgets |
| Cluttered model picker | Clean model picker |
| Hard to add new tiers | Easy to add new variants |
