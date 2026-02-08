import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testExports, loadConfig } from "./loader";

describe("config loader legacy Windows migration", () => {
  let tempRoot: string;
  let previousConfigDir: string | undefined;
  let previousAppData: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "antigravity-config-"));

    previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    previousAppData = process.env.APPDATA;

    process.env.OPENCODE_CONFIG_DIR = join(tempRoot, "new-config");
    process.env.APPDATA = join(tempRoot, "legacy-appdata");
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    }

    if (previousAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = previousAppData;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("migrates %APPDATA%/opencode/antigravity.json to current config path", () => {
    const legacyDir = join(process.env.APPDATA!, "opencode");
    const legacyPath = join(legacyDir, "antigravity.json");
    const expectedPath = join(process.env.OPENCODE_CONFIG_DIR!, "antigravity.json");

    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({ scheduling_mode: "performance_first" }), "utf-8");

    const resolvedPath = __testExports.resolveUserConfigPath("win32");

    expect(resolvedPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
  });

  it("loads settings from migrated legacy config", () => {
    const legacyDir = join(process.env.APPDATA!, "opencode");
    const legacyPath = join(legacyDir, "antigravity.json");

    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        account_selection_strategy: "round-robin",
        scheduling_mode: "performance_first",
        switch_on_first_rate_limit: true,
        max_rate_limit_wait_seconds: 5,
      }),
      "utf-8",
    );

    // Force legacy -> new path migration even when tests run on non-Windows CI.
    __testExports.resolveUserConfigPath("win32");

    const loaded = loadConfig(tempRoot);

    expect(loaded.account_selection_strategy).toBe("round-robin");
    expect(loaded.scheduling_mode).toBe("performance_first");
    expect(loaded.switch_on_first_rate_limit).toBe(true);
    expect(loaded.max_rate_limit_wait_seconds).toBe(5);

    const migratedPath = join(process.env.OPENCODE_CONFIG_DIR!, "antigravity.json");
    const persisted = JSON.parse(readFileSync(migratedPath, "utf-8")) as Record<string, unknown>;
    expect(persisted.scheduling_mode).toBe("performance_first");
  });
});
