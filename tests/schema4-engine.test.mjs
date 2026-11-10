import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeEmptyState, validateState, upgradeSchemaVersion, applyRecurring, getBalances,
  nextSubscriptionDue, setSubscriptionActive, occurrenceKey, prepareSubscriptionEdit,
  reconcileSubscriptionExpiry, subscriptionIntervalMonths, subscriptionMonthlyCnyAmount,
  subscriptionAnnualCnyAmount, MAX_MONEY,
} from '../engine.mjs';
import { expenseCategories, incomeCategories } from '../assets/ledger-categories.mjs';

function fixture(interval = 1, startDate = '2024-01-31', billingDay = 31) {
  const state = makeEmptyState();
  state.accounts = [{ id: 'bank', name: '测试银行', type: 'bank', openingBalance: 100000, color: '#123456' }];
  state.subscriptions = [{ id: 'music', name: '音乐', amount: 100, accountId: 'bank', category: '会员订阅',
    startDate, billingDay, recurring: true, active: true, color: '#123456', icon: 'music', processedOccurrences: [],
    ...(interval === 1 ? {} : { intervalMonths: interval }),
  }];
  upgradeSchemaVersion(state);
  return state;
}

const goal = () => ({ id: 'trip', name: '旅行', target: 10001, saved: 50, color: '#123456' });

// Keep these fixed inputs and dates identical to MobileLedgerTest's schema-4 schedule cases.
const scheduleCases = [
  { interval: 1, dates: ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30', '2024-05-31', '2024-06-30',
    '2024-07-31', '2024-08-31', '2024-09-30', '2024-10-31', '2024-11-30', '2024-12-31', '2025-01-31', '2025-02-28'], next: '2025-03-31' },
  { interval: 3, dates: ['2024-01-31', '2024-04-30', '2024-07-31', '2024-10-31', '2025-01-31'], next: '2025-04-30' },
  { interval: 6, dates: ['2024-01-31', '2024-07-31', '2025-01-31'], next: '2025-07-31' },
  { interval: 12, dates: ['2024-01-31', '2025-01-31'], next: '2026-01-31' },
];

for (const { interval, dates, next } of scheduleCases) {
  test(`schema 4 fixed JS/Java schedule: ${interval} month interval clamps month ends and crosses years`, () => {
    const original = fixture(interval);
    Object.assign(original.subscriptions[0], { startHour: 9, billingHour: 18 });
    upgradeSchemaVersion(original);
    const now = new Date('2025-02-28T10:00:00Z');
    const result = applyRecurring(original, now);
    assert.deepEqual(result.added.map(tx => tx.date), dates);
    assert.deepEqual(result.added.map(tx => tx.occurrenceKey), dates.map(date => `music:${date.slice(0, 7)}`));
    assert.deepEqual(result.added.map(tx => tx.id), dates.map(date => `rec_music_${date.slice(0, 7).replace('-', '')}`));
    assert.equal(nextSubscriptionDue(result.state.subscriptions[0], now), next);
    assert.equal(getBalances(result.state).bank, 100000 - dates.length * 100);
    assert.equal(applyRecurring(result.state, now).added.length, 0);
    assert.equal(original.transactions.length, 0);
  });
}

test('annual leap-day schedules keep the original month and clamp independently each year', () => {
  const state = fixture(12, '2024-02-29');
  Object.assign(state.subscriptions[0], { startHour: 9, billingHour: 18 });
  const early = applyRecurring(state, new Date('2025-02-28T09:59:59Z'));
  assert.deepEqual(early.added.map(tx => tx.date), ['2024-02-29']);
  const result = applyRecurring(early.state, new Date('2025-02-28T10:00:00Z'));
  assert.deepEqual(result.added.map(tx => tx.date), ['2025-02-28']);
  assert.equal(nextSubscriptionDue(result.state.subscriptions[0], '2025-02-28'), '2026-02-28');
});

test('quarterly charges retain unpaid past periods and extend expiry only for successful charges', () => {
  const state = fixture(3);
  state.accounts[0].openingBalance = 199;
  state.subscriptions[0].expiresOn = '2024-01-31';
  const partial = applyRecurring(state, '2024-07-31');
  assert.deepEqual(partial.added.map(tx => tx.date), ['2024-01-31']);
  assert.equal(partial.state.subscriptions[0].expiresOn, '2024-04-30');
  assert.equal(nextSubscriptionDue(partial.state.subscriptions[0], '2024-07-31'), '2024-04-30');
  partial.state.transactions.push({ id: 'topup', type: 'income', amount: 101, accountId: 'bank',
    category: '其他收入', title: '补款', date: '2024-07-31', note: '' });
  const paid = applyRecurring(partial.state, '2024-07-31');
  assert.deepEqual(paid.added.map(tx => tx.date), ['2024-04-30', '2024-07-31']);
  assert.equal(paid.state.subscriptions[0].expiresOn, '2024-10-31');
  assert.equal(getBalances(paid.state).bank, 0);
  assert.deepEqual(applyRecurring(paid.state, '2024-07-31').state, paid.state);
});

test('half-yearly pause/resume skips only paused grid periods and preserves same-hour charges', () => {
  const initial = fixture(6);
  initial.subscriptions[0].billingHour = 18;
  const january = applyRecurring(initial, '2024-01-31').state;
  const paused = setSubscriptionActive(january, 'music', false, '2024-02-01');
  assert.equal(applyRecurring(paused, '2025-01-31').added.length, 0);
  const resumed = setSubscriptionActive(paused, 'music', true, new Date('2025-01-31T10:00:00Z'));
  assert.deepEqual(resumed.subscriptions[0].processedOccurrences, ['music:2024-01', 'music:2024-07']);
  assert.deepEqual(applyRecurring(resumed, new Date('2025-01-31T10:00:00Z')).added.map(tx => tx.date), ['2025-01-31']);
});

test('annual renewal advances twelve months and its metadata validates against the interval', () => {
  const state = fixture(12, '2024-02-29');
  state.subscriptions[0].expiresOn = '2024-02-29';
  const result = applyRecurring(state, '2025-02-28').state;
  assert.equal(result.subscriptions[0].expiresOn, '2026-02-28');
  assert.equal(validateState(result), true);
  reconcileSubscriptionExpiry(result, '2025-02-28');
  assert.equal(result.subscriptions[0].expiresOn, '2026-02-28');
  result.subscriptions[0].expiresOn = '2024-04-29';
  assert.throws(() => validateState(result), /到期顺延记录不一致/);
});

test('monthly to annual edits retain off-grid history and reset earned expiry without retroactive changes', () => {
  const state = fixture();
  state.subscriptions[0].expiresOn = '2024-01-31';
  const paid = applyRecurring(state, '2024-03-31').state;
  const previous = paid.subscriptions[0];
  const sub = prepareSubscriptionEdit(previous, { ...structuredClone(previous), intervalMonths: 12 }, paid.transactions, '2024-06-01');
  assert.deepEqual(sub.processedOccurrences, previous.processedOccurrences);
  assert.equal(sub.expiresOn, '2024-04-30');
  assert.deepEqual(sub.expiryRenewal.renewedOccurrences, []);
  assert.deepEqual(sub.expiryRenewal.baselineOccurrences, previous.processedOccurrences);
  paid.subscriptions[0] = sub;
  upgradeSchemaVersion(paid);
  assert.equal(nextSubscriptionDue(sub, '2024-06-01'), '2025-01-31');
  assert.equal(applyRecurring(paid, '2024-12-31').added.length, 0);
  const renewed = applyRecurring(paid, '2025-01-31');
  assert.equal(renewed.added.length, 1);
  assert.equal(renewed.state.subscriptions[0].expiresOn, '2025-04-30');
});

test('annual to monthly edits skip all elapsed new-grid dates but permit today even after its due hour', () => {
  const state = applyRecurring(fixture(12), '2024-01-31').state;
  const previous = state.subscriptions[0];
  const sub = prepareSubscriptionEdit(previous, { ...structuredClone(previous), intervalMonths: 1 }, state.transactions,
    new Date('2024-06-30T12:00:00Z'));
  assert.equal(Object.hasOwn(sub, 'intervalMonths'), false);
  assert.deepEqual(sub.processedOccurrences, ['music:2024-01', 'music:2024-02', 'music:2024-03', 'music:2024-04', 'music:2024-05']);
  assert.equal(nextSubscriptionDue(sub, '2024-06-30'), '2024-06-30');
  state.subscriptions[0] = sub;
  const result = applyRecurring(state, new Date('2024-06-30T12:00:00Z'));
  assert.deepEqual(result.added.map(tx => tx.date), ['2024-06-30']);
  assert.equal(nextSubscriptionDue(result.state.subscriptions[0], '2024-06-30'), '2024-07-31');
  assert.equal(result.state.schemaVersion, 4);
});

test('changing intervals preserves deleted paid markers and does not fabricate skipped payments or expiry', () => {
  const state = fixture(12);
  state.subscriptions[0].processedOccurrences = ['music:2024-01', 'music:2024-02'];
  state.subscriptions[0].expiresOn = '2025-01-31';
  const previous = structuredClone(state.subscriptions[0]);
  prepareSubscriptionEdit(previous, state.subscriptions[0], state.transactions, '2024-05-01');
  assert.deepEqual(state.subscriptions[0], previous, 'saving the same interval never marks additional dates');
  state.subscriptions[0].intervalMonths = 3;
  prepareSubscriptionEdit(previous, state.subscriptions[0], state.transactions, '2024-05-01');
  assert.deepEqual(state.subscriptions[0].processedOccurrences, ['music:2024-01', 'music:2024-02', 'music:2024-04']);
  assert.equal(applyRecurring(state, '2024-05-01').added.length, 0);
  assert.equal(state.subscriptions[0].expiresOn, '2025-01-31');
  assert.deepEqual(state.subscriptions[0].expiryRenewal.renewedOccurrences, []);
});

test('monthly estimates convert before integer division; annual estimates never reuse rounded monthly values', () => {
  const state = fixture(3);
  const sub = state.subscriptions[0], account = state.accounts[0];
  assert.equal(subscriptionMonthlyCnyAmount(sub, account), 33);
  assert.equal(subscriptionAnnualCnyAmount(sub, account), 400);
  assert.notEqual(subscriptionMonthlyCnyAmount(sub, account) * 12, subscriptionAnnualCnyAmount(sub, account));
  Object.assign(account, { currency: 'USD', cnyRate: '1.5' });
  Object.assign(sub, { currency: 'USD', amount: 1 });
  assert.equal(subscriptionMonthlyCnyAmount(sub, account), 1, '1 USD cent -> 2 CNY cents -> 1 monthly CNY cent');
  assert.equal(subscriptionAnnualCnyAmount(sub, account), 8);
  const cnyAccount = { ...account, currency: 'CNY', cnyRate: '1' };
  for (const [interval, monthly, annual] of [[1, 101, 1212], [3, 34, 404], [6, 17, 202], [12, 8, 101]]) {
    assert.equal(subscriptionMonthlyCnyAmount({ ...sub, amount: 101, intervalMonths: interval }, cnyAccount), monthly);
    assert.equal(subscriptionAnnualCnyAmount({ ...sub, amount: 101, intervalMonths: interval }, cnyAccount), annual);
  }
});

test('annual converted aggregate limits use each real interval and include only active recurring charges', () => {
  for (const interval of [1, 3, 6, 12]) {
    const state = fixture(interval);
    state.subscriptions[0].amount = Math.floor(MAX_MONEY / (12 / interval));
    assert.equal(validateState(state), true);
    state.subscriptions.push({ ...structuredClone(state.subscriptions[0]), id: 'extra', amount: 1 });
    assert.throws(() => validateState(state), /年度预估/);
    state.subscriptions[1].active = false;
    assert.equal(validateState(state), true);
  }
});

test('schema 4 fields reject old versions, preserve prior schema without new fields, and never downgrade', () => {
  const mutations = [
    state => { state.subscriptions[0].intervalMonths = 1; },
    state => { state.subscriptions[0].intervalMonths = 12; },
    state => { state.settings.categoryBudgets = { 餐饮美食: 100 }; },
    state => { state.settings.customCategories = { expense: ['宠物'], income: [] }; },
    state => { state.goals = [{ ...goal(), deadline: '2024-02-29' }]; },
  ];
  for (const version of [1, 2, 3]) {
    const old = fixture();
    old.schemaVersion = version;
    assert.equal(upgradeSchemaVersion(old).schemaVersion, version);
    assert.equal(validateState(JSON.parse(JSON.stringify(old))), true);
    for (const mutate of mutations) {
      const state = structuredClone(old);
      mutate(state);
      assert.throws(() => validateState(state), /需要使用版本 4/);
      upgradeSchemaVersion(state);
      assert.equal(state.schemaVersion, 4);
      assert.equal(validateState(JSON.parse(JSON.stringify(state))), true);
      delete state.subscriptions[0].intervalMonths;
      delete state.settings.categoryBudgets;
      delete state.settings.customCategories;
      state.goals = [];
      assert.equal(upgradeSchemaVersion(state).schemaVersion, 4);
      assert.equal(validateState(state), true);
    }
  }
});

test('interval values require allowed integers on recurring subscriptions, including explicit null and undefined rejection', () => {
  for (const value of [null, undefined, false, true, '3', 0, 2, 4, 9, -3, 1.5, NaN, Infinity, {}, []]) {
    const state = fixture(3);
    state.subscriptions[0].intervalMonths = value;
    assert.throws(() => validateState(state), /扣账周期/);
    assert.throws(() => subscriptionIntervalMonths(state.subscriptions[0]), /扣账周期/);
  }
  for (const interval of [1, 3, 6, 12]) {
    const state = fixture(3);
    state.subscriptions[0].intervalMonths = interval;
    assert.equal(validateState(state), true);
    state.subscriptions[0].recurring = false;
    assert.throws(() => validateState(state), /非连续订阅/);
  }
});

test('category budgets strictly validate object type, category names, positive integer cents and item count', () => {
  for (const value of [null, false, [], '预算', 100]) {
    const state = fixture(3);
    state.settings.categoryBudgets = value;
    assert.throws(() => validateState(state), /分类预算/);
  }
  for (const name of ['', ' ', 'x'.repeat(51), 'a\u0001b']) {
    const state = fixture(3);
    state.settings.categoryBudgets = { [name]: 1 };
    assert.throws(() => validateState(state), /预算分类/);
  }
  for (const amount of [0, -1, 0.5, '10', null, false, MAX_MONEY + 1, NaN, Infinity]) {
    const state = fixture(3);
    state.settings.categoryBudgets = { 宠物: amount };
    assert.throws(() => validateState(state), /分类预算金额/);
  }
  const state = fixture(3);
  state.settings.categoryBudgets = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`分类${i}`, MAX_MONEY]));
  assert.equal(validateState(state), true, 'category budgets are independent and need not sum to the total budget');
  state.settings.categoryBudgets.extra = 1;
  assert.throws(() => validateState(state), /不能超过50项/);
});

test('custom categories strictly validate both groups, names, builtin collisions and per-group uniqueness', () => {
  const invalid = [null, [], '', 1, {}, { expense: [] }, { income: [] }, { expense: [], income: [], other: [] },
    { expense: '', income: [] }, { expense: [], income: null },
    { expense: ['重复', '重复'], income: [] }, { expense: [], income: ['重复', '重复'] },
    { expense: Array.from({ length: 31 }, (_, i) => `支出${i}`), income: [] },
    { expense: [], income: Array.from({ length: 31 }, (_, i) => `收入${i}`) },
  ];
  for (const name of ['', ' ', 'x'.repeat(51), null, 1, false, 'a\u0001b', ...expenseCategories, ...incomeCategories]) {
    invalid.push({ expense: [name], income: [] }, { expense: [], income: [name] });
  }
  for (const categories of invalid) {
    const state = fixture(3);
    state.settings.customCategories = categories;
    assert.throws(() => validateState(state), /自定义分类/);
  }
  const state = fixture(3);
  state.settings.customCategories = { expense: Array.from({ length: 30 }, (_, i) => `支出${i}`),
    income: Array.from({ length: 30 }, (_, i) => `收入${i}`) };
  assert.equal(validateState(state), true);
  state.settings.customCategories = { expense: ['x'.repeat(50)], income: ['x'.repeat(50)] };
  assert.equal(validateState(state), true, 'uniqueness is within each group');
});

test('wish deadlines use strict supported calendar dates and round-trip without affecting legacy wishes', () => {
  const state = fixture(3);
  state.goals = [goal()];
  for (const deadline of ['', null, false, 20240229, '2024-2-29', '2023-02-29', '2024-04-31', '1899-12-31', '2200-01-01', '2024-02-29T00:00:00Z']) {
    state.goals[0].deadline = deadline;
    assert.throws(() => validateState(state), /心愿目标日期/);
  }
  for (const deadline of ['1900-01-01', '2024-02-29', '2199-12-31']) {
    state.goals[0].deadline = deadline;
    assert.equal(validateState(JSON.parse(JSON.stringify(state))), true);
  }
  delete state.goals[0].deadline;
  assert.equal(validateState(state), true);
});

test('future first annual charges and the final supported year remain bounded without changing occurrence keys', () => {
  const state = fixture(12, '2199-12-31');
  assert.equal(applyRecurring(state, '2199-12-30').added.length, 0);
  const result = applyRecurring(state, '2199-12-31');
  assert.equal(occurrenceKey(state.subscriptions[0], '2199-12-31'), 'music:2199-12');
  assert.equal(nextSubscriptionDue(result.state.subscriptions[0], '2199-12-31'), null);
});
