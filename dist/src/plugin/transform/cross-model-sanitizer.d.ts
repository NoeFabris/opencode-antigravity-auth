/**
 * Cross-Model Metadata Sanitization
 *
 * Fixes: "Invalid `signature` in `thinking` block" error when switching models mid-session.
 *
 * Root cause: Gemini stores thoughtSignature in metadata.google, Claude stores signature
 * in top-level thinking blocks. Foreign signatures fail validation on the target model.
 */
export type ModelFamily = "claude" | "gemini" | "unknown";
export interface SanitizerOptions {
    targetModel: string;
    sourceModel?: string;
    preserveNonSignatureMetadata?: boolean;
}
export interface SanitizationResult {
    payload: unknown;
    modified: boolean;
    signaturesStripped: number;
}
export declare function getModelFamily(model: string): ModelFamily;
export declare function stripGeminiThinkingMetadata(part: Record<string, unknown>, preserveNonSignature?: boolean): {
    part: Record<string, unknown>;
    stripped: number;
};
export declare function stripClaudeThinkingFields(part: Record<string, unknown>): {
    part: Record<string, unknown>;
    stripped: number;
};
export declare function deepSanitizeCrossModelMetadata(obj: unknown, targetFamily: ModelFamily, preserveNonSignature?: boolean): {
    obj: unknown;
    stripped: number;
};
export declare function sanitizeCrossModelPayload(payload: unknown, options: SanitizerOptions): SanitizationResult;
export declare function sanitizeCrossModelPayloadInPlace(payload: Record<string, unknown>, options: SanitizerOptions): number;
//# sourceMappingURL=cross-model-sanitizer.d.ts.map