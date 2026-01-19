import { ANSI } from './ansi';
import { select, type MenuItem } from './select';
import { confirm } from './confirm';

export type AccountStatus = 'active' | 'rate-limited' | 'expired' | 'unknown';

export interface AccountInfo {
  email?: string;
  index: number;
  addedAt?: number;
  lastUsed?: number;
  status?: AccountStatus;
  isCurrentAccount?: boolean;
}

export type AuthMenuAction =
  | { type: 'add' }
  | { type: 'select-account'; account: AccountInfo }
  | { type: 'delete-all' }
  | { type: 'cancel' };

export type AccountAction = 'back' | 'delete' | 'refresh' | 'cancel';

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

function getStatusBadge(status: AccountStatus | undefined): string {
  switch (status) {
    case 'active': return `${ANSI.green}[active]${ANSI.reset}`;
    case 'rate-limited': return `${ANSI.yellow}[rate-limited]${ANSI.reset}`;
    case 'expired': return `${ANSI.red}[expired]${ANSI.reset}`;
    default: return '';
  }
}

export async function showAuthMenu(accounts: AccountInfo[]): Promise<AuthMenuAction> {
  const items: MenuItem<AuthMenuAction>[] = [
    { label: 'Add new account', value: { type: 'add' } },

    ...accounts.map(account => {
      const badge = getStatusBadge(account.status);
      const label = account.email || `Account ${account.index + 1}`;
      const fullLabel = badge ? `${label} ${badge}` : label;
      
      return {
        label: fullLabel,
        hint: account.lastUsed ? `used ${formatRelativeTime(account.lastUsed)}` : '',
        value: { type: 'select-account' as const, account },
      };
    }),

    { label: 'Delete all accounts', value: { type: 'delete-all' }, color: 'red' as const },
  ];

  while (true) {
    const result = await select(items, { 
      message: 'Manage accounts',
      subtitle: 'Select account'
    });

    if (!result) return { type: 'cancel' };

    if (result.type === 'delete-all') {
      const confirmed = await confirm('Delete ALL accounts? This cannot be undone.');
      if (!confirmed) continue;
    }

    return result;
  }
}

export async function showAccountDetails(account: AccountInfo): Promise<AccountAction> {
  const label = account.email || `Account ${account.index + 1}`;
  const badge = getStatusBadge(account.status);
  
  console.log('');
  console.log(`${ANSI.bold}Account: ${label}${badge ? ' ' + badge : ''}${ANSI.reset}`);
  console.log(`${ANSI.dim}Added: ${formatDate(account.addedAt)}${ANSI.reset}`);
  console.log(`${ANSI.dim}Last used: ${formatRelativeTime(account.lastUsed)}${ANSI.reset}`);
  console.log('');

  while (true) {
    const result = await select([
      { label: 'Back', value: 'back' as const },
      { label: 'Refresh token', value: 'refresh' as const, color: 'cyan' },
      { label: 'Delete this account', value: 'delete' as const, color: 'red' },
    ], { 
      message: 'Account options',
      subtitle: 'Select action'
    });

    if (result === 'delete') {
      const confirmed = await confirm(`Delete ${label}?`);
      if (!confirmed) continue;
    }

    if (result === 'refresh') {
      const confirmed = await confirm(`Re-authenticate ${label}?`);
      if (!confirmed) continue;
    }

    return result ?? 'cancel';
  }
}

export { isTTY } from './ansi';
