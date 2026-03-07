import { describe, it, expect } from 'vitest';
import { UI_COPY, formatCheckFlaggedLabel } from './copy';

describe('copy', () => {
  describe('UI_COPY', () => {
    it('has required keys in mainMenu', () => {
      const keys = ['title', 'addAccount', 'checkAccounts', 'settings'];
      for (const key of keys) {
        expect(UI_COPY.mainMenu).toHaveProperty(key);
        expect(typeof (UI_COPY.mainMenu as any)[key]).toBe('string');
      }
    });

    it('has required keys in accountDetails', () => {
      const keys = ['back', 'enable', 'disable', 'setCurrent', 'refresh', 'remove', 'help'];
      for (const key of keys) {
        expect(UI_COPY.accountDetails).toHaveProperty(key);
        expect(typeof (UI_COPY.accountDetails as any)[key]).toBe('string');
      }
    });

    it('has required keys in oauth', () => {
      expect(UI_COPY.oauth).toHaveProperty('openBrowser');
      expect(UI_COPY.oauth).toHaveProperty('manualMode');
    });

    it('has required keys in returnFlow', () => {
      expect(UI_COPY.returnFlow).toHaveProperty('continuePrompt');
      expect(typeof UI_COPY.returnFlow.autoReturn).toBe('function');
      expect(UI_COPY.returnFlow.autoReturn(5)).toContain('5');
    });

    it('has required keys in settings', () => {
      expect(UI_COPY.settings).toHaveProperty('title');
      expect(UI_COPY.settings).toHaveProperty('exitTitle');
    });
  });

  describe('formatCheckFlaggedLabel', () => {
    it('returns base label when called with no args', () => {
      expect(formatCheckFlaggedLabel()).toBe(UI_COPY.mainMenu.checkFlagged);
    });

    it('returns base label when called with 0', () => {
      expect(formatCheckFlaggedLabel(0)).toBe(UI_COPY.mainMenu.checkFlagged);
    });

    it('returns base label + count when called with positive number', () => {
      const label = formatCheckFlaggedLabel(3);
      expect(label).toContain(UI_COPY.mainMenu.checkFlagged);
      expect(label).toContain('(3)');
    });
  });
});
