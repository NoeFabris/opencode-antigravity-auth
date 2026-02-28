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
  palette: 'antigravity',
  accent: 'cyan',
  theme: createUiTheme({
    profile: 'truecolor',
    glyphMode: 'ascii',
    palette: 'antigravity',
    accent: 'cyan',
  }),
};

let runtimeOptions: UiRuntimeOptions = { ...DEFAULT_OPTIONS };

function cloneRuntimeOptions(opts: UiRuntimeOptions): UiRuntimeOptions {
  return {
    ...opts,
    theme: {
      ...opts.theme,
      glyphs: { ...opts.theme.glyphs },
      colors: { ...opts.theme.colors },
    },
  }
}

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

  return cloneRuntimeOptions(runtimeOptions)
}

export function getUiRuntimeOptions(): UiRuntimeOptions {
  return cloneRuntimeOptions(runtimeOptions)
}

export function initUiFromConfig(config?: {
  color_profile?: string;
  glyph_mode?: string;
  palette?: string;
  accent?: string;
}): UiRuntimeOptions {
  if (!config) return runtimeOptions;
  return setUiRuntimeOptions({
    colorProfile: (config.color_profile as UiColorProfile) ?? runtimeOptions.colorProfile,
    glyphMode: (config.glyph_mode as UiGlyphMode) ?? runtimeOptions.glyphMode,
    palette: (config.palette as UiPalette) ?? runtimeOptions.palette,
    accent: (config.accent as UiAccent) ?? runtimeOptions.accent,
  });
}

export function resetUiRuntimeOptions(): UiRuntimeOptions {
  runtimeOptions = { ...DEFAULT_OPTIONS };
  return cloneRuntimeOptions(runtimeOptions)
}
