import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { windowsUpdatePayload, signedWindowsUpdateManifest, windowsCandidateOutput } from '../tools/create-windows-update-manifest.mjs';
const { verifySignedManifest } = createRequire(import.meta.url)('../desktop/updater.cjs');
const { registeredSources } = createRequire(import.meta.url)('../desktop/update-sources.cjs');

// These generated identities are isolated test data; never read release keys.
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const androidPublicKey = keys.publicKey.export({ type: 'spki', format: 'der' });
const windows = { version: '1.8.5', url: 'https://github.com/moshangqingchen/super-ledger/releases/download/v1.8.5/SuperLedger-Setup-1.8.5.exe', size: 100000, sha256: 'a'.repeat(64), notes: 'Original desktop notes' };
const androidUrl = 'https://github.com/moshangqingchen/super-ledger/releases/download/v1.8.5/SuperLedger-Mobile-1.3.4.apk';
const android = { version: '1.3.4', versionCode: 10304, url: androidUrl, size: 1640644, sha256: 'b'.repeat(64), notes: 'Keep these Android notes exactly.\n第二行。',
  packageName: 'com.moneylab.superledger.mobile', certificateSha256: 'fd5a4af713362682fd1fe4e638decb05077b4ec672966ce3bd75b80558d7e785', minSdk: 26,
  sources: [{ id: 'gh-proxy', url: 'https://gh-proxy.org/' + androidUrl }, { id: 'ghfast', url: 'https://ghfast.top/' + androidUrl }, { id: 'github', url: androidUrl }],
  futureMetadata: { rollout: { percentage: 25 }, original: ['value', 0, false, null] } };
function envelope(changes = {}) {
  const bytes = Buffer.from(JSON.stringify({ schema: 1, repository: 'moshangqingchen/super-ledger', publishedAt: '2026-11-06T06:42:52.554Z', windows, android, ...changes }));
  return { schema: 1, payload: bytes.toString('base64'), signature: sign('RSA-SHA256', bytes, keys.privateKey).toString('base64') };
}
const installerBytes = Buffer.alloc(64 * 1024); installerBytes.write('MZ');
const options = () => ({ baseEnvelope: envelope(), publicKey, version: '1.8.6', installerBytes, notes: '  Windows selectors improved.\n保留账本。  ', publishedAt: '2026-11-06T10:00:00Z' });

test('Windows-only release preserves the entire Android release including mirrors, notes and unknown fields', () => {
  const input = options(), original = structuredClone(input.baseEnvelope);
  const result = windowsUpdatePayload(input);
  assert.deepEqual(result.android, android);
  assert.equal(JSON.stringify(result.android), JSON.stringify(android));
  assert.deepEqual(input.baseEnvelope, original, 'input envelope must not be mutated');
  assert.deepEqual(result.windows, { version: '1.8.6', url: 'https://github.com/moshangqingchen/super-ledger/releases/download/v1.8.6/SuperLedger-Setup-1.8.6.exe',
    size: installerBytes.length, sha256: createHash('sha256').update(installerBytes).digest('hex'), notes: input.notes.trim(),
    sources: registeredSources('https://github.com/moshangqingchen/super-ledger/releases/download/v1.8.6/SuperLedger-Setup-1.8.6.exe').map(({ id, url }) => ({ id, url })) });
});

test('an Android release without declared sources remains exactly as signed', () => {
  const previous = { ...android }; delete previous.sources;
  const result = windowsUpdatePayload({ ...options(), baseEnvelope: envelope({ android: previous, futureTopLevel: { keep: true } }) });
  assert.deepEqual(result.android, previous);
  assert.equal(Object.hasOwn(result.android, 'sources'), false);
  assert.deepEqual(result.futureTopLevel, { keep: true });
});

test('tampered signatures, wrong repositories and a missing Android segment cannot be republished', () => {
  const forged = envelope(); forged.signature = Buffer.alloc(256).toString('base64');
  assert.throws(() => windowsUpdatePayload({ ...options(), baseEnvelope: forged }), /签名/);
  assert.throws(() => windowsUpdatePayload({ ...options(), baseEnvelope: envelope({ repository: 'other/repository' }) }), /仓库/);
  for (const value of [null, [], 'missing']) assert.throws(() => windowsUpdatePayload({ ...options(), baseEnvelope: envelope({ android: value }) }), /Android/);
});

test('same-version releases, downgrades and invalid version strings are rejected', () => {
  for (const version of ['1.8.5', '1.8.4', '1.7.99', '1.8.6-preview', '01.8.6', '1.8.6/unsafe'])
    assert.throws(() => windowsUpdatePayload({ ...options(), version }));
});

test('invalid installer bytes, notes and publication timestamps are rejected before signing', () => {
  for (const bytes of [Buffer.alloc(64 * 1024), Buffer.from('MZ'), new Uint8Array(installerBytes), null])
    assert.throws(() => windowsUpdatePayload({ ...options(), installerBytes: bytes }), /MZ/);
  for (const notes of ['', '   ', 'x'.repeat(4001), 'bad\0notes', 'bad\u0001notes'])
    assert.throws(() => windowsUpdatePayload({ ...options(), notes }), /notes/);
  for (const publishedAt of ['invalid', '2026-99-06T10:00:00Z', null])
    assert.throws(() => windowsUpdatePayload({ ...options(), publishedAt }), /timestamp/);
});

test('candidate signature is accepted by the production Windows verifier and retains Android metadata', () => {
  const result = signedWindowsUpdateManifest({ ...options(), privateKey, androidPublicKey });
  const verified = verifySignedManifest(result, publicKey);
  assert.equal(verified.version, '1.8.6');
  assert.equal(verified.sha256, createHash('sha256').update(installerBytes).digest('hex'));
  assert.deepEqual(JSON.parse(Buffer.from(result.payload, 'base64')).android, android);
});

test('a replacement signing key or differing Android trust key is rejected', () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => signedWindowsUpdateManifest({ ...options(), androidPublicKey,
    privateKey: other.privateKey.export({ type: 'pkcs8', format: 'pem' }) }), /Signing key does not match/);
  assert.throws(() => signedWindowsUpdateManifest({ ...options(), privateKey,
    androidPublicKey: other.publicKey.export({ type: 'spki', format: 'der' }) }), /trust keys differ/);
});

test('candidate output defaults to a separate file and rejects live feed, base and junction aliases', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-release-test-'));
  t.after(() => {
    const resolved = path.resolve(root), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('windows-release-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'updates'));
  const baseFile = path.join(root, 'updates', 'stable.json'); fs.writeFileSync(baseFile, '{}');
  const settings = { root, baseFile, version: '1.8.6' };
  assert.equal(windowsCandidateOutput(settings), path.join(root, 'release', 'stable-windows-1.8.6.json'));
  assert.throws(() => windowsCandidateOutput({ ...settings, output: baseFile }), /separate candidate/);
  const otherBase = path.join(root, 'base.json'); fs.writeFileSync(otherBase, '{}');
  assert.throws(() => windowsCandidateOutput({ ...settings, baseFile: otherBase, output: baseFile }), /public/);
  assert.throws(() => windowsCandidateOutput({ ...settings, baseFile: otherBase, output: otherBase }), /separate candidate/);
  const alias = path.join(root, 'updates-alias');
  fs.symlinkSync(path.join(root, 'updates'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => windowsCandidateOutput({ ...settings, baseFile: otherBase, output: path.join(alias, 'stable.json') }), /public/);
});
