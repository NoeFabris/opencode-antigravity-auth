# Antigravity Unified Gateway API Specification

**Version:** 1.0
**Last Updated:** December 13, 2025
**Status:** Verified by Direct API Testing

---

## Overview

Antigravity is Google's **Unified Gateway API** for accessing multiple AI models (Claude, Gemini, GPT-OSS) through a single, consistent Gemini-style interface. It is NOT the same as Vertex AI's direct model APIs.

### Key Characteristics

- **Single API format** for all models (Gemini-style)
- **Project-based access** via Google Cloud authentication
- **Internal routing** to model backends (Vertex AI for Claude, Gemini API for Gemini)
- **Unified response format** (`candidates[]` structure for all models)

---

## Endpoints

| Environment | URL | Status |
|-------------|-----|--------|
| **Daily (Sandbox)** | `https://daily-cloudcode-pa.sandbox.googleapis.com` | ✅ Active |
| **Production** | `https://cloudcode-pa.googleapis.com` | ✅ Active |
| **Autopush (Sandbox)** | `https://autopush-cloudcode-pa.sandbox.googleapis.com` | ❌ Unavailable |

### API Actions

| Action | Path | Description |
|--------|------|-------------|
| Generate Content | `/v1internal:generateContent` | Non-streaming request |
| Stream Generate | `/v1internal:streamGenerateContent?alt=sse` | Streaming (SSE) request |
| Load Code Assist | `/v1internal:loadCodeAssist` | Project discovery |
| Onboard User | `/v1internal:onboardUser` | User onboarding |

---

## Authentication

### OAuth 2.0 Setup

```
Authorization URL: https://accounts.google.com/o/oauth2/auth
Token URL: https://oauth2.googleapis.com/token
```

### Required Scopes

```
https://www.googleapis.com/auth/cloud-platform
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/cclog
https://www.googleapis.com/auth/experimentsandconfigs
```

### Required Headers

```http
Authorization: Bearer {access_token}
Content-Type: application/json
User-Agent: antigravity/1.15.8 windows/amd64
X-Goog-Api-Client: google-cloud-sdk vscode_cloudshelleditor/0.1
Client-Metadata: {"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}
```

For streaming requests, also include:
```http
Accept: text/event-stream
```

---

## Available Models

| Model Name | Model ID | Type | Status |
|------------|----------|------|--------|
| Claude Sonnet 4.5 | `claude-sonnet-4-5` | Anthropic | ✅ Verified |
| Claude Sonnet 4.5 Thinking | `claude-sonnet-4-5-thinking` | Anthropic | ✅ Verified |
| Claude Opus 4.5 Thinking | `claude-opus-4-5-thinking` | Anthropic | ✅ Verified |
| Gemini 3 Pro High | `gemini-3-pro-high` | Google | ✅ Verified |
| Gemini 3 Pro Low | `gemini-3-pro-low` | Google | ✅ Verified |
| GPT-OSS 120B Medium | `gpt-oss-120b-medium` | Other | ✅ Verified |

---

## Request Format

### Basic Structure

```json
{
  "project": "{project_id}",
  "model": "{model_id}",
  "request": {
    "contents": [...],
    "generationConfig": {...},
    "systemInstruction": {...},
    "tools": [...]
  },
  "userAgent": "antigravity",
  "requestId": "{unique_id}"
}
```

### Contents Array (REQUIRED)

**⚠️ IMPORTANT: Must use Gemini-style format. Anthropic-style `messages` array is NOT supported.**

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        { "text": "Your message here" }
      ]
    },
    {
      "role": "model",
      "parts": [
        { "text": "Assistant response" }
      ]
    }
  ]
}
```

#### Role Values
- `user` - Human/user messages
- `model` - Assistant responses (NOT `assistant`)

### Generation Config

```json
{
  "generationConfig": {
    "maxOutputTokens": 1000,
    "temperature": 0.7,
    "topP": 0.95,
    "topK": 40,
    "stopSequences": ["STOP"],
    "thinkingConfig": {
      "thinkingBudget": 8000,
      "includeThoughts": true
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `maxOutputTokens` | number | Maximum tokens in response |
| `temperature` | number | Randomness (0.0 - 2.0) |
| `topP` | number | Nucleus sampling threshold |
| `topK` | number | Top-K sampling |
| `stopSequences` | string[] | Stop generation triggers |
| `thinkingConfig` | object | Extended thinking config |

### System Instructions

**⚠️ Must be an object with `parts`, NOT a plain string.**

```json
// ✅ CORRECT
{
  "systemInstruction": {
    "parts": [
      { "text": "You are a helpful assistant." }
    ]
  }
}

// ❌ WRONG - Will return 400 error
{
  "systemInstruction": "You are a helpful assistant."
}
```

### Tools / Function Calling

```json
{
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "get_weather",
          "description": "Get weather for a location",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {
                "type": "string",
                "description": "City name"
              }
            },
            "required": ["location"]
          }
        }
      ]
    }
  ]
}
```


### Google Search Grounding

Gemini models support Google Search grounding, but **it cannot be combined with function declarations** in the same request. This plugin implements a dedicated `google_search` tool that makes separate API calls.

#### How the `google_search` Tool Works

The model can call `google_search(query, urls?, thinking?)` which:
1. Makes a **separate API call** to Antigravity with only `{ googleSearch: {} }` (no function declarations)
2. Parses the `groundingMetadata` from the response
3. Returns formatted markdown with sources and citations

**Tool Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | ✅ | The search query or question |
| `urls` | string[] | ❌ | URLs to analyze (adds `urlContext` tool) |
| `thinking` | boolean | ❌ | Enable deep thinking (default: true) |

**Example Response:**
```markdown
## Search Results

Spain won Euro 2024, defeating England 2-1 in the final...

### Sources
- [UEFA Euro 2024](https://uefa.com/...)
- [Al Jazeera](https://aljazeera.com/...)

### Search Queries Used
- "UEFA Euro 2024 winner"
```

#### Raw API Format (for reference)

The underlying API uses these tool formats:

**New API (Gemini 2.0+ / Gemini 3):**
```json
{
  "tools": [
    { "googleSearch": {} }
  ]
}
```

**Legacy API (Gemini 1.5 only - deprecated):**
```json
{
  "tools": [
    {
      "googleSearchRetrieval": {
        "dynamicRetrievalConfig": {
          "mode": "MODE_DYNAMIC",
          "dynamicThreshold": 0.3
        }
      }
    }
  ]
}
```

**Response includes `groundingMetadata`:**
```json
{
  "groundingMetadata": {
    "webSearchQueries": ["query1", "query2"],
    "searchEntryPoint": { "renderedContent": "..." },
    "groundingChunks": [{ "web": { "uri": "...", "title": "..." } }],
    "groundingSupports": [{ "segment": {...}, "groundingChunkIndices": [...] }]
  }
}
```

> **Important:** `googleSearch` and `urlContext` tools **cannot be combined with `functionDeclarations`** in the same request. This is why the plugin uses a separate API call.
```

### Function Name Rules

| Rule | Description |
|------|-------------|
| First character | Must be a letter (a-z, A-Z) or underscore (_) |
| Allowed characters | `a-zA-Z0-9`, underscores (`_`), dots (`.`), colons (`:`), dashes (`-`) |
| Max length | 64 characters |
| Not allowed | Slashes (`/`), spaces, other special characters |

**Examples:**
- ✅ `get_weather` - Valid
- ✅ `mcp:mongodb.query` - Valid (colons and dots allowed)
- ✅ `read-file` - Valid (dashes allowed)
- ❌ `mcp/query` - Invalid (slashes not allowed)
- ❌ `123_tool` - Invalid (must start with letter or underscore)

### JSON Schema Support

| Feature | Status | Notes |
|---------|--------|-------|
| `type` | ✅ Supported | `object`, `string`, `number`, `integer`, `boolean`, `array` |
| `properties` | ✅ Supported | Object properties |
| `required` | ✅ Supported | Required fields array |
| `description` | ✅ Supported | Field descriptions |
| `enum` | ✅ Supported | Enumerated values |
| `items` | ✅ Supported | Array item schema |
| `anyOf` | ✅ Supported | Converted to `any_of` internally |
| `allOf` | ✅ Supported | Converted to `all_of` internally |
| `oneOf` | ✅ Supported | Converted to `one_of` internally |
| `additionalProperties` | ✅ Supported | Additional properties schema |
| `const` | ❌ NOT Supported | Use `enum: [value]` instead |
| `$ref` | ❌ NOT Supported | Inline the schema instead |
| `$defs` / `definitions` | ❌ NOT Supported | Inline definitions instead |
| `$schema` | ❌ NOT Supported | Strip from schema |
| `$id` | ❌ NOT Supported | Strip from schema |
| `default` | ❌ NOT Supported | Strip from schema |
| `examples` | ❌ NOT Supported | Strip from schema |
| `title` (nested) | ⚠️ Caution | May cause issues in nested objects |

**⚠️ IMPORTANT:** The following features will cause a 400 error if sent to the API:
- `const` - Convert to `enum: [value]` instead
- `$ref` / `$defs` - Inline the schema definitions
- `$schema` / `$id` - Strip these metadata fields
- `default` / `examples` - Strip these documentation fields

```json
// ❌ WRONG - Will return 400 error
{ "type": { "const": "email" } }

// ✅ CORRECT - Use enum instead
{ "type": { "enum": ["email"] } }
```

**Note:** The plugin automatically handles these conversions via the `schema-transform.ts` module.

---

## Response Format

### Non-Streaming Response

```json
{
  "response": {
    "candidates": [
      {
        "content": {
          "role": "model",
          "parts": [
            { "text": "Response text here" }
          ]
        },
        "finishReason": "STOP"
      }
    ],
    "usageMetadata": {
      "promptTokenCount": 16,
      "candidatesTokenCount": 4,
      "totalTokenCount": 20
    },
    "modelVersion": "claude-sonnet-4-5",
    "responseId": "msg_vrtx_..."
  },
  "traceId": "abc123..."
}
```

### Streaming Response (SSE)

Content-Type: `text/event-stream`

```
data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"text": "Hello"}]}}], "usageMetadata": {...}, "modelVersion": "...", "responseId": "..."}, "traceId": "..."}

data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"text": " world"}]}, "finishReason": "STOP"}], "usageMetadata": {...}}, "traceId": "..."}

```

### Response Fields

| Field | Description |
|-------|-------------|
| `response.candidates` | Array of response candidates |
| `response.candidates[].content.role` | Always `"model"` |
| `response.candidates[].content.parts` | Array of content parts |
| `response.candidates[].finishReason` | `STOP`, `MAX_TOKENS`, `OTHER` |
| `response.usageMetadata.promptTokenCount` | Input tokens |
| `response.usageMetadata.candidatesTokenCount` | Output tokens |
| `response.usageMetadata.totalTokenCount` | Total tokens |
| `response.usageMetadata.thoughtsTokenCount` | Thinking tokens (Gemini) |
| `response.modelVersion` | Actual model used |
| `response.responseId` | Request ID (format varies by model) |
| `traceId` | Trace ID for debugging |

### Response ID Formats

| Model Type | Format | Example |
|------------|--------|---------|
| Claude | `msg_vrtx_...` | `msg_vrtx_01UDKZG8PWPj9mjajje8d7u7` |
| Gemini | Base64-like | `ypM9abPqFKWl0-kPvamgqQw` |
| GPT-OSS | Base64-like | `y5M9aZaSKq6z2roPoJ7pEA` |

---

## Function Call Response

When the model wants to call a function:

```json
{
  "response": {
    "candidates": [
      {
        "content": {
          "role": "model",
          "parts": [
            {
              "functionCall": {
                "name": "get_weather",
                "args": {
                  "location": "Paris"
                },
                "id": "toolu_vrtx_01PDbPTJgBJ3AJ8BCnSXvUqk"
              }
            }
          ]
        },
        "finishReason": "OTHER"
      }
    ]
  }
}
```

### Providing Function Results

```json
{
  "contents": [
    { "role": "user", "parts": [{ "text": "What's the weather?" }] },
    { "role": "model", "parts": [{ "functionCall": { "name": "get_weather", "args": {...}, "id": "..." } }] },
    { "role": "user", "parts": [{ "functionResponse": { "name": "get_weather", "id": "...", "response": { "temperature": "22C" } } }] }
  ]
}
```

---

## Thinking / Extended Reasoning

### Thinking Config

For thinking-capable models (`*-thinking`), use:

```json
{
  "generationConfig": {
    "maxOutputTokens": 10000,
    "thinkingConfig": {
      "thinkingBudget": 8000,
      "includeThoughts": true
    }
  }
}
```

**⚠️ IMPORTANT: `maxOutputTokens` must be GREATER than `thinkingBudget`**

### Thinking Response (Gemini)

Gemini models return thinking with signatures:

```json
{
  "parts": [
    {
      "thoughtSignature": "ErADCq0DAXLI2nx...",
      "text": "Let me think about this..."
    },
    {
      "text": "The answer is..."
    }
  ]
}
```

### Thinking Response (Claude)

Claude thinking models may include `thought: true` parts:

```json
{
  "parts": [
    {
      "thought": true,
      "text": "Reasoning process...",
      "thoughtSignature": "..."
    },
    {
      "text": "Final answer..."
    }
  ]
}
```

---

## Error Responses

### Error Structure

```json
{
  "error": {
    "code": 400,
    "message": "Error description",
    "status": "INVALID_ARGUMENT",
    "details": [...]
  }
}
```

### Common Error Codes

| Code | Status | Description |
|------|--------|-------------|
| 400 | `INVALID_ARGUMENT` | Invalid request format |
| 401 | `UNAUTHENTICATED` | Invalid/expired token |
| 403 | `PERMISSION_DENIED` | No access to resource |
| 404 | `NOT_FOUND` | Model not found |
| 429 | `RESOURCE_EXHAUSTED` | Rate limit exceeded |

### Rate Limit Response

```json
{
  "error": {
    "code": 429,
    "message": "You have exhausted your capacity on this model. Your quota will reset after 3s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "3.957525076s"
      }
    ]
  }
}
```

---

## NOT Supported

The following Anthropic/Vertex AI features are **NOT supported**:

| Feature | Error |
|---------|-------|
| `anthropic_version` | Unknown field |
| `messages` array | Unknown field |
| `max_tokens` | Unknown field |
| Plain string `systemInstruction` | Invalid value |
| `system_instruction` (snake_case at root) | Unknown field |
| JSON Schema `const` | Unknown field (use `enum: [value]`) |
| JSON Schema `$ref` | Not supported (inline instead) |
| JSON Schema `$defs` | Not supported (inline instead) |
| Tool names with `/` | Invalid (use `_` or `:` instead) |
| Tool names starting with digit | Invalid (must start with letter/underscore) |

---

## Complete Request Example

```json
{
  "project": "my-project-id",
  "model": "claude-sonnet-4-5",
  "request": {
    "contents": [
      {
        "role": "user",
        "parts": [
          { "text": "Hello, how are you?" }
        ]
      }
    ],
    "systemInstruction": {
      "parts": [
        { "text": "You are a helpful assistant." }
      ]
    },
    "generationConfig": {
      "maxOutputTokens": 1000,
      "temperature": 0.7
    }
  },
  "userAgent": "antigravity",
  "requestId": "agent-abc123"
}
```

---

## Response Headers

| Header | Description |
|--------|-------------|
| `x-cloudaicompanion-trace-id` | Trace ID for debugging |
| `server-timing` | Request duration |

---

## Comparison: Antigravity vs Vertex AI Anthropic

| Feature | Antigravity | Vertex AI Anthropic |
|---------|-------------|---------------------|
| Endpoint | `cloudcode-pa.googleapis.com` | `aiplatform.googleapis.com` |
| Request format | Gemini-style `contents` | Anthropic `messages` |
| `anthropic_version` | Not used | Required |
| Model names | Simple (`claude-sonnet-4-5`) | Versioned (`claude-4-5@date`) |
| Response format | `candidates[]` | Anthropic `content[]` |
| Multi-model support | Yes (Claude, Gemini, etc.) | Anthropic only |

---

## Changelog

- **2025-12-14**: Added function calling quirks, JSON Schema support matrix, tool name rules
- **2025-12-13**: Initial specification based on direct API testing
