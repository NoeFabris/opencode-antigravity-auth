import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Give every test worker its own OpenCode config and data directories.
 * Account migration runs on real files, so without this a unit test could
 * move or overwrite the developer's live account pool.
 *
 * OPENCODE_CONFIG_DIR is intentionally left alone: tests that exercise the
 * default config path set it themselves, and leaving it unset keeps this
 * setup from shadowing that behaviour.
 */
const root = mkdtempSync(join(tmpdir(), "opencode-antigravity-tests-"));

process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CONFIG_HOME = join(root, "config");
if (process.platform === "win32") {
  process.env.APPDATA = join(root, "roaming");
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
