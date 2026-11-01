import { describe, expect, it } from "vitest"
import { OPENCODE_V2_MODEL_DEFINITIONS, buildAccountModelDefinitions } from "./models-v2"
import { OPENCODE_MODEL_DEFINITIONS } from "./models"
import { resolveModelForHeaderStyle } from "../transform/model-resolver"

describe("OpenCode V2 models", () => {
  it("registers tools, modalities, and V2 variant overlays", () => {
    expect(OPENCODE_V2_MODEL_DEFINITIONS["gemini-2.5-flash"]).toBeUndefined()
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-3-flash"]).toMatchObject({
      package: "aisdk:@ai-sdk/google",
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      variants: expect.arrayContaining([{ id: "high", settings: { thinkingConfig: { thinkingLevel: "high" } } }]),
    })
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-claude-opus-4-6-thinking"]?.variants).toContainEqual({
      id: "max", settings: { thinkingConfig: { thinkingBudget: 32768 } },
    })
  })

  it("exposes the current Antigravity inventory before discovery", () => {
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-4-argon-high"]).toMatchObject({
      name: "Gemini 4 Argon (High) (Antigravity)",
      limit: { context: 1048576, output: 65536 },
    })
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-claude-sonnet-5-5-medium"]).toMatchObject({
      limit: { context: 1000000, output: 128000 },
    })
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gpt-oss-120b-medium"]?.capabilities).toMatchObject({
      tools: true, input: ["text"], output: ["text"],
    })
    expect(Object.keys(OPENCODE_V2_MODEL_DEFINITIONS).sort()).toEqual(
      Object.keys(OPENCODE_MODEL_DEFINITIONS).filter(id => id.startsWith("antigravity-")).sort(),
    )
  })

  it("uses account metadata and preserves backend tiers while filtering unavailable models", () => {
    const catalog = buildAccountModelDefinitions({
      "claude-opus-5-5-high": { displayName: "Claude Opus 5.5 High", maxTokens: 1000000, maxOutputTokens: 128000 },
      "gemini-3.9-flash-medium": { displayName: "Gemini 3.9 Flash (Medium)", maxTokens: 1048576, maxOutputTokens: 65536 },
      "gemini-4-argon-disabled": { disabled: true },
      "gemini-3.8-flash-tiered": {},
      "gemini-3.1-flash-image": {},
      "gemini-2.5-pro": { selectable: false },
      "gpt-oss-120b-medium": {},
      "tab_flash_lite_preview": {},
    })
    expect(Object.keys(catalog)).toEqual(["antigravity-claude-opus-5-5-high", "antigravity-gemini-3.9-flash-medium", "antigravity-gpt-oss-120b-medium"])
    expect(catalog["antigravity-claude-opus-5-5-high"]).toMatchObject({
      limit: { context: 1000000, output: 128000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      variants: [],
    })
    expect(catalog["antigravity-gpt-oss-120b-medium"]?.capabilities).toMatchObject({ tools: true, input: ["text"], output: ["text"] })
    expect(resolveModelForHeaderStyle("antigravity-gemini-3.9-flash-medium", "antigravity").actualModel).toBe("gemini-3.9-flash-medium")
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-3.8-flash-high"]).toBeDefined()
  })
})
