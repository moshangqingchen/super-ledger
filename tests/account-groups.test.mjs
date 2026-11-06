import test from 'node:test';
import assert from 'node:assert/strict';
import { groupAccounts } from '../account-groups.mjs';
import { parseMoney } from '../currencies.mjs';
import { makeEmptyState, getBalances, getCnyBalances, validateState } from '../engine.mjs';

const card = (id, bankId = 'boc', extra = {}) => ({
  id, bankId, name: '我的卡', type: '银行卡', providerId: 'bank-card',
  color: '#a83249', openingBalance: 0, ...extra,
});

test('same-bank cards have an exact CNY total and distinct native currency subtotals', () => {
  const state = makeEmptyState();
  state.schemaVersion = 2;
  state.accounts = [
    card('cny', 'boc', { openingBalance: parseMoney('5726.90') }),
    card('usd', 'boc', { currency: 'USD', cnyRate: '6.6684', openingBalance: parseMoney('418.27', 'USD') }),
    card('credit', 'boc', { type: '信用卡', openingBalance: parseMoney('-0.20') }),
  ];
  assert.equal(validateState(state), true);
  const b = getBalances(state), cny = getCnyBalances(state);
  const [group] = groupAccounts(state.accounts, { balances: b, cnyBalances: cny });
  assert.equal(group.kind, 'bank');
  assert.equal(group.bankId, 'boc');
  assert.equal(group.bank.name, '中国银行');
  assert.equal(group.totalCny, cny.cny + cny.usd + cny.credit);
  assert.deepEqual(group.currencyTotals, [
    { currency: 'CNY', amount: 572670 },
    { currency: 'USD', amount: 41827 },
  ]);
  assert.notEqual(group.totalCny, b.cny + b.usd + b.credit);
});

test('first appearance determines group order while member order remains stable', () => {
  const accounts = [
    { id: 'wallet', name: '微信', type: '数字钱包', providerId: 'wechat' },
    card('boc-first'),
    card('icbc', 'icbc'),
    { id: 'cash', name: '现金', type: '现金' },
    card('boc-second'),
  ];
  const groups = groupAccounts(accounts);
  assert.deepEqual(groups.map(g => g.key), ['account:wallet', 'bank:boc', 'bank:icbc', 'account:cash']);
  assert.deepEqual(groups[1].accounts.map(a => a.id), ['boc-first', 'boc-second']);
  assert.equal(groups[0].account, accounts[0]);
  assert.deepEqual(groups[0].accounts, [accounts[0]]);
});

test('single-card banks are still groups with a bank identity for adding another card', () => {
  const account = card('first', 'ccb');
  const [group] = groupAccounts([account]);
  assert.equal(group.kind, 'bank');
  assert.equal(group.bankId, 'ccb');
  assert.equal(group.accounts.length, 1);
  assert.equal(group.accounts[0], account);
  assert.equal(group.totalCny, 0);
});

test('unknown banks, unselected banks, equal names and non-card providers never merge', () => {
  const accounts = [
    card('unknown-one', 'custom'), card('unknown-two', 'custom'),
    card('none-one', ''), card('none-two', ''),
    { id: 'wechat', providerId: 'wechat', bankId: 'boc', name: '中国银行', type: '数字钱包' },
    { id: 'apple', providerId: 'apple-balance', bankId: 'boc', name: '中国银行', type: '银行卡' },
    { id: 'cash', providerId: 'cash', bankId: 'boc', name: '中国银行', type: '现金' },
    card('real'),
  ];
  const groups = groupAccounts(accounts);
  assert.equal(groups.length, accounts.length);
  assert.deepEqual(groups.slice(0, -1).map(g => g.kind), Array(7).fill('account'));
  assert.equal(groups.at(-1).kind, 'bank');
  assert.equal(groups.at(-1).accounts.length, 1);
});

test('legacy credit-card types and virtual bank cards group by explicit bank id', () => {
  const groups = groupAccounts([
    card('legacy', 'boc', { providerId: undefined, type: '信用卡' }),
    card('virtual', 'boc', { providerId: 'virtual-card', type: '虚拟卡' }),
    card('savings', 'boc', { providerId: undefined, type: '储蓄卡' }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].accounts.map(a => a.id), ['legacy', 'virtual', 'savings']);
});

test('minor-unit arithmetic preserves cents, six-decimal tokens, yen and negative balances', () => {
  const accounts = [
    card('ten'), card('twenty'),
    card('usdt-one', 'boc', { currency: 'USDT' }),
    card('usdt-two', 'boc', { currency: 'USDT' }),
    card('yen', 'boc', { currency: 'JPY' }),
  ];
  const balances = { ten: parseMoney('0.10'), twenty: parseMoney('0.20'),
    'usdt-one': parseMoney('1.000001', 'USDT'), 'usdt-two': parseMoney('-0.000002', 'USDT'),
    yen: parseMoney('-1080', 'JPY') };
  const [group] = groupAccounts(accounts, { balances, cnyBalances: { ten: 10, twenty: 20, 'usdt-one': 700, 'usdt-two': 0, yen: -5400 } });
  assert.deepEqual(group.currencyTotals, [
    { currency: 'CNY', amount: 30 }, { currency: 'USDT', amount: 999999 }, { currency: 'JPY', amount: -1080 },
  ]);
  assert.equal(group.totalCny, -4670);
});

test('grouping preserves frozen account data and supplied balance maps', () => {
  const accounts = Object.freeze([Object.freeze(card('a')), Object.freeze(card('b'))]);
  const balances = Object.freeze({ a: 123, b: -456 });
  const cnyBalances = Object.freeze({ a: 123, b: -456 });
  const before = JSON.stringify({ accounts, balances, cnyBalances });
  const [group] = groupAccounts(accounts, { balances, cnyBalances });
  assert.equal(JSON.stringify({ accounts, balances, cnyBalances }), before);
  assert.equal(group.accounts[0], accounts[0]);
  group.accounts.reverse();
  assert.equal(accounts[0].id, 'a');
  assert.equal(group.totalCny, -333);
});

test('empty input stays empty and invalid decimal-unit or unsafe sums fail explicitly', () => {
  assert.deepEqual(groupAccounts([]), []);
  assert.equal(groupAccounts([card('constructor')])[0].totalCny, 0);
  assert.throws(() => groupAccounts([card('a')], { balances: { a: 0.1 } }), /整数最小单位/);
  assert.throws(() => groupAccounts([card('a'), card('b')], {
    balances: { a: Number.MAX_SAFE_INTEGER, b: 1 },
  }), /安全金额范围/);
});
