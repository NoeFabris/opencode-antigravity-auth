import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  showAuthMenu,
  showAccountDetails,
  isTTY,
  type AccountInfo,
  type AccountStatus,
} from "./ui/auth-menu";
import { updateOpencodeConfig } from "./config/updater";
import { showSettingsMenu } from "./ui/settings-menu";
import { runActionPanel } from "./ui/action-panel";
import { select } from "./ui/select";
import { UI_COPY } from "./ui/copy";
import { getUiRuntimeOptions, initUiFromConfig } from "./ui/runtime";

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

export type LoginMode = "add" | "fresh" | "manage" | "check" | "verify" | "verify-all" | "gemini-cli-login" | "cancel";

export interface ExistingAccountInfo {
  email?: string;
  index: number;
  addedAt?: number;
  lastUsed?: number;
  status?: AccountStatus;
  isCurrentAccount?: boolean;
  enabled?: boolean;
  quota5hLeftPercent?: number;
  quota7dLeftPercent?: number;
  quota5hResetAtMs?: number;
  quota7dResetAtMs?: number;
  quotaRateLimited?: boolean;
  quotaSummary?: string;
  verificationRequiredType?: string;
}

export interface LoginMenuResult {
  mode: LoginMode;
  deleteAccountIndex?: number;
  refreshAccountIndex?: number;
  toggleAccountIndex?: number;
  setCurrentAccountIndex?: number;
  verifyAccountIndex?: number;
  verifyAll?: boolean;
  deleteAll?: boolean;
  geminiCliAccountIndex?: number;
}

export type SignInMethod = "browser" | "manual" | "back";

export async function promptSignInMethod(): Promise<SignInMethod> {
  if (!isTTY()) {
    return "browser";
  }

  const ui = getUiRuntimeOptions();

  const items = [
    { label: UI_COPY.oauth.openBrowser, value: "browser" as SignInMethod, color: "green" as const },
    { label: UI_COPY.oauth.manualMode, value: "manual" as SignInMethod },
    { label: UI_COPY.oauth.back, value: "back" as SignInMethod, color: "red" as const },
  ];

  const result = await select<SignInMethod>(items, {
    message: UI_COPY.oauth.chooseModeTitle,
    subtitle: UI_COPY.oauth.chooseModeSubtitle,
    help: UI_COPY.oauth.chooseModeHelp,
    clearScreen: true,
    theme: ui.theme,
    selectedEmphasis: "minimal",
    allowEscape: true,
  });

  return result ?? "back";
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
      const answer = await rl.question("(a)dd new, (f)resh start, (c)heck quotas, (v)erify account, (va) verify all, (g)emini cli login? [a/f/c/v/va/g]: ");
      const normalized = answer.trim().toLowerCase();

      if (normalized === "a" || normalized === "add") {
        return { mode: "add" };
      }
      if (normalized === "f" || normalized === "fresh") {
        return { mode: "fresh" };
      }
      if (normalized === "c" || normalized === "check") {
        return { mode: "check" };
      }
      if (normalized === "v" || normalized === "verify") {
        return { mode: "verify" };
      }
      if (normalized === "va" || normalized === "verify-all" || normalized === "all") {
        return { mode: "verify-all", verifyAll: true };
      }
      if (normalized === "g" || normalized === "gemini" || normalized === "gemini-cli") {
        return { mode: "gemini-cli-login" };
      }

      console.log("Please enter 'a', 'f', 'c', 'v', 'va', or 'g'.");
    }
  } finally {
    rl.close();
  }
}

function mapToAccountInfo(acc: ExistingAccountInfo): AccountInfo {
  return {
    email: acc.email,
    index: acc.index,
    addedAt: acc.addedAt,
    lastUsed: acc.lastUsed,
    status: acc.status,
    isCurrentAccount: acc.isCurrentAccount,
    enabled: acc.enabled,
    quota5hLeftPercent: acc.quota5hLeftPercent,
    quota7dLeftPercent: acc.quota7dLeftPercent,
    quota5hResetAtMs: acc.quota5hResetAtMs,
    quota7dResetAtMs: acc.quota7dResetAtMs,
    quotaRateLimited: acc.quotaRateLimited,
    quotaSummary: acc.quotaSummary,
    verificationRequiredType: acc.verificationRequiredType,
  };
}

export async function promptLoginMode(existingAccounts: ExistingAccountInfo[]): Promise<LoginMenuResult> {
  if (!isTTY()) {
    return promptLoginModeFallback(existingAccounts);
  }

  const accounts: AccountInfo[] = existingAccounts.map(mapToAccountInfo);

  console.log("");

  while (true) {
    const action = await showAuthMenu(accounts);

    switch (action.type) {
      case "add":
        return { mode: "add" };

      case "check":
        return { mode: "check" };

      case "verify":
        return { mode: "verify" };

      case "verify-all":
        return { mode: "verify-all", verifyAll: true };

      case "gemini-cli-login":
        return { mode: "gemini-cli-login" };

      case "select-account": {
        const accountAction = await showAccountDetails(action.account);
        if (accountAction === "delete") {
          return { mode: "add", deleteAccountIndex: action.account.index };
        }
        if (accountAction === "refresh") {
          return { mode: "add", refreshAccountIndex: action.account.index };
        }
        if (accountAction === "toggle") {
          return { mode: "manage", toggleAccountIndex: action.account.index };
        }
        if (accountAction === "set-current") {
          return { mode: "manage", setCurrentAccountIndex: action.account.index };
        }
        if (accountAction === "verify") {
          return { mode: "verify", verifyAccountIndex: action.account.index };
        }
        continue;
      }

      case "delete-all":
        return { mode: "fresh", deleteAll: true };

      case "set-current-account":
        return { mode: "manage", setCurrentAccountIndex: action.account.index };

      case "refresh-account":
        return { mode: "add", refreshAccountIndex: action.account.index };

      case "toggle-account":
        return { mode: "manage", toggleAccountIndex: action.account.index };

      case "delete-account":
        return { mode: "add", deleteAccountIndex: action.account.index };

      case "settings":
        await showSettingsMenu();
        continue;

      case "search":
        continue;

      case "configure-models": {
        try {
          const result = await runActionPanel(
            "Configure Models",
            "Updating opencode.json...",
            async () => updateOpencodeConfig(),
            { autoReturnMs: 3000 },
          );
          if (result.success) {
            console.log(`
✓ Models configured in ${result.configPath}
`);
          } else {
            console.log(`
✗ Failed to configure models: ${result.error}
`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.log(`
✗ Failed to configure models: ${message}
`)
        }
        continue;
      }

      case "cancel":
        return { mode: "cancel" };
    }
  }
}

export { isTTY } from "./ui/auth-menu";
export type { AccountStatus } from "./ui/auth-menu";
