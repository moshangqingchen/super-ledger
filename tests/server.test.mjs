import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLedgerServer } from '../server.mjs';
import { makeEmptyState, localDate, MAX_MONEY, validateState } from '../engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function temporaryDirectory(t, beforeRemove = async () => {}) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'money-lab-server-test-'));
  t.after(async () => {
    await beforeRemove();
    const resolved = path.resolve(directory);
    const prefix = `${path.join(tempRoot, 'money-lab-server-test-')}`;
    assert.ok(resolved.startsWith(prefix) && path.dirname(resolved) === tempRoot, 'Only remove the test-owned temporary directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

async function startFixture(t, options = {}) {
  const fixture = {};
  const directory = temporaryDirectory(t, async () => { await fixture.close?.(); });
  const port = options.port ?? await availablePort();
  Object.assign(fixture, { directory, port, base: `http://127.0.0.1:${port}` });
  fixture.close = async () => {
    if (fixture.server?.listening) await new Promise(resolve => fixture.server.close(resolve));
    await tick();
  };
  fixture.start = async () => {
    fixture.server = await createLedgerServer({ port, dataDirectory: directory, authToken: options.authToken, now: options.now });
    await new Promise((resolve, reject) => {
      fixture.server.once('error', reject);
      fixture.server.listen(port, '127.0.0.1', resolve);
    });
    fixture.port = fixture.server.address().port;
    fixture.base = `http://127.0.0.1:${fixture.port}`;
  };
  await fixture.start();
  return fixture;
}

const readState = async fixture => {
  const response = await fetch(`${fixture.base}/api/state`, { headers: { Connection: 'close' } });
  assert.equal(response.status, 200);
  return response.json();
};
const send = (fixture, endpoint, body, method = 'POST') => fetch(`${fixture.base}${endpoint}`, {
  method, headers: { 'Content-Type': 'application/json', Origin: fixture.base, Connection: 'close' }, body: JSON.stringify(body),
});

test('first launch persists a completely empty personal ledger and restart does not add examples', async t => {
  const fixture = await startFixture(t);
  assert.deepEqual(await readState(fixture), makeEmptyState());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.directory, 'ledger.json'), 'utf8')), makeEmptyState());
  await fixture.close();
  await fixture.start();
  assert.deepEqual(await readState(fixture), makeEmptyState());
});

test('state writes persist across restart, preserve previous contents, and reject stale revisions', async t => {
  const fixture = await startFixture(t);
  const before = await readState(fixture);
  const changed = structuredClone(before);
  changed.settings.monthlyBudget = 123400;
  changed.accounts.push({ id: 'personal-cash', name: '我的现金', type: '现金', openingBalance: 250000, color: '#123456' });
  changed.transactions.push({ id: 'personal-expense', type: 'expense', amount: 2800, accountId: 'personal-cash', category: '餐饮美食', title: '自己的早餐记录', date: localDate(), note: '' });
  const response = await send(fixture, '/api/state', { state: changed, expectedRevision: before.revision }, 'PUT');
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.revision, before.revision + 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.directory, 'ledger.previous.json'), 'utf8')), before);
  const conflict = await send(fixture, '/api/state', { state: changed, expectedRevision: before.revision }, 'PUT');
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).currentRevision, saved.revision);
  await fixture.close();
  await fixture.start();
  assert.deepEqual(await readState(fixture), saved);
});

test('import validates first and keeps a durable backup through later edits', async t => {
  const fixture = await startFixture(t);
  const before = await readState(fixture);
  const invalid = structuredClone(before);
  invalid.transactions.push({ id: 'invalid' });
  assert.equal((await send(fixture, '/api/import', { state: invalid, expectedRevision: before.revision })).status, 400);
  assert.deepEqual(await readState(fixture), before);
  assert.equal(fs.readdirSync(fixture.directory).filter(file => file.startsWith('ledger.before-import.')).length, 0);
  const imported = structuredClone(before);
  imported.settings.monthlyBudget = 777700;
  const response = await send(fixture, '/api/import', { state: imported, expectedRevision: before.revision });
  assert.equal(response.status, 200);
  const saved = await response.json();
  const backupNames = fs.readdirSync(fixture.directory).filter(file => file.startsWith('ledger.before-import.'));
  assert.equal(backupNames.length, 1);
  const backup = path.join(fixture.directory, backupNames[0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), before);
  saved.settings.monthlyBudget = 888800;
  assert.equal((await send(fixture, '/api/state', { state: saved, expectedRevision: saved.revision }, 'PUT')).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), before);
  assert.equal((await send(fixture, '/api/import', { state: before, expectedRevision: before.revision })).status, 409);
});

test('local endpoints reject cross-site access and keep data and server source private', async t => {
  const fixture = await startFixture(t);
  assert.equal((await fetch(`${fixture.base}/api/state`, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${fixture.base}/api/state`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  for (const route of ['/data/ledger.json', '/server.mjs', '/tests/server.test.mjs', '/assets/%2e%2e%2fdata/ledger.json']) {
    assert.equal((await fetch(fixture.base + route)).status, 404, route);
  }
  assert.equal((await fetch(`${fixture.base}/engine.mjs`)).status, 200);
  assert.equal((await fetch(`${fixture.base}/api/state`, { method: 'PUT', body: '{}' })).status, 415);
  assert.equal((await fetch(`${fixture.base}/api/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  const exported = await fetch(`${fixture.base}/api/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(await exported.json(), await readState(fixture));
});

test('data directory lock spans ports, releases on close, and never removes an active PID lock', async t => {
  const fixture = await startFixture(t);
  const otherPort = await availablePort();
  await assert.rejects(createLedgerServer({ port: otherPort, dataDirectory: fixture.directory }), /已有账本实例/);
  await fixture.close();
  const lockFile = path.join(fixture.directory, 'ledger.lock.json');
  assert.equal(fs.existsSync(lockFile), false);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'active-test-process' }));
  await assert.rejects(createLedgerServer({ port: otherPort, dataDirectory: fixture.directory }), /仍运行/);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'active-test-process');
  fs.unlinkSync(lockFile);
  await tick();
  await fixture.start();
  assert.equal((await readState(fixture)).demo, false);
});

test('a real crashed process leaves a recoverable lock without losing its ledger', { timeout: 15000 }, async t => {
  let child;
  let recovered;
  const directory = temporaryDirectory(t, async () => {
    if (recovered?.listening) await new Promise(resolve => recovered.close(resolve));
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    await tick();
  });
  const port = await availablePort();
  const code = `import {createLedgerServer} from './server.mjs'; const server=await createLedgerServer({port:${port},dataDirectory:${JSON.stringify(directory)}}); server.listen(${port},'127.0.0.1',()=>console.log('READY'));`;
  child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let errors = '';
    const timeout = setTimeout(() => reject(new Error(`Child server startup timed out: ${errors}`)), 10000);
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', exitCode => { clearTimeout(timeout); reject(new Error(`Child exited ${exitCode}: ${errors}`)); });
    child.stdout.on('data', chunk => { if (String(chunk).includes('READY')) { clearTimeout(timeout); resolve(); } });
  });
  const original = JSON.parse(fs.readFileSync(path.join(directory, 'ledger.json'), 'utf8'));
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'ledger.lock.json'), 'utf8')).pid, child.pid);
  recovered = await createLedgerServer({ port, dataDirectory: directory });
  await new Promise(resolve => recovered.listen(port, '127.0.0.1', resolve));
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/state`)).json(), original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'ledger.lock.json'), 'utf8')).pid, process.pid);
  await new Promise(resolve => recovered.close(resolve));
  await tick();
  assert.equal(fs.existsSync(path.join(directory, 'ledger.lock.json')), false);
});

test('startup failures release locks and leave corrupt source files untouched', async t => {
  const running = await startFixture(t);
  const directory = temporaryDirectory(t);
  const blocked = await createLedgerServer({ port: running.port, dataDirectory: directory });
  await new Promise((resolve, reject) => {
    blocked.once('error', error => { if (error.code === 'EADDRINUSE') resolve(); else reject(error); });
    blocked.listen(running.port, '127.0.0.1');
  });
  await tick();
  assert.equal(fs.existsSync(path.join(directory, 'ledger.lock.json')), false);
  fs.writeFileSync(path.join(directory, 'ledger.json'), 'corrupt JSON preserved');
  await assert.rejects(createLedgerServer({ port: await availablePort(), dataDirectory: directory }), /未重置/);
  assert.equal(fs.existsSync(path.join(directory, 'ledger.lock.json')), false);
  assert.equal(fs.readFileSync(path.join(directory, 'ledger.json'), 'utf8'), 'corrupt JSON preserved');
});

test('reset empties accounts, budget and records while preserving the previous ledger', async t => {
  const fixture = await startFixture(t);
  const original = await readState(fixture);
  original.settings.monthlyBudget = 900000;
  original.accounts.push({ id: 'existing-cash', name: '原有钱包', type: '现金', openingBalance: 80000, color: '#123456' });
  const edited = await send(fixture, '/api/state', { state: original, expectedRevision: original.revision }, 'PUT');
  assert.equal(edited.status, 200);
  const before = await edited.json();
  const response = await send(fixture, '/api/reset', { mode: 'empty', expectedRevision: before.revision });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state, { ...makeEmptyState(), revision: before.revision + 1 });
  const names = fs.readdirSync(fixture.directory).filter(name => name.startsWith('ledger.before-reset.'));
  assert.equal(names.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.directory, names[0]), 'utf8')), before);
});

test('demonstration data is created only by an explicit demo request and existing demo data remains intact', async t => {
  const fixture = await startFixture(t);
  const before = await readState(fixture);
  assert.equal(before.demo, false);
  assert.equal(before.accounts.length, 0);
  const response = await send(fixture, '/api/reset', { mode: 'demo', expectedRevision: before.revision });
  assert.equal(response.status, 200);
  const demo = await response.json();
  assert.equal(demo.demo, true);
  assert.equal(demo.settings.monthlyBudget, 600000);
  assert.equal(demo.accounts.length, 4);
  assert.ok(demo.transactions.length > 0);
  assert.ok(demo.subscriptions.length > 0);
  assert.ok(demo.goals.length > 0);
  await fixture.close();
  await fixture.start();
  assert.deepEqual(await readState(fixture), demo);
});

test('import records due subscriptions once and later reads do not duplicate them', async t => {
  const fixture = await startFixture(t);
  const before = await readState(fixture);
  const today = localDate();
  const state = makeEmptyState();
  state.accounts = [{ id: 'cash', name: '现金', type: '现金', openingBalance: 100000, color: '#123456' }];
  state.subscriptions = [{ id: 'music', name: '音乐', amount: 1900, accountId: 'cash', category: '会员订阅', startDate: today, billingDay: Number(today.slice(-2)), recurring: true, active: true, color: '#123456', icon: 'music', processedOccurrences: [] }];
  const response = await send(fixture, '/api/import', { state, expectedRevision: before.revision });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.transactions.length, 1);
  assert.equal(saved.transactions[0].amount, 1900);
  assert.equal(saved.transactions[0].subscriptionId, 'music');
  assert.deepEqual(await readState(fixture), saved);
  await fixture.close();
  await fixture.start();
  assert.deepEqual(await readState(fixture), saved);
});

test('save, import and restart wait for the scheduled Beijing hour and preserve the hourly schema', async t => {
  for (const endpoint of ['/api/state', '/api/import']) {
    let current = new Date('2026-11-06T01:59:59.999Z');
    const fixture = await startFixture(t, { now: () => current });
    const before = await readState(fixture);
    const state = makeEmptyState();
    state.schemaVersion = 3;
    state.accounts = [{ id: 'cash', name: '现金', type: '现金', openingBalance: 100000, color: '#123456' }];
    state.subscriptions = [{ id: 'hourly', name: '按小时订阅', amount: 1900, accountId: 'cash', category: '会员订阅', startDate: '2026-11-06', startHour: 10, billingDay: 6, billingHour: 20, recurring: true, active: true, color: '#123456', icon: 'music', processedOccurrences: [] }];
    const response = await send(fixture, endpoint, { state, expectedRevision: before.revision }, endpoint === '/api/state' ? 'PUT' : 'POST');
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.schemaVersion, 3);
    assert.deepEqual(saved.transactions, [], '09:59 Beijing must not book a 10:00 charge');
    await fixture.close();
    await fixture.start();
    assert.deepEqual(await readState(fixture), saved, 'Restart must retain the unprocessed future hour');

    current = new Date('2026-11-06T02:00:00Z');
    const booked = await readState(fixture);
    assert.equal(booked.transactions.length, 1);
    assert.equal(booked.transactions[0].date, '2026-11-06');
    assert.deepEqual(await readState(fixture), booked, 'Repeated reconciliation must charge only once');

    current = new Date('2026-12-06T11:59:59Z');
    assert.equal((await readState(fixture)).transactions.length, 1, 'Following months must wait for billingHour');
    current = new Date('2026-12-06T12:00:00Z');
    const nextMonth = await readState(fixture);
    assert.equal(nextMonth.transactions.length, 2);
    assert.equal(nextMonth.transactions[1].date, '2026-12-06');
    assert.equal(nextMonth.schemaVersion, 3);
  }
});

test('opening a previously booked subscription repairs expiry once without charging again', async t => {
  let current = new Date('2026-11-07T02:00:00Z');
  const fixture = await startFixture(t, { now: () => current });
  await fixture.close();
  const state = makeEmptyState();
  state.schemaVersion = 3;
  state.accounts = [{ id: 'cash', name: '现金', type: '现金', openingBalance: 100000, color: '#123456' }];
  state.subscriptions = [{ id: 'member', name: '已扣会员', amount: 1900, accountId: 'cash', category: '会员订阅', startDate: '2026-11-07', startHour: 10, billingDay: 7, billingHour: 10, recurring: true, active: true, color: '#123456', icon: 'music', expiresOn: '2026-11-07', processedOccurrences: ['member:2026-11'] }];
  state.transactions = [{ id: 'rec_member_202611', type: 'expense', amount: 1900, accountId: 'cash', category: '会员订阅', title: '已扣会员', date: '2026-11-07', note: '订阅到期自动记账', subscriptionId: 'member', occurrenceKey: 'member:2026-11' }];
  fs.writeFileSync(path.join(fixture.directory, 'ledger.json'), JSON.stringify(state));
  await fixture.start();
  const repaired = await readState(fixture);
  assert.equal(repaired.subscriptions[0].expiresOn, '2026-12-07');
  assert.deepEqual(repaired.transactions, state.transactions, 'Expiry repair must preserve the already booked expense exactly');
  assert.deepEqual(await readState(fixture), repaired);
  await fixture.close();
  await fixture.start();
  assert.deepEqual(await readState(fixture), repaired, 'Restart must not extend a paid period twice');
  current = new Date('2026-12-07T01:59:59Z');
  assert.deepEqual(await readState(fixture), repaired);
  current = new Date('2026-12-07T02:00:00Z');
  const renewed = await readState(fixture);
  assert.equal(renewed.subscriptions[0].expiresOn, '2027-01-07');
  assert.equal(renewed.transactions.length, 2);
  assert.deepEqual(await readState(fixture), renewed);
});

async function blockedRecurringFixture(t) {
  const fixture = await startFixture(t);
  await fixture.close();
  const state = makeEmptyState();
  const today = localDate();
  state.accounts = [{ id: 'cash', name: '现金', type: '现金', openingBalance: -MAX_MONEY, color: '#123456' }];
  state.subscriptions = [{ id: 'fee', name: '到期订阅', amount: 1, accountId: 'cash', category: '会员订阅', startDate: today, billingDay: Number(today.slice(-2)), recurring: true, active: true, color: '#123456', icon: 'spark', processedOccurrences: [] }];
  assert.equal(validateState(state), true, 'The saved ledger remains valid before its next automatic debit');
  fs.writeFileSync(path.join(fixture.directory, 'ledger.json'), JSON.stringify(state));
  await fixture.start();
  return { fixture, state };
}

test('failed automatic bookings leave the ledger readable and exportable and allow pausing the failing subscription', async t => {
  const { fixture, state } = await blockedRecurringFixture(t);
  assert.deepEqual(await readState(fixture), state);
  const health = await (await fetch(`${fixture.base}/api/health`)).json();
  assert.equal(health.ready, true);
  assert.match(health.automaticBookingError, /账户累计余额/);
  const exported = await fetch(`${fixture.base}/api/export`);
  assert.equal(exported.status, 200);
  assert.deepEqual(await exported.json(), state, 'Operational errors must not enter the backup schema');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.directory, 'ledger.json'), 'utf8')), state);

  const repaired = structuredClone(state);
  repaired.subscriptions[0].active = false;
  const response = await send(fixture, '/api/state', { state: repaired, expectedRevision: state.revision }, 'PUT');
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.revision, state.revision + 1);
  assert.equal(saved.subscriptions[0].active, false);
  assert.deepEqual(saved.transactions, []);
  assert.deepEqual(saved.subscriptions[0].processedOccurrences, []);
  assert.deepEqual(await readState(fixture), saved);
  assert.equal((await (await fetch(`${fixture.base}/api/health`)).json()).automaticBookingError, '');

  const invalid = structuredClone(saved);
  invalid.subscriptions[0].active = true;
  for (const endpoint of ['/api/state', '/api/import']) {
    const rejected = await send(fixture, endpoint, { state: invalid, expectedRevision: saved.revision }, endpoint === '/api/state' ? 'PUT' : 'POST');
    assert.equal(rejected.status, 400, 'An unbookable candidate must return an actionable validation error');
    assert.match((await rejected.json()).error, /账户累计余额/);
    assert.deepEqual(await readState(fixture), saved);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.directory, 'ledger.json'), 'utf8')), saved);
    assert.equal((await (await fetch(`${fixture.base}/api/health`)).json()).automaticBookingError, '', 'A rejected candidate must not mark the saved ledger as blocked');
  }
});

test('a blocked automatic booking does not prevent explicit backup import or reset', async t => {
  for (const endpoint of ['/api/import', '/api/reset']) {
    const { fixture, state } = await blockedRecurringFixture(t);
    const body = endpoint === '/api/import'
      ? { state: makeEmptyState(), expectedRevision: state.revision }
      : { mode: 'empty', expectedRevision: state.revision };
    const response = await send(fixture, endpoint, body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...makeEmptyState(), revision: state.revision + 1 });
    assert.equal((await (await fetch(`${fixture.base}/api/health`)).json()).automaticBookingError, '');
    const prefix = endpoint === '/api/import' ? 'ledger.before-import.' : 'ledger.before-reset.';
    const backups = fs.readdirSync(fixture.directory).filter(name => name.startsWith(prefix));
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.directory, backups[0]), 'utf8')), state);
  }
});

test('desktop server uses an OS-selected port and updates its allowed origin to that port', async t => {
  const fixture = await startFixture(t, { port: 0 });
  assert.ok(fixture.port > 0);
  const healthResponse = await fetch(`${fixture.base}/api/health`, { headers: { Origin: fixture.base } });
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).port, fixture.port);
  assert.equal((await fetch(`${fixture.base}/api/state`, { headers: { Origin: `http://localhost:${fixture.port}` } })).status, 200);
  assert.equal((await fetch(`${fixture.base}/api/state`, { headers: { Origin: 'http://127.0.0.1:0' } })).status, 403);
  assert.equal((await fetch(`${fixture.base}/api/state`, { headers: { Origin: 'http://localhost:1' } })).status, 403);
});

test('desktop token protects every API while static assets remain available', async t => {
  const token = 'desktop-test-token-0123456789abcdef';
  const fixture = await startFixture(t, { port: 0, authToken: token });
  for (const route of ['/api/state', '/api/health', '/api/export']) {
    assert.equal((await fetch(fixture.base + route)).status, 403, `missing token: ${route}`);
    assert.equal((await fetch(fixture.base + route, { headers: { 'X-Ledger-Token': 'incorrect-token' } })).status, 403, `wrong token: ${route}`);
    assert.equal((await fetch(fixture.base + route, { headers: { Origin: fixture.base, 'X-Ledger-Token': token } })).status, 200, `valid token: ${route}`);
  }
  const state = await (await fetch(`${fixture.base}/api/state`, { headers: { 'X-Ledger-Token': token } })).json();
  const body = JSON.stringify({ state, expectedRevision: state.revision });
  assert.equal((await fetch(`${fixture.base}/api/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(`${fixture.base}/api/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Ledger-Token': token, Origin: fixture.base }, body })).status, 200);
  assert.equal((await fetch(`${fixture.base}/engine.mjs`)).status, 200);
  assert.equal((await fetch(`${fixture.base}/api/state`, { headers: { 'X-Ledger-Token': token, Origin: 'https://example.com' } })).status, 403);
});
