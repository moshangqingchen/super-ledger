import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeEmptyState, validateState, applyRecurring, setSubscriptionActive,
  subscriptionAccountTypes, subscriptionExpiryStatus,
} from '../engine.mjs';

function fixture(extra = {}) {
  const state = makeEmptyState();
  state.accounts.push({ id: 'cash', name: '现金', type: '现金', openingBalance: 100000, color: '#ffffff' });
  state.subscriptions.push({
    id: 'member', name: '会员', amount: 1900, accountId: 'cash', category: '会员订阅',
    startDate: '2024-01-01', billingDay: 1, recurring: true, active: true,
    color: '#123456', icon: 'spark', processedOccurrences: [], ...extra,
  });
  return state;
}

test('old subscriptions remain valid and optional details round-trip without losing account choices', () => {
  assert.equal(validateState(fixture()), true);
  const linkedAccounts = subscriptionAccountTypes.map(({ id }) => ({ type: id, value: `${id}@example.test`, label: '个人账号' }));
  const state = fixture({ linkedAccounts, expiresOn: '2026-12-31', note: '家庭共享\n下次核对实际续费价格' });
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(validateState(restored), true);
  assert.deepEqual(restored, state);
  assert.equal(validateState(fixture({ linkedAccounts: [], expiresOn: '', note: '' })), true);
  assert.equal(validateState(fixture({ linkedAccounts: [{ type: 'other', value: '家庭组编号 123', label: '' }] })), true);
});

test('subscription account and note validation rejects malformed or oversized metadata', () => {
  const badLinks = [
    null, {}, Array.from({ length: 11 }, () => ({ type: 'email', value: 'a@example.test' })),
    [null], [[]], [{ type: 'unknown', value: 'account' }], [{ type: 'email', value: '' }],
    [{ type: 'email', value: '   ' }], [{ type: 'email', value: 123 }],
    [{ type: 'email', value: 'x'.repeat(161) }], [{ type: 'email', value: 'a\u0000b' }],
    [{ type: 'other', value: '123', label: 'x'.repeat(41) }],
  ];
  for (const linkedAccounts of badLinks) {
    assert.throws(() => validateState(fixture({ linkedAccounts })), /关联账号/);
  }
  for (const note of [null, 123, 'x'.repeat(501), 'a\u0000b']) {
    assert.throws(() => validateState(fixture({ note })), /订阅备注/);
  }
  assert.equal(validateState(fixture({ linkedAccounts: [{ type: 'other', value: 'x'.repeat(160), label: 'x'.repeat(40) }], note: 'x'.repeat(500) })), true);
});

test('expiry validation rejects invalid dates and dates before first booking', () => {
  for (const expiresOn of [null, 123, '2024-02-30', '2023-02-29', '2024-2-29', '2200-01-01', '          ', '2023-12-31']) {
    assert.throws(() => validateState(fixture({ expiresOn })), /会员到期日期/);
  }
  assert.equal(validateState(fixture({ expiresOn: '2024-01-01' })), true);
  assert.equal(validateState(fixture({ expiresOn: '2024-02-29' })), true);
});

test('expiry status has inclusive urgency boundaries and explicit date labels', () => {
  const cases = [
    ['2023-12-31', -1, 'expired', '已到期 1 天'],
    ['2024-01-01', 0, 'urgent', '今天到期'],
    ['2024-01-08', 7, 'urgent', '7 天后到期'],
    ['2024-01-09', 8, 'soon', '8 天后到期'],
    ['2024-01-31', 30, 'soon', '30 天后到期'],
    ['2024-02-01', 31, 'normal', '31 天后到期'],
  ];
  for (const [expiresOn, days, tone, label] of cases) {
    const status = subscriptionExpiryStatus(fixture({ expiresOn }).subscriptions[0], '2024-01-01');
    assert.deepEqual(status, { tone, label, detail: `${expiresOn} · 会员到期`, date: expiresOn, days, source: 'expiry' });
  }
});

test('calendar day counts are stable over leap days, year changes and DST dates', () => {
  for (const [referenceDate, expiresOn, days] of [
    ['2024-02-28', '2024-03-01', 2],
    ['2025-02-28', '2025-03-01', 1],
    ['2024-12-31', '2025-01-01', 1],
    ['2026-03-07', '2026-03-09', 2],
    ['2026-10-31', '2026-11-02', 2],
  ]) {
    assert.equal(subscriptionExpiryStatus(fixture({ expiresOn }).subscriptions[0], referenceDate).days, days);
  }
  assert.throws(() => subscriptionExpiryStatus(fixture().subscriptions[0], '2026-02-30'), /当前日期/);
});

test('explicit expiry takes priority while recurring fallback respects processed months and month ends', () => {
  const sub = fixture({ startDate: '2024-01-31', billingDay: 31, processedOccurrences: ['member:2024-01'] }).subscriptions[0];
  const renewal = subscriptionExpiryStatus(sub, '2024-02-22');
  assert.deepEqual(renewal, {
    tone: 'urgent', label: '7 天后续费', detail: '2024-02-29 · 下次续费',
    date: '2024-02-29', days: 7, source: 'renewal',
  });
  assert.equal(subscriptionExpiryStatus(sub, '2024-02-29').label, '今天续费');
  const explicit = subscriptionExpiryStatus({ ...sub, expiresOn: '2024-12-31' }, '2024-02-22');
  assert.equal(explicit.source, 'expiry');
  assert.equal(explicit.date, '2024-12-31');
  const future = subscriptionExpiryStatus({ ...sub, startDate: '2027-01-31', processedOccurrences: [] }, '2026-12-31');
  assert.equal(future.date, '2027-01-31');
  assert.equal(future.days, 31);
});

test('paused and one-time subscriptions retain explicit expiry and otherwise show unset status', () => {
  for (const extra of [{ active: false }, { recurring: false }]) {
    const sub = fixture(extra).subscriptions[0];
    const unset = subscriptionExpiryStatus(sub, '2024-01-01');
    assert.equal(unset.tone, 'unset');
    assert.equal(unset.date, null);
    assert.equal(unset.days, null);
    assert.equal(unset.source, 'none');
    const explicit = subscriptionExpiryStatus({ ...sub, expiresOn: '2024-01-08' }, '2024-01-01');
    assert.equal(explicit.tone, 'urgent');
    assert.equal(explicit.source, 'expiry');
  }
  const exhausted = fixture({ startDate: '2199-12-01', processedOccurrences: ['member:2199-12'] }).subscriptions[0];
  assert.equal(subscriptionExpiryStatus(exhausted, '2199-12-01').tone, 'unset');
});

test('expiry reminders and linked accounts never change booking amounts, schedule or idempotency', () => {
  const plain = fixture();
  const detailed = fixture({
    expiresOn: '2024-01-02', note: '到期后另行续费',
    linkedAccounts: [{ type: 'apple', value: 'member@example.test', label: '家庭账号' }],
  });
  const plainResult = applyRecurring(plain, '2024-03-01');
  const detailedResult = applyRecurring(detailed, '2024-03-01');
  assert.deepEqual(detailedResult.added, plainResult.added);
  assert.equal(detailedResult.added.length, 3);
  assert.deepEqual(detailedResult.state.subscriptions[0].linkedAccounts, detailed.subscriptions[0].linkedAccounts);
  assert.equal(detailedResult.state.subscriptions[0].expiresOn, '2024-01-02');
  assert.equal(applyRecurring(detailedResult.state, '2024-03-01').added.length, 0);
  const paused = setSubscriptionActive(detailedResult.state, 'member', false, '2024-03-01');
  assert.equal(subscriptionExpiryStatus(paused.subscriptions[0], '2024-03-01').tone, 'expired');
  assert.deepEqual(paused.subscriptions[0].linkedAccounts, detailed.subscriptions[0].linkedAccounts);
});
