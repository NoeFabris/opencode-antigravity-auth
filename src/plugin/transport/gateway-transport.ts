import {
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from "../request"
import type {
  Transport,
  TransportRequestMetadata,
  PrepareTransportRequestContext,
  TransformTransportResponseContext,
  PreparedTransportRequest,
} from "./types"

/**
 * Extracts the model name from a generativelanguage.googleapis.com URL.
 * Returns null if no model segment is found.
 * Example: /models/gemini-2.5-pro:streamGenerateContent → "gemini-2.5-pro"
 */
function extractModelFromUrl(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:\/?]+)(?::\w+)?/)
  return match?.[1] ?? null
}

/**
 * Infers the model family from a URL.
 * Returns "claude" if the model name contains "claude", otherwise "gemini".
 */
function getModelFamilyFromUrl(urlString: string): string {
  const model = extractModelFromUrl(urlString)
  return model?.includes("claude") ? "claude" : "gemini"
}

/**
 * GatewayTransport wraps the existing /v1internal CloudCode gateway shim.
 *
 * This is the default and only transport in Phase 3. It delegates entirely to
 * prepareAntigravityRequest() and transformAntigravityResponse() in request.ts.
 * No logic is moved — this is a thin seam for future transport alternatives.
 *
 * Responsibilities:
 * - Request recognition (generativelanguage.googleapis.com URLs)
 * - Request preparation (auth headers, endpoint routing, body transformation)
 * - Response transformation (SSE streaming, thinking blocks, tool normalization)
 *
 * Non-responsibilities (owned by the fetch interceptor in plugin.ts):
 * - Account selection and rotation
 * - Quota tracking and rate limit backoff
 * - Endpoint fallback loop
 * - Auth token refresh
 * - Toast notifications
 */
export const gatewayTransport: Transport = {
  id: "gateway",
  label: "Gateway",

  matches(input: RequestInfo): boolean {
    return isGenerativeLanguageRequest(input)
  },

  getRequestMetadata(input: RequestInfo): TransportRequestMetadata {
    const urlString = typeof input === "string" ? input : input.url
    return {
      family: getModelFamilyFromUrl(urlString),
      model: extractModelFromUrl(urlString) ?? undefined,
    }
  },

  auth: {
    requiresOAuth: true,
    requiresProjectContext: true,
    supportsMultiAccount: true,
    supportsHeaderStyle: true,
  },

  prepareRequest(ctx: PrepareTransportRequestContext): PreparedTransportRequest {
    return prepareAntigravityRequest(
      ctx.input,
      ctx.init,
      ctx.accessToken,
      ctx.projectId,
      ctx.endpointOverride,
      ctx.headerStyle,
      ctx.forceThinkingRecovery ?? false,
      ctx.options,
    )
  },

  transformResponse(ctx: TransformTransportResponseContext): Promise<Response> {
    return transformAntigravityResponse(
      ctx.response,
      ctx.prepared.streaming,
      ctx.debugContext,
      ctx.prepared.requestedModel,
      ctx.prepared.projectId,
      ctx.prepared.endpoint,
      ctx.prepared.effectiveModel,
      ctx.prepared.sessionId,
      ctx.prepared.toolDebugMissing,
      ctx.prepared.toolDebugSummary,
      ctx.prepared.toolDebugPayload,
      ctx.debugLines,
    )
  },
}
