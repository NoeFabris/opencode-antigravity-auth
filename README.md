### Using with Oh-My-OpenCode

**Important:** Disable the built-in Google auth to prevent conflicts:

```json
// ~/.config/opencode/oh-my-opencode.json
{
  "google_auth": false,
  "agents": {
    "multimodal-looker": { "model": "google/antigravity-gemini-3-flash" }
  },
  "categories": {
    "visual-engineering": { "model": "google/antigravity-gemini-3-pro" },
    "document-writer": { "model": "google/antigravity-gemini-3-flash" }
  }
}
```