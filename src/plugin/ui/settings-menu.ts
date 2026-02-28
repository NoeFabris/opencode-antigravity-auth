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

function persistUiConfig(): void {
  const current = getUiRuntimeOptions()
  saveUserConfig({
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
    { label: 'ansi16', value: 'ansi16', hint: 'Basic 16 colors — maximum compatibility' },
    { label: 'ansi256', value: 'ansi256', hint: 'Extended 256 colors — most terminals' },
    { label: 'truecolor', value: 'truecolor', hint: 'Full 24-bit color — modern terminals' },
  ]

  const selection = await select(options, {
    message: UI_COPY.settings.colorProfile,
    subtitle: `Current: ${ui.colorProfile}`,
    help: UI_COPY.settings.help,
    theme: ui.theme,
    showHintsForUnselected: true,
  })

  if (!selection) return null
  if (selection === ui.colorProfile) return false

  setUiRuntimeOptions({ colorProfile: selection })
  persistUiConfig()
  return true
}

async function handleGlyphMode(): Promise<boolean | null> {
  const ui = getUiRuntimeOptions()
  const options: MenuItem<UiGlyphMode>[] = [
    { label: 'ascii', value: 'ascii', hint: 'ASCII characters only' },
    { label: 'unicode', value: 'unicode', hint: 'Unicode symbols (◆ • ✓ ✗)' },
    { label: 'auto', value: 'auto', hint: 'Auto-detect from terminal' },
  ]

  const selection = await select(options, {
    message: UI_COPY.settings.glyphMode,
    subtitle: `Current: ${ui.glyphMode}`,
    help: UI_COPY.settings.help,
    theme: ui.theme,
    showHintsForUnselected: true,
  })

  if (!selection) return null
  if (selection === ui.glyphMode) return false

  setUiRuntimeOptions({ glyphMode: selection })
  persistUiConfig()
  return true
}

async function handlePalette(): Promise<boolean | null> {
  const ui = getUiRuntimeOptions()
  const options: MenuItem<UiPalette>[] = [
    { label: 'green', value: 'green', hint: 'Green-tinted color scheme' },
    { label: 'blue', value: 'blue', hint: 'Blue-tinted color scheme' },
  ]

  const selection = await select(options, {
    message: UI_COPY.settings.palette,
    subtitle: `Current: ${ui.palette}`,
    help: UI_COPY.settings.help,
    theme: ui.theme,
    showHintsForUnselected: true,
  })

  if (!selection) return null
  if (selection === ui.palette) return false

  setUiRuntimeOptions({ palette: selection })
  persistUiConfig()
  return true
}

async function handleAccent(): Promise<boolean | null> {
  const ui = getUiRuntimeOptions()
  const options: MenuItem<UiAccent>[] = [
    { label: 'green', value: 'green', hint: 'Classic green highlights' },
    { label: 'cyan', value: 'cyan', hint: 'Cool cyan highlights' },
    { label: 'blue', value: 'blue', hint: 'Blue highlights' },
    { label: 'yellow', value: 'yellow', hint: 'Warm yellow highlights' },
  ]

  const selection = await select(options, {
    message: UI_COPY.settings.accent,
    subtitle: `Current: ${ui.accent}`,
    help: UI_COPY.settings.help,
    theme: ui.theme,
    showHintsForUnselected: true,
  })

  if (!selection) return null
  if (selection === ui.accent) return false

  setUiRuntimeOptions({ accent: selection })
  persistUiConfig()
  return true
}
