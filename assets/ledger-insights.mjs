import { transactionCnyAmount } from '../engine.mjs';

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
