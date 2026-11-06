import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { createRateService, proxyJson, FIAT_CODES, FIAT_URL, USDT_URL, RATE_CACHE_FILENAME } from '../exchange-rates.mjs';

function fixture(t, options = {}) {
  const prefix = path.join(os.tmpdir(), 'superledger-rates-');
  const directory = fs.mkdtempSync(prefix);
  let instant = new Date('2026-11-05T18:00:00.000Z');
  const calls = [];
  let handler = url => url === FIAT_URL ? fiat() : kraken();
  const service = createRateService({
    dataDirectory: directory, now: () => instant,
    requestJson: (url, requestOptions) => { calls.push(url); return handler(url, requestOptions); }, ...options,
  });
  t.after(() => {
    service.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)), 'only the test-owned temporary directory may be removed');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { service, directory, calls, setHandler: next => { handler = next; }, setTime: next => { instant = new Date(next); }, now: () => instant };
}
function fiat(date = '2026-11-05') {
  return FIAT_CODES.map(quote => ({ date, base: 'CNY', quote, rate: quote === 'USD' ? 0.14 : quote === 'JPY' ? 22 : quote === 'TRY' ? 5 : 1 }));
}
function kraken(price = '0.99844000') { return { error: [], result: { USDTZUSD: { c: [price, '100'] } } }; }

test('daily rates invert ECB quotes exactly and cross USDT market price without assuming dollar parity', async t => {
  const f = fixture(t);
  assert.equal(f.calls.length, 0, 'constructing the service never requests the network');
  const state = await f.service.refresh();
  assert.deepEqual(f.calls, [FIAT_URL, USDT_URL]);
  assert.equal(state.rates.USD.cnyRate, '7.14285714');
  assert.equal(state.rates.JPY.cnyRate, '0.04545455');
  assert.equal(state.rates.TRY.cnyRate, '0.2');
  assert.equal(state.rates.USDT.cnyRate, '7.13171429');
  assert.notEqual(state.rates.USDT.cnyRate, state.rates.USD.cnyRate);
  assert.equal(state.rates.USDT.source, 'Kraken × ECB');
  assert.equal(state.rates.USDT.fiatAsOf, '2026-11-05');
  assert.deepEqual(state.errors, { fiat: null, usdt: null });
  assert.equal(state.refreshing, false);
  assert.ok(new Date(state.nextAttemptAt) > f.now());
  await f.service.refresh();
  assert.equal(f.calls.length, 2, 'same-day automatic reads reuse the successful cache');
  state.rates.USD.cnyRate = '99';
  assert.equal(f.service.status().rates.USD.cnyRate, '7.14285714', 'status is a detached snapshot');
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, RATE_CACHE_FILENAME), 'utf8'));
  assert.equal(saved.rates.USDT.cnyRate, '7.13171429');
  assert.equal(fs.existsSync(path.join(f.directory, 'ledger.json')), false);
  const restored = createRateService({ dataDirectory: f.directory, now: f.now, requestJson: () => { throw new Error('cache should suppress a same-day request'); } });
  t.after(() => restored.close());
  assert.equal((await restored.refresh()).rates.JPY.cnyRate, '0.04545455');
  f.setTime(state.nextAttemptAt);
  await f.service.refresh();
  assert.equal(f.calls.length, 4, 'the next local day permits another automatic fetch');
});

test('a pre-TRY cache refreshes on upgrade even when its same-day deadline has not elapsed', async t => {
  const f = fixture(t);
  await f.service.refresh();
  const file = path.join(f.directory, RATE_CACHE_FILENAME);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.rates.TRY;
  fs.writeFileSync(file, JSON.stringify(saved));
  f.setTime('2026-11-05T18:01:00.000Z');
  const calls = [];
  const upgraded = createRateService({ dataDirectory: f.directory, now: f.now, requestJson: url => {
    calls.push(url);
    return url === FIAT_URL ? fiat() : kraken();
  } });
  t.after(() => upgraded.close());
  assert.equal(upgraded.status().nextAttemptAt, null);
  const state = await upgraded.refresh();
  assert.deepEqual(calls, [FIAT_URL, USDT_URL]);
  assert.equal(state.rates.TRY.cnyRate, '0.2');
});

test('concurrent refreshes join one request and forced refreshes respect a short cooldown', async t => {
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.setHandler(async url => { await gate; return url === FIAT_URL ? fiat() : kraken(); });
  const first = f.service.refresh();
  const joined = f.service.refresh({ force: true });
  assert.equal(first, joined);
  assert.equal(f.service.status().refreshing, true);
  await Promise.resolve();
  assert.equal(f.calls.length, 2);
  release();
  await first;
  await f.service.refresh({ force: true });
  assert.equal(f.calls.length, 2);
  f.setTime('2026-11-05T18:01:00.000Z');
  await f.service.refresh({ force: true });
  assert.equal(f.calls.length, 4);
});

test('failed or partial updates retain each prior rate and retry at most hourly automatically', async t => {
  const f = fixture(t);
  const first = await f.service.refresh();
  f.setTime('2026-11-05T18:02:00.000Z');
  f.setHandler(url => {
    if (url === USDT_URL) throw new Error('market unavailable');
    return fiat().filter(row => row.quote !== 'JPY').map(row => row.quote === 'USD' ? { ...row, rate: 0.125 } : row);
  });
  const partial = await f.service.refresh({ force: true });
  assert.equal(partial.rates.USD.cnyRate, '8');
  assert.deepEqual(partial.rates.JPY, first.rates.JPY);
  assert.deepEqual(partial.rates.USDT, first.rates.USDT);
  assert.match(partial.errors.fiat, /JPY/);
  assert.equal(partial.errors.usdt, 'market unavailable');
  assert.equal(partial.nextAttemptAt, '2026-11-05T19:02:00.000Z');
  f.setTime('2026-11-05T18:10:00.000Z');
  await f.service.refresh();
  assert.equal(f.calls.length, 4);
  f.setTime(partial.nextAttemptAt);
  f.setHandler(() => { throw new Error('proxy offline'); });
  const offline = await f.service.refresh();
  assert.equal(f.calls.length, 6);
  assert.deepEqual(offline.rates, partial.rates);
  assert.equal(offline.lastSuccessAt, partial.lastSuccessAt);
});

test('older, impossible, future, duplicate, and invalid quotes never replace valid cached currencies', async t => {
  const f = fixture(t);
  const first = await f.service.refresh();
  f.setTime('2026-11-05T18:02:00.000Z');
  f.setHandler(url => {
    if (url === USDT_URL) return { error: [], result: { WRONGPAIR: { c: ['1'] } } };
    const rows = fiat();
    rows.find(row => row.quote === 'USD').date = '2026-11-04';
    rows.find(row => row.quote === 'JPY').date = '2026-02-30';
    rows.find(row => row.quote === 'EUR').date = '2199-01-01';
    rows.find(row => row.quote === 'HKD').rate = 0;
    rows.find(row => row.quote === 'GBP').rate = '1e-30';
    rows.push({ ...rows.find(row => row.quote === 'CHF') });
    return rows;
  });
  const next = await f.service.refresh({ force: true });
  for (const code of ['USD', 'JPY', 'EUR', 'HKD', 'GBP', 'CHF', 'USDT']) assert.deepEqual(next.rates[code], first.rates[code]);
  assert.match(next.errors.fiat, /USD.*JPY.*EUR.*HKD.*GBP.*CHF/);
  assert.match(next.errors.usdt, /格式无效/);
});

test('a failed fiat update can use retained USD with its original reference date for a new USDT quote', async t => {
  const f = fixture(t);
  await f.service.refresh();
  f.setTime('2026-11-06T18:00:00.000Z');
  f.setHandler(url => { if (url === FIAT_URL) throw new Error('ECB temporarily unavailable'); return kraken('0.99'); });
  const state = await f.service.refresh();
  assert.equal(state.rates.USDT.cnyRate, '7.07142857');
  assert.equal(state.rates.USDT.fiatAsOf, '2026-11-05');
  assert.equal(state.errors.usdt, null);
  assert.match(state.errors.fiat, /ECB/);
});

test('UTC-tomorrow reference dates survive USDT cache roundtrips independently of the local fetch date', async t => {
  const f = fixture(t);
  f.setHandler(url => url === FIAT_URL ? fiat('2026-11-06') : kraken());
  const state = await f.service.refresh();
  assert.equal(state.errors.fiat, null);
  assert.equal(state.rates.USDT.fiatAsOf, '2026-11-06');
  const restored = createRateService({ dataDirectory: f.directory, now: f.now, enabled: false });
  t.after(() => restored.close());
  assert.deepEqual(restored.status().rates.USDT, state.rates.USDT);
});

test('cache input is validated per currency and corrupt cache files are preserved until refresh', async t => {
  const f = fixture(t);
  await f.service.refresh();
  const file = path.join(f.directory, RATE_CACHE_FILENAME);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.rates.JPY.source = '<script>invalid</script>';
  saved.rates.USD.fetchedAt = '2199-01-01T00:00:00.000Z';
  saved.rates.EUR.cnyRate = 'Infinity';
  saved.rates.HKD.asOf = '2026-02-30';
  saved.rates.BOGUS = { cnyRate: '1' };
  fs.writeFileSync(file, JSON.stringify(saved));
  const sanitized = createRateService({ dataDirectory: f.directory, now: f.now, enabled: false });
  t.after(() => sanitized.close());
  assert.deepEqual(Object.keys(sanitized.status().rates).sort(), ['AUD', 'CAD', 'CHF', 'GBP', 'KRW', 'SGD', 'TRY', 'USDT']);
  assert.equal(sanitized.status().nextAttemptAt, null);
  fs.writeFileSync(file, '{invalid-json');
  const corrupt = createRateService({ dataDirectory: f.directory, now: f.now, enabled: false });
  t.after(() => corrupt.close());
  assert.deepEqual(corrupt.status().rates, {});
  assert.match(corrupt.status().cacheError, /缓存/);
  await corrupt.refresh({ force: true });
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid-json');
  const offline = createRateService({ dataDirectory: f.directory, now: f.now, requestJson: () => { throw new Error('proxy offline'); } });
  t.after(() => offline.close());
  await offline.refresh();
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid-json', 'a failed refresh must not replace unreadable cache contents');
});

test('disabled services never request and closing aborts outstanding work without writing a cache', async t => {
  const disabled = fixture(t, { enabled: false });
  await disabled.service.refresh({ force: true });
  assert.equal(disabled.calls.length, 0);
  const f = fixture(t);
  const signals = [];
  f.setHandler((url, { signal }) => new Promise((resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const pending = f.service.refresh();
  await Promise.resolve();
  f.service.close();
  const status = await pending;
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(status.enabled, false);
  assert.equal(status.refreshing, false);
  assert.equal(fs.existsSync(path.join(f.directory, RATE_CACHE_FILENAME)), false);
});

function mockTransport(t, { proxyFailure = false, timeout = false, authorized = true, statusCode = 200, headers = {}, payload = '{"ok":true}' } = {}) {
  const calls = { proxy: [], tls: [], https: [] };
  const emitter = () => Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; }, end() {} });
  const socket = emitter();
  t.mock.method(http, 'request', options => {
    calls.proxy.push(options);
    const request = emitter();
    request.end = () => {
      if (timeout) return;
      setImmediate(() => proxyFailure ? request.emit('error', new Error('offline')) : request.emit('connect', { statusCode: 200 }, socket, Buffer.alloc(0)));
    };
    return request;
  });
  t.mock.method(tls, 'connect', options => {
    calls.tls.push(options);
    const secure = emitter(); secure.authorized = authorized;
    setImmediate(() => secure.emit('secureConnect'));
    return secure;
  });
  t.mock.method(https, 'request', (options, callback) => {
    calls.https.push(options);
    const request = emitter();
    request.end = () => setImmediate(() => {
      const response = emitter();
      response.statusCode = statusCode;
      response.headers = { 'content-type': 'application/json', ...headers };
      callback(response);
      if (!response.destroyed) { response.emit('data', Buffer.from(payload)); response.emit('end'); }
    });
    return request;
  });
  return calls;
}

test('transport dials only the fixed loopback proxy and verifies TLS on the existing tunnel', async t => {
  const calls = mockTransport(t);
  assert.deepEqual(await proxyJson(FIAT_URL), { ok: true });
  assert.equal(calls.proxy.length, 1);
  assert.equal(calls.proxy[0].hostname, '127.0.0.1');
  assert.equal(calls.proxy[0].port, 10090);
  assert.equal(calls.proxy[0].method, 'CONNECT');
  assert.equal(calls.proxy[0].path, 'api.frankfurter.dev:443');
  assert.equal(calls.tls[0].servername, 'api.frankfurter.dev');
  assert.equal(calls.tls[0].rejectUnauthorized, true);
  assert.ok(calls.tls[0].socket);
  assert.equal(calls.https[0].agent.createConnection().authorized, true);
  for (const url of ['http://api.kraken.com/0/public/Ticker?pair=USDTUSD', USDT_URL + '&extra=1', 'https://attacker.invalid/', 'https://api.kraken.com@attacker.invalid/']) await assert.rejects(proxyJson(url), /固定来源/);
  assert.equal(calls.proxy.length, 1, 'rejected addresses do not create any socket');
});

test('proxy failure fails closed without any TLS or provider request', async t => {
  const calls = mockTransport(t, { proxyFailure: true });
  await assert.rejects(proxyJson(USDT_URL), /未尝试直连/);
  assert.equal(calls.proxy.length, 1);
  assert.equal(calls.tls.length, 0);
  assert.equal(calls.https.length, 0);
});

test('transport refuses an unauthorized TLS peer', async t => {
  const calls = mockTransport(t, { authorized: false });
  await assert.rejects(proxyJson(USDT_URL), /证书验证/);
  assert.equal(calls.https.length, 0);
});

test('transport never follows provider redirects', async t => {
  const calls = mockTransport(t, { statusCode: 302, headers: { location: 'https://attacker.invalid/' } });
  await assert.rejects(proxyJson(USDT_URL), /未跟随重定向/);
  assert.equal(calls.proxy.length, 1);
  assert.equal(calls.https.length, 1);
});

test('transport applies an end-to-end deadline to a stalled proxy', async t => {
  const calls = mockTransport(t, { timeout: true });
  await assert.rejects(proxyJson(USDT_URL, { timeoutMs: 15 }), /超时/);
  assert.equal(calls.proxy.length, 1);
  assert.equal(calls.tls.length, 0);
});

test('transport bounds response bytes and rejects malformed JSON', async t => {
  mockTransport(t, { payload: '{"tooLong":true}' });
  await assert.rejects(proxyJson(USDT_URL, { maxBytes: 3 }), /大小限制/);
  t.mock.restoreAll();
  mockTransport(t, { payload: '{bad-json' });
  await assert.rejects(proxyJson(USDT_URL), /无效 JSON/);
});
