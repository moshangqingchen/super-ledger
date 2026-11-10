import { transactionCnyAmount } from '../engine.mjs';
import { expenseCategories, incomeCategories } from './ledger-categories.mjs';

function monthParts(month) {
  if (typeof month !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) {
    throw new Error('月份格式应为 YYYY-MM');
  }
  return month.split('-').map(Number);
}

function daysInMonth(month) {
  const [year, number] = monthParts(month);
  if (number === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(number) ? 30 : 31;
}

/** Oldest month first, including the selected month and empty calendar months. */
export function monthSequence(endMonth, count = 6) {
  const [year, number] = monthParts(endMonth);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('月份数量必须为非负整数');
  const endIndex = year * 12 + number - 1;
  if (endIndex - count + 1 < 0) throw new Error('月份超出支持范围');
  return Array.from({ length: count }, (_, index) => {
    const absolute = endIndex - count + index + 1;
    return `${String(Math.floor(absolute / 12)).padStart(4, '0')}-${String(absolute % 12 + 1).padStart(2, '0')}`;
  });
}

/** Preserve the ledger's later-entry-first order for transactions on the same day. */
export function sortedLedgerRows(rows, allRows = rows) {
  const indices = new Map(allRows.map((row, index) => [row.id, index]));
  return [...rows].sort((a, b) => b.date.localeCompare(a.date)
    || (indices.get(b.id) ?? -1) - (indices.get(a.id) ?? -1));
}

function addTransaction(total, transaction, state) {
  total.count += 1;
  if (transaction.type === 'income' || transaction.type === 'expense') {
    total[transaction.type] += transactionCnyAmount(transaction, state);
  }
}

/** All monetary results are integer CNY cents, using each transaction's stored rate. */
export function monthlySeries(state, endMonth, count = 6) {
  const series = monthSequence(endMonth, count).map(month => ({
    month, income: 0, expense: 0, balance: 0, count: 0,
  }));
  const byMonth = new Map(series.map(row => [row.month, row]));
  for (const transaction of state.transactions) {
    const total = byMonth.get(transaction.date.slice(0, 7));
    if (total) addTransaction(total, transaction, state);
  }
  for (const total of series) total.balance = total.income - total.expense;
  return series;
}

/** A zero baseline has no percentage. Absolute baseline keeps negative balances intuitive. */
export function monthComparison(current, previous) {
  const difference = current - previous;
  return {
    percent: previous === 0 ? null : difference / Math.abs(previous) * 100,
    direction: difference > 0 ? 'up' : difference < 0 ? 'down' : 'flat',
  };
}

export function groupTransactionsByDay(rows, state) {
  const byDate = new Map();
  for (const transaction of sortedLedgerRows(rows, state.transactions)) {
    let group = byDate.get(transaction.date);
    if (!group) {
      group = { date: transaction.date, rows: [], income: 0, expense: 0, count: 0 };
      byDate.set(transaction.date, group);
    }
    group.rows.push(transaction);
    addTransaction(group, transaction, state);
  }
  return [...byDate.values()];
}

/** Only spending belongs in the expense breakdown; transfers never inflate its totals. */
export function categorySummary(rows, state) {
  const byCategory = new Map();
  for (const transaction of rows) {
    if (transaction.type !== 'expense') continue;
    let group = byCategory.get(transaction.category);
    if (!group) {
      group = { category: transaction.category, amount: 0, count: 0 };
      byCategory.set(transaction.category, group);
    }
    group.amount += transactionCnyAmount(transaction, state);
    group.count += 1;
  }
  for (const [category, budget] of Object.entries(state.settings?.categoryBudgets || {})) {
    const group = byCategory.get(category) || { category, amount: 0, count: 0 };
    group.budget = budget;
    byCategory.set(category, group);
  }
  return [...byCategory.values()].sort((a, b) => b.amount - a.amount);
}

/** Keep every day as a slot; renderers can leave future slots empty without losing data. */
export function dailySeries(state, month, today) {
  const series = Array.from({ length: daysInMonth(month) }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`;
    return { date, income: 0, expense: 0, count: 0, future: date > today };
  });
  const byDate = new Map(series.map(row => [row.date, row]));
  for (const transaction of state.transactions) {
    const total = byDate.get(transaction.date);
    if (total) addTransaction(total, transaction, state);
  }
  return series;
}

/** Round the monthly budget to one daily CNY cent, without binary floating money. */
export function dailyBudget(monthlyBudget, month) {
  if (!Number.isSafeInteger(monthlyBudget) || monthlyBudget < 0) throw new Error('预算必须为非负整数分');
  const days = BigInt(daysInMonth(month));
  return Number((BigInt(monthlyBudget) + days / 2n) / days);
}

/** Only the current month's total budget has a meaningful calendar pace. */
export function budgetPace({ month, today, budget, expense }) {
  if (month !== today.slice(0, 7) || budget <= 0) return null;
  const days = daysInMonth(month), day = Number(today.slice(8, 10));
  const exactBudget = BigInt(budget), exactExpense = BigInt(expense);
  // Cross multiplication keeps the strict ten-point boundary exact in cents.
  const difference = (exactExpense * BigInt(days) - exactBudget * BigInt(day)) * 10n;
  const threshold = exactBudget * BigInt(days);
  const status = expense > budget ? 'over' : difference > threshold ? 'fast'
    : difference < -threshold ? 'room' : 'normal';
  return {
    expectedPercent: day / days * 100,
    usedPercent: expense / budget * 100,
    label: { over: '已超预算', fast: '花得偏快', room: '还有余量', normal: '节奏正常' }[status],
    status,
  };
}

/** Rank values by frequency, retaining the most-recent-first order for ties. */
function frequentValues(rows, valuesFor) {
  const values = new Map();
  for (const row of rows) {
    for (const value of new Set(valuesFor(row).filter(Boolean))) {
      if (!values.has(value)) values.set(value, { value, count: 0, recency: values.size });
      values.get(value).count++;
    }
  }
  return [...values.values()].sort((a, b) => b.count - a.count || a.recency - b.recency)
    .map(item => item.value);
}

export function transactionQuickCategories(state, type) {
  if (!['expense', 'income'].includes(type)) return [];
  const rows = sortedLedgerRows(state.transactions.filter(row => row.type === type), state.transactions).slice(0, 200);
  const builtin = type === 'income' ? incomeCategories : expenseCategories;
  return [...new Set([...frequentValues(rows, row => [row.category]), ...builtin])].slice(0, 5);
}

export function transactionQuickAccounts(state) {
  if (state.accounts.length <= 5) return [...state.accounts];
  const byId = new Map(state.accounts.map(account => [account.id, account]));
  const rows = sortedLedgerRows(state.transactions).slice(0, 200);
  const ranked = frequentValues(rows, row => [row.accountId, row.type === 'transfer' ? row.toAccountId : null]);
  return [...new Set([...ranked, ...byId.keys()])].filter(id => byId.has(id)).slice(0, 4)
    .map(id => byId.get(id));
}

/** Ninety calendar dates including today; no remembered amount leaves this helper. */
export function frequentExpenses(state, today, defaultAccountId) {
  const earliest = new Date(Date.parse(`${today}T00:00:00Z`) - 89 * 86400000).toISOString().slice(0, 10);
  const accounts = new Set(state.accounts.map(account => account.id));
  const fallback = accounts.has(defaultAccountId) ? defaultAccountId : state.accounts[0]?.id || '';
  const groups = new Map();
  for (const row of sortedLedgerRows(state.transactions)) {
    if (row.type !== 'expense' || row.subscriptionId || row.date < earliest || row.date > today || !row.title.trim()) continue;
    if (!groups.has(row.title)) groups.set(row.title, {
      title: row.title, category: row.category,
      accountId: accounts.has(row.accountId) ? row.accountId : fallback,
      count: 0, date: row.date,
    });
    groups.get(row.title).count++;
  }
  // Map insertion already resolves same-day ties in ledger order.
  return [...groups.values()].filter(item => item.count >= 2)
    .sort((a, b) => b.count - a.count || b.date.localeCompare(a.date)).slice(0, 4);
}

/** CNY cent valuations are supplied by getCnyBalances; debts never dilute shares. */
export function accountBalanceShares(state, cnyBalances) {
  const positive = state.accounts.map(account => ({ account, amount: cnyBalances[account.id] }))
    .filter(item => item.amount > 0).sort((a, b) => b.amount - a.amount);
  if (positive.length < 2) return null;
  const total = positive.reduce((sum, item) => sum + item.amount, 0);
  const segments = positive.length <= 4 ? positive : [
    ...positive.slice(0, 3),
    { account: null, name: '其他', amount: positive.slice(3).reduce((sum, item) => sum + item.amount, 0) },
  ];
  return {
    segments: segments.map(item => ({ ...item, percent: item.amount / total * 100 })),
    hasDebt: state.accounts.some(account => cnyBalances[account.id] < 0),
  };
}
