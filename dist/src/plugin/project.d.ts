import type { OAuthAuthDetails, ProjectContextResult } from "./types";
interface AntigravityUserTier {
    id?: string;
    isDefault?: boolean;
    userDefinedCloudaicompanionProject?: boolean;
}
interface LoadCodeAssistPayload {
    cloudaicompanionProject?: string | {
        id?: string;
    };
    currentTier?: {
        id?: string;
    };
    allowedTiers?: AntigravityUserTier[];
}
/**
 * Clears cached project context results and pending promises, globally or for a refresh key.
 */
export declare function invalidateProjectContextCache(refresh?: string): void;
/**
 * Loads managed project information for the given access token and optional project.
 */
export declare function loadManagedProject(accessToken: string, projectId?: string): Promise<LoadCodeAssistPayload | null>;
/**
 * Onboards a managed project for the user, optionally retrying until completion.
 */
export declare function onboardManagedProject(accessToken: string, tierId: string, projectId?: string, attempts?: number, delayMs?: number): Promise<string | undefined>;
/**
 * Resolves an effective project ID for the current auth state, caching results per refresh token.
 */
export declare function ensureProjectContext(auth: OAuthAuthDetails): Promise<ProjectContextResult>;
export {};
//# sourceMappingURL=project.d.ts.map