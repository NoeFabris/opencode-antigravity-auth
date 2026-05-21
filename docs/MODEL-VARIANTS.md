# Model IDs and Legacy Variants

The default model list now contains one direct OpenCode model ID for each current Antigravity Model Quota row. This avoids relying on OpenCode variants for quota tiers and makes every visible quota row selectable directly.

## Current Antigravity quota models

| Quota row | OpenCode model ID |
|-----------|-------------------|
| Gemini 3.1 Pro (Low) | `google/antigravity-gemini-3.1-pro-low` |
| Gemini 3.1 Pro (High) | `google/antigravity-gemini-3.1-pro-high` |
| Gemini 3.5 Flash (Medium) | `google/antigravity-gemini-3.5-flash-medium` |
| Gemini 3.5 Flash (High) | `google/antigravity-gemini-3.5-flash-high` |
| Claude Sonnet 4.6 (Thinking) | `google/antigravity-claude-sonnet-4-6-thinking` |
| Claude Opus 4.6 (Thinking) | `google/antigravity-claude-opus-4-6-thinking` |
| GPT-OSS 120B (Medium) | `google/antigravity-gpt-oss-120b-medium` |

```bash
opencode run "Hello" --model=google/antigravity-gemini-3.5-flash-medium
opencode run "Hello" --model=google/antigravity-gemini-3.1-pro-high
```

Gemini CLI models are intentionally not part of the default model list because individual Gemini CLI access sunsets on **2026-06-18**. Legacy resolver support remains for existing configs, but new configs should use the Antigravity IDs above.

---

## Why direct IDs instead of variants?

The current Antigravity quota UI exposes rows such as "Gemini 3.5 Flash (Medium)" and "Gemini 3.5 Flash (High)". OpenCode only treats configured model keys as selectable model IDs in all contexts, including scripts and agent configs. Direct IDs therefore avoid "Model not found" errors in non-interactive usage.

Internally, the resolver still understands the tier suffixes:

- `antigravity-gemini-3.1-pro-low` → API model `gemini-3.1-pro-low`
- `antigravity-gemini-3.1-pro-high` → API model `gemini-3.1-pro-high`
- `antigravity-gemini-3.5-flash-medium` → API model `gemini-3.5-flash-medium` + `thinkingLevel: "medium"`
- `antigravity-gemini-3.5-flash-high` → API model `gemini-3.5-flash-high` + `thinkingLevel: "high"`

The bare legacy `antigravity-gemini-3.5-flash` resolves to `medium`, but it is not listed by default.

---

## Legacy variant compatibility

Older configs that define `variants` are still accepted by the resolver where possible. For example, a custom config may still use:

```json
{
  "antigravity-gemini-3.5-flash": {
    "name": "Gemini 3.5 Flash (Antigravity)",
    "variants": {
      "medium": { "thinkingLevel": "medium" },
      "high": { "thinkingLevel": "high" }
    }
  }
}
```

But for new installs, prefer direct IDs from the current model list.

---

## Claude thinking budgets

Current Claude Thinking rows are direct model IDs. The plugin enables Claude thinking with its default high budget when no explicit tier/budget is provided:

- `google/antigravity-claude-sonnet-4-6-thinking`
- `google/antigravity-claude-opus-4-6-thinking`

Legacy tier-suffixed Claude names are still understood, such as:

- `antigravity-claude-opus-4-6-thinking-low`
- `antigravity-claude-opus-4-6-thinking-medium`
- `antigravity-claude-opus-4-6-thinking-high`

These are compatibility aliases, not default model picker entries.
