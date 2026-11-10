import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeEmptyState, applyRecurring, resetSubscriptionExpiry, validateState, prepareSubscriptionEdit } from '../engine.mjs';
import { mergeMobileOperations, newSyncMetadata } from '../mobile-sync.mjs';

function ledger(version = 4) {
  return { ...makeEmptyState(), schemaVersion: version, _mobileSync: newSyncMetadata(), accounts: [
    { id: 'cash', name: '现金', type: '现金', color: '#123456', openingBalance: 100000 },
  ] };
}
function request(state, operations = [], supportedSchemaVersion = 4) {
  return { protocolVersion: 2, deviceId: 'schema4-phone', requestId: randomUUID(),
    bookId: state._mobileSync.bookId, supportedSchemaVersion, operations };
}
function put(entity, record, base = null) {
  return { id: randomUUID(), entity, kind: 'put', recordId: entity === 'settings' ? 'settings' : record.id, record, base };
}
function transaction(record) { return { id: randomUUID(), entity: 'transaction', kind: 'put', transaction: record, base: null }; }
function subscription(extra = {}) {
  return { id: 'annual', name: '年费', amount: 1200, category: '会员订阅', accountId: 'cash',
    startDate: '2024-01-31', billingDay: 31, intervalMonths: 12, recurring: true, active: true,
    color: '#123456', icon: 'star', processedOccurrences: [], ...extra };
}

test('schema negotiation compares the full required version and preserves legacy v1/v2 behavior', () => {
  for (const version of [3, 4]) {
    const state = ledger(version), before = structuredClone(state);
    for (const supported of [undefined, null, '4', 1, 2, version - 1]) {
      assert.throws(() => mergeMobileOperations(state, { ...request(state), supportedSchemaVersion: supported }),
        error => error.status === 409 && error.message.includes(`版本 ${version}`) && /升级手机/.test(error.message));
      assert.deepEqual(state, before);
    }
    for (const supported of [version, version + 1]) assert.doesNotThrow(() => mergeMobileOperations(state, request(state, [], supported)));
  }
  for (const version of [1, 2]) assert.doesNotThrow(() => {
    const state = ledger(version);
    mergeMobileOperations(state, { ...request(state), supportedSchemaVersion: undefined });
  });
});

test('settings v4 and opaque fields round-trip as one entity; stale legacy settings cannot erase new choices', () => {
  const state = ledger(2), baseline = structuredClone(state.settings);
  const settings = { ...baseline, categoryBudgets: { 宠物: 12345 }, customCategories: { expense: ['宠物'], income: ['稿费'] },
    futurePreference: { locale: 'zh-CN', nested: [1, '原样保留'] } };
  let result = mergeMobileOperations(state, request(state, [put('settings', settings, baseline)]));
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.next.schemaVersion, 4);
  assert.deepEqual(result.next.settings, settings);
  assert.equal(validateState(result.next), true);
  const changed = { ...settings, monthlyBudget: 800000 };
  result = mergeMobileOperations(result.next, request(result.next, [put('settings', changed, settings)]));
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.next.settings, changed);
  const stale = mergeMobileOperations(result.next, request(result.next, [put('settings', { ...baseline, monthlyBudget: 1 }, baseline)]));
  assert.equal(stale.conflicts.length, 1);
  assert.deepEqual(stale.next.settings, changed);
  const newer = structuredClone(changed);
  delete newer.futurePreference;
  newer.monthlyBudget = 900000;
  const preserved = mergeMobileOperations(result.next, request(result.next, [put('settings', newer, changed)]));
  assert.equal(preserved.conflicts.length, 0);
  assert.deepEqual(preserved.next.settings.futurePreference, settings.futurePreference);
  assert.deepEqual(preserved.next.settings.customCategories, settings.customCategories);
  const removed = { monthlyBudget: 900000, currency: 'CNY', futurePreference: settings.futurePreference };
  const cleared = mergeMobileOperations(preserved.next, request(preserved.next, [put('settings', removed, preserved.next.settings)]));
  assert.equal(cleared.conflicts.length, 0);
  assert.deepEqual(cleared.next.settings, removed, 'Known optional fields can still be intentionally removed');
});

test('both devices yearly catch-up merge each charge and membership extension only once', () => {
  const original = ledger();
  const sub = subscription({ expiresOn: '2024-02-29' });
  resetSubscriptionExpiry(sub, []);
  original.subscriptions.push(sub);
  const desktop = applyRecurring(original, '2024-01-31').state;
  const phone = applyRecurring(original, '2025-01-31').state;
  assert.equal(desktop.subscriptions[0].expiresOn, '2025-02-28');
  assert.equal(phone.subscriptions[0].expiresOn, '2026-02-28');
  const operations = [put('subscription', { ...phone.subscriptions[0], name: '年费同步' }, original.subscriptions[0]),
    ...phone.transactions.map(transaction)];
  const result = mergeMobileOperations(desktop, request(desktop, operations), new Date('2025-01-31T16:00:00Z'));
  assert.equal(result.conflicts.length, 0, JSON.stringify(result.conflicts));
  assert.equal(result.next.transactions.length, 2);
  assert.equal(result.next.subscriptions[0].expiresOn, '2026-02-28');
  assert.deepEqual(result.next.subscriptions[0].processedOccurrences, ['annual:2024-01', 'annual:2025-01']);
  const retry = mergeMobileOperations(result.next, request(result.next, operations), new Date('2025-01-31T16:00:00Z'));
  assert.equal(retry.summary.duplicates, 3);
  assert.equal(retry.next.subscriptions[0].expiresOn, '2026-02-28');
});

test('a rejected yearly charge leaves membership expiry and processed periods pending for a funded retry', () => {
  const desktop = ledger();
  const sub = subscription({ expiresOn: '2024-02-29' });
  resetSubscriptionExpiry(sub, []);
  desktop.subscriptions.push(sub);
  const phone = applyRecurring(desktop, '2024-01-31').state;
  desktop.accounts[0].openingBalance = 0;
  const operations = [put('subscription', phone.subscriptions[0], desktop.subscriptions[0]), transaction(phone.transactions[0])];
  const now = new Date('2024-01-31T02:00:00Z');
  const blocked = mergeMobileOperations(desktop, request(desktop, operations), now);
  assert.equal(blocked.conflicts.length, 1);
  assert.match(blocked.conflicts[0].reason, /余额不足/);
  assert.deepEqual(blocked.next.subscriptions[0].processedOccurrences, []);
  assert.equal(blocked.next.subscriptions[0].expiresOn, '2024-02-29');
  blocked.next.accounts[0].openingBalance = 1200;
  const funded = mergeMobileOperations(blocked.next, request(blocked.next, operations), now);
  assert.equal(funded.conflicts.length, 0);
  assert.equal(funded.next.subscriptions[0].expiresOn, '2025-02-28');
  assert.equal(funded.next.transactions.length, 1);
});

test('off-grid historical receipts survive schedule edits while newly uploaded stale monthly charges conflict', () => {
  const state = ledger();
  state.subscriptions.push(subscription({ processedOccurrences: ['annual:2024-01', 'annual:2024-02'] }));
  const record = { ...state.subscriptions[0], name: '年费改名', processedOccurrences: ['annual:2024-01', 'annual:2024-03'] };
  const renamed = mergeMobileOperations(state, request(state, [put('subscription', record, state.subscriptions[0])]), new Date('2024-06-01T02:00:00Z'));
  assert.equal(renamed.conflicts.length, 0);
  assert.deepEqual(renamed.next.subscriptions[0].processedOccurrences, ['annual:2024-01', 'annual:2024-02', 'annual:2024-03']);
  const stale = { id: 'rec_annual_202404', type: 'expense', accountId: 'cash', amount: 1200, category: '会员订阅',
    title: '年费', note: '', date: '2024-04-30', subscriptionId: 'annual', occurrenceKey: 'annual:2024-04' };
  const rejected = mergeMobileOperations(renamed.next, request(renamed.next, [transaction(stale)]), new Date('2024-06-01T02:00:00Z'));
  assert.equal(rejected.conflicts.length, 1);
  assert.match(rejected.conflicts[0].reason, /扣账周期/);
  assert.equal(rejected.next.transactions.length, 0);
});

test('changing annual to monthly resets the earned-expiry baseline and retains skipped history through sync', () => {
  const original = ledger();
  const sub = subscription({ expiresOn: '2024-02-29' });
  resetSubscriptionExpiry(sub, []);
  original.subscriptions.push(sub);
  const paid = applyRecurring(original, '2024-01-31').state;
  const edited = structuredClone(paid.subscriptions[0]);
  delete edited.intervalMonths;
  const now = new Date('2024-06-15T02:00:00Z');
  prepareSubscriptionEdit(paid.subscriptions[0], edited, paid.transactions, now);
  const result = mergeMobileOperations(paid, request(paid, [put('subscription', edited, paid.subscriptions[0])]), now);
  assert.equal(result.conflicts.length, 0, JSON.stringify(result.conflicts));
  assert.equal(result.next.subscriptions[0].expiresOn, '2025-02-28');
  assert.deepEqual(result.next.subscriptions[0].processedOccurrences,
    ['annual:2024-01', 'annual:2024-02', 'annual:2024-03', 'annual:2024-04', 'annual:2024-05']);
  assert.equal(applyRecurring(result.next, '2024-06-15').added.length, 0);
  const next = applyRecurring(result.next, '2024-06-30');
  assert.equal(next.added.length, 1);
  assert.equal(next.state.subscriptions[0].expiresOn, '2025-03-28');
});

test('offline monthly payments still import after an accepted annual edit, including first pairing', () => {
  for (const firstPairing of [false, true]) {
    const desktop = ledger();
    const monthly = subscription();
    delete monthly.intervalMonths;
    const phone = structuredClone(desktop);
    phone.subscriptions.push(monthly);
    if (!firstPairing) desktop.subscriptions.push(structuredClone(monthly));
    const paid = applyRecurring(phone, '2024-03-31').state;
    const edited = structuredClone(paid.subscriptions[0]);
    edited.intervalMonths = 12;
    const now = new Date('2024-04-15T02:00:00Z');
    prepareSubscriptionEdit(paid.subscriptions[0], edited, paid.transactions, now);
    const operations = [put('subscription', edited, firstPairing ? null : monthly), ...paid.transactions.map(transaction)];
    const result = mergeMobileOperations(desktop, request(desktop, operations), now);
    assert.equal(result.conflicts.length, 0, JSON.stringify(result.conflicts));
    assert.equal(result.next.transactions.length, 3);
    assert.deepEqual(result.next.subscriptions[0].processedOccurrences, ['annual:2024-01', 'annual:2024-02', 'annual:2024-03']);
    assert.equal(applyRecurring(result.next, '2024-04-15').added.length, 0);
    assert.equal(mergeMobileOperations(result.next, request(result.next, operations), now).summary.duplicates, 4);
  }
});

test('a historical off-grid payment can retry after its plan was acknowledged but its charge lacked funds', () => {
  const desktop = ledger();
  const monthly = subscription();
  delete monthly.intervalMonths;
  const phone = structuredClone(desktop);
  phone.subscriptions.push(monthly);
  const paid = applyRecurring(phone, '2024-02-29').state;
  const edited = { ...paid.subscriptions[0], intervalMonths: 12 };
  const now = new Date('2024-04-15T02:00:00Z');
  prepareSubscriptionEdit(paid.subscriptions[0], edited, paid.transactions, now);
  desktop.accounts[0].openingBalance = 1200;
  const operations = [put('subscription', edited), ...paid.transactions.map(transaction)];
  const blocked = mergeMobileOperations(desktop, request(desktop, operations), now);
  assert.equal(blocked.conflicts.length, 1);
  assert.match(blocked.conflicts[0].reason, /余额不足/);
  assert.equal(blocked.next.transactions.length, 1);
  assert.ok(blocked.next.subscriptions[0].processedOccurrences.includes('annual:2024-02'), 'The old-grid receipt survives the plan acknowledgement');
  blocked.next.accounts[0].openingBalance = 2400;
  const retry = mergeMobileOperations(blocked.next, request(blocked.next, [operations[2]]), now);
  assert.equal(retry.conflicts.length, 0);
  assert.equal(retry.next.transactions.length, 2);
});
