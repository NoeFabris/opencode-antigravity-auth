import { describe, it, expect } from 'vitest';
import { parseKey, isTTY, ANSI } from './ansi';

describe('ansi', () => {
  describe('parseKey', () => {
    it('parses arrow up sequences', () => {
      expect(parseKey(Buffer.from('\x1b[A'))).toBe('up');
      expect(parseKey(Buffer.from('\x1bOA'))).toBe('up');
    });

    it('parses arrow down sequences', () => {
      expect(parseKey(Buffer.from('\x1b[B'))).toBe('down');
      expect(parseKey(Buffer.from('\x1bOB'))).toBe('down');
    });

    it('parses enter key (CR and LF)', () => {
      expect(parseKey(Buffer.from('\r'))).toBe('enter');
      expect(parseKey(Buffer.from('\n'))).toBe('enter');
    });

    it('parses Ctrl+C as escape', () => {
      expect(parseKey(Buffer.from('\x03'))).toBe('escape');
    });

    it('parses bare escape as escape-start', () => {
      expect(parseKey(Buffer.from('\x1b'))).toBe('escape-start');
    });

    it('returns null for unknown keys', () => {
      expect(parseKey(Buffer.from('a'))).toBe(null);
      expect(parseKey(Buffer.from('1'))).toBe(null);
      expect(parseKey(Buffer.from(' '))).toBe(null);
      expect(parseKey(Buffer.from('\t'))).toBe(null);
    });

    it('returns null for partial escape sequences', () => {
      expect(parseKey(Buffer.from('\x1b['))).toBe(null);
      expect(parseKey(Buffer.from('\x1bO'))).toBe(null);
    });

    it('returns null for other arrow keys', () => {
      expect(parseKey(Buffer.from('\x1b[C'))).toBe(null);
      expect(parseKey(Buffer.from('\x1b[D'))).toBe(null);
    });
  });

  describe('ANSI codes', () => {
    it('has cursor control codes', () => {
      expect(ANSI.hide).toBe('\x1b[?25l');
      expect(ANSI.show).toBe('\x1b[?25h');
      expect(ANSI.clearLine).toBe('\x1b[2K');
    });

    it('generates cursor movement codes', () => {
      expect(ANSI.up(1)).toBe('\x1b[1A');
      expect(ANSI.up(5)).toBe('\x1b[5A');
      expect(ANSI.down(1)).toBe('\x1b[1B');
      expect(ANSI.down(3)).toBe('\x1b[3B');
    });

    it('has color codes', () => {
      expect(ANSI.cyan).toBe('\x1b[36m');
      expect(ANSI.green).toBe('\x1b[32m');
      expect(ANSI.red).toBe('\x1b[31m');
      expect(ANSI.yellow).toBe('\x1b[33m');
      expect(ANSI.reset).toBe('\x1b[0m');
    });

    it('has style codes', () => {
      expect(ANSI.dim).toBe('\x1b[2m');
      expect(ANSI.bold).toBe('\x1b[1m');
    });
  });

  describe('isTTY', () => {
    it('returns boolean', () => {
      expect(typeof isTTY()).toBe('boolean');
    });
  });
});
