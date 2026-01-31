import { promises as fs } from "node:fs";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import type { HeaderStyle } from "../constants";
import type { Fingerprint } from "./fingerprint";
import { createLogger } from "./logger";

const log = createLogger("storage");

/**
 * Files/directories that should be gitignored in the config directory.
 * These contain sensitive data or machine-specific state.
 */
export const GITIGNORE_ENTRIES = [
  ".gitignore",
  "antigravity-accounts.json",
  "antigravity-accounts.json.*.tmp",
  "antigravity-signature-cache.json",
  "antigravity-logs/",
];

/**
 * Ensures a .gitignore file exists in the config directory with entries
 * for sensitive files. Creates the file if missing, or appends missing
 * entries if it already exists.
 */
export async function ensureGitignore(configDir: string): Promise<void> {
  const gitignorePath = join(configDir, ".gitignore");

  try {
    let content: string;
    let existingLines: string[] = [];

    try {
      content = await fs.readFile(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return;
      }
      content = "";
    }

    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) => !existingLines.includes(entry),
    );

    if (missingEntries.length === 0) {
      return;
    }

    if (content === "") {
      await fs.writeFile(
        gitignorePath,
        missingEntries.join("\n") + "\n",
        "utf-8",
      );
      log.info("Created .gitignore in config directory");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      await fs.appendFile(
        gitignorePath,
        suffix + missingEntries.join("\n") + "\n",
        "utf-8",
      );
      log.info("Updated .gitignore with missing entries", {
        added: missingEntries,
      });
    }
  } catch {
    // Non-critical feature
  }
}

/**
 * Synchronous version of ensureGitignore for use in sync code paths.
 */
export function ensureGitignoreSync(configDir: string): void {
  const gitignorePath = join(configDir, ".gitignore");

  try {
    let content: string;
    let existingLines: string[] = [];

    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    } else {
      content = "";
    }

    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) => !existingLines.includes(entry),
    );

    if (missingEntries.length === 0) {
      return;
    }

    if (content === "") {
      writeFileSync(gitignorePath, missingEntries.join("\n") + "\n", "utf-8");
      log.info("Created .gitignore in config directory");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      appendFileSync(
        gitignorePath,
        suffix + missingEntries.join("\n") + "\n",
        "utf-8",
      );
      log.info("Updated .gitignore with missing entries", {
        added: missingEntries,
      });
    }
  } catch {
    // Non-critical feature
  }
}

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
  enabled?: boolean;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitStateV3;
  coolingDownUntil?: number;
  cooldownReason?: CooldownReason;
  /** Per-account device fingerprint for rate limit mitigation */
  fingerprint?: import("./fingerprint").Fingerprint;
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

type AnyAccountStorage = AccountStorageV1 | AccountStorage | AccountStorageV3;

/**
 * Resolves the absolute path to the directory where OpenCode configuration is stored.
 * OS-aware: handles Windows AppData vs Unix .config.
 * @returns The directory path.
 */
function getConfigDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "opencode",
    );
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/**
 * Resolves the absolute path to the antigravity-accounts.json file.
 * @returns The absolute file path.
 */
export function getStoragePath(): string {
  return join(getConfigDir(), "antigravity-accounts.json");
}

const LOCK_OPTIONS = {
  stale: 10000,
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000,
    factor: 2,
  },
};

/**
 * Ensures the target file exists. Creates the file with an empty initial storage state if it doesn't.
 * @param path - The absolute path to the file.
 */
async function ensureFileExists(path: string): Promise<void> {
  try {
    await fs.access(path);
  } catch {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(
      path,
      JSON.stringify({ version: 3, accounts: [], activeIndex: 0 }, null, 2),
      "utf-8",
    );
  }
}

/**
 * Executes a function within a file lock to ensure exclusive access to the target file.
 * @param path - The absolute path to the file to lock.
 * @param fn - The asynchronous function to execute.
 * @returns The result of the function.
 */
async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await ensureFileExists(path);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(path, LOCK_OPTIONS);
    return await fn();
  } finally {
    if (release) {
      try {
        await release();
      } catch (unlockError) {
        log.warn("Failed to release lock", { error: String(unlockError) });
      }
    }
  }
}

/**
 * Merges two account storage objects, deduplicating accounts by refresh token.
 * Prioritizes fingerprints with newer Antigravity version strings.
 * @param existing - The current storage object.
 * @param incoming - The new storage object to merge in.
 * @returns The merged storage object.
 */
function mergeAccountStorage(
  existing: AccountStorageV3,
  incoming: AccountStorageV3,
): AccountStorageV3 {
  const accountMap = new Map<string, AccountMetadataV3>();

  for (const acc of existing.accounts) {
    if (acc.refreshToken) {
      accountMap.set(acc.refreshToken, acc);
    }
  }

  for (const acc of incoming.accounts) {
    if (acc.refreshToken) {
      const existingAcc = accountMap.get(acc.refreshToken);
      if (existingAcc) {
        const mergedFingerprint = mergeFingerprint(existingAcc.fingerprint, acc.fingerprint);
        accountMap.set(acc.refreshToken, {
          ...existingAcc,
          ...acc,
          // Preserve manually configured projectId/managedProjectId if not in incoming
          projectId: acc.projectId ?? existingAcc.projectId,
          managedProjectId: acc.managedProjectId ?? existingAcc.managedProjectId,
          rateLimitResetTimes: {
            ...existingAcc.rateLimitResetTimes,
            ...acc.rateLimitResetTimes,
          },
          lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
          // Prevent stale processes from downgrading fingerprints back to an older Antigravity version.
          fingerprint: mergedFingerprint,
        });
      } else {
        accountMap.set(acc.refreshToken, acc);
      }
    }
  }

  return {
    version: 3,
    accounts: Array.from(accountMap.values()),
    activeIndex: incoming.activeIndex,
    activeIndexByFamily: incoming.activeIndexByFamily,
  };
}

/**
 * Parses the Antigravity version number from a User-Agent string.
 * @param userAgent - The User-Agent string to parse.
 * @returns An array of version parts [major, minor, patch] or null if not found.
 */
function parseAntigravityVersion(userAgent: string | undefined): number[] | null {
  if (!userAgent) return null;
  const match = userAgent.match(/\bantigravity\/(\d+(?:\.\d+)*)\b/i);
  if (!match) return null;
  const parts = match[1]!.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

/**
 * Compares two version arrays.
 * @param a - The first version array.
 * @param b - The second version array.
 * @returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

/**
 * Merges two device fingerprints, prioritizing the one with the newer Antigravity version.
 * This prevents stale processes from downgrading account fingerprints.
 * @param existing - The current fingerprint in storage.
 * @param incoming - The new fingerprint being saved.
 * @returns The preferred fingerprint.
 */
function mergeFingerprint(existing?: Fingerprint, incoming?: Fingerprint): Fingerprint | undefined {
  if (!incoming) return existing;
  if (!existing) return incoming;

  const existingVersion = parseAntigravityVersion(existing.userAgent);
  const incomingVersion = parseAntigravityVersion(incoming.userAgent);

  // Prefer a parseable Antigravity version when possible.
  if (existingVersion && !incomingVersion) return existing;
  if (!existingVersion && incomingVersion) return incoming;

  if (existingVersion && incomingVersion) {
    const cmp = compareVersions(existingVersion, incomingVersion);
    if (cmp > 0) return existing;
    if (cmp < 0) return incoming;
  }

  // Tie-breaker: use createdAt if both have it.
  // This prevents stale processes on the same version from overwriting newer fingerprints.
  const existingCreatedAt = Number.isFinite(existing.createdAt) ? existing.createdAt : undefined;
  const incomingCreatedAt = Number.isFinite(incoming.createdAt) ? incoming.createdAt : undefined;

  if (existingCreatedAt !== undefined && incomingCreatedAt !== undefined) {
    return existingCreatedAt >= incomingCreatedAt ? existing : incoming;
  }

  // Default to existing behavior (incoming overwrites) when versions are equal/unknown.
  return incoming;
}

/**
 * Deduplicates a list of accounts by their email address.
 * Keeps the newest account for each email based on lastUsed and addedAt timestamps.
 * @param accounts - The list of accounts to deduplicate.
 * @returns The deduplicated list.
 */
export function deduplicateAccountsByEmail<
  T extends { email?: string; lastUsed?: number; addedAt?: number },
>(accounts: T[]): T[] {
  const emailToNewestIndex = new Map<string, number>();
  const indicesToKeep = new Set<number>();

  // First pass: find the newest account for each email (by lastUsed, then addedAt)
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (!acc) continue;

    if (!acc.email) {
      // No email - keep this account (can't deduplicate without email)
      indicesToKeep.add(i);
      continue;
    }

    const existingIndex = emailToNewestIndex.get(acc.email);
    if (existingIndex === undefined) {
      emailToNewestIndex.set(acc.email, i);
      continue;
    }

    // Compare to find which is newer
    const existing = accounts[existingIndex];
    if (!existing) {
      emailToNewestIndex.set(acc.email, i);
      continue;
    }

    // Prefer higher lastUsed, then higher addedAt
    // Compare fields separately to avoid integer overflow with large timestamps
    const currLastUsed = acc.lastUsed || 0;
    const existLastUsed = existing.lastUsed || 0;
    const currAddedAt = acc.addedAt || 0;
    const existAddedAt = existing.addedAt || 0;

    const isNewer =
      currLastUsed > existLastUsed ||
      (currLastUsed === existLastUsed && currAddedAt > existAddedAt);

    if (isNewer) {
      emailToNewestIndex.set(acc.email, i);
    }
  }

  // Add all the newest email-based indices to the keep set
  for (const idx of emailToNewestIndex.values()) {
    indicesToKeep.add(idx);
  }

  // Build the deduplicated list, preserving original order for kept items
  const result: T[] = [];
  for (let i = 0; i < accounts.length; i++) {
    if (indicesToKeep.has(i)) {
      const acc = accounts[i];
      if (acc) {
        result.push(acc);
      }
    }
  }

  return result;
}

/**
 * Migrates account storage from V1 schema to V2.
 * @param v1 - The storage object in V1 format.
 * @returns The migrated V2 storage object.
 */
function migrateV1ToV2(v1: AccountStorageV1): AccountStorage {
  return {
    version: 2,
    accounts: v1.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitState = {};
      if (
        acc.isRateLimited &&
        acc.rateLimitResetTime &&
        acc.rateLimitResetTime > Date.now()
      ) {
        rateLimitResetTimes.claude = acc.rateLimitResetTime;
        rateLimitResetTimes.gemini = acc.rateLimitResetTime;
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes:
          Object.keys(rateLimitResetTimes).length > 0
            ? rateLimitResetTimes
            : undefined,
      };
    }),
    activeIndex: v1.activeIndex,
  };
}

/**
 * Migrates account storage from V2 schema to V3.
 * @param v2 - The storage object in V2 format.
 * @returns The migrated V3 storage object.
 */
export function migrateV2ToV3(v2: AccountStorage): AccountStorageV3 {
  return {
    version: 3,
    accounts: v2.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitStateV3 = {};
      if (
        acc.rateLimitResetTimes?.claude &&
        acc.rateLimitResetTimes.claude > Date.now()
      ) {
        rateLimitResetTimes.claude = acc.rateLimitResetTimes.claude;
      }
      if (
        acc.rateLimitResetTimes?.gemini &&
        acc.rateLimitResetTimes.gemini > Date.now()
      ) {
        rateLimitResetTimes["gemini-antigravity"] =
          acc.rateLimitResetTimes.gemini;
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes:
          Object.keys(rateLimitResetTimes).length > 0
            ? rateLimitResetTimes
            : undefined,
      };
    }),
    activeIndex: v2.activeIndex,
  };
}

/**
 * Asynchronously loads account data from the persistent storage file.
 * Handles schema migration automatically if an older version is detected.
 * @returns A promise resolving to the storage object or null if not found.
 */
export async function loadAccounts(): Promise<AccountStorageV3 | null> {
  try {
    const path = getStoragePath();
    const content = await fs.readFile(path, "utf-8");
    const data = JSON.parse(content) as AnyAccountStorage;

    if (!Array.isArray(data.accounts)) {
      log.warn("Invalid storage format, ignoring");
      return null;
    }

    let storage: AccountStorageV3;

    if (data.version === 1) {
      log.info("Migrating account storage from v1 to v3");
      const v2 = migrateV1ToV2(data);
      storage = migrateV2ToV3(v2);
      try {
        await saveAccounts(storage);
        log.info("Migration to v3 complete");
      } catch (saveError) {
        log.warn("Failed to persist migrated storage", {
          error: String(saveError),
        });
      }
    } else if (data.version === 2) {
      log.info("Migrating account storage from v2 to v3");
      storage = migrateV2ToV3(data);
      try {
        await saveAccounts(storage);
        log.info("Migration to v3 complete");
      } catch (saveError) {
        log.warn("Failed to persist migrated storage", {
          error: String(saveError),
        });
      }
    } else if (data.version === 3) {
      storage = data;
    } else {
      log.warn("Unknown storage version, ignoring", {
        version: (data as { version?: unknown }).version,
      });
      return null;
    }

    // Validate accounts have required fields
    const validAccounts = storage.accounts.filter(
      (a): a is AccountMetadataV3 => {
        return (
          !!a &&
          typeof a === "object" &&
          typeof (a as AccountMetadataV3).refreshToken === "string"
        );
      },
    );

    // Deduplicate accounts by email (keeps newest entry for each email)
    const deduplicatedAccounts = deduplicateAccountsByEmail(validAccounts);

    // Clamp activeIndex to valid range after deduplication
    let activeIndex =
      typeof storage.activeIndex === "number" &&
      Number.isFinite(storage.activeIndex)
        ? storage.activeIndex
        : 0;
    if (deduplicatedAccounts.length > 0) {
      activeIndex = Math.min(activeIndex, deduplicatedAccounts.length - 1);
      activeIndex = Math.max(activeIndex, 0);
    } else {
      activeIndex = 0;
    }

    return {
      version: 3,
      accounts: deduplicatedAccounts,
      activeIndex,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    log.error("Failed to load account storage", { error: String(error) });
    return null;
  }
}

/**
 * Asynchronously saves account data to the persistent storage file.
 * Uses a temporary file and atomic rename (plus locking) to ensure data integrity.
 * @param storage - The storage object to save.
 */
export async function saveAccounts(storage: AccountStorageV3): Promise<void> {
  const path = getStoragePath();
  const configDir = dirname(path);
  await fs.mkdir(configDir, { recursive: true });
  await ensureGitignore(configDir);

  await withFileLock(path, async () => {
    const existing = await loadAccountsUnsafe();
    const merged = existing ? mergeAccountStorage(existing, storage) : storage;

    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const content = JSON.stringify(merged, null, 2);

    try {
      await fs.writeFile(tempPath, content, "utf-8");
      await fs.rename(tempPath, path);
    } catch (error) {
      // Clean up temp file on failure to prevent accumulation
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors (file may not exist)
      }
      throw error;
    }
  });
}

async function loadAccountsUnsafe(): Promise<AccountStorageV3 | null> {
  try {
    const path = getStoragePath();
    const content = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(content);

    if (parsed.version === 1) {
      return migrateV2ToV3(migrateV1ToV2(parsed));
    }
    if (parsed.version === 2) {
      return migrateV2ToV3(parsed);
    }

    return {
      ...parsed,
      accounts: deduplicateAccountsByEmail(parsed.accounts),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function clearAccounts(): Promise<void> {
  try {
    const path = getStoragePath();
    await fs.unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.error("Failed to clear account storage", { error: String(error) });
    }
  }
}
