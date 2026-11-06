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
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-updater-test-'));
  t.after(() => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  const calls = [], launches = [], events = [];
  let manifest = envelope(), clock = Date.parse('2026-11-06T13:00:00Z');
  const request = async (url, options) => {
    calls.push(url);
    if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(manifest)), headers: {} };
    options.onChunk(installer);
    return { statusCode: 200, headers: {}, bytes: installer.length };
  };
  const service = createUpdater({ currentVersion: '1.5.0', userDataDirectory: directory, publicKey, request, launchInstaller: async filename => { launches.push(filename); }, onStatus: value => events.push(value), now: () => clock, ...overrides });
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
    options.onChunk(installer);
    return { statusCode: 200, headers: {} };
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
    options.onChunk(installer); return { statusCode: 200, headers: {} };
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
      options.onChunk(body); return { statusCode: 200, headers: {} };
    } });
    const ledger = path.join(f.directory, 'ledger.json'); fs.writeFileSync(ledger, 'untouched');
    await f.service.check(); assert.equal((await f.service.download()).phase, 'error');
    assert.equal(fs.readFileSync(ledger, 'utf8'), 'untouched'); assert.equal(f.launches.length, 0);
    assert.equal(fs.readdirSync(path.join(f.directory, 'updates')).some(name => /\.(exe|partial)$/.test(name)), false);
  }
});

test('cancel aborts outstanding download, removes partial file and preserves current app', async t => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { request: async (url, options) => {
    if (url === MANIFEST_URL) return { statusCode: 200, body: Buffer.from(JSON.stringify(envelope())), headers: {} };
    options.onChunk(installer.subarray(0, 500)); started();
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

function fakeTransport(t, { proxyFailure = false, authorized = true, redirect, payload = '{"ok":true}' } = {}) {
  const calls = { proxy: [], tls: [], provider: [] };
  const emitter = () => Object.assign(new EventEmitter(), { destroy() {}, end() {}, setTimeout() {} });
  const tunnel = emitter(), secure = Object.assign(emitter(), { authorized });
  t.mock.method(http, 'request', options => {
    calls.proxy.push(options); const request = emitter();
    request.end = () => setImmediate(() => proxyFailure ? request.emit('error', new Error('offline')) : request.emit('connect', { statusCode: 200 }, tunnel, Buffer.alloc(0)));
    return request;
  });
  t.mock.method(tls, 'connect', options => { calls.tls.push(options); setImmediate(() => secure.emit('secureConnect')); return secure; });
  t.mock.method(https, 'request', (options, callback) => {
    calls.provider.push(options); const request = emitter();
    request.end = () => setImmediate(() => {
      const response = Object.assign(emitter(), { statusCode: redirect ? 302 : 200, headers: redirect ? { location: redirect } : {} }); callback(response);
      if (!redirect) { response.emit('data', Buffer.from(payload)); response.emit('end'); }
    }); return request;
  });
  return { calls, tunnel, secure };
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
