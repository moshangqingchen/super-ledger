import { bankById } from './bank-catalog.mjs';
import { accountCurrency } from './currencies.mjs';

/** Optional account shortcuts. They never create accounts or set balances. */
export const accountPresets = [
  { id: 'wechat', name: '微信', type: '数字钱包', color: '#28b877', logo: '/assets/brands/wechat.png', aliases: ['微信钱包', '微信零钱', '微信支付'] },
  { id: 'alipay', name: '支付宝', type: '数字钱包', color: '#3e9ee8', logo: '/assets/brands/alipay.ico', aliases: ['支付宝余额'] },
  { id: 'bank-card', name: '银行卡', type: '银行卡', color: '#849fda', icon: 'bankCard' },
  { id: 'cash', name: '现金', type: '现金', color: '#c8a66c', icon: 'cash' },
  { id: 'virtual-card', name: '虚拟卡', type: '虚拟卡', color: '#a28ad6', icon: 'virtualCard' },
];

export function accountPreset(account) {
  if (!account) return undefined;
  if (account.providerId) return accountPresets.find(p => p.id === account.providerId);
  return accountPresets.find(p => [p.name, ...(p.aliases || [])].includes(account.name))
    || accountPresets.find(p => !p.logo && p.type === account.type);
}

/** One consistent label across account pickers, transfers, history and exports. */
export function accountLabel(account) {
  if (!account) return '未知账户';
  const bank = bankById(account.bankId);
  const name = account.name || bank?.name || '未命名账户';
  const label = bank && ![bank.name, bank.shortName].includes(name)
    ? `${bank.name} · ${name}` : name;
  const currency = accountCurrency(account);
  return label + (account.lastFour ? ` · 尾号 ${account.lastFour}` : '')
    + (currency !== 'CNY' ? ` · ${currency}` : '');
}
