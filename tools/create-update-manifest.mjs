import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'moshangqingchen/super-ledger';
const values = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!['--windows', '--android', '--android-version', '--android-code', '--notes', '--output'].includes(key) || !value) throw new Error('Arguments: --windows installer.exe --android app.apk --android-version 1.1.0 --android-code 10100 [--notes notes.txt] [--output release/stable.json]');
  values.set(key, value);
}
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const androidVersion = values.get('--android-version');
const androidCode = Number(values.get('--android-code'));
for (const item of [version, androidVersion]) if (typeof item !== 'string' || !/^\d+\.\d+\.\d+$/.test(item)) throw new Error('Release versions must be stable major.minor.patch values.');
if (!Number.isSafeInteger(androidCode) || androidCode < 1) throw new Error('Android version code is required.');
const notes = values.has('--notes') ? fs.readFileSync(values.get('--notes'), 'utf8').replace(/^\uFEFF/, '').trim() : '改进体验与稳定性。升级保留原账本数据。';
if (notes.length > 4000) throw new Error('Release notes exceed 4000 characters.');
function artifact(source, name, max) {
  if (!source) throw new Error('Both release artifact paths are required.');
  const file = path.resolve(source);
  const bytes = fs.readFileSync(file);
  if (bytes.length < 1000 || bytes.length > max) throw new Error('Unexpected release artifact size: ' + path.basename(file));
  return { url: `https://github.com/${repository}/releases/download/v${version}/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, notes };
}
const payload = {
  schema: 1, repository, publishedAt: new Date().toISOString(),
  windows: { version, ...artifact(values.get('--windows'), `SuperLedger-Setup-${version}.exe`, 300 * 1024 * 1024) },
  android: { version: androidVersion, versionCode: androidCode, ...artifact(values.get('--android'), `SuperLedger-Mobile-${androidVersion}.apk`, 100 * 1024 * 1024),
    packageName: 'com.moneylab.superledger.mobile', certificateSha256: 'fd5a4af713362682fd1fe4e638decb05077b4ec672966ce3bd75b80558d7e785', minSdk: 26 },
};
const privatePath = path.resolve(process.env.LEDGER_UPDATE_SIGNING_KEY || path.join(root, '.release-signing', 'update-signing-private.pem'));
if (!fs.existsSync(privatePath)) throw new Error('Restore the original private update-signing key before publishing. Do not generate a replacement key for existing installations.');
const privateKey = createPrivateKey(fs.readFileSync(privatePath));
const publicKey = fs.readFileSync(path.join(root, 'assets', 'update-public-key.pem'));
const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
const signature = sign('RSA-SHA256', encoded, privateKey);
if (!verify('RSA-SHA256', encoded, publicKey, signature)) throw new Error('Signing identity does not match the key trusted by installed applications.');
const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
if (!derived.equals(fs.readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'res', 'raw', 'update_public_key.der')))) throw new Error('Android and desktop update trust keys differ.');
const output = path.resolve(values.get('--output') || path.join(root, 'release', 'stable.json'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ schema: 1, payload: encoded.toString('base64'), signature: signature.toString('base64') }, null, 2) + '\n');
console.log(JSON.stringify({ output, repository, desktopVersion: version, androidVersion, androidCode, windowsSha256: payload.windows.sha256, androidSha256: payload.android.sha256 }, null, 2));
