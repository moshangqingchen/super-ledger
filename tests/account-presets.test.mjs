import test from 'node:test';
import assert from 'node:assert/strict';
import { accountPreset } from '../account-presets.mjs';
import { bankForCard, groupAccounts } from '../account-groups.mjs';

test('editing legacy bank cards named after wallets preserves their bank classification', () => {
  for (const name of ['微信', '支付宝']) {
    for (const type of ['银行卡', '储蓄卡', '信用卡 / 负债']) {
      const legacy = Object.freeze({ id: 'legacy', name, type, bankId: 'boc', currency: 'CNY' });
      const inferredPreset = accountPreset(legacy);
      assert.equal(inferredPreset?.id, 'bank-card');
      // The account editor saves the inferred preset when no explicit provider
      // exists. That round trip must keep the card in the same bank group.
      const saved = { ...legacy, providerId: inferredPreset.id };
      assert.equal(bankForCard(saved)?.id, 'boc');
      assert.equal(groupAccounts([saved])[0].kind, 'bank');
      assert.equal(Object.hasOwn(legacy, 'providerId'), false);
    }
  }
});

test('explicit providers win over stale bank identifiers and card-like account types', () => {
  for (const providerId of ['wechat', 'alipay', 'cash', 'apple-balance', 'virtual-card']) {
    const account = { name: '银行卡', type: '银行卡', providerId, bankId: 'boc' };
    assert.equal(accountPreset(account)?.id, providerId);
  }
  assert.equal(accountPreset({ name: '微信', type: '银行卡', providerId: 'custom', bankId: 'boc' }), undefined);
});

test('legacy virtual cards keep their virtual preset even when their nickname matches a wallet', () => {
  for (const name of ['微信', '支付宝', '银行卡']) {
    const account = { name, type: '虚拟卡', bankId: 'boc' };
    assert.equal(accountPreset(account)?.id, 'virtual-card');
    assert.equal(bankForCard(account)?.id, 'boc');
  }
});

test('bank inference requires both a known bank and a card type, preserving other legacy name guesses', () => {
  assert.equal(accountPreset({ name: '微信', type: '数字钱包', bankId: 'boc' })?.id, 'wechat');
  assert.equal(accountPreset({ name: '支付宝', type: '银行卡', bankId: 'unknown' })?.id, 'alipay');
  assert.equal(accountPreset({ name: '微信', type: '银行卡' })?.id, 'wechat');
  assert.equal(accountPreset({ name: '理财', type: '储蓄投资', bankId: 'boc' }), undefined);
});
