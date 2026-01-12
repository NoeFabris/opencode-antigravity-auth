/**
 * Result returned to the caller after constructing an OAuth authorization URL.
 */
export interface AntigravityAuthorization {
    url: string;
    verifier: string;
    projectId: string;
}
interface AntigravityTokenExchangeSuccess {
    type: "success";
    refresh: string;
    access: string;
    expires: number;
    email?: string;
    projectId: string;
}
interface AntigravityTokenExchangeFailure {
    type: "failed";
    error: string;
}
export type AntigravityTokenExchangeResult = AntigravityTokenExchangeSuccess | AntigravityTokenExchangeFailure;
/**
 * Build the Antigravity OAuth authorization URL including PKCE and optional project metadata.
 */
export declare function authorizeAntigravity(projectId?: string): Promise<AntigravityAuthorization>;
/**
 * Exchange an authorization code for Antigravity CLI access and refresh tokens.
 */
export declare function exchangeAntigravity(code: string, state: string): Promise<AntigravityTokenExchangeResult>;
export {};
//# sourceMappingURL=oauth.d.ts.map