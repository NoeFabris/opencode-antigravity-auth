import { describe, it, expect } from 'vitest';
import { ANSI } from './ansi';

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return 'never';
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatDate(timestamp: number | undefined): string {
  if (!timestamp) return 'unknown';
  return new Date(timestamp).toLocaleDateString();
}

type AccountStatus = 'active' | 'rate-limited' | 'expired' | 'unknown';

function getStatusBadge(status: AccountStatus | undefined): string {
  switch (status) {
    case 'active': return `${ANSI.green}[active]${ANSI.reset}`;
    case 'rate-limited': return `${ANSI.yellow}[rate-limited]${ANSI.reset}`;
    case 'expired': return `${ANSI.red}[expired]${ANSI.reset}`;
    default: return '';
  }
}

describe('auth-menu helpers', () => {
  describe('formatRelativeTime', () => {
    it('returns "never" for undefined', () => {
      expect(formatRelativeTime(undefined)).toBe('never');
    });

    it('returns "today" for same day', () => {
      expect(formatRelativeTime(Date.now())).toBe('today');
      expect(formatRelativeTime(Date.now() - 1000)).toBe('today');
    });

    it('returns "yesterday" for 1 day ago', () => {
      const yesterday = Date.now() - 86400000;
      expect(formatRelativeTime(yesterday)).toBe('yesterday');
    });

    it('returns "Xd ago" for 2-6 days', () => {
      expect(formatRelativeTime(Date.now() - 2 * 86400000)).toBe('2d ago');
      expect(formatRelativeTime(Date.now() - 6 * 86400000)).toBe('6d ago');
    });

    it('returns "Xw ago" for 7-29 days', () => {
      expect(formatRelativeTime(Date.now() - 7 * 86400000)).toBe('1w ago');
      expect(formatRelativeTime(Date.now() - 14 * 86400000)).toBe('2w ago');
      expect(formatRelativeTime(Date.now() - 28 * 86400000)).toBe('4w ago');
    });

    it('returns formatted date for 30+ days', () => {
      const oldDate = Date.now() - 60 * 86400000;
      const result = formatRelativeTime(oldDate);
      expect(result).not.toBe('never');
      expect(result).not.toContain('ago');
    });
  });

  describe('formatDate', () => {
    it('returns "unknown" for undefined', () => {
      expect(formatDate(undefined)).toBe('unknown');
    });

    it('returns formatted date for valid timestamp', () => {
      const result = formatDate(Date.now());
      expect(result).not.toBe('unknown');
      expect(typeof result).toBe('string');
    });
  });

  describe('getStatusBadge', () => {
    it('returns green badge for active status', () => {
      const badge = getStatusBadge('active');
      expect(badge).toContain('[active]');
      expect(badge).toContain(ANSI.green);
    });

    it('returns yellow badge for rate-limited status', () => {
      const badge = getStatusBadge('rate-limited');
      expect(badge).toContain('[rate-limited]');
      expect(badge).toContain(ANSI.yellow);
    });

    it('returns red badge for expired status', () => {
      const badge = getStatusBadge('expired');
      expect(badge).toContain('[expired]');
      expect(badge).toContain(ANSI.red);
    });

    it('returns empty string for unknown status', () => {
      expect(getStatusBadge('unknown')).toBe('');
      expect(getStatusBadge(undefined)).toBe('');
    });
  });
});
