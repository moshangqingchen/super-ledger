import {
  beijingDateTime, getBalances, nextSubscriptionDue,
  subscriptionDueHour, subscriptionExpiryStatus,
} from './engine.mjs';
import { accountCurrency } from './currencies.mjs';

export function subscriptionPeriodLabel(sub) {
  return sub.recurring ? ({ 1: '月', 3: '季', 6: '半年', 12: '年' }[sub.intervalMonths ?? 1]) : '次';
}

function amount(exact) {
  const value = Number(exact);
  if (!Number.isSafeInteger(value)) throw new Error('订阅概览合计超过安全金额范围');
  return value;
}

function shortfall(fee, balance) {
  const difference = BigInt(fee) - BigInt(balance);
  return amount(difference > 0n ? difference : 0n);
}

/**
 * Read-only overview of membership dates and the next unprocessed ledger booking.
 * Native minor units stay separate by account/currency. Account coverage reserves
 * exactly one next booking per active subscription, including overdue bookings;
 * it is not a forecast of every billing period or of future account income.
 */
export function buildSubscriptionOverview(state, now = new Date()) {
  const clock = beijingDateTime(now);
  const balances = getBalances(state, clock.date);
  const accountById = new Map(state.accounts.map(account => [account.id, account]));
  const stats = { upcoming: 0, urgent: 0, expired: 0, pending: 0, shortfall: 0 };
  const grouped = new Map();
  const currencyTotals = new Map();

  const rows = state.subscriptions.map(sub => {
    const account = accountById.get(sub.accountId);
    if (!account) throw new Error('订阅扣款账户不存在');
    const currency = accountCurrency(account);
    const balance = balances[sub.accountId];
    const expiry = subscriptionExpiryStatus(sub, now);
    const due = nextSubscriptionDue(sub, now);
    const dueHour = due ? subscriptionDueHour(sub, due) : null;
    const canBook = Boolean(sub.active && due);
    const pending = canBook && (due < clock.date || due === clock.date && dueHour <= clock.hour);
    const row = {
      sub, expiry, due, dueHour, pending,
      accountId: sub.accountId, currency, balance,
      shortfall: canBook ? shortfall(sub.amount, balance) : 0,
      canBook,
    };

    if (Number.isInteger(expiry.days)) {
      if (expiry.days >= 0 && expiry.days <= 30) stats.upcoming++;
      if (expiry.days >= 0 && expiry.days <= 7) stats.urgent++;
      if (expiry.days < 0) stats.expired++;
    }
    if (pending) stats.pending++;
    if (row.shortfall > 0) stats.shortfall++;

    if (canBook) {
      let group = grouped.get(sub.accountId);
      if (!group) {
        group = {
          account, accountId: sub.accountId, currency, balance,
          amount: 0n, subscriptions: [], due, dueHour,
        };
        grouped.set(sub.accountId, group);
      }
      group.amount += BigInt(sub.amount);
      group.subscriptions.push(row);
      if (due < group.due || due === group.due && dueHour < group.dueHour) {
        group.due = due;
        group.dueHour = dueHour;
      }
      currencyTotals.set(currency, (currencyTotals.get(currency) || 0n) + BigInt(sub.amount));
    }
    return row;
  });

  const accounts = [...grouped.values()].map(group => {
    const required = amount(group.amount);
    return {
      ...group,
      amount: required,
      shortfall: shortfall(required, group.balance),
      coverage: Math.max(0, Math.min(1, group.balance / required)),
    };
  });
  const totals = [...currencyTotals].map(([currency, exact]) => ({ currency, amount: amount(exact) }));
  return { today: clock.date, hour: clock.hour, rows, stats, accounts, totals };
}
