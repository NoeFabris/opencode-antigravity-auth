import { ANSI, isTTY, parseKey } from './ansi';

export interface MenuItem<T = string> {
  label: string;
  value: T;
  hint?: string;
  disabled?: boolean;
  separator?: boolean;
  color?: 'red' | 'green' | 'yellow' | 'cyan';
}

export interface SelectOptions {
  message: string;
  subtitle?: string;
}

const ESCAPE_TIMEOUT_MS = 50;

function getColorCode(color: MenuItem['color']): string {
  switch (color) {
    case 'red': return ANSI.red;
    case 'green': return ANSI.green;
    case 'yellow': return ANSI.yellow;
    case 'cyan': return ANSI.cyan;
    default: return '';
  }
}

export async function select<T>(
  items: MenuItem<T>[],
  options: SelectOptions
): Promise<T | null> {
  if (!isTTY()) {
    throw new Error('Interactive select requires a TTY terminal');
  }

  if (items.length === 0) {
    throw new Error('No menu items provided');
  }

  const enabledItems = items.filter(i => !i.disabled && !i.separator);
  if (enabledItems.length === 0) {
    throw new Error('All items disabled');
  }

  if (enabledItems.length === 1) {
    return enabledItems[0]!.value;
  }

  const { message, subtitle } = options;
  const { stdin, stdout } = process;

  let cursor = items.findIndex(i => !i.disabled && !i.separator);
  if (cursor === -1) cursor = 0; // Fallback, though validation above should prevent this
  let escapeTimeout: ReturnType<typeof setTimeout> | null = null;
  let isCleanedUp = false;
  let isFirstRender = true;

  const getTotalLines = (): number => {
    const subtitleLines = subtitle ? 3 : 0;
    return 1 + subtitleLines + items.length + 1 + 1;
  };

  const render = () => {
    const totalLines = getTotalLines();

    if (!isFirstRender) {
      stdout.write(ANSI.up(totalLines) + '\r');
    }
    isFirstRender = false;

    stdout.write(`${ANSI.clearLine}${ANSI.dim}┌  ${ANSI.reset}${message}\n`);
    
    if (subtitle) {
      stdout.write(`${ANSI.clearLine}${ANSI.dim}│${ANSI.reset}\n`);
      stdout.write(`${ANSI.clearLine}${ANSI.cyan}◆${ANSI.reset}  ${subtitle}\n`);
      stdout.write(`${ANSI.clearLine}\n`);
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;

      if (item.separator) {
        stdout.write(`${ANSI.clearLine}${ANSI.dim}│${ANSI.reset}\n`);
        continue;
      }

      const isSelected = i === cursor;
      const colorCode = getColorCode(item.color);

      let labelText: string;
      if (item.disabled) {
        labelText = `${ANSI.dim}${item.label} (unavailable)${ANSI.reset}`;
      } else if (isSelected) {
        labelText = colorCode ? `${colorCode}${item.label}${ANSI.reset}` : item.label;
        if (item.hint) labelText += ` ${ANSI.dim}${item.hint}${ANSI.reset}`;
      } else {
        labelText = colorCode 
          ? `${ANSI.dim}${colorCode}${item.label}${ANSI.reset}` 
          : `${ANSI.dim}${item.label}${ANSI.reset}`;
        if (item.hint) labelText += ` ${ANSI.dim}${item.hint}${ANSI.reset}`;
      }

      if (isSelected) {
        stdout.write(`${ANSI.clearLine}${ANSI.cyan}│${ANSI.reset}  ${ANSI.green}●${ANSI.reset} ${labelText}\n`);
      } else {
        stdout.write(`${ANSI.clearLine}${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}○${ANSI.reset} ${labelText}\n`);
      }
    }

    stdout.write(`${ANSI.clearLine}${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}↑/↓ to select • Enter: confirm${ANSI.reset}\n`);
    stdout.write(`${ANSI.clearLine}${ANSI.cyan}└${ANSI.reset}\n`);
  };

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw ?? false;

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;

      if (escapeTimeout) {
        clearTimeout(escapeTimeout);
        escapeTimeout = null;
      }

      try {
        stdin.removeListener('data', onKey);
        stdin.setRawMode(wasRaw);
        stdin.pause();
        stdout.write(ANSI.show);
      } catch {
        // Intentionally ignored - cleanup is best-effort
      }

      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    };

    const onSignal = () => {
      cleanup();
      resolve(null);
    };

    const finishWithValue = (value: T | null) => {
      cleanup();
      resolve(value);
    };

    const findNextSelectable = (from: number, direction: 1 | -1): number => {
      if (items.length === 0) return from;
      
      let next = from;
      do {
        next = (next + direction + items.length) % items.length;
      } while (items[next]?.disabled || items[next]?.separator);
      return next;
    };

    const onKey = (data: Buffer) => {
      if (escapeTimeout) {
        clearTimeout(escapeTimeout);
        escapeTimeout = null;
      }

      const action = parseKey(data);

      switch (action) {
        case 'up':
          cursor = findNextSelectable(cursor, -1);
          render();
          return;
        case 'down':
          cursor = findNextSelectable(cursor, 1);
          render();
          return;
        case 'enter':
          finishWithValue(items[cursor]?.value ?? null);
          return;
        case 'escape':
          finishWithValue(null);
          return;
        case 'escape-start':
          // Bare escape byte - wait to see if more bytes coming (arrow key sequence)
          escapeTimeout = setTimeout(() => {
            finishWithValue(null);
          }, ESCAPE_TIMEOUT_MS);
          return;
        default:
          // Unknown key - ignore
          return;
      }
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
      stdin.setRawMode(true);
    } catch {
      // Failed to enable raw mode - cleanup and return null
      cleanup();
      resolve(null);
      return;
    }

    stdin.resume();
    stdout.write(ANSI.hide);
    render();

    stdin.on('data', onKey);
  });
}
