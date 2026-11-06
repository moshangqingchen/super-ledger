import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { verifySignedManifest, compareVersions } = createRequire(import.meta.url)('../desktop/updater.cjs');

const repository = 'moshangqingchen/super-ledger';
const certificate = 'fd5a4af713362682fd1fe4e638decb05077b4ec672966ce3bd75b80558d7e785';
const packageName = 'com.moneylab.superledger.mobile';

/** An Android-only release preserves the already signed Windows artifact exactly. */
export function androidUpdatePayload({ baseEnvelope, publicKey, version, versionCode, apkBytes, notes, publishedAt = new Date().toISOString() }) {
  verifySignedManifest(baseEnvelope, publicKey);
  const base = JSON.parse(Buffer.from(baseEnvelope.payload, 'base64').toString('utf8'));
  const previous = base.android;
  if (!previous || previous.packageName !== packageName || previous.certificateSha256 !== certificate || previous.minSdk !== 26 || !Number.isSafeInteger(previous.versionCode)) throw new Error('The signed base Android identity is not the existing application.');
  if (compareVersions(version, previous.version) <= 0 || !Number.isSafeInteger(versionCode) || versionCode <= previous.versionCode || versionCode > 2147483647) throw new Error('Both Android version and versionCode must increase.');
  if (!Buffer.isBuffer(apkBytes) || apkBytes.length < 1000 || apkBytes.length > 128 * 1024 * 1024 || apkBytes[0] !== 0x50 || apkBytes[1] !== 0x4b) throw new Error('Expected a bounded APK ZIP artifact.');
  if (typeof notes !== 'string' || !notes.trim() || notes.length > 4000 || notes.includes('\0')) throw new Error('Android release notes are missing or invalid.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(publishedAt)) throw new Error('Invalid release timestamp.');
  return { ...base, publishedAt, android: { ...previous, version, versionCode,
    url: `https://github.com/${repository}/releases/download/android-v${version}/SuperLedger-Mobile-${version}.apk`,
    size: apkBytes.length, sha256: createHash('sha256').update(apkBytes).digest('hex'), notes: notes.trim() } };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const values = new Map(), allowed = ['--base-manifest', '--android', '--android-version', '--android-code', '--notes', '--output'];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!allowed.includes(key) || !value || value.startsWith('--') || values.has(key)) throw new Error('Use --base-manifest signed.json --android app.apk --android-version x.y.z --android-code N --notes notes.md --output signed.json');
    values.set(key, value);
  }
  if (allowed.some(key => !values.has(key))) throw new Error('All Android-only release arguments are required.');
  const baseFile = path.resolve(values.get('--base-manifest')), output = path.resolve(values.get('--output'));
  if (baseFile.toLowerCase() === output.toLowerCase()) throw new Error('Write a separate candidate manifest; publish the feed only after the release is available.');
  if (fs.statSync(baseFile).size > 128 * 1024) throw new Error('Base manifest exceeds maximum size.');
  const publicKey = fs.readFileSync(path.join(root, 'assets/update-public-key.pem'));
  const payload = androidUpdatePayload({ baseEnvelope: JSON.parse(fs.readFileSync(baseFile, 'utf8')), publicKey,
    version: values.get('--android-version'), versionCode: Number(values.get('--android-code')),
    apkBytes: fs.readFileSync(values.get('--android')), notes: fs.readFileSync(values.get('--notes'), 'utf8').replace(/^\uFEFF/, '') });
  const privateKey = createPrivateKey(fs.readFileSync(process.env.LEDGER_UPDATE_SIGNING_KEY || path.join(root, '.release-signing/update-signing-private.pem')));
  const bytes = Buffer.from(JSON.stringify(payload));
  const signature = sign('RSA-SHA256', bytes, privateKey);
  if (!verify('RSA-SHA256', bytes, publicKey, signature)) throw new Error('Signing key does not match the installed update trust key.');
  if (!createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(fs.readFileSync(path.join(root, 'android/app/src/main/res/raw/update_public_key.der')))) throw new Error('Android update trust key differs.');
  const envelope = { schema: 1, payload: bytes.toString('base64'), signature: signature.toString('base64') };
  verifySignedManifest(envelope, publicKey);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(envelope, null, 2) + '\n');
  console.log(JSON.stringify({ output, windowsPreserved: payload.windows.version, androidVersion: payload.android.version, androidCode: payload.android.versionCode, androidSha256: payload.android.sha256, releaseTag: `android-v${payload.android.version}` }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
