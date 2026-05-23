import { extractVariantThinkingConfig } from "./request-helpers";
import { applyGeminiTransforms, isGemini3Model, resolveModelForHeaderStyle } from "./transform";
import type { AntigravityConfig } from "./config";
import type { GeminiApiModel } from "./config/models";
import type { ApiKeyAuthDetails } from "./types";
import type { RequestPayload, ThinkingTier } from "./transform";

export interface AgySdkCredential {
  label: string;
  apiKey: string;
  projectId?: string;
}

export interface GeminiApiModelsResponse {
  models?: GeminiApiModel[];
  nextPageToken?: string;
}

interface PreparedAgySdkGeminiRequest {
  request: RequestInfo;
  init: RequestInit;
  model?: string;
}

const rateLimitedUntilByKey = new Map<string, number>();
let cursor = 0;

const GEMINI_MODELS_LIST_TIMEOUT_MS = 10000;
const GEMINI_MODELS_LIST_MAX_PAGES = 20;

export function resetAgySdkCredentialStateForTests(): void {
  rateLimitedUntilByKey.clear();
  cursor = 0;
}

async function requestBodyText(request: Request): Promise<string | undefined> {
  if (!request.body) return undefined;
  try {
    return await request.clone().text();
  } catch {
    return undefined;
  }
}

function splitEnvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function dedupeCredentials(credentials: AgySdkCredential[]): AgySdkCredential[] {
  const seen = new Set<string>();
  const result: AgySdkCredential[] = [];
  for (const credential of credentials) {
    if (seen.has(credential.apiKey)) continue;
    seen.add(credential.apiKey);
    result.push(credential);
  }
  return result;
}

export function getAgySdkCredentials(
  config: AntigravityConfig,
  auth?: ApiKeyAuthDetails | null,
): AgySdkCredential[] {
  if (!config.agy_sdk.enabled) return [];

  const credentials: AgySdkCredential[] = [];
  if (auth?.key?.trim()) {
    credentials.push({ label: "opencode api key", apiKey: auth.key.trim() });
  }

  for (const project of config.agy_sdk.cloud_projects) {
    if (project.enabled === false) continue;
    credentials.push({
      label: project.label?.trim() || project.project_id?.trim() || "cloud project",
      apiKey: project.api_key.trim(),
      projectId: project.project_id?.trim() || undefined,
    });
  }

  const envKeys = splitEnvList(process.env.OPENCODE_ANTIGRAVITY_API_KEYS);
  const envCandidates = [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
    ...envKeys,
  ]
    .map((apiKey) => apiKey?.trim())
    .filter((apiKey): apiKey is string => Boolean(apiKey));
  for (const apiKey of envCandidates) {
    credentials.push({ label: "environment", apiKey });
  }

  return dedupeCredentials(credentials);
}

export function selectAgySdkCredential(credentials: AgySdkCredential[]): AgySdkCredential | null {
  if (credentials.length === 0) return null;
  const now = Date.now();
  for (let attempts = 0; attempts < credentials.length; attempts += 1) {
    const index = cursor % credentials.length;
    cursor += 1;
    const credential = credentials[index];
    if (!credential) continue;
    const limitedUntil = rateLimitedUntilByKey.get(credential.apiKey) ?? 0;
    if (limitedUntil <= now) {
      return credential;
    }
  }
  return null;
}

export function markAgySdkCredentialRateLimited(credential: AgySdkCredential, retryAfterMs: number): void {
  rateLimitedUntilByKey.set(credential.apiKey, Date.now() + Math.max(1000, retryAfterMs));
}

function retryAfterMsFromResponse(response: Response, fallbackMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return fallbackMs;
  const parsed = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed * 1000;
  }
  return fallbackMs;
}

export function isApiKeyAuth(auth: unknown): auth is ApiKeyAuthDetails {
  if (!auth || typeof auth !== "object") return false;
  const candidate = auth as ApiKeyAuthDetails;
  return (candidate.type === "api" || candidate.type === "api_key") && typeof candidate.key === "string";
}

export function isAgySdkSupportedRequest(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.hostname !== "generativelanguage.googleapis.com") return false;
  const model = extractGeminiModelFromUrl(url.toString());
  return !!model && model.toLowerCase().includes("gemini");
}

function extractGeminiModelFromUrl(urlString: string): string | undefined {
  try {
    const url = new URL(urlString);
    return url.pathname.match(/\/models\/([^:]+):(\w+)/)?.[1];
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toThinkingTier(value: string | undefined): ThinkingTier | undefined {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

function thinkingLevelFromBudget(budget: number): string {
  if (budget <= 8192) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

function mergeExtraBody(payload: RequestPayload): Record<string, unknown> | undefined {
  const extraBody = isRecord(payload.extra_body)
    ? payload.extra_body
    : isRecord(payload.extraBody)
      ? payload.extraBody
      : undefined;
  if (!extraBody) return undefined;

  if (isRecord(extraBody.generationConfig)) {
    const generationConfig = isRecord(payload.generationConfig) ? payload.generationConfig : {};
    for (const [key, value] of Object.entries(extraBody.generationConfig)) {
      if (!(key in generationConfig)) {
        generationConfig[key] = value;
      }
    }
    payload.generationConfig = generationConfig;
  }

  for (const [key, value] of Object.entries(extraBody)) {
    if (!(key in payload)) {
      payload[key] = value;
    }
  }
  return extraBody;
}

function applyAgySdkGeminiBodyTransforms(payload: RequestPayload, model: string, thinkingLevel?: string): void {
  const generationConfig = isRecord(payload.generationConfig)
    ? payload.generationConfig
    : {};
  const extraBody = mergeExtraBody(payload);
  const variantConfig = extractVariantThinkingConfig(
    isRecord(payload.providerOptions) ? payload.providerOptions : undefined,
    generationConfig,
  );

  const extraThinkingConfig = isRecord(extraBody?.thinkingConfig) ? extraBody.thinkingConfig : undefined;
  const existingThinkingConfig = isRecord(generationConfig.thinkingConfig)
    ? generationConfig.thinkingConfig
    : extraThinkingConfig
      ? { ...extraThinkingConfig }
      : {};

  if (isGemini3Model(model)) {
    const resolvedLevel = variantConfig?.thinkingLevel
      ?? (typeof existingThinkingConfig.thinkingLevel === "string" ? existingThinkingConfig.thinkingLevel : undefined)
      ?? (variantConfig?.thinkingBudget !== undefined ? thinkingLevelFromBudget(variantConfig.thinkingBudget) : undefined)
      ?? thinkingLevel
      ?? "low";
    existingThinkingConfig.thinkingLevel = resolvedLevel;
    if (variantConfig?.includeThoughts !== undefined) {
      existingThinkingConfig.includeThoughts = variantConfig.includeThoughts;
    } else if (typeof existingThinkingConfig.includeThoughts !== "boolean") {
      existingThinkingConfig.includeThoughts = true;
    }
  } else if (variantConfig?.thinkingBudget !== undefined || typeof existingThinkingConfig.thinkingBudget === "number") {
    existingThinkingConfig.thinkingBudget = variantConfig?.thinkingBudget ?? existingThinkingConfig.thinkingBudget;
    if (variantConfig?.includeThoughts !== undefined) {
      existingThinkingConfig.includeThoughts = variantConfig.includeThoughts;
    } else if (typeof existingThinkingConfig.includeThoughts !== "boolean") {
      existingThinkingConfig.includeThoughts = true;
    }
  }

  if (Object.keys(existingThinkingConfig).length > 0) {
    generationConfig.thinkingConfig = existingThinkingConfig;
    payload.generationConfig = generationConfig;
  }

  if (Array.isArray(payload.tools) || variantConfig?.googleSearch) {
    applyGeminiTransforms(payload, {
      model,
      tierThinkingLevel: toThinkingTier(typeof generationConfig.thinkingConfig === "object"
        && generationConfig.thinkingConfig
        && "thinkingLevel" in generationConfig.thinkingConfig
        ? String((generationConfig.thinkingConfig as Record<string, unknown>).thinkingLevel)
        : undefined),
      googleSearch: variantConfig?.googleSearch,
    });
  }

  delete payload.model;
  delete payload.providerOptions;
  delete payload.extra_body;
  delete payload.extraBody;
  delete payload.thinkingConfig;
  delete payload.thinking;
}

export async function prepareAgySdkGeminiRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  credential: AgySdkCredential,
): Promise<PreparedAgySdkGeminiRequest> {
  const requestInput = typeof input === "string" ? undefined : input;
  const urlString = requestInput?.url ?? input.toString();
  const url = new URL(urlString);
  const match = url.pathname.match(/\/models\/([^:]+):(\w+)/);
  const rawModel = match?.[1] ?? undefined;
  const action = match?.[2] ?? undefined;
  const resolved = rawModel ? resolveModelForHeaderStyle(rawModel, "agy-sdk") : undefined;

  if (resolved && action) {
    url.pathname = url.pathname.replace(`/models/${rawModel}:${action}`, `/models/${resolved.actualModel}:${action}`);
  }
  url.searchParams.delete("key");

  const headers = new Headers(init?.headers ?? requestInput?.headers ?? {});
  headers.delete("Authorization");
  headers.delete("x-api-key");
  headers.set("x-goog-api-key", credential.apiKey);
  headers.delete("x-goog-user-project");

  const requestTextBody = init?.body === undefined && requestInput ? await requestBodyText(requestInput) : undefined;
  const originalBody = init?.body ?? requestTextBody ?? requestInput?.body ?? undefined;
  let body = originalBody;
  if (typeof body === "string" && body.trim()) {
    try {
      const payload = JSON.parse(body) as RequestPayload;
      applyAgySdkGeminiBodyTransforms(payload, resolved?.actualModel ?? rawModel ?? "", resolved?.thinkingLevel);
      body = JSON.stringify(payload);
    } catch {
      body = originalBody;
    }
  }

  return {
    request: url.toString(),
    init: {
      method: requestInput?.method,
      ...init,
      headers,
      body,
    },
    model: resolved?.actualModel ?? rawModel,
  };
}

async function fetchGeminiModelsPage(url: string, credential: AgySdkCredential): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_MODELS_LIST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "x-goog-api-key": credential.apiKey,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWithAgySdkCredential(
  input: RequestInfo,
  init: RequestInit | undefined,
  credential: AgySdkCredential,
  fallbackRetryAfterMs: number,
): Promise<Response> {
  const prepared = await prepareAgySdkGeminiRequest(input, init, credential);
  const response = await fetch(prepared.request, prepared.init);
  if (response.status === 429 || response.status === 503 || response.status === 529) {
    markAgySdkCredentialRateLimited(credential, retryAfterMsFromResponse(response, fallbackRetryAfterMs));
  }
  return response;
}

export async function fetchGeminiApiModels(credential: AgySdkCredential): Promise<GeminiApiModel[]> {
  const models: GeminiApiModel[] = [];
  let pageToken: string | undefined;
  const seenPageTokens = new Set<string>();

  for (let page = 0; page < GEMINI_MODELS_LIST_MAX_PAGES; page += 1) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) {
        throw new Error(`Gemini models.list returned repeated page token for ${credential.label}`);
      }
      seenPageTokens.add(pageToken);
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetchGeminiModelsPage(url.toString(), credential);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const snippet = body.trim().slice(0, 200);
      throw new Error(`Gemini models.list failed for ${credential.label}: ${response.status}${snippet ? ` ${snippet}` : ""}`);
    }

    const payload = (await response.json()) as GeminiApiModelsResponse;
    models.push(...(payload.models ?? []));
    pageToken = payload.nextPageToken;
    if (!pageToken) return models;
  }

  throw new Error(`Gemini models.list exceeded ${GEMINI_MODELS_LIST_MAX_PAGES} pages for ${credential.label}`);
}
