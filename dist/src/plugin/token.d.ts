import type { OAuthAuthDetails, PluginClient } from "./types";
export declare class AntigravityTokenRefreshError extends Error {
    code?: string;
    description?: string;
    status: number;
    statusText: string;
    constructor(options: {
        message: string;
        code?: string;
        description?: string;
        status: number;
        statusText: string;
    });
}
/**
 * Refreshes an Antigravity OAuth access token, updates persisted credentials, and handles revocation.
 */
export declare function refreshAccessToken(auth: OAuthAuthDetails, client: PluginClient, providerId: string): Promise<OAuthAuthDetails | undefined>;
//# sourceMappingURL=token.d.ts.map