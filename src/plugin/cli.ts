import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * Prompts the user for a project ID via stdin/stdout.
 */
export async function promptProjectId(): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Project ID (leave blank to use your default project): ");
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * Prompts user whether they want to add another OAuth account.
 */
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

export type LoginMode = "add" | "fresh" | "manage" | "check";

export interface ExistingAccountInfo {
  email?: string;
  index: number;
  enabled?: boolean;
}

/**
 * Prompts user to choose login mode when accounts already exist.
 * Returns "add" to append new accounts, "fresh" to clear and start over.
 */
export async function promptLoginMode(existingAccounts: ExistingAccountInfo[]): Promise<LoginMode> {
  const rl = createInterface({ input, output });
  try {
    console.log(`\n${existingAccounts.length} account(s) saved:`);
    for (const acc of existingAccounts) {
      const label = acc.email || `Account ${acc.index + 1}`;
      const status = acc.enabled === false ? "disabled" : "enabled";
      console.log(`  ${acc.index + 1}. ${label} (${status})`);
    }
    console.log("");

    while (true) {
      const answer = await rl.question(
        "(a)dd new account(s), (f)resh start, (m)anage accounts, or (c)heck quotas? [a/f/m/c]: ",
      );
      const normalized = answer.trim().toLowerCase();

      if (normalized === "a" || normalized === "add") {
        return "add";
      }
      if (normalized === "f" || normalized === "fresh") {
        return "fresh";
      }
      if (normalized === "m" || normalized === "manage") {
        return "manage";
      }
      if (normalized === "c" || normalized === "check") {
        return "check";
      }

      console.log(
        "Please enter 'a' to add accounts, 'f' to start fresh, 'm' to manage accounts, or 'c' to check quotas.",
      );
    }
  } finally {
    rl.close();
  }
}

export async function promptManageAccounts(existingAccounts: ExistingAccountInfo[]): Promise<number[]> {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      console.log("\nManage accounts (toggle enabled/disabled):");
      for (const acc of existingAccounts) {
        const label = acc.email || `Account ${acc.index + 1}`;
        const status = acc.enabled === false ? "disabled" : "enabled";
        console.log(`  ${acc.index + 1}. ${label} (${status})`);
      }
      console.log("");

      const answer = await rl.question("Toggle accounts by number (comma-separated), or press Enter to continue: ");
      const trimmed = answer.trim();
      if (!trimmed) {
        return [];
      }

      const rawTokens = trimmed
        .split(/[\s,]+/)
        .map((token) => token.trim())
        .filter(Boolean);

      const indices = new Set<number>();
      let invalid = false;

      for (const token of rawTokens) {
        const parsed = Number.parseInt(token, 10);
        if (!Number.isFinite(parsed)) {
          invalid = true;
          break;
        }
        const index = parsed - 1;
        if (index < 0 || index >= existingAccounts.length) {
          invalid = true;
          break;
        }
        indices.add(index);
      }

      if (invalid || indices.size === 0) {
        console.log("Please enter valid account numbers (e.g., 1,2).\n");
        continue;
      }

      return Array.from(indices.values());
    }
  } finally {
    rl.close();
  }
}
