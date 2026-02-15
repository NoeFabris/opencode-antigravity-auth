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
import type { ProxyConfig } from "./storage";

const SUPPORTED_PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
]);

function normalizeProxyUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!SUPPORTED_PROXY_PROTOCOLS.has(url.protocol.toLowerCase())) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function parseProxyInput(value: string): {
  proxies: ProxyConfig[];
  invalid: string[];
} {
  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  const invalid: string[] = [];
  const dedup = new Map<string, ProxyConfig>();

  for (const rawToken of tokens) {
    const disabled = rawToken.startsWith("!");
    const token = disabled ? rawToken.slice(1).trim() : rawToken;
    const normalizedUrl = normalizeProxyUrl(token);
    if (!normalizedUrl) {
      invalid.push(rawToken);
      continue;
    }

    const proxy: ProxyConfig = disabled
      ? { url: normalizedUrl, enabled: false }
      : { url: normalizedUrl };
    dedup.set(proxy.url, proxy);
  }

  return {
    proxies: [...dedup.values()],
    invalid,
  };
}

function cloneProxies(proxies: ProxyConfig[]): ProxyConfig[] {
  return proxies.map((proxy) => ({ ...proxy }));
}

function mergeProxyConfigs(existing: ProxyConfig[], additions: ProxyConfig[]): ProxyConfig[] {
  const dedup = new Map<string, ProxyConfig>();

  for (const proxy of existing) {
    dedup.set(proxy.url, { ...proxy });
  }

  for (const proxy of additions) {
    dedup.set(proxy.url, { ...proxy });
  }

  return [...dedup.values()];
}

function proxyStatus(proxy: ProxyConfig): string {
  return proxy.enabled === false ? "disabled" : "enabled";
}

function printProxyList(proxies: ProxyConfig[]): void {
  if (proxies.length === 0) {
    console.log("  (no proxies configured)");
    return;
  }

  for (const [index, proxy] of proxies.entries()) {
    console.log(`  ${index + 1}. ${proxy.url} [${proxyStatus(proxy)}]`);
  }
}

function parseProxyIndex(inputValue: string, max: number): number | null {
  const parsed = Number.parseInt(inputValue.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > max) {
    return null;
  }
  return parsed - 1;
}

interface ProxyManagerOptions {
  doneLabel: string;
  cancelResult: ProxyConfig[] | undefined;
}

async function promptProxyManager(
  rl: ReturnType<typeof createInterface>,
  accountLabel: string,
  initialProxies: ProxyConfig[],
  options: ProxyManagerOptions,
): Promise<ProxyConfig[] | undefined> {
  let working = cloneProxies(initialProxies);

  while (true) {
    console.log(`\nProxy manager for ${accountLabel}:`);
    printProxyList(working);
    console.log("\nActions:");
    console.log("  [a] Add proxy");
    console.log("  [d] Delete one proxy");
    console.log("  [t] Toggle one proxy enabled/disabled");
    console.log("  [c] Clear all proxies");
    console.log(`  [s] ${options.doneLabel}`);
    console.log("  [x] Cancel");

    const action = (await rl.question("Choose action [a/d/t/c/s/x]: ")).trim().toLowerCase();

    if (action === "x" || action === "cancel") {
      return options.cancelResult;
    }

    if (action === "s" || action === "save" || action === "done") {
      return cloneProxies(working);
    }

    if (action === "c" || action === "clear") {
      working = [];
      console.log("Cleared all proxies.");
      continue;
    }

    if (action === "a" || action === "add") {
      console.log("Supported proxy URL schemes: http:// https:// socks4:// socks4a:// socks5:// socks5h://");
      console.log("Tip: prefix a URL with '!' to add as disabled.");
      const raw = await rl.question("Proxy URL(s) to add (comma-separated): ");
      const trimmed = raw.trim();
      if (!trimmed) {
        console.log("No input provided.");
        continue;
      }

      const { proxies, invalid } = parseProxyInput(trimmed);
      if (invalid.length > 0) {
        console.log(`Invalid proxy URL(s): ${invalid.join(", ")}`);
        continue;
      }
      if (proxies.length === 0) {
        console.log("No valid proxies provided.");
        continue;
      }

      working = mergeProxyConfigs(working, proxies);
      console.log(`Added/updated ${proxies.length} proxy item(s).`);
      continue;
    }

    if (action === "d" || action === "delete") {
      if (working.length === 0) {
        console.log("No proxies to delete.");
        continue;
      }

      const selection = await rl.question(`Delete proxy number [1-${working.length}]: `);
      const proxyIndex = parseProxyIndex(selection, working.length);
      if (proxyIndex === null) {
        console.log("Invalid selection.");
        continue;
      }

      const removed = working[proxyIndex];
      working = working.filter((_, index) => index !== proxyIndex);
      console.log(`Deleted proxy: ${removed?.url ?? "unknown"}`);
      continue;
    }

    if (action === "t" || action === "toggle") {
      if (working.length === 0) {
        console.log("No proxies to toggle.");
        continue;
      }

      const selection = await rl.question(`Toggle proxy number [1-${working.length}]: `);
      const proxyIndex = parseProxyIndex(selection, working.length);
      if (proxyIndex === null) {
        console.log("Invalid selection.");
        continue;
      }

      const target = working[proxyIndex];
      if (!target) {
        console.log("Proxy not found.");
        continue;
      }

      working[proxyIndex] = target.enabled === false
        ? { url: target.url }
        : { url: target.url, enabled: false };

      const state = working[proxyIndex]?.enabled === false ? "disabled" : "enabled";
      console.log(`Proxy ${proxyIndex + 1} is now ${state}.`);
      continue;
    }

    console.log("Unknown action. Use a/d/t/c/s/x.");
  }
}

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

export async function promptOAuthProxyConfiguration(existingProxies: ProxyConfig[] = []): Promise<ProxyConfig[]> {
  const rl = createInterface({ input, output });
  try {
    if (existingProxies.length > 0) {
      const reuse = await rl.question("Reuse existing proxies for this account? [Y/n]: ");
      const reuseNormalized = reuse.trim().toLowerCase();
      if (!reuseNormalized || reuseNormalized === "y" || reuseNormalized === "yes") {
        return cloneProxies(existingProxies);
      }
    }

    const useProxy = await rl.question("Use proxy for this OAuth account before login redirect? [y/N]: ");
    const normalized = useProxy.trim().toLowerCase();
    if (!(normalized === "y" || normalized === "yes")) {
      return [];
    }

    const managed = await promptProxyManager(rl, "OAuth account", existingProxies, {
      doneLabel: "Continue OAuth with these proxy settings",
      cancelResult: [],
    });

    return managed ?? [];
  } finally {
    rl.close();
  }
}

export async function promptAccountProxyConfiguration(
  accountLabel: string,
  existingProxies: ProxyConfig[] = [],
): Promise<ProxyConfig[] | undefined> {
  const rl = createInterface({ input, output });
  try {
    return await promptProxyManager(rl, accountLabel, existingProxies, {
      doneLabel: "Save proxy settings",
      cancelResult: undefined,
    });
  } finally {
    rl.close();
  }
}

export type LoginMode = "add" | "fresh" | "manage" | "check" | "verify" | "verify-all" | "cancel";

export interface ExistingAccountInfo {
  email?: string;
  index: number;
  addedAt?: number;
  lastUsed?: number;
  status?: AccountStatus;
  isCurrentAccount?: boolean;
  enabled?: boolean;
}

export interface LoginMenuResult {
  mode: LoginMode;
  deleteAccountIndex?: number;
  refreshAccountIndex?: number;
  toggleAccountIndex?: number;
  configureProxyAccountIndex?: number;
  verifyAccountIndex?: number;
  verifyAll?: boolean;
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
      const answer = await rl.question("(a)dd new, (f)resh start, (c)heck quotas, (v)erify account, (va) verify all, manage (p)roxy? [a/f/c/v/va/p]: ");
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
      if (normalized === "p" || normalized === "proxy") {
        if (existingAccounts.length === 0) {
          console.log("No accounts available for proxy management.");
          continue;
        }

        const pick = await rl.question(`Account number to manage proxy [1-${existingAccounts.length}]: `);
        const pickedIndex = parseProxyIndex(pick, existingAccounts.length);
        if (pickedIndex === null) {
          console.log("Invalid account selection.");
          continue;
        }

        return { mode: "manage", configureProxyAccountIndex: pickedIndex };
      }

      console.log("Please enter 'a', 'f', 'c', 'v', 'va', or 'p'.");
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
        if (accountAction === "proxy") {
          return { mode: "manage", configureProxyAccountIndex: action.account.index };
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

      case "cancel":
        return { mode: "cancel" };
    }
  }
}

export { isTTY } from "./ui/auth-menu";
export type { AccountStatus } from "./ui/auth-menu";
