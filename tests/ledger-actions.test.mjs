import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState, MAX_MONEY, validateState } from '../engine.mjs';
import { adjustedGoalSaved, captureDeletion, restoreDeletion } from '../assets/ledger-actions.mjs';
import { sortedLedgerRows } from '../assets/ledger-insights.mjs';

const transaction = (id, extra = {}) => ({
  id, type: 'expense', amount: 100, accountId: 'cash', date: '2026-11-08',
  category: '其他支出', title: id, note: '', ...extra,
});
const subscription = (id = 'music') => ({
  id, name: id, amount: 1900, accountId: 'cash', category: '会员订阅',
  startDate: '2026-10-08', billingDay: 8, active: true, recurring: true,
  color: '#123456', icon: 'music', processedOccurrences: [`${id}:2026-10`, `${id}:2026-11`],
});
const goal = (id = 'trip') => ({ id, name: id, target: 10000, saved: 100, color: '#123456' });

function fixture({ transactions = [], subscriptions = [], goals = [] } = {}) {
  const state = makeEmptyState();
  state.accounts = [{ id: 'cash', name: '现金', type: '现金', openingBalance: 100000, color: '#123456' }];
  Object.assign(state, { transactions, subscriptions, goals });
  assert.equal(validateState(state), true);
  return state;
}

function deletedState(state, deletion) {
  const next = structuredClone(state);
  next[deletion.key] = next[deletion.key].filter(row => row.id !== deletion.record.id);
  if (deletion.key === 'subscriptions') {
    for (const tx of next.transactions) {
      if (tx.subscriptionId !== deletion.record.id) continue;
      delete tx.subscriptionId;
      delete tx.occurrenceKey;
    }
  }
  assert.equal(validateState(next), true);
  return next;
}

function subscriptionFixture() {
  return fixture({
    subscriptions: [subscription()],
    transactions: [
      transaction('october', { date: '2026-10-08', amount: 1900, category: '会员订阅', subscriptionId: 'music', occurrenceKey: 'music:2026-10' }),
      transaction('november', { amount: 1900, category: '会员订阅', subscriptionId: 'music', occurrenceKey: 'music:2026-11' }),
      transaction('ordinary'),
    ],
  });
}

test('goal deposits and withdrawals use exact cents and permit zero remaining and the exact upper limit', () => {
  assert.equal(adjustedGoalSaved(100, '0.29'), 129);
  assert.equal(adjustedGoalSaved(129, '0.29', 'withdraw'), 100);
  assert.equal(adjustedGoalSaved(29, '0.29', 'withdraw'), 0);
  assert.equal(adjustedGoalSaved(MAX_MONEY - 1, '0.01'), MAX_MONEY);
  assert.equal(adjustedGoalSaved(MAX_MONEY, '10000000000', 'withdraw'), 0);
});

test('goal adjustments reject zero, negative, malformed, overflowing and excessive withdrawal amounts', () => {
  for (const value of ['0', '0.00', '-0', '-0.01', '-1']) {
    assert.throws(() => adjustedGoalSaved(100, value), /金额需要大于 0/);
  }
  for (const value of ['', '0.001', '1e2', '10000000000.01']) {
    assert.throws(() => adjustedGoalSaved(100, value));
  }
  assert.throws(() => adjustedGoalSaved(MAX_MONEY, '0.01'), /上限/);
  assert.throws(() => adjustedGoalSaved(100, '1.01', 'withdraw'), /不能超过当前已存金额/);
  assert.throws(() => adjustedGoalSaved(0, '0.01', 'withdraw'), /不能超过当前已存金额/);
  assert.throws(() => adjustedGoalSaved(100, '1', 'unknown'), /请选择存入或取出/);
});

test('deletion snapshots are independent and unsupported or absent records fail explicitly', () => {
  const state = fixture({ transactions: [transaction('first'), transaction('second'), transaction('third')] });
  const snapshot = captureDeletion(state, 'transaction', 'second');
  assert.equal(snapshot.key, 'transactions');
  assert.equal(snapshot.index, 1);
  assert.equal(snapshot.beforeId, 'first');
  assert.equal(snapshot.afterId, 'third');
  state.transactions[1].title = '后来编辑';
  assert.equal(snapshot.record.title, 'second');
  assert.deepEqual(snapshot.links, []);
  assert.throws(() => captureDeletion(state, 'account', 'cash'), /不支持撤销/);
  assert.throws(() => captureDeletion(state, 'transaction', 'missing'), /已被移除/);
});

test('undo merges with the latest ledger and preserves new bills, revisions, edits and same-day order', () => {
  const state = fixture({ transactions: [transaction('first'), transaction('second'), transaction('third')] });
  const deletion = captureDeletion(state, 'transaction', 'second');
  const latest = deletedState(state, deletion);
  latest.revision = 7;
  latest.transactions.push(transaction('sync-new', { title: '同步增加' }));
  latest.transactions[0].note = '同步修改';
  const before = structuredClone(latest);
  const restored = restoreDeletion(latest, deletion);
  assert.deepEqual(restored.transactions.map(row => row.id), ['first', 'second', 'third', 'sync-new']);
  assert.deepEqual(sortedLedgerRows(restored.transactions).map(row => row.id), ['sync-new', 'third', 'second', 'first']);
  assert.equal(restored.transactions[0].note, '同步修改');
  assert.equal(restored.transactions[3].title, '同步增加');
  assert.equal(restored.revision, 7);
  assert.deepEqual(latest, before);
  assert.equal(validateState(restored), true);
});

test('undo uses surviving neighbors and falls back to the original index when both are gone', () => {
  const state = fixture({ transactions: ['a', 'b', 'c', 'd'].map(id => transaction(id)) });
  const deletion = captureDeletion(state, 'transaction', 'b');
  for (const [ids, expected] of [
    [['c', 'd', 'new'], ['b', 'c', 'd', 'new']],
    [['a', 'd', 'new'], ['a', 'b', 'd', 'new']],
    [['d', 'new'], ['d', 'b', 'new']],
    [[], ['b']],
  ]) {
    const latest = fixture({ transactions: ids.map(id => transaction(id)) });
    assert.deepEqual(restoreDeletion(latest, deletion).transactions.map(row => row.id), expected);
  }
});

test('transaction, subscription and goal undo reject colliding IDs without changing current state', () => {
  for (const [kind, state, id] of [
    ['transaction', fixture({ transactions: [transaction('tx')] }), 'tx'],
    ['subscription', fixture({ subscriptions: [subscription()] }), 'music'],
    ['goal', fixture({ goals: [goal()] }), 'trip'],
  ]) {
    const deletion = captureDeletion(state, kind, id);
    const before = structuredClone(state);
    assert.throws(() => restoreDeletion(state, deletion), /相同 ID/);
    assert.deepEqual(state, before);
  }
});

test('goal undo preserves other goals created after deletion', () => {
  const state = fixture({ goals: [goal()] });
  const deletion = captureDeletion(state, 'goal', 'trip');
  const latest = deletedState(state, deletion);
  latest.goals.push({ ...goal('new'), saved: 234 });
  const restored = restoreDeletion(latest, deletion);
  assert.deepEqual(restored.goals.map(row => row.id), ['trip', 'new']);
  assert.equal(restored.goals[1].saved, 234);
});

test('subscription undo restores only removed link fields while preserving concurrent title, note and valid amount edits', () => {
  const state = subscriptionFixture();
  const deletion = captureDeletion(state, 'subscription', 'music');
  assert.equal(deletion.links.length, 2);
  const latest = deletedState(state, deletion);
  Object.assign(latest.transactions[0], { title: '已重新命名', note: '同步备注', amount: 2000 });
  latest.transactions.push(transaction('new'));
  const before = structuredClone(latest);
  const restored = restoreDeletion(latest, deletion);
  assert.deepEqual(restored.transactions[0], {
    ...latest.transactions[0], subscriptionId: 'music', occurrenceKey: 'music:2026-10',
  });
  assert.deepEqual(restored.transactions[1], state.transactions[1]);
  assert.deepEqual(restored.transactions.slice(2), latest.transactions.slice(2));
  assert.deepEqual(restored.subscriptions, state.subscriptions);
  assert.deepEqual(latest, before);
  assert.equal(validateState(restored), true);
});

test('subscription undo never resurrects linked bills that were independently deleted', () => {
  const state = subscriptionFixture();
  const deletion = captureDeletion(state, 'subscription', 'music');
  const latest = deletedState(state, deletion);
  latest.transactions = latest.transactions.filter(row => row.id !== 'october');
  const restored = restoreDeletion(latest, deletion);
  assert.equal(restored.transactions.some(row => row.id === 'october'), false);
  assert.equal(restored.transactions.find(row => row.id === 'november').subscriptionId, 'music');
  assert.equal(restored.subscriptions.length, 1);
});

test('subscription undo refuses changed links instead of overwriting a different subscription', () => {
  const state = subscriptionFixture();
  const deletion = captureDeletion(state, 'subscription', 'music');
  const latest = deletedState(state, deletion);
  latest.subscriptions.push(subscription('other'));
  Object.assign(latest.transactions[0], { subscriptionId: 'other', occurrenceKey: 'other:2026-10' });
  assert.equal(validateState(latest), true);
  const before = structuredClone(latest);
  assert.throws(() => restoreDeletion(latest, deletion), /订阅关联已改变/);
  assert.deepEqual(latest, before);
});

test('restored subscription links are validated against changed transaction type and calendar month', () => {
  const state = subscriptionFixture();
  const deletion = captureDeletion(state, 'subscription', 'music');
  for (const [change, message] of [
    [{ type: 'income' }, /订阅交易必须是支出/],
    [{ date: '2026-09-08' }, /订阅账期与交易日期不符/],
  ]) {
    const latest = deletedState(state, deletion);
    Object.assign(latest.transactions[0], change);
    assert.equal(validateState(latest), true);
    const before = structuredClone(latest);
    assert.throws(() => restoreDeletion(latest, deletion), message);
    assert.deepEqual(latest, before);
  }
});

test('undo propagates validation errors for invalid amounts and deleted dependencies without mutating state', () => {
  const state = subscriptionFixture();
  const deletion = captureDeletion(state, 'subscription', 'music');
  for (const amount of [0, -1, 1.5, '1900', MAX_MONEY + 1]) {
    const latest = deletedState(state, deletion);
    latest.transactions[0].amount = amount;
    const before = structuredClone(latest);
    assert.throws(() => restoreDeletion(latest, deletion), /交易金额必须是/);
    assert.deepEqual(latest, before);
  }
  const txState = fixture({ transactions: [transaction('tx')] });
  const txDeletion = captureDeletion(txState, 'transaction', 'tx');
  const latest = deletedState(txState, txDeletion);
  latest.accounts = [];
  assert.equal(validateState(latest), true);
  assert.throws(() => restoreDeletion(latest, txDeletion), /交易的账户不存在/);
});

test('subscription links without an occurrence key are restored without inventing one', () => {
  const state = fixture({
    subscriptions: [subscription()],
    transactions: [transaction('manual-linked', { subscriptionId: 'music' })],
  });
  const deletion = captureDeletion(state, 'subscription', 'music');
  const restored = restoreDeletion(deletedState(state, deletion), deletion);
  assert.equal(restored.transactions[0].subscriptionId, 'music');
  assert.equal(Object.hasOwn(restored.transactions[0], 'occurrenceKey'), false);
});
