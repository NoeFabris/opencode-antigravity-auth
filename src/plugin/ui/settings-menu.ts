import { select, type MenuItem } from './select'
import { getUiRuntimeOptions, setUiRuntimeOptions } from './runtime'
import type { UiAccent, UiColorProfile, UiGlyphMode, UiPalette } from './theme'
import { UI_COPY } from './copy'
import { saveUserConfig } from '../config/loader'

type SettingsMenuAction = 'back' | 'color_profile' | 'glyph_mode' | 'palette' | 'accent'

export async function showSettingsMenu(): Promise<'back' | 'changed'> {
  let changed = false

  while (true) {
    const ui = getUiRuntimeOptions()
    const items: MenuItem<SettingsMenuAction>[] = [
      {
        label: UI_COPY.settings.exitTitle,
        value: 'back',
        hint: UI_COPY.settings.help,
      },
      {
        label: UI_COPY.settings.colorProfile,
        value: 'color_profile',
        hint: `${UI_COPY.settings.colorProfileHint}\nCurrent: ${ui.colorProfile}`,
      },
      {
        label: UI_COPY.settings.glyphMode,
        value: 'glyph_mode',
        hint: `${UI_COPY.settings.glyphModeHint}\nCurrent: ${ui.glyphMode}`,
      },
      {
        label: UI_COPY.settings.palette,
        value: 'palette',
        hint: `${UI_COPY.settings.paletteHint}\nCurrent: ${ui.palette}`,
      },
      {
        label: UI_COPY.settings.accent,
        value: 'accent',
        hint: `${UI_COPY.settings.accentHint}\nCurrent: ${ui.accent}`,
      },
    ]

    const selection = await select(items, {
      message: UI_COPY.settings.title,
      subtitle: UI_COPY.settings.subtitle,
      help: UI_COPY.settings.help,
      clearScreen: true,
      theme: ui.theme,
      showHintsForUnselected: true,
    })

    if (!selection || selection === 'back') {
      break
    }

    const result = await handleSettingSelection(selection)
    if (result === true) {
      changed = true
      console.log(UI_COPY.settings.saved)
    } else if (result === false) {
      console.log(UI_COPY.settings.unchanged)
    }
  }

  return changed ? 'changed' : 'back'
}

function persistUiConfig(): boolean {
  const current = getUiRuntimeOptions()
  return saveUserConfig({
    ui: {
      color_profile: current.colorProfile,
      glyph_mode: current.glyphMode,
      palette: current.palette,
      accent: current.accent,
    },
  })
}

async function handleSettingSelection(action: SettingsMenuAction): Promise<boolean | null> {
  switch (action) {
    case 'color_profile':
      return handleColorProfile()
    case 'glyph_mode':
      return handleGlyphMode()
    case 'palette':
      return handlePalette()
    case 'accent':
      return handleAccent()
    default:
      return null
  }
}

async function handleColorProfile(): Promise<boolean | null> {
  const ui = getUiRuntimeOptions()
  const options: MenuItem<UiColorProfile>[] = [
    { label: 'ansi16', value: 'ansi16', hint: UI_COPY.settings.colorProfileAnsi16Hint },
    { label: 'ansi256', value: 'ansi256', hint: UI_COPY.settings.colorProfileAnsi256Hint },
    { label: 'truecolor', value: 'truecolor', hint: UI_COPY.settings.colorProfileTruecolorHint },
  ]

  const selection = await select(options, {
    message: UI_COPY.settings.colorProfile,
    subtitle: `Current: ${ui.colorProfile}`,
    help: UI_COPY.settings.help,
    clearScreen: true,
    theme: ui.theme,
    showHintsForUnselected: true,
  })

  if (!selection) return null
  if (selection === ui.colorProfile) return false

  setUiRuntimeOptions({ colorProfile: selection })
  const saved = persistUiConfig()
  if (!saved) {
    console.log(UI_COPY.settings.saveFailed)
  }
  return true
}

async function handleGlyphMode(): Promise<boolean | null> {
  const ui = getUiRuntimeOptions()
  const options: MenuItem<UiGlyphMode>[] = [
    { label: 'ascii', value: 'ascii', hint: UI_COPY.settings.glyphModeAsciiHint },
    { label: 'unicode', value: 'unicode', hint: UI_COPY.settings.glyphModeUnicodeHint },
    { label: 'auto', value: 'auto', hint: UI_COPY.settings.glyphModeAutoHint },
  ]

  const selection = await select(options, {
    message: UI_COPY.settings.glyphMode,
    subtitle: `Current: ${ui.glyphMode}`,
    help: UI_COPY.settings.help,
    clearScreen: true,
    theme: ui.theme,
    showHintsForUnselected: true,
  })

  if (!selection) return null
  if (selection === ui.glyphMode) return false

  setUiRuntimeOptions({ glyphMode: selection })
  const saved = persistUiConfig()
  if (!saved) {
    console.log(UI_COPY.settings.saveFailed)
  }
  return true
}

async function handlePalette(): Promise<boolean | null> {
  const ui = getUiRuntimeOptions()
  const options: MenuItem<UiPalette>[] = [
    { label: 'antigravity', value: 'antigravity', hint: UI_COPY.settings.paletteAntigravityHint ?? 'Deep space theme (Google Blue & Dark Grey)' },
    { label: 'green', value: 'green', hint: UI_COPY.settings.paletteGreenHint },
    { label: 'blue', value: 'blue', hint: UI_COPY.settings.paletteBlueHint },
  ]

  const selection = await select(options, {
    message: UI_COPY.settings.palette,
    subtitle: `Current: ${ui.palette}`,
    help: UI_COPY.settings.help,
    clearScreen: true,
    theme: ui.theme,
    showHintsForUnselected: true,
  })

  if (!selection) return null
  if (selection === ui.palette) return false

  setUiRuntimeOptions({ palette: selection })
  const saved = persistUiConfig()
  if (!saved) {
    console.log(UI_COPY.settings.saveFailed)
  }
  return true
}

async function handleAccent(): Promise<boolean | null> {
  const ui = getUiRuntimeOptions()
  const options: MenuItem<UiAccent>[] = [
    { label: 'cyan', value: 'cyan', hint: UI_COPY.settings.accentCyanHint },
    { label: 'magenta', value: 'magenta', hint: UI_COPY.settings.accentMagentaHint ?? 'Bright neon magenta' },
    { label: 'purple', value: 'purple', hint: UI_COPY.settings.accentPurpleHint ?? 'Deep gemini purple' },
    { label: 'green', value: 'green', hint: UI_COPY.settings.accentGreenHint },
    { label: 'blue', value: 'blue', hint: UI_COPY.settings.accentBlueHint },
    { label: 'yellow', value: 'yellow', hint: UI_COPY.settings.accentYellowHint },
  ]

  const selection = await select(options, {
    message: UI_COPY.settings.accent,
    subtitle: `Current: ${ui.accent}`,
    help: UI_COPY.settings.help,
    clearScreen: true,
    theme: ui.theme,
    showHintsForUnselected: true,
  })

  if (!selection) return null
  if (selection === ui.accent) return false

  setUiRuntimeOptions({ accent: selection })
  const saved = persistUiConfig()
  if (!saved) {
    console.log(UI_COPY.settings.saveFailed)
  }
  return true
}
