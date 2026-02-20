export type LogLevel = "debug" | "info" | "warn" | "error"

export interface DebugPolicyInput {
  configDebug: boolean
  configDebugTui: boolean
  envDebugFlag?: string
  envDebugTuiFlag?: string
}

export interface DebugPolicy {
  debugLevel: number
  debugEnabled: boolean
  debugTuiEnabled: boolean
  verboseEnabled: boolean
}

export function isTruthyFlag(flag?: string): boolean {
  return flag === "1" || flag?.toLowerCase() === "true"
}

export function parseDebugLevel(flag: string): number {
  const trimmed = flag.trim()
  if (trimmed === "2" || trimmed === "verbose") return 2
  if (trimmed === "1" || trimmed === "true") return 1
  return 0
}

export function deriveDebugPolicy(input: DebugPolicyInput): DebugPolicy {
  const envDebugFlag = input.envDebugFlag ?? ""
  const debugLevel = input.configDebug
    ? envDebugFlag === "2" || envDebugFlag === "verbose"
      ? 2
      : 1
    : parseDebugLevel(envDebugFlag)
  const debugEnabled = debugLevel >= 1
  const verboseEnabled = debugLevel >= 2
  const debugTuiEnabled = debugEnabled && (input.configDebugTui || isTruthyFlag(input.envDebugTuiFlag))

  return {
    debugLevel,
    debugEnabled,
    debugTuiEnabled,
    verboseEnabled,
  }
}

export function formatAccountLabel(email: string | undefined, accountIndex: number): string {
  return email || `Account ${accountIndex + 1}`
}

export function formatAccountContextLabel(email: string | undefined, accountIndex: number): string {
  if (email) {
    return email
  }
  if (accountIndex >= 0) {
    return `Account ${accountIndex + 1}`
  }
  return "All accounts"
}

export function formatErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function truncateTextForLog(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text
  }
  return `${text.slice(0, maxChars)}... (truncated ${text.length - maxChars} chars)`
}

export function formatBodyPreviewForLog(
  body: BodyInit | null | undefined,
  maxChars: number,
): string | undefined {
  if (body == null) {
    return undefined
  }

  if (typeof body === "string") {
    return truncateTextForLog(body, maxChars)
  }

  if (body instanceof URLSearchParams) {
    return truncateTextForLog(body.toString(), maxChars)
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return `[Blob size=${body.size}]`
  }

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return "[FormData payload omitted]"
  }

  return `[${body.constructor?.name ?? typeof body} payload omitted]`
}

export function writeConsoleLog(level: LogLevel, ...args: unknown[]): void {
  switch (level) {
    case "debug":
      console.debug(...args)
      break
    case "info":
      console.info(...args)
      break
    case "warn":
      console.warn(...args)
      break
    case "error":
      console.error(...args)
      break
  }
}
