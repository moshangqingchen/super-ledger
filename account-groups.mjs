import { bankById } from './bank-catalog.mjs';
import { accountCurrency } from './currencies.mjs';

const nonCardProviders = new Set(['wechat', 'alipay', 'cash', 'apple-balance']);

export function bankForCard(account) {
  if (nonCardProviders.has(account.providerId)) return undefined;
  const isCard = ['bank-card', 'virtual-card'].includes(account.providerId)
    || /银行卡|储蓄卡|信用卡|虚拟卡/.test(account.type || '');
  return isCard ? bankById(account.bankId) : undefined;
}

function units(value) {
  if (value === undefined) return 0n;
  if (!Number.isSafeInteger(value)) throw new Error('账户分组余额必须使用整数最小单位');
  return BigInt(value);
}

function total(exact) {
  const value = Number(exact);
  if (!Number.isSafeInteger(value)) throw new Error('账户分组合计超过安全金额范围');
  return value;
}

/**
 * Presentation-only grouping; it never merges or changes ledger accounts.
 * Both balance maps contain integer minor units (CNY cents for cnyBalances).
 * Currency subtotals remain separate. Missing map entries mean zero.
 * Groups occupy their first account's position, with member order preserved.
 */
export function groupAccounts(accounts, { balances = {}, cnyBalances = {} } = {}) {
  const groups = [];
  const banks = new Map();

  for (const account of accounts) {
    const bank = bankForCard(account);
    let group = bank ? banks.get(bank.id) : undefined;
    if (!group) {
      group = bank
        ? { kind: 'bank', key: `bank:${bank.id}`, bankId: bank.id, bank, accounts: [] }
        : { kind: 'account', key: `account:${account.id}`, account, accounts: [] };
      groups.push(group);
      if (bank) banks.set(bank.id, group);
    }
    group.accounts.push(account);
  }

  return groups.map(group => {
    let cny = 0n;
    const currencies = new Map();
    for (const account of group.accounts) {
      const currency = accountCurrency(account);
      cny += units(Object.hasOwn(cnyBalances, account.id) ? cnyBalances[account.id] : undefined);
      const native = units(Object.hasOwn(balances, account.id) ? balances[account.id] : undefined);
      currencies.set(currency, (currencies.get(currency) || 0n) + native);
    }
    return {
      ...group,
      totalCny: total(cny),
      currencyTotals: [...currencies].map(([currency, amount]) => ({ currency, amount: total(amount) })),
    };
  });
}
