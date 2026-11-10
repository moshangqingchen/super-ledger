import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { makeEmptyState, localDate, getBalances } from '../engine.mjs';
import { newSyncMetadata, mergeMobileOperations, encryptMessage, decryptMessage, isPrivateIPv4, networkChoices, createMobileSync } from '../mobile-sync.mjs';
import { createLedgerServer } from '../server.mjs';

function ledger() {
  return { ...makeEmptyState(), _mobileSync: newSyncMetadata(), accounts: [
    { id: 'wallet', name: '微信', type: '数字钱包', providerId: 'wechat', openingBalance: 100000, color: '#28b877' },
    { id: 'bank', name: '储蓄卡', type: '银行卡', lastFour: '1234', openingBalance: 500000, color: '#567abc' },
  ] };
}
function tx(extra = {}) { return { id: randomUUID(), type: 'expense', amount: 2800, currency: 'CNY', accountId: 'wallet', category: '餐饮美食', title: '午餐', date: localDate(), note: '', ...extra }; }
function capture(extra = {}) { return { sourcePackage: 'com.tencent.mm', sourceKey: randomUUID(), occurredAt: Date.now(), merchant: '餐厅', ...extra }; }
function put(transaction, base = null, extra = {}) { return { id: randomUUID(), kind: 'put', transaction, base, ...extra }; }
const deviceId = randomUUID();
function request(state, operations = [], extra = {}) { return { requestId: randomUUID(), deviceId, deviceName: '模拟 vivo X200 Ultra', bookId: state._mobileSync.bookId, operations, ...extra }; }

test('mobile merge adds, edits and deletes with durable exactly-once receipts including lost replies', () => {
  let state = ledger();
  const transaction = tx(), add = put(transaction);
  let result = mergeMobileOperations(state, request(state, [add]));
  state = result.next;
  assert.deepEqual(result.summary, { added: 1, updated: 0, deleted: 0, duplicates: 0 });
  assert.equal(getBalances(state).wallet, 97200);
  result = mergeMobileOperations(state, request(state, [add]));
  assert.equal(result.changed, false);
  const edited = { ...transaction, title: '工作午餐', amount: 3200 };
  result = mergeMobileOperations(state, request(state, [put(edited, transaction)])); state = result.next;
  assert.equal(result.summary.updated, 1);
  const remove = { id: randomUUID(), kind: 'delete', transactionId: transaction.id, base: edited };
  result = mergeMobileOperations(state, request(state, [remove])); state = result.next;
  assert.equal(result.summary.deleted, 1);
  assert.equal(getBalances(state).wallet, 100000);
  const replay = mergeMobileOperations(state, request(state, [add, remove]));
  assert.equal(replay.next.transactions.length, 0, 'replaying an old add must not resurrect a deleted payment');
  assert.deepEqual(replay.accepted, [add.id, remove.id]);
});

test('concurrent desktop edits are preserved, partial valid operations succeed and changed receipt content conflicts', () => {
  const state = ledger(), original = tx();
  state.transactions.push({ ...original, title: '电脑修改' });
  const conflict = put({ ...original, title: '手机修改' }, original), add = put(tx());
  let result = mergeMobileOperations(state, request(state, [conflict, add]));
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.next.transactions[0].title, '电脑修改');
  assert.deepEqual(result.accepted, [add.id]);
  assert.equal(state.transactions.length, 1, 'merge never mutates its input');
  const changed = { ...add, transaction: { ...add.transaction, amount: 9999 } };
  result = mergeMobileOperations(result.next, request(result.next, [changed]));
  assert.equal(result.accepted.length, 0);
  assert.match(result.conflicts[0].reason, /标识/);
});

test('cross-source and subscription matches require review, exact source retries dedupe and equal unrelated payments survive', () => {
  const state = ledger(), c = capture(), first = tx({ mobileCapture: c });
  state.transactions.push(first);
  let result = mergeMobileOperations(state, request(state, [put(tx({ mobileCapture: c }))]));
  assert.equal(result.summary.duplicates, 1);
  const second = tx({ accountId: 'bank', mobileCapture: capture({ sourcePackage: 'com.bank.mobile' }) });
  result = mergeMobileOperations(state, request(state, [put(second)]));
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].candidate.id, first.id);
  result = mergeMobileOperations(state, request(state, [put(second, null, { allowDuplicate: true })]));
  assert.equal(result.summary.added, 1);
  result = mergeMobileOperations(state, request(state, [put(tx({ mobileCapture: capture({ occurredAt: c.occurredAt + 180000 }) }))]));
  assert.equal(result.summary.added, 1);
  // A manually entered equal amount is a distinct user choice, not an automatic duplicate.
  result = mergeMobileOperations(state, request(state, [put(tx())]));
  assert.equal(result.summary.added, 1);
});

test('new phones first download accounts; different/restored books and invalid transactions cannot overwrite data', () => {
  const state = ledger();
  assert.equal(mergeMobileOperations(state, request(state, [], { bookId: null })).changed, false);
  assert.throws(() => mergeMobileOperations(state, request(state, [put(tx())], { bookId: null })), /另一份账本/);
  assert.throws(() => mergeMobileOperations(state, request(state, [], { bookId: randomUUID() })), /另一份账本/);
  const result = mergeMobileOperations(state, request(state, [put(tx({ accountId: 'deleted-account' })), put(tx({ amount: 1.25 }))]));
  assert.equal(result.accepted.length, 0);
  assert.equal(result.conflicts.length, 2);
  assert.equal(result.changed, false);
});

test('AES-GCM authenticates direction, session, key, ciphertext and tag; LAN selector rejects public/loopback/ambiguous hosts', () => {
  const key = randomBytes(32), sessionId = randomUUID(), content = { amount: 2800, title: '午餐' };
  const encrypted = encryptMessage(key, sessionId, 'request', content);
  assert.deepEqual(decryptMessage(key, sessionId, 'request', encrypted), content);
  assert.throws(() => decryptMessage(key, sessionId, 'response', encrypted), /校验失败/);
  assert.throws(() => decryptMessage(key, randomUUID(), 'request', encrypted), /校验失败/);
  assert.throws(() => decryptMessage(randomBytes(32), sessionId, 'request', encrypted), /校验失败/);
  const bytes = Buffer.from(encrypted.data, 'base64url'); bytes[0] ^= 1;
  assert.throws(() => decryptMessage(key, sessionId, 'request', { ...encrypted, data: bytes.toString('base64url') }), /校验失败/);
  for (const ip of ['10.1.2.3', '172.16.0.2', '172.31.255.1', '192.168.1.1']) assert.equal(isPrivateIPv4(ip), true);
  for (const ip of ['127.0.0.1', '8.8.8.8', '169.254.1.1', '172.32.0.1', '192.168.001.1', 'localhost', '::1', '192.168.1.999']) assert.equal(isPrivateIPv4(ip), false);
});

test('session expiry removes its endpoint and cancelling an in-flight start cannot leave a listener', async t => {
  const address = networkChoices().find(i => !i.virtual)?.address;
  if (!address) { t.skip('No local RFC1918 interface available'); return; }
  let now = 100000;
  const sync = createMobileSync({ ensureBook() {}, synchronize() {}, interfaces: () => [{ address, label: 'test' }], now: () => now, sessionMs: 1000 });
  t.after(() => sync.stop());
  const started = await sync.start(address);
  assert.equal(started.active, true);
  now += 1001;
  assert.equal(sync.status().active, false);
  assert.equal(sync.status().qrPayload, null);
  const pending = sync.start(address);
  sync.stop();
  await assert.rejects(pending, /取消/);
  assert.equal(sync.status().active, false);
});

async function fixture(t, options = {}) {
  const address = networkChoices().find(i => !i.virtual)?.address;
  if (!address) { t.skip('No local RFC1918 interface available'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'superledger-sync-test-'));
  let server;
  const close = async () => { if (server?.listening) { await new Promise(resolve => server.close(resolve)); await new Promise(resolve => setImmediate(resolve)); } };
  t.after(async () => {
    await close();
    const resolved = path.resolve(directory), parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(fs.realpathSync(resolved)), parent);
    assert.ok(path.basename(resolved).startsWith('superledger-sync-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const result = { address, directory, close };
  result.start = async () => {
    server = await createLedgerServer({ port: 0, dataDirectory: directory, onlineRates: false, authToken: 'test-token', now: options.now, mobileSyncOptions: { interfaces: () => [{ address, label: 'test' }] } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    result.base = `http://127.0.0.1:${server.address().port}`;
  };
  result.api = async (route, body, method = 'POST') => {
    const response = await fetch(result.base + route, { method: body === undefined ? 'GET' : method, headers: { 'X-Ledger-Token': 'test-token', 'Content-Type': 'application/json', Connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  result.pair = async () => {
    const start = await result.api('/api/mobile-sync/start', { address });
    assert.equal(start.status, 200);
    result.qr = JSON.parse(start.body.qrPayload);
    result.key = Buffer.from(result.qr.key, 'base64url');
  };
  result.sync = async payload => {
    const response = await fetch(result.qr.addresses[0] + '/sync/v1/' + result.qr.sessionId, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(encryptMessage(result.key, result.qr.sessionId, 'request', payload)) });
    const wire = await response.json();
    return { status: response.status, body: wire.iv ? decryptMessage(result.key, result.qr.sessionId, 'response', wire) : wire };
  };
  await result.start();
  return result;
}

test('encrypted hourly sync advertises support, blocks older phones and waits for the Beijing hour', async t => {
  let current = new Date('2026-11-06T01:59:59Z');
  const f = await fixture(t, { now: () => current });
  if (!f) return;
  let state = (await f.api('/api/state')).body;
  state.schemaVersion = 3;
  state.accounts = ledger().accounts;
  state.subscriptions = [{ id: 'hourly', name: '小时订阅', amount: 1200, accountId: 'wallet', category: '会员订阅', startDate: '2026-11-06', startHour: 10, billingDay: 6, billingHour: 18, recurring: true, active: true, color: '#123456', icon: 'music', processedOccurrences: [] }];
  assert.equal((await f.api('/api/state', { state, expectedRevision: state.revision }, 'PUT')).status, 200);
  await f.pair();
  assert.equal(f.qr.supportedSchemaVersion, 4);
  state = (await f.api('/api/state')).body;
  const oldPhone = await f.sync(request(state, [], { protocolVersion: 2 }));
  assert.equal(oldPhone.status, 409);
  assert.match(oldPhone.body.error, /升级手机/);

  const mobileRequest = request(state, [], { protocolVersion: 2, supportedSchemaVersion: 3 });
  const pending = await f.sync(mobileRequest);
  assert.equal(pending.status, 200);
  assert.equal(pending.body.state.schemaVersion, 3);
  assert.deepEqual(pending.body.state.transactions, []);
  current = new Date('2026-11-06T02:00:00Z');
  const due = await f.sync({ ...mobileRequest, requestId: randomUUID() });
  assert.equal(due.status, 200);
  assert.equal(due.body.state.transactions.length, 1);
  assert.equal(due.body.state.transactions[0].date, '2026-11-06');
  const repeated = await f.sync({ ...mobileRequest, requestId: randomUUID() });
  assert.equal(repeated.body.state.transactions.length, 1);
});

test('real local transport encrypts ledger, restricts routes, persists receipts across restart and protects imports', async t => {
  const f = await fixture(t); if (!f) return;
  let original = (await f.api('/api/state')).body;
  original.accounts = ledger().accounts;
  assert.equal((await f.api('/api/state', { state: original, expectedRevision: original.revision }, 'PUT')).status, 200);
  await f.pair();
  const initial = await f.sync({ requestId: randomUUID(), deviceId, bookId: null, operations: [] });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.state._mobileSync, undefined);
  const oldBook = initial.body.bookId;
  let state = (await f.api('/api/state')).body;
  const op = put(tx()), req = request(state, [op]);
  const response = await f.sync(req);
  assert.equal(response.status, 200); assert.equal(response.body.summary.added, 1);
  const failed = await fetch(f.qr.addresses[0] + '/api/state', { headers: { Connection: 'close' } });
  assert.equal(failed.status, 404);
  const tamper = encryptMessage(f.key, f.qr.sessionId, 'request', request(state));
  tamper.iv = randomBytes(12).toString('base64url');
  const denied = await fetch(f.qr.addresses[0] + '/sync/v1/' + f.qr.sessionId, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(tamper) });
  assert.equal(denied.status, 403);
  state = (await f.api('/api/state')).body;
  const receipts = structuredClone(state._mobileSync);
  delete state._mobileSync;
  const putResponse = await f.api('/api/state', { state, expectedRevision: state.revision }, 'PUT');
  assert.deepEqual(putResponse.body._mobileSync, receipts, 'whole-ledger UI writes cannot erase mobile receipts');
  await f.close(); await f.start(); await f.pair();
  const retry = await f.sync({ ...req, requestId: randomUUID() });
  assert.equal(retry.body.summary.duplicates, 1);
  assert.equal(retry.body.state.transactions.length, 1);
  state = (await f.api('/api/state')).body;
  assert.equal((await f.api('/api/import', { state, expectedRevision: state.revision })).status, 200);
  assert.equal((await f.api('/api/mobile-sync/status')).body.active, false);
  await f.pair();
  const mismatch = await f.sync({ ...req, requestId: randomUUID(), bookId: oldBook });
  assert.equal(mismatch.status, 409);
  assert.match(mismatch.body.error, /另一份账本/);
  await f.api('/api/mobile-sync/stop', {});
  assert.equal((await f.api('/api/mobile-sync/status')).body.active, false);
});

test('encrypted v4 sync rejects v3 phones and carries full settings and goal dates through import and restart', async t => {
  const f = await fixture(t, { now: () => new Date('2026-11-06T02:00:00Z') });
  if (!f) return;
  let state = (await f.api('/api/state')).body;
  state.schemaVersion = 4;
  state.accounts = ledger().accounts;
  state.settings = { ...state.settings, categoryBudgets: { 宠物: 15000 }, customCategories: { expense: ['宠物'], income: ['稿费'] },
    futurePreference: { keep: '未知字段原样往返' } };
  state.goals = [{ id: 'dated-goal', name: '旅行', target: 10000, saved: 100, color: '#123456', deadline: '2027-01-31' }];
  const saved = await f.api('/api/import', { state, expectedRevision: state.revision });
  assert.equal(saved.status, 200);
  await f.pair();
  assert.equal(f.qr.supportedSchemaVersion, 4);
  state = (await f.api('/api/state')).body;
  const oldPhone = await f.sync(request(state, [], { protocolVersion: 2, supportedSchemaVersion: 3 }));
  assert.equal(oldPhone.status, 409);
  assert.match(oldPhone.body.error, /版本 4.*升级手机/);
  const downloaded = await f.sync(request(state, [], { protocolVersion: 2, supportedSchemaVersion: 4 }));
  assert.equal(downloaded.status, 200);
  assert.deepEqual(downloaded.body.state.settings, state.settings);
  assert.deepEqual(downloaded.body.state.goals, state.goals);
  const record = { ...downloaded.body.state.settings, monthlyBudget: 80000 };
  const operation = { id: randomUUID(), entity: 'settings', kind: 'put', recordId: 'settings', record, base: downloaded.body.state.settings };
  const updated = await f.sync(request(state, [operation], { protocolVersion: 2, supportedSchemaVersion: 4 }));
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.state.settings, record);
  await f.close(); await f.start();
  const restarted = (await f.api('/api/state')).body;
  assert.deepEqual(restarted.settings, record);
  assert.equal(restarted.schemaVersion, 4);
  assert.equal(restarted.goals[0].deadline, '2027-01-31');
});
