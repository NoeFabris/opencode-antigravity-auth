import type { HeaderStyle } from "../constants";
export type ModelFamily = "claude" | "gemini";
export type { HeaderStyle };
export interface RateLimitState {
    claude?: number;
    gemini?: number;
}
export interface RateLimitStateV3 {
    claude?: number;
    "gemini-antigravity"?: number;
    "gemini-cli"?: number;
    [key: string]: number | undefined;
}
export interface AccountMetadataV1 {
    email?: string;
    refreshToken: string;
    projectId?: string;
    managedProjectId?: string;
    addedAt: number;
    lastUsed: number;
    isRateLimited?: boolean;
    rateLimitResetTime?: number;
    lastSwitchReason?: "rate-limit" | "initial" | "rotation";
}
export interface AccountStorageV1 {
    version: 1;
    accounts: AccountMetadataV1[];
    activeIndex: number;
}
export interface AccountMetadata {
    email?: string;
    refreshToken: string;
    projectId?: string;
    managedProjectId?: string;
    addedAt: number;
    lastUsed: number;
    lastSwitchReason?: "rate-limit" | "initial" | "rotation";
    rateLimitResetTimes?: RateLimitState;
}
export interface AccountStorage {
    version: 2;
    accounts: AccountMetadata[];
    activeIndex: number;
}
export type CooldownReason = "auth-failure" | "network-error" | "project-error";
export interface AccountMetadataV3 {
    email?: string;
    refreshToken: string;
    projectId?: string;
    managedProjectId?: string;
    addedAt: number;
    lastUsed: number;
    lastSwitchReason?: "rate-limit" | "initial" | "rotation";
    rateLimitResetTimes?: RateLimitStateV3;
    coolingDownUntil?: number;
    cooldownReason?: CooldownReason;
}
export interface AccountStorageV3 {
    version: 3;
    accounts: AccountMetadataV3[];
    activeIndex: number;
    activeIndexByFamily?: {
        claude?: number;
        gemini?: number;
    };
}
export declare function getStoragePath(): string;
export declare function deduplicateAccountsByEmail<T extends {
    email?: string;
    lastUsed?: number;
    addedAt?: number;
}>(accounts: T[]): T[];
export declare function migrateV2ToV3(v2: AccountStorage): AccountStorageV3;
export declare function loadAccounts(): Promise<AccountStorageV3 | null>;
export declare function saveAccounts(storage: AccountStorageV3): Promise<void>;
export declare function clearAccounts(): Promise<void>;
//# sourceMappingURL=storage.d.ts.map