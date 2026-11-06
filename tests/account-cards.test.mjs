import test from 'node:test';
import assert from 'node:assert/strict';
import { accountCardArtKey, formatAccountTotal, renderAccountLibrary } from '../account-cards.js';
import { bankCatalog } from '../bank-catalog.mjs';
import { MAX_NATIVE_UNITS, formatMoney } from '../currencies.mjs';

const account = (id, extra = {}) => ({
  id, name: id, type: '银行卡', providerId: 'bank-card', bankId: 'boc',
  color: '#a83249', currency: 'CNY', openingBalance: 0, ...extra,
});

function render(accounts, options = {}) {
  const balances = Object.fromEntries(accounts.map(a => [a.id, a.openingBalance]));
  return renderAccountLibrary({
    state: { accounts, transactions: [] }, balances, cnyBalances: balances,
    view: 'banks', expandedBanks: new Set(), icon: () => '<svg aria-hidden="true"></svg>',
    accountLogo: () => '<span class="account-logo" aria-hidden="true"></span>',
    ...options,
  });
}

function cards(html) {
  return [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].map(match => match[0]);
}

test('every catalogue bank uses one native identity theme for its summary and member cards', () => {
  const accounts = bankCatalog.map(bank => account(bank.id, { bankId: bank.id }));
  const collapsed = render(accounts);
  const html = render(accounts, { expandedBanks: new Set(bankCatalog.map(bank => bank.id)) });
  assert.equal(new Set(accounts.map(accountCardArtKey)).size, bankCatalog.length);
  for (const bank of bankCatalog) {
    assert.equal(accountCardArtKey(accounts.find(a => a.id === bank.id)), bank.id);
    assert.equal(collapsed.split(`data-account-theme="${bank.id}"`).length - 1, 1);
    assert.equal(html.split(`data-account-theme="${bank.id}"`).length - 1, 2);
  }
  assert.doesNotMatch(collapsed + html, /data-card-art|\/assets\/illustrations\/|url\(/i);
});

test('wallets retain distinct native themes and imported IDs cannot inject theme keys or asset paths', () => {
  const cases = [['wechat','wechat'],['alipay','alipay'],['apple-balance','apple'],['virtual-card','virtual'],['cash','cash']];
  for (const [providerId, expected] of cases) {
    const a = account(providerId, { providerId, bankId: undefined, type: providerId === 'virtual-card' ? '虚拟卡' : '数字钱包' });
    assert.equal(accountCardArtKey(a), expected);
  }
  for (const bankId of [undefined,'unknown-bank','../../private',"boc');url(https://example.test/"]) {
    const unknown = account('unknown', { bankId });
    assert.equal(accountCardArtKey(unknown), 'generic');
    const html = render([unknown]);
    assert.match(html, /data-account-theme="generic"/);
    assert.doesNotMatch(html, /\.\.\/|example\.test|url\(|data-card-art/i);
  }
  assert.equal(accountCardArtKey(account('wallet', { providerId:'wechat', bankId:'boc', type:'数字钱包' })), 'wechat');
  assert.equal(accountCardArtKey(account('cash', { providerId:'cash', bankId:'boc' })), 'cash');
  assert.equal(accountCardArtKey(account('legacy-card', { name:'微信', providerId:undefined, bankId:'boc', type:'银行卡' })), 'boc');
  assert.equal(accountCardArtKey(account('investment', { name:'理财', providerId:undefined, bankId:'boc', type:'储蓄投资' })), 'generic');
});

test('read-only totals above one-account limits retain every digit without relaxing persisted-money validation', () => {
  const big = MAX_NATIVE_UNITS * 2 + 1;
  assert.equal(formatAccountTotal(big), '¥ 20,000,000,000.01');
  assert.equal(formatAccountTotal(-big), '¥ -20,000,000,000.01');
  assert.equal(formatAccountTotal(9007199254740991), '¥ 90,071,992,547,409.91');
  assert.throws(() => formatMoney(big), /范围/);
  assert.throws(() => formatAccountTotal(0.1));
});

test('USDT totals preserve six decimals while yen has no artificial decimal places', () => {
  assert.equal(formatAccountTotal(1234567, 'USDT'), 'USDT 1.234567');
  assert.equal(formatAccountTotal(-1, 'USDT'), 'USDT -0.000001');
  assert.equal(formatAccountTotal(1234000, 'USDT'), 'USDT 1.234');
  assert.equal(formatAccountTotal(1000000, 'USDT'), 'USDT 1');
  assert.equal(formatAccountTotal(-1080, 'JPY'), 'JPY -1,080');
  assert.equal(formatAccountTotal(0, 'JPY'), 'JPY 0');
  assert.equal(formatAccountTotal(-0), '¥ 0.00');
  assert.equal(formatAccountTotal(100, 'USD'), 'USD 1.00');
});

test('collapsed banks show CNY valuations and separate native totals without rendering member balances', () => {
  const accounts = [
    account('savings', { name: '工资卡', openingBalance: 572690, lastFour: '2333' }),
    account('foreign', { name: '跨境卡', currency: 'USD', cnyRate: '7', openingBalance: 41827, lastFour: '0611' }),
  ];
  const html = render(accounts, { cnyBalances: { savings: 572690, foreign: 292789 } });
  assert.match(html, /1 家银行 · 2 张卡/);
  assert.match(html, /合计余额 · 折合 CNY/);
  assert.match(html, /¥ 8,654\.79/);
  assert.match(html, /¥ 5,726\.90/);
  assert.match(html, /USD 418\.27/);
  assert.match(html, /多币种账户/);
  assert.match(html, /data-action="add-bank-account" data-bank-id="boc"/);
  assert.match(html, /aria-expanded="false" aria-controls="bank-cards-boc"/);
  assert.match(html, /id="bank-cards-boc"[^>]*hidden/);
  assert.equal(cards(html).length, 0);
  assert.doesNotMatch(html, /工资卡|跨境卡|2333|0611/);
});

test('expansion exposes independent card edit and bill actions, native currency and distinguishing tails', () => {
  const accounts = [
    account('savings', { name: '工资卡', openingBalance: 572690, lastFour: '2333' }),
    account('foreign', { name: '跨境卡', currency: 'USD', cnyRate: '7', openingBalance: 41827, lastFour: '0611', rateMode: 'manual' }),
  ];
  const html = render(accounts, {
    cnyBalances: { savings: 572690, foreign: 292789 }, expandedBanks: new Set(['boc']),
  });
  assert.match(html, /aria-expanded="true" aria-controls="bank-cards-boc"/);
  assert.doesNotMatch(html, /id="bank-cards-boc"[^>]*hidden/);
  const members = cards(html);
  assert.equal(members.length, 2);
  for (const [index, a] of accounts.entries()) {
    assert.ok(members[index].includes(`data-account-id="${a.id}"`));
    assert.ok(members[index].includes(`data-action="edit-account" data-id="${a.id}"`));
    assert.ok(members[index].includes(`data-action="account-transactions" data-id="${a.id}"`));
    assert.ok(members[index].includes(a.lastFour));
  }
  assert.match(members[1], /USD 418\.27/);
  assert.match(members[1], /¥ 2,927\.89/);
  assert.match(members[1], /手动汇率/);
});

test('each transfer counts once per related card and duplicate source/target ids do not double count', () => {
  const accounts = [account('a'), account('b')];
  const transactions = [
    { id: 'move', type: 'transfer', accountId: 'a', toAccountId: 'b' },
    { id: 'income', type: 'income', accountId: 'a' },
    { id: 'defensive-same-id', type: 'transfer', accountId: 'b', toAccountId: 'b' },
    { id: 'other', type: 'expense', accountId: 'unrelated' },
  ];
  const members = cards(render(accounts, { state: { accounts, transactions }, view: 'cards' }));
  assert.equal(members.length, 2);
  assert.match(members[0], /2 笔关联账单/);
  assert.match(members[1], /2 笔关联账单/);
});

test('account-controlled names, identifiers, tails and Apple labels are HTML-escaped', () => {
  const attack = '"><img src=x onerror=alert(1)>&\'tail';
  const a = account(attack, {
    name: attack, providerId: 'apple-balance', type: attack, bankId: undefined,
    appleRegion: 'US', appleAccount: attack, currency: 'USD', cnyRate: '7',
    lastFour: attack, rateAsOf: attack,
  });
  const html = render([a], { view: 'cards' });
  assert.doesNotMatch(html, /<img|<script/);
  assert.doesNotMatch(html, /data-id=""><|data-account-id=""></);
  assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&#39;tail'));
  assert.ok(html.includes('data-id="&quot;&gt;&lt;img'));
  assert.ok(html.includes('class="card-account-label">&quot;&gt;&lt;img'));
});

test('each supported provider selects its own native theme and ordinary cards remain separate', () => {
  const accounts = [
    account('wechat', { bankId: undefined, providerId: 'wechat', type: '数字钱包' }),
    account('alipay', { bankId: undefined, providerId: 'alipay', type: '数字钱包' }),
    account('apple', { bankId: undefined, providerId: 'apple-balance', type: 'Apple 账户余额', appleRegion: 'CN' }),
    account('bank'),
    account('virtual', { bankId: undefined, providerId: 'virtual-card', type: '虚拟卡' }),
    account('cash', { bankId: undefined, providerId: 'cash', type: '现金' }),
    account('custom', { bankId: undefined, providerId: undefined, type: '其他账户' }),
  ];
  const members = cards(render(accounts, { view: 'cards' }));
  assert.equal(members.length, accounts.length);
  const identityThemes = ['wechat', 'alipay', 'apple', 'boc', 'virtual', 'cash', 'generic'];
  ['wechat', 'alipay', 'apple', 'bank', 'virtual', 'cash', 'other'].forEach((theme, index) => {
    assert.ok(members[index].includes(`theme-${theme}`));
    assert.ok(members[index].includes(`data-account-theme="${identityThemes[index]}"`));
    assert.ok(members[index].includes(`data-account-id="${accounts[index].id}"`));
  });
});

test('all displayed account, converted and group amounts carry the existing privacy money marker', () => {
  const accounts = [account('a', { openingBalance: 12345 }),
    account('b', { currency: 'USD', cnyRate: '7', openingBalance: 6789 })];
  const html = render(accounts, { cnyBalances: { a: 12345, b: 47523 }, expandedBanks: new Set(['boc']) });
  const moneyElements = [...html.matchAll(/<(div|span) class="money">([^<]+)<\/\1>/g)].map(match => match[2]);
  assert.deepEqual(moneyElements, ['¥ 598.68', '¥ 123.45', 'USD 67.89', '¥ 123.45', 'USD 67.89', '¥ 475.23']);
  const withoutAmounts = html.replace(/<(div|span) class="money">[^<]+<\/\1>/g, '');
  assert.doesNotMatch(withoutAmounts, /¥\s-?\d|USD\s-?\d/);
});

test('rendering both views and expansion preserves independent accounts, debts and linked ledger records', () => {
  const accounts = [account('a', { openingBalance: 10000 }), account('b', { openingBalance: -2500 })];
  const state = {
    accounts, transactions: [{ id: 't', accountId: 'a', toAccountId: 'b', type: 'transfer', amount: 100 }],
    subscriptions: [{ id: 's', accountId: 'b', amount: 500 }], settings: { keep: true },
  };
  const before = structuredClone(state);
  const expandedBanks = new Set(['boc']);
  const grouped = render(accounts, { state, expandedBanks });
  const individual = render(accounts, { state, expandedBanks, view: 'cards' });
  assert.match(grouped, /¥ 75\.00/);
  assert.match(grouped, /包含负余额/);
  assert.match(individual, /¥ -25\.00/);
  assert.deepEqual(state, before);
  assert.deepEqual([...expandedBanks], ['boc']);
});

test('large native bank subtotals render even when both individual balances reach their allowed maximum', () => {
  const accounts = [account('one', { currency: 'USDT', openingBalance: MAX_NATIVE_UNITS }),
    account('two', { currency: 'USDT', openingBalance: MAX_NATIVE_UNITS })];
  const html = render(accounts, { cnyBalances: { one: 700000000, two: 700000000 } });
  assert.match(html, /USDT 2,000,000/);
  assert.match(html, /¥ 14,000,000\.00/);
});
