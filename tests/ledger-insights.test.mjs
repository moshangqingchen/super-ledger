import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState, validateState } from '../engine.mjs';
import {
  monthSequence, monthlySeries, monthComparison, groupTransactionsByDay,
  categorySummary, sortedLedgerRows, dailySeries, dailyBudget,
} from '../assets/ledger-insights.mjs';

const transaction = (id, type, amount, date, extra = {}) => ({
  id, type, amount, date, accountId: 'cash', category: '其他支出', title: id, note: '', ...extra,
});

function fixture(transactions = []) {
  const state = makeEmptyState();
  state.schemaVersion = 2;
  state.accounts = [
    { id: 'cash', name: '现金', type: '现金', openingBalance: 0, color: '#123456' },
    { id: 'usd', name: '外币', type: '银行卡', openingBalance: 0, color: '#123456', currency: 'USD', cnyRate: '8' },
  ];
  state.transactions = transactions;
  assert.equal(validateState(state), true);
  return state;
}

test('six calendar months include year transitions and preserve empty months', () => {
  assert.deepEqual(monthSequence('2027-02'), ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
  const state = fixture([
    transaction('old', 'expense', 200, '2026-08-31'),
    transaction('income', 'income', 10000, '2026-12-01'),
    transaction('expense', 'expense', 1250, '2027-02-05'),
    transaction('future', 'expense', 300, '2027-03-01'),
  ]);
  const before = structuredClone(state);
  assert.deepEqual(monthlySeries(state, '2027-02'), [
    { month: '2026-09', income: 0, expense: 0, balance: 0, count: 0 },
    { month: '2026-10', income: 0, expense: 0, balance: 0, count: 0 },
    { month: '2026-11', income: 0, expense: 0, balance: 0, count: 0 },
    { month: '2026-12', income: 10000, expense: 0, balance: 10000, count: 1 },
    { month: '2027-01', income: 0, expense: 0, balance: 0, count: 0 },
    { month: '2027-02', income: 0, expense: 1250, balance: -1250, count: 1 },
  ]);
  assert.deepEqual(state, before);
  assert.deepEqual(monthSequence('2027-02', 0), []);
});

test('month comparison never divides by zero and handles increases, falls and negative balances', () => {
  assert.deepEqual(monthComparison(500, 0), { percent: null, direction: 'up' });
  assert.deepEqual(monthComparison(0, 0), { percent: null, direction: 'flat' });
  assert.deepEqual(monthComparison(-500, 0), { percent: null, direction: 'down' });
  assert.deepEqual(monthComparison(1500, 1000), { percent: 50, direction: 'up' });
  assert.deepEqual(monthComparison(500, 1000), { percent: -50, direction: 'down' });
  assert.deepEqual(monthComparison(0, 1000), { percent: -100, direction: 'down' });
  assert.deepEqual(monthComparison(1000, 1000), { percent: 0, direction: 'flat' });
  assert.deepEqual(monthComparison(-500, -1000), { percent: 50, direction: 'up' });
});

test('daily groups sort newest entries first and total foreign bills using historical rates', () => {
  const state = fixture([
    transaction('usd-expense', 'expense', 101, '2026-11-08', { accountId: 'usd', currency: 'USD', cnyRate: '7.25' }),
    transaction('cash-income', 'income', 5000, '2026-11-08'),
    transaction('cash-expense', 'expense', 29, '2026-11-08'),
    transaction('yesterday', 'expense', 100, '2026-11-07'),
    transaction('transfer', 'transfer', 500, '2026-11-08', { toAccountId: 'usd', toAmount: 65, toCurrency: 'USD', category: '账户转账' }),
  ]);
  const before = structuredClone(state);
  const groups = groupTransactionsByDay(state.transactions, state);
  assert.deepEqual(groups.map(({ date, income, expense, count }) => ({ date, income, expense, count })), [
    { date: '2026-11-08', income: 5000, expense: 761, count: 4 },
    { date: '2026-11-07', income: 0, expense: 100, count: 1 },
  ]);
  assert.deepEqual(groups[0].rows.map(row => row.id), ['transfer', 'cash-expense', 'cash-income', 'usd-expense']);
  const month = monthlySeries(state, '2026-11', 1)[0];
  assert.deepEqual(month, { month: '2026-11', income: 5000, expense: 861, balance: 4139, count: 5 });
  assert.deepEqual(groupTransactionsByDay([], state), []);
  assert.deepEqual(state, before);
});

test('expense categories include custom names and counts, exclude income and transfers, and sort by CNY total', () => {
  const state = fixture([
    transaction('food', 'expense', 200, '2026-11-08', { category: '餐饮美食' }),
    transaction('usd-food', 'expense', 101, '2026-11-08', { category: '餐饮美食', accountId: 'usd', currency: 'USD', cnyRate: '7.25' }),
    transaction('custom', 'expense', 1000, '2026-11-07', { category: '<自定义 & 分类>' }),
    transaction('income', 'income', 50000, '2026-11-08', { category: '餐饮美食' }),
    transaction('transfer', 'transfer', 400, '2026-11-08', { toAccountId: 'usd', toAmount: 50, toCurrency: 'USD', category: '账户转账' }),
  ]);
  const before = structuredClone(state);
  assert.deepEqual(categorySummary(state.transactions, state), [
    { category: '<自定义 & 分类>', amount: 1000, count: 1 },
    { category: '餐饮美食', amount: 932, count: 2 },
  ]);
  assert.deepEqual(categorySummary([], state), []);
  assert.deepEqual(state, before);
});

test('indexed ordering is identical to the old indexOf comparator for full and filtered ledgers', () => {
  const rows = Array.from({ length: 700 }, (_, index) => transaction(
    `tx-${index}`, index % 2 ? 'expense' : 'income', index + 1,
    `2026-${String(index % 3 + 9).padStart(2, '0')}-${String(index * 7 % 28 + 1).padStart(2, '0')}`,
  ));
  const originalIds = rows.map(row => row.id);
  for (const subset of [rows, rows.filter((_, index) => index % 4 === 0), [...rows].reverse(), []]) {
    const expected = [...subset].sort((a, b) => b.date.localeCompare(a.date) || rows.indexOf(b) - rows.indexOf(a));
    assert.deepEqual(sortedLedgerRows(subset, rows), expected);
  }
  const tied = [transaction('first', 'expense', 1, '2026-11-08'), transaction('second', 'expense', 1, '2026-11-08')];
  assert.deepEqual(sortedLedgerRows(tied).map(row => row.id), ['second', 'first']);
  assert.deepEqual(rows.map(row => row.id), originalIds);
});

test('daily series includes empty slots, leap days and future markers independently of income scale', () => {
  const state = fixture([
    transaction('salary', 'income', 1850000, '2024-02-01'),
    transaction('lunch', 'expense', 2800, '2024-02-01'),
    transaction('future', 'expense', 400, '2024-02-29'),
  ]);
  const series = dailySeries(state, '2024-02', '2024-02-08');
  assert.equal(series.length, 29);
  assert.deepEqual(series[0], { date: '2024-02-01', income: 1850000, expense: 2800, count: 2, future: false });
  assert.deepEqual(series[7], { date: '2024-02-08', income: 0, expense: 0, count: 0, future: false });
  assert.deepEqual(series[28], { date: '2024-02-29', income: 0, expense: 400, count: 1, future: true });
  assert.equal(dailySeries(fixture(), '2025-02', '2025-03-01').length, 28);
  assert.equal(dailySeries(fixture(), '2026-11', '2026-10-31').every(row => row.future), true);
});

test('daily budget rounds once to exact cents for all month lengths', () => {
  assert.equal(dailyBudget(600000, '2026-11'), 20000);
  assert.equal(dailyBudget(10000, '2026-01'), 323);
  assert.equal(dailyBudget(10000, '2024-02'), 345);
  assert.equal(dailyBudget(0, '2026-11'), 0);
  assert.equal(dailyBudget(15, '2026-11'), 1);
  assert.throws(() => dailyBudget(1.5, '2026-11'));
  assert.throws(() => monthSequence('2026-13'));
});
