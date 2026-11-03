import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Folder that holds this plugin's mutable state under OpenCode's data directory.
 * Accounts, the signature cache, and debug logs live here instead of in the
 * config directory that OpenCode watches and reloads.
 */
const PLUGIN_STATE_DIR = "antigravity";

/**
 * Resolves OpenCode's data directory.
 * OpenCode uses the XDG layout on every platform, including Windows, so this
 * stays at ~/.local/share/opencode unless XDG_DATA_HOME overrides it.
 */
function getOpencodeDataDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "opencode");
}

/** Root directory for state written by this plugin. */
export function getPluginDataDir(): string {
  return join(getOpencodeDataDir(), PLUGIN_STATE_DIR);
}

/** Account pool file. Contains refresh tokens, so keep it out of the config directory. */
export function getAccountsPath(): string {
  return join(getPluginDataDir(), "antigravity-accounts.json");
}

/** Disk cache for thinking-block signatures. */
export function getSignatureCachePath(): string {
  return join(getPluginDataDir(), "antigravity-signature-cache.json");
}

/** Directory for debug logs. */
export function getPluginLogsDir(): string {
  return join(getPluginDataDir(), "antigravity-logs");
}

/**
 * Directories that older plugin versions wrote state to, in lookup order.
 * Nothing is written here anymore; they are read once to migrate existing files.
 */
export function getLegacyStateDirs(): string[] {
  const dirs: string[] = [];

  // An explicit config directory used to redirect all plugin state.
  if (process.env.OPENCODE_CONFIG_DIR) {
    dirs.push(process.env.OPENCODE_CONFIG_DIR);
  }

  // Default config directory used by current and recent releases.
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const configDir = join(xdgConfig, "opencode");
  if (!dirs.includes(configDir)) {
    dirs.push(configDir);
  }

  // Windows location used by releases before 2.0.
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    const legacyDir = join(roaming, "opencode");
    if (!dirs.includes(legacyDir)) {
      dirs.push(legacyDir);
    }
  }

  return dirs;
}

/** Returns the first legacy copy of a state file, when one exists. */
export function findLegacyStateFile(fileName: string): string | undefined {
  return getLegacyStateDirs()
    .map((dir) => join(dir, fileName))
    .find((candidate) => existsSync(candidate));
}

export interface LegacyStateMove {
  from: string;
  to: string;
  moved: boolean;
}

/**
 * Moves one state file from a legacy config directory into the plugin data directory.
 * A rename is atomic when both paths share a filesystem; the copy fallback covers
 * the cross-device case. An existing data-directory file always wins.
 */
export function moveLegacyStateFile(fileName: string): LegacyStateMove | undefined {
  const to = join(getPluginDataDir(), fileName);
  if (existsSync(to)) {
    return undefined;
  }

  const from = findLegacyStateFile(fileName);
  if (!from) {
    return undefined;
  }

  try {
    mkdirSync(getPluginDataDir(), { recursive: true });
    try {
      renameSync(from, to);
    } catch {
      copyFileSync(from, to);
      unlinkSync(from);
    }
    return { from, to, moved: true };
  } catch {
    // The caller decides whether the legacy path is still usable.
    return { from, to, moved: false };
  }
}
