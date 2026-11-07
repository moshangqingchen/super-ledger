import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeEmptyState, applyRecurring, setSubscriptionActive, validateState, getBalances, getNetWorth } from '../engine.mjs';
import { newSyncMetadata, mergeMobileOperations } from '../mobile-sync.mjs';

function state() {
  return { ...makeEmptyState(), _mobileSync: newSyncMetadata(), accounts: [
    { id: 'cash', name: '现金', type: '现金', color: '#445566', openingBalance: 50000 },
  ] };
}
function payload(book, operations, more = {}) {
  return { protocolVersion: 2, supportedSchemaVersion: 3, deviceId: 'phone-full', requestId: randomUUID(), bookId: book._mobileSync.bookId, operations, ...more };
}
function put(entity, record, base = null) { return { id: randomUUID(), entity, kind: 'put', recordId: entity === 'settings' ? 'settings' : record.id, record, base }; }
function remove(entity, record) { return { id: randomUUID(), entity, kind: 'delete', recordId: record.id, base: record }; }
function tx(record, base = null) { return { id: randomUUID(), entity: 'transaction', kind: 'put', transaction: record, base }; }
function payment(more = {}) {
  return { id: randomUUID(), type: 'expense', accountId: 'cash', amount: 1200, title: '买菜', category: '购物消费', note: '', date: '2026-11-05', ...more };
}
function subscription(more = {}) {
  return { id: 'member', name: '会员', amount: 1000, accountId: 'cash', category: '会员订阅', startDate: '2026-11-05', billingDay: 5,
    recurring: true, active: true, color: '#445566', icon: 'star', processedOccurrences: [], ...more };
}

test('hourly subscription sync promotes and retains schema 3 across entity and transaction edits', () => {
  const desktop = state();
  const sub = subscription({ startHour: 10, billingHour: 20 });
  let result = mergeMobileOperations(desktop, payload(desktop, [put('subscription', sub)]));
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.next.schemaVersion, 3);
  assert.deepEqual(result.next.subscriptions[0], sub);
  assert.equal(applyRecurring(result.next, new Date('2026-11-05T01:59:59Z')).added.length, 0);

  const account = result.next.accounts[0];
  result = mergeMobileOperations(result.next, payload(result.next, [put('account', { ...account, name: '手机现金' }, account), tx(payment())]));
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.next.schemaVersion, 3, 'Unrelated sync operations must not downgrade the hourly ledger');
  assert.equal(validateState(result.next), true);

  const changed = { ...sub, startHour: 11 };
  result = mergeMobileOperations(result.next, payload(result.next, [put('subscription', changed, sub)]));
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.next.subscriptions[0].startHour, 11);
  const conflict = mergeMobileOperations(result.next, payload(result.next, [put('subscription', { ...sub, startHour: 12 }, sub)]));
  assert.equal(conflict.conflicts.length, 1, 'Concurrent hour edits must participate in conflict detection');
  assert.equal(conflict.next.subscriptions[0].startHour, 11);
  const invalid = mergeMobileOperations(result.next, payload(result.next, [
    put('account', { ...result.next.accounts[0], currency: 'INVALID' }, result.next.accounts[0]),
    put('subscription', { ...changed, billingHour: 24 }, changed),
    put('goal', { id: 'valid-goal', name: '旅行', target: 10000, saved: 0, color: '#123456' }),
  ]));
  assert.equal(invalid.conflicts.length, 2, 'Invalid currency and hour remain individual conflicts');
  assert.equal(invalid.accepted.length, 1, 'A valid independent operation must still succeed');
  assert.equal(invalid.next.schemaVersion, 3);
});

test('older phones cannot upload prematurely generated charges into an hourly ledger', () => {
  const desktop = state();
  desktop.schemaVersion = 3;
  const sub = subscription({ startHour: 18, billingHour: 18 });
  desktop.subscriptions.push(sub);
  const oldSub = structuredClone(sub);
  delete oldSub.startHour;
  delete oldSub.billingHour;
  const oldPhone = state();
  oldPhone.subscriptions.push(oldSub);
  const early = applyRecurring(oldPhone, '2026-11-05').state;
  const operations = [put('subscription', early.subscriptions[0], oldSub), tx(early.transactions[0])];
  const before = structuredClone(desktop);
  for (const batch of [operations, []]) {
    const legacyPayload = payload(desktop, batch);
    delete legacyPayload.supportedSchemaVersion;
    assert.throws(() => mergeMobileOperations(desktop, legacyPayload), error => error.status === 409 && /升级手机/.test(error.message));
    assert.deepEqual(desktop, before, 'Reject the entire old-client batch before applying edits or receipts');
  }
  const legacyBook = state();
  assert.doesNotThrow(() => mergeMobileOperations(legacyBook, payload(legacyBook, [], { supportedSchemaVersion: undefined })));
});

test('a stale phone schedule cannot charge before the desktop scheduled hour', () => {
  const phone = state();
  phone.schemaVersion = 3;
  const original = subscription({ startHour: 10, billingHour: 10 });
  phone.subscriptions.push(original);
  const charged = applyRecurring(phone, new Date('2026-11-05T02:00:00Z')).state;
  const desktop = structuredClone(phone);
  desktop.subscriptions[0].startHour = 18;
  const operations = [put('subscription', charged.subscriptions[0], original), tx(charged.transactions[0])];
  const result = mergeMobileOperations(desktop, payload(desktop, operations), new Date('2026-11-05T02:00:00Z'));
  assert.equal(result.accepted.length, 0);
  assert.equal(result.conflicts.length, 2);
  assert.match(result.conflicts[1].reason, /尚未到扣账时间/);
  assert.equal(result.conflicts[1].canKeepPhone, false);
  assert.equal(result.next.transactions.length, 0);
  assert.deepEqual(result.next.subscriptions[0].processedOccurrences, []);
  const due = applyRecurring(result.next, new Date('2026-11-05T10:00:00Z'));
  assert.equal(due.added.length, 1, 'The accepted desktop schedule remains eligible at its actual due hour');
});

test('a phone one second ahead cannot suppress the desktop charge with an early processed marker', () => {
  const desktop = state();
  desktop.schemaVersion = 3;
  const sub = subscription({ startHour: 18, billingHour: 18 });
  desktop.subscriptions.push(sub);
  const phone = applyRecurring(desktop, new Date('2026-11-05T10:00:00Z')).state;
  const operations = [put('subscription', phone.subscriptions[0], sub), tx(phone.transactions[0])];
  const request = payload(desktop, operations);
  const result = mergeMobileOperations(desktop, request, new Date('2026-11-05T09:59:59Z'));
  assert.deepEqual(result.accepted, []);
  assert.equal(result.conflicts.length, 2);
  assert.match(result.conflicts[0].reason, /尚未到北京时间扣账时间/);
  assert.equal(result.next.transactions.length, 0);
  assert.deepEqual(result.next.subscriptions[0].processedOccurrences, []);
  assert.deepEqual(result.next._mobileSync.receipts, desktop._mobileSync.receipts);
  assert.equal(applyRecurring(result.next, new Date('2026-11-05T10:00:00Z')).added.length, 1);

  const retry = mergeMobileOperations(result.next, request, new Date('2026-11-05T10:00:00Z'));
  assert.equal(retry.conflicts.length, 0);
  assert.equal(retry.accepted.length, 2);
  assert.equal(retry.next.transactions.length, 1);
  assert.deepEqual(retry.next.subscriptions[0].processedOccurrences, ['member:2026-11']);
  assert.equal(applyRecurring(retry.next, new Date('2026-11-05T10:00:00Z')).added.length, 0);
});

test('hourly sync retains already processed or recorded periods when a schedule moves later', () => {
  for (const preserveMarker of [true, false]) {
    const desktop = state();
    desktop.schemaVersion = 3;
    const sub = subscription({ startHour: 18, billingHour: 18 });
    if (preserveMarker) sub.processedOccurrences = ['member:2026-11'];
    desktop.subscriptions.push(sub);
    if (!preserveMarker) {
      const booked = applyRecurring(desktop, new Date('2026-11-05T10:00:00Z')).state;
      desktop.transactions = booked.transactions;
    }
    const changed = { ...sub, name: '调整后的会员', processedOccurrences: ['member:2026-11'] };
    const result = mergeMobileOperations(desktop, payload(desktop, [put('subscription', changed, sub)]), new Date('2026-11-05T09:59:59Z'));
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.accepted.length, 1);
    assert.deepEqual(result.next.subscriptions[0].processedOccurrences, ['member:2026-11']);
  }
});

test('first full-ledger pairing merges offline accounts, foreign payments, transfers, budget and goals without replacing desktop data', () => {
  const desktop = state();
  const usd = { id: 'usd', name: '美元账户', type: '银行卡', color: '#445566', openingBalance: 10000, currency: 'USD', cnyRate: '7', rateMode: 'manual' };
  const expense = payment({ accountId: 'usd', currency: 'USD', cnyRate: '7', amount: 200 });
  const transfer = payment({ type: 'transfer', amount: 7000, currency: 'CNY', toAccountId: 'usd', toCurrency: 'USD', toAmount: 1000 });
  const goal = { id: 'goal', name: '旅行', target: 100000, saved: 12000, color: '#445566' };
  const operations = [put('account', usd), tx(expense), tx(transfer), put('settings', { monthlyBudget: 300000, currency: 'CNY' }, desktop.settings), put('goal', goal)];
  const result = mergeMobileOperations(desktop, payload(desktop, operations, { bookId: null }));
  assert.equal(result.accepted.length, 5); assert.equal(result.conflicts.length, 0);
  assert.deepEqual({ ...getBalances(result.next) }, { cash: 43000, usd: 10800 });
  assert.equal(getNetWorth(result.next), 118600);
  assert.equal(result.next.settings.monthlyBudget, 300000); assert.equal(result.next.goals[0].saved, 12000);
  assert.equal(desktop.accounts.length, 1); assert.equal(desktop.transactions.length, 0);
  const retry = mergeMobileOperations(result.next, payload(result.next, operations));
  assert.equal(retry.summary.duplicates, 5); assert.equal(retry.next.transactions.length, 2);
});

test('entity conflicts preserve concurrent desktop edits and reject referenced account deletion', () => {
  const desktop = state(), baseline = structuredClone(desktop.accounts[0]);
  desktop.accounts[0].name = '电脑修改'; desktop.transactions.push(payment());
  const result = mergeMobileOperations(desktop, payload(desktop, [
    put('account', { ...baseline, name: '手机修改' }, baseline),
    remove('account', desktop.accounts[0]),
    put('goal', { id: 'g', name: '储蓄', target: 50000, saved: 0, color: '#445566' }),
  ]));
  assert.equal(result.conflicts.length, 2); assert.equal(result.conflicts[0].entity, 'account');
  assert.equal(result.conflicts[0].current.name, '电脑修改');
  assert.match(result.conflicts[1].reason, /账单或订阅/); assert.equal(result.next.accounts[0].name, '电脑修改');
  assert.equal(result.next.transactions.length, 1); assert.equal(result.next.goals.length, 1);
});

test('subscription processed markers merge independently from editable fields', () => {
  const desktop = state(), base = subscription(); desktop.subscriptions.push({ ...base, processedOccurrences: ['member:2026-11'] });
  const mobile = { ...base, name: '新名称', processedOccurrences: ['member:2026-12'] };
  const result = mergeMobileOperations(desktop, payload(desktop, [put('subscription', mobile, base)]));
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.next.subscriptions[0].processedOccurrences, ['member:2026-11', 'member:2026-12']);
  const conflict = mergeMobileOperations(result.next, payload(result.next, [put('subscription', { ...base, amount: 2000 }, base)]));
  assert.equal(conflict.conflicts.length, 1); assert.equal(conflict.next.subscriptions[0].amount, 1000);
});

test('linked subscription accounts, expiry and notes survive sync, phone edits, paused periods and automatic charges', () => {
  const desktop = state(), details = {
    linkedAccounts: [{ type: 'email', value: 'member@example.com' }, { type: 'apple', value: 'store@example.com', label: '美区商店' }],
    expiresOn: '2027-02-05', note: '家庭共享 · 到期前检查续费',
  };
  const sub = subscription(details);
  const wire = value => JSON.parse(JSON.stringify(value));
  const checkDetails = book => {
    for (const field of Object.keys(details)) assert.deepEqual(book.subscriptions[0][field], details[field], field);
    assert.equal(validateState(book), true);
  };
  let result = mergeMobileOperations(desktop, wire(payload(desktop, [put('subscription', sub)])));
  assert.equal(result.conflicts.length, 0); assert.equal(result.accepted.length, 1); checkDetails(result.next);
  let booked = applyRecurring(result.next, '2026-11-05');
  assert.equal(booked.added.length, 1); checkDetails(booked.state);

  // The existing phone editor copies the entire subscription before changing its visible fields.
  const phoneBase = wire(booked.state.subscriptions[0]);
  const renamed = { ...phoneBase, name: '手机修改会员名称' };
  result = mergeMobileOperations(booked.state, wire(payload(booked.state, [put('subscription', renamed, phoneBase)])));
  assert.equal(result.conflicts.length, 0); assert.equal(result.next.subscriptions[0].name, renamed.name); checkDetails(result.next);

  const beforePause = wire(result.next.subscriptions[0]);
  const paused = setSubscriptionActive(result.next, sub.id, false, '2026-11-06');
  result = mergeMobileOperations(result.next, wire(payload(result.next, [put('subscription', paused.subscriptions[0], beforePause)])));
  assert.equal(result.conflicts.length, 0); checkDetails(result.next);
  booked = applyRecurring(result.next, '2026-12-05');
  assert.equal(booked.added.length, 0); checkDetails(booked.state);

  const beforeResume = wire(booked.state.subscriptions[0]);
  const resumed = setSubscriptionActive(booked.state, sub.id, true, '2027-01-04');
  result = mergeMobileOperations(booked.state, wire(payload(booked.state, [put('subscription', resumed.subscriptions[0], beforeResume)])));
  assert.equal(result.conflicts.length, 0); checkDetails(result.next);
  booked = applyRecurring(result.next, '2027-01-05');
  assert.deepEqual(booked.added.map(item => item.date), ['2027-01-05']); checkDetails(booked.state);
  assert.equal(booked.state.transactions.length, 2);
  assert.equal(applyRecurring(booked.state, '2027-01-05').added.length, 0);
});

test('each subscription detail participates in conflict detection and cannot silently overwrite a concurrent edit', () => {
  const baseline = subscription({ linkedAccounts: [{ type: 'apple', value: 'old@example.com' }], expiresOn: '2027-02-05', note: '原备注' });
  const variants = [
    ['linkedAccounts', [{ type: 'apple', value: 'desktop@example.com' }], [{ type: 'email', value: 'phone@example.com' }]],
    ['expiresOn', '2027-03-05', '2027-04-05'],
    ['note', '电脑确认过的备注', '离线手机备注'],
  ];
  for (const [field, desktopValue, phoneValue] of variants) {
    const desktop = state(), current = { ...structuredClone(baseline), [field]: desktopValue };
    desktop.subscriptions.push(current);
    const result = mergeMobileOperations(desktop, payload(desktop, [put('subscription', { ...baseline, [field]: phoneValue }, baseline)]));
    assert.equal(result.accepted.length, 0, field); assert.equal(result.conflicts.length, 1, field);
    assert.equal(result.conflicts[0].entity, 'subscription');
    assert.deepEqual(result.conflicts[0].current[field], desktopValue, field);
    assert.deepEqual(result.next, desktop, field);
  }
});

test('explicitly clearing subscription details syncs without restoring stale account or expiry values', () => {
  const desktop = state(), baseline = subscription({ linkedAccounts: [{ type: 'email', value: 'member@example.com' }], expiresOn: '2027-02-05', note: '可清空' });
  desktop.subscriptions.push(baseline);
  const cleared = { ...baseline, linkedAccounts: [], expiresOn: '', note: '' };
  const operation = put('subscription', cleared, baseline);
  const result = mergeMobileOperations(desktop, payload(desktop, [operation]));
  assert.equal(result.conflicts.length, 0); assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.next.subscriptions[0], cleared);
  const retry = mergeMobileOperations(result.next, payload(result.next, [operation]));
  assert.equal(retry.summary.duplicates, 1);
  assert.deepEqual(retry.next.subscriptions[0], cleared);
});

test('both devices charging the same subscription period preserve one charge despite metadata differences', () => {
  let desktop = state(); desktop.subscriptions.push(subscription()); desktop = applyRecurring(desktop, '2026-11-05').state;
  const charge = desktop.transactions[0];
  const result = mergeMobileOperations(desktop, payload(desktop, [tx({ ...charge, currency: 'CNY', title: '手机显示名称' })]));
  assert.equal(result.accepted.length, 1); assert.equal(result.summary.duplicates, 1); assert.equal(result.next.transactions.length, 1);
  assert.equal(getBalances(result.next).cash, 49000);
  const mismatch = mergeMobileOperations(desktop, payload(desktop, [tx({ ...charge, amount: 2000 })]));
  assert.equal(mismatch.accepted.length, 0); assert.equal(mismatch.conflicts.length, 1); assert.equal(getBalances(mismatch.next).cash, 49000);
});

test('new subscription and generated transaction can be synced in order and deleting a subscription retains historical expense', () => {
  const desktop = state(), sub = subscription({ processedOccurrences: ['member:2026-11'] });
  const charge = payment({ id: 'rec_member_202611', title: '会员', amount: 1000, category: '会员订阅', subscriptionId: 'member', occurrenceKey: 'member:2026-11' });
  let result = mergeMobileOperations(desktop, payload(desktop, [put('subscription', sub), tx(charge)]));
  assert.equal(result.conflicts.length, 0); assert.equal(result.next.transactions.length, 1);
  result = mergeMobileOperations(result.next, payload(result.next, [remove('subscription', sub)]));
  assert.equal(result.next.subscriptions.length, 0); assert.equal(result.next.transactions.length, 1);
  assert.equal(result.next.transactions[0].amount, 1000); assert.equal(result.next.transactions[0].subscriptionId, undefined);
  assert.equal(result.next.transactions[0].occurrenceKey, undefined); validateState(result.next);
});

test('full-ledger validation rejects currency changes, malformed transfers, settings deletion and unknown entities without partial writes', () => {
  const desktop = state(); desktop.transactions.push(payment());
  const result = mergeMobileOperations(desktop, payload(desktop, [
    put('account', { ...desktop.accounts[0], currency: 'USD', cnyRate: '7' }, desktop.accounts[0]),
    tx(payment({ type: 'transfer', toAccountId: 'cash' })),
    { id: randomUUID(), entity: 'settings', kind: 'delete', recordId: 'settings', base: desktop.settings },
    put('_mobileSync', { id: 'hack' }),
  ]));
  assert.equal(result.accepted.length, 0); assert.equal(result.conflicts.length, 4); assert.equal(result.changed, false);
  assert.deepEqual(result.next, desktop);
});

test('editing an existing subscription expense into income detaches the association and retains its processed marker', () => {
  let desktop = state(); desktop.subscriptions.push(subscription()); desktop = applyRecurring(desktop, '2026-11-05').state;
  const base = desktop.transactions[0], edited = { ...base, type: 'income', category: '其他收入' };
  delete edited.subscriptionId; delete edited.occurrenceKey;
  const result = mergeMobileOperations(desktop, payload(desktop, [tx(edited, base)]));
  assert.equal(result.conflicts.length, 0); assert.equal(result.next.transactions[0].type, 'income');
  assert.equal(applyRecurring(result.next, '2026-11-05').added.length, 0);
});

test('old clients retain their transaction-only scope and foreign or entity operations require protocol 2', () => {
  const desktop = state(), operations = [put('goal', { id: 'g', name: '目标', target: 10, saved: 0, color: '#445566' }), tx(payment({ currency: 'USD', cnyRate: '7' }))];
  const result = mergeMobileOperations(desktop, payload(desktop, operations, { protocolVersion: 1 }));
  assert.equal(result.accepted.length, 0); assert.equal(result.conflicts.length, 2);
  assert.throws(() => mergeMobileOperations(desktop, payload(desktop, [], { protocolVersion: 99 })), /版本/);
  assert.throws(() => mergeMobileOperations(desktop, payload(desktop, operations, { bookId: 'different-book' })), /另一份账本/);
});

test('lost subscription-create acknowledgement can merge later billing markers without overwriting editable fields', () => {
  const desktop = state(), sub = subscription({ processedOccurrences: ['member:2026-11'] });
  desktop.subscriptions.push(sub);
  const later = { ...sub, processedOccurrences: ['member:2026-11', 'member:2026-12'] };
  const result = mergeMobileOperations(desktop, payload(desktop, [put('subscription', later)]));
  assert.equal(result.conflicts.length, 0); assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.next.subscriptions[0].processedOccurrences, later.processedOccurrences);
  const conflict = mergeMobileOperations(desktop, payload(desktop, [put('subscription', { ...later, amount: 2500 })]));
  assert.equal(conflict.accepted.length, 0); assert.equal(conflict.conflicts.length, 1); assert.equal(conflict.next.subscriptions[0].amount, 1000);
});

test('refund sharing a payment order reference remains an independent reviewed transaction', () => {
  const desktop = state();
  const capture = { sourcePackage: 'com.tencent.mm', sourceKey: 'payment-key', occurredAt: Date.parse('2026-11-05T12:00:00Z'), reference: 'ORDER1234', transactionKind: 'payment' };
  desktop.transactions.push(payment({ mobileCapture: capture }));
  const refund = payment({ type: 'income', category: '退款', mobileCapture: { ...capture, sourceKey: 'refund-key', transactionKind: 'refund' } });
  const result = mergeMobileOperations(desktop, payload(desktop, [tx(refund)]));
  assert.equal(result.conflicts.length, 0); assert.equal(result.next.transactions.length, 2); assert.equal(getBalances(result.next).cash, 50000);
  const replay = mergeMobileOperations(result.next, payload(result.next, [tx({ ...refund, id: 'same-refund-again' })]));
  assert.equal(replay.summary.duplicates, 1); assert.equal(replay.next.transactions.length, 2);
});

test('strong notification deduplication compares transfer destination and actual received amount', () => {
  const desktop = state();
  desktop.accounts.push({ id: 'bank', name: '银行', type: '银行卡', color: '#445566', openingBalance: 0 }, { id: 'other', name: '另一账户', type: '银行卡', color: '#445566', openingBalance: 0 });
  const capture = { sourcePackage: 'cmb.pb', sourceKey: 'same-transfer', occurredAt: Date.parse('2026-11-05T12:00:00Z'), reference: 'TRANSFER123', transactionKind: 'transfer' };
  const first = payment({ type: 'transfer', toAccountId: 'bank', mobileCapture: capture }); desktop.transactions.push(first);
  const conflict = mergeMobileOperations(desktop, payload(desktop, [tx({ ...first, id: 'another-id', toAccountId: 'other' })]));
  assert.equal(conflict.accepted.length, 0); assert.equal(conflict.conflicts.length, 1); assert.equal(conflict.next.transactions.length, 1);
  assert.equal(conflict.conflicts[0].canKeepPhone, false); assert.match(conflict.conflicts[0].resolutionHint, /编辑/);
  assert.equal(getBalances(conflict.next).bank, 1200); assert.equal(getBalances(conflict.next).other, 0);
});

test('phone account repricing changes assets but retains historical transaction rate snapshots', () => {
  const desktop = state(); desktop.schemaVersion = 2;
  const account = { id: 'usd', name: '美元', type: '银行卡', color: '#445566', openingBalance: 10000, currency: 'USD', cnyRate: '7', rateMode: 'manual' };
  desktop.accounts.push(account); desktop.transactions.push(payment({ accountId: 'usd', amount: 1000, currency: 'USD', cnyRate: '7' }));
  const result = mergeMobileOperations(desktop, payload(desktop, [put('account', { ...account, cnyRate: '8' }, account)]));
  assert.equal(result.conflicts.length, 0); assert.equal(result.next.transactions[0].cnyRate, '7'); assert.equal(getNetWorth(result.next), 122000);
});
