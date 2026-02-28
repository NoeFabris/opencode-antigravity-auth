import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ANSI, isTTY } from './ansi';
import { confirm } from './confirm';
import { getUiRuntimeOptions } from './runtime';
import { select, type MenuItem } from './select';
import { paintUiText, formatUiBadge, quotaToneFromLeftPercent } from './format';
import { UI_COPY, formatCheckFlaggedLabel } from './copy';
import type { UiRuntimeOptions } from './runtime';

export type AccountStatus =
  | 'active'
  | 'ok'
  | 'rate-limited'
  | 'cooldown'
  | 'expired'
  | 'verification-required'
  | 'disabled'
  | 'error'
  | 'flagged'
  | 'unknown';

export interface AccountInfo {
  index: number;
  sourceIndex?: number;
  quickSwitchNumber?: number;
  accountId?: string;
  accountLabel?: string;
  email?: string;
  addedAt?: number;
  lastUsed?: number;
  status?: AccountStatus;
  quotaSummary?: string;
  quota5hLeftPercent?: number;
  quota5hResetAtMs?: number;
  quota7dLeftPercent?: number;
  quota7dResetAtMs?: number;
  quotaRateLimited?: boolean;
  isCurrentAccount?: boolean;
  enabled?: boolean;
  verificationRequiredType?: string;
  showStatusBadge?: boolean;
  showCurrentBadge?: boolean;
  showLastUsed?: boolean;
  showQuotaCooldown?: boolean;
  showHintsForUnselectedRows?: boolean;
  highlightCurrentRow?: boolean;
  focusStyle?: 'row-invert' | 'chip';
  statuslineFields?: string[];
}

export interface AuthMenuOptions {
  flaggedCount?: number;
  statusMessage?: string | (() => string | undefined);
}

export type AuthMenuAction =
  | { type: 'add' }
  | { type: 'select-account'; account: AccountInfo }
  | { type: 'set-current-account'; account: AccountInfo }
  | { type: 'refresh-account'; account: AccountInfo }
  | { type: 'toggle-account'; account: AccountInfo }
  | { type: 'delete-account'; account: AccountInfo }
  | { type: 'delete-all' }
  | { type: 'check' }
  | { type: 'verify' }
  | { type: 'verify-all' }
  | { type: 'gemini-cli-login' }
  | { type: 'configure-models' }
  | { type: 'settings' }
  | { type: 'search' }
  | { type: 'cancel' };

export type AccountAction = 'back' | 'delete' | 'refresh' | 'toggle' | 'set-current' | 'verify' | 'cancel';

export function sanitizeTerminalText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
}

export function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return 'never';
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function formatDate(timestamp: number | undefined): string {
  if (!timestamp) return 'unknown';
  return new Date(timestamp).toLocaleDateString();
}

export function statusTone(status: AccountStatus | undefined): 'success' | 'warning' | 'danger' | 'muted' {
  switch (status) {
    case 'active':
    case 'ok':
      return 'success';
    case 'rate-limited':
    case 'cooldown':
      return 'warning';
    case 'disabled':
    case 'error':
    case 'flagged':
    case 'expired':
    case 'verification-required':
      return 'danger';
    default:
      return 'muted';
  }
}

export function statusText(status: AccountStatus | undefined): string {
  return status ?? 'unknown';
}

function statusBadge(status: AccountStatus | undefined): string {
  const ui = getUiRuntimeOptions();
  const withTone = (
    label: string,
    tone: 'accent' | 'success' | 'warning' | 'danger' | 'muted',
  ): string => {
    if (ui.v2Enabled) return formatUiBadge(ui, label, tone);
    if (tone === 'accent') return `${ANSI.bgGreen}${ANSI.black}[${label}]${ANSI.reset}`;
    if (tone === 'success') return `${ANSI.bgGreen}${ANSI.black}[${label}]${ANSI.reset}`;
    if (tone === 'warning') return `${ANSI.bgYellow}${ANSI.black}[${label}]${ANSI.reset}`;
    if (tone === 'danger') return `${ANSI.bgRed}${ANSI.white}[${label}]${ANSI.reset}`;
    return `${ANSI.inverse}[${label}]${ANSI.reset}`;
  };

  const mapping: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'muted' }> = {
    active: { label: 'active', tone: 'success' },
    ok: { label: 'ok', tone: 'success' },
    'rate-limited': { label: 'rate-limited', tone: 'warning' },
    cooldown: { label: 'cooldown', tone: 'warning' },
    flagged: { label: 'flagged', tone: 'danger' },
    disabled: { label: 'disabled', tone: 'danger' },
    error: { label: 'error', tone: 'danger' },
    expired: { label: 'expired', tone: 'danger' },
  };

  const key = status ?? 'unknown';
  const entry = mapping[key];
  if (entry) return withTone(entry.label, entry.tone);
  if (key === 'verification-required') {
    return withTone(ui.v2Enabled ? 'verify' : 'needs verification', 'warning');
  }
  return withTone('unknown', 'muted');
}

export function accountTitle(account: AccountInfo): string {
  const accountNumber = account.quickSwitchNumber ?? account.index + 1;
  const base =
    sanitizeTerminalText(account.email) ||
    sanitizeTerminalText(account.accountLabel) ||
    sanitizeTerminalText(account.accountId) ||
    `Account ${accountNumber}`;
  return `${accountNumber}. ${base}`;
}

function accountSearchText(account: AccountInfo): string {
  return [
    sanitizeTerminalText(account.email),
    sanitizeTerminalText(account.accountLabel),
    sanitizeTerminalText(account.accountId),
    String(account.quickSwitchNumber ?? account.index + 1),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

function accountRowColor(account: AccountInfo): MenuItem<AuthMenuAction>['color'] {
  if (account.isCurrentAccount && account.highlightCurrentRow !== false) return 'green';
  switch (account.status) {
    case 'active':
    case 'ok':
      return 'green';
    case 'rate-limited':
    case 'cooldown':
      return 'yellow';
    case 'disabled':
    case 'error':
    case 'flagged':
    case 'expired':
    case 'verification-required':
      return 'red';
    default:
      return 'yellow';
  }
}

export function normalizeQuotaPercent(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function parseLeftPercentFromSummary(summary: string, windowLabel: '5h' | '7d'): number | null {
  const segments = summary.split('|');
  for (const segment of segments) {
    const trimmed = segment.trim().toLowerCase();
    if (!trimmed.startsWith(`${windowLabel} `)) continue;
    const percentToken = trimmed.slice(windowLabel.length).trim().split(/\s+/)[0] ?? '';
    const parsed = Number.parseInt(percentToken.replace('%', ''), 10);
    if (!Number.isFinite(parsed)) continue;
    return Math.max(0, Math.min(100, parsed));
  }
  return null;
}

export function formatDurationCompact(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export function formatLimitCooldown(resetAtMs: number | undefined): string | null {
  if (typeof resetAtMs !== 'number' || !Number.isFinite(resetAtMs)) return null;
  const remaining = resetAtMs - Date.now();
  if (remaining <= 0) return 'reset ready';
  return `reset ${formatDurationCompact(remaining)}`;
}

function formatQuotaBar(
  leftPercent: number | null,
  ui: UiRuntimeOptions,
): string {
  const width = 10;
  const ratio = leftPercent === null ? 0 : leftPercent / 100;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const filledText = '█'.repeat(filled);
  const emptyText = '▒'.repeat(width - filled);
  if (ui.v2Enabled) {
    const tone = leftPercent === null ? 'muted' : quotaToneFromLeftPercent(leftPercent);
    const filledSegment = filledText.length > 0 ? paintUiText(ui, filledText, tone) : '';
    const emptySegment = emptyText.length > 0 ? paintUiText(ui, emptyText, 'muted') : '';
    return `${filledSegment}${emptySegment}`;
  }
  if (leftPercent === null) return `${ANSI.dim}${emptyText}${ANSI.reset}`;
  const color = leftPercent <= 15 ? ANSI.red : leftPercent <= 35 ? ANSI.yellow : ANSI.green;
  const filledSegment = filledText.length > 0 ? `${color}${filledText}${ANSI.reset}` : '';
  const emptySegment = emptyText.length > 0 ? `${ANSI.dim}${emptyText}${ANSI.reset}` : '';
  return `${filledSegment}${emptySegment}`;
}

function formatQuotaPercent(
  leftPercent: number | null,
  ui: UiRuntimeOptions,
): string | null {
  if (leftPercent === null) return null;
  const percentText = `${leftPercent}%`;
  if (!ui.v2Enabled) {
    const color = leftPercent <= 15 ? ANSI.red : leftPercent <= 35 ? ANSI.yellow : ANSI.green;
    return `${color}${percentText}${ANSI.reset}`;
  }
  const tone = quotaToneFromLeftPercent(leftPercent);
  return paintUiText(ui, percentText, tone);
}

function formatQuotaWindow(
  label: '5h' | '7d',
  leftPercent: number | null,
  resetAtMs: number | undefined,
  showCooldown: boolean,
  ui: UiRuntimeOptions,
): string {
  const labelText = ui.v2Enabled ? paintUiText(ui, label, 'muted') : label;
  const bar = formatQuotaBar(leftPercent, ui);
  const percent = formatQuotaPercent(leftPercent, ui);
  if (!showCooldown) {
    return percent ? `${labelText} ${bar} ${percent}` : `${labelText} ${bar}`;
  }
  const cooldown = formatLimitCooldown(resetAtMs);
  if (!cooldown) {
    return percent ? `${labelText} ${bar} ${percent}` : `${labelText} ${bar}`;
  }
  const cooldownText = ui.v2Enabled ? paintUiText(ui, cooldown, 'muted') : cooldown;
  if (!percent) {
    return `${labelText} ${bar} ${cooldownText}`;
  }
  return `${labelText} ${bar} ${percent} ${cooldownText}`;
}

function formatQuotaSummary(account: AccountInfo, ui: UiRuntimeOptions): string {
  const summary = account.quotaSummary ?? '';
  const showCooldown = account.showQuotaCooldown !== false;
  const left5h = normalizeQuotaPercent(account.quota5hLeftPercent) ?? parseLeftPercentFromSummary(summary, '5h');
  const left7d = normalizeQuotaPercent(account.quota7dLeftPercent) ?? parseLeftPercentFromSummary(summary, '7d');
  const segments: string[] = [];

  if (left5h !== null || typeof account.quota5hResetAtMs === 'number') {
    segments.push(formatQuotaWindow('5h', left5h, account.quota5hResetAtMs, showCooldown, ui));
  }
  if (left7d !== null || typeof account.quota7dResetAtMs === 'number') {
    segments.push(formatQuotaWindow('7d', left7d, account.quota7dResetAtMs, showCooldown, ui));
  }
  if (account.quotaRateLimited || summary.toLowerCase().includes('rate-limited')) {
    segments.push(ui.v2Enabled ? paintUiText(ui, 'rate-limited', 'danger') : `${ANSI.red}rate-limited${ANSI.reset}`);
  }

  if (segments.length === 0) {
    if (!summary) return '';
    return ui.v2Enabled ? paintUiText(ui, summary, 'muted') : summary;
  }

  const separator = ui.v2Enabled ? ` ${paintUiText(ui, '|', 'muted')} ` : ' | ';
  return segments.join(separator);
}

function formatAccountHint(account: AccountInfo, ui: UiRuntimeOptions): string {
  const withKey = (
    key: string,
    value: string,
    tone: 'heading' | 'accent' | 'muted' | 'success' | 'warning' | 'danger',
  ) => {
    if (!ui.v2Enabled) return `${key} ${value}`;
    if (value.includes('\x1b[')) {
      return `${paintUiText(ui, key, 'muted')} ${value}`;
    }
    return `${paintUiText(ui, key, 'muted')} ${paintUiText(ui, value, tone)}`;
  };

  const partsByKey = new Map<string, string>();
  if (account.showStatusBadge === false) {
    partsByKey.set('status', withKey('Status:', statusText(account.status), statusTone(account.status)));
  }
  if (account.showLastUsed !== false) {
    partsByKey.set('last-used', withKey('Last used:', formatRelativeTime(account.lastUsed), 'heading'));
  }
  const quotaSummaryText = formatQuotaSummary(account, ui);
  if (quotaSummaryText) {
    partsByKey.set('limits', withKey('Limits:', quotaSummaryText, 'accent'));
  }

  const fields = account.statuslineFields && account.statuslineFields.length > 0
    ? account.statuslineFields
    : ['last-used', 'limits', 'status'];
  const orderedParts: string[] = [];
  for (const field of fields) {
    const part = partsByKey.get(field);
    if (part) orderedParts.push(part);
  }

  if (orderedParts.length === 0) {
    return '';
  }

  const separator = ui.v2Enabled ? ` ${paintUiText(ui, '|', 'muted')} ` : ' | ';
  if (orderedParts.length === 1) {
    return orderedParts[0] ?? '';
  }

  const firstLine = orderedParts.slice(0, 2).join(separator);
  const secondLine = orderedParts.slice(2).join(separator);
  return secondLine ? `${firstLine}${separator}${secondLine}` : firstLine;
}

async function promptSearchQuery(current: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    return current;
  }

  const rl = createInterface({ input, output });
  try {
    const suffix = current ? ` (${current})` : '';
    const answer = await rl.question(`Search${suffix} (blank clears): `);
    return answer.trim().toLowerCase();
  } finally {
    rl.close();
  }
}

function authMenuFocusKey(action: AuthMenuAction): string {
  switch (action.type) {
    case 'select-account':
    case 'set-current-account':
    case 'refresh-account':
    case 'toggle-account':
    case 'delete-account':
      return `account:${action.account.sourceIndex ?? action.account.index}`;
    case 'add':
    case 'settings':
    case 'check':
    case 'verify':
    case 'verify-all':
    case 'configure-models':
    case 'search':
    case 'delete-all':
    case 'gemini-cli-login':
    case 'cancel':
      return `action:${action.type}`;
  }
}

export async function showAuthMenu(
  accounts: AccountInfo[],
  options: AuthMenuOptions = {},
): Promise<AuthMenuAction> {
  const flaggedCount = options.flaggedCount ?? 0;
  const verifyLabel = formatCheckFlaggedLabel(flaggedCount);
  const ui = getUiRuntimeOptions();
  let showDetailedHelp = false;
  let searchQuery = '';
  let focusKey = 'action:add';
  while (true) {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const visibleAccounts = normalizedSearch.length > 0
      ? accounts.filter((account) => accountSearchText(account).includes(normalizedSearch))
      : accounts;
    const visibleByNumber = new Map<number, AccountInfo>();
    const duplicateQuickSwitchNumbers = new Set<number>();
    for (const account of visibleAccounts) {
      const quickSwitchNumber = account.quickSwitchNumber ?? account.index + 1;
      if (visibleByNumber.has(quickSwitchNumber)) {
        duplicateQuickSwitchNumbers.add(quickSwitchNumber);
        continue;
      }
      visibleByNumber.set(quickSwitchNumber, account);
    }

    const items: MenuItem<AuthMenuAction>[] = [
      { label: UI_COPY.mainMenu.quickStart, value: { type: 'cancel' }, kind: 'heading' },
      { label: UI_COPY.mainMenu.addAccount, value: { type: 'add' }, color: 'cyan' },
      { label: UI_COPY.mainMenu.checkAccounts, value: { type: 'check' }, color: 'cyan' },
      { label: UI_COPY.mainMenu.settings, value: { type: 'settings' }, color: 'cyan' },
      { label: '', value: { type: 'cancel' }, separator: true },
      { label: UI_COPY.mainMenu.moreChecks, value: { type: 'cancel' }, kind: 'heading' },
      { label: UI_COPY.mainMenu.verifyOneAccount, value: { type: 'verify' }, color: 'cyan' },
      { label: verifyLabel, value: { type: 'verify-all' }, color: flaggedCount > 0 ? 'red' : 'yellow' },
      { label: UI_COPY.mainMenu.configureModels, value: { type: 'configure-models' }, color: 'cyan' },
      { label: UI_COPY.mainMenu.geminiCliLogin, value: { type: 'gemini-cli-login' }, color: 'cyan' },
      { label: '', value: { type: 'cancel' }, separator: true },
      { label: UI_COPY.mainMenu.accounts, value: { type: 'cancel' }, kind: 'heading' },
    ];

    if (visibleAccounts.length === 0) {
      items.push({
        label: UI_COPY.mainMenu.noSearchMatches,
        value: { type: 'cancel' },
        disabled: true,
      });
    } else {
      items.push(
        ...visibleAccounts.map((account) => {
          const currentBadge = account.isCurrentAccount && account.showCurrentBadge !== false
            ? ui.v2Enabled
              ? ` ${formatUiBadge(ui, 'current', 'accent')}`
              : ` ${ANSI.cyan}[current]${ANSI.reset}`
            : '';
          const badge = account.showStatusBadge === false ? '' : statusBadge(account.status);
          const statusSuffix = badge ? ` ${badge}` : '';
          const title = ui.v2Enabled
            ? paintUiText(ui, accountTitle(account), account.isCurrentAccount ? 'accent' : 'heading')
            : accountTitle(account);
          const label = `${title}${currentBadge}${statusSuffix}`;
          const hint = formatAccountHint(account, ui);
          const hasHint = hint.length > 0;
          const hintText = hasHint ? hint : undefined;
          return {
            label,
            hint: hintText,
            color: accountRowColor(account),
            value: { type: 'select-account' as const, account },
          };
        }),
      );
    }

    items.push({ label: '', value: { type: 'cancel' }, separator: true });
    items.push({ label: UI_COPY.mainMenu.dangerZone, value: { type: 'cancel' }, kind: 'heading' });
    items.push({ label: UI_COPY.mainMenu.removeAllAccounts, value: { type: 'delete-all' }, color: 'red' });

    const compactHelp = UI_COPY.mainMenu.helpCompact;
    const detailedHelp = UI_COPY.mainMenu.helpDetailed;
    const showHintsForUnselectedRows = visibleAccounts[0]?.showHintsForUnselectedRows ??
      accounts[0]?.showHintsForUnselectedRows ??
      false;
    const focusStyle = visibleAccounts[0]?.focusStyle ??
      accounts[0]?.focusStyle ??
      'row-invert';
    const resolveStatusMessage = (): string | undefined => {
      const raw = typeof options.statusMessage === 'function'
        ? options.statusMessage()
        : options.statusMessage;
      return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
    };
    const buildSubtitle = (): string | undefined => {
      const parts: string[] = [];
      if (normalizedSearch.length > 0) {
        parts.push(`${UI_COPY.mainMenu.searchSubtitlePrefix} ${normalizedSearch}`);
      }
      const resolvedStatus = resolveStatusMessage();
      if (resolvedStatus) {
        parts.push(resolvedStatus);
      }
      if (parts.length === 0) return undefined;
      return parts.join(' | ');
    };
    const initialCursor = items.findIndex((item) => {
      if (item.separator || item.disabled || item.kind === 'heading') return false;
      return authMenuFocusKey(item.value) === focusKey;
    });

    const result = await select(items, {
      message: UI_COPY.mainMenu.title,
      subtitle: buildSubtitle(),
      dynamicSubtitle: buildSubtitle,
      help: showDetailedHelp ? detailedHelp : compactHelp,
      clearScreen: true,
      selectedEmphasis: 'minimal',
      focusStyle,
      showHintsForUnselected: showHintsForUnselectedRows,
      refreshIntervalMs: 200,
      initialCursor: initialCursor >= 0 ? initialCursor : undefined,
      theme: ui.theme,
      onInput: (input, context) => {
        const lower = input.toLowerCase();
        if (lower === '?') {
          showDetailedHelp = !showDetailedHelp;
          context.requestRerender();
          return undefined;
        }
        if (lower === 'q') {
          return { type: 'cancel' as const };
        }
        if (lower === '/') {
          return { type: 'search' as const };
        }
        const parsed = Number.parseInt(input, 10);
        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 9) {
          if (duplicateQuickSwitchNumbers.has(parsed)) {
            return undefined;
          }
          const direct = visibleByNumber.get(parsed);
          if (direct) {
            return { type: 'set-current-account' as const, account: direct };
          }
        }

        const selected = context.items[context.cursor];
        if (!selected || selected.separator || selected.disabled || selected.kind === 'heading') {
          return undefined;
        }
        return undefined;
      },
      onCursorChange: ({ cursor }) => {
        const selected = items[cursor];
        if (!selected || selected.separator || selected.disabled || selected.kind === 'heading') return;
        focusKey = authMenuFocusKey(selected.value);
      },
    });

    if (!result) return { type: 'cancel' };
    if (result.type === 'search') {
      searchQuery = await promptSearchQuery(searchQuery);
      focusKey = 'action:search';
      continue;
    }
    if (result.type === 'delete-all') {
      const confirmed = await confirm('Delete all accounts?');
      if (!confirmed) continue;
    }
    if (result.type === 'delete-account') {
      const confirmed = await confirm(`Delete ${accountTitle(result.account)}?`);
      if (!confirmed) continue;
    }
    if (result.type === 'refresh-account') {
      const confirmed = await confirm(`Re-authenticate ${accountTitle(result.account)}?`);
      if (!confirmed) continue;
    }
    focusKey = authMenuFocusKey(result);
    return result;
  }
}

export async function showAccountDetails(account: AccountInfo): Promise<AccountAction> {
  const ui = getUiRuntimeOptions();
  const header =
    `${accountTitle(account)} ${statusBadge(account.status)}` +
    (account.enabled === false
      ? ui.v2Enabled
        ? ` ${formatUiBadge(ui, 'disabled', 'danger')}`
        : ` ${ANSI.red}[disabled]${ANSI.reset}`
      : '');
  const statusLabel = account.status ?? 'unknown';
  const subtitle = `Added: ${formatDate(account.addedAt)} | Used: ${formatRelativeTime(account.lastUsed)} | Status: ${statusLabel}`;
  let focusAction: AccountAction = 'back';

  while (true) {
    const items: MenuItem<AccountAction>[] = [
      { label: UI_COPY.accountDetails.back, value: 'back' },
      {
        label: account.enabled === false ? UI_COPY.accountDetails.enable : UI_COPY.accountDetails.disable,
        value: 'toggle',
        color: account.enabled === false ? 'cyan' : 'yellow',
      },
      {
        label: UI_COPY.accountDetails.setCurrent,
        value: 'set-current',
        color: 'cyan',
      },
      { label: UI_COPY.accountDetails.refresh, value: 'refresh', color: 'cyan' },
      { label: UI_COPY.accountDetails.remove, value: 'delete', color: 'red' },
    ];
    const initialCursor = items.findIndex((item) => item.value === focusAction);
    const action = await select<AccountAction>(items, {
      message: header,
      subtitle,
      help: UI_COPY.accountDetails.help,
      clearScreen: true,
      selectedEmphasis: 'minimal',
      focusStyle: account.focusStyle ?? 'row-invert',
      initialCursor: initialCursor >= 0 ? initialCursor : undefined,
      theme: ui.theme,
      onInput: (input) => {
        const lower = input.toLowerCase();
        if (lower === 'q') return 'cancel';
        if (lower === 's') return 'set-current';
        if (lower === 'r') return 'refresh';
        if (lower === 't' || lower === 'e' || lower === 'x') return 'toggle';
        if (lower === 'd') return 'delete';
        return undefined;
      },
      onCursorChange: ({ cursor }) => {
        const selected = items[cursor];
        if (!selected || selected.separator || selected.disabled || selected.kind === 'heading') return;
        focusAction = selected.value;
      },
    });

    if (!action) return 'cancel';
    focusAction = action;
    if (action === 'delete') {
      const confirmed = await confirm(`Delete ${accountTitle(account)}?`);
      if (!confirmed) continue;
    }
    if (action === 'refresh') {
      const confirmed = await confirm(`Re-authenticate ${accountTitle(account)}?`);
      if (!confirmed) continue;
    }
    return action;
  }
}

export { isTTY };
