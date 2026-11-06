import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { androidUpdatePayload } from '../tools/create-android-update-manifest.mjs';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const windows = { version: '1.8.0', url: 'https://github.com/moshangqingchen/super-ledger/releases/download/v1.8.0/SuperLedger-Setup-1.8.0.exe', size: 100000, sha256: 'a'.repeat(64), notes: 'Original desktop release notes' };
const android = { version: '1.2.0', versionCode: 10200, packageName: 'com.moneylab.superledger.mobile', certificateSha256: 'fd5a4af713362682fd1fe4e638decb05077b4ec672966ce3bd75b80558d7e785', minSdk: 26 };
function envelope(changes = {}) {
  const bytes = Buffer.from(JSON.stringify({ schema: 1, repository: 'moshangqingchen/super-ledger', publishedAt: '2026-11-06T03:00:00Z', windows, android, ...changes }));
  return { schema: 1, payload: bytes.toString('base64'), signature: sign('RSA-SHA256', bytes, keys.privateKey).toString('base64') };
}
const apkBytes = Buffer.alloc(1024); apkBytes.write('PK');
const options = () => ({ baseEnvelope: envelope(), publicKey, version: '1.3.0', versionCode: 10300, apkBytes, notes: '手机界面改进。', publishedAt: '2026-11-06T04:00:00Z' });
test('Android-only release retains every Windows field and original URL without offering another desktop update', () => {
  const result = androidUpdatePayload(options());
  assert.deepEqual(result.windows, windows);
  assert.equal(result.android.url, 'https://github.com/moshangqingchen/super-ledger/releases/download/android-v1.3.0/SuperLedger-Mobile-1.3.0.apk');
  assert.equal(result.android.versionCode, 10300);
  assert.equal(result.android.certificateSha256, android.certificateSha256);
  assert.notEqual(result.android.notes, windows.notes);
});
test('unverified base metadata or a different app signing identity cannot enter the new feed', () => {
  const forged = envelope(); forged.signature = Buffer.alloc(256).toString('base64');
  assert.throws(() => androidUpdatePayload({ ...options(), baseEnvelope: forged }), /签名/);
  for (const change of [{ packageName: 'other.app' }, { certificateSha256: 'b'.repeat(64) }, { minSdk: 25 }])
    assert.throws(() => androidUpdatePayload({ ...options(), baseEnvelope: envelope({ android: { ...android, ...change } }) }), /identity/);
});
test('both platform version name and code must advance', () => {
  for (const change of [{ version: '1.2.0' }, { version: '1.1.9' }, { versionCode: 10200 }, { versionCode: 10100 }, { versionCode: 10300.5 }, { version: '1.3.0/evil' }])
    assert.throws(() => androidUpdatePayload({ ...options(), ...change }));
});
test('empty artifacts and oversized or non-text release notes are rejected before signing', () => {
  for (const change of [{ apkBytes: Buffer.alloc(1024) }, { apkBytes: Buffer.from('PK') }, { notes: '' }, { notes: 'x'.repeat(4001) }, { notes: 'bad\0notes' }, { publishedAt: 'not-a-date' }])
    assert.throws(() => androidUpdatePayload({ ...options(), ...change }));
});
test('each release rebuilds signed routes for the same new APK and never inherits old mirror destinations', () => {
  const result = androidUpdatePayload({ ...options(), version: '1.3.2', versionCode: 10302,
    baseEnvelope: envelope({ android: { ...android, sources: [{ id: 'old', url: 'https://untrusted.invalid/old.apk' }] } }) });
  const canonical = 'https://github.com/moshangqingchen/super-ledger/releases/download/android-v1.3.2/SuperLedger-Mobile-1.3.2.apk';
  assert.equal(result.android.url, canonical, 'older installed clients still receive the original GitHub URL');
  assert.deepEqual(result.android.sources, [
    { id: 'gh-proxy', url: 'https://gh-proxy.org/' + canonical },
    { id: 'ghfast', url: 'https://ghfast.top/' + canonical },
    { id: 'github', url: canonical }
  ]);
  assert.deepEqual(result.windows, windows);
});
