/**
 * Shared terminal theme primitives for the TUI renderer.
 */

export type UiColorProfile = 'ansi16' | 'ansi256' | 'truecolor';
export type UiGlyphMode = 'ascii' | 'unicode' | 'auto';
export type UiPalette = 'green' | 'blue';
export type UiAccent = 'green' | 'cyan' | 'blue' | 'yellow';

export interface UiGlyphSet {
  selected: string;
  unselected: string;
  bullet: string;
  check: string;
  cross: string;
}

export interface UiThemeColors {
  reset: string;
  dim: string;
  muted: string;
  heading: string;
  primary: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  border: string;
  focusBg: string;
  focusText: string;
}

export interface UiTheme {
  profile: UiColorProfile;
  glyphMode: UiGlyphMode;
  glyphs: UiGlyphSet;
  colors: UiThemeColors;
}

const ansi16 = (code: number): string => `\x1b[${code}m`;
const ansi256 = (code: number): string => `\x1b[38;5;${code}m`;
const truecolor = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`;
const ansi256Bg = (code: number): string => `\x1b[48;5;${code}m`;
const truecolorBg = (r: number, g: number, b: number): string => `\x1b[48;2;${r};${g};${b}m`;

/**
 * Resolve a glyph mode, interpreting "auto" to choose unicode or ASCII based on the environment.
 */
function resolveGlyphMode(mode: UiGlyphMode): Exclude<UiGlyphMode, 'auto'> {
  if (mode !== 'auto') return mode;
  const isLikelyUnicodeSafe =
    process.env.WT_SESSION !== undefined ||
    process.env.TERM_PROGRAM === 'vscode' ||
    process.env.TERM?.toLowerCase().includes('xterm') === true;
  return isLikelyUnicodeSafe ? 'unicode' : 'ascii';
}

function getGlyphs(mode: Exclude<UiGlyphMode, 'auto'>): UiGlyphSet {
  if (mode === 'unicode') {
    return {
      selected: '◆',
      unselected: '○',
      bullet: '•',
      check: '✓',
      cross: '✗',
    };
  }

  return {
    selected: '>',
    unselected: 'o',
    bullet: '-',
    check: '+',
    cross: 'x',
  };
}

function accentColorForProfile(profile: UiColorProfile, accent: UiAccent): string {
  switch (profile) {
    case 'truecolor':
      switch (accent) {
        case 'cyan':
          return truecolor(34, 211, 238);
        case 'blue':
          return truecolor(59, 130, 246);
        case 'yellow':
          return truecolor(245, 158, 11);
        default:
          return truecolor(74, 222, 128);
      }
    case 'ansi256':
      switch (accent) {
        case 'cyan':
          return ansi256(51);
        case 'blue':
          return ansi256(75);
        case 'yellow':
          return ansi256(214);
        default:
          return ansi256(83);
      }
    default:
      switch (accent) {
        case 'cyan':
          return ansi16(96);
        case 'blue':
          return ansi16(94);
        case 'yellow':
          return ansi16(93);
        default:
          return ansi16(92);
      }
  }
}

function getColors(profile: UiColorProfile, palette: UiPalette, accent: UiAccent): UiThemeColors {
  const accentColor = accentColorForProfile(profile, accent);
  const isBluePalette = palette === 'blue';

  switch (profile) {
    case 'truecolor':
      return {
        reset: '\x1b[0m',
        dim: '\x1b[2m',
        muted: truecolor(148, 163, 184),
        heading: truecolor(240, 253, 244),
        primary: isBluePalette ? truecolor(96, 165, 250) : truecolor(74, 222, 128),
        accent: accentColor,
        success: isBluePalette ? truecolor(96, 165, 250) : truecolor(74, 222, 128),
        warning: truecolor(245, 158, 11),
        danger: truecolor(239, 68, 68),
        border: isBluePalette ? truecolor(59, 130, 246) : truecolor(34, 197, 94),
        focusBg: isBluePalette ? truecolorBg(37, 99, 235) : truecolorBg(22, 101, 52),
        focusText: truecolor(248, 250, 252),
      };
    case 'ansi256':
      return {
        reset: '\x1b[0m',
        dim: '\x1b[2m',
        muted: ansi256(102),
        heading: ansi256(255),
        primary: isBluePalette ? ansi256(75) : ansi256(83),
        accent: accentColor,
        success: isBluePalette ? ansi256(75) : ansi256(83),
        warning: ansi256(214),
        danger: ansi256(196),
        border: isBluePalette ? ansi256(27) : ansi256(40),
        focusBg: isBluePalette ? ansi256Bg(26) : ansi256Bg(28),
        focusText: ansi256(231),
      };
    default:
      return {
        reset: '\x1b[0m',
        dim: '\x1b[2m',
        muted: ansi16(37),
        heading: ansi16(97),
        primary: isBluePalette ? ansi16(94) : ansi16(92),
        accent: accentColor,
        success: isBluePalette ? ansi16(94) : ansi16(92),
        warning: ansi16(93),
        danger: ansi16(91),
        border: isBluePalette ? ansi16(94) : ansi16(92),
        focusBg: isBluePalette ? '\x1b[104m' : '\x1b[102m',
        focusText: '\x1b[30m',
      };
  }
}

export function createUiTheme(options?: {
  profile?: UiColorProfile;
  glyphMode?: UiGlyphMode;
  palette?: UiPalette;
  accent?: UiAccent;
}): UiTheme {
  const profile = options?.profile ?? 'truecolor';
  const glyphMode = options?.glyphMode ?? 'ascii';
  const palette = options?.palette ?? 'green';
  const accent = options?.accent ?? 'green';
  const resolvedGlyphMode = resolveGlyphMode(glyphMode);

  return {
    profile,
    glyphMode,
    glyphs: getGlyphs(resolvedGlyphMode),
    colors: getColors(profile, palette, accent),
  };
}
