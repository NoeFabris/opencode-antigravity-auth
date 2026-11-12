import { OPENCODE_MODEL_DEFINITIONS, type OpencodeModelDefinition } from "./models.ts"
import type { AvailableModel } from "../quota.ts"
import { registerAdvertisedModelIds } from "../transform/model-resolver.ts"
import { z } from "zod"

export const ModelCatalogCacheSchema = z.object({
  version: z.literal(3),
  identity: z.string(), updatedAt: z.number(),
  accounts: z.record(z.string(), z.array(z.string())),
  models: z.record(z.string(), z.object({
    displayName: z.string().optional(), maxTokens: z.number().positive().optional(), maxOutputTokens: z.number().positive().optional(),
    supportsImages: z.boolean().optional(), supportsThinking: z.boolean().optional(), disabled: z.boolean().optional(), selectable: z.boolean().optional(),
  })),
})

// Used before login or when discovery is unavailable. Once connected, Google's
// catalog replaces this list, including model IDs, names and token limits.
// Every Antigravity definition doubles as a fallback entry so newly added
// models stay visible even when live discovery has not completed yet.
const fallbackModels: Record<string, OpencodeModelDefinition> = Object.fromEntries(
  Object.entries(OPENCODE_MODEL_DEFINITIONS)
    .filter(([id]) => id.startsWith("antigravity-")),
)

function definition(model: OpencodeModelDefinition) {
  return {
    name: model.name,
    package: "aisdk:@ai-sdk/google",
    limit: { ...model.limit },
    capabilities: { tools: true, ...model.modalities },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    variants: Object.entries(model.variants ?? {}).map(([id, settings]) => ({
      id,
      settings: settings.thinkingLevel
        ? { thinkingConfig: { thinkingLevel: settings.thinkingLevel } }
        : { ...settings },
    })),
  }
}

export const OPENCODE_V2_MODEL_DEFINITIONS = Object.fromEntries(
  Object.entries(fallbackModels).map(([id, model]) => [id, definition(model)]),
)
export type V2ModelDefinitions = typeof OPENCODE_V2_MODEL_DEFINITIONS

/**
 * Builds OpenCode V2 model definitions from the account-specific catalog.
 *
 * Filters the catalog down to selectable chat models (gemini-, claude-, and
 * gpt-oss- prefixed IDs) and falls back to each model's known static definition
 * for name, limit, and modalities when the catalog omits them.
 */
export function buildAccountModelDefinitions(models: Record<string, AvailableModel>): V2ModelDefinitions {
  const definitions: V2ModelDefinitions = {}
  for (const [id, model] of Object.entries(models)) {
    // Exclude completion/internal, image-generation, tier routers and explicitly
    // disabled entries. They are not selectable chat models.
    if (!/^(gemini-|claude-|gpt-oss-)/.test(id) || /image|imagen|-(disabled|tiered)$/.test(id) || model.disabled || model.selectable === false) continue
    const key = `antigravity-${id}`
    const known = OPENCODE_MODEL_DEFINITIONS[key]
    definitions[key] = definition({
      name: `${model.displayName ?? id} (Antigravity)`,
      limit: {
        context: model.maxTokens ?? known?.limit.context ?? 200000,
        output: model.maxOutputTokens ?? known?.limit.output ?? 64000,
      },
      modalities: model.supportsImages === false
        ? { input: ["text"], output: ["text"] }
        : known?.modalities ?? { input: ["text", "image", "pdf"], output: ["text"] },
      variants: known?.variants,
    })
  }
  registerAdvertisedModelIds(Object.keys(models))
  return definitions
}
