import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { verifySignedManifest, compareVersions } = createRequire(import.meta.url)('../desktop/updater.cjs');
const { registeredSources } = createRequire(import.meta.url)('../desktop/update-sources.cjs');

const repository = 'moshangqingchen/super-ledger';
const maxInstallerBytes = 512 * 1024 * 1024;
const maxManifestBytes = 128 * 1024;

/** A Windows-only release retains every field of the signed Android release. */
export function windowsUpdatePayload({ baseEnvelope, publicKey, version, installerBytes, notes, publishedAt = new Date().toISOString() }) {
  const previous = verifySignedManifest(baseEnvelope, publicKey);
  const base = JSON.parse(Buffer.from(baseEnvelope.payload, 'base64').toString('utf8'));
  if (!base.android || typeof base.android !== 'object' || Array.isArray(base.android)) throw new Error('The signed base must contain the Android release to preserve.');
  if (compareVersions(version, previous.version) <= 0) throw new Error('The Windows version must strictly increase.');
  if (!Buffer.isBuffer(installerBytes) || installerBytes.length < 64 * 1024 || installerBytes.length > maxInstallerBytes || installerBytes[0] !== 0x4d || installerBytes[1] !== 0x5a) throw new Error('Expected a bounded Windows MZ installer.');
  if (typeof notes !== 'string' || !notes.trim() || notes.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(notes)) throw new Error('Windows release notes are missing or invalid.');
  if (typeof publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt))) throw new Error('Invalid release timestamp.');
  const result = { ...base, publishedAt, windows: {
    version, url: `https://github.com/${repository}/releases/download/v${version}/SuperLedger-Setup-${version}.exe`,
    sha256: createHash('sha256').update(installerBytes).digest('hex'), size: installerBytes.length, notes: notes.trim(),
  } };
  result.windows.sources = registeredSources(result.windows.url).map(({ id, url }) => ({ id, url }));
  return result;
}

/** Sign with the existing identity, checking both installed platforms' trust keys. */
export function signedWindowsUpdateManifest({ privateKey, androidPublicKey, ...options }) {
  const payload = windowsUpdatePayload(options);
  const signingKey = createPrivateKey(privateKey);
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign('RSA-SHA256', bytes, signingKey);
  if (!verify('RSA-SHA256', bytes, options.publicKey, signature)) throw new Error('Signing key does not match the installed update trust key.');
  const derived = createPublicKey(signingKey).export({ type: 'spki', format: 'der' });
  if (!Buffer.isBuffer(androidPublicKey) || !derived.equals(androidPublicKey)) throw new Error('Android and desktop update trust keys differ.');
  const envelope = { schema: 1, payload: bytes.toString('base64'), signature: signature.toString('base64') };
  verifySignedManifest(envelope, options.publicKey);
  if (Buffer.byteLength(JSON.stringify(envelope)) > maxManifestBytes) throw new Error('Candidate manifest exceeds maximum size.');
  return envelope;
}

// Resolve existing ancestors as well as the file itself, so a junction/symlink
// cannot disguise the live feed or the signed base as a candidate output.
function canonicalPath(filename) {
  let current = path.resolve(filename);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(fs.realpathSync(current), ...suffix).toLowerCase();
}

export function windowsCandidateOutput({ root, version, baseFile, output }) {
  compareVersions(version, version);
  const candidate = path.resolve(output || path.join(root, 'release', `stable-windows-${version}.json`));
  if (canonicalPath(candidate) === canonicalPath(baseFile)) throw new Error('Write a separate candidate manifest; do not overwrite the signed base.');
  if (canonicalPath(candidate) === canonicalPath(path.join(root, 'updates', 'stable.json'))) throw new Error('Do not write the public updates/stable.json feed; publish the candidate only after the release is available.');
  return candidate;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const values = new Map(), allowed = ['--base-manifest', '--windows', '--notes', '--output'];
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index], value = process.argv[index + 1];
    if (!allowed.includes(flag) || !value || value.startsWith('--') || values.has(flag)) throw new Error('Use --base-manifest signed.json --windows installer.exe --notes notes.md [--output candidate.json]');
    values.set(flag, value);
  }
  if (['--base-manifest', '--windows', '--notes'].some(flag => !values.has(flag))) throw new Error('--base-manifest, --windows and --notes are required.');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const baseFile = path.resolve(values.get('--base-manifest'));
  const output = windowsCandidateOutput({ root, version, baseFile, output: values.get('--output') });
  const baseBytes = fs.readFileSync(baseFile);
  if (baseBytes.length > maxManifestBytes) throw new Error('Base manifest exceeds maximum size.');
  const installerFile = path.resolve(values.get('--windows'));
  if (fs.statSync(installerFile).size > maxInstallerBytes) throw new Error('Windows installer exceeds maximum size.');
  const publicKey = fs.readFileSync(path.join(root, 'assets/update-public-key.pem'));
  const options = { baseEnvelope: JSON.parse(baseBytes.toString('utf8')), publicKey, version,
    installerBytes: fs.readFileSync(installerFile), notes: fs.readFileSync(values.get('--notes'), 'utf8').replace(/^\uFEFF/, '') };
  // Validate artifact and metadata before opening the local signing material.
  windowsUpdatePayload(options);
  const privatePath = path.resolve(process.env.LEDGER_UPDATE_SIGNING_KEY || path.join(root, '.release-signing/update-signing-private.pem'));
  if (!fs.existsSync(privatePath)) throw new Error('Restore the original private update-signing key before publishing. Do not generate a replacement key for existing installations.');
  const envelope = signedWindowsUpdateManifest({ ...options, privateKey: fs.readFileSync(privatePath),
    androidPublicKey: fs.readFileSync(path.join(root, 'android/app/src/main/res/raw/update_public_key.der')) });
  // A concurrent platform release must not be overwritten by a stale candidate.
  if (!fs.readFileSync(baseFile).equals(baseBytes)) throw new Error('The signed base changed during generation; regenerate from the latest base.');
  windowsCandidateOutput({ root, version, baseFile, output });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(envelope, null, 2) + '\n');
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  console.log(JSON.stringify({ output, windowsVersion: payload.windows.version, windowsSha256: payload.windows.sha256,
    androidPreserved: payload.android.version, androidCode: payload.android.versionCode, releaseTag: `v${version}` }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
