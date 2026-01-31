import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { NpmDistTags, OpencodeConfig, PackageJson, UpdateCheckResult } from "./types";
import {
  PACKAGE_NAME,
  NPM_REGISTRY_URL,
  NPM_FETCH_TIMEOUT,
  INSTALLED_PACKAGE_JSON,
  USER_OPENCODE_CONFIG,
  USER_OPENCODE_CONFIG_JSONC,
} from "./constants";
import { debugLogToFile } from "../../plugin/debug";

function debugLog(message: string): void {
  debugLogToFile(message);
}

/**
 * Checks if the plugin is running in local development mode based on the configuration.
 * @param directory - The project root directory.
 * @returns True if a local dev path is configured.
 */
export function isLocalDevMode(directory: string): boolean {
  return getLocalDevPath(directory) !== null;
}

/**
 * Sanitizes a JSON string by removing single-line and multi-line comments.
 * @param json - The raw JSON string.
 * @returns The sanitized JSON string.
 */
function stripJsonComments(json: string): string {
  return json
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m: string, g: string | undefined) => (g ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Retrieves the potential paths for OpenCode configuration files in priority order.
 * @param directory - The project root directory.
 * @returns An array of absolute file paths to check.
 */
function getConfigPaths(directory: string): string[] {
  return [
    path.join(directory, ".opencode", "opencode.json"),
    path.join(directory, ".opencode", "opencode.jsonc"),
    path.join(directory, ".opencode.json"),
    USER_OPENCODE_CONFIG,
    USER_OPENCODE_CONFIG_JSONC,
  ];
}

/**
 * Resolves the local development path for the plugin if configured.
 * @param directory - The project root directory.
 * @returns The absolute path to the local plugin directory, or null.
 */
export function getLocalDevPath(directory: string): string | null {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const content = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsonComments(content)) as OpencodeConfig;
      const plugins = config.plugin ?? [];

      for (const entry of plugins) {
        if (entry.startsWith("file://") && entry.includes(PACKAGE_NAME)) {
          try {
            return fileURLToPath(entry);
          } catch {
            return entry.replace("file://", "");
          }
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Searches upwards from a starting path for a package.json file matching this package.
 * @param startPath - The directory or file to start searching from.
 * @returns The absolute path to the matching package.json, or null.
 */
function findPackageJsonUp(startPath: string): string | null {
  try {
    const stat = fs.statSync(startPath);
    let dir = stat.isDirectory() ? startPath : path.dirname(startPath);

    for (let i = 0; i < 10; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const content = fs.readFileSync(pkgPath, "utf-8");
          const pkg = JSON.parse(content) as PackageJson;
          if (pkg.name === PACKAGE_NAME) return pkgPath;
        } catch {
          continue;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolves the version of the plugin running in local development mode.
 * @param directory - The project root directory.
 * @returns The version string from package.json, or null.
 */
export function getLocalDevVersion(directory: string): string | null {
  const localPath = getLocalDevPath(directory);
  if (!localPath) return null;

  try {
    const pkgPath = findPackageJsonUp(localPath);
    if (!pkgPath) return null;
    const content = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content) as PackageJson;
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export interface PluginEntryInfo {
  entry: string;
  isPinned: boolean;
  pinnedVersion: string | null;
  configPath: string;
}

/**
 * Locates the plugin entry in the OpenCode configuration files.
 * @param directory - The project root directory.
 * @returns Information about the found entry (pinned version, config path, etc.).
 */
export function findPluginEntry(directory: string): PluginEntryInfo | null {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const content = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsonComments(content)) as OpencodeConfig;
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
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Resolves the version of the currently installed plugin.
 * Prioritizes the version from the currently executing code's package.json.
 * Falls back to the cached installation path if not found in the current path.
 * @returns The version string or null if it cannot be resolved.
 */
export function getCachedVersion(): string | null {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = findPackageJsonUp(currentDir);
    if (pkgPath) {
      const content = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(content) as PackageJson;
      if (pkg.version) return pkg.version;
    }
  } catch (err) {
    debugLog(`[auto-update-checker] Failed to resolve version from current directory: ${err}`);
  }

  // Fallback: use the cached install path (may be stale if multiple installs exist).
  try {
    if (fs.existsSync(INSTALLED_PACKAGE_JSON)) {
      const content = fs.readFileSync(INSTALLED_PACKAGE_JSON, "utf-8");
      const pkg = JSON.parse(content) as PackageJson;
      if (pkg.version) return pkg.version;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Updates a pinned version in an OpenCode configuration file.
 * Performs a text-based replacement to preserve comments and formatting.
 * @param configPath - The absolute path to the configuration file.
 * @param oldEntry - The current plugin entry string to replace.
 * @param newVersion - The new version string to pin.
 * @returns True if the file was successfully updated.
 */
export function updatePinnedVersion(configPath: string, oldEntry: string, newVersion: string): boolean {
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
      if (content[i] === "[") bracketCount++;
      else if (content[i] === "]") bracketCount--;
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
  } catch (err) {
    console.error(`[auto-update-checker] Failed to update config file ${configPath}:`, err);
    return false;
  }
}

/**
 * Fetches the latest published version of the plugin from the npm registry.
 * @returns A promise resolving to the latest version string, or null.
 */
export async function getLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NPM_FETCH_TIMEOUT);

  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as NpmDistTags;
    return data.latest ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Orchestrates an update check for the plugin.
 * Detects local dev mode, pinned versions, and registry updates.
 * @param directory - The project root directory.
 * @returns A result object indicating if an update is available.
 */
export async function checkForUpdate(directory: string): Promise<UpdateCheckResult> {
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
