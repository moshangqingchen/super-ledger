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
const DOWNLOAD_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000]);
const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const VERSION = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function cancelled() { return Object.assign(new Error('更新下载已取消，当前版本和账本保持不变。'), { code: 'ABORT_ERR' }); }
function transferError(message) { return Object.assign(new Error(message), { code: 'UPDATE_TRANSFER_INTERRUPTED' }); }
function retryable(failure) { return failure?.code === 'UPDATE_TRANSFER_INTERRUPTED' || TRANSIENT_NETWORK_CODES.has(failure?.code); }
function waitForRetry(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
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
function proxyTransfer(input, { signal, maxBytes = MAX_MANIFEST_BYTES, timeoutMs = 20000, rangeStart, onResponse, onChunk } = {}) {
  let target;
  try { target = validateTransportUrl(input); }
  catch (error) { return Promise.reject(error); }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_INSTALLER_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) return Promise.reject(new Error('更新请求限制无效。'));
  if (rangeStart !== undefined && (!Number.isSafeInteger(rangeStart) || rangeStart < 1 || rangeStart >= maxBytes || input === MANIFEST_URL)) return Promise.reject(new Error('更新续传偏移无效。'));
  return new Promise((resolve, reject) => {
    let settled = false, connect, tunnel, secure, request, response, agent;
    const finish = (error, result) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      response?.destroy(); request?.destroy(); agent?.destroy(); secure?.destroy(); tunnel?.destroy(); connect?.destroy();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(transferError('更新连接超时，已停止代理请求。')), timeoutMs);
    const idleTimeout = Math.min(timeoutMs, 30000);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      connect = http.request({ hostname: '127.0.0.1', port: 10090, method: 'CONNECT', path: `${target.hostname}:443`, agent: false, headers: { Host: `${target.hostname}:443` } });
      connect.once('error', () => finish(transferError('无法连接本机代理 127.0.0.1:10090，未尝试直连。')));
      connect.once('close', () => { if (!tunnel) finish(transferError('更新代理请求提前关闭。')); });
      connect.setTimeout?.(idleTimeout, () => finish(transferError('连接本机更新代理超时。')));
      connect.once('connect', (reply, socket, head) => {
        tunnel = socket;
        if (settled) { socket.destroy(); return; }
        if (reply.statusCode !== 200 || head.length) { finish(TRANSIENT_HTTP_STATUS.has(reply.statusCode) && !head.length ? transferError('本机代理暂时未能建立更新隧道。') : new Error('本机代理未建立安全更新隧道。')); return; }
        socket.once('error', () => finish(transferError('更新代理连接中断。')));
        socket.once('close', () => finish(transferError('更新代理连接提前关闭。')));
        // CONNECT hands the socket to TLS; only the TLS/HTTP idle timer may
        // monitor it from here, otherwise the unused raw socket can time out.
        socket.setTimeout?.(0);
        secure = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
        secure.once('error', failure => finish(TRANSIENT_NETWORK_CODES.has(failure.code) ? transferError('更新安全连接中断。') : new Error('更新来源的 TLS 验证失败。')));
        secure.once('close', () => finish(transferError('更新安全连接提前关闭。')));
        secure.setTimeout?.(idleTimeout, () => finish(transferError('更新安全连接长时间无响应。')));
        secure.once('secureConnect', () => {
          if (settled) return;
          if (!secure.authorized) { finish(new Error('更新来源证书验证失败。')); return; }
          agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
          // The agent can only return the existing verified proxy tunnel.
          agent.createConnection = () => secure;
          request = https.request({ hostname: target.hostname, port: 443, path: target.pathname + target.search, method: 'GET', agent,
            headers: { Accept: 'application/octet-stream, application/json, text/plain', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache', 'User-Agent': 'SuperLedger-Signed-Updater/1', ...(rangeStart === undefined ? {} : { Range: `bytes=${rangeStart}-` }) } }, incoming => {
            response = incoming;
            const statusCode = incoming.statusCode, headers = incoming.headers;
            try { onResponse?.({ statusCode, headers }); } catch (failure) { finish(failure); return; }
            if ([301, 302, 303, 307, 308].includes(statusCode)) { finish(null, { statusCode, headers, bytes: 0, body: Buffer.alloc(0) }); return; }
            if (statusCode !== 200 && !(statusCode === 206 && rangeStart !== undefined)) { finish(TRANSIENT_HTTP_STATUS.has(statusCode) ? transferError(`更新来源暂时返回 HTTP ${statusCode}。`) : new Error(`更新来源返回 HTTP ${statusCode}，当前版本保持不变。`)); return; }
            if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') { finish(new Error('更新来源返回了不支持的压缩数据。')); return; }
            if (headers['content-length'] !== undefined && (!/^\d+$/.test(headers['content-length']) || !Number.isSafeInteger(Number(headers['content-length'])) || Number(headers['content-length']) > maxBytes)) { finish(new Error('更新响应超过预期大小或长度无效。')); return; }
            let bytes = 0, ended = false; const chunks = [];
            incoming.on('data', chunk => {
              if (settled) return;
              try {
                bytes += chunk.length;
                if (bytes > maxBytes) throw new Error('更新响应超过预期大小。');
                if (onChunk) onChunk(chunk); else chunks.push(chunk);
              } catch (error) { finish(error); }
            });
            incoming.once('error', () => finish(transferError('更新响应读取失败。')));
            incoming.once('aborted', () => finish(transferError('更新响应未完整接收。')));
            incoming.once('close', () => { if (!ended) finish(transferError('更新响应提前关闭。')); });
            incoming.once('end', () => { ended = true; finish(null, { statusCode, headers, bytes, body: onChunk ? null : Buffer.concat(chunks) }); });
          });
          request.once('error', () => finish(transferError('更新请求中断，未尝试其他网络出口。')));
          request.setTimeout?.(idleTimeout, () => finish(transferError('更新连接长时间无响应。')));
          request.end();
        });
      });
      connect.end();
    } catch (failure) { finish(TRANSIENT_NETWORK_CODES.has(failure.code) ? transferError('无法建立更新代理请求，未尝试直连。') : failure); }
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

function createUpdater({ currentVersion, userDataDirectory, publicKey, enabled = true, request = proxyTransfer, launchInstaller = spawnInstaller, onStatus = () => {}, now = Date.now, retryDelaysMs = DOWNLOAD_RETRY_DELAYS_MS } = {}) {
  assertVersion(currentVersion);
  if (!path.isAbsolute(userDataDirectory) || !publicKey) throw new Error('更新器配置不完整。');
  if (!Array.isArray(retryDelaysMs) || retryDelaysMs.length > 3 || retryDelaysMs.some(value => !Number.isSafeInteger(value) || value < 0 || value > 30000)) throw new Error('更新重试设置无效。');
  const retryDelays = [...retryDelaysMs];
  const directory = path.join(userDataDirectory, 'updates'), preferences = path.join(directory, 'update-state.json');
  let closed = false, checking = null, downloading = null, installing = false, controller, candidate = null, readyFile = null;
  // This high-water mark tracks signed releases seen from the update feed.
  // A newer locally installed build must not make an older public release an error.
  let phase = 'idle', error = '', operation = '', downloadedBytes = 0, lastCheckedAt = null, deferredVersion = '', deferredUntil = 0, highestVersion = '';
  let retryAttempt = 0, bytesPerSecond = 0;
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
    if (typeof saved.highestVersion === 'string' && VERSION.test(saved.highestVersion)) highestVersion = saved.highestVersion;
  } catch { /* A missing/broken reminder preference cannot authorize an update. */ }
  const status = () => ({ enabled: Boolean(enabled) && !closed, currentVersion, phase, error, operation, lastCheckedAt, availableVersion: candidate?.version || null, notes: candidate?.notes || '', downloadedBytes, totalBytes: candidate?.size || 0, ready: Boolean(readyFile), deferredUntil, retryAttempt, maxRetryAttempts: retryDelays.length, bytesPerSecond });
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
      phase = 'checking'; operation = 'check'; error = ''; emit();
      controller = new AbortController();
      try {
        const result = await request(MANIFEST_URL, { signal: controller.signal, maxBytes: MAX_MANIFEST_BYTES, timeoutMs: 20000 });
        if (closed) throw cancelled();
        if (result.statusCode !== 200) throw new Error('更新清单不允许重定向。');
        const update = verifySignedManifest(JSON.parse(result.body.toString('utf8')), publicKey);
        if (highestVersion && compareVersions(update.version, highestVersion) < 0) throw new Error('更新清单版本早于已验证版本，已拒绝回退。');
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
    // Allocate before the microtask so an immediate cancel also takes effect.
    controller = new AbortController();
    downloading = Promise.resolve().then(async () => {
      let temporary, fd;
      phase = 'downloading'; operation = 'download'; error = ''; downloadedBytes = 0; retryAttempt = 0; bytesPerSecond = 0; emit();
      try {
        if (closed || controller.signal.aborted) throw cancelled();
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
        let retries = 0, rangeFallbackUsed = false;
        for (;;) {
          if (closed || controller.signal.aborted) throw cancelled();
          const startOffset = downloadedBytes, startedAt = now();
          let url = update.url, lastProgress = startedAt, transferBytes = 0;
          try {
            for (let redirects = 0; redirects <= 5; redirects++) {
              validateTransportUrl(url);
              let accepted = false, responseBytes = 0, expectedBytes = 0;
              const acceptResponse = ({ statusCode, headers = {} }) => {
                if (accepted) throw new Error('安装包响应头重复，已停止下载。');
                if (statusCode === 416 && startOffset > 0) throw Object.assign(new Error('更新来源不支持此次续传。'), { code: 'UPDATE_RANGE_UNSUPPORTED' });
                if (statusCode !== 200 && statusCode !== 206) return;
                if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') throw new Error('更新来源返回了不支持的压缩数据。');
                if (statusCode === 206) {
                  const match = typeof headers['content-range'] === 'string' && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range']);
                  const [start, end, total] = match ? match.slice(1).map(Number) : [];
                  if (!startOffset || !match || ![start, end, total].every(Number.isSafeInteger) || start !== startOffset || total !== update.size || end < start || end >= total) throw new Error('安装包续传范围与已验证清单不符。');
                  expectedBytes = end - start + 1;
                } else {
                  expectedBytes = update.size;
                }
                const length = headers['content-length'];
                if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== expectedBytes)) throw new Error('安装包响应大小与清单或续传范围不符。');
                // A source may ignore Range. Start this full response at byte 0,
                // never append it to the retained prefix from the failed request.
                if (statusCode === 200 && downloadedBytes) { fs.ftruncateSync(fd, 0); downloadedBytes = 0; }
                accepted = true;
              };
              const response = await request(url, { signal: controller.signal, maxBytes: update.size, timeoutMs: 20 * 60 * 1000,
                ...(startOffset ? { rangeStart: startOffset } : {}), onResponse: acceptResponse, onChunk(chunk) {
                  if (closed || controller.signal.aborted) throw cancelled();
                  if (!accepted) throw new Error('未验证安装包响应头，已停止下载。');
                  if (responseBytes + chunk.length > expectedBytes || downloadedBytes + chunk.length > update.size) throw new Error('安装包超过清单声明的大小。');
                  let offset = 0;
                  while (offset < chunk.length) {
                    const written = fs.writeSync(fd, chunk, offset, chunk.length - offset, downloadedBytes + offset);
                    if (!written) throw new Error('无法写入更新安装包。');
                    offset += written;
                  }
                  downloadedBytes += chunk.length; responseBytes += chunk.length; transferBytes += chunk.length;
                  const elapsed = now() - startedAt;
                  bytesPerSecond = elapsed > 0 ? Math.round(transferBytes * 1000 / elapsed) : 0;
                  if (now() - lastProgress >= 200) { lastProgress = now(); emit(); }
                } });
              if (response.statusCode === 200 || response.statusCode === 206) {
                if (!accepted) acceptResponse(response);
                if (responseBytes !== expectedBytes) throw transferError('安装包传输中断，正在保留已下载内容。');
                break;
              }
              if (TRANSIENT_HTTP_STATUS.has(response.statusCode)) throw transferError(`更新来源暂时返回 HTTP ${response.statusCode}。`);
              if (![301, 302, 303, 307, 308].includes(response.statusCode) || !response.headers.location || redirects === 5) throw new Error('安装包重定向无效或次数过多。');
              const next = new URL(response.headers.location, url).href;
              validateTransportUrl(next);
              if (next === MANIFEST_URL) throw new Error('安装包不能跳转到更新清单。');
              url = next;
            }
            if (downloadedBytes !== update.size) throw transferError('安装包未完整接收，正在保留已下载内容。');
            break;
          } catch (failure) {
            if (closed || controller.signal.aborted) throw cancelled();
            bytesPerSecond = 0;
            if (failure.code === 'UPDATE_RANGE_UNSUPPORTED' && !rangeFallbackUsed) {
              rangeFallbackUsed = true; fs.ftruncateSync(fd, 0); downloadedBytes = 0; emit(); continue;
            }
            if (!retryable(failure)) throw failure;
            // A connection can close after the last byte but before HTTP end.
            // The signed whole-file digest still decides whether it is usable.
            if (downloadedBytes === update.size) break;
            if (retries >= retryDelays.length) throw failure;
            retryAttempt = retries + 1; emit();
            await waitForRetry(retryDelays[retries++], controller.signal);
            retryAttempt = 0; emit();
          }
        }
        if (closed || controller.signal.aborted) throw cancelled();
        if (downloadedBytes !== update.size) throw new Error('安装包未完整下载，当前版本保持不变。');
        fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        await verifyInstaller(temporary, update);
        if (closed || controller.signal.aborted) throw cancelled();
        fs.renameSync(temporary, target); temporary = null;
        readyFile = target; phase = 'ready';
      } catch (failure) { readyFile = null; downloadedBytes = 0; error = failure.message; phase = failure.code === 'ABORT_ERR' ? 'available' : 'error'; }
      finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch {}
        if (temporary) try { fs.unlinkSync(temporary); } catch {}
        controller = null; downloading = null; retryAttempt = 0; bytesPerSecond = 0; emit();
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
    installing = true; phase = 'installing'; operation = 'install'; error = ''; emit();
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
