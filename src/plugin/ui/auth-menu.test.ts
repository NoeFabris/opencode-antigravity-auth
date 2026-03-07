import { describe, it, expect } from 'vitest';
import type { AccountStatus, AccountInfo } from './auth-menu';
import {
  sanitizeTerminalText,
  formatRelativeTime,
  formatDate,
  normalizeQuotaPercent,
  parseLeftPercentFromSummary,
  formatDurationCompact,
  formatLimitCooldown,
  statusTone,
  statusText,
  accountTitle,
} from './auth-menu';
describe('auth-menu', () => {
  describe('sanitizeTerminalText', () => {
    it('strips ANSI codes', () => {
      expect(sanitizeTerminalText('\x1b[32mHello\x1b[0m')).toBe('Hello');
    });

    it('strips control characters', () => {
      expect(sanitizeTerminalText('Hello\nWorld\r')).toBe('HelloWorld');
    });

    it('trims whitespace', () => {
      expect(sanitizeTerminalText('  Hello  ')).toBe('Hello');
    });

    it('returns undefined for empty/null input', () => {
      expect(sanitizeTerminalText('')).toBe(undefined);
      expect(sanitizeTerminalText(undefined)).toBe(undefined);
    });
  });

  describe('formatRelativeTime', () => {
    it('returns never for undefined', () => {
      expect(formatRelativeTime(undefined)).toBe('never');
    });

    it('returns today for recent timestamp', () => {
      expect(formatRelativeTime(Date.now())).toBe('today');
    });

    it('returns yesterday for 1 day ago', () => {
      const yesterday = Date.now() - 86_400_000;
      expect(formatRelativeTime(yesterday)).toBe('yesterday');
    });

    it('returns days ago for < 7 days', () => {
      const threeDaysAgo = Date.now() - 3 * 86_400_000;
      expect(formatRelativeTime(threeDaysAgo)).toBe('3d ago');
    });

    it('returns weeks ago for < 30 days', () => {
      const twoWeeksAgo = Date.now() - 14 * 86_400_000;
      expect(formatRelativeTime(twoWeeksAgo)).toBe('2w ago');
    });
  });

  describe('formatDate', () => {
    it('returns unknown for undefined', () => {
      expect(formatDate(undefined)).toBe('unknown');
    });

    it('returns formatted date for timestamp', () => {
      const date = new Date(2023, 0, 1);
      expect(formatDate(date.getTime())).toBe(date.toLocaleDateString());
    });
  });

  describe('normalizeQuotaPercent', () => {
    it('returns null for non-finite values', () => {
      expect(normalizeQuotaPercent(NaN)).toBe(null);
      expect(normalizeQuotaPercent(Infinity)).toBe(null);
      expect(normalizeQuotaPercent(undefined)).toBe(null);
    });

    it('clamps value between 0 and 100', () => {
      expect(normalizeQuotaPercent(-10)).toBe(0);
      expect(normalizeQuotaPercent(150)).toBe(100);
    });

    it('rounds values', () => {
      expect(normalizeQuotaPercent(75.6)).toBe(76);
      expect(normalizeQuotaPercent(75.4)).toBe(75);
    });
  });

  describe('parseLeftPercentFromSummary', () => {
    it('parses 5h percent from summary', () => {
      expect(parseLeftPercentFromSummary('5h 75% | 7d 10%', '5h')).toBe(75);
    });

    it('parses 7d percent from summary', () => {
      expect(parseLeftPercentFromSummary('5h 75% | 7d 10%', '7d')).toBe(10);
    });

    it('returns null for no match', () => {
      expect(parseLeftPercentFromSummary('other 50%', '5h')).toBe(null);
    });
  });

  describe('formatDurationCompact', () => {
    it('formats seconds', () => {
      expect(formatDurationCompact(30_000)).toBe('30s');
    });

    it('formats minutes', () => {
      expect(formatDurationCompact(125_000)).toBe('2m 5s');
      expect(formatDurationCompact(120_000)).toBe('2m');
    });

    it('formats hours', () => {
      expect(formatDurationCompact(3600_000 * 2 + 60_000 * 5)).toBe('2h 5m');
    });

    it('formats days', () => {
      expect(formatDurationCompact(86400_000 * 3 + 3600_000 * 2)).toBe('3d 2h');
    });
  });

  describe('formatLimitCooldown', () => {
    it('returns null for invalid input', () => {
      expect(formatLimitCooldown(undefined)).toBe(null);
    });

    it('returns reset ready for past timestamp', () => {
      expect(formatLimitCooldown(Date.now() - 1000)).toBe('reset ready');
    });

    it('returns reset duration for future timestamp', () => {
      const future = Date.now() + 120_000;
      expect(formatLimitCooldown(future)).toBe('reset 2m');
    });
  });

  describe('statusTone', () => {
    it('maps statuses to tones correctly', () => {
      expect(statusTone('active')).toBe('success');
      expect(statusTone('ok')).toBe('success');
      expect(statusTone('rate-limited')).toBe('warning');
      expect(statusTone('cooldown')).toBe('warning');
      expect(statusTone('error')).toBe('danger');
      expect(statusTone('flagged')).toBe('danger');
      expect(statusTone('unknown')).toBe('muted');
    });
  });

  describe('statusText', () => {
    it('returns status or unknown', () => {
      expect(statusText('active')).toBe('active');
      expect(statusText(undefined)).toBe('unknown');
    });
  });

  describe('accountTitle', () => {
    it('uses email if available', () => {
      const acc: Partial<AccountInfo> = { index: 0, email: 'test@example.com' };
      expect(accountTitle(acc as AccountInfo)).toContain('test@example.com');
    });

    it('uses label if email missing', () => {
      const acc: Partial<AccountInfo> = { index: 0, accountLabel: 'My Account' };
      expect(accountTitle(acc as AccountInfo)).toContain('My Account');
    });

    it('uses id if others missing', () => {
      const acc: Partial<AccountInfo> = { index: 0, accountId: '123' };
      expect(accountTitle(acc as AccountInfo)).toContain('123');
    });

    it('uses default fallback if all missing', () => {
      const acc: Partial<AccountInfo> = { index: 4 };
      expect(accountTitle(acc as AccountInfo)).toBe('5. Account 5');
    });
  });
});
