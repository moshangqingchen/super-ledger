import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeInitialState, validateState } from '../engine.mjs';

const require = createRequire(import.meta.url);
const { migrateLegacyData } = require('../desktop/migrate.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'money-lab-迁移-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, legacy: path.join(root, '旧版账本 data'), destination: path.join(root, '桌面版数据') };
}

function writeLedger(directory, state = makeInitialState('2026-11-05')) {
  fs.mkdirSync(directory, { recursive: true });
  const raw = `\ufeff${JSON.stringify(state, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, 'ledger.json'), raw);
  return raw;
}

test('existing destination is never validated, changed, or replaced by legacy data', t => {
  const f = fixture(t);
  const destination = writeLedger(f.destination);
  writeLedger(f.legacy);
  fs.writeFileSync(path.join(f.legacy, 'ledger.lock.json'), JSON.stringify({ pid: process.pid }));
  const result = migrateLegacyData({ destinationDirectory: f.destination, legacyDirectories: [f.legacy], validate() { assert.fail('must not read legacy data'); } });
  assert.deepEqual(result, { migrated: false });
  assert.equal(fs.readFileSync(path.join(f.destination, 'ledger.json'), 'utf8'), destination);
  assert.deepEqual(fs.readdirSync(f.destination), ['ledger.json']);
});

test('a new user with no legacy file gets no manufactured ledger or metadata', t => {
  const f = fixture(t);
  const result = migrateLegacyData({ destinationDirectory: f.destination, legacyDirectories: [f.legacy], validate: validateState });
  assert.deepEqual(result, { migrated: false });
  assert.equal(fs.existsSync(f.destination), false);
});

test('valid source is preserved byte-for-byte with an independent backup and migration metadata', t => {
  const f = fixture(t);
  const source = writeLedger(f.legacy);
  fs.writeFileSync(path.join(f.legacy, '.ledger.lock'), 'old process lock');
  const result = migrateLegacyData({ destinationDirectory: f.destination, legacyDirectories: [path.join(f.root, 'missing'), f.legacy], validate: validateState });
  assert.equal(result.migrated, true);
  assert.equal(result.source, path.join(f.legacy, 'ledger.json'));
  assert.equal(fs.readFileSync(result.source, 'utf8'), source);
  assert.equal(fs.readFileSync(path.join(f.destination, 'ledger.json'), 'utf8'), source);
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), source);
  assert.equal(fs.existsSync(path.join(f.destination, '.ledger.lock')), false);
  const metadata = JSON.parse(fs.readFileSync(path.join(f.destination, 'migration.json'), 'utf8'));
  assert.equal(metadata.source, result.source);
  assert.equal(metadata.backupPath, result.backupPath);
  assert.equal(metadata.destination, path.join(f.destination, 'ledger.json'));
  assert.equal(metadata.bytes, Buffer.byteLength(source));
  assert.match(metadata.migratedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readdirSync(f.destination).some(name => name.endsWith('.tmp')), false);
  // The backup must not share the ledger's inode: even a manual in-place edit
  // to the migrated ledger cannot corrupt its independent migration backup.
  fs.writeFileSync(path.join(f.destination, 'ledger.json'), 'changed later');
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), source);
  assert.equal(fs.readFileSync(result.source, 'utf8'), source);
});

test('a corrupt earlier source stops migration without silently selecting a later valid source', t => {
  const f = fixture(t);
  fs.mkdirSync(f.legacy, { recursive: true });
  const source = path.join(f.legacy, 'ledger.json');
  fs.writeFileSync(source, '{broken original data');
  const other = path.join(f.root, 'another source');
  writeLedger(other);
  assert.throws(() => migrateLegacyData({ destinationDirectory: f.destination, legacyDirectories: [f.legacy, other], validate: validateState }), error => {
    assert.equal(error.code, 'INVALID_LEGACY_LEDGER');
    assert.equal(error.errors[0].source, source);
    return true;
  });
  assert.equal(fs.readFileSync(source, 'utf8'), '{broken original data');
  assert.equal(fs.existsSync(path.join(f.destination, 'ledger.json')), false);
});

test('valid JSON that fails ledger validation is rejected before any destination write', t => {
  const f = fixture(t);
  writeLedger(f.legacy, { schemaVersion: 1, accounts: [] });
  assert.throws(() => migrateLegacyData({ destinationDirectory: f.destination, legacyDirectories: [f.legacy], validate: validateState }), { code: 'INVALID_LEGACY_LEDGER' });
  assert.equal(fs.existsSync(f.destination), false);
});

test('sources larger than 2 MB are rejected before parsing or creating data', t => {
  const f = fixture(t);
  fs.mkdirSync(f.legacy, { recursive: true });
  fs.writeFileSync(path.join(f.legacy, 'ledger.json'), Buffer.alloc(2 * 1024 * 1024 + 1, 32));
  assert.throws(() => migrateLegacyData({ destinationDirectory: f.destination, legacyDirectories: [f.legacy], validate() { assert.fail('oversized file must not be parsed'); } }), /超过 2 MB/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('a destination created while the source is validated wins without being overwritten', t => {
  const f = fixture(t);
  writeLedger(f.legacy);
  const concurrentState = makeInitialState('2026-11-05');
  concurrentState.revision = 99;
  let winner;
  const result = migrateLegacyData({ destinationDirectory: f.destination, legacyDirectories: [f.legacy], validate(value) {
    validateState(value);
    winner = writeLedger(f.destination, concurrentState);
  } });
  assert.equal(result.migrated, false);
  assert.equal(fs.readFileSync(path.join(f.destination, 'ledger.json'), 'utf8'), winner);
});

test('exclusive hard-link publication loses a last-moment race safely and retains its backup', t => {
  const f = fixture(t);
  const original = writeLedger(f.legacy);
  const link = fs.linkSync;
  const winner = JSON.stringify({ winner: 'another process' });
  fs.linkSync = (source, destination) => {
    fs.writeFileSync(destination, winner, { flag: 'wx' });
    return link(source, destination);
  };
  let result;
  try { result = migrateLegacyData({ destinationDirectory: f.destination, legacyDirectories: [f.legacy], validate: validateState }); }
  finally { fs.linkSync = link; }
  assert.equal(result.migrated, false);
  assert.equal(fs.readFileSync(path.join(f.destination, 'ledger.json'), 'utf8'), winner);
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(f.destination, 'migration.json')), false);
  assert.equal(fs.readdirSync(f.destination).some(name => name.endsWith('.tmp')), false);
});

test('unsupported atomic publication fails closed and leaves source and backup intact', t => {
  const f = fixture(t);
  const source = writeLedger(f.legacy);
  const link = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error('Hard links unsupported'), { code: 'ENOTSUP' }); };
  let failure;
  try {
    assert.throws(() => migrateLegacyData({ destinationDirectory: f.destination, legacyDirectories: [f.legacy], validate: validateState }), error => { failure = error; return error.code === 'LEDGER_MIGRATION_FAILED'; });
  } finally { fs.linkSync = link; }
  assert.equal(failure.migrated, false);
  assert.equal(fs.readFileSync(failure.backupPath, 'utf8'), source);
  assert.equal(fs.readFileSync(path.join(f.legacy, 'ledger.json'), 'utf8'), source);
  assert.equal(fs.existsSync(path.join(f.destination, 'ledger.json')), false);
  assert.equal(fs.readdirSync(f.destination).some(name => name.endsWith('.tmp')), false);
});

test('an active legacy process blocks migration before source parsing or validation and preserves its lock', t => {
  const f = fixture(t);
  fs.mkdirSync(f.legacy, { recursive: true });
  const source = path.join(f.legacy, 'ledger.json');
  fs.writeFileSync(source, '{must not be parsed while the old app runs');
  const lockPath = path.join(f.legacy, 'ledger.lock.json');
  const lock = JSON.stringify({ pid: process.pid, token: 'active-owner', port: 4317 });
  fs.writeFileSync(lockPath, lock);
  assert.throws(() => migrateLegacyData({ destinationDirectory: f.destination, legacyDirectories: [f.legacy], validate() { assert.fail('running legacy data must not be validated'); } }), error => {
    assert.equal(error.code, 'LEGACY_LEDGER_RUNNING');
    assert.match(error.message, /请先关闭旧版账本后重试/);
    assert.equal(error.errors[0].source, lockPath);
    return true;
  });
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lock);
  assert.equal(fs.readFileSync(source, 'utf8'), '{must not be parsed while the old app runs');
  assert.equal(fs.existsSync(f.destination), false);
});

test('only a process positively confirmed ESRCH allows migration with the stale lock left untouched', t => {
  const f = fixture(t);
  const source = writeLedger(f.legacy);
  const lockPath = path.join(f.legacy, 'ledger.lock.json');
  const legacyPid = 2147483000;
  const lock = JSON.stringify({ pid: legacyPid, token: 'stale-owner', port: 4317 });
  fs.writeFileSync(lockPath, lock);
  const kill = process.kill;
  process.kill = (pid, signal) => {
    assert.equal(pid, legacyPid);
    assert.equal(signal, 0);
    throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
  };
  let result;
  try { result = migrateLegacyData({ destinationDirectory: f.destination, legacyDirectories: [f.legacy], validate: validateState }); }
  finally { process.kill = kill; }
  assert.equal(result.migrated, true);
  assert.equal(fs.readFileSync(path.join(f.destination, 'ledger.json'), 'utf8'), source);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lock);
  assert.equal(fs.existsSync(path.join(f.destination, 'ledger.lock.json')), false);
});

test('unverifiable process status fails closed instead of assuming the lock is stale', t => {
  const f = fixture(t);
  writeLedger(f.legacy);
  const lockPath = path.join(f.legacy, 'ledger.lock.json');
  const lock = JSON.stringify({ pid: 2147483000, token: 'unknown-owner' });
  fs.writeFileSync(lockPath, lock);
  const kill = process.kill;
  process.kill = () => { throw Object.assign(new Error('Access denied'), { code: 'EPERM' }); };
  try {
    assert.throws(() => migrateLegacyData({ destinationDirectory: f.destination, legacyDirectories: [f.legacy], validate() { assert.fail('unverified process must block validation'); } }), error => {
      assert.equal(error.code, 'LEGACY_LEDGER_RUNNING');
      assert.match(error.message, /请先关闭旧版账本后重试/);
      assert.equal(error.errors[0].code, 'EPERM');
      return true;
    });
  } finally { process.kill = kill; }
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lock);
  assert.equal(fs.existsSync(f.destination), false);
});

test('malformed lock JSON and invalid process IDs stop migration without modifying either file', t => {
  const f = fixture(t);
  const source = writeLedger(f.legacy);
  const lockPath = path.join(f.legacy, 'ledger.lock.json');
  for (const lock of ['{broken', '{}', 'null', '[]', '{"pid":0}', '{"pid":-2}', '{"pid":1.5}', '{"pid":"123"}', '{"pid":2147483648}']) {
    fs.writeFileSync(lockPath, lock);
    assert.throws(() => migrateLegacyData({ destinationDirectory: f.destination, legacyDirectories: [f.legacy], validate() { assert.fail('invalid lock must block validation'); } }), error => {
      assert.equal(error.code, 'INVALID_LEGACY_LOCK');
      assert.match(error.message, /请先关闭旧版账本后重试/);
      return true;
    });
    assert.equal(fs.readFileSync(lockPath, 'utf8'), lock);
    assert.equal(fs.readFileSync(path.join(f.legacy, 'ledger.json'), 'utf8'), source);
    assert.equal(fs.existsSync(f.destination), false);
  }
});
