import { execFile } from "node:child_process"
import { existsSync } from "node:fs"

const AGY_BINARY_TIMEOUT_MS = 2000
const AGY_AUTH_TIMEOUT_MS = 3000
const UNAUTHENTICATED_RE = /not logged into antigravity|not authenticated|login required/i

export interface AgyBinary {
  path: string
  version: string
}

export interface AgyCommand {
  binary: string
  args: string[]
  timeoutMs: number
}

export interface AgyResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

function parseVersion(text: string): string | null {
  return text.match(/\d+\.\d+\.\d+/)?.[0] ?? null
}

function agyCandidates(): string[] {
  return [
    `${process.env["HOME"] ?? ""}/.local/bin/agy`,
    "agy",
  ].filter(Boolean)
}

function execFileText(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<AgyResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const nodeErr = err as NodeJS.ErrnoException | null
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        exitCode: typeof nodeErr?.code === "number" ? nodeErr.code : err ? 1 : 0,
        timedOut: Boolean((nodeErr as unknown as Record<string, unknown>)?.killed) || nodeErr?.code === "ETIMEDOUT",
      })
    })
  })
}

export async function findAgyBinary(): Promise<AgyBinary | null> {
  for (const candidate of agyCandidates()) {
    if (candidate.includes("/") && !existsSync(candidate)) continue

    const result = await execFileText(candidate, ["--version"], AGY_BINARY_TIMEOUT_MS)
    if (result.exitCode !== 0) continue

    const version = parseVersion(result.stdout.trim() || result.stderr.trim())
    if (!version) continue

    return {
      path: candidate,
      version,
    }
  }

  return null
}

/**
 * Best-effort non-interactive auth probe.
 *
 * There is no documented `agy auth status` command. This deliberately uses
 * a very short timeout and no OAuth automation. If agy starts an auth flow,
 * this returns "unknown" instead of waiting.
 */
export async function checkAgyAuthState(binary: string): Promise<"authenticated" | "unauthenticated" | "unknown"> {
  const result = await execFileText(
    binary,
    [
      "--print",
      "Respond with OK.",
      "--print-timeout",
      "1s",
      "--dangerously-skip-permissions",
    ],
    AGY_AUTH_TIMEOUT_MS,
  )

  const combined = `${result.stdout}\n${result.stderr}`
  if (UNAUTHENTICATED_RE.test(combined)) return "unauthenticated"
  if (result.timedOut) return "unknown"
  if (result.exitCode === 0) return "authenticated"

  return "unknown"
}

export async function executeAgyCommand(command: AgyCommand): Promise<Response> {
  const result = await execFileText(command.binary, command.args, command.timeoutMs)

  if (result.timedOut) {
    return Response.json(
      {
        error: {
          code: 504,
          status: "DEADLINE_EXCEEDED",
          message: "agy timed out. Increase transport.cli.process_timeout_seconds.",
          stderr: result.stderr,
        },
      },
      { status: 504 },
    )
  }

  const combined = `${result.stdout}\n${result.stderr}`
  if (UNAUTHENTICATED_RE.test(combined)) {
    return Response.json(
      {
        error: {
          code: 401,
          status: "UNAUTHENTICATED",
          message: "agy is not logged into Antigravity. Run `agy` manually and complete Google OAuth in the browser.",
          stderr: result.stderr,
        },
      },
      { status: 401 },
    )
  }

  if (result.exitCode !== 0) {
    return Response.json(
      {
        error: {
          code: 502,
          status: "AGY_PROCESS_ERROR",
          message: `agy exited with code ${result.exitCode ?? "unknown"}.`,
          stderr: result.stderr,
        },
      },
      { status: 502 },
    )
  }

  return Response.json({
    stdout: result.stdout,
    stderr: result.stderr,
  })
}

// Exposed for testing
export const _test = {
  parseVersion,
  execFileText,
  UNAUTHENTICATED_RE,
}
