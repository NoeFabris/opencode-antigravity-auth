import { describe, it, expect } from 'vitest';
import {
  paintUiText,
  formatUiHeader,
  formatUiSection,
  formatUiItem,
  formatUiKeyValue,
  formatUiBadge,
  quotaToneFromLeftPercent
} from './format';
import { createUiTheme } from './theme';

const mockUi = (v2Enabled: boolean): any => ({
  v2Enabled,
  colorProfile: 'truecolor',
  glyphMode: 'ascii',
  palette: 'green',
  accent: 'green',
  theme: createUiTheme({ profile: 'truecolor', glyphMode: 'ascii' }),
});

describe('format', () => {
  describe('paintUiText', () => {
    it('returns text unchanged when v2Enabled is false', () => {
      const ui = mockUi(false);
      expect(paintUiText(ui, 'hello', 'primary')).toBe('hello');
    });

    it('wraps text with color codes when v2Enabled is true', () => {
      const ui = mockUi(true);
      const painted = paintUiText(ui, 'hello', 'primary');
      expect(painted).toContain('hello');
      expect(painted).toContain('\x1b[');
      expect(painted).toContain('\x1b[0m');
    });

    it('returns text unchanged with tone normal even when v2Enabled is true', () => {
      const ui = mockUi(true);
      expect(paintUiText(ui, 'hello', 'normal')).toBe('hello');
    });
  });

  describe('formatUiBadge', () => {
    it('returns [label] without ANSI when v2Enabled is false', () => {
      const ui = mockUi(false);
      expect(formatUiBadge(ui, 'TEST')).toBe('[TEST]');
    });

    it('returns styled [label] when v2Enabled is true', () => {
      const ui = mockUi(true);
      const badged = formatUiBadge(ui, 'TEST');
      expect(badged).toContain('[TEST]');
      expect(badged).toContain('\x1b[');
    });

    it('produces different output for some tones', () => {
      const ui = mockUi(true);
      const tones: any[] = ['accent', 'warning', 'danger', 'muted'];
      const results = tones.map(tone => formatUiBadge(ui, 'TEST', tone));
      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(tones.length);
    });
  });

  describe('quotaToneFromLeftPercent', () => {
    it('returns danger for <= 15', () => {
      expect(quotaToneFromLeftPercent(0)).toBe('danger');
      expect(quotaToneFromLeftPercent(15)).toBe('danger');
    });

    it('returns warning for <= 35', () => {
      expect(quotaToneFromLeftPercent(16)).toBe('warning');
      expect(quotaToneFromLeftPercent(35)).toBe('warning');
    });

    it('returns success for > 35', () => {
      expect(quotaToneFromLeftPercent(36)).toBe('success');
      expect(quotaToneFromLeftPercent(100)).toBe('success');
    });
  });

  describe('formatUiHeader', () => {
    it('returns single-element array when v2Enabled is false', () => {
      const ui = mockUi(false);
      expect(formatUiHeader(ui, 'Title')).toEqual(['Title']);
    });

    it('returns 2-element array when v2Enabled is true', () => {
      const ui = mockUi(true);
      const result = formatUiHeader(ui, 'Title');
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('Title');
      expect(result[1]).toContain('-----');
      expect(result[1]).toContain('\x1b[');
    });
  });

  describe('formatUiSection', () => {
    it('returns array with title', () => {
      const ui = mockUi(true);
      const result = formatUiSection(ui, 'Section');
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('Section');
    });

    it('returns raw title when v2Enabled is false', () => {
      const ui = mockUi(false);
      expect(formatUiSection(ui, 'Section')).toEqual(['Section']);
    });
  });

  describe('formatUiItem', () => {
    it('returns - text when v2Enabled is false', () => {
      const ui = mockUi(false);
      expect(formatUiItem(ui, 'item')).toBe('- item');
    });

    it('returns bullet + text when v2Enabled is true', () => {
      const ui = mockUi(true);
      const result = formatUiItem(ui, 'item');
      expect(result).toContain('item');
      expect(result).toContain(ui.theme.glyphs.bullet);
    });
  });

  describe('formatUiKeyValue', () => {
    it('returns key: value when v2Enabled is false', () => {
      const ui = mockUi(false);
      expect(formatUiKeyValue(ui, 'key', 'value')).toBe('key: value');
    });

    it('returns themed key+value when v2Enabled is true', () => {
      const ui = mockUi(true);
      const result = formatUiKeyValue(ui, 'key', 'value');
      expect(result).toContain('key:');
      expect(result).toContain('value');
      expect(result).toContain('\x1b[');
    });
  });
});
