import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock node:child_process and node:fs before importing the module
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}))

import { findAgyBinary, checkAgyAuthState, executeAgyCommand, _test } from "./agy-cli.ts"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>
const mockExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>

function mockExecResult(overrides: Partial<{ stdout: string; stderr: string; err: Error | null }> = {}) {
  const err = overrides.err ?? null
  return ((
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cb(err, overrides.stdout ?? "", overrides.stderr ?? "")
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockExistsSync.mockReturnValue(true)
  process.env["HOME"] = "/home/test"
})

// ---------------------------------------------------------------------------
// findAgyBinary
// ---------------------------------------------------------------------------

describe("findAgyBinary", () => {
  it("returns binary info when agy --version succeeds", async () => {
    mockExecFile.mockImplementation(mockExecResult({ stdout: "1.0.0\n" }))

    const result = await findAgyBinary()
    expect(result).toEqual({ path: "/home/test/.local/bin/agy", version: "1.0.0" })
  })

  it("skips candidates that do not exist on disk", async () => {
    mockExistsSync.mockReturnValue(false)
    mockExecFile.mockImplementation(mockExecResult({ stdout: "1.0.0\n" }))

    const result = await findAgyBinary()
    // Falls through to "agy" (no existsSync check for bare names)
    expect(result).toEqual({ path: "agy", version: "1.0.0" })
  })

  it("returns null when no candidate succeeds", async () => {
    mockExistsSync.mockReturnValue(false)
    mockExecFile.mockImplementation(mockExecResult({ err: new Error("not found") }))

    const result = await findAgyBinary()
    expect(result).toBeNull()
  })

  it("returns null when version output is unparseable", async () => {
    mockExecFile.mockImplementation(mockExecResult({ stdout: "no-version-here" }))

    const result = await findAgyBinary()
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// checkAgyAuthState
// ---------------------------------------------------------------------------

describe("checkAgyAuthState", () => {
  it("returns 'authenticated' on success", async () => {
    mockExecFile.mockImplementation(mockExecResult({ stdout: "OK" }))

    const state = await checkAgyAuthState("agy")
    expect(state).toBe("authenticated")
  })

  it("returns 'unauthenticated' when stderr contains auth message", async () => {
    mockExecFile.mockImplementation(mockExecResult({ stderr: "You are not logged into Antigravity" }))

    const state = await checkAgyAuthState("agy")
    expect(state).toBe("unauthenticated")
  })

  it("returns 'unknown' on timeout (killed process)", async () => {
    const killedErr = Object.assign(new Error("timed out"), { killed: true })
    mockExecFile.mockImplementation(mockExecResult({ err: killedErr }))

    const state = await checkAgyAuthState("agy")
    expect(state).toBe("unknown")
  })

  it("returns 'unknown' on non-zero exit with no auth message", async () => {
    mockExecFile.mockImplementation(mockExecResult({ err: new Error("some error") }))

    const state = await checkAgyAuthState("agy")
    expect(state).toBe("unknown")
  })
})

// ---------------------------------------------------------------------------
// executeAgyCommand
// ---------------------------------------------------------------------------

describe("executeAgyCommand", () => {
  it("returns JSON with stdout on success", async () => {
    mockExecFile.mockImplementation(mockExecResult({ stdout: "Hello from agy!" }))

    const response = await executeAgyCommand({
      binary: "agy",
      args: ["--print", "Hi"],
      timeoutMs: 5000,
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ stdout: "Hello from agy!", stderr: "" })
  })

  it("returns 504 on timeout", async () => {
    const killedErr = Object.assign(new Error("timed out"), { killed: true })
    mockExecFile.mockImplementation(mockExecResult({ err: killedErr }))

    const response = await executeAgyCommand({
      binary: "agy",
      args: ["--print", "Hi"],
      timeoutMs: 1000,
    })

    expect(response.status).toBe(504)
    const body = await response.json()
    expect(body.error.status).toBe("DEADLINE_EXCEEDED")
  })

  it("returns 401 when unauthenticated", async () => {
    mockExecFile.mockImplementation(mockExecResult({ stderr: "not authenticated" }))

    const response = await executeAgyCommand({
      binary: "agy",
      args: ["--print", "Hi"],
      timeoutMs: 5000,
    })

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.status).toBe("UNAUTHENTICATED")
  })

  it("returns 502 on non-zero exit", async () => {
    const err = Object.assign(new Error("exit 1"), { code: 1 })
    mockExecFile.mockImplementation(mockExecResult({ err }))

    const response = await executeAgyCommand({
      binary: "agy",
      args: ["--print", "Hi"],
      timeoutMs: 5000,
    })

    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error.status).toBe("AGY_PROCESS_ERROR")
  })
})

// ---------------------------------------------------------------------------
// parseVersion
// ---------------------------------------------------------------------------

describe("parseVersion", () => {
  it("extracts semver from text", () => {
    expect(_test.parseVersion("Antigravity CLI v1.2.3")).toBe("1.2.3")
  })

  it("returns null for no match", () => {
    expect(_test.parseVersion("no version here")).toBeNull()
  })
})
