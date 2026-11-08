/**
 * Model Resolution with Thinking Tier Support
 * 
 * Resolves model names with tier suffixes (e.g., gemini-3-pro-high, claude-opus-4-6-thinking-low)
 * to their actual API model names and corresponding thinking configurations.
 */

import type { ResolvedModel, ThinkingTier, GoogleSearchConfig } from "./types";

export interface ModelResolverOptions {
  cli_first?: boolean;
}

/**
 * Thinking tier budgets by model family.
 * Claude and Gemini 2.5 Pro use numeric budgets.
 */
export const THINKING_TIER_BUDGETS = {
  claude: { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-pro": { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-flash": { low: 6144, medium: 12288, high: 24576 },
  default: { low: 4096, medium: 8192, high: 16384 },
} as const;

/**
 * Gemini 3 uses thinkingLevel strings instead of numeric budgets.
 * Flash supports: minimal, low, medium, high
 * Pro supports: low, high (no minimal/medium)
 */
export const GEMINI_3_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;

/**
 * Model aliases - maps user-friendly names to API model names.
 * 
 * Format:
 * - Gemini 3 Pro variants: gemini-3-pro-{low,medium,high}
 * - Claude thinking variants: claude-{model}-thinking-{low,medium,high}
 * - Claude non-thinking: claude-{model} (no -thinking suffix)
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Gemini 3 variants - for Gemini CLI only (tier stripped, thinkingLevel used)
  // For Antigravity, these are bypassed and full model name is kept
  "gemini-3-pro-low": "gemini-3-pro",
  "gemini-3-pro-high": "gemini-3-pro",
  "gemini-3.1-pro-low": "gemini-3.1-pro",
  "gemini-3.1-pro-high": "gemini-3.1-pro",
  "gemini-3-flash-low": "gemini-3-flash",
  "gemini-3-flash-medium": "gemini-3-flash",
  "gemini-3-flash-high": "gemini-3-flash",

  // Claude proxy names (gemini- prefix for compatibility)
  "gemini-claude-opus-4-6-thinking-low": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-medium": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-high": "claude-opus-4-6-thinking",
  "gemini-claude-sonnet-4-6": "claude-sonnet-4-6",

  // Image generation models - only gemini-3-pro-image is available via Antigravity API
  // Note: gemini-2.5-flash-image (Nano Banana) is NOT supported by Antigravity - only Google AI API
  // Reference: Antigravity-Manager/src-tauri/src/proxy/common/model_mapping.rs
};

/**
 * Model IDs that Antigravity fetchAvailableModels advertises verbatim with a
 * tier-like suffix. The suffix is part of the real model ID, so it must reach the
 * API unchanged instead of being stripped as a legacy thinking-tier alias.
 */
const advertisedModelIds = new Set([
  "claude-opus-5-5-high",
  "claude-sonnet-5-5-high",
  "gemini-4-argon-high",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gpt-oss-120b-medium",
]);
export const ADVERTISED_TIER_SUFFIX_MODEL_IDS: ReadonlySet<string> = advertisedModelIds;

/** Preserve backend IDs discovered from Google's account-specific catalog. */
export function registerAdvertisedModelIds(ids: Iterable<string>): void {
  for (const id of ids) advertisedModelIds.add(id.toLowerCase());
}

const TIER_REGEX = /-(minimal|low|medium|high)$/;
const QUOTA_PREFIX_REGEX = /^antigravity-/i;
const GEMINI_3_PRO_REGEX = /^gemini-3(?:\.\d+)?-pro/i;
const GEMINI_3_FLASH_REGEX = /^gemini-3(?:\.\d+)?-flash/i;

// ANTIGRAVITY_ONLY_MODELS removed - all models now default to antigravity

/**
 * Image generation models - always route to Antigravity.
 * These models don't support thinking and require imageConfig.
 */
const IMAGE_GENERATION_MODELS = /image|imagen/i;

// Legacy LEGACY_ANTIGRAVITY_GEMINI3 regex removed - all Gemini models now default to antigravity

/**
 * Models that support thinking tier suffixes.
 * Only these models should have -low/-medium/-high stripped as thinking tiers.
 * GPT models like gpt-oss-120b-medium should NOT have -medium stripped.
 */
function supportsThinkingTiers(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("gemini-3") ||
    lower.includes("gemini-2.5") ||
    (lower.includes("claude") && lower.includes("thinking"))
  );
}

/**
 * Extracts thinking tier from model name suffix.
 * Only extracts tier for models that support thinking tiers.
 */
function extractThinkingTierFromModel(model: string): ThinkingTier | undefined {
  // Only extract tier for models that support thinking tiers
  if (!supportsThinkingTiers(model)) {
    return undefined;
  }
  const tierMatch = model.match(TIER_REGEX);
  return tierMatch?.[1] as ThinkingTier | undefined;
}

/**
 * Determines the budget family for a model.
 */
function getBudgetFamily(model: string): keyof typeof THINKING_TIER_BUDGETS {
  if (model.includes("claude")) {
    return "claude";
  }
  if (model.includes("gemini-2.5-pro")) {
    return "gemini-2.5-pro";
  }
  if (model.includes("gemini-2.5-flash")) {
    return "gemini-2.5-flash";
  }
  return "default";
}

/**
 * Checks if a model is a thinking-capable model.
 */
function isThinkingCapableModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("thinking") ||
    lower.includes("gemini-3") ||
    lower.includes("gemini-2.5")
  );
}

function isGemini3ProModel(model: string): boolean {
  return GEMINI_3_PRO_REGEX.test(model);
}

function isGemini3FlashModel(model: string): boolean {
  return GEMINI_3_FLASH_REGEX.test(model);
}

/**
 * True for advertised model IDs whose tier-like suffix must not be stripped.
 * Accepts names with or without the "antigravity-" quota prefix.
 */
export function isAdvertisedTierSuffixModel(model: string): boolean {
  return ADVERTISED_TIER_SUFFIX_MODEL_IDS.has(model.replace(QUOTA_PREFIX_REGEX, "").toLowerCase());
}

/**
 * A reasoning tier or effort label advertised by the backend. Standard
 * Gemini/Claude tiers are minimal/low/medium/high, but Google can add or rename
 * efforts, so any slug is accepted.
 */
export type CollapsedModelTier = string;

/** Canonical ordering used when presenting known synthesized variants. */
export const COLLAPSED_MODEL_TIERS: readonly CollapsedModelTier[] = ["minimal", "low", "medium", "high"];

const STANDARD_THINKING_LEVELS = new Set<string>(COLLAPSED_MODEL_TIERS);
const COLLAPSED_TIER_REGEX = /-(minimal|low|medium|high)$/i;

/**
 * Normalizes a display or effort label into a stable slug:
 * "Extra Low" -> "extra-low", "Max" -> "max".
 */
export function normalizeReasoningLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .replace(/-+/g, "-");
}

/** Parenthetical labels that describe the model, not a reasoning effort. */
const NON_EFFORT_LABELS = new Set([
  "thinking",
  "preview",
  "custom-tools",
  "customtools",
  "image",
  "video",
  "lite",
  "agent",
  "experimental",
  "deprecated",
  "legacy",
  "tiered",
  "disabled",
]);

export interface DisplayReasoningLabel {
  /** Family display name with the effort suffix removed. */
  familyName: string;
  /** Effort label exactly as shown by the backend. */
  label: string;
  /** Variant id slug derived from the label. */
  id: string;
}

/**
 * Extracts the reasoning effort from a backend display name. Google advertises
 * tiers as a trailing parenthetical, e.g. "Gemini 3.8 Flash (High)". The label
 * is authoritative: the backend ID may not match it.
 */
export function parseDisplayReasoning(displayName: string | undefined): DisplayReasoningLabel | undefined {
  const name = displayName?.trim();
  if (!name) return undefined;
  const match = name.match(/^(.*?)\s*[\(\[]\s*([^()\[\]]{1,40})\s*[\)\]]\s*$/);
  if (!match) return undefined;
  const familyName = match[1]?.trim();
  const label = match[2]?.trim();
  if (!familyName || !label) return undefined;
  const id = normalizeReasoningLabel(label);
  if (!id || NON_EFFORT_LABELS.has(id)) return undefined;
  return { familyName, label, id };
}

/**
 * A backend model family whose thinking tiers are advertised as separate model
 * IDs (for example gemini-3.8-flash-low/medium/high). OpenCode presents the
 * family as one model with variants, and requests are retargeted to the
 * concrete backend ID at request time.
 */
export interface CollapsedModelFamily {
  /** Backend model ID without the tier suffix and without the antigravity- prefix. */
  baseId: string;
  /** Concrete backend model ID per effort slug. */
  tiers: Record<string, string>;
  /** Effort label shown by the backend per slug, e.g. "Extra Low". */
  labels?: Record<string, string>;
  /** Real backend ID for the base model, when one exists. */
  baseModelId?: string;
  /** Tier used when a request has no explicit variant. */
  defaultTier?: CollapsedModelTier;
  /**
   * How tiers are expressed: Gemini thinkingLevel, a numeric thinkingBudget, or
   * "none" when the backend ID already encodes the effort.
   */
  thinking?: "level" | "budget" | "none";
}

const collapsedFamilies = new Map<string, CollapsedModelFamily>();
const collapsedMembersByBase = new Map<string, Set<string>>();
const collapsedMemberIndex = new Map<string, { baseId: string; tier: CollapsedModelTier }>();

/**
 * Returns the thinking tier encoded in a model ID suffix, but only when the
 * suffix is semantically a thinking tier. IDs such as gpt-oss-120b-medium keep
 * their suffix as part of the real model name.
 */
export function getThinkingTierSuffix(model: string): { baseId: string; tier: CollapsedModelTier } | undefined {
  const withoutQuota = model.replace(QUOTA_PREFIX_REGEX, "");
  if (!supportsThinkingTiers(withoutQuota)) return undefined;
  const match = withoutQuota.match(COLLAPSED_TIER_REGEX);
  const tier = match?.[1]?.toLowerCase();
  if (!match || !tier) return undefined;
  return {
    baseId: withoutQuota.slice(0, -match[0].length),
    tier: tier as CollapsedModelTier,
  };
}

/**
 * Registers (or replaces) a collapsed family. Registration is additive so a
 * cached catalog can keep resolving requests until a fresh discovery replaces
 * the family.
 */
export function registerCollapsedModelFamily(family: CollapsedModelFamily): void {
  const key = family.baseId.toLowerCase();
  const previous = collapsedMembersByBase.get(key);
  if (previous) {
    for (const member of previous) collapsedMemberIndex.delete(member);
  }
  collapsedFamilies.set(key, family);
  const members = new Set<string>();
  for (const tier of Object.keys(family.tiers)) {
    const id = family.tiers[tier];
    if (!id) continue;
    const lower = id.toLowerCase();
    members.add(lower);
    collapsedMemberIndex.set(lower, { baseId: family.baseId, tier });
  }
  collapsedMembersByBase.set(key, members);
}

/**
 * Returns the collapsed family base ID for a base or tiered backend model ID.
 */
export function getCollapsedModelBaseId(model: string): string | undefined {
  const normalized = model.replace(QUOTA_PREFIX_REGEX, "").toLowerCase();
  const direct = collapsedFamilies.get(normalized);
  if (direct) return direct.baseId;
  return collapsedMemberIndex.get(normalized)?.baseId;
}

export interface CollapsedModelTarget {
  /** Concrete backend model ID to send to Antigravity. */
  model: string;
  /** Gemini thinking level implied by the selected tier. */
  thinkingLevel?: string;
  /** Numeric thinking budget implied by the selected tier. */
  thinkingBudget?: number;
}

function isBudgetThinkingFamily(baseId: string): boolean {
  const lower = baseId.toLowerCase();
  return lower.includes("claude") || lower.includes("gemini-2.5");
}

function standardThinkingLevel(tier: string): string | undefined {
  const normalized = tier.trim().toLowerCase();
  return STANDARD_THINKING_LEVELS.has(normalized) ? normalized : undefined;
}

function collapsedThinkingConfig(
  family: CollapsedModelFamily,
  tier: CollapsedModelTier,
): Pick<CollapsedModelTarget, "thinkingLevel" | "thinkingBudget"> {
  const mode = family.thinking ?? (isBudgetThinkingFamily(family.baseId) ? "budget" : "level");
  if (mode === "none") return {};
  if (mode === "budget") {
    const budget = getThinkingTierBudget(family.baseId, tier);
    return budget === undefined ? {} : { thinkingBudget: budget };
  }
  // New or renamed efforts ride on the wire model ID; only send a level the
  // Antigravity API understands.
  const level = standardThinkingLevel(tier);
  return level ? { thinkingLevel: level } : {};
}

/**
 * Numeric budget for a tier, using the same family budgets as tier suffixes.
 * Returns undefined for effort labels the budget table does not know.
 */
export function getThinkingTierBudget(model: string, tier: CollapsedModelTier): number | undefined {
  const normalized = tier.trim().toLowerCase();
  const key = normalized === "minimal" ? "low" : normalized;
  if (key !== "low" && key !== "medium" && key !== "high") return undefined;
  const budgets = THINKING_TIER_BUDGETS[getBudgetFamily(model)];
  return budgets[key];
}

function budgetToCollapsedTier(budget: number): CollapsedModelTier {
  if (budget <= 8192) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

function matchCollapsedVariant(family: CollapsedModelFamily, value: string): string | undefined {
  const normalized = normalizeReasoningLabel(value);
  if (!normalized) return undefined;
  if (family.tiers[normalized]) return normalized;
  for (const [id, label] of Object.entries(family.labels ?? {})) {
    if (normalizeReasoningLabel(label) === normalized) return id;
  }
  return normalized;
}

/**
 * Maps a collapsed OpenCode model (plus the selected variant's thinking
 * configuration) to the concrete backend model ID and tier.
 *
 * Explicit variant config wins. Otherwise a requested tier suffix is
 * preserved, then a real backend base ID is preferred, and finally the
 * family's default tier is used.
 */
export function resolveCollapsedModelTarget(
  requestedModel: string,
  variant?: { thinkingLevel?: string; thinkingBudget?: number },
): CollapsedModelTarget | undefined {
  const normalized = requestedModel.replace(QUOTA_PREFIX_REGEX, "").toLowerCase();
  const direct = collapsedFamilies.get(normalized);
  const member = collapsedMemberIndex.get(normalized);
  const family = direct ?? (member ? collapsedFamilies.get(member.baseId.toLowerCase()) : undefined);
  if (!family) return undefined;

  const available = (tier: CollapsedModelTier) => family.tiers[tier] !== undefined;
  const ordered = Object.keys(family.tiers);
  const defaultTier = family.defaultTier && available(family.defaultTier)
    ? family.defaultTier
    : ordered[0];
  let tier: CollapsedModelTier | undefined;

  if (variant?.thinkingLevel) {
    const candidate = matchCollapsedVariant(family, variant.thinkingLevel);
    if (candidate && available(candidate)) tier = candidate;
  }
  if (!tier && typeof variant?.thinkingBudget === "number") {
    const candidate = budgetToCollapsedTier(variant.thinkingBudget);
    if (available(candidate)) tier = candidate;
  }
  if (!tier && member) tier = member.tier;

  if (!tier) {
    if (family.baseModelId) return { model: family.baseModelId };
    tier = defaultTier;
  }
  if (!tier) return undefined;

  const tierId = family.tiers[tier];
  if (tierId) {
    return { model: tierId, ...collapsedThinkingConfig(family, tier) };
  }
  if (family.baseModelId) {
    return { model: family.baseModelId, ...collapsedThinkingConfig(family, tier) };
  }
  if (defaultTier) {
    const fallbackId = family.tiers[defaultTier];
    if (fallbackId) {
      return { model: fallbackId, ...collapsedThinkingConfig(family, defaultTier) };
    }
  }
  return undefined;
}

/**
 * Resolves a model name with optional tier suffix and quota prefix to its actual API model name
 * and corresponding thinking configuration.
 *
 * Quota routing:
 * - Default to Antigravity quota unless cli_first is enabled for Gemini models
 * - Fallback to Gemini CLI happens at account rotation level when Antigravity is exhausted
 * - "antigravity-" prefix marks explicit quota (no fallback allowed)
 * - Claude and image models always use Antigravity
 *
 * Examples:
 * - "gemini-2.5-flash" → { quotaPreference: "antigravity" }
 * - "gemini-3-pro-preview" → { quotaPreference: "antigravity" }
 * - "antigravity-gemini-3-pro-high" → { quotaPreference: "antigravity", explicitQuota: true }
 * - "claude-opus-4-6-thinking-medium" → { quotaPreference: "antigravity" }
 *
 * @param requestedModel - The model name from the request
 * @param options - Optional configuration including cli_first preference
 * @returns Resolved model with thinking configuration
 */
export function resolveModelWithTier(requestedModel: string, options: ModelResolverOptions = {}): ResolvedModel {
  const isAntigravity = QUOTA_PREFIX_REGEX.test(requestedModel);
  const modelWithoutQuota = requestedModel.replace(QUOTA_PREFIX_REGEX, "");

  const isAdvertisedTierId = isAdvertisedTierSuffixModel(modelWithoutQuota);

  const tier = extractThinkingTierFromModel(modelWithoutQuota);
  // Advertised IDs keep their suffix; it still selects the thinking level below.
  const baseName = tier && !isAdvertisedTierId ? modelWithoutQuota.replace(TIER_REGEX, "") : modelWithoutQuota;

  const isImageModel = IMAGE_GENERATION_MODELS.test(modelWithoutQuota);
  const isClaudeModel = modelWithoutQuota.toLowerCase().includes("claude");
  
  // All models default to Antigravity quota unless cli_first is enabled
  // Fallback to gemini-cli happens at the account rotation level when Antigravity is exhausted
  const preferGeminiCli = options.cli_first === true && !isAntigravity && !isImageModel && !isClaudeModel;
  const quotaPreference = preferGeminiCli ? "gemini-cli" as const : "antigravity" as const;
  const explicitQuota = isAntigravity || isImageModel;

  const isGemini3 = modelWithoutQuota.toLowerCase().startsWith("gemini-3");
  const skipAlias = isAntigravity && isGemini3;

  // For Antigravity Gemini 3 Pro models without explicit tier, append default tier
  // Antigravity API: gemini-3-pro requires tier suffix (gemini-3-pro-low/high)
  //                  gemini-3-flash uses bare name + thinkingLevel param
  // Pro defaults to -low unless an explicit tier is provided
  const isGemini3Pro = isGemini3ProModel(modelWithoutQuota);
  const isGemini3Flash = isGemini3FlashModel(modelWithoutQuota);
  
  let antigravityModel = modelWithoutQuota;
  if (skipAlias && !isAdvertisedTierId) {
    if (isGemini3Pro && !tier && !isImageModel) {
      antigravityModel = `${modelWithoutQuota}-low`;
    } else if (isGemini3Flash && tier) {
      antigravityModel = baseName;
    }
  }

  const actualModel = skipAlias || isAdvertisedTierId
    ? antigravityModel
    : MODEL_ALIASES[modelWithoutQuota] || MODEL_ALIASES[baseName] || baseName;

  const resolvedModel = actualModel;

  const isThinking = isThinkingCapableModel(resolvedModel);

  // Image generation models don't support thinking - return early without thinking config
  if (isImageModel) {
    return {
      actualModel: resolvedModel,
      isThinkingModel: false,
      isImageModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  // Check if this is a Gemini 3 model (works for both aliased and skipAlias paths)
  const isEffectiveGemini3 = resolvedModel.toLowerCase().includes("gemini-3");
  const isClaudeThinking = resolvedModel.toLowerCase().includes("claude") && resolvedModel.toLowerCase().includes("thinking");

  if (!tier) {
    // Gemini 3 models without explicit tier get a default thinkingLevel
    if (isEffectiveGemini3) {
      return {
        actualModel: resolvedModel,
        thinkingLevel: "low",
        isThinkingModel: true,
        quotaPreference,
        explicitQuota,
      };
    }
    // Claude thinking models without explicit tier get max budget (32768)
    // Per Anthropic docs, budget_tokens is required when enabling extended thinking
    if (isClaudeThinking) {
      return {
        actualModel: resolvedModel,
        thinkingBudget: THINKING_TIER_BUDGETS.claude.high,
        isThinkingModel: true,
        quotaPreference,
        explicitQuota,
      };
    }
    return { actualModel: resolvedModel, isThinkingModel: isThinking, quotaPreference, explicitQuota };
  }

  // Gemini 3 models with tier always get thinkingLevel set
  if (isEffectiveGemini3) {
    return {
      actualModel: resolvedModel,
      thinkingLevel: tier,
      tier,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  const budgetFamily = getBudgetFamily(resolvedModel);
  const budgets = THINKING_TIER_BUDGETS[budgetFamily];
  const thinkingBudget = budgets[tier];

  return {
    actualModel: resolvedModel,
    thinkingBudget,
    tier,
    isThinkingModel: isThinking,
    quotaPreference,
    explicitQuota,
  };
}

/**
 * Gets the model family for routing decisions.
 */
export function getModelFamily(model: string): "claude" | "gemini-flash" | "gemini-pro" {
  const lower = model.toLowerCase();
  if (lower.includes("claude")) {
    return "claude";
  }
  if (lower.includes("flash")) {
    return "gemini-flash";
  }
  return "gemini-pro";
}

/**
 * Variant config from OpenCode's providerOptions.
 */
export interface VariantConfig {
  thinkingBudget?: number;
  googleSearch?: GoogleSearchConfig;
}

/**
 * Maps a thinking budget to Gemini 3 thinking level.
 * ≤8192 → low, ≤16384 → medium, >16384 → high
 */
function budgetToGemini3Level(budget: number): "low" | "medium" | "high" {
  if (budget <= 8192) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

/**
 * Resolves model name for a specific headerStyle (quota fallback support).
 * Transforms model names when switching between gemini-cli and antigravity quotas.
 * 
 * Issue #103: When quota fallback occurs, model names need to be transformed:
 * - gemini-3-flash-preview (gemini-cli) → gemini-3-flash (antigravity)
 * - gemini-3-pro-preview (gemini-cli) → gemini-3-pro-low (antigravity)
 * - gemini-3-flash (antigravity) → gemini-3-flash-preview (gemini-cli)
 */
export function resolveModelForHeaderStyle(
  requestedModel: string,
  headerStyle: "antigravity" | "gemini-cli"
): ResolvedModel {
  const lower = requestedModel.toLowerCase();
  const isGemini3 = lower.includes("gemini-3");
  
  if (!isGemini3) {
    return resolveModelWithTier(requestedModel);
  }

  if (headerStyle === "antigravity") {
    let transformedModel = requestedModel
      .replace(/-preview-customtools$/i, "")
      .replace(/-preview$/i, "")
      .replace(/^antigravity-/i, "");
    
    const isGemini3Pro = isGemini3ProModel(transformedModel);
    const hasTierSuffix = /-(low|medium|high)$/i.test(transformedModel);
    const isImageModel = IMAGE_GENERATION_MODELS.test(transformedModel);
    
    // Don't add tier suffix to image models - they don't support thinking
    if (isGemini3Pro && !hasTierSuffix && !isImageModel) {
      transformedModel = `${transformedModel}-low`;
    }
    
    const prefixedModel = `antigravity-${transformedModel}`;
    return resolveModelWithTier(prefixedModel);
  }
  
  if (headerStyle === "gemini-cli") {
    let transformedModel = requestedModel
      .replace(/^antigravity-/i, "")
      .replace(/-(low|medium|high)$/i, "");

    const hasPreviewSuffix = /-preview($|-)/i.test(transformedModel);
    if (!hasPreviewSuffix) {
      transformedModel = `${transformedModel}-preview`;
    }
    
    return {
      ...resolveModelWithTier(transformedModel),
      quotaPreference: "gemini-cli",
    };
  }

  return resolveModelWithTier(requestedModel);
}

/**
 * Resolves model with variant config from providerOptions.
 * Variant config takes priority over tier suffix in model name.
 */
export function resolveModelWithVariant(
  requestedModel: string,
  variantConfig?: VariantConfig
): ResolvedModel {
  const base = resolveModelWithTier(requestedModel);

  if (!variantConfig) {
    return base;
  }

  // Apply Google Search config if present
  if (variantConfig.googleSearch) {
    base.googleSearch = variantConfig.googleSearch;
    base.configSource = "variant";
  }

  if (!variantConfig.thinkingBudget) {
    return base;
  }

  const budget = variantConfig.thinkingBudget;
  const isGemini3 = base.actualModel.toLowerCase().includes("gemini-3");

  if (isGemini3) {
    const level = budgetToGemini3Level(budget);
    const isAntigravityGemini3Pro = base.quotaPreference === "antigravity" &&
      isGemini3ProModel(base.actualModel) &&
      !isAdvertisedTierSuffixModel(base.actualModel);

    let actualModel = base.actualModel;
    if (isAntigravityGemini3Pro) {
      const baseModel = base.actualModel.replace(/-(low|medium|high)$/, "");
      actualModel = `${baseModel}-${level}`;
    }

    return {
      ...base,
      actualModel,
      thinkingLevel: level,
      thinkingBudget: undefined,
      configSource: "variant",
    };
  }

  return {
    ...base,
    thinkingBudget: budget,
    configSource: "variant",
  };
}
