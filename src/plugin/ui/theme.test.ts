import { describe, it, expect } from 'vitest';
import { createUiTheme } from './theme';

describe('theme', () => {
  describe('createUiTheme', () => {
    it('returns default theme with no arguments', () => {
      const theme = createUiTheme();
      expect(theme.profile).toBe('truecolor');
      expect(theme.glyphMode).toBe('ascii');
      expect(theme.glyphs.selected).toBe('>');
      expect(theme.colors.reset).toBe('\x1b[0m');
    });

    it('produces different color codes for each profile', () => {
      const truecolor = createUiTheme({ profile: 'truecolor' });
      const ansi256 = createUiTheme({ profile: 'ansi256' });
      const ansi16 = createUiTheme({ profile: 'ansi16' });

      expect(truecolor.colors.primary).toContain(';2;');
      expect(ansi256.colors.primary).toContain(';5;');
      expect(ansi16.colors.primary).toMatch(new RegExp('^\\x1b\\[\\d+m$'));

      expect(truecolor.colors.primary).not.toBe(ansi256.colors.primary);
      expect(ansi256.colors.primary).not.toBe(ansi16.colors.primary);
    });

    it('uses ASCII glyphs when mode is ascii', () => {
      const theme = createUiTheme({ glyphMode: 'ascii' });
      expect(theme.glyphs).toEqual({
        selected: '>',
        unselected: 'o',
        bullet: '-',
        check: '+',
        cross: 'x',
        topBorder: '+',
        bottomBorder: '+',
      });
    });

    it('uses Unicode glyphs when mode is unicode', () => {
      const theme = createUiTheme({ glyphMode: 'unicode' });
      expect(theme.glyphs).toEqual({
        selected: '◆',
        unselected: '○',
        bullet: '•',
        check: '✓',
        cross: '✗',
        topBorder: '╭',
        bottomBorder: '╰',
      });
    });

    it('has all UiThemeColors keys on every profile', () => {
      const profiles: any[] = ['ansi16', 'ansi256', 'truecolor'];
      const requiredKeys = [
        'reset', 'dim', 'muted', 'heading', 'primary', 'accent',
        'success', 'warning', 'danger', 'border', 'focusBg', 'focusText'
      ];

      for (const profile of profiles) {
        const theme = createUiTheme({ profile });
        for (const key of requiredKeys) {
          expect(theme.colors).toHaveProperty(key);
          expect(typeof (theme.colors as any)[key]).toBe('string');
        }
      }
    });

    it('produces different primary/success colors for green vs blue palette', () => {
      const green = createUiTheme({ palette: 'green' });
      const blue = createUiTheme({ palette: 'blue' });

      expect(green.colors.primary).not.toBe(blue.colors.primary);
      expect(green.colors.success).not.toBe(blue.colors.success);
      expect(green.colors.border).not.toBe(blue.colors.border);
    });

    it('produces different accent values for different accent colors', () => {
      const accents: any[] = ['green', 'cyan', 'blue', 'yellow'];
      const values = accents.map(accent => createUiTheme({ accent }).colors.accent);
      
      const uniqueValues = new Set(values);
      expect(uniqueValues.size).toBe(accents.length);
    });

    it('always has reset key set to \x1b[0m', () => {
      expect(createUiTheme({ profile: 'truecolor' }).colors.reset).toBe('\x1b[0m');
      expect(createUiTheme({ profile: 'ansi256' }).colors.reset).toBe('\x1b[0m');
      expect(createUiTheme({ profile: 'ansi16' }).colors.reset).toBe('\x1b[0m');
    });
  });
});
