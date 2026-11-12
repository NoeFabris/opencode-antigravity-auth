import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  findLegacyStateFile,
  getAccountsPath,
  getLegacyStateDirs,
  getPluginDataDir,
  getPluginLogsDir,
  getSignatureCachePath,
  moveLegacyStateFile,
} from "./paths";
import { getStoragePath } from "./storage";

const ACCOUNTS = "antigravity-accounts.json";

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "antigravity-paths-"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("plugin data directory", () => {
  it("keeps every state file under the OpenCode data directory", () => {
    const dataDir = join(root, "data", "opencode", "antigravity");

    expect(getPluginDataDir()).toBe(dataDir);
    expect(getAccountsPath()).toBe(join(dataDir, "antigravity-accounts.json"));
    expect(getSignatureCachePath()).toBe(join(dataDir, "antigravity-signature-cache.json"));
    expect(getPluginLogsDir()).toBe(join(dataDir, "antigravity-logs"));
  });

  it("never resolves state inside a legacy config directory", () => {
    for (const legacy of getLegacyStateDirs()) {
      expect(isInside(getPluginDataDir(), legacy)).toBe(false);
    }
  });

  it("reads OPENCODE_CONFIG_DIR before the default config directory", () => {
    const custom = join(root, "custom-config");
    vi.stubEnv("OPENCODE_CONFIG_DIR", custom);

    const dirs = getLegacyStateDirs();
    expect(dirs[0]).toBe(custom);
    expect(dirs).toContain(join(root, "config", "opencode"));
  });
});

describe("legacy state migration", () => {
  it("moves an account file out of the config directory", () => {
    const legacyDir = join(root, "config", "opencode");
    const legacyFile = join(legacyDir, ACCOUNTS);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyFile, '{"version":4,"accounts":[]}');

    const move = moveLegacyStateFile(ACCOUNTS);

    expect(move).toEqual({ from: legacyFile, to: getAccountsPath(), moved: true });
    expect(existsSync(legacyFile)).toBe(false);
    expect(readFileSync(getAccountsPath(), "utf-8")).toBe('{"version":4,"accounts":[]}');
  });

  it("does not overwrite a file that already lives in the data directory", () => {
    const legacyDir = join(root, "config", "opencode");
    const legacyFile = join(legacyDir, ACCOUNTS);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyFile, "legacy");
    mkdirSync(getPluginDataDir(), { recursive: true });
    writeFileSync(getAccountsPath(), "current");

    expect(moveLegacyStateFile(ACCOUNTS)).toBeUndefined();
    expect(readFileSync(getAccountsPath(), "utf-8")).toBe("current");
    expect(readFileSync(legacyFile, "utf-8")).toBe("legacy");
  });

  it("uses the explicit config directory first when several copies exist", () => {
    const custom = join(root, "custom-config");
    const defaultDir = join(root, "config", "opencode");
    mkdirSync(custom, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(join(custom, ACCOUNTS), "custom");
    writeFileSync(join(defaultDir, ACCOUNTS), "default");
    vi.stubEnv("OPENCODE_CONFIG_DIR", custom);

    expect(findLegacyStateFile(ACCOUNTS)).toBe(join(custom, ACCOUNTS));
  });

  it("moves the pool before getStoragePath returns the new location", () => {
    const legacyDir = join(root, "config", "opencode");
    const legacyFile = join(legacyDir, ACCOUNTS);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyFile, '{"version":4}');

    expect(getStoragePath()).toBe(getAccountsPath());
    expect(existsSync(legacyFile)).toBe(false);
    expect(readFileSync(getAccountsPath(), "utf-8")).toBe('{"version":4}');
  });
});
