import { describe, expect, it } from "vitest"
import {
  OPENCODE_V2_MODEL_DEFINITIONS,
  buildAccountModelDefinitions,
  buildAccountModelKeys,
  normalizeModelAccountKeys,
} from "./models-v2"
import { COLLAPSED_TIER_BODY_KEY, getCollapsedModelBaseId, resolveCollapsedModelTarget } from "../transform/model-resolver"

const tierMarker = (id: string) => ({ [COLLAPSED_TIER_BODY_KEY]: id })

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

  it("uses account metadata while filtering unavailable models", () => {
    const catalog = buildAccountModelDefinitions({
      "claude-opus-5-5-high": { displayName: "Claude Opus 5.5 High", maxTokens: 1000000, maxOutputTokens: 128000 },
      "gemini-3.9-flash-medium": { displayName: "Gemini 3.9 Flash (Medium)", maxTokens: 1048576, maxOutputTokens: 65536 },
      "gemini-4-argon-disabled": { disabled: true },
      "gemini-3.8-flash-tiered": {},
      "gemini-3.1-flash-image": {},
      "gemini-2.5-pro": { selectable: false },
      "tab_flash_lite_preview": {},
    })
    expect(Object.keys(catalog)).toEqual(["antigravity-claude-opus-5-5-high", "antigravity-gemini-3.9-flash"])
    expect(catalog["antigravity-claude-opus-5-5-high"]).toMatchObject({
      limit: { context: 1000000, output: 128000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      variants: [],
    })
    expect(catalog["antigravity-gemini-3.9-flash"]?.variants).toEqual([
      { id: "medium", settings: { thinkingConfig: { thinkingLevel: "medium" } }, body: tierMarker("medium") },
    ])
    expect(resolveCollapsedModelTarget("antigravity-gemini-3.9-flash", { thinkingLevel: "medium" }))
      .toEqual({ model: "gemini-3.9-flash-medium", thinkingLevel: "medium" })
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-3.8-flash"]).toBeDefined()
  })

  it("collapses advertised reasoning tiers into one model with variants", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", maxTokens: 1048576, maxOutputTokens: 65536 },
      "gemini-3.8-flash-medium": { displayName: "Gemini 3.8 Flash (Medium)", maxTokens: 1048576, maxOutputTokens: 65536 },
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", maxTokens: 1048576, maxOutputTokens: 65536 },
    })

    expect(Object.keys(catalog)).toEqual(["antigravity-gemini-3.8-flash"])
    expect(catalog["antigravity-gemini-3.8-flash"]).toMatchObject({
      name: "Gemini 3.8 Flash (Antigravity)",
      limit: { context: 1048576, output: 65536 },
      variants: [
        { id: "low", settings: { thinkingConfig: { thinkingLevel: "low" } }, body: tierMarker("low") },
        { id: "medium", settings: { thinkingConfig: { thinkingLevel: "medium" } }, body: tierMarker("medium") },
        { id: "high", settings: { thinkingConfig: { thinkingLevel: "high" } }, body: tierMarker("high") },
      ],
    })
  })

  it("emits a collapsed model at the first family member in catalog order", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-3.5-pro": {},
      "gemini-3.8-flash-medium": {},
      "claude-opus-4-6-thinking": {},
      "gemini-3.8-flash-low": {},
      "gemini-3.8-flash-high": {},
    })

    expect(Object.keys(catalog)).toEqual([
      "antigravity-gemini-3.5-pro",
      "antigravity-gemini-3.8-flash",
      "antigravity-claude-opus-4-6-thinking",
    ])
  })

  it("keeps lone tier-like IDs as their own models", () => {
    const catalog = buildAccountModelDefinitions({
      "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B Medium" },
      "claude-sonnet-5-5-high": { displayName: "Claude Sonnet 5.5 High" },
      "gemini-3.9-flash-medium": { displayName: "Gemini 3.9 Flash Medium" },
    })

    expect(Object.keys(catalog)).toEqual([
      "antigravity-gpt-oss-120b-medium",
      "antigravity-claude-sonnet-5-5-high",
      "antigravity-gemini-3.9-flash-medium",
    ])
    expect(catalog["antigravity-gpt-oss-120b-medium"]?.variants).toEqual([])
  })

  it("collapses a real base model together with its tier siblings", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash", maxTokens: 1048576, maxOutputTokens: 65536 },
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", maxTokens: 1048576, maxOutputTokens: 65536 },
    })

    expect(Object.keys(catalog)).toEqual(["antigravity-gemini-3.8-flash"])
    expect(catalog["antigravity-gemini-3.8-flash"]?.variants).toEqual([
      { id: "high", settings: { thinkingConfig: { thinkingLevel: "high" } }, body: tierMarker("high") },
    ])
  })

  it("uses budget variants for Claude thinking families", () => {
    const catalog = buildAccountModelDefinitions({
      "claude-opus-4-6-thinking-low": {},
      "claude-opus-4-6-thinking-medium": {},
      "claude-opus-4-6-thinking-high": {},
    })

    expect(Object.keys(catalog)).toEqual(["antigravity-claude-opus-4-6-thinking"])
    expect(catalog["antigravity-claude-opus-4-6-thinking"]?.variants).toEqual([
      { id: "low", settings: { thinkingConfig: { thinkingBudget: 8192 } }, body: tierMarker("low") },
      { id: "medium", settings: { thinkingConfig: { thinkingBudget: 16384 } }, body: tierMarker("medium") },
      { id: "high", settings: { thinkingConfig: { thinkingBudget: 32768 } }, body: tierMarker("high") },
    ])
  })

  it("maps single-tier account eligibility onto the collapsed family key", () => {
    const catalog = {
      "gemini-3.8-flash-low": {},
      "gemini-3.8-flash-medium": {},
      "gemini-3.8-flash-high": {},
      "gemini-3.5-flash-lite": {},
    }

    expect(buildAccountModelKeys({ "gemini-3.8-flash-medium": {} }, catalog))
      .toEqual(["antigravity-gemini-3.8-flash"])
    expect(buildAccountModelKeys({ "gemini-3.5-flash-lite": {} }, catalog))
      .toEqual(["antigravity-gemini-3.5-flash-lite"])
  })

  it("normalizes cached per-tier account keys to collapsed keys", () => {
    const normalized = normalizeModelAccountKeys({
      "antigravity-gemini-3.8-flash-low": ["first"],
      "antigravity-gemini-3.8-flash-high": ["second", "first"],
      "antigravity-gemini-3.5-flash-lite": ["first"],
    }, {
      "gemini-3.8-flash-low": {},
      "gemini-3.8-flash-medium": {},
      "gemini-3.8-flash-high": {},
      "gemini-3.5-flash-lite": {},
    })

    expect(normalized).toEqual({
      "antigravity-gemini-3.8-flash": ["first", "second"],
      "antigravity-gemini-3.5-flash-lite": ["first"],
    })
  })

  it("uses display-name efforts so renamed tiers work without code changes", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-9-flash-extra-low": { displayName: "Gemini 9 Flash (Extra Low)" },
      "gemini-9-flash-turbo": { displayName: "Gemini 9 Flash (Turbo)" },
      "gemini-9-flash-ultra": { displayName: "Gemini 9 Flash (Ultra)" },
    })

    expect(Object.keys(catalog)).toEqual(["antigravity-gemini-9-flash"])
    expect(catalog["antigravity-gemini-9-flash"]?.variants.map(variant => variant.id))
      .toEqual(["extra-low", "turbo", "ultra"])
    // Dispatch exactly what OpenCode emits for #turbo: empty thinking settings
    // plus the tier marker. The marker must still select the turbo backend.
    const turbo = catalog["antigravity-gemini-9-flash"]?.variants.find(variant => variant.id === "turbo")
    expect(turbo?.settings).toEqual({})
    const emittedConfig = turbo?.settings?.thinkingConfig
    const turboSettings = emittedConfig && "thinkingLevel" in emittedConfig
      ? { thinkingLevel: emittedConfig.thinkingLevel }
      : undefined
    expect(resolveCollapsedModelTarget(
      "antigravity-gemini-9-flash",
      turboSettings,
      turbo?.body?.[COLLAPSED_TIER_BODY_KEY] as string | undefined,
    )).toEqual({ model: "gemini-9-flash-turbo", suppressThinking: true })
  })

  it("treats the display label as authoritative when the ID disagrees", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-3.5-flash-low": { displayName: "Gemini 3.5 Flash (Medium)" },
      "gemini-3.5-flash-extra-low": { displayName: "Gemini 3.5 Flash (Low)" },
    })

    expect(catalog["antigravity-gemini-3.5-flash"]?.variants).toEqual([
      { id: "low", settings: { thinkingConfig: { thinkingLevel: "low" } }, body: tierMarker("low") },
      { id: "medium", settings: { thinkingConfig: { thinkingLevel: "medium" } }, body: tierMarker("medium") },
    ])
    expect(resolveCollapsedModelTarget("antigravity-gemini-3.5-flash", { thinkingLevel: "medium" }))
      .toEqual({ model: "gemini-3.5-flash-low", thinkingLevel: "medium" })
  })

  it("collapses newly added families with parenthetical efforts", () => {
    const catalog = buildAccountModelDefinitions({
      "gpt-oss-120b-low": { displayName: "GPT-OSS 120B (Low)" },
      "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)" },
      "gpt-oss-120b-high": { displayName: "GPT-OSS 120B (High)" },
    })

    expect(Object.keys(catalog)).toEqual(["antigravity-gpt-oss-120b"])
    expect(catalog["antigravity-gpt-oss-120b"]?.variants).toEqual([
      { id: "low", settings: {}, body: tierMarker("low") },
      { id: "medium", settings: {}, body: tierMarker("medium") },
      { id: "high", settings: {}, body: tierMarker("high") },
    ])
    expect(resolveCollapsedModelTarget("antigravity-gpt-oss-120b", { thinkingLevel: "high" }))
      .toEqual({ model: "gpt-oss-120b-high", suppressThinking: true })
  })

  it("exposes a lone labelled effort as a one-variant family", () => {
    const catalog = buildAccountModelDefinitions({
      "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)" },
    })

    expect(Object.keys(catalog)).toEqual(["antigravity-gpt-oss-120b"])
    expect(catalog["antigravity-gpt-oss-120b"]?.variants).toEqual([{ id: "medium", settings: {}, body: tierMarker("medium") }])
    expect(resolveCollapsedModelTarget("antigravity-gpt-oss-120b", { thinkingLevel: "medium" }))
      .toEqual({ model: "gpt-oss-120b-medium", suppressThinking: true })
  })

  it("does not treat non-effort parentheticals as tiers", () => {
    const catalog = buildAccountModelDefinitions({
      "claude-opus-4-6": { displayName: "Claude Opus 4.6" },
      "claude-opus-4-6-thinking": { displayName: "Claude Opus 4.6 (Thinking)" },
    })

    expect(Object.keys(catalog)).toEqual([
      "antigravity-claude-opus-4-6",
      "antigravity-claude-opus-4-6-thinking",
    ])
  })

  it("groups a base model by backend ID even when its display name differs", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash Preview Build" },
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
    })

    expect(Object.keys(catalog)).toEqual(["antigravity-gemini-3.8-flash"])
    expect(catalog["antigravity-gemini-3.8-flash"]?.variants.map(variant => variant.id))
      .toEqual(["high"])
    // A request without a variant still prefers the real base model.
    expect(resolveCollapsedModelTarget("antigravity-gemini-3.8-flash")).toEqual({ model: "gemini-3.8-flash" })
  })

  it("keeps a discarded bare-ID alias inside the family instead of overwriting it", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
      // The bare ID repeats the high effort through its display name.
      "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash (High)" },
    })

    expect(Object.keys(catalog)).toEqual(["antigravity-gemini-3.8-flash"])
    expect(catalog["antigravity-gemini-3.8-flash"]?.variants).toEqual([
      { id: "high", settings: { thinkingConfig: { thinkingLevel: "high" } }, body: tierMarker("high") },
    ])
    expect(resolveCollapsedModelTarget("antigravity-gemini-3.8-flash", undefined, "high"))
      .toEqual({ model: "gemini-3.8-flash-high", thinkingLevel: "high" })
  })

  it("keeps tiers with different image capabilities as separate models", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", supportsImages: true },
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", supportsImages: false },
    })

    expect(Object.keys(catalog)).toEqual([
      "antigravity-gemini-3.8-flash-low",
      "antigravity-gemini-3.8-flash-high",
    ])
    expect(catalog["antigravity-gemini-3.8-flash-low"]?.capabilities.input).toContain("image")
    expect(catalog["antigravity-gemini-3.8-flash-high"]?.capabilities.input).toEqual(["text"])
  })

  it("ignores a discarded alias when deciding image support", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", supportsImages: true },
      // The alias repeats the effort but is text-only; it is never dispatched.
      "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash (High)", supportsImages: false },
    })

    expect(Object.keys(catalog)).toEqual(["antigravity-gemini-3.8-flash"])
    expect(catalog["antigravity-gemini-3.8-flash"]?.capabilities.input).toContain("image")
  })

  it("removes obsolete families after a catalog refresh", () => {
    buildAccountModelDefinitions({
      "gemini-9-pro-high": { displayName: "Gemini 9 Pro (High)" },
    })
    expect(resolveCollapsedModelTarget("antigravity-gemini-9-pro", undefined, "high"))
      .toEqual({ model: "gemini-9-pro-high", thinkingLevel: "high" })

    buildAccountModelDefinitions({
      "gemini-9-pro": { displayName: "Gemini 9 Pro" },
    })
    expect(getCollapsedModelBaseId("gemini-9-pro-high")).toBeUndefined()
    expect(resolveCollapsedModelTarget("antigravity-gemini-9-pro")).toBeUndefined()
  })
})
