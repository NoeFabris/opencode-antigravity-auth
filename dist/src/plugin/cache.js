import { accessTokenExpired } from "./auth";
import { createHash } from "node:crypto";
const authCache = new Map();
/**
 * Produces a stable cache key from a refresh token string.
 */
function normalizeRefreshKey(refresh) {
    const key = refresh?.trim();
    return key ? key : undefined;
}
/**
 * Returns a cached auth snapshot when available, favoring unexpired tokens.
 */
export function resolveCachedAuth(auth) {
    const key = normalizeRefreshKey(auth.refresh);
    if (!key) {
        return auth;
    }
    const cached = authCache.get(key);
    if (!cached) {
        authCache.set(key, auth);
        return auth;
    }
    if (!accessTokenExpired(auth)) {
        authCache.set(key, auth);
        return auth;
    }
    if (!accessTokenExpired(cached)) {
        return cached;
    }
    authCache.set(key, auth);
    return auth;
}
/**
 * Stores the latest auth snapshot keyed by refresh token.
 */
export function storeCachedAuth(auth) {
    const key = normalizeRefreshKey(auth.refresh);
    if (!key) {
        return;
    }
    authCache.set(key, auth);
}
/**
 * Clears cached auth globally or for a specific refresh token.
 */
export function clearCachedAuth(refresh) {
    if (!refresh) {
        authCache.clear();
        return;
    }
    const key = normalizeRefreshKey(refresh);
    if (key) {
        authCache.delete(key);
    }
}
// ============================================================================
// Thinking Signature Cache (for Claude multi-turn conversations)
// ============================================================================
import { SignatureCache, createSignatureCache } from "./cache/signature-cache";
// Map: sessionId -> Map<textHash, SignatureEntry>
const signatureCache = new Map();
// Cache entries expire after 1 hour
const SIGNATURE_CACHE_TTL_MS = 60 * 60 * 1000;
// Maximum entries per session to prevent memory bloat
const MAX_ENTRIES_PER_SESSION = 100;
// 16 hex chars = 64-bit key space; keeps memory bounded while making collisions extremely unlikely.
const SIGNATURE_TEXT_HASH_HEX_LEN = 16;
// Disk cache instance (initialized via initDiskSignatureCache)
let diskCache = null;
/**
 * Initialize the disk-based signature cache.
 * Call this from plugin initialization when keep_thinking is enabled.
 */
export function initDiskSignatureCache(config) {
    diskCache = createSignatureCache(config);
    return diskCache;
}
/**
 * Get the disk cache instance (for testing/debugging).
 */
export function getDiskSignatureCache() {
    return diskCache;
}
/**
 * Hashes text content into a stable, Unicode-safe key.
 *
 * Uses SHA-256 over UTF-8 bytes and truncates to keep memory usage bounded.
 */
function hashText(text) {
    return createHash("sha256").update(text, "utf8").digest("hex").slice(0, SIGNATURE_TEXT_HASH_HEX_LEN);
}
/**
 * Create a disk cache key from sessionId and textHash.
 */
function makeDiskKey(sessionId, textHash) {
    return `${sessionId}:${textHash}`;
}
/**
 * Caches a thinking signature for a given session and text.
 * Used for Claude models that require signed thinking blocks in multi-turn conversations.
 * Also writes to disk cache if enabled.
 */
export function cacheSignature(sessionId, text, signature) {
    if (!sessionId || !text || !signature)
        return;
    const textHash = hashText(text);
    // Write to memory cache
    let sessionMemCache = signatureCache.get(sessionId);
    if (!sessionMemCache) {
        sessionMemCache = new Map();
        signatureCache.set(sessionId, sessionMemCache);
    }
    // Evict old entries if we're at capacity
    if (sessionMemCache.size >= MAX_ENTRIES_PER_SESSION) {
        const now = Date.now();
        for (const [key, entry] of sessionMemCache.entries()) {
            if (now - entry.timestamp > SIGNATURE_CACHE_TTL_MS) {
                sessionMemCache.delete(key);
            }
        }
        // If still at capacity, remove oldest entries
        if (sessionMemCache.size >= MAX_ENTRIES_PER_SESSION) {
            const entries = Array.from(sessionMemCache.entries())
                .sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toRemove = entries.slice(0, Math.floor(MAX_ENTRIES_PER_SESSION / 4));
            for (const [key] of toRemove) {
                sessionMemCache.delete(key);
            }
        }
    }
    sessionMemCache.set(textHash, { signature, timestamp: Date.now() });
    // Write to disk cache if enabled
    if (diskCache) {
        const diskKey = makeDiskKey(sessionId, textHash);
        diskCache.store(diskKey, signature);
    }
}
/**
 * Retrieves a cached signature for a given session and text.
 * Checks memory first, then falls back to disk cache.
 * Returns undefined if not found or expired.
 */
export function getCachedSignature(sessionId, text) {
    if (!sessionId || !text)
        return undefined;
    const textHash = hashText(text);
    // Check memory cache first
    const sessionMemCache = signatureCache.get(sessionId);
    if (sessionMemCache) {
        const entry = sessionMemCache.get(textHash);
        if (entry) {
            // Check if expired
            if (Date.now() - entry.timestamp > SIGNATURE_CACHE_TTL_MS) {
                sessionMemCache.delete(textHash);
            }
            else {
                return entry.signature;
            }
        }
    }
    // Fall back to disk cache
    if (diskCache) {
        const diskKey = makeDiskKey(sessionId, textHash);
        const diskValue = diskCache.retrieve(diskKey);
        if (diskValue) {
            // Promote to memory cache for faster subsequent access
            let memCache = signatureCache.get(sessionId);
            if (!memCache) {
                memCache = new Map();
                signatureCache.set(sessionId, memCache);
            }
            memCache.set(textHash, { signature: diskValue, timestamp: Date.now() });
            return diskValue;
        }
    }
    return undefined;
}
/**
 * Clears signature cache for a specific session or all sessions.
 * Also clears from disk cache if enabled.
 */
export function clearSignatureCache(sessionId) {
    if (sessionId) {
        signatureCache.delete(sessionId);
        // Note: We don't clear individual sessions from disk cache to avoid
        // expensive iteration. Disk cache entries will expire naturally.
    }
    else {
        signatureCache.clear();
        // For full clear, we could clear disk cache, but leaving it for now
        // since entries have TTL and will expire naturally.
    }
}
// ============================================================================
// Disk-Persistent Signature Cache (re-export from cache/ folder)
// ============================================================================
// Re-export SignatureCache class and factory for direct use
export { SignatureCache, createSignatureCache } from "./cache/signature-cache";
//# sourceMappingURL=cache.js.map