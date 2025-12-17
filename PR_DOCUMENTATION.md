# Pull Request: Fix JSON Schema Validation for Claude Models

## Overview

This PR resolves Issue #16 where Claude models (e.g., `claude-opus-4-5-thinking`) were failing with JSON schema validation errors when using MCP tools that contain `anyOf`, `allOf`, or `oneOf` keywords.

**Error Message:**
```
tools.X.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12
```

## Problem

The previous implementation in `src/plugin/request.ts` contained a `sanitizeSchema` function that **aggressively stripped** all `anyOf`, `allOf`, and `oneOf` keywords from tool schemas when preparing requests for Claude models. This was based on an incorrect assumption that these features were "not well supported."

### Impact

- **MongoDB MCP Server**: Failed completely on Claude models (worked on Gemini)
- **Firecrawl MCP**: Failed on Claude models
- **Any MCP tool using schema combinators**: Would fail with validation errors
- **Tools with no parameters**: Got overly permissive `{ type: "object" }` schema instead of strict void schema

### Root Cause

The sanitization logic would transform valid schemas like:

```json
{
  "type": "array",
  "items": {
    "anyOf": [
      { "name": { "enum": ["aggregate"] } },
      { "name": { "enum": ["find"] } },
      { "name": { "enum": ["count"] } }
    ]
  }
}
```

Into broken schemas:

```json
{
  "type": "array",
  "items": {}  // ❌ Invalid - no type constraints
}
```

## Solution

### Changes Made

1. **Replaced `sanitizeSchema` with `normalizeSchemaRecursive`** (`src/plugin/request.ts:252-280`)
   - **Preserves** `anyOf`, `allOf`, `oneOf` keywords (valid in JSON Schema Draft 2020-12)
   - Recursively processes nested schemas while maintaining structure
   - No longer strips valid schema features

2. **Improved Void Schema Handling** (`src/plugin/request.ts:282-303`)
   - Empty/missing schemas now normalize to: `{ type: "object", properties: {}, additionalProperties: false }`
   - This strict format prevents tools from accepting arbitrary parameters
   - Complies with Anthropic's API requirements

3. **Safe Deep Cloning** (`src/plugin/request.ts:305`)
   - Uses `structuredClone()` to prevent mutation of original tool definitions
   - Ensures input schemas remain unchanged during normalization

4. **Comprehensive Test Coverage** (`src/plugin/request.test.ts`)
   - Tests Claude schema preservation with `anyOf`/`allOf`/`oneOf`
   - Validates void schema normalization
   - Confirms non-Claude (Gemini) path still works
   - Verifies immutability (no mutation of input)

### Technical Details

**Why This Works:**

- Anthropic's Claude API **fully supports** JSON Schema Draft 2020-12, including schema combinators
- Google's Antigravity gateway proxies Claude requests and preserves these features
- The error was caused by our overzealous sanitization, not by the API itself

**Proof:**

- Gemini models (using the same Antigravity backend) worked fine with `anyOf` schemas
- Research confirmed Claude API supports JSON Schema Draft 2020-12 spec
- Backend architect review validated this approach

## Testing

### Build & Test Results

```bash
npm run build  # ✅ Passes
npm test       # ✅ All 14 tests pass (4 new)
```

### Test Coverage

New tests in `src/plugin/request.test.ts`:

1. **`preserves Claude tool schemas that reference anyOf/allOf/oneOf`**
   - Verifies complex schemas with combinators are preserved
   - Checks all three keyword types

2. **`normalizes Claude tools without schemas into void schema`**
   - Ensures parameterless tools get strict void schema
   - Validates `additionalProperties: false` is set

3. **`runs Gemini/standard normalization path for non-Claude models`**
   - Confirms legacy behavior for Gemini still works
   - Validates backward compatibility

4. **`does not mutate supplied tool definitions during normalization`**
   - Ensures original tool definitions remain unchanged
   - Validates deep cloning works correctly

## Verification

### Before This Fix

```bash
# Using Claude with MongoDB MCP
Error: tools.43.custom.input_schema: JSON schema is invalid. 
It must match JSON Schema draft 2020-12
```

### After This Fix

```bash
# Using Claude with MongoDB MCP
✅ Request succeeds
✅ Tool schemas preserved correctly
✅ Complex MCP tools work with Claude models
```

## Compatibility

- **Claude Models**: ✅ Now fully compatible with MCP tools using schema combinators
- **Gemini Models**: ✅ No changes to existing behavior
- **Backward Compatibility**: ✅ All existing tests pass
- **Node.js**: Requires Node.js 17+ for `structuredClone()` (already met by project)

## Migration Notes

No breaking changes. This is a pure bug fix that:
- Makes Claude models work with more MCP tools
- Improves schema handling for all models
- Doesn't change the API or require configuration updates

## Related Issues

Closes #16

## Commit

```
fix: preserve JSON Schema Draft 2020-12 combinators for Claude models

Claude models via Antigravity were failing with 'JSON schema is invalid' 
errors when MCP tools used anyOf/allOf/oneOf keywords. The previous 
implementation aggressively stripped these valid schema features, creating 
broken schemas (e.g., items: {}) that failed validation.

Changes:
- Replace sanitizeSchema with normalizeSchemaRecursive that preserves 
  anyOf/allOf/oneOf combinators (supported by Anthropic API)
- Use structuredClone for deep copying to prevent mutation of original 
  tool definitions
- Normalize void/empty schemas to strict format: 
  {type: 'object', properties: {}, additionalProperties: false}
- Add comprehensive unit tests for schema normalization logic

Fixes #16
```

## Review Checklist

- [x] Code builds without errors
- [x] All tests pass
- [x] New tests added for changed functionality
- [x] No breaking changes
- [x] Documentation updated (this PR doc)
- [x] Commit message follows conventional commits
- [x] Issue reference included

## Next Steps

Once merged:
1. Version bump to 1.1.3 (patch release)
2. Publish to npm
3. Update README with release notes
4. Close Issue #16

---

## For Reviewers

**Key Files to Review:**
1. `src/plugin/request.ts` (lines 246-310) - Core logic changes
2. `src/plugin/request.test.ts` - New test coverage

**Questions to Consider:**
- Does the schema normalization logic correctly preserve combinators?
- Are the test cases comprehensive enough?
- Should we add any additional validation or error handling?
