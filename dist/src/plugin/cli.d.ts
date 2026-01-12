/**
 * Prompts the user for a project ID via stdin/stdout.
 */
export declare function promptProjectId(): Promise<string>;
/**
 * Prompts user whether they want to add another OAuth account.
 */
export declare function promptAddAnotherAccount(currentCount: number): Promise<boolean>;
export type LoginMode = "add" | "fresh";
export interface ExistingAccountInfo {
    email?: string;
    index: number;
}
/**
 * Prompts user to choose login mode when accounts already exist.
 * Returns "add" to append new accounts, "fresh" to clear and start over.
 */
export declare function promptLoginMode(existingAccounts: ExistingAccountInfo[]): Promise<LoginMode>;
//# sourceMappingURL=cli.d.ts.map