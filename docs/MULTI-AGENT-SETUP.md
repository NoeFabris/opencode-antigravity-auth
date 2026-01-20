# Multi-Agent Setup Guide

Reduce rate limit pressure by using Antigravity only for complex tasks, and free providers for fast subagents.

## Architecture

```text
Primary Agent (Antigravity Claude Opus)
    ├── explore (Cerebras - fast, free)
    ├── researcher (Cerebras - fast, free)
    ├── coder (Cerebras - fast, free)
    └── security-auditor (Antigravity Sonnet - needs thinking)
```

## Model Tiers

| Tier | Provider | Models | Use Case |
|------|----------|--------|----------|
| Heavy | Antigravity | antigravity-claude-opus-4-5-thinking, antigravity-claude-sonnet-4-5-thinking | Complex reasoning, architecture |
| Fast | Cerebras | llama-3.3-70b, qwen-3-32b | Exploration, research, code generation |

## Example Configurations

### Primary Agent (Antigravity)

```markdown
<!-- ~/.config/opencode/agent/antigravity.md -->
---
model: google/antigravity-claude-opus-4-5-thinking
mode: primary
maxSteps: 100
---
You are an elite coding agent with access to Claude Opus 4.5 Thinking.
```

### Fast Subagent (Cerebras)

```markdown
<!-- ~/.config/opencode/agent/explore.md -->
---
model: cerebras/llama-3.3-70b
mode: subagent
tools:
  - Read
  - Glob
  - Grep
---
Fast agent for codebase exploration. Read-only access.
```

### Security Auditor (Antigravity - needs thinking)

```markdown
<!-- ~/.config/opencode/agent/security-auditor.md -->
---
model: google/antigravity-claude-sonnet-4-5-thinking
mode: subagent
tools:
  - Read
  - Glob
  - Grep
---
Security analysis agent. Thorough review of code for vulnerabilities.
```

## Why This Works

- **Primary agent** uses Antigravity for complex multi-step reasoning
- **Fast subagents** use Cerebras (free, ~2100 tokens/sec) for quick tasks
- **Rate limits hit less often** since most requests go to free providers
- **Quality maintained** - complex work still uses Claude thinking

## Related

- [OpenCode Agent Docs](https://opencode.ai/docs/agents)
- [OpenCode #7138](https://github.com/anomalyco/opencode/issues/7138) - Per-agent variant defaults (would allow `variant: "max"` in agent config)
