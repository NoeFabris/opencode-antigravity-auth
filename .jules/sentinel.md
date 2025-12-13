# Sentinel's Journal

## 2025-02-18 - Hardcoded OAuth Client Secret
**Vulnerability:** Found hardcoded `ANTIGRAVITY_CLIENT_SECRET` in `src/constants.ts`.
**Learning:** Hardcoding secrets prevents rotation and poses a security risk. Even for "public clients", it is better to inject secrets at runtime or build time.
**Prevention:** Removed the hardcoded secret and replaced it with `process.env.ANTIGRAVITY_CLIENT_SECRET`. This forces secure configuration.
