import { type HeaderStyle } from "../constants";
import { createStreamingTransformer, transformSseLine, transformStreamingPayload } from "./core/streaming";
import { type AntigravityDebugContext } from "./debug";
declare function buildSignatureSessionKey(sessionId: string, model?: string, conversationKey?: string, projectKey?: string): string;
declare function hashConversationSeed(seed: string): string;
declare function extractTextFromContent(content: unknown): string;
declare function extractConversationSeedFromMessages(messages: any[]): string;
declare function extractConversationSeedFromContents(contents: any[]): string;
declare function resolveConversationKey(requestPayload: Record<string, unknown>): string | undefined;
declare function resolveProjectKey(candidate?: unknown, fallback?: string): string | undefined;
declare function isGeminiToolUsePart(part: any): boolean;
declare function isGeminiThinkingPart(part: any): boolean;
declare function ensureThoughtSignature(part: any, sessionId: string): any;
declare function hasSignedThinkingPart(part: any): boolean;
declare function ensureThinkingBeforeToolUseInContents(contents: any[], signatureSessionKey: string): any[];
declare function hasToolUseInContents(contents: any[]): boolean;
declare function hasSignedThinkingInContents(contents: any[]): boolean;
declare function hasToolUseInMessages(messages: any[]): boolean;
declare function hasSignedThinkingInMessages(messages: any[]): boolean;
declare function ensureThinkingBeforeToolUseInMessages(messages: any[], signatureSessionKey: string): any[];
/**
 * Gets the stable session ID for this plugin instance.
 */
export declare function getPluginSessionId(): string;
declare function generateSyntheticProjectId(): string;
/**
 * Detects requests headed to the Google Generative Language API so we can intercept them.
 */
export declare function isGenerativeLanguageRequest(input: RequestInfo): input is string;
/**
 * Options for request preparation.
 */
export interface PrepareRequestOptions {
    /** Enable Claude tool hardening (parameter signatures + system instruction). Default: true */
    claudeToolHardening?: boolean;
}
export declare function prepareAntigravityRequest(input: RequestInfo, init: RequestInit | undefined, accessToken: string, projectId: string, endpointOverride?: string, headerStyle?: HeaderStyle, forceThinkingRecovery?: boolean, options?: PrepareRequestOptions): {
    request: RequestInfo;
    init: RequestInit;
    streaming: boolean;
    requestedModel?: string;
    effectiveModel?: string;
    projectId?: string;
    endpoint?: string;
    sessionId?: string;
    toolDebugMissing?: number;
    toolDebugSummary?: string;
    toolDebugPayload?: string;
    needsSignedThinkingWarmup?: boolean;
    headerStyle: HeaderStyle;
    thinkingRecoveryMessage?: string;
};
export declare function buildThinkingWarmupBody(bodyText: string | undefined, isClaudeThinking: boolean): string | null;
/**
 * Normalizes Antigravity responses: applies retry headers, extracts cache usage into headers,
 * rewrites preview errors, flattens streaming payloads, and logs debug metadata.
 *
 * For streaming SSE responses, uses TransformStream for true real-time incremental streaming.
 * Thinking/reasoning tokens are transformed and forwarded immediately as they arrive.
 */
export declare function transformAntigravityResponse(response: Response, streaming: boolean, debugContext?: AntigravityDebugContext | null, requestedModel?: string, projectId?: string, endpoint?: string, effectiveModel?: string, sessionId?: string, toolDebugMissing?: number, toolDebugSummary?: string, toolDebugPayload?: string, debugLines?: string[]): Promise<Response>;
export declare const __testExports: {
    buildSignatureSessionKey: typeof buildSignatureSessionKey;
    hashConversationSeed: typeof hashConversationSeed;
    extractTextFromContent: typeof extractTextFromContent;
    extractConversationSeedFromMessages: typeof extractConversationSeedFromMessages;
    extractConversationSeedFromContents: typeof extractConversationSeedFromContents;
    resolveConversationKey: typeof resolveConversationKey;
    resolveProjectKey: typeof resolveProjectKey;
    isGeminiToolUsePart: typeof isGeminiToolUsePart;
    isGeminiThinkingPart: typeof isGeminiThinkingPart;
    ensureThoughtSignature: typeof ensureThoughtSignature;
    hasSignedThinkingPart: typeof hasSignedThinkingPart;
    hasSignedThinkingInContents: typeof hasSignedThinkingInContents;
    hasSignedThinkingInMessages: typeof hasSignedThinkingInMessages;
    hasToolUseInContents: typeof hasToolUseInContents;
    hasToolUseInMessages: typeof hasToolUseInMessages;
    ensureThinkingBeforeToolUseInContents: typeof ensureThinkingBeforeToolUseInContents;
    ensureThinkingBeforeToolUseInMessages: typeof ensureThinkingBeforeToolUseInMessages;
    generateSyntheticProjectId: typeof generateSyntheticProjectId;
    MIN_SIGNATURE_LENGTH: number;
    transformSseLine: typeof transformSseLine;
    transformStreamingPayload: typeof transformStreamingPayload;
    createStreamingTransformer: typeof createStreamingTransformer;
};
export {};
//# sourceMappingURL=request.d.ts.map