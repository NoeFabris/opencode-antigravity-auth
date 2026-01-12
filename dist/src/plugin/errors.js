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
export class EmptyResponseError extends Error {
    provider;
    model;
    attempts;
    constructor(provider, model, attempts, message) {
        super(message ??
            `The model returned an empty response after ${attempts} attempts. ` +
                `This may indicate a temporary service issue. Please try again.`);
        this.name = "EmptyResponseError";
        this.provider = provider;
        this.model = model;
        this.attempts = attempts;
    }
}
/**
 * Error thrown when tool ID matching fails and cannot be recovered.
 */
export class ToolIdMismatchError extends Error {
    expectedIds;
    foundIds;
    constructor(expectedIds, foundIds, message) {
        super(message ??
            `Tool ID mismatch: expected [${expectedIds.join(", ")}] but found [${foundIds.join(", ")}]`);
        this.name = "ToolIdMismatchError";
        this.expectedIds = expectedIds;
        this.foundIds = foundIds;
    }
}
//# sourceMappingURL=errors.js.map