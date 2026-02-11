# AGENTS.md

Guidance for AI agents working with this repository.

## Overview

This is an **OpenCode plugin** that enables OAuth authentication with Google's Antigravity API. It allows access to models like `gemini-3-pro-high` and `claude-opus-4-6-thinking` using Google credentials.

## Build & Test

```bash
npm install      # Install dependencies
npm run build    # Compile TypeScript
npm run typecheck # Type checking only
npm test         # Run tests
```

## Module Structure

```
src/
├── plugin.ts                # Main entry, fetch interceptor
├── constants.ts             # Endpoints, headers, config
├── antigravity/oauth.ts     # OAuth token exchange
└── plugin/
    ├── auth.ts              # Token validation & refresh
    ├── request.ts           # Request transformation (main logic)
    ├── request-helpers.ts   # Schema cleaning, thinking filters
    ├── thinking-recovery.ts # Turn boundary detection
    ├── recovery.ts          # Session recovery (tool_result_missing)
    ├── quota.ts             # Quota checking (API usage stats)
    ├── cache.ts             # Auth & signature caching
    ├── accounts.ts          # Multi-account management
    └── debug.ts             # Debug logging
```

## Key Design Patterns

### 1. Request Interception
Plugin intercepts `fetch()` for `generativelanguage.googleapis.com`, transforms to Antigravity format.

### 2. Claude Thinking Blocks
For Claude models, ALL thinking blocks are stripped from outgoing requests. Claude generates fresh thinking each turn. This eliminates signature validation errors.

### 3. Session Recovery
When tool execution is interrupted (ESC/timeout), the plugin injects synthetic `tool_result` blocks to recover the session.

### 4. Schema Sanitization
Tool schemas are cleaned via allowlist approach. Unsupported fields (`const`, `$ref`, `$defs`) are removed or converted.

### 5. Multi-Account Load Balancing
Accounts are rotated on rate limits. Gemini has dual quota pools (Antigravity + Gemini CLI headers).

## Key Files

| File | Purpose |
|------|---------|
| `src/plugin.ts` | Main entry, orchestrates flow |
| `src/plugin/request.ts` | Request/response transformation |
| `src/plugin/request-helpers.ts` | Schema cleaning, thinking filters |
| `src/plugin/thinking-recovery.ts` | Turn boundary detection |
| `src/plugin/recovery.ts` | Session recovery hook |

## Documentation

- [README.md](README.md) - Installation & usage
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - Detailed architecture guide
- [docs/ANTIGRAVITY_API_SPEC.md](docs/ANTIGRAVITY_API_SPEC.md) - API reference
