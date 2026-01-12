/**
 * Signature cache for persisting thinking block signatures to disk.
 *
 * Features (based on LLM-API-Key-Proxy's ProviderCache):
 * - Dual-TTL system: short memory TTL, longer disk TTL
 * - Background disk persistence with batched writes
 * - Atomic writes with temp file + move pattern
 * - Automatic cleanup of expired entries
 *
 * Cache key format: `${sessionId}:${modelId}`
 */
import type { SignatureCacheConfig } from "../config";
interface CacheStats {
    memoryHits: number;
    diskHits: number;
    misses: number;
    writes: number;
    memoryEntries: number;
    dirty: boolean;
    diskEnabled: boolean;
}
/**
 * Full thinking content with signature (for recovery)
 */
export interface ThinkingCacheData {
    text: string;
    signature: string;
    toolIds?: string[];
}
export declare class SignatureCache {
    private cache;
    private memoryTtlMs;
    private diskTtlMs;
    private writeIntervalMs;
    private cacheFilePath;
    private enabled;
    private dirty;
    private writeTimer;
    private cleanupTimer;
    private stats;
    constructor(config: SignatureCacheConfig);
    /**
     * Generate a cache key from sessionId and modelId.
     */
    static makeKey(sessionId: string, modelId: string): string;
    /**
     * Store a signature in the cache.
     */
    store(key: string, signature: string): void;
    /**
     * Retrieve a signature from the cache.
     * Returns null if not found or expired.
     */
    retrieve(key: string): string | null;
    /**
     * Check if a key exists in the cache (without updating stats).
     */
    has(key: string): boolean;
    /**
     * Store full thinking content with signature.
     * This enables recovery even after thinking text is stripped by compaction.
     *
     * Port of LLM-API-Key-Proxy's _cache_thinking()
     */
    storeThinking(key: string, thinkingText: string, signature: string, toolIds?: string[]): void;
    /**
     * Retrieve full thinking content by key.
     * Returns null if not found or expired.
     */
    retrieveThinking(key: string): ThinkingCacheData | null;
    /**
     * Check if full thinking content exists for a key.
     */
    hasThinking(key: string): boolean;
    /**
     * Get cache statistics.
     */
    getStats(): CacheStats;
    /**
     * Manually trigger a disk save.
     */
    flush(): Promise<boolean>;
    /**
     * Graceful shutdown: stop timers and flush to disk.
     */
    shutdown(): void;
    /**
     * Load cache from disk file with TTL validation.
     */
    private loadFromDisk;
    /**
     * Save cache to disk with atomic write pattern.
     * Merges with existing disk entries that haven't expired.
     */
    private saveToDisk;
    /**
     * Start background write and cleanup timers.
     */
    private startBackgroundTasks;
    /**
     * Remove expired entries from memory.
     */
    private cleanupExpired;
}
/**
 * Create a signature cache with the given configuration.
 * Returns null if caching is disabled.
 */
export declare function createSignatureCache(config: SignatureCacheConfig | undefined): SignatureCache | null;
export {};
//# sourceMappingURL=signature-cache.d.ts.map