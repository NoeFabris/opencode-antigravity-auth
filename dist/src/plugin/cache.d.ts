import type { OAuthAuthDetails } from "./types";
/**
 * Returns a cached auth snapshot when available, favoring unexpired tokens.
 */
export declare function resolveCachedAuth(auth: OAuthAuthDetails): OAuthAuthDetails;
/**
 * Stores the latest auth snapshot keyed by refresh token.
 */
export declare function storeCachedAuth(auth: OAuthAuthDetails): void;
/**
 * Clears cached auth globally or for a specific refresh token.
 */
export declare function clearCachedAuth(refresh?: string): void;
import { SignatureCache } from "./cache/signature-cache";
import type { SignatureCacheConfig } from "./config";
/**
 * Initialize the disk-based signature cache.
 * Call this from plugin initialization when keep_thinking is enabled.
 */
export declare function initDiskSignatureCache(config: SignatureCacheConfig | undefined): SignatureCache | null;
/**
 * Get the disk cache instance (for testing/debugging).
 */
export declare function getDiskSignatureCache(): SignatureCache | null;
/**
 * Caches a thinking signature for a given session and text.
 * Used for Claude models that require signed thinking blocks in multi-turn conversations.
 * Also writes to disk cache if enabled.
 */
export declare function cacheSignature(sessionId: string, text: string, signature: string): void;
/**
 * Retrieves a cached signature for a given session and text.
 * Checks memory first, then falls back to disk cache.
 * Returns undefined if not found or expired.
 */
export declare function getCachedSignature(sessionId: string, text: string): string | undefined;
/**
 * Clears signature cache for a specific session or all sessions.
 * Also clears from disk cache if enabled.
 */
export declare function clearSignatureCache(sessionId?: string): void;
export { SignatureCache, createSignatureCache } from "./cache/signature-cache";
export type { SignatureCacheConfig } from "./config";
//# sourceMappingURL=cache.d.ts.map