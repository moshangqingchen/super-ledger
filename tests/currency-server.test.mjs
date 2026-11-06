import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedgerServer } from '../server.mjs';
import { getBalances, getNetWorth, localDate, makeEmptyState, transactionCnyAmount } from '../engine.mjs';

async function fixture(t, initialState) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'money-lab-currency-test-'));
  let server;
  const result = {
    directory,
    async close() {
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => setImmediate(resolve));
    },
    async start() {
      server = await createLedgerServer({ port: 0, dataDirectory: directory });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      result.base = `http://127.0.0.1:${server.address().port}`;
    },
    async read(endpoint = '/api/state') {
      const response = await fetch(result.base + endpoint, { headers: { Connection: 'close' } });
      assert.equal(response.status, 200);
      return response.json();
    },
    async save(state) {
      return fetch(result.base + '/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: result.base, Connection: 'close' },
        body: JSON.stringify({ state, expectedRevision: state.revision }),
      });
    },
  };
  t.after(async () => {
    await result.close();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.join(tempRoot, 'money-lab-currency-test-')) && path.dirname(resolved) === tempRoot,
      'Only remove this test-owned temporary directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  if (initialState) fs.writeFileSync(path.join(directory, 'ledger.json'), JSON.stringify(initialState));
  await result.start();
  return result;
}

test('schema 2 preserves native transfer amounts and historical exchange rates through save, export, and restart', async t => {
  const app = await fixture(t);
  const state = await app.read();
  state.schemaVersion = 2;
  state.accounts = [
    { id: 'usd', name: 'Dollar account', type: '现金', currency: 'USD', cnyRate: '7.1', openingBalance: 10000, color: '#123456' },
    { id: 'cny', name: '人民币账户', type: '现金', currency: 'CNY', openingBalance: 50000, color: '#abcdef' },
  ];
  state.transactions = [
    { id: 'exchange', type: 'transfer', accountId: 'usd', currency: 'USD', cnyRate: '7.1', amount: 2500,
      toAccountId: 'cny', toCurrency: 'CNY', toAmount: 17500, category: '账户转账', title: '实际兑换到账', date: localDate(), note: '' },
    { id: 'purchase', type: 'expense', accountId: 'usd', currency: 'USD', cnyRate: '7.2', amount: 1000,
      category: '日常购物', title: '按支付时汇率记录', date: localDate(), note: '' },
  ];
  const response = await app.save(state);
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json();
  assert.equal(saved.schemaVersion, 2);
  assert.deepEqual({ ...getBalances(saved) }, { usd: 6500, cny: 67500 });
  assert.equal(getNetWorth(saved), 113650);
  assert.equal(transactionCnyAmount(saved.transactions[1], saved), 7200);
  assert.deepEqual(await app.read('/api/export'), saved);
  await app.close();
  await app.start();
  assert.deepEqual(await app.read(), saved);

  const invalid = structuredClone(saved);
  delete invalid.transactions[0].toAmount;
  assert.equal((await app.save(invalid)).status, 400);
  assert.deepEqual(await app.read(), saved, 'A rejected exchange must not alter the durable ledger');

  const revalued = structuredClone(saved);
  revalued.accounts[0].cnyRate = '7.4';
  const updatedResponse = await app.save(revalued);
  assert.equal(updatedResponse.status, 200, await updatedResponse.clone().text());
  const updated = await updatedResponse.json();
  assert.equal(getNetWorth(updated), 115600, 'Account revaluation uses the new rate');
  assert.equal(transactionCnyAmount(updated.transactions[1], updated), 7200, 'Historical spending retains its own rate');
  assert.deepEqual(updated.transactions, saved.transactions);
});

test('legacy schema 1 files with no currency metadata load and export as unchanged CNY records', async t => {
  const legacy = makeEmptyState();
  legacy.revision = 9;
  legacy.accounts = [
    { id: 'cash', name: '原有现金', type: '现金', openingBalance: 20000, color: '#123456' },
    { id: 'wallet', name: '原有钱包', type: '现金', openingBalance: 1000, color: '#abcdef' },
  ];
  legacy.transactions = [
    { id: 'old-transfer', type: 'transfer', accountId: 'cash', toAccountId: 'wallet', amount: 3000,
      category: '账户转账', title: '原有转账', date: localDate(), note: '' },
    { id: 'old-expense', type: 'expense', accountId: 'wallet', amount: 500,
      category: '餐饮美食', title: '原有早餐', date: localDate(), note: '' },
  ];
  const app = await fixture(t, legacy);
  const loaded = await app.read();
  assert.deepEqual(loaded, legacy);
  assert.deepEqual({ ...getBalances(loaded) }, { cash: 17000, wallet: 3500 });
  assert.equal(getNetWorth(loaded), 20500);
  assert.equal(transactionCnyAmount(loaded.transactions[1], loaded), 500);
  assert.deepEqual(await app.read('/api/export'), legacy);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app.directory, 'ledger.json'), 'utf8')), legacy);
});

test('due USD subscriptions snapshot the booking rate once and survive later rate changes and restarts', async t => {
  const app = await fixture(t);
  const state = await app.read();
  state.schemaVersion = 2;
  state.accounts = [{ id: 'usd', name: 'Dollar account', type: '现金', currency: 'USD', cnyRate: '6.8', openingBalance: 10000, color: '#123456' }];
  state.subscriptions = [{
    id: 'usd-membership', name: '外币会员', amount: 1000, currency: 'USD', accountId: 'usd', category: '会员订阅',
    startDate: localDate(), billingDay: Number(localDate().slice(8)), recurring: true, active: true,
    color: '#123456', icon: 'spark', processedOccurrences: [],
  }];
  const response = await app.save(state);
  assert.equal(response.status, 200, await response.clone().text());
  const booked = await response.json();
  assert.equal(booked.transactions.length, 1);
  assert.equal(booked.transactions[0].currency, 'USD');
  assert.equal(booked.transactions[0].cnyRate, '6.8');
  assert.equal(transactionCnyAmount(booked.transactions[0], booked), 6800);
  assert.deepEqual({ ...getBalances(booked) }, { usd: 9000 });
  assert.equal(getNetWorth(booked), 61200);
  const changed = structuredClone(booked);
  changed.accounts[0].cnyRate = '7.3';
  const changedResponse = await app.save(changed);
  assert.equal(changedResponse.status, 200, await changedResponse.clone().text());
  const saved = await changedResponse.json();
  await app.close();
  await app.start();
  assert.deepEqual(await app.read(), saved);
  assert.deepEqual(saved.transactions, booked.transactions, 'Reconciliation must not duplicate or reprice the completed bill');
  assert.equal(getNetWorth(saved), 65700);
});
