'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_BYTES = 2 * 1024 * 1024;

function exists(filename) {
  try { fs.lstatSync(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function failure(message, source, cause, code = 'LEDGER_MIGRATION_FAILED') {
  const error = new Error(message, { cause });
  error.code = code;
  error.errors = [{ source, code: cause?.code || code, message: cause?.message || message }];
  return error;
}

function writeDurably(filename, bytes) {
  const descriptor = fs.openSync(filename, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function removeOwnTemporary(filename) {
  if (!filename) return;
  try { fs.unlinkSync(filename); }
  catch (error) { if (error.code !== 'ENOENT') { /* A leftover temporary is safer than deleting another file. */ } }
}

function assertLegacyStopped(source) {
  const lockPath = path.join(path.dirname(source), 'ledger.lock.json');
  let lock;
  try {
    if (!exists(lockPath)) return;
    const lockStat = fs.statSync(lockPath);
    if (!lockStat.isFile() || lockStat.size > 64 * 1024) throw new Error('旧版账本锁文件格式异常');
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)
        || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || lock.pid > 0x7fffffff) {
      throw new Error('旧版账本锁文件中的进程号不合法');
    }
  } catch (cause) {
    throw failure(`请先关闭旧版账本后重试。无法核实旧版账本锁，请检查 ${lockPath}；锁文件未修改。${cause.message}`, lockPath, cause, 'INVALID_LEGACY_LOCK');
  }

  try { process.kill(lock.pid, 0); }
  catch (cause) {
    // Only ESRCH positively confirms that the previous process no longer exists.
    // EPERM/EACCES and all other results must not be treated as a stale lock.
    if (cause.code === 'ESRCH') return;
    throw failure(`请先关闭旧版账本后重试。无法确认进程 ${lock.pid} 已退出；锁文件未修改。`, lockPath, cause, 'LEGACY_LEDGER_RUNNING');
  }
  throw failure(`请先关闭旧版账本后重试。旧版账本进程 ${lock.pid} 仍在运行；锁文件未修改。`, lockPath, undefined, 'LEGACY_LEDGER_RUNNING');
}

function readValidatedSource(source, validate) {
  let descriptor;
  try {
    descriptor = fs.openSync(source, 'r');
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new Error('旧账本路径不是普通文件');
    if (before.size > MAX_BYTES) throw new Error('旧账本超过 2 MB，未自动迁移');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('读取期间旧账本发生变化，请关闭旧账本后重试');
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('读取期间旧账本发生变化，请关闭旧账本后重试');
    }
    const parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    const valid = validate(parsed);
    if (valid && typeof valid.then === 'function') throw new Error('账本验证函数必须同步执行');
    if (valid === false) throw new Error('旧账本没有通过数据校验');
    return bytes;
  } catch (cause) {
    throw failure(`发现旧账本但无法安全迁移，原文件未修改：${source}。${cause.message}`, source, cause, 'INVALID_LEGACY_LEDGER');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/**
 * Synchronously migrate the first existing legacy ledger; never seed or overwrite data.
 * validate must synchronously throw (or return false) for invalid ledger state.
 *
 * Windows/NTFS publication: a complete, fsynced temporary file is hard-linked into
 * ledger.json. Creating that link is atomic and exclusive: an existing destination
 * produces EEXIST instead of replacing data. The backup has its own inode. We do
 * not fall back to rename (overwrites) or wx + writing (exposes incomplete JSON).
 * Unsupported filesystems fail closed, retaining the original and migration backup.
 */
function migrateLegacyData({ destinationDirectory, legacyDirectories = [], validate } = {}) {
  if (typeof destinationDirectory !== 'string' || !destinationDirectory.trim()) throw new TypeError('必须提供新账本数据目录');
  if (!Array.isArray(legacyDirectories) || legacyDirectories.some(value => typeof value !== 'string' || !value.trim())) {
    throw new TypeError('旧账本目录必须是路径字符串数组');
  }
  if (typeof validate !== 'function') throw new TypeError('必须提供同步账本验证函数');

  const destination = path.resolve(destinationDirectory);
  const ledgerPath = path.join(destination, 'ledger.json');
  // Include directories and dangling symlinks: nothing at this pathname is replaced.
  if (exists(ledgerPath)) return { migrated: false };

  let source;
  const seen = new Set();
  for (const directory of legacyDirectories) {
    const candidate = path.join(path.resolve(directory), 'ledger.json');
    const comparison = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(comparison)) continue;
    seen.add(comparison);
    try {
      if (exists(candidate)) { source = candidate; break; }
    } catch (cause) {
      throw failure(`无法检查旧账本，已停止迁移：${candidate}`, candidate, cause, 'INVALID_LEGACY_LEDGER');
    }
  }
  if (!source) return { migrated: false };

  // A damaged earlier source must stop startup; do not silently choose another
  // candidate or let the server create an empty ledger over the user's old data.
  // Check the legacy process before even reading or validating its ledger snapshot.
  // Never remove or migrate its lock, including locks confirmed to be stale.
  assertLegacyStopped(source);
  const bytes = readValidatedSource(source, validate);
  // Another launcher may have completed migration while validation ran.
  if (exists(ledgerPath)) return { migrated: false };

  const migratedAt = new Date().toISOString();
  const token = randomUUID();
  const stamp = migratedAt.replace(/[:.]/g, '-');
  const backupPath = path.join(destination, `ledger.before-migration.${stamp}.${token}.json`);
  const temporaryPath = path.join(destination, `.ledger.migration.${token}.tmp`);
  const metadataTemporary = path.join(destination, `.migration.${token}.tmp`);
  const metadataPath = path.join(destination, 'migration.json');
  let published = false;

  try {
    fs.mkdirSync(destination, { recursive: true });
    writeDurably(backupPath, bytes);
    writeDurably(temporaryPath, bytes);
    const metadata = {
      schemaVersion: 1, migratedAt, source, destination: ledgerPath, backupPath,
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    writeDurably(metadataTemporary, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));

    try { fs.linkSync(temporaryPath, ledgerPath); }
    catch (cause) {
      if (cause.code === 'EEXIST') return { migrated: false, source, backupPath };
      throw cause;
    }
    published = true;
    // Only the exclusive publication winner updates migration metadata.
    fs.renameSync(metadataTemporary, metadataPath);
    return { migrated: true, source, backupPath };
  } catch (cause) {
    const error = failure(
      published
        ? `账本已安全迁移，但迁移记录保存失败。原文件与备份均已保留：${cause.message}`
        : `无法安全写入新账本，已停止迁移。原文件未修改，已有备份保留：${cause.message}`,
      published ? metadataPath : source,
      cause,
      published ? 'MIGRATION_METADATA_FAILED' : 'LEDGER_MIGRATION_FAILED',
    );
    error.migrated = published;
    error.source = source;
    if (exists(backupPath)) error.backupPath = backupPath;
    throw error;
  } finally {
    removeOwnTemporary(temporaryPath);
    removeOwnTemporary(metadataTemporary);
  }
}

module.exports = { migrateLegacyData };
