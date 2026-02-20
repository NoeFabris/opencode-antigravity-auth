import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginClient } from "./types"

vi.mock("./storage", () => ({
  ensureGitignoreSync: vi.fn(),
}))

function createTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv("OPENCODE_ANTIGRAVITY_DEBUG", "")
  vi.stubEnv("OPENCODE_ANTIGRAVITY_DEBUG_TUI", "")
  vi.stubEnv("OPENCODE_ANTIGRAVITY_CONSOLE_LOG", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("logger.ts baseline sink routing", () => {
  async function runLoggerWithFlags(debug: boolean, debugTui: boolean): Promise<{ appLog: ReturnType<typeof vi.fn> }> {
    const configDir = createTmpDir("antigravity-logger-config-")
    const logDir = createTmpDir("antigravity-logger-logs-")
    vi.stubEnv("XDG_CONFIG_HOME", configDir)

    const { DEFAULT_CONFIG } = await import("./config")
    const { initializeDebug } = await import("./debug")
    const { initLogger, createLogger } = await import("./logger")

    initializeDebug({ ...DEFAULT_CONFIG, debug, debug_tui: debugTui, log_dir: logDir })

    const appLog = vi.fn().mockResolvedValue(undefined)
    const client = {
      app: {
        log: appLog,
      },
    }

    initLogger(client as unknown as PluginClient)
    const logger = createLogger("baseline")
    logger.debug("testing baseline routing", { debug, debugTui })

    return { appLog }
  }

  it("does not emit TUI logs when debug=false and debug_tui=true", async () => {
    const { appLog } = await runLoggerWithFlags(false, true)
    expect(appLog).not.toHaveBeenCalled()
  })

  it("does not emit TUI logs when debug=true and debug_tui=false", async () => {
    const { appLog } = await runLoggerWithFlags(true, false)
    expect(appLog).not.toHaveBeenCalled()
  })

  it("emits TUI logs when debug=true and debug_tui=true", async () => {
    const { appLog } = await runLoggerWithFlags(true, true)
    expect(appLog).toHaveBeenCalledTimes(1)
    expect(appLog).toHaveBeenCalledWith({
      body: {
        service: "antigravity.baseline",
        level: "debug",
        message: "testing baseline routing",
        extra: { debug: true, debugTui: true },
      },
    })
  })
})
