import type { UpdateCheckResult } from "./types";
export declare function isLocalDevMode(directory: string): boolean;
export declare function getLocalDevPath(directory: string): string | null;
export declare function getLocalDevVersion(directory: string): string | null;
export interface PluginEntryInfo {
    entry: string;
    isPinned: boolean;
    pinnedVersion: string | null;
    configPath: string;
}
export declare function findPluginEntry(directory: string): PluginEntryInfo | null;
export declare function getCachedVersion(): string | null;
export declare function updatePinnedVersion(configPath: string, oldEntry: string, newVersion: string): boolean;
export declare function getLatestVersion(): Promise<string | null>;
export declare function checkForUpdate(directory: string): Promise<UpdateCheckResult>;
//# sourceMappingURL=checker.d.ts.map