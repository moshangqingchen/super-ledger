import { bankById } from './bank-catalog.mjs';
import { accountCurrency } from './currencies.mjs';

/** Optional account shortcuts. They never create accounts or set balances. */
export const accountPresets = [
  { id: 'wechat', name: '微信', type: '数字钱包', color: '#28b877', logo: '/assets/brands/wechat.png', aliases: ['微信钱包', '微信零钱', '微信支付'] },
  { id: 'alipay', name: '支付宝', type: '数字钱包', color: '#3e9ee8', logo: '/assets/brands/alipay.ico', aliases: ['支付宝余额'] },
  { id: 'bank-card', name: '银行卡', type: '银行卡', color: '#849fda', icon: 'bankCard' },
  { id: 'cash', name: '现金', type: '现金', color: '#c8a66c', icon: 'cash' },
  { id: 'virtual-card', name: '虚拟卡', type: '虚拟卡', color: '#a28ad6', icon: 'virtualCard' },
  { id: 'apple-balance', name: 'Apple 余额', type: 'Apple 账户余额', color: '#77728f', logo: '/assets/brands/apple.svg', icon: 'gift' },
];

/** Region/currency labels for bookkeeping, not a catalogue of gift-card face values. */
export const appleBalanceRegions = Object.freeze([
  { id: 'US', name: '美国', currency: 'USD' },
  { id: 'TR', name: '土耳其', currency: 'TRY' },
  { id: 'JP', name: '日本', currency: 'JPY' },
  { id: 'CN', name: '中国大陆', currency: 'CNY' },
  { id: 'HK', name: '香港', currency: 'HKD' },
  { id: 'GB', name: '英国', currency: 'GBP' },
  { id: 'CA', name: '加拿大', currency: 'CAD' },
  { id: 'AU', name: '澳大利亚', currency: 'AUD' },
  { id: 'CH', name: '瑞士', currency: 'CHF' },
  { id: 'DE', name: '德国', currency: 'EUR' },
  { id: 'FR', name: '法国', currency: 'EUR' },
  { id: 'IT', name: '意大利', currency: 'EUR' },
  { id: 'ES', name: '西班牙', currency: 'EUR' },
  { id: 'NL', name: '荷兰', currency: 'EUR' },
  { id: 'AT', name: '奥地利', currency: 'EUR' },
  { id: 'BE', name: '比利时', currency: 'EUR' },
  { id: 'IE', name: '爱尔兰', currency: 'EUR' },
  { id: 'PT', name: '葡萄牙', currency: 'EUR' },
  { id: 'FI', name: '芬兰', currency: 'EUR' },
  { id: 'GR', name: '希腊', currency: 'EUR' },
  { id: 'LU', name: '卢森堡', currency: 'EUR' },
  { id: 'OTHER', name: '其他国家 / 地区', currency: null },
].map(Object.freeze));

export const appleBalanceRegion = id => appleBalanceRegions.find(region => region.id === id);
export const isAppleBalance = account => account?.providerId === 'apple-balance';

export function accountPreset(account) {
  if (!account) return undefined;
  if (account.providerId) return accountPresets.find(p => p.id === account.providerId);
  // A saved bank and card type identify legacy cards more reliably than a
  // nickname. Editing a card named “微信” must not turn it into a wallet.
  if (bankById(account.bankId) && /银行卡|储蓄卡|信用卡|虚拟卡/.test(account.type || '')) {
    const presetId = /虚拟卡/.test(account.type) ? 'virtual-card' : 'bank-card';
    return accountPresets.find(p => p.id === presetId);
  }
  // Apple balances require an explicit region; do not reclassify older custom accounts by name.
  return accountPresets.find(p => p.id !== 'apple-balance' && [p.name, ...(p.aliases || [])].includes(account.name))
    || accountPresets.find(p => p.id !== 'apple-balance' && !p.logo && p.type === account.type);
}

/** One consistent label across account pickers, transfers, history and exports. */
export function accountLabel(account) {
  if (!account) return '未知账户';
  const bank = bankById(account.bankId);
  const name = account.name || bank?.name || '未命名账户';
  const label = bank && ![bank.name, bank.shortName].includes(name)
    ? `${bank.name} · ${name}` : name;
  const currency = accountCurrency(account);
  if (isAppleBalance(account)) {
    const region = appleBalanceRegion(account.appleRegion);
    return name + (region ? ` · ${region.name}` : '')
      + (account.appleAccount ? ` · ${account.appleAccount}` : '')
      + ` · ${currency}`;
  }
  return label + (account.lastFour ? ` · 尾号 ${account.lastFour}` : '')
    + (currency !== 'CNY' ? ` · ${currency}` : '');
}
