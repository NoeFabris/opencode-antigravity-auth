import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { createLogger } from "./logger";
const log = createLogger("storage");
function getConfigDir() {
    const platform = process.platform;
    if (platform === "win32") {
        return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
    }
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(xdgConfig, "opencode");
}
export function getStoragePath() {
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
async function ensureFileExists(path) {
    try {
        await fs.access(path);
    }
    catch {
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(path, JSON.stringify({ version: 3, accounts: [], activeIndex: 0 }, null, 2), "utf-8");
    }
}
async function withFileLock(path, fn) {
    await ensureFileExists(path);
    let release = null;
    try {
        release = await lockfile.lock(path, LOCK_OPTIONS);
        return await fn();
    }
    finally {
        if (release) {
            try {
                await release();
            }
            catch (unlockError) {
                log.warn("Failed to release lock", { error: String(unlockError) });
            }
        }
    }
}
function mergeAccountStorage(existing, incoming) {
    const accountMap = new Map();
    for (const acc of existing.accounts) {
        if (acc.refreshToken) {
            accountMap.set(acc.refreshToken, acc);
        }
    }
    for (const acc of incoming.accounts) {
        if (acc.refreshToken) {
            const existingAcc = accountMap.get(acc.refreshToken);
            if (existingAcc) {
                accountMap.set(acc.refreshToken, {
                    ...existingAcc,
                    ...acc,
                    rateLimitResetTimes: {
                        ...existingAcc.rateLimitResetTimes,
                        ...acc.rateLimitResetTimes,
                    },
                    lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
                });
            }
            else {
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
export function deduplicateAccountsByEmail(accounts) {
    const emailToNewestIndex = new Map();
    const indicesToKeep = new Set();
    // First pass: find the newest account for each email (by lastUsed, then addedAt)
    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        if (!acc)
            continue;
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
        const isNewer = currLastUsed > existLastUsed ||
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
    const result = [];
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
function migrateV1ToV2(v1) {
    return {
        version: 2,
        accounts: v1.accounts.map((acc) => {
            const rateLimitResetTimes = {};
            if (acc.isRateLimited && acc.rateLimitResetTime && acc.rateLimitResetTime > Date.now()) {
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
                rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : undefined,
            };
        }),
        activeIndex: v1.activeIndex,
    };
}
export function migrateV2ToV3(v2) {
    return {
        version: 3,
        accounts: v2.accounts.map((acc) => {
            const rateLimitResetTimes = {};
            if (acc.rateLimitResetTimes?.claude && acc.rateLimitResetTimes.claude > Date.now()) {
                rateLimitResetTimes.claude = acc.rateLimitResetTimes.claude;
            }
            if (acc.rateLimitResetTimes?.gemini && acc.rateLimitResetTimes.gemini > Date.now()) {
                rateLimitResetTimes["gemini-antigravity"] = acc.rateLimitResetTimes.gemini;
            }
            return {
                email: acc.email,
                refreshToken: acc.refreshToken,
                projectId: acc.projectId,
                managedProjectId: acc.managedProjectId,
                addedAt: acc.addedAt,
                lastUsed: acc.lastUsed,
                lastSwitchReason: acc.lastSwitchReason,
                rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : undefined,
            };
        }),
        activeIndex: v2.activeIndex,
    };
}
export async function loadAccounts() {
    try {
        const path = getStoragePath();
        const content = await fs.readFile(path, "utf-8");
        const data = JSON.parse(content);
        if (!Array.isArray(data.accounts)) {
            log.warn("Invalid storage format, ignoring");
            return null;
        }
        let storage;
        if (data.version === 1) {
            log.info("Migrating account storage from v1 to v3");
            const v2 = migrateV1ToV2(data);
            storage = migrateV2ToV3(v2);
            try {
                await saveAccounts(storage);
                log.info("Migration to v3 complete");
            }
            catch (saveError) {
                log.warn("Failed to persist migrated storage", { error: String(saveError) });
            }
        }
        else if (data.version === 2) {
            log.info("Migrating account storage from v2 to v3");
            storage = migrateV2ToV3(data);
            try {
                await saveAccounts(storage);
                log.info("Migration to v3 complete");
            }
            catch (saveError) {
                log.warn("Failed to persist migrated storage", { error: String(saveError) });
            }
        }
        else if (data.version === 3) {
            storage = data;
        }
        else {
            log.warn("Unknown storage version, ignoring", {
                version: data.version,
            });
            return null;
        }
        // Validate accounts have required fields
        const validAccounts = storage.accounts.filter((a) => {
            return !!a && typeof a === "object" && typeof a.refreshToken === "string";
        });
        // Deduplicate accounts by email (keeps newest entry for each email)
        const deduplicatedAccounts = deduplicateAccountsByEmail(validAccounts);
        // Clamp activeIndex to valid range after deduplication
        let activeIndex = typeof storage.activeIndex === "number" && Number.isFinite(storage.activeIndex) ? storage.activeIndex : 0;
        if (deduplicatedAccounts.length > 0) {
            activeIndex = Math.min(activeIndex, deduplicatedAccounts.length - 1);
            activeIndex = Math.max(activeIndex, 0);
        }
        else {
            activeIndex = 0;
        }
        return {
            version: 3,
            accounts: deduplicatedAccounts,
            activeIndex,
        };
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT") {
            return null;
        }
        log.error("Failed to load account storage", { error: String(error) });
        return null;
    }
}
export async function saveAccounts(storage) {
    const path = getStoragePath();
    await withFileLock(path, async () => {
        const existing = await loadAccountsUnsafe();
        const merged = existing ? mergeAccountStorage(existing, storage) : storage;
        const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
        const content = JSON.stringify(merged, null, 2);
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(tempPath, content, "utf-8");
        await fs.rename(tempPath, path);
    });
}
async function loadAccountsUnsafe() {
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
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT") {
            return null;
        }
        return null;
    }
}
export async function clearAccounts() {
    try {
        const path = getStoragePath();
        await fs.unlink(path);
    }
    catch (error) {
        const code = error.code;
        if (code !== "ENOENT") {
            log.error("Failed to clear account storage", { error: String(error) });
        }
    }
}
//# sourceMappingURL=storage.js.map