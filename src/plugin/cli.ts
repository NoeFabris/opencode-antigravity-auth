  import { createInterface } from "node:readline/promises";
  import { stdin as input, stdout as output } from "node:process";
  import {
    showAuthMenu,
    showAccountDetails,
    isTTY,
    type AccountInfo,
    type AccountStatus,
  } from "./ui/auth-menu";

  export async function promptProjectId(): Promise<string> {
    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question("Project ID (leave blank to use your default project): ");
      return answer.trim();
    } finally {
      rl.close();
    }
  }

  export async function promptAddAnotherAccount(currentCount: number): Promise<boolean> {
    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question(`Add another account? (${currentCount} added) (y/n): `);
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    } finally {
      rl.close();
    }
  }

  export type LoginMode = "add" | "fresh" | "cancel";

  export interface ExistingAccountInfo {
    email?: string;
    index: number;
    addedAt?: number;
    lastUsed?: number;
    status?: AccountStatus;
    isCurrentAccount?: boolean;
  }

  export interface LoginMenuResult {
    mode: LoginMode;
    deleteAccountIndex?: number;
    refreshAccountIndex?: number;
    deleteAll?: boolean;
  }

  async function promptLoginModeFallback(existingAccounts: ExistingAccountInfo[]): Promise<LoginMenuResult> {
    const rl = createInterface({ input, output });
    try {
      console.log(`\n${existingAccounts.length} account(s) saved:`);
      for (const acc of existingAccounts) {
        const label = acc.email || `Account ${acc.index + 1}`;
        console.log(`  ${acc.index + 1}. ${label}`);
      }
      console.log("");

      while (true) {
        const answer = await rl.question("(a)dd new account(s) or (f)resh start? [a/f]: ");
        const normalized = answer.trim().toLowerCase();

        if (normalized === "a" || normalized === "add") {
          return { mode: "add" };
        }
        if (normalized === "f" || normalized === "fresh") {
          return { mode: "fresh" };
        }

        console.log("Please enter 'a' to add accounts or 'f' to start fresh.");
      }
    } finally {
      rl.close();
    }
  }

  export async function promptLoginMode(existingAccounts: ExistingAccountInfo[]): Promise<LoginMenuResult> {
    if (!isTTY()) {
      return promptLoginModeFallback(existingAccounts);
    }

    const accounts: AccountInfo[] = existingAccounts.map(acc => ({
      email: acc.email,
      index: acc.index,
      addedAt: acc.addedAt,
      lastUsed: acc.lastUsed,
      status: acc.status,
      isCurrentAccount: acc.isCurrentAccount,
    }));

    console.log("");

    while (true) {
      const action = await showAuthMenu(accounts);

      switch (action.type) {
        case "add":
          return { mode: "add" };

        case "select-account": {
          const accountAction = await showAccountDetails(action.account);
          if (accountAction === "delete") {
            return { mode: "add", deleteAccountIndex: action.account.index };
          }
          if (accountAction === "refresh") {
            return { mode: "add", refreshAccountIndex: action.account.index };
          }
          continue;
        }

        case "delete-all":
          return { mode: "fresh", deleteAll: true };

        case "cancel":
          return { mode: "cancel" };
      }
    }
  }

  export type AuthMethod = "oauth" | "refresh_token";

  /**
   * Prompts user to choose authentication method.
   * Returns "oauth" for standard OAuth flow, "refresh_token" for direct token input.
   */
  export async function promptAuthMethod(): Promise<AuthMethod> {
    const rl = createInterface({ input, output });
    try {
      console.log("\nAuthentication method:");
      console.log("  1. OAuth with Google (browser login)");
      console.log("  2. Direct refresh token input");
      console.log("");

      while (true) {
        const answer = await rl.question("Choose method [1/2]: ");
        const normalized = answer.trim();

        if (normalized === "1" || normalized === "oauth") {
          return "oauth";
        }
        if (normalized === "2" || normalized === "refresh_token" || normalized === "token") {
          return "refresh_token";
        }

        console.log("Please enter '1' for OAuth or '2' for refresh token.");
      }
    } finally {
      rl.close();
    }
  }

  /**
   * Prompts user for a Google refresh token.
   */
  export async function promptRefreshToken(): Promise<string> {
    const rl = createInterface({ input, output });
    try {
      console.log("\nEnter your Google refresh token.");
      console.log("(The token should be obtained from a previous OAuth flow)\n");
      const answer = await rl.question("Refresh token: ");
      return answer.trim();
    } finally {
      rl.close();
    }
  }

  export { isTTY } from "./ui/auth-menu";
  export type { AccountStatus } from "./ui/auth-menu";