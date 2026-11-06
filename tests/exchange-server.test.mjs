import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedgerServer } from '../server.mjs';
import { getNetWorth, localDate, makeEmptyState, transactionCnyAmount, validateState } from '../engine.mjs';

function foreignLedger() {
  return {
    ...makeEmptyState(), schemaVersion: 2,
    accounts: [{ id: 'usd', name: 'Dollar account', type: '现金', currency: 'USD', cnyRate: '7', openingBalance: 10000, color: '#123456' }],
    transactions: [{ id: 'historical', type: 'expense', accountId: 'usd', currency: 'USD', cnyRate: '6.8', amount: 1000,
      category: '日常购物', title: 'Historical exchange rate', date: localDate(), note: '' }],
  };
}

test('rate metadata permits legacy, automatic, and manual accounts without mutating historical snapshots', () => {
  for (const metadata of [{}, { rateMode: 'auto' }, { rateMode: 'manual', rateAsOf: '2026-11-05', rateSource: 'ECB' }]) {
    const state = foreignLedger();
    Object.assign(state.accounts[0], metadata);
    const before = structuredClone(state);
    assert.equal(validateState(state), true);
    assert.deepEqual(state, before);
    assert.equal(transactionCnyAmount(state.transactions[0], state), 6800);
  }
});

test('rate metadata rejects invalid modes, malformed dates, and unbounded or non-string provenance', () => {
  for (const metadata of [
    { rateMode: '' }, { rateMode: 'AUTO' }, { rateMode: true }, { rateMode: null },
    { rateAsOf: '2025-02-29' }, { rateAsOf: '2026-11-05T00:00:00Z' }, { rateAsOf: null },
    { rateSource: '' }, { rateSource: 'x'.repeat(121) }, { rateSource: {} }, { rateSource: '\u0000ECB' },
  ]) {
    const state = foreignLedger();
    Object.assign(state.accounts[0], metadata);
    assert.throws(() => validateState(state), /汇率/);
  }
});

function rateStub() {
  let current = {
    enabled: false, refreshing: false, lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null,
    rates: {}, errors: { fiat: null, usdt: null },
  };
  const service = {
    calls: 0, closed: false, response: null, beforeRefresh: null,
    status: () => structuredClone(current),
    enable: () => { current.enabled = true; },
    async refresh() {
      service.calls += 1;
      current.refreshing = true;
      await service.beforeRefresh?.();
      const timestamp = new Date().toISOString();
      current = { ...current, ...structuredClone(service.response || {}), refreshing: false, lastAttemptAt: timestamp };
      if (Object.keys(current.rates).length) current.lastSuccessAt = timestamp;
      return service.status();
    },
    close: () => { service.closed = true; },
  };
  return service;
}

const quote = cnyRate => ({ cnyRate, asOf: localDate(), source: 'ECB', fetchedAt: new Date().toISOString() });

async function fixture(t, state = foreignLedger()) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'money-lab-exchange-test-'));
  fs.writeFileSync(path.join(directory, 'ledger.json'), JSON.stringify(state));
  let server;
  const app = {
    directory,
    async close() {
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => setImmediate(resolve));
    },
    async start() {
      app.rates = rateStub();
      server = await createLedgerServer({ port: 0, dataDirectory: directory, rateService: app.rates });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      app.base = `http://127.0.0.1:${server.address().port}`;
      app.rates.enable();
    },
    async read(endpoint = '/api/state') {
      const response = await fetch(app.base + endpoint, { headers: { Connection: 'close' } });
      assert.equal(response.status, 200);
      return response.json();
    },
    async post(endpoint, body, method = 'POST') {
      const response = await fetch(app.base + endpoint, {
        method, headers: { 'Content-Type': 'application/json', Origin: app.base, Connection: 'close' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    },
  };
  t.after(async () => {
    await app.close();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.join(tempRoot, 'money-lab-exchange-test-')) && path.dirname(resolved) === tempRoot,
      'Only remove this test-owned temporary directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  await app.start();
  return app;
}

test('rate refresh updates automatic accounts atomically, retains manual rates and historical snapshots, and persists once', async t => {
  const initial = foreignLedger();
  initial.accounts.push(
    { id: 'manual', name: 'Manual dollars', type: '现金', currency: 'USD', cnyRate: '8', rateMode: 'manual', openingBalance: 1000, color: '#654321' },
    { id: 'yen', name: 'Yen account', type: '现金', currency: 'JPY', cnyRate: '0.04', rateMode: 'auto', openingBalance: 1000, color: '#abcdef' },
    { id: 'cash', name: '人民币账户', type: '现金', openingBalance: 1000, color: '#123abc' },
  );
  const app = await fixture(t, initial);
  const before = await app.read();
  app.rates.response = { rates: { USD: quote('7.2'), JPY: quote('0.045') } };
  const status = await app.post('/api/rates/refresh', {});
  assert.equal(status.rates.USD.cnyRate, '7.2');
  assert.ok(!status.applyError);
  const updated = await app.read();
  assert.equal(updated.revision, before.revision + 1);
  assert.equal(updated.accounts[0].cnyRate, '7.2', 'Foreign accounts missing rateMode opt into automatic updates');
  assert.equal(updated.accounts[0].rateAsOf, localDate());
  assert.equal(updated.accounts[0].rateSource, 'ECB');
  assert.equal(updated.accounts[2].cnyRate, '0.045');
  assert.deepEqual(updated.accounts[1], before.accounts[1]);
  assert.deepEqual(updated.accounts[3], before.accounts[3]);
  assert.deepEqual(updated.transactions, before.transactions);
  assert.equal(transactionCnyAmount(updated.transactions[0], updated), 6800);
  assert.equal(getNetWorth(updated), 78300);

  // A new fetch timestamp with an unchanged market quote must not create a ledger revision.
  app.rates.response = { rates: { USD: quote('7.2'), JPY: quote('0.045') } };
  await app.post('/api/rates/refresh', {});
  assert.deepEqual(await app.read(), updated);
  assert.equal(app.rates.calls, 2);
  assert.equal((await app.read('/api/rates')).rates.USD.cnyRate, '7.2');
  await app.close();
  assert.equal(app.rates.closed, true);
  await app.start();
  assert.deepEqual(await app.read(), updated);
});

test('a refresh finishing after a user edit applies to the latest ledger and respects switching to manual mode', async t => {
  const initial = foreignLedger();
  initial.accounts.push({ id: 'yen', name: 'Yen account', type: '现金', currency: 'JPY', cnyRate: '0.04', openingBalance: 1000, color: '#abcdef' });
  const app = await fixture(t, initial);
  let release, announce;
  const started = new Promise(resolve => { announce = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  app.rates.response = { rates: { USD: quote('7.2'), JPY: quote('0.045') } };
  app.rates.beforeRefresh = async () => { announce(); await barrier; };
  const refreshing = app.post('/api/rates/refresh', {});
  await started;
  try {
    const edited = await app.read();
    edited.accounts[0].rateMode = 'manual';
    edited.accounts[0].cnyRate = '8';
    edited.transactions[0].title = 'Edited while the request was pending';
    const saved = await app.post('/api/state', { state: edited, expectedRevision: edited.revision }, 'PUT');
    release();
    await refreshing;
    const after = await app.read();
    assert.equal(after.revision, saved.revision + 1);
    assert.deepEqual(after.accounts[0], saved.accounts[0]);
    assert.deepEqual(after.transactions, saved.transactions);
    assert.equal(after.accounts[1].cnyRate, '0.045');
  } finally {
    release();
    await refreshing;
  }
});

test('an exchange-rate overflow rejects the entire ledger update while keeping downloaded quote status available', async t => {
  const initial = foreignLedger();
  initial.accounts[0].openingBalance = 1_000_000_000_000;
  initial.accounts[0].cnyRate = '1';
  initial.accounts.push({ id: 'eur', name: 'Euro account', type: '现金', currency: 'EUR', cnyRate: '1', openingBalance: 0, color: '#abcdef' });
  const app = await fixture(t, initial);
  const before = await app.read();
  const diskBefore = fs.readFileSync(path.join(app.directory, 'ledger.json'), 'utf8');
  app.rates.response = { rates: { USD: quote('2'), EUR: quote('8') } };
  const status = await app.post('/api/rates/refresh', {});
  assert.equal(typeof status.applyError, 'string');
  assert.ok(status.applyError.length > 0);
  assert.equal(status.rates.USD.cnyRate, '2');
  assert.deepEqual(await app.read(), before);
  assert.equal(fs.readFileSync(path.join(app.directory, 'ledger.json'), 'utf8'), diskBefore);
});

test('a failed refresh exposes its error without replacing saved rates or recording a new revision', async t => {
  const app = await fixture(t);
  const before = await app.read();
  app.rates.response = { rates: {}, errors: { fiat: 'Proxy unavailable', usdt: null } };
  const status = await app.post('/api/rates/refresh', {});
  assert.equal(status.errors.fiat, 'Proxy unavailable');
  assert.deepEqual(await app.read(), before);
  const invalid = await fetch(app.base + '/api/rates/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.base, Connection: 'close' }, body: '{',
  });
  assert.equal(invalid.status, 400);
  assert.equal(app.rates.calls, 1, 'Malformed requests must not trigger a rate request');
});

test('editing an automatic account without quote metadata cannot replace a newer stored rate with an older cache', async t => {
  const initial = foreignLedger();
  Object.assign(initial.accounts[0], { rateMode: 'auto', cnyRate: '7.4', rateAsOf: '2026-11-05', rateSource: 'ECB' });
  const app = await fixture(t, initial);
  const before = await app.read();
  app.rates.response = { rates: { USD: { ...quote('7.1'), asOf: '2026-11-04' } } };
  await app.post('/api/rates/refresh', {});
  assert.deepEqual(await app.read(), before, 'An older market date must not change the existing account');

  const renamed = structuredClone(before);
  renamed.accounts[0].name = 'Renamed after viewing an older cached quote';
  renamed.accounts[0].cnyRate = '7.1';
  delete renamed.accounts[0].rateAsOf;
  delete renamed.accounts[0].rateSource;
  const saved = await app.post('/api/state', { state: renamed, expectedRevision: renamed.revision }, 'PUT');
  assert.equal(saved.revision, before.revision + 1);
  assert.equal(saved.accounts[0].name, renamed.accounts[0].name);
  assert.equal(saved.accounts[0].cnyRate, '7.4');
  assert.equal(saved.accounts[0].rateAsOf, '2026-11-05');
  assert.equal(saved.accounts[0].rateSource, 'ECB');
  assert.deepEqual(saved.transactions, before.transactions);

  const manual = structuredClone(saved);
  Object.assign(manual.accounts[0], { rateMode: 'manual', cnyRate: '8.25' });
  delete manual.accounts[0].rateAsOf;
  delete manual.accounts[0].rateSource;
  const manualSaved = await app.post('/api/state', { state: manual, expectedRevision: manual.revision }, 'PUT');
  assert.equal(manualSaved.accounts[0].cnyRate, '8.25', 'Explicit manual input must take precedence over both cached and stored automatic quotes');
  assert.equal(manualSaved.accounts[0].rateMode, 'manual');
  assert.equal(Object.hasOwn(manualSaved.accounts[0], 'rateAsOf'), false);
  assert.equal(Object.hasOwn(manualSaved.accounts[0], 'rateSource'), false);
  assert.deepEqual(manualSaved.transactions, before.transactions);
  await app.close();
  await app.start();
  assert.deepEqual(await app.read(), manualSaved);
});
