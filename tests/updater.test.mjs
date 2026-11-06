import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign, createHash, constants } from 'node:crypto';
const { REPOSITORY, MANIFEST_URL, compareVersions, installerUrl, verifySignedManifest, validateTransportUrl, proxyTransfer, createUpdater, PROMPT_COOLDOWN_MS } = createRequire(import.meta.url)('../desktop/updater.cjs');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const installer = Buffer.alloc(65536, 7); installer.write('MZ');
function payload(version = '1.6.0', changes = {}) {
  return { schema: 1, repository: REPOSITORY, publishedAt: '2026-11-06T12:00:00.000Z', windows: { version, url: installerUrl(version), size: installer.length, sha256: createHash('sha256').update(installer).digest('hex'), notes: '更新与同步改进', ...changes } };
}
function envelope(value = payload()) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { schema: 1, payload: bytes.toString('base64'), signature: sign('RSA-SHA256', bytes, { key: keys.privateKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64') };
}
function stream(options, body, statusCode = 200, headers = {}) {
  options.onResponse?.({ statusCode, headers });
  options.onChunk(body);
  return { statusCode, headers, bytes: body.length };
}
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-updater-test-'));
  t.after(() => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  const calls = [], launches = [], events = [];
  let manifest = envelope(), clock = Date.parse('2026-11-06T13:00:00Z');
  const request = async (url, options) => {
    calls.push(url);
    if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(manifest)), headers: {} };
    return stream(options, installer);
  };
  const service = createUpdater({ currentVersion: '1.5.0', userDataDirectory: directory, publicKey, request, launchInstaller: async filename => { launches.push(filename); }, onStatus: value => events.push(value), now: () => clock, retryDelaysMs: [0, 0, 0], ...overrides });
  return { service, directory, calls, launches, events, setManifest: value => { manifest = value; }, setClock: value => { clock = value; }, now: () => clock, request };
}

test('signed manifest verifies identity, stable versions, exact release asset, size and digest', () => {
  const valid = envelope(); assert.equal(verifySignedManifest(valid, publicKey).version, '1.6.0');
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1); assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  for (const v of ['01.6.0', '1.6', '1.6.0-beta', '1.6.0+build', '9999999.0.0']) assert.throws(() => compareVersions(v, '1.0.0'));
  assert.throws(() => verifySignedManifest({ ...valid, payload: Buffer.from(JSON.stringify(payload('1.7.0'))).toString('base64') }, publicKey), /签名验证失败/);
  assert.throws(() => verifySignedManifest(envelope({ ...payload(), repository: 'elsewhere/repo' }), publicKey), /仓库/);
  for (const changes of [{ url: installerUrl('1.6.0') + '?extra=1' }, { url: 'https://attacker.invalid/setup.exe' }, { sha256: '0'.repeat(63) }, { size: -1 }, { size: 1024 * 1024 * 1024 }, { notes: { unexpected: true } }]) assert.throws(() => verifySignedManifest(envelope(payload('1.6.0', changes)), publicKey));
});

test('transport rejects HTTP, credential tricks, other repositories and non-allowlisted redirect hosts', () => {
  assert.equal(validateTransportUrl(MANIFEST_URL).hostname, 'raw.githubusercontent.com');
  assert.equal(validateTransportUrl('https://release-assets.githubusercontent.com/github-production-release-asset/123?sig=value').hostname, 'release-assets.githubusercontent.com');
  for (const url of ['http://github.com/'+REPOSITORY+'/x', 'https://github.com.evil.invalid/setup.exe', 'https://github.com@evil.invalid/setup.exe', 'https://github.com/other/repository/releases/download/v1.6.0/SuperLedger-Setup-1.6.0.exe', 'https://raw.githubusercontent.com/other/repository/main/updates/stable.json', 'https://objects.githubusercontent.com:8443/asset', installerUrl('1.6.0')+'#fragment']) assert.throws(() => validateTransportUrl(url));
});

test('check never downloads or launches and same/older releases cannot become installers', async t => {
  const f = fixture(t); assert.equal(f.calls.length, 0);
  assert.equal((await f.service.check()).phase, 'available'); assert.deepEqual(f.calls, [MANIFEST_URL]); assert.equal(f.launches.length, 0);
  const same = fixture(t, { currentVersion: '1.6.0' }); assert.equal((await same.service.check()).phase, 'idle');
  await assert.rejects(same.service.download(), /检查/);
  const older = fixture(t, { currentVersion: '2.0.0' }); assert.equal((await older.service.check()).phase, 'idle'); assert.equal(older.service.status().availableVersion, null);
  assert.equal(older.service.status().error, ''); assert.equal(older.service.status().lastCheckedAt, older.now());
  await assert.rejects(older.service.download(), /检查/); await assert.rejects(older.service.install(), /下载并验证/);
  assert.deepEqual(older.calls, [MANIFEST_URL]); assert.deepEqual(older.launches, []);
});

test('a local build ahead of public releases persists the verified feed watermark and rejects a later rollback', async t => {
  const f = fixture(t, { currentVersion: '2.0.0' });
  assert.equal((await f.service.check()).phase, 'idle');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'updates', 'update-state.json'), 'utf8')).highestVersion, '1.6.0');
  const restored = createUpdater({ currentVersion: '2.1.0', userDataDirectory: f.directory, publicKey, request: f.request, now: f.now });
  assert.equal((await restored.check()).phase, 'idle', 'reopening a newer local build accepts the unchanged public release');
  f.setManifest(envelope(payload('1.7.0')));
  assert.equal((await restored.check()).phase, 'idle');
  const afterRestart = createUpdater({ currentVersion: '2.1.0', userDataDirectory: f.directory, publicKey, request: f.request, now: f.now });
  f.setManifest(envelope(payload('1.6.0')));
  assert.match((await afterRestart.check()).error, /拒绝回退/);
  assert.equal(afterRestart.status().availableVersion, null);
  f.setManifest(envelope(payload('2.2.0')));
  assert.equal((await afterRestart.check()).phase, 'available');
  assert.equal(afterRestart.status().availableVersion, '2.2.0');
  assert.deepEqual(f.launches, []);
});

test('simultaneous startup/manual checks share a request and checks never interrupt downloads', async t => {
  let finishCheck, finishDownload, markCheckStarted, markDownloadStarted;
  const checkStarted = new Promise(resolve => { markCheckStarted = resolve; });
  const downloadStarted = new Promise(resolve => { markDownloadStarted = resolve; });
  const urls = [];
  const f = fixture(t, { request: async (url, options) => {
    urls.push(url);
    if (url === MANIFEST_URL) {
      markCheckStarted();
      await new Promise(resolve => { finishCheck = resolve; });
      return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
    }
    markDownloadStarted();
    await new Promise(resolve => { finishDownload = resolve; });
    return stream(options, installer);
  } });
  const first = f.service.check(), second = f.service.check();
  await checkStarted;
  assert.deepEqual(urls, [MANIFEST_URL]);
  finishCheck();
  assert.equal((await first).phase, 'available'); assert.equal((await second).phase, 'available');
  const download = f.service.download(); await downloadStarted;
  assert.equal((await f.service.check()).phase, 'downloading');
  assert.deepEqual(urls, [MANIFEST_URL, installerUrl('1.6.0')]);
  finishDownload(); assert.equal((await download).phase, 'ready');
  assert.deepEqual(f.launches, []);
});

test('disabled mode never sends requests or executes installers', async t => {
  const f = fixture(t, { enabled: false });
  await assert.rejects(f.service.check(), /测试模式/); await assert.rejects(f.service.download(), /测试模式/); await assert.rejects(f.service.install(), /测试模式/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.launches, []);
});

test('failed signature never reaches download and a later manual check can recover', async t => {
  const f = fixture(t); f.setManifest({ ...envelope(), signature: Buffer.alloc(256).toString('base64') });
  assert.equal((await f.service.check()).phase, 'error'); assert.equal(f.service.status().availableVersion, null);
  f.setManifest(envelope()); assert.equal((await f.service.check()).phase, 'available'); assert.equal(f.calls.length, 2);
});

test('update bytes are size/hash/MZ verified, reused from cache, and rechecked before installer launch', async t => {
  const f = fixture(t); await f.service.check();
  const value = await f.service.download(); assert.equal(value.phase, 'ready'); assert.equal(value.downloadedBytes, installer.length); assert.equal(f.launches.length, 0);
  const filename = path.join(f.directory, 'updates', 'SuperLedger-Setup-1.6.0.exe'); assert.deepEqual(fs.readFileSync(filename), installer);
  const count = f.calls.length; await f.service.download(); assert.equal(f.calls.length, count, 'verified cache avoids a second network download');
  await f.service.install(); assert.deepEqual(f.launches, [filename]);
  const tampered = Buffer.from(installer); tampered[100] = 99; fs.writeFileSync(filename, tampered);
  await assert.rejects(f.service.install(), /SHA-256/); assert.equal(f.launches.length, 1); assert.equal(f.service.status().ready, false);
});

test('download follows only checked HTTPS redirects through its injected proxy transport', async t => {
  const destinations = [], cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/file?sig=one';
  const f = fixture(t, { request: async (url, options) => {
    destinations.push(url);
    if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
    if (url === installerUrl('1.6.0')) return { statusCode: 302, headers: { location: cdn } };
    return stream(options, installer);
  } });
  await f.service.check(); assert.equal((await f.service.download()).ready, true); assert.deepEqual(destinations, [MANIFEST_URL, installerUrl('1.6.0'), cdn]);
  const badCalls = [];
  const bad = fixture(t, { request: async url => {
    badCalls.push(url);
    if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
    return { statusCode: 302, headers: { location: 'http://attacker.invalid/exe' } };
  } });
  await bad.service.check(); assert.equal((await bad.service.download()).phase, 'error'); assert.equal(badCalls.length, 2); assert.equal(bad.launches.length, 0);
  assert.equal(fs.readdirSync(path.join(bad.directory, 'updates')).some(name => name.endsWith('.partial')), false);
});

test('corrupt/truncated bytes never become a ready installer and do not touch ledger data', async t => {
  const corrupt = Buffer.from(installer); corrupt[900] ^= 1;
  for (const body of [corrupt, installer.subarray(0, 100)]) {
    const f = fixture(t, { request: async (url, options) => {
      if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
      return stream(options, body);
    } });
    const ledger = path.join(f.directory, 'ledger.json'); fs.writeFileSync(ledger, 'untouched');
    await f.service.check(); assert.equal((await f.service.download()).phase, 'error');
    assert.equal(fs.readFileSync(ledger, 'utf8'), 'untouched'); assert.equal(f.launches.length, 0);
    assert.equal(fs.readdirSync(path.join(f.directory, 'updates')).some(name => /\.(exe|partial)$/.test(name)), false);
  }
});

test('interrupted streams resume the retained prefix with a checked range and report real speed', async t => {
  const offsets = [], prefix = 16384;
  const f = fixture(t, { request: async (url, options) => {
    if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
    offsets.push(options.rangeStart);
    f.setClock(f.now() + 500);
    if (offsets.length === 1) {
      stream(options, installer.subarray(0, prefix), 200, { 'content-length': String(installer.length) });
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    }
    return stream(options, installer.subarray(prefix), 206, { 'content-range': `bytes ${prefix}-${installer.length - 1}/${installer.length}`, 'content-length': String(installer.length - prefix) });
  } });
  await f.service.check();
  assert.equal((await f.service.download()).phase, 'ready');
  assert.deepEqual(offsets, [undefined, prefix]);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'updates', 'SuperLedger-Setup-1.6.0.exe')), installer);
  assert.ok(f.events.some(value => value.downloadedBytes === prefix && value.bytesPerSecond === prefix * 2));
  assert.ok(f.events.some(value => value.retryAttempt === 1 && value.phase === 'downloading' && value.error === '' && value.bytesPerSecond === 0));
  assert.ok(f.events.every(value => Number.isFinite(value.bytesPerSecond) && value.bytesPerSecond >= 0));
  assert.equal(f.service.status().retryAttempt, 0);
  assert.equal(f.service.status().bytesPerSecond, 0);
  assert.equal(f.launches.length, 0);
});

test('a successful but short body retries from its actual offset instead of becoming ready', async t => {
  let attempts = 0;
  const f = fixture(t, { request: async (url, options) => {
    if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
    if (++attempts === 1) return stream(options, installer.subarray(0, 100));
    assert.equal(options.rangeStart, 100);
    return stream(options, installer.subarray(100), 206, { 'content-range': `bytes 100-${installer.length - 1}/${installer.length}` });
  } });
  await f.service.check(); assert.equal((await f.service.download()).ready, true); assert.equal(attempts, 2);
});

test('a source ignoring Range restarts the file without concatenating duplicate bytes', async t => {
  const offsets = [];
  const f = fixture(t, { request: async (url, options) => {
    if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
    offsets.push(options.rangeStart);
    if (offsets.length === 1) {
      stream(options, installer.subarray(0, 1000));
      throw Object.assign(new Error('closed'), { code: 'ECONNRESET' });
    }
    return stream(options, installer, 200, { 'content-length': String(installer.length) });
  } });
  await f.service.check(); assert.equal((await f.service.download()).ready, true);
  assert.deepEqual(offsets, [undefined, 1000]);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'updates', 'SuperLedger-Setup-1.6.0.exe')), installer);
});

test('a rejected range falls back to one full request from the canonical signed URL', async t => {
  const offsets = [], urls = [];
  const f = fixture(t, { request: async (url, options) => {
    if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
    urls.push(url); offsets.push(options.rangeStart);
    if (offsets.length === 1) {
      stream(options, installer.subarray(0, 1000));
      throw Object.assign(new Error('closed'), { code: 'ECONNRESET' });
    }
    if (offsets.length === 2) { options.onResponse({ statusCode: 416, headers: { 'content-range': `bytes */${installer.length}` } }); return { statusCode: 416, headers: {} }; }
    return stream(options, installer);
  } });
  await f.service.check(); assert.equal((await f.service.download()).ready, true);
  assert.deepEqual(offsets, [undefined, 1000, undefined]);
  assert.ok(urls.every(url => url === installerUrl('1.6.0')));
});

test('invalid range positions, totals, response lengths and compression fail before appending bytes', async t => {
  for (const headers of [
    {}, { 'content-range': `bytes 999-${installer.length - 1}/${installer.length}` },
    { 'content-range': `bytes 1000-${installer.length - 1}/${installer.length + 1}` },
    { 'content-range': `bytes 1000-${installer.length}/${installer.length}` },
    { 'content-range': `bytes 1000-${installer.length - 1}/*` },
    { 'content-range': `bytes 1000-${installer.length - 1}/${installer.length}`, 'content-length': '1' },
    { 'content-range': `bytes 1000-${installer.length - 1}/${installer.length}`, 'content-encoding': 'gzip' },
  ]) {
    let attempts = 0, acceptedInvalidBody = false;
    const f = fixture(t, { request: async (url, options) => {
      if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
      if (++attempts === 1) { stream(options, installer.subarray(0, 1000)); throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }
      options.onResponse({ statusCode: 206, headers }); acceptedInvalidBody = true;
      options.onChunk(installer.subarray(1000)); return { statusCode: 206, headers };
    } });
    await f.service.check(); assert.equal((await f.service.download()).phase, 'error');
    assert.equal(attempts, 2); assert.equal(acceptedInvalidBody, false);
    assert.equal(fs.readdirSync(path.join(f.directory, 'updates')).some(name => /\.(exe|partial)$/.test(name)), false);
  }
});

test('integrity and unclassified failures do not retry or authorize an installer', async t => {
  const corrupt = Buffer.from(installer); corrupt[100] ^= 1;
  const nonMZ = Buffer.from(installer); nonMZ.write('NO');
  for (const respond of [
    options => stream(options, corrupt), options => stream(options, nonMZ),
    options => stream(options, installer, 200, { 'content-length': String(installer.length + 1) }),
    options => stream(options, Buffer.concat([installer, Buffer.from([1])])),
    () => { throw Object.assign(new Error('certificate rejected'), { code: 'CERT_HAS_EXPIRED' }); },
    () => { throw new Error('unclassified integrity failure'); },
  ]) {
    let attempts = 0;
    const f = fixture(t, { request: async (url, options) => {
      if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
      attempts++; return respond(options);
    } });
    await f.service.check(); assert.equal((await f.service.download()).phase, 'error'); assert.equal(attempts, 1);
    assert.equal(f.service.status().ready, false); assert.equal(f.launches.length, 0);
  }
});

test('transient errors exhaust a bounded retry budget and remove the retained partial file', async t => {
  let attempts = 0;
  const f = fixture(t, { request: async (url, options) => {
    if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
    attempts++;
    if (attempts === 1) stream(options, installer.subarray(0, 1000));
    throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  } });
  await f.service.check(); const result = await f.service.download();
  assert.equal(result.phase, 'error'); assert.equal(attempts, 4);
  assert.deepEqual(f.events.filter(value => value.retryAttempt > 0).map(value => value.retryAttempt), [1, 2, 3]);
  assert.equal(result.downloadedBytes, 0); assert.equal(result.bytesPerSecond, 0); assert.equal(result.retryAttempt, 0);
  assert.equal(fs.readdirSync(path.join(f.directory, 'updates')).some(name => name.endsWith('.partial')), false);
});

test('cancel and close interrupt retry waits immediately and clean retained bytes', async t => {
  for (const method of ['cancelDownload', 'close']) {
    let attempts = 0, waiting;
    const waitStarted = new Promise(resolve => { waiting = resolve; });
    const f = fixture(t, { retryDelaysMs: [30000], onStatus: value => { if (value.retryAttempt) waiting(); }, request: async (url, options) => {
      if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
      attempts++; stream(options, installer.subarray(0, 1000));
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    } });
    await f.service.check(); const pending = f.service.download(); await waitStarted;
    const started = Date.now(); f.service[method](); const result = await pending;
    assert.ok(Date.now() - started < 1000); assert.equal(result.phase, 'available'); assert.equal(attempts, 1);
    assert.equal(result.retryAttempt, 0); assert.equal(result.bytesPerSecond, 0);
    assert.equal(fs.readdirSync(path.join(f.directory, 'updates')).some(name => name.endsWith('.partial')), false);
  }
});

test('cancellation before the download microtask sends no installer request', async t => {
  const f = fixture(t); await f.service.check();
  const pending = f.service.download(); f.service.cancelDownload();
  assert.equal((await pending).phase, 'available'); assert.deepEqual(f.calls, [MANIFEST_URL]);
});

test('cancel aborts outstanding download, removes partial file and preserves current app', async t => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { request: async (url, options) => {
    if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
    stream(options, installer.subarray(0, 500)); started();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' })), { once: true }));
  } });
  await f.service.check(); const first = f.service.download(), second = f.service.download(); await began; f.service.cancelDownload();
  assert.equal((await first).phase, 'available'); await second;
  assert.equal(f.launches.length, 0); assert.equal(fs.readdirSync(path.join(f.directory, 'updates')).some(name => name.endsWith('.partial')), false);
});

test('later reminder persists its cooldown; newer version overrides the previous deferral', async t => {
  const f = fixture(t); await f.service.check(); assert.equal(f.service.shouldPrompt(), true);
  f.service.defer(); assert.equal(f.service.shouldPrompt(), false);
  const restored = createUpdater({ currentVersion: '1.5.0', userDataDirectory: f.directory, publicKey, request: f.request, now: f.now });
  await restored.check(); assert.equal(restored.shouldPrompt(), false);
  f.setClock(f.now() + PROMPT_COOLDOWN_MS + 1); assert.equal(restored.shouldPrompt(), true);
  f.setManifest(envelope(payload('1.7.0'))); await restored.check(); assert.equal(restored.status().availableVersion, '1.7.0');
  f.setManifest(envelope()); assert.equal((await restored.check()).phase, 'error');
});

function fakeTransport(t, { proxyFailure = false, authorized = true, redirect, payload = '{"ok":true}', statusCode = 200, headers = {}, responseEvent, tlsFailure, hangAt } = {}) {
  const calls = { proxy: [], tls: [], provider: [] };
  const emitter = () => Object.assign(new EventEmitter(), { destroy() {}, end() {}, setTimeout(milliseconds, callback) { this.timeoutMs = milliseconds; this.timeoutCallback = callback; } });
  const tunnel = emitter(), secure = Object.assign(emitter(), { authorized });
  const controls = {};
  t.mock.method(http, 'request', options => {
    calls.proxy.push(options); const request = emitter();
    controls.proxy = request;
    request.end = () => { if (hangAt !== 'connect') setImmediate(() => proxyFailure ? request.emit('error', new Error('offline')) : request.emit('connect', { statusCode: 200 }, tunnel, Buffer.alloc(0))); };
    return request;
  });
  t.mock.method(tls, 'connect', options => { calls.tls.push(options); if (hangAt !== 'tls') setImmediate(() => tlsFailure ? secure.emit('error', tlsFailure) : secure.emit('secureConnect')); return secure; });
  t.mock.method(https, 'request', (options, callback) => {
    calls.provider.push(options); const request = emitter();
    controls.provider = request;
    request.end = () => setImmediate(() => {
      const response = Object.assign(emitter(), { statusCode: redirect ? 302 : statusCode, headers: redirect ? { location: redirect } : headers }); controls.response = response; callback(response);
      if (!redirect && hangAt !== 'response') {
        response.emit('data', Buffer.from(payload));
        if (responseEvent) response.emit(responseEvent, new Error('interrupted'));
        else { response.emit('end'); response.emit('close'); }
      }
    }); return request;
  });
  return { calls, tunnel, secure, controls };
}

test('real transport only dials the loopback proxy, then validates TLS over that exact tunnel', async t => {
  const f = fakeTransport(t); const result = await proxyTransfer(MANIFEST_URL); assert.equal(result.body.toString(), '{"ok":true}');
  assert.equal(f.calls.proxy.length, 1); assert.equal(f.calls.proxy[0].hostname, '127.0.0.1'); assert.equal(f.calls.proxy[0].port, 10090); assert.equal(f.calls.proxy[0].method, 'CONNECT');
  assert.equal(f.calls.tls[0].socket, f.tunnel); assert.equal(f.calls.tls[0].rejectUnauthorized, true); assert.equal(f.calls.tls[0].servername, 'raw.githubusercontent.com');
  assert.equal(f.calls.provider[0].agent.createConnection(), f.secure);
});

test('proxy failure and bad TLS stop without any direct-network fallback', async t => {
  const f = fakeTransport(t, { proxyFailure: true }); await assert.rejects(proxyTransfer(MANIFEST_URL), /未尝试直连/); assert.equal(f.calls.tls.length, 0); assert.equal(f.calls.provider.length, 0);
  t.mock.restoreAll();
  const peer = fakeTransport(t, { authorized: false }); await assert.rejects(proxyTransfer(MANIFEST_URL), /证书验证失败/); assert.equal(peer.calls.provider.length, 0);
});

test('range transport sends identity encoding and validates response metadata before delivering bytes', async t => {
  const order = [], start = 1000;
  const f = fakeTransport(t, { statusCode: 206, headers: { 'content-range': `bytes ${start}-${installer.length - 1}/${installer.length}` }, payload: installer.subarray(start) });
  const result = await proxyTransfer(installerUrl('1.6.0'), { rangeStart: start, maxBytes: installer.length,
    onResponse: response => { order.push('headers'); assert.equal(response.statusCode, 206); }, onChunk: () => order.push('bytes') });
  assert.deepEqual(order, ['headers', 'bytes']); assert.equal(result.bytes, installer.length - start);
  assert.equal(f.calls.provider[0].headers.Range, 'bytes=1000-');
  assert.equal(f.calls.provider[0].headers['Accept-Encoding'], 'identity');
  assert.equal(f.tunnel.timeoutMs, 0, 'The raw CONNECT socket timer must be disabled after TLS takes ownership');
  assert.equal(f.secure.timeoutMs, 20000);
});

test('premature response events are retryable while normal end then close succeeds once', async t => {
  for (const responseEvent of ['aborted', 'error', 'close']) {
    fakeTransport(t, { responseEvent });
    await assert.rejects(proxyTransfer(MANIFEST_URL), error => error.code === 'UPDATE_TRANSFER_INTERRUPTED');
    t.mock.restoreAll();
  }
  let chunks = 0;
  fakeTransport(t);
  const response = await proxyTransfer(MANIFEST_URL, { onChunk: () => chunks++ });
  assert.equal(response.statusCode, 200); assert.equal(chunks, 1);
});

test('TLS certificate failures are terminal but TLS transport resets remain retryable', async t => {
  for (const [code, retry] of [['CERT_HAS_EXPIRED', false], ['ERR_TLS_CERT_ALTNAME_INVALID', false], ['ECONNRESET', true]]) {
    const f = fakeTransport(t, { tlsFailure: Object.assign(new Error(code), { code }) });
    await assert.rejects(proxyTransfer(MANIFEST_URL), error => (error.code === 'UPDATE_TRANSFER_INTERRUPTED') === retry);
    assert.equal(f.calls.provider.length, 0); t.mock.restoreAll();
  }
});

test('CONNECT, TLS and HTTP idle timeouts and silent socket closure terminate the request', async t => {
  const turn = () => new Promise(resolve => setImmediate(resolve));
  for (const stage of ['connect', 'tls', 'response']) {
    const f = fakeTransport(t, { hangAt: stage });
    const pending = proxyTransfer(MANIFEST_URL);
    const rejected = assert.rejects(pending, error => error.code === 'UPDATE_TRANSFER_INTERRUPTED');
    await turn(); await turn(); await turn();
    const endpoint = stage === 'connect' ? f.controls.proxy : stage === 'tls' ? f.secure : f.controls.provider;
    assert.equal(endpoint.timeoutMs, 20000); endpoint.timeoutCallback(); await rejected; t.mock.restoreAll();
  }
  for (const socketName of ['tunnel', 'secure']) {
    const f = fakeTransport(t, { hangAt: 'response' });
    const pending = proxyTransfer(MANIFEST_URL);
    const rejected = assert.rejects(pending, error => error.code === 'UPDATE_TRANSFER_INTERRUPTED');
    await turn(); await turn(); await turn(); f[socketName].emit('close'); await rejected; t.mock.restoreAll();
  }
});

test('temporary HTTP failure is retryable while forbidden responses are terminal', async t => {
  for (const [statusCode, retry] of [[503, true], [429, true], [403, false], [404, false]]) {
    fakeTransport(t, { statusCode });
    await assert.rejects(proxyTransfer(MANIFEST_URL), error => (error.code === 'UPDATE_TRANSFER_INTERRUPTED') === retry);
    t.mock.restoreAll();
  }
});
