import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currencyCatalog, currencyInfo, accountCurrency, parseMoney, amountInput,
  formatMoney, formatAmount, normalizeRate, currencyRate, toCnyCents,
} from '../currencies.mjs';
import {
  makeEmptyState, validateState, getBalances, getCnyBalances, getNetWorth,
  transactionCnyAmount, applyRecurring, moneyToCents,
} from '../engine.mjs';

function account(id, currency, balance, rate) {
  return {
    id, name: id, type: '虚拟卡', providerId: 'virtual-card', color: '#6651eb',
    openingBalance: parseMoney(balance, currency), currency,
    ...(rate === undefined ? {} : { cnyRate: rate }),
  };
}

function tx(id, accountId, type, amount, extra = {}) {
  return { id, accountId, type, amount, category: type === 'transfer' ? '账户转账' : '其他支出', title: id, date: '2026-11-05', note: '', ...extra };
}

function mixedFixture() {
  const state = makeEmptyState();
  state.schemaVersion = 2;
  state.accounts = [
    account('cny', 'CNY', '1000.25'),
    account('usd', 'USD', '100.10', '7.25'),
    account('jpy', 'JPY', '10000', '0.048'),
    account('usdt', 'USDT', '2.123456', '7.1'),
  ];
  return state;
}

test('currency parsing preserves exact native precision and refuses silent rounding', () => {
  assert.deepEqual(currencyCatalog.map(c => c.code), ['CNY', 'USD', 'USDT', 'JPY', 'EUR', 'HKD', 'GBP', 'KRW', 'SGD', 'AUD', 'CAD', 'CHF', 'TRY']);
  assert.equal(accountCurrency({}), 'CNY');
  assert.equal(parseMoney('0.29', 'USD'), 29);
  assert.equal(parseMoney('-0', 'CNY'), 0);
  assert.equal(parseMoney('12000', 'JPY'), 12000);
  assert.equal(parseMoney('12000', 'KRW'), 12000);
  assert.equal(parseMoney('2.123456', 'USDT'), 2123456);
  assert.equal(parseMoney('0.000001', 'USDT'), 1);
  assert.equal(parseMoney('-2.123456', 'USDT'), -2123456);
  assert.equal(moneyToCents('12.34'), parseMoney('12.34', 'CNY'));
  for (const [value, code] of [['1.001', 'USD'], ['1.0', 'JPY'], ['1.1', 'KRW'], ['1.0000001', 'USDT'], ['1e3', 'USD'], ['1,000', 'JPY'], ['Infinity', 'USD'], [null, 'CNY'], [NaN, 'USD'], ['1000000.000001', 'USDT']]) {
    assert.throws(() => parseMoney(value, code));
  }
  for (const code of ['usd', 'USTD', '', null, 123]) assert.throws(() => currencyInfo(code));
});

test('Turkish lira keeps two decimal places and converts account balances exactly', () => {
  assert.deepEqual(currencyInfo('TRY'), { code: 'TRY', name: '土耳其里拉', symbol: '₺', decimals: 2 });
  assert.equal(parseMoney('100.25', 'TRY'), 10025);
  assert.equal(amountInput(10025, 'TRY'), '100.25');
  assert.equal(formatMoney(10025, 'TRY'), 'TRY 100.25');
  assert.throws(() => parseMoney('100.251', 'TRY'), /2 位小数/);
  const state = makeEmptyState();
  state.schemaVersion = 2;
  state.accounts = [account('turkey', 'TRY', '100.25', '0.15')];
  assert.equal(validateState(state), true);
  assert.equal(getBalances(state).turkey, 10025);
  assert.equal(getNetWorth(state), 1504);
});

test('editable and displayed values preserve their denomination and never show JPY as CNY', () => {
  assert.equal(amountInput(1234567, 'USD'), '12345.67');
  assert.equal(amountInput(1234500, 'USDT'), '1.2345');
  assert.equal(amountInput(-100, 'CNY'), '-1');
  assert.equal(formatAmount(1234500, 'USD'), '12,345.00');
  assert.equal(formatAmount(1234500, 'USD', { grouping: false }), '12345.00');
  assert.equal(formatMoney(123, 'CNY'), '¥ 1.23');
  assert.equal(formatMoney(123, 'USD'), 'USD 1.23');
  assert.equal(formatMoney(123, 'HKD'), 'HKD 1.23');
  assert.equal(formatMoney(12345, 'JPY'), 'JPY 12,345');
  assert.equal(formatMoney(1234500, 'USDT'), 'USDT 1.2345');
});

test('manual exchange rates are strict, required for foreign currency, and normalized exactly', () => {
  assert.equal(currencyRate({}), '1');
  assert.equal(currencyRate({ currency: 'CNY', cnyRate: '1.00000000' }), '1');
  assert.equal(currencyRate({ currency: 'USD', cnyRate: ' 007.25000000 ' }), '7.25');
  assert.equal(normalizeRate('0.00000001'), '0.00000001');
  assert.equal(normalizeRate('1000000.00000000'), '1000000');
  for (const value of [undefined, null, 7.25, '', '0', '-1', '1e2', '1,000', '0.000000001', '1000000.01', 'Infinity']) {
    assert.throws(() => currencyRate({ currency: 'USD', cnyRate: value }));
  }
  assert.throws(() => currencyRate({ currency: 'CNY', cnyRate: '7.2' }));
  assert.throws(() => currencyRate({ currency: 'JPY' }));
});

test('CNY conversion rounds once with decimal-exact half-away-from-zero arithmetic', () => {
  assert.equal(toCnyCents(10010, 'USD', '7.25'), 72573);
  assert.equal(toCnyCents(-10010, 'USD', '7.25'), -72573);
  assert.equal(toCnyCents(10000, 'JPY', '0.048'), 48000);
  assert.equal(toCnyCents(2123456, 'USDT', '7.1'), 1508);
  assert.equal(toCnyCents(1, 'JPY', '0.005'), 1);
  assert.equal(toCnyCents(-1, 'JPY', '0.005'), -1);
  assert.equal(toCnyCents(1, 'JPY', '0.00499999'), 0);
  assert.equal(toCnyCents(1, 'USDT', '0.00000001'), 0);
  assert.throws(() => toCnyCents(1, 'USD'));
  assert.throws(() => toCnyCents(1_000_000_000_000, 'JPY', '1'));
});

test('mixed balances stay in native units while net worth uses separately converted CNY cents', () => {
  const state = mixedFixture();
  assert.equal(validateState(state), true);
  assert.deepEqual({ ...getBalances(state) }, { cny: 100025, usd: 10010, jpy: 10000, usdt: 2123456 });
  assert.deepEqual({ ...getCnyBalances(state) }, { cny: 100025, usd: 72573, jpy: 48000, usdt: 1508 });
  assert.equal(getNetWorth(state), 222106);
  assert.notEqual(Object.values(getBalances(state)).reduce((a, b) => a + b, 0), getNetWorth(state));
});

test('cross-currency transfers require a real received amount and update both native balances', () => {
  const state = mixedFixture();
  state.transactions.push(tx('usd_to_jpy', 'usd', 'transfer', 1000, { currency: 'USD', cnyRate: '7.25', toAccountId: 'jpy', toCurrency: 'JPY', toAmount: 1510 }));
  assert.equal(validateState(state), true);
  const balances = getBalances(state);
  assert.equal(balances.usd, 9010);
  assert.equal(balances.jpy, 11510);
  assert.equal(transactionCnyAmount(state.transactions[0], state), 7250);
  assert.equal(state.transactions.filter(t => t.type === 'income' || t.type === 'expense').length, 0);
  assert.equal(getBalances(state, '2026-11-04').usd, 10010);
  assert.equal(getBalances(state, '2026-11-04').jpy, 10000);
  const missing = structuredClone(state); delete missing.transactions[0].toAmount;
  assert.throws(() => validateState(missing), /实际到账金额/);
  const denomination = structuredClone(state); delete denomination.transactions[0].toCurrency;
  assert.throws(() => validateState(denomination), /转入金额币种/);
  for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    const invalid = structuredClone(state); invalid.transactions[0].toAmount = amount;
    assert.throws(() => validateState(invalid));
  }
});

test('same-currency transfers preserve native wealth and cannot hide transfer fees', () => {
  const state = makeEmptyState();
  state.schemaVersion = 2;
  state.accounts = [account('one', 'USDT', '1.234567', '7'), account('two', 'USDT', '2', '7')];
  state.transactions = [tx('move', 'one', 'transfer', 123456, { currency: 'USDT', cnyRate: '7', toCurrency: 'USDT', toAccountId: 'two' })];
  assert.equal(validateState(state), true);
  assert.equal(getBalances(state).one, 1111111);
  assert.equal(getBalances(state).two, 2123456);
  const before = getNetWorth({ ...state, transactions: [] });
  assert.ok(Math.abs(getNetWorth(state) - before) <= 1, 'independent per-account CNY rounding can differ by at most one cent');
  state.transactions[0].toAmount = 123456;
  assert.equal(validateState(state), true);
  state.transactions[0].toAmount = 123455;
  assert.throws(() => validateState(state), /相同币种/);
});

test('account valuation rate changes leave original transaction snapshots and reports unchanged', () => {
  const state = makeEmptyState();
  state.schemaVersion = 2;
  state.accounts = [account('usd', 'USD', '100', '7')];
  state.transactions = [tx('coffee', 'usd', 'expense', 123, { currency: 'USD', cnyRate: '7' })];
  assert.equal(validateState(state), true);
  assert.equal(transactionCnyAmount(state.transactions[0], state), 861);
  assert.equal(getNetWorth(state), 69139);
  state.accounts[0].cnyRate = '8';
  assert.equal(validateState(state), true);
  assert.equal(getNetWorth(state), 79016);
  assert.equal(transactionCnyAmount(state.transactions[0], state), 861);
  delete state.transactions[0].cnyRate;
  assert.throws(() => validateState(state), /汇率/);
});

test('legacy currency defaults remain CNY and historical account denomination changes are rejected', () => {
  const state = makeEmptyState();
  state.accounts = [{ id: 'old', name: '旧账户', type: '银行卡', color: '#000000', openingBalance: 10000 }];
  state.transactions = [tx('old_tx', 'old', 'expense', 123)];
  const json = JSON.stringify(state);
  assert.equal(validateState(state), true);
  assert.equal(getNetWorth(state), 9877);
  assert.equal(transactionCnyAmount(state.transactions[0], state), 123);
  assert.equal(JSON.stringify(state), json, 'validation and valuation must not mutate old backups');
  const restored = JSON.parse(json);
  assert.equal(validateState(restored), true);
  restored.accounts[0].currency = 'JPY'; restored.accounts[0].cnyRate = '0.05';
  restored.schemaVersion = 2;
  assert.throws(() => validateState(restored), /已有账单账户/);
  restored.transactions = [];
  assert.equal(validateState(restored), true);
});

test('foreign subscriptions debit native units and snapshot each booking rate exactly once', () => {
  const state = makeEmptyState();
  state.schemaVersion = 2;
  state.accounts = [account('usd', 'USD', '100', '7.1')];
  state.subscriptions = [{ id: 'gpt', name: 'ChatGPT', amount: 2000, currency: 'USD', accountId: 'usd', category: '会员订阅', startDate: '2026-10-05', billingDay: 5, recurring: true, active: true, color: '#6651eb', icon: 'spark', processedOccurrences: [] }];
  const oct = applyRecurring(state, '2026-10-05');
  assert.equal(oct.added.length, 1);
  assert.equal(oct.added[0].currency, 'USD');
  assert.equal(oct.added[0].cnyRate, '7.1');
  assert.equal(getBalances(oct.state).usd, 8000);
  assert.equal(transactionCnyAmount(oct.added[0], oct.state), 14200);
  oct.state.accounts[0].cnyRate = '7.2';
  const nov = applyRecurring(oct.state, '2026-11-05');
  assert.equal(nov.added.length, 1);
  assert.equal(nov.added[0].cnyRate, '7.2');
  assert.equal(nov.state.transactions[0].cnyRate, '7.1');
  assert.equal(getBalances(nov.state).usd, 6000);
  assert.equal(applyRecurring(nov.state, '2026-11-05').added.length, 0);
  const restored = JSON.parse(JSON.stringify(nov.state));
  assert.equal(validateState(restored), true);
  assert.deepEqual(getBalances(restored), getBalances(nov.state));
  delete restored.subscriptions[0].currency;
  assert.throws(() => validateState(restored), /订阅币种/);
});

test('mixed aggregate limits are applied after conversion, never by adding unrelated units', () => {
  const state = makeEmptyState();
  state.schemaVersion = 2;
  state.accounts = [account('usdt', 'USDT', '1000000', '1'), account('jpy', 'JPY', '100000000', '0.01')];
  assert.equal(validateState(state), true);
  assert.equal(getNetWorth(state), 200000000);
  assert.equal(getBalances(state).usdt, 1000000000000);
  const invalid = mixedFixture();
  invalid.accounts[1].cnyRate = '1000000';
  invalid.accounts[1].openingBalance = 100000000;
  assert.throws(() => validateState(invalid), /折算金额/);
});

test('foreign ledgers require a newer schema so older CNY-only apps fail closed', () => {
  const state = mixedFixture();
  state.schemaVersion = 1;
  assert.throws(() => validateState(state), /版本 2/);
  state.schemaVersion = 2;
  assert.equal(validateState(state), true);
  const cnyOnly = makeEmptyState();
  assert.equal(validateState(cnyOnly), true);
  cnyOnly.schemaVersion = 2;
  assert.equal(validateState(cnyOnly), true, 'removing the last foreign account need not downgrade the ledger');
  cnyOnly.schemaVersion = 3;
  assert.equal(validateState(cnyOnly), true, 'hourly schedules use schema 3 and retain currency support');
  cnyOnly.schemaVersion = 4;
  assert.throws(() => validateState(cnyOnly), /版本/);
});

test('historical report totals are bounded in converted CNY even when income and expense cancel', () => {
  const state = makeEmptyState();
  state.schemaVersion = 2;
  state.accounts = [account('usd', 'USD', '0', '1')];
  state.transactions = [
    tx('in_one', 'usd', 'income', 500000000000, { currency: 'USD', cnyRate: '1' }),
    tx('out_one', 'usd', 'expense', 500000000000, { currency: 'USD', cnyRate: '1' }),
    tx('in_two', 'usd', 'income', 500000000000, { currency: 'USD', cnyRate: '1' }),
    tx('out_two', 'usd', 'expense', 500000000000, { currency: 'USD', cnyRate: '1' }),
  ];
  assert.equal(validateState(state), true);
  assert.equal(getNetWorth(state), 0);
  state.transactions.push(tx('in_three', 'usd', 'income', 1, { currency: 'USD', cnyRate: '1' }));
  assert.throws(() => validateState(state), /累计收支/);
});

test('future subscription conversions and combined annual estimates stay within supported limits', () => {
  const state = makeEmptyState();
  state.schemaVersion = 2;
  state.accounts = [account('usd', 'USD', '0', '1000000')];
  const subscription = (id, amount, extra = {}) => ({
    id, name: id, amount, currency: 'USD', accountId: 'usd', category: '会员订阅',
    startDate: '2199-01-01', billingDay: 1, recurring: true, active: true,
    color: '#6651eb', icon: 'spark', processedOccurrences: [], ...extra,
  });
  state.subscriptions = [subscription('future', 1000000000000)];
  assert.throws(() => validateState(state), /折算金额/, 'a future start date must not defer conversion validation');
  state.subscriptions[0].active = false;
  assert.throws(() => validateState(state), /折算金额/, 'paused fees also need a representable individual valuation');
  state.accounts[0].cnyRate = '2';
  state.subscriptions = [subscription('one', 20833333333), subscription('two', 20833333333)];
  assert.equal(validateState(state), true);
  const monthly = state.subscriptions.reduce((total, sub) => total + toCnyCents(sub.amount, sub.currency, '2'), 0);
  assert.equal(monthly * 12, 999999999984);
  state.subscriptions[1].amount += 1;
  assert.throws(() => validateState(state), /年度预估/, 'individually valid fees can overflow their combined annual estimate');
  state.subscriptions[1].active = false;
  assert.equal(validateState(state), true, 'paused fees are excluded from the recurring estimate');
  state.subscriptions[1].active = true;
  state.subscriptions[1].recurring = false;
  assert.equal(validateState(state), true, 'one-time fees are excluded from the recurring estimate');
  state.subscriptions[1].recurring = true;
  state.subscriptions[1].amount -= 1;
  state.accounts[0].cnyRate = '3';
  assert.throws(() => validateState(state), /年度预估/, 'current valuation rate edits must preserve representable annual estimates');
});
