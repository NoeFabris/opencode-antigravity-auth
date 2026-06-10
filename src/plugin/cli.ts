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

export type LoginMode = "add" | "fresh" | "manage" | "check" | "routing" | "verify" | "verify-all" | "cancel";

export interface AccountRoutingEntry {
  model: string;
  normalizedModel: string;
  email: string;
  quotaModels?: Array<{
    modelId: string;
    displayName?: string;
    group?: "claude" | "gemini-flash" | "gemini-pro";
    remainingFraction?: number;
    resetTime?: string;
  }>;
  quotaError?: string;
}

export interface AccountRoutingInfo {
  strict: boolean;
  entries: AccountRoutingEntry[];
}

export interface ExistingAccountInfo {
  email?: string;
  index: number;
  addedAt?: number;
  lastUsed?: number;
  status?: AccountStatus;
  isCurrentAccount?: boolean;
  enabled?: boolean;
  cachedQuota?: Record<string, { remainingFraction?: number; resetTime?: string; modelCount: number }>;
  cachedQuotaUpdatedAt?: number;
}

export interface LoginMenuResult {
  mode: LoginMode;
  deleteAccountIndex?: number;
  refreshAccountIndex?: number;
  toggleAccountIndex?: number;
  verifyAccountIndex?: number;
  verifyAll?: boolean;
  deleteAll?: boolean;
}

export function showAccountRouting(accounts: ExistingAccountInfo[], routing?: AccountRoutingInfo): void {
  console.log("\nAccount routing");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (!routing || routing.entries.length === 0) {
    console.log("No model_account_affinity entries configured.\n");
    return;
  }

  console.log(`Strict mode: ${routing.strict ? "enabled" : "disabled"}`);
  console.log("");

  for (const entry of routing.entries) {
    const account = accounts.find((candidate) => candidate.email?.toLowerCase() === entry.email.toLowerCase());
    const accountStatus = account
      ? account.enabled === false
        ? "disabled"
        : account.status ?? "unknown"
      : "not configured";
    const accountLabel = account ? `${entry.email} (#${account.index + 1})` : entry.email;
    const quotaGroup = getQuotaGroupForModel(entry.normalizedModel);
    const quota = summarizeLiveQuota(entry.quotaModels, quotaGroup) ?? account?.cachedQuota?.[quotaGroup];

    console.log(`Model:      ${entry.model}`);
    console.log(`Normalized: ${entry.normalizedModel}`);
    console.log(`Account:    ${accountLabel}`);
    console.log(`Status:     ${accountStatus}`);
    console.log(`Quota:      ${formatQuota(quota, account?.cachedQuotaUpdatedAt)}`);
    if (entry.quotaError) {
      console.log(`Quota API:  ${entry.quotaError}`);
    }
    if (entry.quotaModels && entry.quotaModels.length > 0) {
      console.log("Model quota:");
      for (const modelQuota of entry.quotaModels) {
        const name = modelQuota.displayName ?? modelQuota.modelId;
        console.log(`  ${name}`);
        console.log(`  ${formatUsageBar(modelQuota.remainingFraction)}`);
        console.log(`  ${formatQuotaAvailability(modelQuota.remainingFraction, modelQuota.resetTime)}`);
      }
    }
    console.log("");
  }
}

function summarizeLiveQuota(
  quotaModels: AccountRoutingEntry["quotaModels"],
  quotaGroup: "claude" | "gemini-flash" | "gemini-pro",
): { remainingFraction?: number; resetTime?: string; modelCount: number } | undefined {
  const matchingModels = quotaModels?.filter((model) => model.group === quotaGroup) ?? [];
  if (matchingModels.length === 0) {
    return undefined;
  }

  return {
    remainingFraction: Math.max(...matchingModels.map((model) => model.remainingFraction ?? 0)),
    resetTime: matchingModels.find((model) => model.resetTime)?.resetTime,
    modelCount: matchingModels.length,
  };
}

function getQuotaGroupForModel(model: string): "claude" | "gemini-flash" | "gemini-pro" {
  const lower = model.toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("flash")) return "gemini-flash";
  return "gemini-pro";
}

function formatQuota(
  quota: { remainingFraction?: number; resetTime?: string; modelCount: number } | undefined,
  updatedAt: number | undefined,
): string {
  if (!quota) {
    return "not checked yet";
  }
  const remaining = typeof quota.remainingFraction === "number"
    ? `${Math.round(quota.remainingFraction * 100)}% remaining`
    : "remaining unknown";
  const reset = quota.resetTime ? `, resets ${quota.resetTime}` : "";
  const updated = updatedAt ? `, checked ${new Date(updatedAt).toLocaleString()}` : "";
  return `${remaining}${reset}${updated}`;
}

function formatUsageBar(remainingFraction: number | undefined): string {
  if (typeof remainingFraction !== "number") {
    return "░░░░░░░░░░░ ░░░░░░░░░░░ ░░░░░░░░░░░ ░░░░░░░░░░░ ░░░░░░░░░░░ ???";
  }
  const clamped = Math.max(0, Math.min(1, remainingFraction));
  const filledSegments = Math.round(clamped * 5);
  const segments = Array.from({ length: 5 }, (_, index) => index < filledSegments ? "███████████" : "░░░░░░░░░░░");
  return `${segments.join(" ")} ${Math.round(clamped * 100)}%`;
}

function formatQuotaAvailability(remainingFraction: number | undefined, resetTime: string | undefined): string {
  if (typeof remainingFraction !== "number") {
    return resetTime ? `Quota unknown, resets ${resetTime}` : "Quota unknown";
  }
  if (remainingFraction <= 0) {
    return resetTime ? `Quota exhausted, resets ${resetTime}` : "Quota exhausted";
  }
  return "Quota available";
}

async function promptLoginModeFallback(existingAccounts: ExistingAccountInfo[], routing?: AccountRoutingInfo): Promise<LoginMenuResult> {
  const rl = createInterface({ input, output });
  try {
    console.log(`\n${existingAccounts.length} account(s) saved:`);
    for (const acc of existingAccounts) {
      const label = acc.email || `Account ${acc.index + 1}`;
      console.log(`  ${acc.index + 1}. ${label}`);
    }
    console.log("");

    while (true) {
      const answer = await rl.question("(a)dd new, (f)resh start, (c)heck quotas, (r)outing, (v)erify account, (va) verify all? [a/f/c/r/v/va]: ");
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
      if (normalized === "r" || normalized === "routing") {
        return { mode: "routing" };
      }
      if (normalized === "v" || normalized === "verify") {
        return { mode: "verify" };
      }
      if (normalized === "va" || normalized === "verify-all" || normalized === "all") {
        return { mode: "verify-all", verifyAll: true };
      }

      console.log("Please enter 'a', 'f', 'c', 'r', 'v', or 'va'.");
    }
  } finally {
    rl.close();
  }
}

export async function promptLoginMode(existingAccounts: ExistingAccountInfo[], routing?: AccountRoutingInfo): Promise<LoginMenuResult> {
  if (!isTTY()) {
    return promptLoginModeFallback(existingAccounts, routing);
  }

  const accounts: AccountInfo[] = existingAccounts.map(acc => ({
    email: acc.email,
    index: acc.index,
    addedAt: acc.addedAt,
    lastUsed: acc.lastUsed,
    status: acc.status,
    isCurrentAccount: acc.isCurrentAccount,
    enabled: acc.enabled,
  }));

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
        if (accountAction === "verify") {
          return { mode: "verify", verifyAccountIndex: action.account.index };
        }
        continue;
      }

      case "delete-all":
        return { mode: "fresh", deleteAll: true };

      case "configure-models": {
        const result = await updateOpencodeConfig();
        if (result.success) {
          console.log(`\n✓ Models configured in ${result.configPath}\n`);
        } else {
          console.log(`\n✗ Failed to configure models: ${result.error}\n`);
        }
        continue;
      }

      case "view-routing": {
        return { mode: "routing" };
      }

      case "cancel":
        return { mode: "cancel" };
    }
  }
}

export async function promptContinue(): Promise<void> {
  if (!isTTY()) return;
  const rl = createInterface({ input, output });
  try {
    await rl.question("Press Enter to continue...");
  } finally {
    rl.close();
  }
}

export { isTTY } from "./ui/auth-menu";
export type { AccountStatus } from "./ui/auth-menu";
