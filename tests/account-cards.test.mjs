import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('every bank and wallet theme defines its saturated glow token with a generic fallback', () => {
  const css = readFileSync(new URL('../account-cards.css', import.meta.url), 'utf8');
  const glows = {
    icbc: '#ff5d4d', ccb: '#2f86e8', abc: '#17b894', cmb: '#ff3f78',
    boc: '#d8345b', bocom: '#4f68e8', psbc: '#5fae3c', pingan: '#ff9a2e',
    wechat: '#22d07d', alipay: '#2f9dff', apple: '#9aa6b8',
    virtual: '#9a6bff', cash: '#f2b23a', generic: '#7c8cff',
  };
  for (const theme of [...bankCatalog.map(bank => bank.id), 'wechat', 'alipay', 'apple', 'virtual', 'cash', 'generic']) {
    const rule = css.match(new RegExp(`\\[data-account-theme="${theme}"\\]\\s*\\{([^}]+)\\}`));
    assert.ok(rule, `${theme} has an explicit theme rule`);
    assert.match(rule[1], new RegExp(`--card-glow\\s*:\\s*${glows[theme]}\\s*[;}]?`, 'i'));
  }
  const fallback = css.match(/\[data-account-theme\]\s*\{([^}]+)\}/);
  assert.ok(fallback, 'unknown themes have a fallback rule');
  assert.match(fallback[1], /--card-glow\s*:\s*#7c8cff\b/i);
});

test('all seven account kinds have distinct hidden native ornaments and bank summaries reuse the bank ornament', () => {
  const accounts = [
    account('alipay', { bankId: undefined, providerId: 'alipay', type: '数字钱包' }),
    account('apple', { bankId: undefined, providerId: 'apple-balance', type: 'Apple 账户余额' }),
    account('virtual', { bankId: undefined, providerId: 'virtual-card', type: '虚拟卡' }),
    account('cash', { bankId: undefined, providerId: 'cash', type: '现金' }),
    account('wechat', { bankId: undefined, providerId: 'wechat', type: '数字钱包' }),
    account('bank'),
    account('other', { bankId: undefined, providerId: undefined, type: '其他账户' }),
  ];
  const individual = render(accounts, { view: 'cards' });
  const ornaments = cards(individual).map(card => {
    const tags = [...card.matchAll(/<span\b[^>]*class="([^"]*\bcard-ornament\b[^"]*)"[^>]*>/g)];
    assert.equal(tags.length, 1, 'each card has exactly one decorative object');
    assert.match(tags[0][0], /aria-hidden="true"/);
    const ornament = tags[0][1].split(/\s+/).filter(name => name.startsWith('ornament-'));
    assert.equal(ornament.length, 1);
    return ornament[0];
  });
  assert.equal(new Set(ornaments).size, 7);
  const collapsed = render(accounts);
  const expanded = render(accounts, { expandedBanks: new Set(['boc']) });
  const summary = collapsed.match(/<div class="bank-group-overview">([\s\S]*?)<div class="bank-cover">/);
  assert.ok(summary, 'bank ornament appears inside the summary before its foreground content');
  assert.ok(summary[1].includes(ornaments[5]));
  assert.match(summary[1], /aria-hidden="true"/);
  assert.doesNotMatch(individual + collapsed + expanded, /url\(|\/assets\/illustrations\/|data-card-art/i);
});

test('collapsed bank stack depth matches one or two cards and caps at three for five cards', () => {
  for (const count of [1, 2, 5]) {
    const accounts = Array.from({ length: count }, (_, index) => account(`private-member-${index}`, { lastFour: `900${index}` }));
    const html = render(accounts);
    const section = html.match(/<section\b[^>]*class="bank-group\b[^>]*>/);
    assert.ok(section);
    assert.match(section[0], new RegExp(`data-card-stack="${Math.min(count, 3)}"`));
    assert.equal(cards(html).length, 0);
    assert.doesNotMatch(html, /private-member-|900[0-4]/);
  }
});

test('only the explicitly dealt and currently expanded bank receives the entrance animation marker', () => {
  const accounts = [account('boc-card'), account('ccb-card', { bankId: 'ccb' })];
  const cases = [
    { expandedBanks: new Set(['boc', 'ccb']), dealBankId: 'boc', expected: ['boc'] },
    { expandedBanks: new Set(['boc', 'ccb']), dealBankId: 'ccb', expected: ['ccb'] },
    { expandedBanks: new Set(['ccb']), dealBankId: 'boc', expected: [] },
    { expandedBanks: new Set(['boc', 'ccb']), dealBankId: '', expected: [] },
    { expandedBanks: new Set(['boc', 'ccb']), dealBankId: 'unknown-bank', expected: [] },
  ];
  for (const { expected, ...options } of cases) {
    const html = render(accounts, options);
    const marked = [...html.matchAll(/<section\b[^>]*class="([^"]*\bbank-group\b[^"]*)"[^>]*data-bank-id="([^"]+)"[^>]*>/g)]
      .filter(match => match[1].split(/\s+/).includes('is-dealing')).map(match => match[2]);
    assert.deepEqual(marked, expected);
  }
  assert.doesNotMatch(render(accounts, { view: 'cards', expandedBanks: new Set(['boc']), dealBankId: 'boc' }), /is-dealing/);
});

test('toggle-all appears only for two or more banks in the bank view and reflects full or mixed expansion', () => {
  const accounts = [account('boc-one'), account('boc-two'), account('ccb-one', { bankId: 'ccb' })];
  const button = /<button\b[^>]*data-action="toggle-all-banks"[^>]*>([^<]+)<\/button>/g;
  for (const [expandedBanks, label] of [
    [new Set(), '全部展开'],
    [new Set(['boc']), '全部展开'],
    [new Set(['boc', 'ccb']), '全部收起'],
    [new Set(['boc', 'ccb', 'stale-bank']), '全部收起'],
  ]) {
    const html = render(accounts, { expandedBanks });
    const buttons = [...html.matchAll(button)];
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0][1], label);
    assert.match(buttons[0][0], /class="text-btn bank-toggle-all"/);
    assert.match(html, /2 家银行 · 3 张卡/);
  }
  for (const subset of [[], accounts.slice(0, 1), accounts.slice(0, 2)]) {
    assert.doesNotMatch(render(subset), /toggle-all-banks/);
  }
  assert.doesNotMatch(render(accounts, { view: 'cards', expandedBanks: new Set(['boc', 'ccb']) }), /toggle-all-banks/);
});

test('negative card markers use the live native balance while every amount retains the exact money class', () => {
  const accounts = [
    account('negative', { openingBalance: 500 }),
    account('zero', { openingBalance: -500 }),
    account('positive', { openingBalance: -500, currency: 'USD' }),
  ];
  const balances = { negative: -125, zero: 0, positive: 125 };
  const html = render(accounts, { view: 'cards', balances, cnyBalances: { negative: -125, zero: 0, positive: 875 } });
  for (const [index, card] of cards(html).entries()) {
    const balanceClass = card.match(/<div class="(card-balance(?:\s+[^"]*)?)"/);
    assert.ok(balanceClass);
    assert.equal(balanceClass[1].split(/\s+/).includes('is-negative'), index === 0);
  }
  const moneyClasses = [...html.matchAll(/class="([^"]*\bmoney\b[^"]*)"/g)].map(match => match[1]);
  assert.equal(moneyClasses.length, 4);
  assert.ok(moneyClasses.every(value => value === 'money'));
});

test('bank negative markers depend only on the CNY total, including mixed debts and a zero net balance', () => {
  const accounts = [
    account('positive-debt', { openingBalance: -10000 }),
    account('positive-credit', { openingBalance: 20000 }),
    account('zero-debt', { bankId: 'ccb', openingBalance: -500 }),
    account('zero-credit', { bankId: 'ccb', openingBalance: 500 }),
    account('negative-credit', { bankId: 'icbc', currency: 'JPY', openingBalance: 10000 }),
    account('negative-debt', { bankId: 'icbc', currency: 'USD', openingBalance: -100 }),
  ];
  const cnyBalances = {
    'positive-debt': -10000, 'positive-credit': 20000,
    'zero-debt': -500, 'zero-credit': 500,
    'negative-credit': 500, 'negative-debt': -700,
  };
  const html = render(accounts, { cnyBalances, expandedBanks: new Set(['boc', 'ccb', 'icbc']) });
  for (const [bankId, negative] of [['boc', false], ['ccb', false], ['icbc', true]]) {
    const section = html.match(new RegExp(`<section\\b[^>]*data-bank-id="${bankId}"[^>]*>([\\s\\S]*?)<\\/section>`));
    assert.ok(section);
    const totalClass = section[1].match(/<div class="(bank-total(?:\s+[^"]*)?)"/);
    assert.ok(totalClass);
    assert.equal(totalClass[1].split(/\s+/).includes('is-negative'), negative, bankId);
    assert.match(section[1], /包含负余额/);
  }
  for (const match of html.matchAll(/class="([^"]*\bmoney\b[^"]*)"/g)) assert.equal(match[1], 'money');
});

test('negative amount styling uses direct children and privacy mode neutralizes both card and bank colors', () => {
  const css = readFileSync(new URL('../account-cards.css', import.meta.url), 'utf8');
  assert.match(css, /\.card-balance\.is-negative\s*>\s*\.money\s*,\s*\.bank-total\.is-negative\s*>\s*\.money\s*\{\s*color:\s*#c2453d\s*;?\s*\}/i);
  assert.match(css, /\.amounts-hidden\s+\.card-balance\.is-negative\s*>\s*\.money\s*,\s*\.amounts-hidden\s+\.bank-total\.is-negative\s*>\s*\.money\s*\{\s*color:\s*inherit\s*;?\s*\}/i);
});

// Exercise the real event branches without importing the application or opening
// storage, Electron, or a browser. The DOM and render boundary stay in memory.
function accountToggle(action, { expandedBanks = new Set(), domBanks = [], bankId, dealBank = '' } = {}) {
  const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const branches = ['toggle-bank', 'toggle-all-banks'].map(name => {
    const branch = source.match(new RegExp(`case\\s*'${name}'\\s*:[\\s\\S]*?(?=\\s*case\\s*'|\\s*default\\s*:)`));
    assert.ok(branch, `${name} event branch exists`);
    return branch[0];
  }).join('\n');
  const events = [];
  const environment = {
    action, expandedBanks, dealBank, events, target: { dataset: { bankId } },
    bankById: id => bankCatalog.find(bank => bank.id === id),
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, '.bank-group[data-bank-id]');
        return domBanks.map(id => ({ dataset: { bankId: id } }));
      },
      querySelector(selector) {
        return { focus(options) { events.push({ type: 'focus', selector, options }); } };
      },
    },
  };
  const run = new Function('environment', `
    let { dealBank } = environment;
    const { expandedBanks, target, bankById, document } = environment;
    const render = () => environment.events.push({ type: 'render', dealBank, banks: [...expandedBanks] });
    switch (environment.action) { ${branches} }
    return dealBank;
  `);
  return { expandedBanks, events, dealBank: run(environment) };
}

test('single-bank toggles deal only on expansion, clear the marker after render and restore keyboard focus', () => {
  const expandedBanks = new Set();
  const opened = accountToggle('toggle-bank', { expandedBanks, bankId: 'boc' });
  assert.deepEqual(opened.events, [
    { type: 'render', dealBank: 'boc', banks: ['boc'] },
    { type: 'focus', selector: '[data-action="toggle-bank"][data-bank-id="boc"]', options: { preventScroll: true } },
  ]);
  assert.equal(opened.dealBank, '');
  assert.deepEqual(expandedBanks, new Set(['boc']));
  const closed = accountToggle('toggle-bank', { expandedBanks, bankId: 'boc', dealBank: opened.dealBank });
  assert.deepEqual(closed.events, [
    { type: 'render', dealBank: '', banks: [] },
    { type: 'focus', selector: '[data-action="toggle-bank"][data-bank-id="boc"]', options: { preventScroll: true } },
  ]);
  assert.equal(closed.dealBank, '');
  assert.equal(expandedBanks.size, 0);
  const unknown = accountToggle('toggle-bank', { expandedBanks, bankId: 'unknown-bank' });
  assert.deepEqual(unknown.events, []);
  assert.equal(expandedBanks.size, 0);
});

test('toggle-all uses current DOM banks, expands mixed state and clears full state without dealing cards', () => {
  const expandedBanks = new Set(['boc', 'stale-bank']);
  const opened = accountToggle('toggle-all-banks', { expandedBanks, domBanks: ['boc', 'ccb'] });
  assert.deepEqual(expandedBanks, new Set(['boc', 'stale-bank', 'ccb']));
  assert.deepEqual(opened.events, [
    { type: 'render', dealBank: '', banks: ['boc', 'stale-bank', 'ccb'] },
    { type: 'focus', selector: '[data-action="toggle-all-banks"]', options: { preventScroll: true } },
  ]);
  assert.equal(opened.dealBank, '');
  const closed = accountToggle('toggle-all-banks', { expandedBanks, domBanks: ['boc', 'ccb'] });
  assert.equal(expandedBanks.size, 0);
  assert.deepEqual(closed.events, [
    { type: 'render', dealBank: '', banks: [] },
    { type: 'focus', selector: '[data-action="toggle-all-banks"]', options: { preventScroll: true } },
  ]);
  assert.equal(closed.dealBank, '');
});
