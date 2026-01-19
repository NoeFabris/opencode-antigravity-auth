/**
 * ANSI escape codes and key parsing for interactive CLI menus.
 * Works cross-platform (Windows/Mac/Linux).
 */

export const ANSI = {
  // Cursor control
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  up: (n = 1) => `\x1b[${n}A`,
  down: (n = 1) => `\x1b[${n}B`,
  clearLine: '\x1b[2K',
  clearScreen: '\x1b[2J',
  moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,
  
  // Styles
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
  inverse: '\x1b[7m',
} as const;

export type KeyAction = 'up' | 'down' | 'enter' | 'escape' | 'escape-start' | null;

/**
 * Parse raw keyboard input buffer into a key action.
 * Handles Windows/Mac/Linux differences in arrow key sequences.
 */
export function parseKey(data: Buffer): KeyAction {
  const s = data.toString();
  
  // Arrow keys (ANSI escape sequences)
  // Standard: \x1b[A (up), \x1b[B (down)
  // Application mode: \x1bOA (up), \x1bOB (down)
  if (s === '\x1b[A' || s === '\x1bOA') return 'up';
  if (s === '\x1b[B' || s === '\x1bOB') return 'down';
  
  // Enter (CR or LF)
  if (s === '\r' || s === '\n') return 'enter';
  
  if (s === '\x03') return 'escape';
  
  if (s === '\x1b') return 'escape-start';
  
  return null;
}

/**
 * Check if the terminal supports interactive input.
 */
export function isTTY(): boolean {
  return Boolean(process.stdin.isTTY);
}
