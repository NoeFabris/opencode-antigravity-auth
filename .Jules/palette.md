
## 2025-12-13 - Backend-Embedded UI Blindspots
**Learning:** HTML strings embedded in backend code (like the OAuth success page) often miss standard design system features like focus rings and a11y attributes because they live outside the main frontend codebase.
**Action:** Always check `server.ts` or similar backend files for hidden UI that users interact with.
