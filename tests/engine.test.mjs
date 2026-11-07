import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  makeInitialState, makeEmptyState, validateState, applyRecurring, getBalances,
  moneyToCents, addMonthsDue, setSubscriptionActive, nextSubscriptionDue, replaceRecord,
  beijingDateTime, subscriptionDueHour, subscriptionExpiryStatus, upgradeSchemaVersion,
  reconcileSubscriptionExpiry, resetSubscriptionExpiry,
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

test('Beijing subscription clocks use UTC+8 across day and year boundaries', () => {
  assert.deepEqual(beijingDateTime(new Date('2026-11-06T16:00:00Z')), { date: '2026-11-07', hour: 0 });
  assert.deepEqual(beijingDateTime(new Date('2026-12-31T15:59:59Z')), { date: '2026-12-31', hour: 23 });
  assert.deepEqual(beijingDateTime(new Date('2026-12-31T16:00:00Z')), { date: '2027-01-01', hour: 0 });
  assert.throws(() => beijingDateTime(new Date('invalid')), /当前时间/);
});

test('first and monthly charges wait for their configured Beijing hour and remain idempotent', () => {
  const state = fixture('2024-01-31', 31);
  Object.assign(state.subscriptions[0], { startHour: 9, billingHour: 18 });
  upgradeSchemaVersion(state);
  assert.equal(applyRecurring(state, new Date('2024-01-31T00:59:59Z')).added.length, 0);
  const january = applyRecurring(state, new Date('2024-01-31T01:00:00Z'));
  assert.deepEqual(january.added.map(tx => tx.date), ['2024-01-31']);
  assert.equal(applyRecurring(january.state, new Date('2024-01-31T01:59:59Z')).added.length, 0);
  assert.equal(applyRecurring(january.state, new Date('2024-02-29T09:59:59Z')).added.length, 0);
  const february = applyRecurring(january.state, new Date('2024-02-29T10:00:00Z'));
  assert.deepEqual(february.added.map(tx => tx.date), ['2024-02-29']);
  assert.equal(applyRecurring(february.state, new Date('2024-02-29T10:30:00Z')).added.length, 0);
  assert.equal(state.transactions.length, 0);
  assert.equal(subscriptionDueHour(state.subscriptions[0], '2024-01-31'), 9);
  assert.equal(subscriptionDueHour(state.subscriptions[0], '2024-02-29'), 18);
});

test('hourly catch-up books earlier periods while waiting for the current hour', () => {
  const state = fixture('2024-01-31', 31);
  Object.assign(state.subscriptions[0], { startHour: 23, billingHour: 20 });
  upgradeSchemaVersion(state);
  const result = applyRecurring(state, new Date('2024-03-31T11:59:59Z'));
  assert.deepEqual(result.added.map(tx => tx.date), ['2024-01-31', '2024-02-29']);
  assert.deepEqual(applyRecurring(result.state, new Date('2024-03-31T12:00:00Z')).added.map(tx => tx.date), ['2024-03-31']);
  assert.deepEqual(applyRecurring(state, '2024-03-31').added.map(tx => tx.date), ['2024-01-31', '2024-02-29', '2024-03-31']);
});

test('legacy subscriptions book at Beijing midnight and one-time subscriptions respect their hour', () => {
  const legacy = fixture('2026-11-07', 7);
  assert.equal(subscriptionDueHour(legacy.subscriptions[0], '2026-11-07'), 0);
  assert.equal(subscriptionDueHour(legacy.subscriptions[0], '2026-12-07'), 0);
  assert.equal(applyRecurring(legacy, new Date('2026-11-06T15:59:59Z')).added.length, 0);
  assert.equal(applyRecurring(legacy, new Date('2026-11-06T16:00:00Z')).added.length, 1);
  const once = fixture('2026-11-07', 7);
  Object.assign(once.subscriptions[0], { recurring: false, startHour: 14, billingHour: 3 });
  upgradeSchemaVersion(once);
  assert.equal(applyRecurring(once, new Date('2026-11-07T05:59:59Z')).added.length, 0);
  const booked = applyRecurring(once, new Date('2026-11-07T06:00:00Z'));
  assert.equal(booked.added.length, 1);
  assert.equal(applyRecurring(booked.state, new Date('2027-01-01T00:00:00Z')).added.length, 0);
});

test('hourly next-charge dates and renewal reminders share the Beijing clock', () => {
  const sub = fixture('2026-11-07', 7).subscriptions[0];
  Object.assign(sub, { startHour: 9, billingHour: 18 });
  assert.equal(nextSubscriptionDue(sub, new Date('2026-11-07T00:59:59Z')), '2026-11-07');
  assert.equal(nextSubscriptionDue(sub, new Date('2026-11-07T01:30:00Z')), '2026-11-07');
  assert.equal(nextSubscriptionDue(sub, new Date('2026-11-07T02:00:00Z')), '2026-11-07');
  assert.equal(nextSubscriptionDue(sub, '2026-11-07'), '2026-11-07');
  const status = subscriptionExpiryStatus(sub, new Date('2026-11-06T16:01:00Z'));
  assert.equal(status.date, '2026-11-07');
  assert.equal(status.days, 0);
  assert.equal(subscriptionExpiryStatus({ ...sub, expiresOn: '2026-11-07' }, new Date('2026-11-07T16:00:00Z')).days, -1);
});

test('resuming subscriptions skips earlier Beijing hours and preserves a pending same-hour charge', () => {
  const state = fixture('2026-11-07', 7);
  Object.assign(state.subscriptions[0], { startHour: 9, billingHour: 18, active: false });
  upgradeSchemaVersion(state);
  const early = setSubscriptionActive(state, 'music', true, new Date('2026-11-07T00:00:00Z'));
  assert.equal(applyRecurring(early, new Date('2026-11-07T00:59:59Z')).added.length, 0);
  assert.equal(applyRecurring(early, new Date('2026-11-07T01:00:00Z')).added.length, 1);
  const sameHour = setSubscriptionActive(state, 'music', true, new Date('2026-11-07T01:30:00Z'));
  assert.equal(applyRecurring(sameHour, new Date('2026-11-07T01:30:00Z')).added.length, 1);
  const late = setSubscriptionActive(state, 'music', true, new Date('2026-11-07T02:00:00Z'));
  assert.equal(applyRecurring(late, new Date('2026-11-07T02:00:00Z')).added.length, 0);
  assert.deepEqual(late.subscriptions[0].processedOccurrences, ['music:2026-11']);
});

test('subscription hours are optional integers from zero to twenty-three and survive backups', () => {
  const state = fixture();
  assert.equal(validateState(state), true);
  state.schemaVersion = 3;
  for (const field of ['startHour', 'billingHour']) {
    for (const invalid of [-1, 24, 1.5, '9', null]) {
      state.subscriptions[0][field] = invalid;
      assert.throws(() => validateState(state), /扣账小时/);
    }
    state.subscriptions[0][field] = 0;
    assert.equal(validateState(state), true);
    state.subscriptions[0][field] = 23;
    assert.equal(validateState(state), true);
  }
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(validateState(restored), true);
  assert.equal(restored.subscriptions[0].startHour, 23);
  assert.equal(restored.subscriptions[0].billingHour, 23);
});

test('hour schedules require schema three and promotion never downgrades existing schemas', () => {
  const legacy = fixture();
  assert.equal(upgradeSchemaVersion(legacy), legacy);
  assert.equal(legacy.schemaVersion, 1);
  for (const field of ['startHour', 'billingHour']) {
    const state = fixture();
    state.subscriptions[0][field] = 0;
    assert.throws(() => validateState(state), /按小时扣账需要使用版本 3/);
    state.schemaVersion = 2;
    assert.throws(() => validateState(state), /按小时扣账需要使用版本 3/);
    upgradeSchemaVersion(state);
    assert.equal(state.schemaVersion, 3);
    assert.equal(validateState(state), true);
    delete state.subscriptions[0][field];
    upgradeSchemaVersion(state);
    assert.equal(state.schemaVersion, 3);
  }
  const foreign = fixture();
  Object.assign(foreign.accounts[0], { currency: 'USD', cnyRate: '7.2' });
  foreign.subscriptions[0].currency = 'USD';
  upgradeSchemaVersion(foreign);
  assert.equal(foreign.schemaVersion, 2);
  foreign.subscriptions[0].startHour = 9;
  upgradeSchemaVersion(foreign);
  assert.equal(foreign.schemaVersion, 3);
  assert.equal(validateState(foreign), true);
  foreign.schemaVersion = 4;
  upgradeSchemaVersion(foreign);
  assert.throws(() => validateState(foreign), /不支持此账本版本/);
});

test('a successful Beijing-hour payment advances explicit membership expiry once', () => {
  const state = fixture('2026-11-07', 7);
  Object.assign(state.subscriptions[0], { startHour: 10, billingHour: 10, expiresOn: '2026-11-07' });
  upgradeSchemaVersion(state);
  const original = structuredClone(state);
  const before = applyRecurring(state, new Date('2026-11-07T01:59:59Z'));
  assert.equal(before.added.length, 0);
  assert.equal(before.state.subscriptions[0].expiresOn, '2026-11-07');
  const paid = applyRecurring(before.state, new Date('2026-11-07T02:00:00Z'));
  assert.equal(paid.added.length, 1);
  assert.equal(paid.state.subscriptions[0].expiresOn, '2026-12-07');
  assert.deepEqual(paid.state.subscriptions[0].expiryRenewal, {
    baseDate: '2026-11-07', baselineOccurrences: [], renewedOccurrences: ['music:2026-11'],
  });
  assert.equal(subscriptionExpiryStatus(paid.state.subscriptions[0], '2026-11-07').days, 30);
  assert.deepEqual(applyRecurring(paid.state, new Date('2026-11-07T02:30:00Z')).state, paid.state);
  assert.deepEqual(state, original);
});

test('expiry renewal keeps its original calendar-day anchor across catch-up and short months', () => {
  for (const [start, afterFirst, afterSecond, afterThird] of [
    ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30'],
    ['2023-01-31', '2023-02-28', '2023-03-31', '2023-04-30'],
  ]) {
    const state = fixture(start, 31);
    state.subscriptions[0].expiresOn = start;
    const first = applyRecurring(state, start);
    assert.equal(first.state.subscriptions[0].expiresOn, afterFirst);
    const second = applyRecurring(first.state, afterFirst);
    assert.equal(second.state.subscriptions[0].expiresOn, afterSecond);
    const third = applyRecurring(second.state, afterSecond);
    assert.equal(third.state.subscriptions[0].expiresOn, afterThird);
    assert.deepEqual(applyRecurring(state, afterSecond).state, third.state);
    const restored = JSON.parse(JSON.stringify(third.state));
    assert.equal(validateState(restored), true);
    assert.deepEqual(applyRecurring(restored, afterSecond).state, restored);
  }
  const leap = fixture('2024-02-29', 29);
  leap.subscriptions[0].expiresOn = '2024-02-29';
  const january = applyRecurring(leap, '2025-01-29');
  assert.equal(january.state.subscriptions[0].expiresOn, '2025-02-28');
  assert.equal(applyRecurring(january.state, '2025-02-28').state.subscriptions[0].expiresOn, '2025-03-29');
});

test('new payments extend an already future explicit expiry without shortening it', () => {
  const state = fixture('2026-11-07', 7);
  state.subscriptions[0].expiresOn = '2026-12-31';
  const paid = applyRecurring(state, '2026-11-07');
  assert.equal(paid.state.subscriptions[0].expiresOn, '2027-01-31');
  assert.equal(paid.state.subscriptions[0].expiryRenewal.baseDate, '2026-12-31');
});

test('existing paid subscriptions repair stale expiry once and baseline already covered history', () => {
  const legacy = applyRecurring(fixture('2026-11-07', 7), '2026-11-07').state;
  legacy.subscriptions[0].expiresOn = '2026-11-07';
  const original = structuredClone(legacy);
  const repaired = applyRecurring(legacy, '2026-11-07');
  assert.equal(repaired.added.length, 0);
  assert.equal(repaired.state.subscriptions[0].expiresOn, '2026-12-07');
  assert.deepEqual(repaired.state.transactions, legacy.transactions);
  assert.deepEqual(applyRecurring(repaired.state, '2026-11-07').state, repaired.state);
  assert.deepEqual(legacy, original);

  const future = structuredClone(legacy);
  future.subscriptions[0].expiresOn = '2026-12-31';
  const covered = applyRecurring(future, '2026-11-07');
  assert.equal(covered.state.subscriptions[0].expiresOn, '2026-12-31');
  assert.deepEqual(covered.state.subscriptions[0].expiryRenewal.baselineOccurrences, ['music:2026-11']);
  assert.deepEqual(covered.state.subscriptions[0].expiryRenewal.renewedOccurrences, []);

  const history = applyRecurring(fixture(), '2024-03-31').state;
  history.subscriptions[0].expiresOn = '2024-01-31';
  assert.equal(applyRecurring(history, '2024-03-31').state.subscriptions[0].expiresOn, '2024-04-30');
});

test('expiry renewal requires a real recurring payment and retains history after transaction deletion', () => {
  const state = fixture('2026-11-07', 7);
  Object.assign(state.subscriptions[0], { expiresOn: '2026-11-07', processedOccurrences: ['music:2026-11'] });
  const skipped = applyRecurring(state, '2026-11-07');
  assert.equal(skipped.state.subscriptions[0].expiresOn, '2026-11-07');
  assert.deepEqual(skipped.state.subscriptions[0].expiryRenewal.renewedOccurrences, []);
  const paused = fixture('2026-11-07', 7);
  Object.assign(paused.subscriptions[0], { expiresOn: '2026-11-07', active: false });
  assert.equal(applyRecurring(paused, '2026-12-07').state.subscriptions[0].expiresOn, '2026-11-07');

  const once = fixture('2026-11-07', 7);
  Object.assign(once.subscriptions[0], { expiresOn: '2026-11-07', recurring: false });
  const single = applyRecurring(once, '2026-11-07');
  assert.equal(single.added.length, 1);
  assert.equal(single.state.subscriptions[0].expiresOn, '2026-11-07');
  assert.equal(Object.hasOwn(single.state.subscriptions[0], 'expiryRenewal'), false);
  const noExpiry = applyRecurring(fixture('2026-11-07', 7), '2026-11-07');
  assert.equal(Object.hasOwn(noExpiry.state.subscriptions[0], 'expiryRenewal'), false);
  assert.equal(nextSubscriptionDue(noExpiry.state.subscriptions[0], '2026-11-07'), '2026-12-07');

  const paid = fixture('2026-11-07', 7);
  paid.subscriptions[0].expiresOn = '2026-11-07';
  const deleted = applyRecurring(paid, '2026-11-07').state;
  deleted.transactions = [];
  assert.deepEqual(applyRecurring(deleted, '2026-11-07').state, deleted);
});

test('newly synchronized real expenses advance an initialized expiry only after their Beijing date arrives', () => {
  const state = fixture('2026-11-07', 7);
  state.subscriptions[0].expiresOn = '2026-11-07';
  const initialized = applyRecurring(state, '2026-11-06').state;
  const paid = applyRecurring(state, '2026-11-07').state;
  initialized.transactions = paid.transactions;
  assert.equal(reconcileSubscriptionExpiry(initialized, '2026-11-06'), initialized);
  assert.equal(initialized.subscriptions[0].expiresOn, '2026-11-07');
  reconcileSubscriptionExpiry(initialized, '2026-11-07');
  assert.equal(initialized.subscriptions[0].expiresOn, '2026-12-07');
  const snapshot = structuredClone(initialized);
  reconcileSubscriptionExpiry(initialized, '2026-11-07');
  assert.deepEqual(initialized, snapshot);
});

test('future imported payments remain uncovered until their Beijing date arrives', () => {
  const imported = applyRecurring(fixture('2026-11-07', 7), '2026-11-07').state;
  imported.subscriptions[0].expiresOn = '2026-11-07';
  const before = applyRecurring(imported, new Date('2026-11-06T15:59:59Z'));
  assert.equal(before.added.length, 0);
  assert.equal(before.state.subscriptions[0].expiresOn, '2026-11-07');
  assert.deepEqual(before.state.subscriptions[0].expiryRenewal, {
    baseDate: '2026-11-07', baselineOccurrences: [], renewedOccurrences: [],
  });
  const due = applyRecurring(before.state, new Date('2026-11-06T16:00:00Z'));
  assert.equal(due.added.length, 0);
  assert.equal(due.state.subscriptions[0].expiresOn, '2026-12-07');
  assert.deepEqual(due.state.subscriptions[0].expiryRenewal.renewedOccurrences, ['music:2026-11']);
  assert.deepEqual(applyRecurring(due.state, new Date('2026-11-06T16:30:00Z')).state, due.state);
  assert.equal(Object.hasOwn(imported.subscriptions[0], 'expiryRenewal'), false);
});

test('manual expiry edits reset the day anchor and retain paid or deleted periods as covered', () => {
  const state = fixture();
  state.subscriptions[0].expiresOn = '2024-01-31';
  const first = applyRecurring(state, '2024-01-31').state;
  const sub = first.subscriptions[0];
  sub.expiresOn = '2024-03-15';
  assert.equal(resetSubscriptionExpiry(sub, first.transactions), sub);
  assert.deepEqual(sub.expiryRenewal, {
    baseDate: '2024-03-15', baselineOccurrences: ['music:2024-01'], renewedOccurrences: [],
  });
  first.transactions = [];
  const second = applyRecurring(first, '2024-02-29').state;
  assert.equal(second.subscriptions[0].expiresOn, '2024-04-15');
  assert.deepEqual(second.subscriptions[0].expiryRenewal.baselineOccurrences, ['music:2024-01']);
  assert.deepEqual(second.subscriptions[0].expiryRenewal.renewedOccurrences, ['music:2024-02']);
  resetSubscriptionExpiry(second.subscriptions[0], second.transactions);
  assert.deepEqual(second.subscriptions[0].expiryRenewal.baselineOccurrences, ['music:2024-01', 'music:2024-02']);

  second.subscriptions[0].expiresOn = '';
  resetSubscriptionExpiry(second.subscriptions[0], second.transactions);
  assert.equal(Object.hasOwn(second.subscriptions[0], 'expiryRenewal'), false);
  sub.recurring = false;
  resetSubscriptionExpiry(sub, []);
  assert.equal(Object.hasOwn(sub, 'expiryRenewal'), false);
});

test('expiry renewal metadata validates its baseline, period sets and effective calendar date', () => {
  const state = fixture();
  state.subscriptions[0].expiresOn = '2024-01-31';
  const paid = applyRecurring(state, '2024-01-31').state;
  assert.equal(validateState(paid), true);
  for (const mutate of [
    sub => { sub.recurring = false; },
    sub => { sub.expiryRenewal = null; },
    sub => { sub.expiryRenewal.baseDate = '2024-02-30'; },
    sub => { sub.expiryRenewal.baselineOccurrences = null; },
    sub => { sub.expiryRenewal.renewedOccurrences = ['wrong:2024-01']; },
    sub => { sub.expiryRenewal.renewedOccurrences = ['music:2024-13']; },
    sub => { sub.expiryRenewal.renewedOccurrences = ['music:2024-01', 'music:2024-01']; },
    sub => { sub.expiryRenewal.baselineOccurrences = ['music:2023-12', 'music:2023-12']; },
    sub => { sub.expiryRenewal.baselineOccurrences = ['music:2024-01']; },
    sub => { sub.expiresOn = '2024-02-28'; },
    sub => { sub.expiresOn = ''; },
  ]) {
    const invalid = structuredClone(paid);
    mutate(invalid.subscriptions[0]);
    assert.throws(() => validateState(invalid));
  }
});

test('expiry overflow fails atomically before an automatic payment can be persisted', () => {
  const state = fixture('2199-12-31', 31);
  state.subscriptions[0].expiresOn = '2199-12-31';
  const original = structuredClone(state);
  assert.throws(() => applyRecurring(state, '2199-12-31'), /超过支持范围/);
  assert.deepEqual(state, original);
  assert.equal(state.transactions.length, 0);
});

test('insufficient funds leave a charge and expiry pending until a current-day top-up covers it exactly', () => {
  const state = fixture('2026-11-07', 7);
  state.accounts[0].openingBalance = 1799;
  Object.assign(state.subscriptions[0], { startHour: 10, billingHour: 10, expiresOn: '2026-11-07' });
  upgradeSchemaVersion(state);
  const original = structuredClone(state);
  const waiting = applyRecurring(state, new Date('2026-11-07T02:00:00Z'));
  assert.deepEqual(waiting.added, []);
  assert.deepEqual(waiting.state.subscriptions[0].processedOccurrences, []);
  assert.deepEqual(waiting.state.subscriptions[0].expiryRenewal.renewedOccurrences, []);
  assert.equal(waiting.state.subscriptions[0].expiresOn, '2026-11-07');
  assert.equal(getBalances(waiting.state, '2026-11-07').bank, 1799);
  assert.deepEqual(applyRecurring(waiting.state, new Date('2026-11-08T02:00:00Z')).state, waiting.state);
  assert.deepEqual(state, original);

  waiting.state.transactions.push({ id: 'topup', type: 'income', accountId: 'bank', amount: 1,
    title: '补足余额', category: '其他收入', date: '2026-11-08', note: '' });
  const paid = applyRecurring(waiting.state, new Date('2026-11-08T02:00:00Z'));
  assert.equal(paid.added.length, 1);
  assert.equal(paid.added[0].date, '2026-11-07');
  assert.equal(getBalances(paid.state, '2026-11-08').bank, 0);
  assert.equal(paid.state.subscriptions[0].expiresOn, '2026-12-07');
  assert.deepEqual(paid.state.subscriptions[0].processedOccurrences, ['music:2026-11']);
  assert.deepEqual(applyRecurring(paid.state, new Date('2026-11-08T03:00:00Z')).state, paid.state);
});

test('zero and negative balances cannot fund a subscription but sufficient later income can', () => {
  for (const openingBalance of [0, -500]) {
    const state = fixture('2026-11-07', 7);
    state.accounts[0].openingBalance = openingBalance;
    const waiting = applyRecurring(state, '2026-11-07');
    assert.equal(waiting.added.length, 0);
    assert.deepEqual(waiting.state.subscriptions[0].processedOccurrences, []);
    waiting.state.transactions.push({ id: 'income', type: 'income', accountId: 'bank', amount: 1800 - openingBalance,
      title: '补足余额', category: '其他收入', date: '2026-11-08', note: '' });
    const paid = applyRecurring(waiting.state, '2026-11-08');
    assert.equal(paid.added.length, 1);
    assert.equal(getBalances(paid.state, '2026-11-08').bank, 0);
  }
});

test('future income and transfers become available only on their Beijing ledger date', () => {
  for (const type of ['income', 'transfer']) {
    const state = fixture('2026-11-07', 7);
    state.accounts[0].openingBalance = 1799;
    state.accounts.push({ id: 'wallet', name: '钱包', type: '现金', openingBalance: 100, color: '#123456' });
    state.transactions.push({ id: 'future-funds', type, accountId: type === 'transfer' ? 'wallet' : 'bank', amount: 1,
      ...(type === 'transfer' ? { toAccountId: 'bank' } : {}), title: '未来资金', category: '其他', date: '2026-11-08', note: '' });
    assert.equal(getBalances(state).bank, 1800);
    const waiting = applyRecurring(state, new Date('2026-11-07T15:59:59Z'));
    assert.equal(waiting.added.length, 0);
    assert.equal(getBalances(waiting.state, '2026-11-07').bank, 1799);
    const paid = applyRecurring(waiting.state, new Date('2026-11-07T16:00:00Z'));
    assert.equal(paid.added.length, 1);
    assert.equal(getBalances(paid.state, '2026-11-08').bank, 0);
  }
  const state = fixture('2026-11-07', 7);
  state.accounts[0].openingBalance = 1800;
  state.transactions.push({ id: 'future-expense', type: 'expense', accountId: 'bank', amount: 1,
    title: '未来支出', category: '其他', date: '2026-11-08', note: '' });
  const paid = applyRecurring(state, '2026-11-07');
  assert.equal(paid.added.length, 1);
  assert.equal(getBalances(paid.state, '2026-11-07').bank, 0);
});

test('catch-up charges consume funds from oldest month first and renew only paid periods', () => {
  const state = fixture();
  state.accounts[0].openingBalance = 3600;
  state.subscriptions[0].expiresOn = '2024-01-31';
  const partial = applyRecurring(state, '2024-03-31');
  assert.deepEqual(partial.added.map(tx => tx.date), ['2024-01-31', '2024-02-29']);
  assert.deepEqual(partial.state.subscriptions[0].processedOccurrences, ['music:2024-01', 'music:2024-02']);
  assert.deepEqual(partial.state.subscriptions[0].expiryRenewal.renewedOccurrences, ['music:2024-01', 'music:2024-02']);
  assert.equal(partial.state.subscriptions[0].expiresOn, '2024-03-31');
  assert.equal(getBalances(partial.state, '2024-03-31').bank, 0);
  assert.equal(nextSubscriptionDue(partial.state.subscriptions[0], '2024-04-01'), '2024-03-31');
  assert.deepEqual(applyRecurring(partial.state, '2024-04-01').state, partial.state);
  partial.state.transactions.push({ id: 'april-topup', type: 'income', accountId: 'bank', amount: 1800,
    title: '补款', category: '其他收入', date: '2024-04-01', note: '' });
  const paid = applyRecurring(partial.state, '2024-04-01');
  assert.deepEqual(paid.added.map(tx => tx.date), ['2024-03-31']);
  assert.equal(paid.state.subscriptions[0].expiresOn, '2024-04-30');
  assert.equal(getBalances(paid.state, '2024-04-01').bank, 0);
});

test('subscriptions sharing an account use stable list order and debit available funds per payment', () => {
  const state = fixture('2026-11-07', 7);
  state.accounts[0].openingBalance = 2000;
  state.subscriptions[0].expiresOn = '2026-11-07';
  state.subscriptions.push({ ...structuredClone(state.subscriptions[0]), id: 'second' },
    { ...structuredClone(state.subscriptions[0]), id: 'small', amount: 200 });
  const partial = applyRecurring(state, '2026-11-07');
  assert.deepEqual(partial.added.map(tx => tx.subscriptionId), ['music', 'small']);
  assert.equal(getBalances(partial.state, '2026-11-07').bank, 0);
  assert.deepEqual(partial.state.subscriptions[1].processedOccurrences, []);
  assert.equal(partial.state.subscriptions[1].expiresOn, '2026-11-07');
  assert.equal(partial.state.subscriptions[0].expiresOn, '2026-12-07');
  assert.equal(partial.state.subscriptions[2].expiresOn, '2026-12-07');
  partial.state.transactions.push({ id: 'topup-second', type: 'income', accountId: 'bank', amount: 1800,
    title: '补款', category: '其他收入', date: '2026-11-08', note: '' });
  const paid = applyRecurring(partial.state, '2026-11-08');
  assert.deepEqual(paid.added.map(tx => tx.subscriptionId), ['second']);
  assert.equal(paid.state.subscriptions[1].expiresOn, '2026-12-07');
  assert.equal(getBalances(paid.state, '2026-11-08').bank, 0);
});

test('an existing paid occurrence repairs its marker without requiring or deducting its funds again', () => {
  const state = fixture('2026-11-07', 7);
  state.accounts[0].openingBalance = 1800;
  state.subscriptions[0].expiresOn = '2026-11-07';
  const paid = applyRecurring(state, '2026-11-07').state;
  paid.subscriptions[0].processedOccurrences = [];
  const repaired = applyRecurring(paid, '2026-11-08');
  assert.equal(repaired.added.length, 0);
  assert.equal(repaired.state.transactions.length, 1);
  assert.equal(getBalances(repaired.state, '2026-11-08').bank, 0);
  assert.deepEqual(repaired.state.subscriptions[0].processedOccurrences, ['music:2026-11']);
  assert.deepEqual(repaired.state.subscriptions[0].expiryRenewal, paid.subscriptions[0].expiryRenewal);
});

test('funding checks use exact account currency units without borrowing another account or converted value', () => {
  for (const [currency, fee, rate] of [['USD', 1800, '7.2'], ['JPY', 1800, '0.05'], ['USDT', 2, '7.2'], ['TRY', 1800, '0.2']]) {
    const state = fixture('2026-11-07', 7);
    Object.assign(state.accounts[0], { currency, cnyRate: rate, openingBalance: fee - 1 });
    state.accounts.push({ id: 'rich', name: '其他账户', type: '现金', color: '#123456', openingBalance: 100000 });
    Object.assign(state.subscriptions[0], { currency, amount: fee });
    upgradeSchemaVersion(state);
    const waiting = applyRecurring(state, '2026-11-07');
    assert.equal(waiting.added.length, 0, currency);
    waiting.state.transactions.push({ id: 'native-topup', type: 'income', accountId: 'bank', amount: 1, currency, cnyRate: rate,
      title: '原币补款', category: '其他收入', date: '2026-11-08', note: '' });
    const paid = applyRecurring(waiting.state, '2026-11-08');
    assert.equal(paid.added.length, 1, currency);
    assert.equal(paid.added[0].amount, fee);
    assert.equal(paid.added[0].currency, currency);
    assert.equal(paid.added[0].cnyRate, rate);
    assert.equal(getBalances(paid.state, '2026-11-08').bank, 0);
    assert.equal(getBalances(paid.state, '2026-11-08').rich, 100000);
  }
});

test('a single charge also waits for enough funds and records only once after a later deposit', () => {
  const state = fixture('2026-11-07', 7);
  state.accounts[0].openingBalance = 0;
  Object.assign(state.subscriptions[0], { recurring: false, expiresOn: '2026-11-07' });
  const waiting = applyRecurring(state, '2026-11-07');
  assert.equal(waiting.added.length, 0);
  assert.deepEqual(waiting.state.subscriptions[0].processedOccurrences, []);
  waiting.state.transactions.push({ id: 'single-topup', type: 'income', accountId: 'bank', amount: 1800,
    title: '补款', category: '其他收入', date: '2026-11-08', note: '' });
  const paid = applyRecurring(waiting.state, '2026-11-08');
  assert.equal(paid.added.length, 1);
  assert.equal(paid.state.subscriptions[0].expiresOn, '2026-11-07');
  assert.equal(Object.hasOwn(paid.state.subscriptions[0], 'expiryRenewal'), false);
  assert.deepEqual(applyRecurring(paid.state, '2026-12-08').state, paid.state);
});

test('an unpaid overdue subscription keeps its original pending date and never claims renewal succeeded', () => {
  const state = fixture('2026-11-07', 7);
  state.accounts[0].openingBalance = 0;
  const waiting = applyRecurring(state, new Date('2026-11-08T02:00:00Z')).state;
  assert.equal(nextSubscriptionDue(waiting.subscriptions[0], new Date('2026-11-08T02:00:00Z')), '2026-11-07');
  assert.deepEqual(subscriptionExpiryStatus(waiting.subscriptions[0], new Date('2026-11-08T02:00:00Z')), {
    tone: 'expired', label: '待扣账 · 已逾期 1 天', detail: '2026-11-07 · 待扣账',
    date: '2026-11-07', days: -1, source: 'renewal',
  });
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
