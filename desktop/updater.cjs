'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const REPOSITORY = 'moshangqingchen/super-ledger';
const MANIFEST_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/updates/stable.json`;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const VERSION = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function cancelled() { return Object.assign(new Error('更新下载已取消，当前版本和账本保持不变。'), { code: 'ABORT_ERR' }); }
function assertVersion(version) { if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('更新版本号无效。'); return version.split('.').map(Number); }
function compareVersions(left, right) {
  const a = assertVersion(left), b = assertVersion(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
function base64(value, maxBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > maxBytes * 2) throw new Error('更新签名格式无效。');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== value) throw new Error('更新签名编码无效。');
  return bytes;
}
function installerUrl(version) { assertVersion(version); return `https://github.com/${REPOSITORY}/releases/download/v${version}/SuperLedger-Setup-${version}.exe`; }
function verifySignedManifest(envelope, publicKey) {
  if (!object(envelope) || envelope.schema !== 1) throw new Error('不支持此更新清单格式。');
  const payload = base64(envelope.payload, MAX_MANIFEST_BYTES), signature = base64(envelope.signature, 1024);
  const key = crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('更新验证公钥无效。');
  if (!crypto.verify('RSA-SHA256', payload, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature)) throw new Error('更新清单签名验证失败，已停止更新。');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); }
  catch { throw new Error('签名更新清单内容无效。'); }
  if (!object(value) || value.schema !== 1 || value.repository !== REPOSITORY || typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))) throw new Error('更新清单仓库或发布日期无效。');
  const update = value.windows;
  if (!object(update)) throw new Error('更新清单缺少 Windows 安装包。');
  assertVersion(update.version);
  if (update.url !== installerUrl(update.version)) throw new Error('更新安装包地址不属于固定仓库的对应版本。');
  if (typeof update.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(update.sha256) || !Number.isSafeInteger(update.size) || update.size < 64 * 1024 || update.size > MAX_INSTALLER_BYTES) throw new Error('更新安装包的大小或 SHA-256 无效。');
  if (typeof update.notes !== 'string' || update.notes.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(update.notes)) throw new Error('更新说明格式无效。');
  return { version: update.version, url: update.url, sha256: update.sha256, size: update.size, notes: update.notes, publishedAt: value.publishedAt };
}

function validateTransportUrl(input, manifestOnly = false) {
  if (typeof input !== 'string' || input.length > 8192) throw new Error('更新请求地址无效。');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443') throw new Error('更新请求必须使用已验证的 HTTPS 来源。');
  if (input === MANIFEST_URL) return url;
  if (manifestOnly || !DOWNLOAD_HOSTS.has(url.hostname)) throw new Error('更新地址不在固定来源列表中。');
  if (url.hostname === 'github.com' && !new RegExp(`^/${REPOSITORY}/releases/download/v[0-9]+\\.[0-9]+\\.[0-9]+/SuperLedger-Setup-[0-9]+\\.[0-9]+\\.[0-9]+\\.exe$`).test(url.pathname)) throw new Error('更新重定向离开了固定仓库。');
  return url;
}

/** The only outbound dial is CONNECT to 127.0.0.1:10090; no direct fallback exists. */
function proxyTransfer(input, { signal, maxBytes = MAX_MANIFEST_BYTES, timeoutMs = 20000, onChunk } = {}) {
  let target;
  try { target = validateTransportUrl(input); }
  catch (error) { return Promise.reject(error); }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_INSTALLER_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) return Promise.reject(new Error('更新请求限制无效。'));
  return new Promise((resolve, reject) => {
    let settled = false, connect, tunnel, secure, request, response, agent;
    const finish = (error, result) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      response?.destroy(); request?.destroy(); agent?.destroy(); secure?.destroy(); tunnel?.destroy(); connect?.destroy();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(new Error('更新连接超时，已停止代理请求。')), timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      connect = http.request({ hostname: '127.0.0.1', port: 10090, method: 'CONNECT', path: `${target.hostname}:443`, agent: false, headers: { Host: `${target.hostname}:443` } });
      connect.once('error', () => finish(new Error('无法连接本机代理 127.0.0.1:10090，未尝试直连。')));
      connect.once('connect', (reply, socket, head) => {
        tunnel = socket;
        if (settled) { socket.destroy(); return; }
        if (reply.statusCode !== 200 || head.length) { finish(new Error('本机代理未建立安全更新隧道。')); return; }
        socket.once('error', () => finish(new Error('更新代理连接中断。')));
        secure = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
        secure.once('error', () => finish(new Error('更新来源的 TLS 验证或连接失败。')));
        secure.once('secureConnect', () => {
          if (settled) return;
          if (!secure.authorized) { finish(new Error('更新来源证书验证失败。')); return; }
          agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
          // The agent can only return the existing verified proxy tunnel.
          agent.createConnection = () => secure;
          request = https.request({ hostname: target.hostname, port: 443, path: target.pathname + target.search, method: 'GET', agent,
            headers: { Accept: 'application/octet-stream, application/json, text/plain', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache', 'User-Agent': 'SuperLedger-Signed-Updater/1' } }, incoming => {
            response = incoming;
            const statusCode = incoming.statusCode, headers = incoming.headers;
            if ([301, 302, 303, 307, 308].includes(statusCode)) { finish(null, { statusCode, headers, bytes: 0, body: Buffer.alloc(0) }); return; }
            if (statusCode !== 200) { finish(new Error(`更新来源返回 HTTP ${statusCode}，当前版本保持不变。`)); return; }
            if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') { finish(new Error('更新来源返回了不支持的压缩数据。')); return; }
            if (Number(headers['content-length'] || 0) > maxBytes) { finish(new Error('更新响应超过预期大小。')); return; }
            let bytes = 0; const chunks = [];
            incoming.on('data', chunk => {
              if (settled) return;
              try {
                bytes += chunk.length;
                if (bytes > maxBytes) throw new Error('更新响应超过预期大小。');
                if (onChunk) onChunk(chunk); else chunks.push(chunk);
              } catch (error) { finish(error); }
            });
            incoming.once('error', () => finish(new Error('更新响应读取失败。')));
            incoming.once('aborted', () => finish(new Error('更新响应未完整接收。')));
            incoming.once('end', () => finish(null, { statusCode, headers, bytes, body: onChunk ? null : Buffer.concat(chunks) }));
          });
          request.once('error', () => finish(new Error('更新请求中断，未尝试其他网络出口。')));
          request.setTimeout?.(30000, () => finish(new Error('更新连接长时间无响应。')));
          request.end();
        });
      });
      connect.end();
    } catch { finish(new Error('无法建立更新代理请求，未尝试直连。')); }
  });
}

async function verifyInstaller(filename, expected) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.size) throw new Error('安装包大小验证失败，请重新下载。');
  const digest = crypto.createHash('sha256'); let first = true;
  for await (const chunk of fs.createReadStream(filename)) {
    if (first && (chunk.length < 2 || chunk[0] !== 0x4d || chunk[1] !== 0x5a)) throw new Error('下载内容不是有效的 Windows 安装包。');
    first = false; digest.update(chunk);
  }
  if (digest.digest('hex') !== expected.sha256) throw new Error('安装包 SHA-256 验证失败，已阻止安装。');
  return true;
}

function spawnInstaller(filename) {
  return new Promise((resolve, reject) => {
    // Verified against electron-builder 26.15.3 NSIS templates: /S skips the
    // wizard, --updated retains update semantics/data, and --force-run starts
    // the updated app after a silent assisted install. NSIS reuses InstallLocation.
    const child = spawn(filename, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.once('error', () => reject(new Error('安装器未能启动，当前应用继续运行。')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function createUpdater({ currentVersion, userDataDirectory, publicKey, enabled = true, request = proxyTransfer, launchInstaller = spawnInstaller, onStatus = () => {}, now = Date.now } = {}) {
  assertVersion(currentVersion);
  if (!path.isAbsolute(userDataDirectory) || !publicKey) throw new Error('更新器配置不完整。');
  const directory = path.join(userDataDirectory, 'updates'), preferences = path.join(directory, 'update-state.json');
  let closed = false, checking = null, downloading = null, installing = false, controller, candidate = null, readyFile = null;
  let phase = 'idle', error = '', downloadedBytes = 0, lastCheckedAt = null, deferredVersion = '', deferredUntil = 0, highestVersion = currentVersion;
  function ensureDirectory() {
    fs.mkdirSync(userDataDirectory, { recursive: true });
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('更新目录不能是目录链接。');
    fs.mkdirSync(directory, { recursive: true });
    if (path.dirname(fs.realpathSync.native(directory)).toLowerCase() !== fs.realpathSync.native(userDataDirectory).toLowerCase()) throw new Error('更新目录不在当前应用数据目录中。');
  }
  try {
    const stat = fs.lstatSync(preferences);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('invalid preferences');
    const saved = JSON.parse(fs.readFileSync(preferences, 'utf8'));
    if (typeof saved.deferredVersion === 'string' && VERSION.test(saved.deferredVersion) && Number.isSafeInteger(saved.deferredUntil) && saved.deferredUntil <= now() + PROMPT_COOLDOWN_MS) { deferredVersion = saved.deferredVersion; deferredUntil = saved.deferredUntil; }
    if (typeof saved.highestVersion === 'string' && VERSION.test(saved.highestVersion) && compareVersions(saved.highestVersion, highestVersion) > 0) highestVersion = saved.highestVersion;
  } catch { /* A missing/broken reminder preference cannot authorize an update. */ }
  const status = () => ({ enabled: Boolean(enabled) && !closed, currentVersion, phase, error, lastCheckedAt, availableVersion: candidate?.version || null, notes: candidate?.notes || '', downloadedBytes, totalBytes: candidate?.size || 0, ready: Boolean(readyFile), deferredUntil });
  function emit() { try { onStatus(status()); } catch { /* UI listeners cannot change update state. */ } }
  function persist() {
    ensureDirectory();
    const temporary = path.join(directory, `state-${crypto.randomUUID()}.tmp`);
    try { fs.writeFileSync(temporary, JSON.stringify({ deferredVersion, deferredUntil, highestVersion }), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, preferences); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  function available() { if (!enabled || closed) throw new Error('当前为开发或隔离测试模式，联网更新已关闭。'); }
  async function check() {
    available();
    if (checking) return checking;
    if (downloading || installing) return status();
    checking = Promise.resolve().then(async () => {
      phase = 'checking'; error = ''; emit();
      controller = new AbortController();
      try {
        const result = await request(MANIFEST_URL, { signal: controller.signal, maxBytes: MAX_MANIFEST_BYTES, timeoutMs: 20000 });
        if (closed) throw cancelled();
        if (result.statusCode !== 200) throw new Error('更新清单不允许重定向。');
        const update = verifySignedManifest(JSON.parse(result.body.toString('utf8')), publicKey);
        if (compareVersions(update.version, highestVersion) < 0) throw new Error('更新清单版本早于已验证版本，已拒绝回退。');
        highestVersion = update.version; lastCheckedAt = now();
        if (compareVersions(update.version, currentVersion) <= 0) { candidate = null; readyFile = null; downloadedBytes = 0; phase = 'idle'; }
        else {
          if (candidate?.sha256 !== update.sha256 || candidate?.version !== update.version) { readyFile = null; downloadedBytes = 0; }
          candidate = update; phase = readyFile ? 'ready' : 'available';
        }
        persist();
      } catch (failure) { error = failure.message; phase = 'error'; }
      finally { controller = null; checking = null; emit(); }
      return status();
    });
    return checking;
  }
  async function download() {
    available();
    if (downloading) return downloading;
    if (checking || installing || !candidate) throw new Error('请先完成更新检查。');
    const update = { ...candidate };
    downloading = Promise.resolve().then(async () => {
      let temporary, fd;
      phase = 'downloading'; error = ''; downloadedBytes = 0; controller = new AbortController(); emit();
      try {
        ensureDirectory();
        const target = path.join(directory, `SuperLedger-Setup-${update.version}.exe`);
        if (fs.existsSync(target)) {
          try {
            await verifyInstaller(target, update);
            if(closed||controller.signal.aborted)throw cancelled();
            readyFile = target; downloadedBytes = update.size; phase = 'ready'; return status();
          } catch(failure) { if(failure.code==='ABORT_ERR')throw failure;if (fs.lstatSync(target).isSymbolicLink()) throw new Error('安装包缓存不能是文件链接。'); }
        }
        temporary = path.join(directory, `download-${crypto.randomUUID()}.partial`); fd = fs.openSync(temporary, 'wx', 0o600);
        let url = update.url, response, lastProgress = 0;
        for (let redirects = 0; redirects <= 5; redirects++) {
          validateTransportUrl(url);
          response = await request(url, { signal: controller.signal, maxBytes: update.size, timeoutMs: 20 * 60 * 1000, onChunk(chunk) {
            let offset = 0; while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
            downloadedBytes += chunk.length;
            if (downloadedBytes > update.size) throw new Error('安装包超过清单声明的大小。');
            if (now() - lastProgress >= 200) { lastProgress = now(); emit(); }
          } });
          if (response.statusCode === 200) break;
          if (![301, 302, 303, 307, 308].includes(response.statusCode) || !response.headers.location || redirects === 5) throw new Error('安装包重定向无效或次数过多。');
          const next = new URL(response.headers.location, url).href;
          validateTransportUrl(next);
          if (next === MANIFEST_URL) throw new Error('安装包不能跳转到更新清单。');
          url = next;
        }
        if (closed || controller.signal.aborted) throw cancelled();
        if (downloadedBytes !== update.size) throw new Error('安装包未完整下载，当前版本保持不变。');
        fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        await verifyInstaller(temporary, update);
        if (closed || controller.signal.aborted) throw cancelled();
        fs.renameSync(temporary, target); temporary = null;
        readyFile = target; phase = 'ready';
      } catch (failure) { readyFile = null; error = failure.message; phase = failure.code === 'ABORT_ERR' ? 'available' : 'error'; }
      finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch {}
        if (temporary) try { fs.unlinkSync(temporary); } catch {}
        controller = null; downloading = null; emit();
      }
      return status();
    });
    return downloading;
  }
  function cancelDownload() { if (downloading) controller?.abort(); return status(); }
  function defer() { if (candidate) { deferredVersion = candidate.version; deferredUntil = now() + PROMPT_COOLDOWN_MS; persist(); emit(); } return status(); }
  function shouldPrompt() { return Boolean(enabled && !closed && candidate && ['available', 'ready'].includes(phase) && (deferredVersion !== candidate.version || now() >= deferredUntil)); }
  async function install() {
    available();
    if (installing || downloading || checking || !readyFile || !candidate) throw new Error('请先下载并验证新版本。');
    installing = true; phase = 'installing'; error = ''; emit();
    try {
      if (compareVersions(candidate.version, currentVersion) <= 0) throw new Error('不能安装相同或更早版本。');
      try { await verifyInstaller(readyFile, candidate); }
      catch(failure) {readyFile=null;throw failure;}
      if (closed) throw cancelled();
      await launchInstaller(readyFile);
      return true;
    } catch (failure) { error = failure.message; phase = 'error'; throw failure; }
    finally { installing = false; emit(); }
  }
  function close() { closed = true; controller?.abort(); }
  return { status, check, download, cancelDownload, defer, shouldPrompt, install, close };
}

module.exports = { REPOSITORY, MANIFEST_URL, CHECK_INTERVAL_MS, PROMPT_COOLDOWN_MS, compareVersions, installerUrl, verifySignedManifest, validateTransportUrl, proxyTransfer, verifyInstaller, createUpdater, spawnInstaller };
