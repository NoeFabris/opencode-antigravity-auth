import { describe, it, expect, beforeEach } from 'vitest';
import { getUiRuntimeOptions, setUiRuntimeOptions, resetUiRuntimeOptions } from './runtime';

describe('runtime', () => {
  beforeEach(() => {
    resetUiRuntimeOptions();
  });

  describe('getUiRuntimeOptions', () => {
    it('returns default options', () => {
      const options = getUiRuntimeOptions();
      expect(options.v2Enabled).toBe(true);
      expect(options.colorProfile).toBe('truecolor');
      expect(options.glyphMode).toBe('ascii');
      expect(options.palette).toBe('antigravity');
      expect(options.accent).toBe('cyan');
      expect(options.theme).toBeDefined();
    });
  });

  describe('setUiRuntimeOptions', () => {
    it('updates options and returns new value', () => {
      const updated = setUiRuntimeOptions({ v2Enabled: false, colorProfile: 'ansi256' });
      expect(updated.v2Enabled).toBe(false);
      expect(updated.colorProfile).toBe('ansi256');
      expect(getUiRuntimeOptions().v2Enabled).toBe(false);
    });

    it('partial updates preserve unset fields', () => {
      setUiRuntimeOptions({ accent: 'cyan' });
      const options = getUiRuntimeOptions();
      expect(options.accent).toBe('cyan');
      expect(options.v2Enabled).toBe(true); // default
      expect(options.colorProfile).toBe('truecolor'); // default
    });

    it('rebuilds theme when colorProfile changes', () => {
      const originalTheme = getUiRuntimeOptions().theme;
      const updated = setUiRuntimeOptions({ colorProfile: 'ansi16' });
      expect(updated.theme).not.toBe(originalTheme);
      expect(updated.theme.profile).toBe('ansi16');
    });
  });

  describe('resetUiRuntimeOptions', () => {
    it('restores defaults', () => {
      setUiRuntimeOptions({ v2Enabled: false, colorProfile: 'ansi16' });
      const reset = resetUiRuntimeOptions();
      expect(reset.v2Enabled).toBe(true);
      expect(reset.colorProfile).toBe('truecolor');
    });

    it('values match original defaults after reset', () => {
      const defaults = { ...getUiRuntimeOptions() };
      setUiRuntimeOptions({ v2Enabled: false, palette: 'blue' });
      resetUiRuntimeOptions();
      expect(getUiRuntimeOptions().v2Enabled).toBe(defaults.v2Enabled);
      expect(getUiRuntimeOptions().palette).toBe(defaults.palette);
    });
  });

  it('theme object is always present and has colors/glyphs', () => {
    const options = getUiRuntimeOptions();
    expect(options.theme.colors).toBeDefined();
    expect(options.theme.glyphs).toBeDefined();
  });
});
