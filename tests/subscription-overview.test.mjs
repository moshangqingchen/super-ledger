import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState, validateState, upgradeSchemaVersion } from '../engine.mjs';
import { buildSubscriptionOverview, subscriptionPeriodLabel } from '../subscription-overview.mjs';

const NOW = new Date('2026-11-07T02:00:00Z'); // Beijing 10:00.
const account = (id = 'cash', extra = {}) => ({
  id, name: id, type: '现金', openingBalance: 10000, color: '#123456', ...extra,
});
const subscription = (id = 'member', extra = {}) => ({
  id, name: id, amount: 1900, accountId: 'cash', category: '会员订阅',
  startDate: '2026-11-07', startHour: 10, billingDay: 7, billingHour: 18,
  recurring: true, active: true, color: '#123456', icon: 'spark',
  processedOccurrences: [], ...extra,
});
function fixture(subscriptions = [subscription()], accounts = [account()], transactions = []) {
  const state = makeEmptyState();
  state.schemaVersion = 3;
  state.accounts = accounts;
  state.subscriptions = subscriptions;
  state.transactions = transactions;
  upgradeSchemaVersion(state);
  assert.equal(validateState(state), true);
  return state;
}
const transaction = (id, type, amount, accountId, date, extra = {}) => ({
  id, type, amount, accountId, date, category: '其他', title: id, note: '', ...extra,
});

test('overview follows quarterly and annual grid dates and reserves the full installment', () => {
  const state = fixture([
    subscription('quarter', { startDate: '2024-01-31', billingDay: 31, intervalMonths: 3, processedOccurrences: ['quarter:2024-01'] }),
    subscription('year', { startDate: '2024-01-31', billingDay: 31, intervalMonths: 12, processedOccurrences: ['year:2024-01'] }),
  ]);
  const overview = buildSubscriptionOverview(state, new Date('2024-02-22T02:00:00Z'));
  assert.deepEqual(overview.rows.map(row => row.due), ['2024-04-30', '2025-01-31']);
  assert.equal(overview.accounts[0].amount, 3800);
  assert.deepEqual([1, 3, 6, 12].map(intervalMonths => subscriptionPeriodLabel({ recurring: true, intervalMonths })), ['月', '季', '半年', '年']);
  assert.equal(subscriptionPeriodLabel({ recurring: false }), '次');
});

test('empty overview has no dates, funding demand or inferred expiry counts', () => {
  assert.deepEqual(buildSubscriptionOverview(fixture([], []), NOW), {
    today: '2026-11-07', hour: 10, rows: [], accounts: [], totals: [],
    stats: { upcoming: 0, urgent: 0, expired: 0, pending: 0, shortfall: 0 },
  });
  const { rows, stats } = buildSubscriptionOverview(fixture([subscription('unset', { recurring: false })]), NOW);
  assert.equal(rows[0].expiry.source, 'none');
  assert.equal(stats.upcoming, 0);
  assert.equal(stats.urgent, 0);
});

test('membership deadline remains distinct from a pending booking and funding shortage', () => {
  const state = fixture([
    subscription('member', { startDate: '2026-10-07', expiresOn: '2026-12-07', amount: 16000 }),
  ], [account('cash', { openingBalance: 1291 })]);
  const { rows: [row], stats, accounts: [funding] } = buildSubscriptionOverview(state, NOW);
  assert.equal(row.expiry.date, '2026-12-07');
  assert.equal(row.expiry.source, 'expiry');
  assert.equal(row.due, '2026-10-07');
  assert.equal(row.dueHour, 10);
  assert.equal(row.pending, true);
  assert.equal(row.shortfall, 14709);
  assert.equal(funding.due, '2026-10-07');
  assert.equal(funding.amount, 16000, 'only each subscription’s next booking is reserved');
  assert.deepEqual(stats, { upcoming: 1, urgent: 0, expired: 0, pending: 1, shortfall: 1 });
});

test('Beijing date and first/monthly hours control pending at the exact hour', () => {
  const state = fixture();
  assert.equal(buildSubscriptionOverview(state, new Date('2026-11-07T01:59:59Z')).rows[0].pending, false);
  assert.equal(buildSubscriptionOverview(state, NOW).rows[0].pending, true);
  const midnight = buildSubscriptionOverview(state, new Date('2026-11-06T16:00:00Z'));
  assert.equal(midnight.today, '2026-11-07');
  assert.equal(midnight.hour, 0);
  assert.equal(midnight.rows[0].pending, false);
  state.subscriptions[0].processedOccurrences.push('member:2026-11');
  const before = buildSubscriptionOverview(state, new Date('2026-12-07T09:59:59Z'));
  assert.equal(before.rows[0].dueHour, 18);
  assert.equal(before.rows[0].pending, false);
  assert.equal(buildSubscriptionOverview(state, new Date('2026-12-07T10:00:00Z')).rows[0].pending, true);
});

test('expiry statistics include exact 0/7/30 day boundaries without excluding overlapping pending', () => {
  const dates = ['2026-11-06', '2026-11-07', '2026-11-14', '2026-11-15', '2026-12-07', '2026-12-08'];
  const state = fixture(dates.map((expiresOn, i) => subscription(`s${i}`, { startDate: '2026-11-01', expiresOn })));
  const overview = buildSubscriptionOverview(state, NOW);
  assert.deepEqual(overview.rows.map(row => row.expiry.days), [-1, 0, 7, 8, 30, 31]);
  assert.deepEqual(overview.stats, { upcoming: 4, urgent: 2, expired: 1, pending: 6, shortfall: 0 });
});

test('shared account coverage counts its balance once even when both individual fees fit', () => {
  const state = fixture([
    subscription('later', { amount: 8000, startDate: '2026-11-08', startHour: 8 }),
    subscription('early-hour', { amount: 8000, startDate: '2026-11-07', startHour: 9 }),
    subscription('earliest', { amount: 1000, startDate: '2026-11-07', startHour: 8 }),
  ]);
  const overview = buildSubscriptionOverview(state, NOW);
  assert.equal(overview.rows.every(row => row.shortfall === 0), true);
  assert.equal(overview.stats.shortfall, 0, 'row shortage counts individual fees, account shortage is separate');
  const [funding] = overview.accounts;
  assert.equal(funding.balance, 10000);
  assert.equal(funding.amount, 17000);
  assert.equal(funding.shortfall, 7000);
  assert.equal(funding.coverage, 10000 / 17000);
  assert.equal(funding.due, '2026-11-07');
  assert.equal(funding.dueHour, 8);
  assert.deepEqual(funding.subscriptions, overview.rows);
});

test('equal currencies across distinct accounts never use surplus to hide a shortage', () => {
  const state = fixture([
    subscription('first', { accountId: 'rich', amount: 8000, currency: 'USD' }),
    subscription('second', { accountId: 'empty', amount: 8000, currency: 'USD' }),
  ], [
    account('rich', { openingBalance: 20000, currency: 'USD', cnyRate: '7.2' }),
    account('empty', { openingBalance: 0, currency: 'USD', cnyRate: '7.2' }),
  ]);
  const overview = buildSubscriptionOverview(state, NOW);
  assert.deepEqual(overview.accounts.map(row => row.shortfall), [0, 8000]);
  assert.deepEqual(overview.accounts.map(row => row.coverage), [1, 0]);
  assert.deepEqual(overview.totals, [{ currency: 'USD', amount: 16000 }]);
});

test('future transactions are excluded while today’s income and transfer are available', () => {
  const state = fixture([subscription('member', { amount: 1000 })], [
    account('cash', { openingBalance: 0 }), account('source', { openingBalance: 10000 }),
  ], [
    transaction('today-income', 'income', 100, 'cash', '2026-11-07'),
    transaction('today-transfer', 'transfer', 200, 'source', '2026-11-07', { toAccountId: 'cash' }),
    transaction('future-income', 'income', 10000, 'cash', '2026-11-08'),
    transaction('future-transfer', 'transfer', 300, 'source', '2026-11-08', { toAccountId: 'cash' }),
    transaction('future-expense', 'expense', 50, 'cash', '2026-11-08'),
  ]);
  const { rows: [row], accounts: [funding] } = buildSubscriptionOverview(state, NOW);
  assert.equal(row.balance, 300);
  assert.equal(row.shortfall, 700);
  assert.equal(funding.coverage, 0.3);
});

test('paused and completed subscriptions keep expiry reminders without reserving funds', () => {
  const state = fixture([
    subscription('paused', { active: false, expiresOn: '2026-11-06', startDate: '2026-11-01' }),
    subscription('completed', { recurring: false, processedOccurrences: ['completed:2026-11'], expiresOn: '2026-11-14' }),
    subscription('no-expiry', { active: false }),
  ], [account('cash', { openingBalance: 0 })]);
  const overview = buildSubscriptionOverview(state, NOW);
  assert.equal(overview.accounts.length, 0);
  assert.deepEqual(overview.totals, []);
  assert.equal(overview.rows.every(row => row.due === null && row.dueHour === null && !row.pending && !row.canBook && row.shortfall === 0), true);
  assert.deepEqual(overview.stats, { upcoming: 1, urgent: 1, expired: 1, pending: 0, shortfall: 0 });
});

test('native JPY and six-decimal USDT amounts stay separate and negative debt remains in the gap', () => {
  const state = fixture([
    subscription('yen', { amount: 1080, accountId: 'yen', currency: 'JPY' }),
    subscription('token', { amount: 1000001, accountId: 'token', currency: 'USDT' }),
  ], [
    account('yen', { openingBalance: -20, currency: 'JPY', cnyRate: '0.05' }),
    account('token', { openingBalance: 999999, currency: 'USDT', cnyRate: '7.2' }),
  ]);
  const overview = buildSubscriptionOverview(state, NOW);
  assert.deepEqual(overview.totals, [{ currency: 'JPY', amount: 1080 }, { currency: 'USDT', amount: 1000001 }]);
  assert.deepEqual(overview.rows.map(row => row.shortfall), [1100, 2]);
  assert.deepEqual(overview.accounts.map(row => row.shortfall), [1100, 2]);
  assert.equal(overview.accounts[0].coverage, 0);
});

test('month-end renewal uses the engine calendar and supports the final date without inventing a next month', () => {
  const leap = fixture([subscription('month-end', {
    startDate: '2024-01-31', billingDay: 31, processedOccurrences: ['month-end:2024-01'],
  })]);
  const row = buildSubscriptionOverview(leap, new Date('2024-02-22T02:00:00Z')).rows[0];
  assert.equal(row.due, '2024-02-29');
  assert.equal(row.expiry.source, 'renewal');
  assert.equal(row.expiry.days, 7);
  const final = fixture([subscription('final', {
    startDate: '2199-12-31', billingDay: 31, processedOccurrences: ['final:2199-12'],
  })]);
  const overview = buildSubscriptionOverview(final, new Date('2199-12-31T02:00:00Z'));
  assert.equal(overview.rows[0].due, null);
  assert.equal(overview.accounts.length, 0);
});

test('large native forecast totals are exact beyond a single-record limit', () => {
  const state = fixture([
    subscription('one', { recurring: false, amount: 1000000000000 }),
    subscription('two', { recurring: false, amount: 1000000000000 }),
  ], [account('cash', { openingBalance: -1 })]);
  const overview = buildSubscriptionOverview(state, NOW);
  assert.equal(overview.accounts[0].amount, 2000000000000);
  assert.equal(overview.accounts[0].shortfall, 2000000000001);
  assert.equal(overview.totals[0].amount, 2000000000000);
});

test('building an overview accepts frozen data and does not book expenses, mark periods or renew expiry', () => {
  const state = fixture([subscription('member', { expiresOn: '2026-11-07' })]);
  const before = structuredClone(state);
  const freeze = value => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  freeze(state);
  const overview = buildSubscriptionOverview(state, NOW);
  assert.deepEqual(state, before);
  assert.equal(overview.rows[0].sub, state.subscriptions[0]);
  assert.equal(overview.accounts[0].account, state.accounts[0]);
  overview.accounts[0].subscriptions.reverse();
  assert.deepEqual(state, before);
  assert.throws(() => buildSubscriptionOverview(state, new Date('invalid')), /当前时间/);
});
