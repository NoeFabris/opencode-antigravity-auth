import { createUiTheme } from './theme';
import type { UiAccent, UiColorProfile, UiGlyphMode, UiPalette, UiTheme } from './theme';

export interface UiRuntimeOptions {
  v2Enabled: boolean;
  colorProfile: UiColorProfile;
  glyphMode: UiGlyphMode;
  palette: UiPalette;
  accent: UiAccent;
  theme: UiTheme;
}

const DEFAULT_OPTIONS: UiRuntimeOptions = {
  v2Enabled: true,
  colorProfile: 'truecolor',
  glyphMode: 'ascii',
  palette: 'green',
  accent: 'green',
  theme: createUiTheme({
    profile: 'truecolor',
    glyphMode: 'ascii',
    palette: 'green',
    accent: 'green',
  }),
};

let runtimeOptions: UiRuntimeOptions = { ...DEFAULT_OPTIONS };

export function setUiRuntimeOptions(
  options: Partial<Omit<UiRuntimeOptions, 'theme'>>,
): UiRuntimeOptions {
  const v2Enabled = options.v2Enabled ?? runtimeOptions.v2Enabled;
  const colorProfile = options.colorProfile ?? runtimeOptions.colorProfile;
  const glyphMode = options.glyphMode ?? runtimeOptions.glyphMode;
  const palette = options.palette ?? runtimeOptions.palette;
  const accent = options.accent ?? runtimeOptions.accent;

  runtimeOptions = {
    v2Enabled,
    colorProfile,
    glyphMode,
    palette,
    accent,
    theme: createUiTheme({ profile: colorProfile, glyphMode, palette, accent }),
  };

  return runtimeOptions;
}

export function getUiRuntimeOptions(): UiRuntimeOptions {
  return runtimeOptions;
}

export function resetUiRuntimeOptions(): UiRuntimeOptions {
  runtimeOptions = { ...DEFAULT_OPTIONS };
  return runtimeOptions;
}
