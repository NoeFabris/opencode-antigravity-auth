import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UiRuntimeOptions } from './runtime'
import type { UiTheme } from './theme'

vi.mock('./select', () => ({
  select: vi.fn(),
}))

vi.mock('./runtime', () => ({
  getUiRuntimeOptions: vi.fn(),
  setUiRuntimeOptions: vi.fn(),
}))

vi.mock('../config/loader', () => ({
  saveUserConfig: vi.fn(),
}))

vi.mock('./copy', () => ({
  UI_COPY: {
    settings: {
      title: 'Settings',
      subtitle: 'Customize theme and behavior',
      help: 'help',
      exitTitle: 'Back',
      colorProfile: 'Color Profile',
      colorProfileHint: 'hint',
      glyphMode: 'Glyph Mode',
      glyphModeHint: 'hint',
      palette: 'Color Palette',
      paletteHint: 'hint',
      accent: 'Accent Color',
      accentHint: 'hint',
      saved: 'Settings saved.',
      unchanged: 'No changes.',
    },
  },
}))

import { select } from './select'
import { getUiRuntimeOptions, setUiRuntimeOptions } from './runtime'
import { saveUserConfig } from '../config/loader'
import { showSettingsMenu } from './settings-menu'

const mockSelect = vi.mocked(select)
const mockGetUi = vi.mocked(getUiRuntimeOptions)
const mockSetUi = vi.mocked(setUiRuntimeOptions)
const mockSave = vi.mocked(saveUserConfig)

const stubTheme = {} as UiTheme

function makeUiOptions(overrides?: Partial<UiRuntimeOptions>): UiRuntimeOptions {
  return {
    v2Enabled: true,
    colorProfile: 'truecolor',
    glyphMode: 'ascii',
    palette: 'green',
    accent: 'green',
    theme: stubTheme,
    ...overrides,
  }
}

describe('settings-menu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUi.mockReturnValue(makeUiOptions())
    mockSetUi.mockReturnValue(makeUiOptions())
  })

  describe('showSettingsMenu', () => {
    it('returns back when user selects back immediately', async () => {
      mockSelect.mockResolvedValueOnce('back')
      const result = await showSettingsMenu()
      expect(result).toBe('back')
    })

    it('returns back when user cancels (null)', async () => {
      mockSelect.mockResolvedValueOnce(null)
      const result = await showSettingsMenu()
      expect(result).toBe('back')
    })

    it('returns changed when a color profile is modified', async () => {
      // First call: main menu -> select color_profile
      mockSelect.mockResolvedValueOnce('color_profile')
      // Second call: sub-menu -> select ansi256
      mockSelect.mockResolvedValueOnce('ansi256')
      // Third call: back to main menu -> select back
      mockSelect.mockResolvedValueOnce('back')

      const result = await showSettingsMenu()
      expect(result).toBe('changed')
      expect(mockSetUi).toHaveBeenCalledWith({ colorProfile: 'ansi256' })
      expect(mockSave).toHaveBeenCalled()
    })

    it('returns changed when glyph mode is modified', async () => {
      mockSelect.mockResolvedValueOnce('glyph_mode')
      mockSelect.mockResolvedValueOnce('unicode')
      mockSelect.mockResolvedValueOnce('back')

      const result = await showSettingsMenu()
      expect(result).toBe('changed')
      expect(mockSetUi).toHaveBeenCalledWith({ glyphMode: 'unicode' })
    })

    it('returns changed when palette is modified', async () => {
      mockSelect.mockResolvedValueOnce('palette')
      mockSelect.mockResolvedValueOnce('blue')
      mockSelect.mockResolvedValueOnce('back')

      const result = await showSettingsMenu()
      expect(result).toBe('changed')
      expect(mockSetUi).toHaveBeenCalledWith({ palette: 'blue' })
    })

    it('returns changed when accent is modified', async () => {
      mockSelect.mockResolvedValueOnce('accent')
      mockSelect.mockResolvedValueOnce('cyan')
      mockSelect.mockResolvedValueOnce('back')

      const result = await showSettingsMenu()
      expect(result).toBe('changed')
      expect(mockSetUi).toHaveBeenCalledWith({ accent: 'cyan' })
    })

    it('does not mark changed when same value selected', async () => {
      // Select color_profile, then pick current value (truecolor)
      mockSelect.mockResolvedValueOnce('color_profile')
      mockSelect.mockResolvedValueOnce('truecolor')
      mockSelect.mockResolvedValueOnce('back')

      const result = await showSettingsMenu()
      expect(result).toBe('back')
      expect(mockSetUi).not.toHaveBeenCalled()
      expect(mockSave).not.toHaveBeenCalled()
    })

    it('does not mark changed when sub-menu cancelled', async () => {
      mockSelect.mockResolvedValueOnce('color_profile')
      mockSelect.mockResolvedValueOnce(null) // cancelled
      mockSelect.mockResolvedValueOnce('back')

      const result = await showSettingsMenu()
      expect(result).toBe('back')
      expect(mockSetUi).not.toHaveBeenCalled()
    })

    it('persists full ui config on change', async () => {
      const updated = makeUiOptions({ colorProfile: 'ansi256' })
      mockSetUi.mockReturnValue(updated)
      mockGetUi
        .mockReturnValueOnce(makeUiOptions()) // first main menu render
        .mockReturnValueOnce(makeUiOptions()) // inside handleColorProfile
        .mockReturnValue(updated) // persistUiConfig + subsequent renders

      mockSelect.mockResolvedValueOnce('color_profile')
      mockSelect.mockResolvedValueOnce('ansi256')
      mockSelect.mockResolvedValueOnce('back')

      await showSettingsMenu()

      expect(mockSave).toHaveBeenCalledWith({
        ui: {
          color_profile: 'ansi256',
          glyph_mode: 'ascii',
          palette: 'green',
          accent: 'green',
        },
      })
    })

    it('handles multiple setting changes in one session', async () => {
      mockSelect
        .mockResolvedValueOnce('accent')
        .mockResolvedValueOnce('yellow')
        .mockResolvedValueOnce('palette')
        .mockResolvedValueOnce('blue')
        .mockResolvedValueOnce('back')

      const result = await showSettingsMenu()
      expect(result).toBe('changed')
      expect(mockSetUi).toHaveBeenCalledTimes(2)
      expect(mockSave).toHaveBeenCalledTimes(2)
    })
  })
})
