import test from 'node:test';
import assert from 'node:assert/strict';
import { getCnyBalances, makeEmptyState } from '../engine.mjs';
import { expenseCategories, incomeCategories } from '../assets/ledger-categories.mjs';
import {
  budgetPace, frequentExpenses, transactionQuickCategories,
  transactionQuickAccounts, accountBalanceShares,
} from '../assets/ledger-insights.mjs';

const account = (id, extra = {}) => ({ id, name: id, type: '现金', color: '#aabbcc', openingBalance: 0, ...extra });
const expense = (id, extra = {}) => ({
  id, type: 'expense', title: '午饭', category: '餐饮美食', accountId: 'cash',
  amount: 1234, date: '2026-11-09', note: '', ...extra,
});
function fixture(transactions = []) {
  return { ...makeEmptyState(), accounts: [account('cash'), account('bank')], transactions };
}

test('budget pace covers first and last days, leap months and absent or historical budgets', () => {
  const pace = (today, expense, budget = 300000, month = today.slice(0, 7)) => budgetPace({ month, today, expense, budget });
  assert.deepEqual(pace('2026-11-01', 10000), {
    expectedPercent: 100 / 30, usedPercent: 100 / 30, label: '节奏正常', status: 'normal',
  });
  assert.equal(pace('2026-11-01', 50000).label, '花得偏快');
  assert.equal(pace('2026-11-30', 200000).label, '还有余量');
  assert.equal(pace('2026-11-30', 300000).expectedPercent, 100);
  assert.equal(pace('2026-11-30', 300000).label, '节奏正常');
  assert.equal(pace('2026-11-01', 300001).label, '已超预算');
  assert.equal(pace('2024-02-29', 300000).expectedPercent, 100);
  assert.equal(pace('2024-02-01', 0).expectedPercent, 100 / 29);
  assert.equal(pace('2026-11-09', 0, 0), null);
  assert.equal(pace('2026-11-09', 100, 300000, '2026-10'), null);
  assert.equal(pace('2026-11-09', 100, 300000, '2026-12'), null);
});

test('budget pace treats exactly ten percentage points as normal using integer cent comparisons', () => {
  const pace = expense => budgetPace({ month: '2026-11', today: '2026-11-09', budget: 100000, expense });
  assert.equal(pace(40000).status, 'normal');
  assert.equal(pace(40001).status, 'fast');
  assert.equal(pace(20000).status, 'normal');
  assert.equal(pace(19999).status, 'room');
});

test('quick categories rank the latest 200 of each type by count then recent use and fill built-ins', () => {
  const state = fixture([
    expense('one', { category: '<自定 & 分类>', date: '2026-11-08' }),
    expense('two', { category: '购物消费' }),
    expense('three', { category: '<自定 & 分类>' }),
    expense('income', { type: 'income', category: '额外收入' }),
  ]);
  const before = structuredClone(state);
  assert.deepEqual(transactionQuickCategories(state, 'expense'), ['<自定 & 分类>', '购物消费', '餐饮美食', '交通出行', '居住生活']);
  assert.deepEqual(transactionQuickCategories(state, 'income'), ['额外收入', ...incomeCategories.slice(0, 4)]);
  assert.deepEqual(transactionQuickCategories(fixture(), 'expense'), expenseCategories.slice(0, 5));
  assert.deepEqual(transactionQuickCategories(state, 'transfer'), []);
  assert.deepEqual(state, before);
  const tied = fixture([expense('old', { category: '旧分类' }), expense('new', { category: '新分类' })]);
  assert.deepEqual(transactionQuickCategories(tied, 'expense').slice(0, 2), ['新分类', '旧分类']);
  const limited = fixture([
    ...Array.from({ length: 300 }, (_, i) => expense(`old-${i}`, { category: '窗口之外', date: '2026-10-01' })),
    ...Array.from({ length: 200 }, (_, i) => expense(`new-${i}`, { category: '窗口之内' })),
    ...Array.from({ length: 250 }, (_, i) => expense(`income-${i}`, { type: 'income', category: '工资薪资' })),
  ]);
  assert.equal(transactionQuickCategories(limited, 'expense')[0], '窗口之内');
  assert.equal(transactionQuickCategories(limited, 'expense').includes('窗口之外'), false);
});

test('quick accounts keep all small collections and otherwise rank recent valid source and destination usage', () => {
  const state = fixture();
  assert.deepEqual(transactionQuickAccounts(state), state.accounts);
  assert.notEqual(transactionQuickAccounts(state), state.accounts);
  state.accounts = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => account(id));
  state.transactions = [
    expense('one', { accountId: 'b' }),
    expense('two', { accountId: 'c' }),
    expense('three', { type: 'transfer', accountId: 'd', toAccountId: 'b' }),
    expense('four', { accountId: 'removed' }),
  ];
  const before = structuredClone(state);
  assert.deepEqual(transactionQuickAccounts(state).map(item => item.id), ['b', 'd', 'c', 'a']);
  assert.deepEqual(state, before);
  state.transactions = [
    ...Array.from({ length: 201 }, (_, i) => expense(`old-${i}`, { accountId: 'f', date: '2026-10-01' })),
    ...Array.from({ length: 200 }, (_, i) => expense(`new-${i}`, { accountId: 'e' })),
  ];
  assert.deepEqual(transactionQuickAccounts(state).map(item => item.id), ['e', 'a', 'b', 'c']);
});

test('frequent expense suggestions exclude automatic, non-expense, future and older records at the 90-day boundary', () => {
  const state = fixture([
    expense('at-start', { date: '2026-08-12' }), expense('today'),
    expense('too-old', { title: '过期', date: '2026-08-11' }), expense('old-title', { title: '过期' }),
    expense('future', { title: '未来', date: '2026-11-10' }), expense('future-title', { title: '未来' }),
    expense('sub-one', { title: '自动订阅', subscriptionId: 'sub' }), expense('sub-two', { title: '自动订阅', subscriptionId: 'sub' }),
    expense('income-one', { title: '收入', type: 'income' }), expense('income-two', { title: '收入', type: 'income' }),
    expense('transfer-one', { title: '转账', type: 'transfer' }), expense('transfer-two', { title: '转账', type: 'transfer' }),
  ]);
  const before = structuredClone(state);
  assert.deepEqual(frequentExpenses(state, '2026-11-09', 'bank'), [
    { title: '午饭', category: '餐饮美食', accountId: 'cash', count: 2, date: '2026-11-09' },
  ]);
  assert.deepEqual(state, before);
  assert.deepEqual(frequentExpenses(fixture(), '2026-11-09'), []);
});

test('frequent expenses rank count before date, cap at four, and retain the newest category and live account', () => {
  const state = fixture();
  for (let group = 0; group < 6; group++) {
    const title = `事项${group}`, count = group === 0 ? 3 : 2;
    for (let i = 0; i < count; i++) state.transactions.push(expense(`${group}-${i}`, {
      title, date: `2026-11-0${group + 1}`, category: `分类${i}`, accountId: i === 0 ? 'cash' : 'bank',
    }));
  }
  const items = frequentExpenses(state, '2026-11-09');
  assert.deepEqual(items.map(item => item.title), ['事项0', '事项5', '事项4', '事项3']);
  assert.equal(items[0].category, '分类2');
  assert.equal(items[0].accountId, 'bank');
  assert.equal(items.every(item => !Object.hasOwn(item, 'amount')), true);
});

test('frequent expenses preserve HTML-special titles verbatim and fall back after account deletion', () => {
  const title = '<午饭 & "咖啡">';
  const state = fixture([expense('one', { title }), expense('two', { title, category: '自定分类', accountId: 'deleted' })]);
  assert.deepEqual(frequentExpenses(state, '2026-11-09', 'bank'), [
    { title, category: '自定分类', accountId: 'bank', count: 2, date: '2026-11-09' },
  ]);
  assert.equal(frequentExpenses(state, '2026-11-09', 'also-deleted')[0].accountId, 'cash');
  state.accounts = [];
  assert.equal(frequentExpenses(state, '2026-11-09', 'bank')[0].accountId, '');
});

test('balance shares use positive CNY valuations, omit debt and zero balances, and hide fewer than two positives', () => {
  const state = fixture();
  state.accounts = [
    account('cash', { openingBalance: 10000 }),
    account('usd', { openingBalance: 1000, currency: 'USD', cnyRate: '7.2' }),
    account('debt', { openingBalance: -5000 }), account('zero'),
  ];
  const before = structuredClone(state), shares = accountBalanceShares(state, getCnyBalances(state));
  assert.deepEqual(shares.segments.map(item => [item.account.id, item.amount]), [['cash', 10000], ['usd', 7200]]);
  assert.equal(shares.hasDebt, true);
  assert.equal(shares.segments[0].percent, 10000 / 17200 * 100);
  assert.equal(shares.segments.reduce((sum, item) => sum + item.percent, 0), 100);
  assert.deepEqual(state, before);
  assert.equal(accountBalanceShares(state, { cash: 100, usd: 0, debt: -50, zero: 0 }), null);
  assert.equal(accountBalanceShares(state, { cash: 0, usd: 0, debt: -50, zero: 0 }), null);
});

test('balance shares show at most four segments and combine the rest into exact CNY cents', () => {
  const state = fixture();
  state.accounts = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => account(id));
  const shares = accountBalanceShares(state, { a: 10, b: 90, c: 70, d: 50, e: 30, f: 0 });
  assert.deepEqual(shares.segments.map(item => [item.account?.id || item.name, item.amount]), [
    ['b', 90], ['c', 70], ['d', 50], ['其他', 40],
  ]);
  assert.equal(shares.hasDebt, false);
  assert.equal(accountBalanceShares({ accounts: state.accounts.slice(0, 4) }, { a: 10, b: 90, c: 70, d: 50 }).segments.length, 4);
});
