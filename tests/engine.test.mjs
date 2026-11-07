import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  makeInitialState, makeEmptyState, validateState, applyRecurring, getBalances,
  moneyToCents, addMonthsDue, setSubscriptionActive, nextSubscriptionDue, replaceRecord,
} from '../engine.mjs';

function fixture(startDate = '2024-01-31', billingDay = 31) {
  const state = makeEmptyState();
  state.accounts = [{ id: 'bank', name: '测试银行', type: 'bank', openingBalance: 100000, color: '#123456' }];
  state.subscriptions = [{
    id: 'music', name: '音乐', amount: 1800, accountId: 'bank', category: '会员订阅',
    startDate, billingDay, recurring: true, active: true, color: '#123456', icon: 'music', processedOccurrences: [],
  }];
  return state;
}

test('decimal parser uses exact cents and rejects rounding, scientific notation and unsafe amounts', () => {
  assert.equal(moneyToCents('0.29'), 29);
  assert.equal(moneyToCents('18500.10'), 1850010);
  assert.equal(moneyToCents('-1.05'), -105);
  assert.equal(moneyToCents(' 1.2 '), 120);
  assert.equal(moneyToCents('-0'), 0);
  assert.equal(moneyToCents('10000000000'), 1e12);
  for (const input of ['', '1.001', '1e3', '1,000', '.', 'Infinity', '10000000000.01', null, NaN]) {
    assert.throws(() => moneyToCents(input));
  }
});

test('month ends clamp independently, including leap years and year transitions', () => {
  assert.equal(addMonthsDue('2024-01-31', 1, 31), '2024-02-29');
  assert.equal(addMonthsDue('2024-01-31', 2, 31), '2024-03-31');
  assert.equal(addMonthsDue('2023-01-31', 1, 31), '2023-02-28');
  assert.equal(addMonthsDue('2024-12-31', 1, 31), '2025-01-31');
  assert.equal(addMonthsDue('2024-02-29', 1, 31), '2024-03-31');
  assert.throws(() => addMonthsDue('2024-02-30', 1, 31));
});

test('recurring bookings catch up at exact due dates without mutating input or double counting', () => {
  const original = fixture();
  assert.equal(applyRecurring(original, '2024-01-30').added.length, 0);
  const result = applyRecurring(original, '2024-03-30');
  assert.deepEqual(result.added.map(tx => tx.date), ['2024-01-31', '2024-02-29']);
  assert.equal(original.transactions.length, 0);
  assert.equal(getBalances(result.state).bank, 96400);
  assert.equal(applyRecurring(result.state, '2024-03-30').added.length, 0);
  const march = applyRecurring(result.state, '2024-03-31');
  assert.equal(march.added.length, 1);
  assert.equal(march.added[0].date, '2024-03-31');
  assert.equal(getBalances(march.state).bank, 94600);
});

test('future first date remains future and subsequent month obeys billing day', () => {
  const state = fixture('2024-05-20', 20);
  assert.equal(applyRecurring(state, '2024-05-19').added.length, 0);
  const may = applyRecurring(state, '2024-06-19');
  assert.equal(may.added.length, 1);
  assert.equal(may.added[0].date, '2024-05-20');
  assert.equal(nextSubscriptionDue(may.state.subscriptions[0], '2024-06-19'), '2024-06-20');
});

test('next due preserves a future first date across years and follows month-end billing after it', () => {
  const state = fixture('2027-01-31', 31);
  const sub = state.subscriptions[0];
  assert.equal(nextSubscriptionDue(sub, '2026-11-05'), '2027-01-31');
  assert.equal(nextSubscriptionDue(sub, '2026-12-31'), '2027-01-31');
  assert.equal(applyRecurring(state, '2026-12-31').added.length, 0);
  const afterFirst = applyRecurring(state, '2027-01-31').state;
  assert.equal(nextSubscriptionDue(afterFirst.subscriptions[0], '2027-01-31'), '2027-02-28');
  assert.equal(nextSubscriptionDue(afterFirst.subscriptions[0], '2027-02-01'), '2027-02-28');
});

test('next due scans processed future periods and returns null at the supported date boundary', () => {
  const sub = fixture('2024-01-31', 31).subscriptions[0];
  sub.processedOccurrences = ['music:2024-01', 'music:2024-02', 'music:2024-03'];
  assert.equal(nextSubscriptionDue(sub, '2024-01-01'), '2024-04-30');
  const last = fixture('2199-12-31', 31).subscriptions[0];
  assert.equal(nextSubscriptionDue(last, '2199-12-01'), '2199-12-31');
  last.processedOccurrences = ['music:2199-12'];
  assert.equal(nextSubscriptionDue(last, '2199-12-31'), null);
});

test('one-time subscription books once and inactive subscription never books', () => {
  const once = fixture();
  once.subscriptions[0].recurring = false;
  const result = applyRecurring(once, '2026-11-05');
  assert.equal(result.added.length, 1);
  assert.equal(applyRecurring(result.state, '2026-12-05').added.length, 0);
  assert.equal(nextSubscriptionDue(result.state.subscriptions[0], '2026-12-05'), null);
  const paused = fixture();
  paused.subscriptions[0].active = false;
  assert.equal(applyRecurring(paused, '2026-11-05').added.length, 0);
});

test('resume skips paused months without generating hidden debt, but allows same-day due', () => {
  const jan = applyRecurring(fixture(), '2024-01-31').state;
  const paused = setSubscriptionActive(jan, 'music', false, '2024-02-01');
  const resumed = setSubscriptionActive(paused, 'music', true, '2024-04-30');
  const result = applyRecurring(resumed, '2024-04-30');
  assert.deepEqual(result.added.map(tx => tx.date), ['2024-04-30']);
  assert.equal(result.state.transactions.length, 2);
});

test('a recorded occurrence remains idempotent when its processed marker is missing', () => {
  const first = applyRecurring(fixture(), '2024-01-31').state;
  first.subscriptions[0].processedOccurrences = [];
  const result = applyRecurring(first, '2024-01-31');
  assert.equal(result.added.length, 0);
  assert.deepEqual(result.state.subscriptions[0].processedOccurrences, ['music:2024-01']);
});

test('deleting an automatic transaction does not recreate a previously processed booking', () => {
  const first = applyRecurring(fixture(), '2024-01-31').state;
  first.transactions = [];
  assert.equal(applyRecurring(first, '2024-01-31').added.length, 0);
});

test('transfers move money between accounts without changing total wealth', () => {
  const state = makeEmptyState();
  state.accounts = [
    { id: 'a', name: '账户 A', type: 'bank', openingBalance: 10000, color: '#123456' },
    { id: 'b', name: '账户 B', type: 'wallet', openingBalance: -2000, color: '#123456' },
  ];
  state.transactions = [{ id: 'tx1', type: 'transfer', amount: 3000, accountId: 'a', toAccountId: 'b', category: '转账', title: '转账', date: '2024-02-29', note: '' }];
  assert.equal(validateState(state), true);
  const balances = getBalances(state);
  assert.equal(balances.a, 7000);
  assert.equal(balances.b, 1000);
  assert.equal(Object.values(balances).reduce((a, b) => a + b), 8000);
  state.transactions[0].toAccountId = 'a';
  assert.throws(() => validateState(state), /不能相同/);
});

test('account provider IDs survive JSON backup round trips without changing exact balances or legacy accounts', () => {
  const state = makeEmptyState();
  const providers = [
    ['wechat', '微信', '数字钱包'], ['alipay', '支付宝', '数字钱包'],
    ['bank-card', '银行卡', '银行卡'], ['cash', '现金', '现金'],
    ['virtual-card', '虚拟卡', '虚拟卡'],
  ];
  state.accounts = providers.map(([providerId, name, type], index) => ({
    id: `account_${index}`, providerId, name, type,
    openingBalance: moneyToCents(`100.0${index + 1}`), color: '#123456',
  }));
  state.accounts.push({ id: 'legacy', name: '旧账户', type: '钱包', openingBalance: -29, color: '#123456' });
  assert.equal(validateState(state), true);
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(validateState(restored), true);
  assert.deepEqual(restored.accounts, state.accounts);
  assert.deepEqual(restored.accounts.slice(0, 5).map(account => account.providerId), providers.map(item => item[0]));
  assert.equal(Object.hasOwn(restored.accounts[5], 'providerId'), false);
  const balances = getBalances(restored);
  for (let index = 0; index < providers.length; index++) assert.equal(balances[`account_${index}`], 10001 + index);
  assert.equal(balances.legacy, -29);
  assert.equal(Object.values(balances).reduce((sum, value) => sum + value, 0), 49986);
});

test('account provider IDs use the existing safe ID format and optional 80-character limit', () => {
  const state = fixture();
  assert.equal(validateState(state), true);
  state.accounts[0].providerId = `future_${'x'.repeat(73)}`;
  assert.equal(state.accounts[0].providerId.length, 80);
  assert.equal(validateState(state), true);
  for (const providerId of ['', ' ', null, 123, 'bank/card', '<svg>', 'x'.repeat(81)]) {
    state.accounts[0].providerId = providerId;
    assert.throws(() => validateState(state), /账户预设标识/);
  }
  delete state.accounts[0].providerId;
  assert.equal(validateState(state), true);
});

test('asset transfers require two distinct existing account selections', () => {
  const state = makeEmptyState();
  state.accounts = [
    { id: 'from-card', providerId: 'bank-card', name: '转出银行卡', type: '银行卡', openingBalance: 10000, color: '#123456' },
    { id: 'to-card', providerId: 'virtual-card', name: '转入虚拟卡', type: '虚拟卡', openingBalance: 500, color: '#123456' },
  ];
  state.transactions = [{ id: 'asset-transfer', type: 'transfer', amount: 1234, accountId: 'from-card', toAccountId: 'to-card', category: '账户转账', title: '转移资产', date: '2026-11-05', note: '' }];
  assert.equal(validateState(state), true);
  assert.equal(getBalances(state)['from-card'], 8766);
  assert.equal(getBalances(state)['to-card'], 1734);
  assert.equal(Object.values(getBalances(state)).reduce((sum, value) => sum + value, 0), 10500);
  for (const [accountId, toAccountId, message] of [
    ['missing', 'to-card', /交易的账户不存在/],
    ['from-card', 'missing', /转入账户不存在/],
    ['from-card', '', /转入账户不存在/],
    ['from-card', 'from-card', /不能相同/],
  ]) {
    const invalid = structuredClone(state);
    Object.assign(invalid.transactions[0], { accountId, toAccountId });
    assert.throws(() => validateState(invalid), message);
  }
});

test('bank metadata and leading-zero card suffixes survive backups alongside legacy accounts', () => {
  const state = makeEmptyState();
  state.accounts = [
    { id: 'bank-card', providerId: 'bank-card', bankId: 'icbc', lastFour: '0012', name: '工资卡', type: '银行卡', openingBalance: 12345, color: '#123456' },
    { id: 'virtual-card', providerId: 'virtual-card', bankId: 'cmb', lastFour: '0000', name: '订阅卡', type: '虚拟卡', openingBalance: 678, color: '#123456' },
    { id: 'legacy', name: '旧账户', type: '银行卡', openingBalance: 90, color: '#123456' },
  ];
  assert.equal(validateState(state), true);
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(validateState(restored), true);
  assert.deepEqual(restored.accounts, state.accounts);
  assert.deepEqual(restored.accounts.slice(0, 2).map(account => account.lastFour), ['0012', '0000']);
  assert.equal(Object.hasOwn(restored.accounts[2], 'bankId'), false);
  assert.equal(Object.hasOwn(restored.accounts[2], 'lastFour'), false);
  assert.deepEqual(getBalances(restored), getBalances(state));
});

test('bank IDs use safe identifiers while card suffixes accept exactly four ASCII digits', () => {
  const state = fixture();
  state.accounts[0].bankId = 'x'.repeat(80);
  state.accounts[0].lastFour = '0123';
  assert.equal(validateState(state), true);
  for (const bankId of ['', ' ', null, 123, 'bank/card', '<svg>', 'x'.repeat(81)]) {
    state.accounts[0].bankId = bankId;
    assert.throws(() => validateState(state), /银行标识/);
  }
  delete state.accounts[0].bankId;
  for (const lastFour of ['', '123', '12345', '6222021234567890123', '１２３４', '12a4', ' 1234', '1234 ', '1234\n', null, 1234]) {
    state.accounts[0].lastFour = lastFour;
    assert.throws(() => validateState(state), /尾号必须为 4 位数字/);
  }
  delete state.accounts[0].lastFour;
  assert.equal(validateState(state), true);
});

test('two cards at the same bank keep distinct identities and exact transfer balances', () => {
  const state = makeEmptyState();
  state.accounts = [
    { id: 'salary', providerId: 'bank-card', bankId: 'ccb', lastFour: '0012', name: '建设银行', type: '银行卡', openingBalance: 100025, color: '#123456' },
    { id: 'saving', providerId: 'bank-card', bankId: 'ccb', lastFour: '9012', name: '建设银行', type: '银行卡', openingBalance: 20010, color: '#123456' },
  ];
  state.transactions = [{ id: 'between-cards', type: 'transfer', amount: 1234, accountId: 'salary', toAccountId: 'saving', category: '账户转账', title: '同银行转移', date: '2026-11-05', note: '' }];
  assert.equal(validateState(state), true);
  const restored = JSON.parse(JSON.stringify(state));
  const balances = getBalances(restored);
  assert.equal(balances.salary, 98791);
  assert.equal(balances.saving, 21244);
  assert.equal(Object.values(balances).reduce((sum, value) => sum + value, 0), 120035);
  assert.deepEqual(restored.accounts.map(account => account.lastFour), ['0012', '9012']);
  assert.equal(restored.transactions.filter(tx => tx.type === 'income' || tx.type === 'expense').length, 0);
});

test('virtual cards use ordinary cent-accurate balances through transfers and recurring charges without losing provider IDs', () => {
  const state = makeEmptyState();
  state.accounts = [
    { id: 'physical', providerId: 'bank-card', name: '银行卡', type: '银行卡', openingBalance: moneyToCents('100.29'), color: '#123456' },
    { id: 'virtual', providerId: 'virtual-card', name: '虚拟卡', type: '虚拟卡', openingBalance: moneyToCents('100.29'), color: '#123456' },
  ];
  for (const account of state.accounts) {
    state.transactions.push(
      { id: `${account.id}_income`, type: 'income', amount: moneyToCents('12.34'), accountId: account.id, category: '其他收入', title: '收入', date: '2026-11-05', note: '' },
      { id: `${account.id}_expense`, type: 'expense', amount: moneyToCents('5.67'), accountId: account.id, category: '其他支出', title: '支出', date: '2026-11-05', note: '' },
    );
  }
  assert.equal(validateState(state), true);
  assert.equal(getBalances(state).physical, 10696);
  assert.equal(getBalances(state).virtual, 10696);
  const totalBeforeTransfer = Object.values(getBalances(state)).reduce((sum, value) => sum + value, 0);
  state.transactions.push({ id: 'card_transfer', type: 'transfer', amount: moneyToCents('0.29'), accountId: 'physical', toAccountId: 'virtual', category: '账户转账', title: '转入虚拟卡', date: '2026-11-05', note: '' });
  assert.equal(getBalances(state).physical, 10667);
  assert.equal(getBalances(state).virtual, 10725);
  assert.equal(Object.values(getBalances(state)).reduce((sum, value) => sum + value, 0), totalBeforeTransfer);
  state.subscriptions = state.accounts.map(account => ({
    id: `${account.id}_membership`, name: '会员', amount: moneyToCents('0.19'), accountId: account.id,
    category: '会员订阅', startDate: '2026-11-05', billingDay: 5,
    recurring: true, active: true, color: '#123456', icon: 'spark', processedOccurrences: [],
  }));
  const result = applyRecurring(state, '2026-11-05');
  assert.equal(result.added.length, 2);
  assert.deepEqual(result.state.accounts, state.accounts);
  assert.equal(getBalances(result.state).physical, 10648);
  assert.equal(getBalances(result.state).virtual, 10706);
  assert.equal(Object.values(getBalances(result.state)).reduce((sum, value) => sum + value, 0), totalBeforeTransfer - 38);
  assert.equal(state.transactions.length, 5);
  const restored = JSON.parse(JSON.stringify(result.state));
  assert.equal(validateState(restored), true);
  assert.deepEqual(restored.accounts.map(account => account.providerId), ['bank-card', 'virtual-card']);
  assert.equal(applyRecurring(restored, '2026-11-05').added.length, 0);
  assert.deepEqual(getBalances(restored), getBalances(result.state));
});

test('as-of balances exclude future income, expense and both sides of a future transfer', () => {
  const state = makeEmptyState();
  state.accounts = [
    { id: 'bank', name: '银行', type: 'bank', openingBalance: 10000, color: '#123456' },
    { id: 'wallet', name: '钱包', type: 'wallet', openingBalance: 2000, color: '#123456' },
  ];
  const tx = (id, type, amount, date) => ({ id, type, amount, accountId: 'bank', category: '其他', title: '交易', date, note: '' });
  state.transactions = [
    tx('today', 'expense', 500, '2026-11-05'),
    tx('income', 'income', 3000, '2026-11-06'),
    tx('expense', 'expense', 1000, '2026-11-06'),
    { ...tx('transfer', 'transfer', 1500, '2026-11-06'), toAccountId: 'wallet' },
  ];
  assert.equal(validateState(state), true);
  const current = getBalances(state, '2026-11-05');
  assert.equal(current.bank, 9500);
  assert.equal(current.wallet, 2000);
  const all = getBalances(state);
  assert.equal(all.bank, 10000);
  assert.equal(all.wallet, 3500);
  assert.throws(() => getBalances(state, '2026-02-30'));
});

test('invalid backup values, dates, references and duplicate occurrences are rejected', () => {
  for (const mutate of [
    s => { s.accounts[0].openingBalance = 1.5; },
    s => { s.subscriptions[0].amount = 0; },
    s => { s.subscriptions[0].amount = 1e13; },
    s => { s.subscriptions[0].accountId = 'missing'; },
    s => { s.subscriptions[0].startDate = '2023-02-29'; },
    s => { s.subscriptions[0].active = 'true'; },
    s => { s.subscriptions[0].billingDay = 32; },
    s => { s.subscriptions[0].processedOccurrences = ['music:2024-13']; },
    s => { s.accounts.push({ ...s.accounts[0] }); },
    s => { s.settings.monthlyBudget = null; },
  ]) {
    const state = fixture();
    mutate(state);
    assert.throws(() => validateState(state));
  }
  const state = applyRecurring(fixture(), '2024-01-31').state;
  state.transactions.push({ ...state.transactions[0], id: 'another_id' });
  assert.throws(() => validateState(state), /重复记账/);
});

test('balances preserve cents even when intermediate historic sums exceed safe integer precision', () => {
  const state = makeEmptyState();
  state.accounts = [{ id: 'bank', name: '银行', type: 'bank', openingBalance: 1, color: '#123456' }];
  const tx = (id, type) => ({ id, type, amount: 1e12, accountId: 'bank', category: '其他', title: '历史交易', date: '2024-01-01', note: '' });
  for (let i = 0; i < 10000; i++) state.transactions.push(tx(`in_${i}`, 'income'));
  for (let i = 0; i < 10000; i++) state.transactions.push(tx(`out_${i}`, 'expense'));
  assert.equal(validateState(state), true);
  assert.equal(getBalances(state).bank, 1);
});

test('a new personal ledger has no preset budget, accounts, activity, subscriptions or goals', () => {
  const state = makeEmptyState();
  assert.equal(validateState(state), true);
  assert.equal(state.demo, false);
  assert.equal(state.settings.monthlyBudget, 0);
  for (const key of ['accounts', 'transactions', 'subscriptions', 'goals']) assert.deepEqual(state[key], []);
  assert.equal(Object.values(getBalances(state)).reduce((sum, value) => sum + value, 0), 0);
});

test('sample state works on ordinary and first-of-month dates and is explicitly marked demo', () => {
  for (const today of ['2026-11-05', '2026-01-01', '2024-02-29']) {
    const state = makeInitialState(today);
    assert.equal(validateState(state), true);
    assert.equal(state.demo, true);
    assert.equal(state.settings.monthlyBudget, 600000);
    assert.equal(state.accounts.length, 4);
    assert.equal(state.subscriptions.length, 3);
    assert.equal(state.transactions.every(tx => tx.date <= today), true);
  }
  assert.equal(validateState(makeEmptyState()), true);
});

test('replacing a record keeps its position, and a deleted record fails instead of losing the edit', () => {
  const records = [{ id: 'a', title: '旧' }, { id: 'b', title: '留' }];
  replaceRecord(records, 'a', { id: 'a', title: '新' });
  assert.deepEqual(records, [{ id: 'a', title: '新' }, { id: 'b', title: '留' }]);

  const before = JSON.stringify(records);
  assert.throws(() => replaceRecord(records, 'deleted', { id: 'deleted', title: '修改' }), /已被删除/);
  assert.equal(JSON.stringify(records), before);
  assert.equal(Object.hasOwn(records, '-1'), false);
});

test('all four edit forms save through replaceRecord, never through an unchecked index', () => {
  const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /next\.\w+\[next\.\w+\.findIndex/);
  for (const [collection, record] of [['transactions', 'tx'], ['accounts', 'item'], ['subscriptions', 'sub'], ['goals', 'goal']]) {
    assert.ok(source.includes(`if(id)replaceRecord(next.${collection},id,${record});else next.${collection}.push(${record});`), collection);
  }
});
