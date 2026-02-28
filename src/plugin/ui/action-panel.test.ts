import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MockInstance } from 'vitest'

vi.mock('./ansi', () => ({
  ANSI: {
    altScreenOn: '\x1b[?1049h',
    altScreenOff: '\x1b[?1049l',
    hide: '\x1b[?25l',
    show: '\x1b[?25h',
    clearScreen: '\x1b[2J',
    moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,
    clearLine: '\x1b[2K',
  },
  isTTY: vi.fn(),
}))

vi.mock('./runtime', () => ({
  getUiRuntimeOptions: vi.fn().mockReturnValue({
    v2Enabled: true,
    colorProfile: 'truecolor',
    glyphMode: 'ascii',
    palette: 'green',
    accent: 'green',
    theme: {},
  }),
}))

vi.mock('./format', () => ({
  paintUiText: vi.fn((_ui: unknown, text: string) => text),
}))

vi.mock('./copy', () => ({
  UI_COPY: {
    returnFlow: {
      continuePrompt: 'Press Enter to go back.',
      actionFailedPrompt: 'Action failed. Press Enter to go back.',
      autoReturn: (s: number) => `Returning in ${s}s...`,
      paused: 'Paused.',
      working: 'Running...',
      done: 'Done.',
      failed: 'Failed.',
    },
  },
}))

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn().mockReturnValue({
    question: vi.fn().mockResolvedValue(''),
    close: vi.fn(),
  }),
}))

import { isTTY } from './ansi'
import { runActionPanel, waitForMenuReturn } from './action-panel'

const mockIsTTY = vi.mocked(isTTY)

describe('action-panel', () => {
  let writeSpy: MockInstance
  let originalRows: number | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    originalRows = process.stdout.rows
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    writeSpy.mockRestore()
    Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
  })

  describe('runActionPanel', () => {
    it('runs action directly when not TTY', async () => {
      mockIsTTY.mockReturnValue(false)
      const action = vi.fn().mockResolvedValue(42)
      const result = await runActionPanel('Title', 'Stage', action)
      expect(result).toBe(42)
      expect(action).toHaveBeenCalledOnce()
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('runs action in alt-screen when TTY', async () => {
      mockIsTTY.mockReturnValue(true)
      const action = vi.fn().mockImplementation(() => {
        return Promise.resolve('result-value')
      })

      const promise = runActionPanel('Title', 'Stage', action, { autoReturnMs: 0 })

      // Advance past setInterval renders and the readline question
      await vi.advanceTimersByTimeAsync(500)

      const result = await promise
      expect(result).toBe('result-value')
      expect(action).toHaveBeenCalledOnce()

      // Verify alt-screen was used
      const allWrites = writeSpy.mock.calls.map(c => String(c[0]))
      const hasAltScreenOn = allWrites.some(w => w.includes('\x1b[?1049h'))
      const hasAltScreenOff = allWrites.some(w => w.includes('\x1b[?1049l'))
      expect(hasAltScreenOn).toBe(true)
      expect(hasAltScreenOff).toBe(true)
    })

    it('cleanup writes clearScreen after altScreenOff (codex-multi-auth pattern)', async () => {
      mockIsTTY.mockReturnValue(true)
      const action = vi.fn().mockResolvedValue('ok')

      const promise = runActionPanel('Title', 'Stage', action, { autoReturnMs: 0 })
      await vi.advanceTimersByTimeAsync(500)
      await promise

      // The final cleanup write should contain altScreenOff + show + clearScreen + moveTo
      const allWrites = writeSpy.mock.calls.map(c => String(c[0]))
      const lastWrite = allWrites[allWrites.length - 1] ?? ''
      expect(lastWrite).toContain('\x1b[?1049l') // altScreenOff
      expect(lastWrite).toContain('\x1b[?25h')   // show cursor
      expect(lastWrite).toContain('\x1b[2J')      // clearScreen
      expect(lastWrite).toContain('\x1b[1;1H')    // moveTo(1,1)
    })

    it('captures console.log during action', async () => {
      mockIsTTY.mockReturnValue(true)
      const originalLog = console.log

      const action = vi.fn().mockImplementation(() => {
        console.log('captured message')
        return Promise.resolve('ok')
      })

      const promise = runActionPanel('Title', 'Stage', action, { autoReturnMs: 0 })
      await vi.advanceTimersByTimeAsync(500)
      await promise

      // Console should be restored
      expect(console.log).toBe(originalLog)
    })

    it('restores console methods on error', async () => {
      mockIsTTY.mockReturnValue(true)
      const originalLog = console.log
      const originalWarn = console.warn
      const originalError = console.error

      const action = vi.fn().mockRejectedValue(new Error('boom'))

      const promise = runActionPanel('Title', 'Stage', action, { autoReturnMs: 0 })
      promise.catch(() => {}) // prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(500)

      await expect(promise).rejects.toThrow('boom')

      expect(console.log).toBe(originalLog)
      expect(console.warn).toBe(originalWarn)
      expect(console.error).toBe(originalError)
    })

    it('rethrows action error after cleanup', async () => {
      mockIsTTY.mockReturnValue(true)
      const testError = new Error('test failure')
      const action = vi.fn().mockRejectedValue(testError)

      const promise = runActionPanel('Title', 'Stage', action, { autoReturnMs: 0 })
      promise.catch(() => {}) // prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(500)

      await expect(promise).rejects.toThrow('test failure')

      // Verify cleanup happened (alt-screen off)
      const allWrites = writeSpy.mock.calls.map(c => String(c[0]))
      const hasAltScreenOff = allWrites.some(w => w.includes('\x1b[?1049l'))
      expect(hasAltScreenOff).toBe(true)
    })

    it('returns action result on success', async () => {
      mockIsTTY.mockReturnValue(false)
      const action = vi.fn().mockResolvedValue({ data: 'hello' })
      const result = await runActionPanel('T', 'S', action)
      expect(result).toEqual({ data: 'hello' })
    })
  })

  describe('waitForMenuReturn', () => {
    it('returns immediately when not TTY', async () => {
      mockIsTTY.mockReturnValue(false)
      await waitForMenuReturn()
      // Should not hang or throw
    })

    it('returns immediately when not TTY even with options', async () => {
      mockIsTTY.mockReturnValue(false)
      await waitForMenuReturn({ autoReturnMs: 5000, pauseOnAnyKey: true })
      // Should not hang or throw
    })
  })
})
