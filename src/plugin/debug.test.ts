import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("debug.ts baseline coupling", () => {
  it("keeps TUI debug disabled when debug=false and debug_tui=true", async () => {
    const configDir = createTmpDir("antigravity-debug-config-")
    const logDir = createTmpDir("antigravity-debug-logs-")
    vi.stubEnv("XDG_CONFIG_HOME", configDir)

    const { DEFAULT_CONFIG } = await import("./config")
    const { initializeDebug, isDebugEnabled, isDebugTuiEnabled, getLogFilePath } = await import("./debug")

    initializeDebug({ ...DEFAULT_CONFIG, debug: false, debug_tui: true, log_dir: logDir })

    expect(isDebugEnabled()).toBe(false)
    expect(isDebugTuiEnabled()).toBe(false)
    expect(getLogFilePath()).toBeUndefined()
  })

  it("enables file debug only when debug=true and debug_tui=false", async () => {
    const configDir = createTmpDir("antigravity-debug-config-")
    const logDir = createTmpDir("antigravity-debug-logs-")
    vi.stubEnv("XDG_CONFIG_HOME", configDir)

    const { DEFAULT_CONFIG } = await import("./config")
    const { initializeDebug, isDebugEnabled, isDebugTuiEnabled, getLogFilePath } = await import("./debug")

    initializeDebug({ ...DEFAULT_CONFIG, debug: true, debug_tui: false, log_dir: logDir })

    expect(isDebugEnabled()).toBe(true)
    expect(isDebugTuiEnabled()).toBe(false)
    expect(getLogFilePath()).toBeTruthy()
  })

  it("enables both file and TUI debug when debug=true and debug_tui=true", async () => {
    const configDir = createTmpDir("antigravity-debug-config-")
    const logDir = createTmpDir("antigravity-debug-logs-")
    vi.stubEnv("XDG_CONFIG_HOME", configDir)

    const { DEFAULT_CONFIG } = await import("./config")
    const { initializeDebug, isDebugEnabled, isDebugTuiEnabled, getLogFilePath } = await import("./debug")

    initializeDebug({ ...DEFAULT_CONFIG, debug: true, debug_tui: true, log_dir: logDir })

    expect(isDebugEnabled()).toBe(true)
    expect(isDebugTuiEnabled()).toBe(true)
    expect(getLogFilePath()).toBeTruthy()
  })
})
