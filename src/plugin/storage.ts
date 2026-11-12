import { promises as fs } from "node:fs";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import type { HeaderStyle } from "../constants";
import { createLogger } from "./logger";
import {
  findLegacyStateFile,
  getAccountsPath,
  moveLegacyStateFile,
} from "./paths";

const log = createLogger("storage");

/**
 * Files/directories that should be gitignored in the plugin data directory.
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
 * Ensures a .gitignore file exists in the plugin data directory with entries
 * for sensitive files. Creates the file if missing, or appends missing
 * entries if it already exists.
 */
export async function ensureGitignore(directory: string): Promise<void> {
  const gitignorePath = join(directory, ".gitignore");

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
      log.info("Created .gitignore in plugin data directory");
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
export function ensureGitignoreSync(directory: string): void {
  const gitignorePath = join(directory, ".gitignore");

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
      log.info("Created .gitignore in plugin data directory");
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

export type CooldownReason = "auth-failure" | "network-error" | "project-error" | "validation-required";

export interface AccountMetadataV3 {
  /** Stable menu identity, preserved when OAuth refresh tokens rotate. */
  id?: string;
  /** Hashes identify native connections that still hold an older OAuth token. */
  refreshTokenHashes?: string[];
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
  fingerprintHistory?: import("./fingerprint").FingerprintVersion[];
  /** Set when Google asks the user to verify this account before requests can continue. */
  verificationRequired?: boolean;
  verificationRequiredAt?: number;
  verificationRequiredReason?: string;
  verificationUrl?: string;
  /** Cached soft quota data */
  cachedQuota?: Record<string, { remainingFraction?: number; resetTime?: string; remainingFractionResetTime?: string; modelCount: number }>;
  cachedQuotaUpdatedAt?: number;
}

export const accountTokenHash = (token: string): string => createHash("sha256").update(token).digest("hex").slice(0, 24);

export function matchesAccountToken(account: AccountMetadataV3, token: string): boolean {
  const hash = accountTokenHash(token);
  return account.refreshToken === token || account.id === hash || account.refreshTokenHashes?.includes(hash) === true;
}

/** Update credentials without losing the identity of older native connections. */
export function updateAccountCredentials(account: AccountMetadataV3, parts: { refreshToken?: string; projectId?: string; managedProjectId?: string }): void {
  account.id ??= accountTokenHash(account.refreshToken);
  if (parts.refreshToken && parts.refreshToken !== account.refreshToken) {
    account.refreshTokenHashes = [...new Set([...(account.refreshTokenHashes ?? []), accountTokenHash(account.refreshToken)])];
    account.refreshToken = parts.refreshToken;
  }
  if (parts.projectId !== undefined) account.projectId = parts.projectId;
  if (parts.managedProjectId !== undefined) account.managedProjectId = parts.managedProjectId;
}

export async function saveAccountCredentials(original: AccountMetadataV3, updated: AccountMetadataV3): Promise<AccountStorageV4 | null> {
  return updateAccounts(storage => {
    const current = storage.accounts.find(account => original.id ? account.id === original.id : account.refreshToken === original.refreshToken);
    if (current?.refreshToken === original.refreshToken) updateAccountCredentials(current, updated);
  });
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

export interface AccountStorageV4 {
  version: 4;
  accounts: AccountMetadataV3[];
  activeIndex: number;
  activeIndexByFamily?: {
    claude?: number;
    gemini?: number;
  };
}

type AnyAccountStorage =
  | AccountStorageV1
  | AccountStorage
  | AccountStorageV3
  | AccountStorageV4;

/**
 * Resolves the account file and moves an older copy into the plugin data directory.
 * The data directory belongs to the plugin; the config directory belongs to
 * OpenCode and is watched for changes.
 */
function getStoragePathWithMigration(): string {
  const target = getAccountsPath();
  const move = moveLegacyStateFile("antigravity-accounts.json");

  if (move?.moved) {
    log.info("Moved account storage into the plugin data directory", {
      from: move.from,
      to: move.to,
    });
  }

  if (existsSync(target)) {
    return target;
  }

  // Keep working if the move failed, even though that path is not ideal.
  const legacyPath = findLegacyStateFile("antigravity-accounts.json");
  if (legacyPath) {
    log.warn("Could not move account storage; using the legacy path", {
      legacyPath,
      target,
    });
    return legacyPath;
  }

  return target;
}

export function getStoragePath(): string {
  return getStoragePathWithMigration();
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
 * Ensures the file has secure permissions (0600) on POSIX systems.
 * This is a best-effort operation and ignores errors on Windows/unsupported FS.
 */
async function ensureSecurePermissions(path: string): Promise<void> {
  try {
    await fs.chmod(path, 0o600);
  } catch {
    // Ignore errors (e.g. Windows, file doesn't exist, FS doesn't support chmod)
  }
}

async function ensureFileExists(path: string): Promise<void> {
  try {
    await fs.access(path);
  } catch {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(
      path,
      JSON.stringify({ version: 4, accounts: [], activeIndex: 0 }, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
  }
}

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

function mergeAccountStorage(
  existing: AccountStorageV4,
  incoming: AccountStorageV4,
): AccountStorageV4 {
  const accountMap = new Map<string, AccountMetadataV3>();

  for (const acc of existing.accounts) {
    if (acc.refreshToken) {
      accountMap.set(acc.refreshToken, acc);
    }
  }

  for (const acc of incoming.accounts) {
    if (acc.refreshToken) {
      let existingAcc = accountMap.get(acc.refreshToken);
      if (!existingAcc && acc.id) {
        for (const [token, previous] of accountMap) {
          if (previous.id === acc.id) {
            existingAcc = previous;
            accountMap.delete(token);
            break;
          }
        }
      }
      if (existingAcc) {
        accountMap.set(acc.refreshToken, {
          ...existingAcc,
          ...acc,
          id: existingAcc.id ?? acc.id,
          // Preserve manually configured projectId/managedProjectId if not in incoming
          projectId: acc.projectId ?? existingAcc.projectId,
          managedProjectId: acc.managedProjectId ?? existingAcc.managedProjectId,
          rateLimitResetTimes: {
            ...existingAcc.rateLimitResetTimes,
            ...acc.rateLimitResetTimes,
          },
          lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
        });
      } else {
        accountMap.set(acc.refreshToken, acc);
      }
    }
  }

  return normalizeAccountStorage(incoming, Array.from(accountMap.values()));
}

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

/** Preserve selected account identities when filtering, deduplicating, or merging. */
function normalizeAccountStorage(
  storage: AccountStorageV4,
  candidateAccounts = storage.accounts,
): AccountStorageV4 {
  const accounts = deduplicateAccountsByEmail(
    candidateAccounts.filter(
      (account): account is AccountMetadataV3 =>
        !!account &&
        typeof account === "object" &&
        typeof account.refreshToken === "string",
    ),
  );

  const remapIndex = (index: unknown, fallback: number): number => {
    const selected =
      typeof index === "number" && Number.isInteger(index) && index >= 0
        ? storage.accounts[index]
        : undefined;
    if (selected && typeof selected.refreshToken === "string") {
      const tokenIndex = accounts.findIndex(
        (account) => account.refreshToken === selected.refreshToken,
      );
      if (tokenIndex >= 0) return tokenIndex;

      // A newer login for the same email may have replaced the selected token.
      const emailIndex = selected.email
        ? accounts.findIndex((account) => account.email === selected.email)
        : -1;
      if (emailIndex >= 0) return emailIndex;
    }
    return fallback;
  };

  const activeIndex = remapIndex(storage.activeIndex, 0);
  const activeIndexByFamily = storage.activeIndexByFamily
    ? { ...storage.activeIndexByFamily }
    : undefined;
  for (const family of ["claude", "gemini"] as const) {
    if (activeIndexByFamily?.[family] !== undefined) {
      activeIndexByFamily[family] = remapIndex(activeIndexByFamily[family], activeIndex);
    }
  }

  return { version: 4, accounts, activeIndex, activeIndexByFamily };
}

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

export function migrateV3ToV4(v3: AccountStorageV3): AccountStorageV4 {
  return {
    version: 4,
    accounts: v3.accounts.map((acc) => ({
      ...acc,
      fingerprint: undefined,
      fingerprintHistory: undefined,
    })),
    activeIndex: v3.activeIndex,
    activeIndexByFamily: v3.activeIndexByFamily,
  };
}

export async function loadAccounts(): Promise<AccountStorageV4 | null> {
  try {
    const path = getStoragePath();
    // Ensure permissions are correct on load (fixes existing files)
    await ensureSecurePermissions(path);

    const content = await fs.readFile(path, "utf-8");
    const data = JSON.parse(content) as AnyAccountStorage;

    if (!Array.isArray(data.accounts)) {
      log.warn("Invalid storage format, ignoring");
      return null;
    }

    let storage: AccountStorageV4;

    if (data.version === 1) {
      log.info("Migrating account storage from v1 to v4");
      const v2 = migrateV1ToV2(data);
      const v3 = migrateV2ToV3(v2);
      storage = migrateV3ToV4(v3);
    } else if (data.version === 2) {
      log.info("Migrating account storage from v2 to v4");
      const v3 = migrateV2ToV3(data);
      storage = migrateV3ToV4(v3);
    } else if (data.version === 3) {
      log.info("Migrating account storage from v3 to v4");
      storage = migrateV3ToV4(data);
    } else if (data.version === 4) {
      storage = data;
    } else {
      log.warn("Unknown storage version, ignoring", {
        version: (data as { version?: unknown }).version,
      });
      return null;
    }

    storage = normalizeAccountStorage(storage);
    if (data.version !== 4) {
      try {
        await saveAccounts(storage);
        log.info("Migration to v4 complete");
      } catch (saveError) {
        log.warn("Failed to persist migrated storage", {
          error: String(saveError),
        });
      }
    }

    return storage;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    log.error("Failed to load account storage", { error: String(error) });
    return null;
  }
}

export async function saveAccounts(storage: AccountStorageV4): Promise<void> {
  const path = getStoragePath();
  const configDir = dirname(path);
  await fs.mkdir(configDir, { recursive: true });
  await ensureGitignore(configDir);

  await withFileLock(path, async () => {
    const existing = await loadAccountsUnsafe();
    const merged = existing
      ? mergeAccountStorage(existing, storage)
      : normalizeAccountStorage(storage);

    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const content = JSON.stringify(merged, null, 2);

    try {
      await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
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

/** Apply a targeted change to the latest pool while holding its file lock. */
export async function updateAccounts(update: (storage: AccountStorageV4) => void): Promise<AccountStorageV4 | null> {
  const path = getStoragePath();
  await fs.mkdir(dirname(path), { recursive: true });
  await ensureGitignore(dirname(path));
  return withFileLock(path, async () => {
    const storage = await loadAccountsUnsafe();
    if (!storage) return null;
    update(storage);
    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(storage, null, 2), { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tempPath, path);
    } catch (error) {
      try { await fs.unlink(tempPath); } catch { /* The temporary file may not exist. */ }
      throw error;
    }
    return storage;
  });
}

/**
 * Save accounts storage by replacing the entire file (no merge).
 * Use this for destructive operations like delete where we need to
 * remove accounts that would otherwise be merged back from existing storage.
 */
export async function saveAccountsReplace(storage: AccountStorageV4): Promise<void> {
  const path = getStoragePath();
  const configDir = dirname(path);
  await fs.mkdir(configDir, { recursive: true });
  await ensureGitignore(configDir);

  await withFileLock(path, async () => {
    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const content = JSON.stringify(storage, null, 2);

    try {
      await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tempPath, path);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  });
}

async function loadAccountsUnsafe(): Promise<AccountStorageV4 | null> {
  try {
    const path = getStoragePath();
    // Ensure permissions are correct on load (fixes existing files)
    await ensureSecurePermissions(path);

    const content = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(content) as AnyAccountStorage;

    if (!Array.isArray(parsed.accounts)) return null;

    if (parsed.version === 1) {
      return normalizeAccountStorage(migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(parsed))));
    }
    if (parsed.version === 2) {
      return normalizeAccountStorage(migrateV3ToV4(migrateV2ToV3(parsed)));
    }
    if (parsed.version === 3) {
      return normalizeAccountStorage(migrateV3ToV4(parsed));
    }

    return parsed.version === 4 ? normalizeAccountStorage(parsed) : null;
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
