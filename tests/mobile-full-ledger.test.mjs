import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeEmptyState, applyRecurring, validateState, getBalances, getNetWorth } from '../engine.mjs';
import { newSyncMetadata, mergeMobileOperations } from '../mobile-sync.mjs';

function state() {
  return { ...makeEmptyState(), _mobileSync: newSyncMetadata(), accounts: [
    { id: 'cash', name: '现金', type: '现金', color: '#445566', openingBalance: 50000 },
  ] };
}
function payload(book, operations, more = {}) {
  return { protocolVersion: 2, deviceId: 'phone-full', requestId: randomUUID(), bookId: book._mobileSync.bookId, operations, ...more };
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
