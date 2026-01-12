import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, NPM_REGISTRY_URL, NPM_FETCH_TIMEOUT, INSTALLED_PACKAGE_JSON, USER_OPENCODE_CONFIG, USER_OPENCODE_CONFIG_JSONC, } from "./constants";
import { debugLogToFile } from "../../plugin/debug";
function debugLog(message) {
    debugLogToFile(message);
}
export function isLocalDevMode(directory) {
    return getLocalDevPath(directory) !== null;
}
function stripJsonComments(json) {
    return json
        .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => (g ? "" : m))
        .replace(/,(\s*[}\]])/g, "$1");
}
function getConfigPaths(directory) {
    return [
        path.join(directory, ".opencode", "opencode.json"),
        path.join(directory, ".opencode", "opencode.jsonc"),
        path.join(directory, ".opencode.json"),
        USER_OPENCODE_CONFIG,
        USER_OPENCODE_CONFIG_JSONC,
    ];
}
export function getLocalDevPath(directory) {
    for (const configPath of getConfigPaths(directory)) {
        try {
            if (!fs.existsSync(configPath))
                continue;
            const content = fs.readFileSync(configPath, "utf-8");
            const config = JSON.parse(stripJsonComments(content));
            const plugins = config.plugin ?? [];
            for (const entry of plugins) {
                if (entry.startsWith("file://") && entry.includes(PACKAGE_NAME)) {
                    try {
                        return fileURLToPath(entry);
                    }
                    catch {
                        return entry.replace("file://", "");
                    }
                }
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
function findPackageJsonUp(startPath) {
    try {
        const stat = fs.statSync(startPath);
        let dir = stat.isDirectory() ? startPath : path.dirname(startPath);
        for (let i = 0; i < 10; i++) {
            const pkgPath = path.join(dir, "package.json");
            if (fs.existsSync(pkgPath)) {
                try {
                    const content = fs.readFileSync(pkgPath, "utf-8");
                    const pkg = JSON.parse(content);
                    if (pkg.name === PACKAGE_NAME)
                        return pkgPath;
                }
                catch {
                    continue;
                }
            }
            const parent = path.dirname(dir);
            if (parent === dir)
                break;
            dir = parent;
        }
    }
    catch {
        return null;
    }
    return null;
}
export function getLocalDevVersion(directory) {
    const localPath = getLocalDevPath(directory);
    if (!localPath)
        return null;
    try {
        const pkgPath = findPackageJsonUp(localPath);
        if (!pkgPath)
            return null;
        const content = fs.readFileSync(pkgPath, "utf-8");
        const pkg = JSON.parse(content);
        return pkg.version ?? null;
    }
    catch {
        return null;
    }
}
export function findPluginEntry(directory) {
    for (const configPath of getConfigPaths(directory)) {
        try {
            if (!fs.existsSync(configPath))
                continue;
            const content = fs.readFileSync(configPath, "utf-8");
            const config = JSON.parse(stripJsonComments(content));
            const plugins = config.plugin ?? [];
            for (const entry of plugins) {
                if (entry === PACKAGE_NAME) {
                    return { entry, isPinned: false, pinnedVersion: null, configPath };
                }
                if (entry.startsWith(`${PACKAGE_NAME}@`)) {
                    const pinnedVersion = entry.slice(PACKAGE_NAME.length + 1);
                    const isPinned = pinnedVersion !== "latest";
                    return { entry, isPinned, pinnedVersion: isPinned ? pinnedVersion : null, configPath };
                }
                if (entry.startsWith("file://") && entry.includes(PACKAGE_NAME)) {
                    return { entry, isPinned: false, pinnedVersion: null, configPath };
                }
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
export function getCachedVersion() {
    try {
        if (fs.existsSync(INSTALLED_PACKAGE_JSON)) {
            const content = fs.readFileSync(INSTALLED_PACKAGE_JSON, "utf-8");
            const pkg = JSON.parse(content);
            if (pkg.version)
                return pkg.version;
        }
    }
    catch {
        return null;
    }
    try {
        const currentDir = path.dirname(fileURLToPath(import.meta.url));
        const pkgPath = findPackageJsonUp(currentDir);
        if (pkgPath) {
            const content = fs.readFileSync(pkgPath, "utf-8");
            const pkg = JSON.parse(content);
            if (pkg.version)
                return pkg.version;
        }
    }
    catch (err) {
        debugLog(`[auto-update-checker] Failed to resolve version from current directory: ${err}`);
    }
    return null;
}
export function updatePinnedVersion(configPath, oldEntry, newVersion) {
    try {
        const content = fs.readFileSync(configPath, "utf-8");
        const newEntry = `${PACKAGE_NAME}@${newVersion}`;
        const pluginMatch = content.match(/"plugin"\s*:\s*\[/);
        if (!pluginMatch || pluginMatch.index === undefined) {
            debugLog(`[auto-update-checker] No "plugin" array found in ${configPath}`);
            return false;
        }
        const startIdx = pluginMatch.index + pluginMatch[0].length;
        let bracketCount = 1;
        let endIdx = startIdx;
        for (let i = startIdx; i < content.length && bracketCount > 0; i++) {
            if (content[i] === "[")
                bracketCount++;
            else if (content[i] === "]")
                bracketCount--;
            endIdx = i;
        }
        const before = content.slice(0, startIdx);
        const pluginArrayContent = content.slice(startIdx, endIdx);
        const after = content.slice(endIdx);
        const escapedOldEntry = oldEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`["']${escapedOldEntry}["']`);
        if (!regex.test(pluginArrayContent)) {
            debugLog(`[auto-update-checker] Entry "${oldEntry}" not found in plugin array of ${configPath}`);
            return false;
        }
        const updatedPluginArray = pluginArrayContent.replace(regex, `"${newEntry}"`);
        const updatedContent = before + updatedPluginArray + after;
        if (updatedContent === content) {
            debugLog(`[auto-update-checker] No changes made to ${configPath}`);
            return false;
        }
        fs.writeFileSync(configPath, updatedContent, "utf-8");
        debugLog(`[auto-update-checker] Updated ${configPath}: ${oldEntry} → ${newEntry}`);
        return true;
    }
    catch (err) {
        console.error(`[auto-update-checker] Failed to update config file ${configPath}:`, err);
        return false;
    }
}
export async function getLatestVersion() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), NPM_FETCH_TIMEOUT);
    try {
        const response = await fetch(NPM_REGISTRY_URL, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
        });
        if (!response.ok)
            return null;
        const data = (await response.json());
        return data.latest ?? null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timeoutId);
    }
}
export async function checkForUpdate(directory) {
    if (isLocalDevMode(directory)) {
        debugLog("[auto-update-checker] Local dev mode detected, skipping update check");
        return { needsUpdate: false, currentVersion: null, latestVersion: null, isLocalDev: true, isPinned: false };
    }
    const pluginInfo = findPluginEntry(directory);
    if (!pluginInfo) {
        debugLog("[auto-update-checker] Plugin not found in config");
        return { needsUpdate: false, currentVersion: null, latestVersion: null, isLocalDev: false, isPinned: false };
    }
    const currentVersion = getCachedVersion() ?? pluginInfo.pinnedVersion;
    if (!currentVersion) {
        debugLog("[auto-update-checker] No version found (cached or pinned)");
        return { needsUpdate: false, currentVersion: null, latestVersion: null, isLocalDev: false, isPinned: pluginInfo.isPinned };
    }
    const latestVersion = await getLatestVersion();
    if (!latestVersion) {
        debugLog("[auto-update-checker] Failed to fetch latest version");
        return { needsUpdate: false, currentVersion, latestVersion: null, isLocalDev: false, isPinned: pluginInfo.isPinned };
    }
    const needsUpdate = currentVersion !== latestVersion;
    debugLog(`[auto-update-checker] Current: ${currentVersion}, Latest: ${latestVersion}, NeedsUpdate: ${needsUpdate}`);
    return { needsUpdate, currentVersion, latestVersion, isLocalDev: false, isPinned: pluginInfo.isPinned };
}
//# sourceMappingURL=checker.js.map