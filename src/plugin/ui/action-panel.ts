import { createInterface } from 'node:readline/promises'

import { ANSI, isTTY } from './ansi'
import { UI_COPY } from './copy'
import { paintUiText } from './format'
import { getUiRuntimeOptions } from './runtime'

export interface ActionPanelOptions {
  autoReturnMs?: number
  pauseOnAnyKey?: boolean
}

export interface MenuReturnOptions {
  promptText?: string
  autoReturnMs?: number
  pauseOnAnyKey?: boolean
}

const SPINNER_FRAMES_ASCII = ['-', '\\', '|', '/']
const SPINNER_FRAMES_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const MAX_LOG_LINES = 400
const DEFAULT_AUTO_RETURN_MS = 2000

type ConsoleMethod = (...args: unknown[]) => void

function stringifyLogArgs(args: unknown[]): string {
  return args
    .map((val) => {
      if (typeof val === 'string') return val
      try {
        return JSON.stringify(val)
      } catch {
        return String(val)
      }
    })
    .join(' ')
}

function splitLogLines(line: string): string[] {
  return line.split(/\r?\n/)
}

export async function runActionPanel<T>(
  title: string,
  stage: string,
  action: () => Promise<T> | T,
  options?: ActionPanelOptions,
): Promise<T> {
  const ui = getUiRuntimeOptions()
  const { autoReturnMs = DEFAULT_AUTO_RETURN_MS, pauseOnAnyKey = true } = options ?? {}

  if (!isTTY()) {
    return await action()
  }

  const logs: string[] = []
  const pushLog = (args: unknown[]): void => {
    const text = stringifyLogArgs(args)
    const lines = splitLogLines(text)
    for (const line of lines) {
      logs.push(line)
    }
    if (logs.length > MAX_LOG_LINES) {
      const extra = logs.length - MAX_LOG_LINES
      logs.splice(0, extra)
    }
  }

  const originalLog = console.log as ConsoleMethod
  const originalWarn = console.warn as ConsoleMethod
  const originalError = console.error as ConsoleMethod

  console.log = (...args: unknown[]) => {
    pushLog(args)
  }
  console.warn = (...args: unknown[]) => {
    pushLog(['!', ...args])
  }
  console.error = (...args: unknown[]) => {
    pushLog(['x', ...args])
  }

  let running = true
  let failed = false
  let frame = 0
  let error: unknown
  let interval: NodeJS.Timeout | undefined
  let result: T | undefined

  const render = (): void => {
    const rows = process.stdout.rows ?? 24
    const availableLogRows = Math.max(8, rows - 8);
    const isUnicode = ui.glyphMode === 'unicode' || (ui.glyphMode === 'auto' && (process.env.WT_SESSION !== undefined || process.env.TERM_PROGRAM === 'vscode' || process.env.TERM?.toLowerCase().includes('xterm') === true))
    const frames = isUnicode ? SPINNER_FRAMES_UNICODE : SPINNER_FRAMES_ASCII
    const spinner = running
      ? frames[frame % frames.length]
      : failed
        ? UI_COPY.returnFlow.failed
        : UI_COPY.returnFlow.done
    const stageTone = running ? 'accent' : failed ? 'danger' : 'success'
    const statusText = running
      ? UI_COPY.returnFlow.working
      : failed
        ? UI_COPY.returnFlow.failed
        : UI_COPY.returnFlow.done
    const statusTone = running ? 'accent' : failed ? 'danger' : 'success'
    const columns = process.stdout.columns ?? 80
    const maxWidth = Math.max(1, columns - 2)
    const logLines = logs.slice(-availableLogRows).map((line) => {
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, '')
      if (stripped.length <= maxWidth) return line
      return line.slice(0, Math.max(1, maxWidth - 3)) + '...'
    })
    const header = paintUiText(ui, title, 'accent')
    const stageLine = paintUiText(ui, `${stage} ${spinner}`, stageTone)
    const body = logLines.join('\n')
    const statusLine = paintUiText(ui, statusText, statusTone)

    const lines = [header, stageLine, '', body, statusLine]
    process.stdout.write(`${ANSI.clearScreen}${ANSI.moveTo(1, 1)}${lines.join('\n')}`)
    frame += 1
  }

  const cleanupConsole = (): void => {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
  }

  const cleanupScreen = (): void => {
    process.stdout.write(`${ANSI.altScreenOff}${ANSI.show}${ANSI.clearScreen}${ANSI.moveTo(1, 1)}`)
  }

  process.stdout.write(`${ANSI.altScreenOn}${ANSI.hide}`)
  render()
  interval = setInterval(render, 120)

  try {
    try {
      result = await action()
    } catch (err) {
      failed = true
      error = err
      const message = err instanceof Error ? err.message : String(err)
      pushLog([message])
    } finally {
      running = false
      if (interval) clearInterval(interval)
      render()
    }

    await waitForMenuReturn({
      promptText: failed ? UI_COPY.returnFlow.actionFailedPrompt : UI_COPY.returnFlow.continuePrompt,
      autoReturnMs,
      pauseOnAnyKey,
    })
  } finally {
    cleanupConsole()
    cleanupScreen()
  }

  if (failed) {
    throw error
  }

  return result as T
}

export async function waitForMenuReturn(options?: MenuReturnOptions): Promise<void> {
  if (!isTTY()) return

  const ui = getUiRuntimeOptions()
  const { promptText = UI_COPY.returnFlow.continuePrompt, autoReturnMs = 0, pauseOnAnyKey = true } = options ?? {}
  const stdout = process.stdout
  const stdin = process.stdin

  if (autoReturnMs > 0) {
    const rows = stdout.rows ?? 24
    const promptRow = Math.max(1, rows - 1)
    const countdownRow = rows
    let remainingMs = autoReturnMs
    let paused = false

    await new Promise<void>((resolve) => {
      let countdownInterval: NodeJS.Timeout | undefined

      const renderPrompt = (text: string): void => {
        stdout.write(`${ANSI.moveTo(promptRow, 1)}${ANSI.clearLine}${paintUiText(ui, text, 'muted')}`)
      }

      const renderCountdown = (text: string): void => {
        stdout.write(`${ANSI.moveTo(countdownRow, 1)}${ANSI.clearLine}${paintUiText(ui, text, 'muted')}`)
      }

      const cleanup = (): void => {
        if (countdownInterval) clearInterval(countdownInterval)
        stdin.off('data', onKey)
        stdin.setRawMode?.(false)
        stdin.pause()
      }

      const finish = (): void => {
        cleanup()
        resolve()
      }

      const onKey = (): void => {
        if (!pauseOnAnyKey) {
          finish()
          return
        }
        if (!paused) {
          paused = true
          renderCountdown(UI_COPY.returnFlow.paused)
          return
        }
        finish()
      }

      renderPrompt(promptText)
      renderCountdown(UI_COPY.returnFlow.autoReturn(Math.ceil(remainingMs / 1000)))

      stdin.setRawMode?.(true)
      stdin.resume()
      stdin.on('data', onKey)

      countdownInterval = setInterval(() => {
        if (paused) return
        remainingMs -= 1000
        if (remainingMs <= 0) {
          finish()
          return
        }
        const seconds = Math.ceil(remainingMs / 1000)
        renderCountdown(UI_COPY.returnFlow.autoReturn(seconds))
      }, 1000)
    })

    return
  }

  const rl = createInterface({ input: stdin, output: stdout })
  await rl.question(paintUiText(ui, promptText, 'muted'))
  rl.close()
}
