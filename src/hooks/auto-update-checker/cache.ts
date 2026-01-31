import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CACHE_DIR, PACKAGE_NAME } from "./constants";

/**
 * Resolves the OpenCode configuration directory path based on the operating system.
 * @returns The absolute path to the opencode configuration directory.
 */
function getOpencodeConfigDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "opencode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfig, "opencode");
}

interface BunLockfile {
  workspaces?: {
    ""?: {
      dependencies?: Record<string, string>;
    };
  };
  packages?: Record<string, unknown>;
}

/**
 * Sanitizes a JSON string by removing trailing commas to ensure compatibility with standard JSON.parse.
 * @param json - The raw JSON string with potential trailing commas.
 * @returns The sanitized JSON string.
 */
function stripTrailingCommas(json: string): string {
  return json.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Removes a package entry from a Bun lockfile at a specific path.
 * @param lockPath - The absolute path to the bun.lock file.
 * @param packageName - The name of the package to remove.
 * @returns True if the lockfile was modified and saved.
 */
function removeFromBunLockAt(lockPath: string, packageName: string): boolean {
  if (!fs.existsSync(lockPath)) return false;

  try {
    const content = fs.readFileSync(lockPath, "utf-8");
    const lock = JSON.parse(stripTrailingCommas(content)) as BunLockfile;
    let modified = false;

    if (lock.workspaces?.[""]?.dependencies?.[packageName]) {
      delete lock.workspaces[""].dependencies[packageName];
      modified = true;
    }

    if (lock.packages?.[packageName]) {
      delete lock.packages[packageName];
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
      console.log(`[auto-update-checker] Removed from bun.lock: ${packageName} (${lockPath})`);
    }

    return modified;
  } catch {
    return false;
  }
}

/**
 * Clears the Bun global install cache for a specific package.
 * @param packageName - The name of the package to purge from the cache.
 * @returns True if any cache entries were successfully removed.
 */
function removeFromBunInstallCache(packageName: string): boolean {
  const cacheDir =
    process.env.BUN_INSTALL_CACHE_DIR ||
    path.join(os.homedir(), ".bun", "install", "cache");

  try {
    if (!fs.existsSync(cacheDir)) return false;
    const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
    let removed = false;

    for (const entry of entries) {
      if (!entry.name.startsWith(packageName)) continue;
      const fullPath = path.join(cacheDir, entry.name);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        removed = true;
      } catch {
        // best-effort
      }
    }

    if (removed) {
      console.log(`[auto-update-checker] Removed from bun install cache: ${packageName}`);
    }

    return removed;
  } catch {
    return false;
  }
}

/**
 * Forcefully invalidates (removes) a package from all known OpenCode and Bun caches.
 * Targets node_modules, package.json dependencies, lockfiles, and the Bun global install cache.
 * @param packageName - The name of the package to invalidate (defaults to PACKAGE_NAME).
 * @returns True if any cache entry was removed or modified.
 */
export function invalidatePackage(packageName: string = PACKAGE_NAME): boolean {
  try {
    const cachePkgDir = path.join(CACHE_DIR, "node_modules", packageName);
    const cachePkgJsonPath = path.join(CACHE_DIR, "package.json");

    const configDir = getOpencodeConfigDir();
    const configPkgDir = path.join(configDir, "node_modules", packageName);
    const configPkgJsonPath = path.join(configDir, "package.json");

    let packageRemoved = false;
    let dependencyRemoved = false;
    let lockRemoved = false;
    let bunInstallCacheRemoved = false;

    if (fs.existsSync(cachePkgDir)) {
      fs.rmSync(cachePkgDir, { recursive: true, force: true });
      console.log(`[auto-update-checker] Package removed: ${cachePkgDir}`);
      packageRemoved = true;
    }

    if (fs.existsSync(configPkgDir)) {
      fs.rmSync(configPkgDir, { recursive: true, force: true });
      console.log(`[auto-update-checker] Package removed: ${configPkgDir}`);
      packageRemoved = true;
    }

    if (fs.existsSync(cachePkgJsonPath)) {
      const content = fs.readFileSync(cachePkgJsonPath, "utf-8");
      const pkgJson = JSON.parse(content);
      if (pkgJson.dependencies?.[packageName]) {
        delete pkgJson.dependencies[packageName];
        fs.writeFileSync(cachePkgJsonPath, JSON.stringify(pkgJson, null, 2));
        console.log(`[auto-update-checker] Dependency removed from package.json: ${packageName} (${cachePkgJsonPath})`);
        dependencyRemoved = true;
      }
    }

    if (fs.existsSync(configPkgJsonPath)) {
      const content = fs.readFileSync(configPkgJsonPath, "utf-8");
      const pkgJson = JSON.parse(content);
      if (pkgJson.dependencies?.[packageName]) {
        delete pkgJson.dependencies[packageName];
        fs.writeFileSync(configPkgJsonPath, JSON.stringify(pkgJson, null, 2));
        console.log(`[auto-update-checker] Dependency removed from package.json: ${packageName} (${configPkgJsonPath})`);
        dependencyRemoved = true;
      }
    }

    const cacheLockRemoved = removeFromBunLockAt(path.join(CACHE_DIR, "bun.lock"), packageName);
    const configLockRemoved = removeFromBunLockAt(path.join(configDir, "bun.lock"), packageName);
    lockRemoved = cacheLockRemoved || configLockRemoved;

    // Some environments (notably Bun-based plugin runners) may keep stale copies of packages
    // in Bun's global install cache. Best-effort removal helps ensure updated versions are used.
    bunInstallCacheRemoved = removeFromBunInstallCache(packageName);

    if (!packageRemoved && !dependencyRemoved && !lockRemoved && !bunInstallCacheRemoved) {
      console.log(`[auto-update-checker] Package not found, nothing to invalidate: ${packageName}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error("[auto-update-checker] Failed to invalidate package:", err);
    return false;
  }
}

/**
 * @deprecated Use invalidatePackage instead.
 */
export function invalidateCache(): boolean {
  console.warn("[auto-update-checker] WARNING: invalidateCache is deprecated, use invalidatePackage");
  return invalidatePackage();
}
