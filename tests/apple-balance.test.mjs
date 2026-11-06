import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { accountPresets, accountPreset, accountLabel, appleBalanceRegions, appleBalanceRegion, isAppleBalance } from '../account-presets.mjs';
import { currencyInfo, parseMoney, toCnyCents } from '../currencies.mjs';
import { makeEmptyState, validateState, applyRecurring, getBalances, getNetWorth } from '../engine.mjs';
import { newSyncMetadata, mergeMobileOperations } from '../mobile-sync.mjs';

function account(region = 'US', extra = {}) {
  const currency = appleBalanceRegion(region)?.currency || 'USD';
  return {
    id: 'apple', providerId: 'apple-balance', name: '个人 Apple 余额', type: 'Apple 账户余额',
    color: '#77728f', appleRegion: region, appleAccount: 'member@example.test',
    currency, openingBalance: parseMoney('100', currency),
    ...(currency !== 'CNY' ? { cnyRate: '1', rateMode: 'manual' } : {}), ...extra,
  };
}
function fixture(accounts = [account()]) {
  const state = makeEmptyState();
  state.schemaVersion = 2;
  state.accounts = accounts;
  return state;
}

test('Apple shortcut and country choices have unique ids and supported matching currencies', () => {
  const preset = accountPresets.find(p => p.id === 'apple-balance');
  assert.equal(preset.name, 'Apple 余额');assert.equal(preset.icon, 'gift');
  assert.equal(accountPreset(account()), preset);
  assert.equal(new Set(appleBalanceRegions.map(r => r.id)).size, appleBalanceRegions.length);
  for (const region of appleBalanceRegions) {
    if (region.currency) assert.equal(currencyInfo(region.currency).code, region.currency);
    assert.equal(validateState(fixture([account(region.id)])), true);
  }
  assert.equal(appleBalanceRegion('TR').currency, 'TRY');
  assert.equal(appleBalanceRegion('OTHER').currency, null);
  assert.equal(appleBalanceRegion('unknown'), undefined);
});

test('Apple region is required and known country currencies cannot be substituted', () => {
  const absent = account();delete absent.appleRegion;
  assert.throws(() => validateState(fixture([absent])), /国家或地区/);
  for (const appleRegion of ['', 'XX', 'us', ' US ', null, 123, 'x'.repeat(11)]) {
    assert.throws(() => validateState(fixture([account('US', { appleRegion })])), /Apple/);
  }
  assert.throws(() => validateState(fixture([account('US', { currency: 'EUR' })])), /地区与币种不一致/);
  assert.throws(() => validateState(fixture([account('JP', { currency: 'USD' })])), /地区与币种不一致/);
  assert.equal(validateState(fixture([account('OTHER', { currency: 'EUR' })])), true);
});

test('optional Apple account labels reject invalid values and do not leak into ordinary accounts', () => {
  for (const appleAccount of [null, 123, 'x'.repeat(161), 'a\u0000b']) {
    assert.throws(() => validateState(fixture([account('US', { appleAccount })])), /Apple 账号标注/);
  }
  assert.equal(validateState(fixture([account('US', { appleAccount: 'x'.repeat(160) })])), true);
  const optional = account();delete optional.appleAccount;
  assert.equal(validateState(fixture([optional])), true);
  assert.equal(validateState(fixture([account('US', { appleAccount: '' })])), true);
  const ordinary = { id: 'cash', name: '现金', type: '现金', openingBalance: 0, color: '#123456' };
  assert.equal(validateState(fixture([ordinary])), true);
  assert.equal(validateState(fixture([{ ...ordinary, providerId: 'future-provider' }])), true);
  assert.equal(validateState(fixture([{ ...ordinary, appleRegion: '', appleAccount: '' }])), true);
  for (const extra of [{ appleRegion: 'US' }, { appleAccount: 'member@example.test' }]) {
    assert.throws(() => validateState(fixture([{ ...ordinary, ...extra }])), /只有 Apple 余额账户/);
  }
  assert.equal(isAppleBalance(undefined), false);
  assert.equal(isAppleBalance({ name: 'Apple 余额', type: 'Apple 账户余额' }), false);
  assert.equal(accountPreset({ name: 'Apple 余额', type: 'Apple 账户余额' }), undefined);
});

test('account selectors distinguish equal nicknames by Apple region, identifier and currency', () => {
  const us = account('US', { name: '我的余额', appleAccount: 'first@example.test' });
  const jp = account('JP', { name: '我的余额', appleAccount: 'first@example.test' });
  const usSecond = account('US', { name: '我的余额', appleAccount: 'second@example.test' });
  assert.equal(accountLabel(us), '我的余额 · 美国 · first@example.test · USD');
  assert.equal(accountLabel(jp), '我的余额 · 日本 · first@example.test · JPY');
  assert.notEqual(accountLabel(us), accountLabel(usSecond));
  assert.equal(accountLabel(account('CN', { name: '苹果余额', appleAccount: '' })), '苹果余额 · 中国大陆 · CNY');
  assert.equal(accountLabel({ name: '现金', type: '现金' }), '现金');
});

test('Apple balance metadata round-trips in backups without modifying native amounts or CNY valuation', () => {
  const state = fixture([account('TR', { openingBalance: parseMoney('1234.56', 'TRY'), cnyRate: '0.2' })]);
  const original = JSON.stringify(state);
  assert.equal(validateState(state), true);
  assert.equal(getBalances(state).apple, 123456);
  assert.equal(getNetWorth(state), toCnyCents(123456, 'TRY', '0.2'));
  const restored = JSON.parse(original);
  assert.equal(validateState(restored), true);
  assert.deepEqual(restored, state);assert.equal(JSON.stringify(state), original);
});

test('Apple-funded subscriptions charge exact native units once and retain account metadata', () => {
  const state = fixture([account('JP', { openingBalance: 10000, cnyRate: '0.05' })]);
  state.subscriptions.push({
    id: 'music', name: 'Apple Music', amount: 1080, currency: 'JPY', accountId: 'apple', category: '会员订阅',
    startDate: '2026-11-05', billingDay: 5, recurring: true, active: true,
    color: '#77728f', icon: 'music', processedOccurrences: [],
  });
  const result = applyRecurring(state, '2026-11-05');
  assert.equal(result.added.length, 1);assert.equal(result.added[0].amount, 1080);
  assert.equal(result.added[0].currency, 'JPY');assert.equal(result.added[0].cnyRate, '0.05');
  assert.equal(getBalances(result.state).apple, 8920);
  assert.deepEqual(result.state.accounts[0], state.accounts[0]);
  assert.equal(applyRecurring(result.state, '2026-11-05').added.length, 0);
});

function syncAccount(book, record, base = null) {
  return JSON.parse(JSON.stringify({
    protocolVersion: 2, deviceId: 'apple-phone', requestId: randomUUID(), bookId: book._mobileSync.bookId,
    operations: [{ id: randomUUID(), entity: 'account', kind: 'put', recordId: record.id, record, base }],
  }));
}

test('Turkish Apple accounts retain region, native balance and identifier across mobile creation and rename', () => {
  const desktop = { ...fixture([]), _mobileSync: newSyncMetadata() };
  const apple = account('TR', { openingBalance: 123456, cnyRate: '0.2', appleAccount: 'turkey@example.test' });
  let result = mergeMobileOperations(desktop, syncAccount(desktop, apple));
  assert.equal(result.accepted.length, 1);assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.next.accounts[0], apple);assert.equal(validateState(result.next), true);
  const beforeRename = JSON.parse(JSON.stringify(result.next.accounts[0]));
  const renamed = { ...beforeRename, name: '手机标注的土区账号' };
  result = mergeMobileOperations(result.next, syncAccount(result.next, renamed, beforeRename));
  assert.equal(result.accepted.length, 1);assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.next.accounts[0], renamed);
  assert.equal(getBalances(result.next).apple, 123456);
  assert.equal(getNetWorth(result.next), 24691);
  assert.equal(result.next.accounts[0].currency, 'TRY');
  assert.equal(result.next.accounts[0].appleRegion, 'TR');
  assert.equal(result.next.accounts[0].appleAccount, 'turkey@example.test');
});

test('concurrent Apple region or identifier edits conflict without replacing the current desktop account', () => {
  const baseline = account('DE');
  for (const [field, desktopValue, phoneValue] of [
    ['appleRegion', 'FR', 'IT'],
    ['appleAccount', 'desktop@example.test', 'phone@example.test'],
  ]) {
    const current = { ...baseline, [field]: desktopValue };
    const desktop = { ...fixture([current]), _mobileSync: newSyncMetadata() };
    const result = mergeMobileOperations(desktop, syncAccount(desktop, { ...baseline, [field]: phoneValue }, baseline));
    assert.equal(result.accepted.length, 0, field);assert.equal(result.conflicts.length, 1, field);
    assert.equal(result.conflicts[0].entity, 'account');
    assert.equal(result.conflicts[0].current[field], desktopValue);
    assert.deepEqual(result.next, desktop);
  }
});
