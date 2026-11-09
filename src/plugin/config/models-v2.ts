import {
  OPENCODE_MODEL_DEFINITIONS,
  type ModelThinkingLevel,
  type ModelVariant,
  type OpencodeModelDefinition,
} from "./models.ts"
import type { AvailableModel } from "../quota.ts"
import {
  COLLAPSED_MODEL_TIERS,
  COLLAPSED_TIER_BODY_KEY,
  getThinkingTierBudget,
  getThinkingTierSuffix,
  normalizeReasoningLabel,
  parseDisplayReasoning,
  registerAdvertisedModelIds,
  registerCollapsedModelFamily,
  resetCollapsedModelFamilies,
  type CollapsedModelFamily,
} from "../transform/model-resolver.ts"
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

/** Grouping key that treats "3.8" and "3-8" as the same family. */
function familyKey(value: string): string {
  return normalizeReasoningLabel(value).replace(/\./g, "-")
}

/** Returns the standard Gemini thinking level for an effort slug. */
function standardThinkingLevel(id: string): ModelThinkingLevel | undefined {
  const normalized = id.trim().toLowerCase()
  return normalized === "minimal" || normalized === "low" || normalized === "medium" || normalized === "high"
    ? normalized
    : undefined
}

/** True for Gemini 2.5 families, which use numeric thinking budgets. */
function isGemini25(baseId: string): boolean {
  const lower = baseId.toLowerCase()
  return lower.includes("gemini-2.5") || lower.includes("gemini-2-5")
}

/** True when a family expresses effort as a numeric thinking budget. */
function isBudgetThinkingFamily(baseId: string): boolean {
  const lower = baseId.toLowerCase()
  return lower.includes("claude") || isGemini25(lower)
}

/** Gemini 3+ (and future Gemini versions) express tiers as thinkingLevel. */
function isLevelThinkingFamily(baseId: string): boolean {
  const lower = baseId.toLowerCase()
  return lower.includes("gemini") && !isGemini25(lower)
}

/** Thinking settings for one variant, as emitted to OpenCode. */
function collapseVariants(family: CollapsedModelFamily): Record<string, ModelVariant> {
  const variants: Record<string, ModelVariant> = {}
  const mode = family.thinking
    ?? (isBudgetThinkingFamily(family.baseId) ? "budget" : isLevelThinkingFamily(family.baseId) ? "level" : "none")
  for (const id of Object.keys(family.tiers)) {
    const body = { [COLLAPSED_TIER_BODY_KEY]: id }
    if (mode === "none") {
      variants[id] = { body }
    } else if (mode === "budget") {
      const value = getThinkingTierBudget(family.baseId, id)
      variants[id] = value === undefined ? { body } : { thinkingConfig: { thinkingBudget: value }, body }
    } else {
      const level = standardThinkingLevel(id)
      variants[id] = level ? { thinkingLevel: level, body } : { body }
    }
  }
  return variants
}

export const GEMINI_38_FLASH_FAMILY: CollapsedModelFamily = {
  baseId: "gemini-3.8-flash",
  tiers: {
    low: "gemini-3.8-flash-low",
    medium: "gemini-3.8-flash-medium",
    high: "gemini-3.8-flash-high",
  },
  labels: { low: "Low", medium: "Medium", high: "High" },
  defaultTier: "low",
  thinking: "level",
}
registerCollapsedModelFamily(GEMINI_38_FLASH_FAMILY)

// Used before login or when discovery is unavailable. Once connected, Google's
// catalog replaces this list, including model IDs, names and token limits.
const fallbackModels: Record<string, OpencodeModelDefinition> = Object.fromEntries(
  ["antigravity-gemini-3-flash", "antigravity-claude-sonnet-4-6", "antigravity-claude-opus-4-6-thinking"]
    .flatMap(id => OPENCODE_MODEL_DEFINITIONS[id] ? [[id, OPENCODE_MODEL_DEFINITIONS[id]]] : []),
)
fallbackModels[`antigravity-${GEMINI_38_FLASH_FAMILY.baseId}`] = {
  name: "Gemini 3.8 Flash (Antigravity)",
  limit: { context: 1048576, output: 65536 },
  modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  variants: collapseVariants(GEMINI_38_FLASH_FAMILY),
}

/** Converts a plugin model definition into an OpenCode V2 model entry. */
function definition(model: OpencodeModelDefinition) {
  return {
    name: model.name,
    package: "aisdk:@ai-sdk/google",
    limit: { ...model.limit },
    capabilities: { tools: true, ...model.modalities },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    variants: Object.entries(model.variants ?? {}).map(([id, settings]) => {
      const { body, thinkingLevel, ...rest } = settings
      return {
        id,
        settings: thinkingLevel ? { thinkingConfig: { thinkingLevel } } : rest,
        ...(body ? { body: { ...body } } : {}),
      }
    }),
  }
}

/** True for catalog rows that can be offered as selectable chat models. */
function isEligibleModel(id: string, model: AvailableModel): boolean {
  // Exclude completion/internal, image-generation, tier routers and explicitly
  // disabled entries. They are not selectable chat models.
  return /^(gemini-|claude-|gpt-oss-)/.test(id)
    && !/image|imagen|-(disabled|tiered)$/.test(id)
    && !model.disabled
    && model.selectable !== false
}

/** Returns only the catalog entries that are selectable chat models. */
function eligibleEntries(models: Record<string, AvailableModel>): Array<[string, AvailableModel]> {
  return Object.entries(models).filter(([id, model]) => isEligibleModel(id, model))
}

interface PlannedVariant {
  id: string
  label: string
  model: string
  order: number
  /** True when the effort came from displayName rather than an ID suffix. */
  fromDisplay: boolean
  /** False when the backend explicitly reports that the member cannot take images. */
  supportsImages: boolean
}

interface PlannedGroup {
  key: string
  familyName: string
  variants: Map<string, PlannedVariant>
  /** Backend IDs that describe a known effort but are not the retained target. */
  aliasIds: Set<string>
  baseModelId?: string
  baseSupportsImages?: boolean
}

interface ParsedEntry {
  id: string
  familyKey: string
  familyName: string
  variantId?: string
  variantLabel?: string
  fromDisplay: boolean
  isBase: boolean
  supportsImages: boolean
  order: number
}

interface CollapsedPlan {
  key: string
  family: CollapsedModelFamily
  displayName: string
  /** First catalog entry belonging to the family; the collapsed model is emitted there. */
  firstId: string
  memberIds: string[]
}

/** Removes a trailing standard tier label from a display name. */
function stripTierLabel(name: string): string {
  return name
    .replace(/\s*[\(\[]\s*(?:minimal|low|medium|high)\s*[\)\]]\s*$/i, "")
    .replace(/\s*[-–—:]\s*(?:minimal|low|medium|high)\s*$/i, "")
    .replace(/\s+(?:minimal|low|medium|high)\s*$/i, "")
    .trim()
}

/**
 * Parses one catalog entry. A trailing parenthetical in displayName is the
 * authoritative effort label. Entries without one fall back to the ID suffix
 * for known thinking families, then to a base model.
 */
function parseCatalogEntry(id: string, model: AvailableModel, order: number): ParsedEntry {
  const supportsImages = model.supportsImages !== false
  const display = parseDisplayReasoning(model.displayName)
  if (display) {
    return {
      id,
      order,
      familyKey: familyKey(display.familyName),
      familyName: display.familyName,
      variantId: display.id,
      variantLabel: display.label,
      fromDisplay: true,
      isBase: false,
      supportsImages,
    }
  }

  const suffix = getThinkingTierSuffix(id)
  if (suffix) {
    return {
      id,
      order,
      familyKey: familyKey(suffix.baseId),
      familyName: stripTierLabel(model.displayName?.trim() || suffix.baseId) || suffix.baseId,
      variantId: suffix.tier,
      variantLabel: suffix.tier,
      fromDisplay: false,
      isBase: false,
      supportsImages,
    }
  }

  const displayName = model.displayName?.trim() || id
  return {
    id,
    order,
    // Group by backend ID: the display name may add qualifiers that are not
    // part of the family key used by the tier siblings.
    familyKey: familyKey(id),
    familyName: stripTierLabel(displayName) || displayName,
    fromDisplay: false,
    isBase: true,
    supportsImages,
  }
}

/** Orders variants by standard tier, then by catalog order. */
function compareVariants(a: PlannedVariant, b: PlannedVariant): number {
  const ai = COLLAPSED_MODEL_TIERS.indexOf(a.id)
  const bi = COLLAPSED_MODEL_TIERS.indexOf(b.id)
  const aRank = ai === -1 ? COLLAPSED_MODEL_TIERS.length : ai
  const bRank = bi === -1 ? COLLAPSED_MODEL_TIERS.length : bi
  if (aRank !== bRank) return aRank - bRank
  return a.order - b.order
}

/** Records the real base model for a group, if its ID matches the family key. */
function addBase(group: PlannedGroup, parsed: ParsedEntry): void {
  if (group.baseModelId) return
  if (familyKey(parsed.id) !== group.key) return
  group.baseModelId = parsed.id
  group.baseSupportsImages = parsed.supportsImages
}

/** Adds one effort to a group and keeps discarded aliases in the family. */
function addVariant(group: PlannedGroup, parsed: ParsedEntry): void {
  if (!parsed.variantId) return
  const existing = group.variants.get(parsed.variantId)
  const candidate: PlannedVariant = {
    id: parsed.variantId,
    label: parsed.variantLabel ?? parsed.variantId,
    model: parsed.id,
    order: parsed.order,
    fromDisplay: parsed.fromDisplay,
    supportsImages: parsed.supportsImages,
  }
  if (!existing) {
    group.variants.set(candidate.id, candidate)
    return
  }
  // Two catalog rows can describe the same effort (for example an alias whose
  // ID encodes the tier and one that does not). Prefer the row whose ID
  // actually ends with the effort slug, but keep the discarded row as a family
  // member so it cannot be emitted as a separate model that overwrites the
  // collapsed definition.
  const idSlug = normalizeReasoningLabel(candidate.model)
  const existingSlug = normalizeReasoningLabel(existing.model)
  const candidateMatches = idSlug.endsWith(`-${candidate.id}`)
  const existingMatches = existingSlug.endsWith(`-${existing.id}`)
  if (candidateMatches && !existingMatches) {
    group.aliasIds.add(existing.model)
    group.variants.set(candidate.id, candidate)
  } else {
    group.aliasIds.add(candidate.model)
  }
}

/** Derives the backend family base ID from the base row or tier prefixes. */
function deriveBaseId(group: PlannedGroup, variants: PlannedVariant[]): string {
  if (group.baseModelId) return normalizeReasoningLabel(group.baseModelId)
  if (variants.length >= 1) {
    let prefix: string | undefined
    for (const variant of variants) {
      const id = normalizeReasoningLabel(variant.model)
      if (!id.endsWith(`-${variant.id}`)) {
        prefix = undefined
        break
      }
      const candidate = id.slice(0, -(variant.id.length + 1))
      if (prefix === undefined) prefix = candidate
      else if (prefix !== candidate) {
        prefix = undefined
        break
      }
    }
    if (prefix) return prefix
  }
  return normalizeReasoningLabel(group.familyName)
}

/** Picks the tier used when a request selects no variant. */
function pickDefaultTier(variants: PlannedVariant[], thinking: "level" | "budget" | "none"): string | undefined {
  const ids = new Set(variants.map(variant => variant.id))
  const preferred = thinking === "budget"
    ? ["high", "medium", "low", "minimal"]
    : ["low", "medium", "high", "minimal"]
  for (const id of preferred) if (ids.has(id)) return id
  return thinking === "budget" ? variants.at(-1)?.id : variants[0]?.id
}

/**
 * Groups eligible catalog entries into reasoning families.
 *
 * The display name is the primary source of the effort label, so newly added
 * models and renamed efforts work without code changes. Entries that only
 * expose an ID suffix (or omit displayName entirely) still collapse through the
 * legacy suffix fallback. A family collapses only when at least two variants or
 * a real base model exist, so lone IDs keep their own model entry.
 *
 * Registration is opt-in so catalog planning used for eligibility does not
 * replace the request-time registry until the catalog is accepted.
 */
function planCollapsedFamilies(
  entries: Array<[string, AvailableModel]>,
  options: { registerFamilies?: boolean } = {},
): {
  plansByBase: Map<string, CollapsedPlan>
  memberToPlan: Map<string, CollapsedPlan>
} {
  const registerFamilies = options.registerFamilies ?? true;
  const plansByBase = new Map<string, CollapsedPlan>()
  const memberToPlan = new Map<string, CollapsedPlan>()
  const groups = new Map<string, PlannedGroup>()

  entries.forEach(([id, model], order) => {
    const parsed = parseCatalogEntry(id, model, order)
    const group = groups.get(parsed.familyKey) ?? {
      key: parsed.familyKey,
      familyName: parsed.familyName,
      variants: new Map<string, PlannedVariant>(),
      aliasIds: new Set<string>(),
      baseSupportsImages: undefined,
    }
    if (!group.familyName) group.familyName = parsed.familyName
    groups.set(parsed.familyKey, group)
    if (parsed.isBase) addBase(group, parsed)
    else addVariant(group, parsed)
  })

  for (const group of groups.values()) {
    const variantCount = group.variants.size
    if (variantCount === 0) continue

    const variants = [...group.variants.values()].sort(compareVariants)
    // Video/image support is per backend ID. Collapsing members with different
    // image capabilities would either hide images from a capable tier or send
    // images to a text-only one, so keep those members as separate models.
    const imageSupport = new Set<boolean>([
      ...variants.map(variant => variant.supportsImages),
      ...(group.baseSupportsImages === undefined ? [] : [group.baseSupportsImages]),
    ])
    if (imageSupport.size > 1) continue
    // An explicit display-name effort is an unambiguous family member, even
    // when it is the only one advertised. ID-suffix-only catalogs still need
    // two siblings or a real base so lone tier-like IDs keep their own entry.
    const hasDisplayEffort = variants.some(variant => variant.fromDisplay)
    if (variantCount < 2 && !group.baseModelId && !hasDisplayEffort) continue

    const thinking = isBudgetThinkingFamily(group.key)
      ? "budget"
      : isLevelThinkingFamily(group.key)
        ? "level"
        : "none"
    const tiers: Record<string, string> = {}
    const labels: Record<string, string> = {}
    for (const variant of variants) {
      tiers[variant.id] = variant.model
      labels[variant.id] = variant.label
    }

    const baseId = deriveBaseId(group, variants)
    const defaultTier = group.baseModelId ? undefined : pickDefaultTier(variants, thinking)
    const family: CollapsedModelFamily = {
      baseId,
      tiers,
      labels,
      ...(group.baseModelId ? { baseModelId: group.baseModelId } : {}),
      ...(defaultTier ? { defaultTier } : {}),
      thinking,
    }
    if (registerFamilies) registerCollapsedModelFamily(family)

    const memberIds = new Set(variants.map(variant => variant.model))
    for (const alias of group.aliasIds) memberIds.add(alias)
    if (group.baseModelId) memberIds.add(group.baseModelId)
    const firstId = entries.find(([id]) => memberIds.has(id))?.[0] ?? variants[0]?.model
    if (!firstId) continue

    const plan: CollapsedPlan = {
      key: `antigravity-${baseId}`,
      family,
      displayName: group.familyName,
      firstId,
      memberIds: [...memberIds],
    }
    plansByBase.set(group.key, plan)
    plansByBase.set(familyKey(baseId), plan)
    for (const memberId of memberIds) memberToPlan.set(memberId.toLowerCase(), plan)
  }

  return { plansByBase, memberToPlan }
}

/** Builds the single OpenCode entry that represents a collapsed family. */
function collapsedDefinition(plan: CollapsedPlan, models: Map<string, AvailableModel>): OpencodeModelDefinition {
  const known = OPENCODE_MODEL_DEFINITIONS[plan.key]
  const members = plan.memberIds
    .map(id => models.get(id))
    .filter((model): model is AvailableModel => !!model)
  const displayName = plan.displayName || plan.family.baseId
  const limits = members.map(model => ({
    context: model.maxTokens ?? known?.limit.context ?? 200000,
    output: model.maxOutputTokens ?? known?.limit.output ?? 64000,
  }))
  // Image support comes from the concrete dispatch targets (retained tiers and
  // the real base). Discarded aliases stay in the family for grouping but must
  // not narrow a capability that every possible target supports.
  const capabilityIds = new Set<string>(Object.values(plan.family.tiers))
  if (plan.family.baseModelId) capabilityIds.add(plan.family.baseModelId)
  const capabilityMembers = [...capabilityIds]
    .map(id => models.get(id))
    .filter((model): model is AvailableModel => !!model)
  const supportsImages = capabilityMembers.length > 0
    && capabilityMembers.every(model => model.supportsImages !== false)
  return {
    name: `${displayName} (Antigravity)`,
    limit: {
      context: Math.max(...limits.map(limit => limit.context)),
      output: Math.max(...limits.map(limit => limit.output)),
    },
    modalities: { input: supportsImages ? ["text", "image", "pdf"] : ["text"], output: ["text"] },
    variants: collapseVariants(plan.family),
  }
}

/** Builds a standalone OpenCode entry for one catalog model. */
function accountDefinition(id: string, model: AvailableModel): OpencodeModelDefinition {
  const key = `antigravity-${id}`
  const known = OPENCODE_MODEL_DEFINITIONS[key]
  return {
    name: `${model.displayName ?? id} (Antigravity)`,
    limit: {
      context: model.maxTokens ?? known?.limit.context ?? 200000,
      output: model.maxOutputTokens ?? known?.limit.output ?? 64000,
    },
    modalities: { input: model.supportsImages === false ? ["text"] : ["text", "image", "pdf"], output: ["text"] },
    variants: known?.variants,
  }
}

export const OPENCODE_V2_MODEL_DEFINITIONS = Object.fromEntries(
  Object.entries(fallbackModels).map(([id, model]) => [id, definition(model)]),
)
export type V2ModelDefinitions = typeof OPENCODE_V2_MODEL_DEFINITIONS

/**
 * Builds the OpenCode V2 definition map for one account catalog and refreshes
 * the collapsed-family registry from the accepted catalog.
 */
export function buildAccountModelDefinitions(models: Record<string, AvailableModel>): V2ModelDefinitions {
  const entries = eligibleEntries(models)
  resetCollapsedModelFamilies()
  const { memberToPlan } = planCollapsedFamilies(entries)
  const byId = new Map(entries.map(([id, model]) => [id, model]))
  const definitions: V2ModelDefinitions = {}
  const emitted = new Set<string>()

  for (const [id, model] of entries) {
    const plan = memberToPlan.get(id.toLowerCase())
    if (plan) {
      if (plan.firstId !== id || emitted.has(plan.key)) continue
      definitions[plan.key] = definition(collapsedDefinition(plan, byId))
      emitted.add(plan.key)
      continue
    }
    definitions[`antigravity-${id}`] = definition(accountDefinition(id, model))
  }

  registerAdvertisedModelIds(Object.keys(models))
  return definitions
}

/**
 * Collapsed OpenCode model keys an account can use. Members of a family map to
 * the family's collapsed key even when that account only reports one tier.
 */
export function buildAccountModelKeys(
  accountModels: Record<string, AvailableModel>,
  catalogModels: Record<string, AvailableModel> = accountModels,
): string[] {
  const { plansByBase, memberToPlan } = planCollapsedFamilies(eligibleEntries(catalogModels), { registerFamilies: false })
  const keys = new Set<string>()
  for (const [id] of eligibleEntries(accountModels)) {
    const plan = memberToPlan.get(id.toLowerCase()) ?? plansByBase.get(familyKey(id))
    keys.add(plan?.key ?? `antigravity-${id}`)
  }
  return [...keys]
}

/**
 * Rewrites cached per-tier account keys to the current collapsed keys using
 * the cached catalog's grouping. Unknown keys are preserved.
 */
export function normalizeModelAccountKeys(
  accounts: Record<string, string[]>,
  models: Record<string, AvailableModel>,
): Record<string, string[]> {
  const { plansByBase, memberToPlan } = planCollapsedFamilies(eligibleEntries(models), { registerFamilies: false })
  const normalized: Record<string, string[]> = {}
  for (const [key, ids] of Object.entries(accounts)) {
    const backendId = key.replace(/^antigravity-/i, "")
    const plan = memberToPlan.get(backendId.toLowerCase()) ?? plansByBase.get(familyKey(backendId))
    const targetKey = plan?.key ?? key
    const target = normalized[targetKey] ??= []
    for (const id of ids) {
      if (!target.includes(id)) target.push(id)
    }
  }
  return normalized
}
