import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedgerServer } from '../server.mjs';
import { makeEmptyState, applyRecurring, nextSubscriptionDue, prepareSubscriptionEdit } from '../engine.mjs';

function initial(interval = 12) {
  const state = makeEmptyState();
  state.schemaVersion = 4;
  state.accounts = [{ id: 'cash', name: '测试现金', type: '现金', openingBalance: 100000, color: '#123456' }];
  state.subscriptions = [{ id: 'annual', name: '周期测试', amount: 100, accountId: 'cash', category: '会员订阅',
    startDate: '2024-01-31', billingDay: 31, recurring: true, active: true, color: '#123456', icon: 'repeat',
    expiresOn: '2024-01-31', processedOccurrences: [], ...(interval > 1 ? { intervalMonths: interval } : {}) }];
  return state;
}

async function fixture(t, state, now) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'schema4-server-test-'));
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('schema4-server-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(directory, 'ledger.json'), JSON.stringify(state));
  server = await createLedgerServer({ port: 0, dataDirectory: directory, onlineRates: false, now: () => new Date(now) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.ok(![4317, 4399].includes(server.address().port));
  return {
    directory,
    async read() { const response = await fetch(base + '/api/state', { headers: { Connection: 'close' } }); assert.equal(response.status, 200); return response.json(); },
    async write(state, importing = false) {
      return fetch(base + (importing ? '/api/import' : '/api/state'), { method: importing ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: base, Connection: 'close' },
        body: JSON.stringify({ state, expectedRevision: state.revision }),
      });
    },
  };
}

for (const preparedInRenderer of [false, true]) {
  test(`annual to monthly direct PUT avoids historic backfill and preserves earned expiry (renderer prepared: ${preparedInRenderer})`, async t => {
    const now = '2024-06-30T12:00:00Z';
    const app = await fixture(t, applyRecurring(initial(), '2024-01-31').state, now);
    const current = await app.read(), edited = structuredClone(current);
    delete edited.subscriptions[0].intervalMonths;
    if (preparedInRenderer) prepareSubscriptionEdit(current.subscriptions[0], edited.subscriptions[0], edited.transactions, new Date(now));
    const response = await app.write(edited);
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    assert.deepEqual(saved.transactions.map(tx => tx.date), ['2024-01-31', '2024-06-30']);
    assert.deepEqual(saved.subscriptions[0].processedOccurrences, ['annual:2024-01', 'annual:2024-02', 'annual:2024-03', 'annual:2024-04', 'annual:2024-05', 'annual:2024-06']);
    assert.equal(saved.subscriptions[0].expiresOn, '2025-02-28');
    assert.deepEqual(saved.subscriptions[0].expiryRenewal.renewedOccurrences, ['annual:2024-06']);
    assert.equal(nextSubscriptionDue(saved.subscriptions[0], new Date(now)), '2024-07-31');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app.directory, 'ledger.json'), 'utf8')), saved);
    assert.deepEqual(await app.read(), saved);
  });
}

test('monthly to annual direct PUT keeps off-grid markers and does not rescale prior expiry extensions', async t => {
  const app = await fixture(t, applyRecurring(initial(1), '2024-04-30').state, '2024-05-15T04:00:00Z');
  const state = await app.read(), previous = structuredClone(state.subscriptions[0]);
  state.subscriptions[0].intervalMonths = 12;
  const response = await app.write(state);
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json();
  assert.equal(saved.transactions.length, 4);
  assert.deepEqual(saved.subscriptions[0].processedOccurrences, previous.processedOccurrences);
  assert.equal(saved.subscriptions[0].expiresOn, previous.expiresOn);
  assert.equal(saved.subscriptions[0].expiresOn, '2024-05-31');
  assert.equal(nextSubscriptionDue(saved.subscriptions[0], '2024-05-15'), '2025-01-31');
});

test('cycle edit guard retains lower-schema and one-time interval rejection without durable mutations', async t => {
  const app = await fixture(t, applyRecurring(initial(), '2024-01-31').state, '2024-05-15T04:00:00Z');
  const current = await app.read();
  for (const mutation of [
    state => { state.schemaVersion = 3; state.subscriptions[0].intervalMonths = 3; },
    state => { state.schemaVersion = 3; state.subscriptions[0].intervalMonths = 1; },
    state => { state.subscriptions[0].intervalMonths = 3; state.subscriptions[0].recurring = false; },
    state => { state.subscriptions[0].intervalMonths = 13; },
  ]) {
    const edited = structuredClone(current);
    mutation(edited);
    const response = await app.write(edited);
    assert.equal(response.status, 400);
    const error = await response.json();
    assert.match(error.error, /版本 4|连续订阅|扣账周期/);
    assert.deepEqual(await app.read(), current);
  }
});

test('v1-v4 imports retain their schema and v4 fields; imported schedules retain intentional catch-up behavior', async t => {
  const app = await fixture(t, makeEmptyState(), '2024-05-15T04:00:00Z');
  for (const version of [1, 2, 3, 4]) {
    const incoming = makeEmptyState();
    incoming.schemaVersion = version;
    incoming.revision = (await app.read()).revision;
    if (version === 4) {
      incoming.settings.categoryBudgets = { 宠物: 10001 };
      incoming.settings.customCategories = { expense: ['宠物'], income: ['稿费'] };
      incoming.goals = [{ id: 'trip', name: '旅行', target: 50000, saved: 100, color: '#123456', deadline: '2025-02-28' }];
    }
    const response = await app.write(incoming, true);
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    assert.equal(saved.schemaVersion, version);
    assert.deepEqual(saved.settings, incoming.settings);
    assert.deepEqual(saved.goals, incoming.goals);
  }
  const incoming = initial(3);
  incoming.revision = (await app.read()).revision;
  const response = await app.write(incoming, true);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).transactions.map(tx => tx.date), ['2024-01-31', '2024-04-30']);
});
