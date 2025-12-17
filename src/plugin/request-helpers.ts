const ANTIGRAVITY_PREVIEW_LINK = "https://goo.gle/enable-preview-features"; // TODO: Update to Antigravity link if available

export interface AntigravityApiError {
  code?: number;
  message?: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * Minimal representation of Antigravity API responses we touch.
 */
export interface AntigravityApiBody {
  response?: unknown;
  error?: AntigravityApiError;
  [key: string]: unknown;
}

/**
 * Usage metadata exposed by Antigravity responses. Fields are optional to reflect partial payloads.
 */
export interface AntigravityUsageMetadata {
  totalTokenCount?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

/**
 * Valid thinking levels for Gemini 3 models.
 * - Gemini 3 Pro: "low", "high"
 * - Gemini 3 Flash: "minimal", "low", "medium", "high"
 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

/**
 * Normalized thinking configuration accepted by Antigravity.
 */
export interface ThinkingConfig {
  thinkingBudget?: number;
  thinkingLevel?: ThinkingLevel;
  includeThoughts?: boolean;
}

/**
 * Default token budget for thinking/reasoning. 16000 tokens provides sufficient
 * space for complex reasoning while staying within typical model limits.
 */
export const DEFAULT_THINKING_BUDGET = 16000;

/**
 * Checks if a model is a Gemini 3 model.
 */
export function isGemini3Model(modelName: string): boolean {
  return /gemini-3/i.test(modelName);
}

/**
 * Checks if a model is a Gemini 2.5 model.
 */
export function isGemini25Model(modelName: string): boolean {
  return /gemini-2\.5/i.test(modelName);
}

/**
 * Checks if a model is specifically Gemini 3 Pro (supports only "low" and "high" levels).
 */
export function isGemini3ProModel(modelName: string): boolean {
  return /gemini-3[^a-z]*pro/i.test(modelName);
}

/**
 * Checks if a model is specifically Gemini 3 Flash (supports all thinking levels).
 */
export function isGemini3FlashModel(modelName: string): boolean {
  return /gemini-3[^a-z]*flash/i.test(modelName);
}

/**
 * Checks if a model name indicates thinking/reasoning capability.
 * Models with "thinking", "gemini-3", "gemini-2.5", or "opus" in their name support extended thinking.
 */
export function isThinkingCapableModel(modelName: string): boolean {
  const lowerModel = modelName.toLowerCase();
  return lowerModel.includes("thinking")
    || lowerModel.includes("gemini-3")
    || lowerModel.includes("gemini-2.5")
    || lowerModel.includes("opus");
}

/**
 * Extracts thinking configuration from various possible request locations.
 * Supports both Gemini-style thinkingConfig and Anthropic-style thinking options.
 */
export function extractThinkingConfig(
  requestPayload: Record<string, unknown>,
  rawGenerationConfig: Record<string, unknown> | undefined,
  extraBody: Record<string, unknown> | undefined,
): ThinkingConfig | undefined {
  const thinkingConfig = rawGenerationConfig?.thinkingConfig
    ?? extraBody?.thinkingConfig
    ?? requestPayload.thinkingConfig;

  if (thinkingConfig && typeof thinkingConfig === "object") {
    const config = thinkingConfig as Record<string, unknown>;
    const result: ThinkingConfig = {};

    // Extract thinkingLevel (for Gemini 3)
    if (typeof config.thinkingLevel === "string") {
      result.thinkingLevel = config.thinkingLevel.toLowerCase() as ThinkingLevel;
    }

    // Extract thinkingBudget (for Gemini 2.5 and backward compat)
    if (typeof config.thinkingBudget === "number") {
      result.thinkingBudget = config.thinkingBudget;
    }

    // Extract includeThoughts
    if (typeof config.includeThoughts === "boolean") {
      result.includeThoughts = config.includeThoughts;
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  // Convert Anthropic-style "thinking" option: { type: "enabled", budgetTokens: N }
  const anthropicThinking = extraBody?.thinking ?? requestPayload.thinking;
  if (anthropicThinking && typeof anthropicThinking === "object") {
    const thinking = anthropicThinking as Record<string, unknown>;
    if (thinking.type === "enabled" || thinking.budgetTokens) {
      return {
        includeThoughts: true,
        thinkingBudget: typeof thinking.budgetTokens === "number" ? thinking.budgetTokens : DEFAULT_THINKING_BUDGET,
      };
    }
  }

  return undefined;
}

/** Valid thinking levels for Gemini 3 Pro models. */
const GEMINI_3_PRO_LEVELS: ThinkingLevel[] = ["low", "high"];

/** Valid thinking levels for Gemini 3 Flash models (supports all levels). */
const GEMINI_3_FLASH_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high"];

/**
 * Validates thinking configuration for the given model.
 * Logs a warning and removes invalid thinkingLevel values.
 */
function validateThinkingConfig(
  modelName: string,
  config: ThinkingConfig,
): ThinkingConfig {
  const result: ThinkingConfig = { ...config };

  // Validate thinkingLevel for Gemini 3 models
  if (result.thinkingLevel && isGemini3Model(modelName)) {
    const validLevels = isGemini3ProModel(modelName)
      ? GEMINI_3_PRO_LEVELS
      : GEMINI_3_FLASH_LEVELS;

    if (!validLevels.includes(result.thinkingLevel)) {
      console.warn(
        `[opencode-antigravity-auth] Invalid thinkingLevel "${result.thinkingLevel}" ` +
        `for ${modelName}. Valid: ${validLevels.join(", ")}. Using API default.`
      );
      delete result.thinkingLevel;
    }
  }

  return result;
}

/**
 * Determines the final thinking configuration based on model capabilities and user settings.
 * For Claude thinking models, we keep thinking enabled even in multi-turn conversations.
 * The filterUnsignedThinkingBlocks function will handle signature validation/restoration.
 * For Gemini 3/2.5 models, we don't apply defaults - let the API decide.
 */
export function resolveThinkingConfig(
  userConfig: ThinkingConfig | undefined,
  modelName: string,
  _isClaudeModel: boolean,
  _hasAssistantHistory: boolean,
): ThinkingConfig | undefined {
  // If user provided config, validate and pass it through.
  if (userConfig) {
    const validated = validateThinkingConfig(modelName, userConfig);
    if (!isGemini3Model(modelName) && !isGemini25Model(modelName)) {
      if (validated.includeThoughts && validated.thinkingBudget === undefined) {
        return { ...validated, thinkingBudget: DEFAULT_THINKING_BUDGET };
      }
    }
    return validated;
  }

  // For Gemini 3/2.5: DON'T apply defaults - let OpenCode/API decide.
  if (isGemini3Model(modelName) || isGemini25Model(modelName)) {
    return undefined;
  }

  // For other thinking models (Claude Opus), keep existing default behavior.
  if (isThinkingCapableModel(modelName)) {
    return { includeThoughts: true, thinkingBudget: DEFAULT_THINKING_BUDGET };
  }

  return undefined;
}

/**
 * Checks if a part is a thinking/reasoning block (Anthropic or Gemini style).
 */
function isThinkingPart(part: Record<string, unknown>): boolean {
  return part.type === "thinking"
    || part.type === "reasoning"
    || part.thinking !== undefined
    || part.thought === true;
}

/**
 * Removes trailing thinking blocks from a content array.
 * Claude API requires that assistant messages don't end with thinking blocks.
 * Only removes unsigned thinking blocks; preserves those with valid signatures.
 */
function removeTrailingThinkingBlocks(contentArray: any[]): any[] {
  const result = [...contentArray];
  while (result.length > 0 && isThinkingPart(result[result.length - 1]) && !hasValidSignature(result[result.length - 1])) {
    result.pop();
  }
  return result;
}

/**
 * Checks if a thinking part has a valid signature.
 * A valid signature is a non-empty string with at least 50 characters.
 */
function hasValidSignature(part: Record<string, unknown>): boolean {
  const signature = part.thought === true ? part.thoughtSignature : part.signature;
  return typeof signature === "string" && signature.length >= 50;
}

/**
 * Gets the text content from a thinking part.
 */
function getThinkingText(part: Record<string, unknown>): string {
  if (typeof part.text === "string") return part.text;
  if (typeof part.thinking === "string") return part.thinking;

  // Some SDKs wrap thinking in an object like { text: "...", cache_control: {...} }
  if (part.thinking && typeof part.thinking === "object") {
    const maybeText = (part.thinking as any).text ?? (part.thinking as any).thinking;
    if (typeof maybeText === "string") return maybeText;
  }

  return "";
}

/**
 * Recursively strips cache_control and providerOptions from any object.
 * These fields can be injected by SDKs, but Claude rejects them inside thinking blocks.
 */
function stripCacheControlRecursively(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(item => stripCacheControlRecursively(item));

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === "cache_control" || key === "providerOptions") continue;
    result[key] = stripCacheControlRecursively(value);
  }
  return result;
}

/**
 * Sanitizes a thinking part by keeping only the allowed fields.
 * In particular, ensures `thinking` is a string (not an object with cache_control).
 */
function sanitizeThinkingPart(part: Record<string, unknown>): Record<string, unknown> {
  // Gemini-style thought blocks: { thought: true, text, thoughtSignature }
  if (part.thought === true) {
    const sanitized: Record<string, unknown> = { thought: true };

    if (part.text !== undefined) {
      // If text is wrapped, extract the inner string.
      if (typeof part.text === "object" && part.text !== null) {
        const maybeText = (part.text as any).text;
        sanitized.text = typeof maybeText === "string" ? maybeText : part.text;
      } else {
        sanitized.text = part.text;
      }
    }

    if (part.thoughtSignature !== undefined) sanitized.thoughtSignature = part.thoughtSignature;
    return sanitized;
  }

  // Anthropic-style thinking blocks: { type: "thinking", thinking, signature }
  if (part.type === "thinking" || part.thinking !== undefined) {
    const sanitized: Record<string, unknown> = { type: "thinking" };

    let thinkingContent: unknown = part.thinking ?? part.text;
    if (thinkingContent !== undefined && typeof thinkingContent === "object" && thinkingContent !== null) {
      const maybeText = (thinkingContent as any).text ?? (thinkingContent as any).thinking;
      thinkingContent = typeof maybeText === "string" ? maybeText : "";
    }

    if (thinkingContent !== undefined) sanitized.thinking = thinkingContent;
    if (part.signature !== undefined) sanitized.signature = part.signature;
    return sanitized;
  }

  // Fallback: strip cache_control recursively.
  return stripCacheControlRecursively(part) as Record<string, unknown>;
}

function filterContentArray(
  contentArray: any[],
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
): any[] {
  const filtered: any[] = [];

  for (const item of contentArray) {
    if (!item || typeof item !== "object") {
      filtered.push(item);
      continue;
    }

    if (!isThinkingPart(item)) {
      filtered.push(item);
      continue;
    }

    if (hasValidSignature(item)) {
      filtered.push(sanitizeThinkingPart(item));
      continue;
    }

    if (sessionId && getCachedSignatureFn) {
      const text = getThinkingText(item);
      if (text) {
        const cachedSignature = getCachedSignatureFn(sessionId, text);
        if (cachedSignature && cachedSignature.length >= 50) {
          const restoredPart = { ...item };
          if ((item as any).thought === true) {
            (restoredPart as any).thoughtSignature = cachedSignature;
          } else {
            (restoredPart as any).signature = cachedSignature;
          }
          filtered.push(sanitizeThinkingPart(restoredPart as Record<string, unknown>));
          continue;
        }
      }
    }

    // Drop unsigned/invalid thinking blocks.
  }

  return filtered;
}

/**
 * Filters out unsigned thinking blocks from contents (required by Claude API).
 * Attempts to restore signatures from cache for thinking blocks that lack valid signatures.
 * 
 * @param contents - The contents array from the request
 * @param sessionId - Optional session ID for signature cache lookup
 * @param getCachedSignatureFn - Optional function to retrieve cached signatures
 */
export function filterUnsignedThinkingBlocks(
  contents: any[],
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
): any[] {
  return contents.map((content: any) => {
    if (!content || typeof content !== "object") {
      return content;
    }

    // Gemini format: contents[].parts[]
    if (Array.isArray((content as any).parts)) {
      let filteredParts = filterContentArray((content as any).parts, sessionId, getCachedSignatureFn);

      // Remove trailing thinking blocks for model role (assistant equivalent in Gemini)
      if ((content as any).role === "model") {
        filteredParts = removeTrailingThinkingBlocks(filteredParts);
      }

      return { ...content, parts: filteredParts };
    }

    // Some Anthropic-style payloads may appear here as contents[].content[]
    if (Array.isArray((content as any).content)) {
      let filteredContent = filterContentArray((content as any).content, sessionId, getCachedSignatureFn);

      // Claude API requires assistant messages don't end with thinking blocks
      if ((content as any).role === "assistant") {
        filteredContent = removeTrailingThinkingBlocks(filteredContent);
      }

      return { ...content, content: filteredContent };
    }

    return content;
  });
}

/**
 * Filters thinking blocks from Anthropic-style messages[] payloads.
 */
export function filterMessagesThinkingBlocks(
  messages: any[],
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
): any[] {
  return messages.map((message: any) => {
    if (!message || typeof message !== "object") {
      return message;
    }

    if (Array.isArray((message as any).content)) {
      let filteredContent = filterContentArray((message as any).content, sessionId, getCachedSignatureFn);

      // Claude API requires assistant messages don't end with thinking blocks
      if ((message as any).role === "assistant") {
        filteredContent = removeTrailingThinkingBlocks(filteredContent);
      }

      return { ...message, content: filteredContent };
    }

    return message;
  });
}

/**
 * Transforms Gemini-style thought parts (thought: true) and Anthropic-style
 * thinking parts (type: "thinking") to reasoning format.
 * Claude responses through Antigravity may use candidates structure with Anthropic-style parts.
 */
function transformGeminiCandidate(candidate: any): any {
  if (!candidate || typeof candidate !== "object") {
    return candidate;
  }

  const content = candidate.content;
  if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
    return candidate;
  }

  const thinkingTexts: string[] = [];
  const transformedParts = content.parts.map((part: any) => {
    if (!part || typeof part !== "object") {
      return part;
    }

    // Handle Gemini-style: thought: true
    if (part.thought === true) {
      thinkingTexts.push(part.text || "");
      return { ...part, type: "reasoning" };
    }

    // Handle Anthropic-style in candidates: type: "thinking"
    if (part.type === "thinking") {
      const thinkingText = part.thinking || part.text || "";
      thinkingTexts.push(thinkingText);
      return {
        ...part,
        type: "reasoning",
        text: thinkingText,
        thought: true,
      };
    }

    return part;
  });

  return {
    ...candidate,
    content: { ...content, parts: transformedParts },
    ...(thinkingTexts.length > 0 ? { reasoning_content: thinkingTexts.join("\n\n") } : {}),
  };
}

/**
 * Transforms thinking/reasoning content in response parts to OpenCode's expected format.
 * Handles both Gemini-style (thought: true) and Anthropic-style (type: "thinking") formats.
 * Also extracts reasoning_content for Anthropic-style responses.
 */
export function transformThinkingParts(response: unknown): unknown {
  if (!response || typeof response !== "object") {
    return response;
  }

  const resp = response as Record<string, unknown>;
  const result: Record<string, unknown> = { ...resp };
  const reasoningTexts: string[] = [];

  // Handle Anthropic-style content array (type: "thinking")
  if (Array.isArray(resp.content)) {
    const transformedContent: any[] = [];
    for (const block of resp.content) {
      if (block && typeof block === "object" && (block as any).type === "thinking") {
        const thinkingText = (block as any).thinking || (block as any).text || "";
        reasoningTexts.push(thinkingText);
        transformedContent.push({
          ...block,
          type: "reasoning",
          text: thinkingText,
          thought: true,
        });
      } else {
        transformedContent.push(block);
      }
    }
    result.content = transformedContent;
  }

  // Handle Gemini-style candidates array
  if (Array.isArray(resp.candidates)) {
    result.candidates = resp.candidates.map(transformGeminiCandidate);
  }

  // Add reasoning_content if we found any thinking blocks (for Anthropic-style)
  if (reasoningTexts.length > 0 && !result.reasoning_content) {
    result.reasoning_content = reasoningTexts.join("\n\n");
  }

  return result;
}

/**
 * Normalizes a thinkingConfig object, supporting both camelCase and snake_case.
 * Handles thinkingLevel (for Gemini 3) and thinkingBudget (for Gemini 2.5).
 */
export function normalizeThinkingConfig(config: unknown): ThinkingConfig | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const record = config as Record<string, unknown>;

  // Support both camelCase and snake_case
  const budgetRaw = record.thinkingBudget ?? record.thinking_budget;
  const levelRaw = record.thinkingLevel ?? record.thinking_level;
  const includeRaw = record.includeThoughts ?? record.include_thoughts;

  const thinkingBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : undefined;
  const thinkingLevel = typeof levelRaw === "string" ? levelRaw.toLowerCase() as ThinkingLevel : undefined;
  const includeThoughts = typeof includeRaw === "boolean" ? includeRaw : undefined;

  const enableThinking = (thinkingBudget !== undefined && thinkingBudget > 0) || thinkingLevel !== undefined;
  let finalInclude = includeThoughts;

  if (thinkingBudget !== undefined && thinkingBudget <= 0 && thinkingLevel === undefined) {
    finalInclude = false;
  }

  if (
    !enableThinking
    && finalInclude === undefined
    && thinkingBudget === undefined
    && thinkingLevel === undefined
    && includeThoughts === undefined
  ) {
    return undefined;
  }

  const normalized: ThinkingConfig = {};
  if (thinkingBudget !== undefined) {
    normalized.thinkingBudget = thinkingBudget;
  }
  if (thinkingLevel !== undefined) {
    normalized.thinkingLevel = thinkingLevel;
  }
  if (finalInclude !== undefined) {
    normalized.includeThoughts = finalInclude;
  }
  return normalized;
}

/**
 * Parses an Antigravity API body; handles array-wrapped responses the API sometimes returns.
 */
export function parseAntigravityApiBody(rawText: string): AntigravityApiBody | null {
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      const firstObject = parsed.find((item: unknown) => typeof item === "object" && item !== null);
      if (firstObject && typeof firstObject === "object") {
        return firstObject as AntigravityApiBody;
      }
      return null;
    }

    if (parsed && typeof parsed === "object") {
      return parsed as AntigravityApiBody;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts usageMetadata from a response object, guarding types.
 */
export function extractUsageMetadata(body: AntigravityApiBody): AntigravityUsageMetadata | null {
  const usage = (body.response && typeof body.response === "object"
    ? (body.response as { usageMetadata?: unknown }).usageMetadata
    : undefined) as AntigravityUsageMetadata | undefined;

  if (!usage || typeof usage !== "object") {
    return null;
  }

  const asRecord = usage as Record<string, unknown>;
  const toNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  return {
    totalTokenCount: toNumber(asRecord.totalTokenCount),
    promptTokenCount: toNumber(asRecord.promptTokenCount),
    candidatesTokenCount: toNumber(asRecord.candidatesTokenCount),
    cachedContentTokenCount: toNumber(asRecord.cachedContentTokenCount),
  };
}

/**
 * Walks SSE lines to find a usage-bearing response chunk.
 */
export function extractUsageFromSsePayload(payload: string): AntigravityUsageMetadata | null {
  const lines = payload.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const jsonText = line.slice(5).trim();
    if (!jsonText) {
      continue;
    }
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === "object") {
        const usage = extractUsageMetadata({ response: (parsed as Record<string, unknown>).response });
        if (usage) {
          return usage;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Enhances 404 errors for Antigravity models with a direct preview-access message.
 */
export function rewriteAntigravityPreviewAccessError(
  body: AntigravityApiBody,
  status: number,
  requestedModel?: string,
): AntigravityApiBody | null {
  if (!needsPreviewAccessOverride(status, body, requestedModel)) {
    return null;
  }

  const error: AntigravityApiError = body.error ?? {};
  const trimmedMessage = typeof error.message === "string" ? error.message.trim() : "";
  const messagePrefix = trimmedMessage.length > 0
    ? trimmedMessage
    : "Antigravity preview features are not enabled for this account.";
  const enhancedMessage = `${messagePrefix} Request preview access at ${ANTIGRAVITY_PREVIEW_LINK} before using this model.`;

  return {
    ...body,
    error: {
      ...error,
      message: enhancedMessage,
    },
  };
}

function needsPreviewAccessOverride(
  status: number,
  body: AntigravityApiBody,
  requestedModel?: string,
): boolean {
  if (status !== 404) {
    return false;
  }

  if (isAntigravityModel(requestedModel)) {
    return true;
  }

  const errorMessage = typeof body.error?.message === "string" ? body.error.message : "";
  return isAntigravityModel(errorMessage);
}

function isAntigravityModel(target?: string): boolean {
  if (!target) {
    return false;
  }

  // Check for Antigravity models instead of Gemini 3
  return /antigravity/i.test(target) || /opus/i.test(target) || /claude/i.test(target);
}
