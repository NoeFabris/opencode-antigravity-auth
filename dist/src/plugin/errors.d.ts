/**
 * Custom error types for opencode-antigravity-auth plugin.
 *
 * Ported from LLM-API-Key-Proxy for robust error handling.
 */
/**
 * Error thrown when Antigravity returns an empty response after retry attempts.
 *
 * Empty responses can occur when:
 * - The model has no candidates/choices
 * - The response body is empty or malformed
 * - A temporary service issue prevents generation
 */
export declare class EmptyResponseError extends Error {
    readonly provider: string;
    readonly model: string;
    readonly attempts: number;
    constructor(provider: string, model: string, attempts: number, message?: string);
}
/**
 * Error thrown when tool ID matching fails and cannot be recovered.
 */
export declare class ToolIdMismatchError extends Error {
    readonly expectedIds: string[];
    readonly foundIds: string[];
    constructor(expectedIds: string[], foundIds: string[], message?: string);
}
//# sourceMappingURL=errors.d.ts.map