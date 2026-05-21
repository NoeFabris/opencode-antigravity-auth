import type { HeaderStyle } from "../../constants"
import type { PrepareRequestOptions } from "../request"
import type { AntigravityDebugContext } from "../debug"

/**
 * Identifies the active transport. Extend this union when adding new transports.
 */
export type TransportId = "gateway" | "cli" | "managed-agent"

/**
 * Metadata extracted from a recognized request before preparation.
 */
export interface TransportRequestMetadata {
  family: string
  model?: string
}

/**
 * The result of preparing a request for transport.
 * Mirrors the return type of prepareAntigravityRequest().
 */
export interface PreparedTransportRequest {
  request: RequestInfo
  init: RequestInit
  streaming: boolean
  action: string
  requestedModel?: string
  effectiveModel?: string
  projectId?: string
  endpoint?: string
  sessionId?: string
  toolDebugMissing?: number
  toolDebugSummary?: string
  toolDebugPayload?: string
  needsSignedThinkingWarmup?: boolean
  headerStyle: HeaderStyle
  thinkingRecoveryMessage?: string

  /** Experimental non-HTTP transports may attach execution metadata here. */
  transportPayload?: unknown
}

/**
 * Context passed to transport.prepareRequest().
 */
export interface PrepareTransportRequestContext {
  input: RequestInfo
  init: RequestInit | undefined
  accessToken: string
  projectId: string
  endpointOverride?: string
  headerStyle: HeaderStyle
  forceThinkingRecovery?: boolean
  options?: PrepareRequestOptions
}

/**
 * Context passed to transport.transformResponse().
 */
export interface TransformTransportResponseContext {
  response: Response
  prepared: PreparedTransportRequest
  debugContext?: AntigravityDebugContext | null
  debugLines?: string[]
}

/**
 * Static auth requirements for a transport.
 */
export interface TransportAuthRequirements {
  requiresOAuth: boolean
  requiresProjectContext: boolean
  supportsMultiAccount: boolean
  supportsHeaderStyle: boolean
}

/**
 * A transport encapsulates request recognition, preparation, and response
 * transformation for a specific backend.
 *
 * Phase 3 introduces this boundary so future transports (CliTransport,
 * ManagedAgentTransport) can be added without editing the fetch interceptor.
 *
 * The fetch interceptor (plugin.ts) owns: account selection, quota rotation,
 * endpoint fallback, rate limiting, retries, and auth refresh.
 * The transport owns: request shape, response shape, and backend-specific logic.
 */
export interface Transport {
  /** Stable identifier for debug labels and config. */
  id: TransportId

  /** Human-readable label for debug output. */
  label: string

  /** Returns true if this transport should handle the given request. */
  matches(input: RequestInfo): boolean

  /** Extracts model family and model name from a recognized request URL. */
  getRequestMetadata(input: RequestInfo): TransportRequestMetadata

  /** Static auth requirements for this transport. */
  auth: TransportAuthRequirements

  /** Prepare the request for the backend. */
  prepareRequest(ctx: PrepareTransportRequestContext): PreparedTransportRequest

  /** Transform the backend response into an OpenCode-compatible response. */
  transformResponse(ctx: TransformTransportResponseContext): Promise<Response>
}
