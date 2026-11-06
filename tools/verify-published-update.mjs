import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, createPublicKey, randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const updater = createRequire(import.meta.url)('../desktop/updater.cjs');
const manifestVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const args = process.argv.slice(2);
const options = { oldVersion: '1.5.0', currentVersion: manifestVersion };

function usage() {
  console.log(`Validate signed SuperLedger Windows updates without running an installer.

Online (fixed published source and fixed 127.0.0.1:10090 proxy):
  node tools/verify-published-update.mjs
  node tools/verify-published-update.mjs --old-version 1.5.0 --current-version 1.6.0

Offline before publishing (no network requests):
  node tools/verify-published-update.mjs --manifest release/stable.json --windows release/超级账本-安装-1.6.0.exe

The public key and repository cannot be overridden. All reports and online
download caches stay under artifacts/update-release. Installer launch is always
an injected recording stub; this script never executes the downloaded EXE.`);
}

function parseArgs() {
  const names = new Map([['--manifest', 'manifest'], ['--windows', 'windows'], ['--old-version', 'oldVersion'], ['--current-version', 'currentVersion']]);
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' && args.length === 1) { usage(); return false; }
    if (!names.has(flag) || seen.has(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unknown, repeated, or missing argument: ${flag}. Use --help.`);
    seen.add(flag); options[names.get(flag)] = args[++index];
  }
  if (Boolean(options.manifest) !== Boolean(options.windows)) throw new Error('--manifest and --windows must be supplied together; no network was requested.');
  updater.compareVersions(options.currentVersion, options.currentVersion);
  updater.compareVersions(options.oldVersion, options.oldVersion);
  if (updater.compareVersions(options.oldVersion, options.currentVersion) >= 0) throw new Error('--old-version must be strictly older than --current-version.');
  return true;
}

async function verify() {
  if (!parseArgs()) return;
  const mode = options.manifest ? 'offline' : 'online';
  const outputRoot = path.join(root, 'artifacts', 'update-release');
  const runDirectory = path.join(outputRoot, `${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(runDirectory, { recursive: true });
  const reportFile = path.join(runDirectory, 'report.json');
  const publicKey = fs.readFileSync(path.join(root, 'assets', 'update-public-key.pem'), 'utf8');
  const publicKeySha256 = createHash('sha256').update(createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
  const report = { success: false, mode, startedAt: new Date().toISOString(), repository: updater.REPOSITORY,
    manifestUrl: updater.MANIFEST_URL, publicKeySha256, oldVersion: options.oldVersion, currentVersion: options.currentVersion,
    installerExecuted: false, checks: [] };
  const services = [];
  let stage = 'initialize';
  const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  try {
    if (mode === 'offline') {
      stage = 'local manifest signature';
      const filename = path.resolve(options.manifest), size = fs.statSync(filename).size;
      if (size > 128 * 1024) throw new Error('Local signed manifest exceeds 128 KiB.');
      const update = updater.verifySignedManifest(JSON.parse(fs.readFileSync(filename, 'utf8')), publicKey);
      assert.equal(update.version, options.currentVersion, 'Signed Windows version must match the version being verified');
      report.checks.push('RSA-SHA256 signature and fixed repository/asset identity verified', 'Windows version matches expected current release');
      stage = 'local installer verification';
      const installerFile = path.resolve(options.windows);
      await updater.verifyInstaller(installerFile, update);
      report.checks.push('Local Windows installer MZ, exact length, and SHA-256 verified', 'No network requests made');
      report.windows = { version: update.version, size: update.size, sha256: update.sha256, localFile: installerFile };
    } else {
      const olderProfile = path.join(runDirectory, 'older-profile'), currentProfile = path.join(runDirectory, 'current-profile');
      const launches = [];
      let progressBucket = -1;
      const older = updater.createUpdater({ currentVersion: options.oldVersion, userDataDirectory: olderProfile, publicKey,
        enabled: true, request: updater.proxyTransfer,
        launchInstaller: async filename => {
          const relative = path.relative(path.join(olderProfile, 'updates'), path.resolve(filename));
          assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Installer stub receives only the isolated downloaded file');
          launches.push({ filename, simulated: true });
        },
        onStatus(value) {
          if (value.phase !== 'downloading' || !value.totalBytes) return;
          const bucket = Math.floor(value.downloadedBytes / value.totalBytes * 10);
          if (bucket !== progressBucket) { progressBucket = bucket; console.log(`Verified-source download: ${Math.min(bucket * 10, 100)}%`); }
        },
      });
      services.push(older);
      stage = 'published manifest check from older version';
      console.log(`Checking fixed published feed as Windows ${options.oldVersion} through the fixed local proxy.`);
      const available = await older.check();
      if (available.phase === 'error') throw new Error(available.error);
      assert.equal(available.phase, 'available', 'The older installed version must be offered an update');
      assert.equal(available.availableVersion, options.currentVersion, 'Published version must match expected release');
      report.checks.push('Published signed feed verified using real updater.proxyTransfer', 'Older installed version is offered exactly the expected Windows release');
      stage = 'published Windows installer download';
      const downloaded = await older.download();
      if (downloaded.phase !== 'ready') throw new Error(downloaded.error || 'Published installer did not become verified and ready.');
      assert.equal(downloaded.downloadedBytes, downloaded.totalBytes);
      report.checks.push('Published Windows asset downloaded via the fixed proxy and checked for length/MZ/SHA-256');
      stage = 'installer verification with non-executing stub';
      await older.install();
      assert.equal(launches.length, 1, 'The verified install path reaches the stub once');
      report.checks.push('Install re-verifies cached bytes and reaches a recording stub; no executable is launched');
      report.simulatedInstallerLaunch = launches[0];
      report.downloadedBytes = downloaded.downloadedBytes;
      stage = 'already-current version check';
      const current = updater.createUpdater({ currentVersion: options.currentVersion, userDataDirectory: currentProfile, publicKey,
        enabled: true, request: updater.proxyTransfer,
        launchInstaller: async () => { throw new Error('An already-current app must never reach installer launch.'); },
      });
      services.push(current);
      const latest = await current.check();
      if (latest.phase === 'error') throw new Error(latest.error);
      assert.equal(latest.phase, 'idle'); assert.equal(latest.availableVersion, null); assert.equal(latest.ready, false);
      report.checks.push('Already-current Windows version has no available update and no installer');
      report.profiles = { older: olderProfile, current: currentProfile };
    }
    report.success = true; report.completedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ success: true, mode, installerExecuted: false, report: reportFile }));
  } catch (failure) {
    report.failedStage = stage; report.error = failure.message; report.completedAt = new Date().toISOString(); save();
    console.error(JSON.stringify({ success: false, mode, stage, error: failure.message, report: reportFile }));
    process.exitCode = 1;
  } finally { for (const service of services) service.close(); }
}

verify().catch(error => { console.error(error.message); process.exitCode = 1; });
