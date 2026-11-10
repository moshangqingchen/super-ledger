import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeEmptyState, makeInitialState, validateState, applyRecurring, beijingDateTime, subscriptionIntervalMonths, prepareSubscriptionEdit } from './engine.mjs';
import { createRateService } from './exchange-rates.mjs';
import { accountCurrency } from './currencies.mjs';
import { createMobileSync, newSyncMetadata, checkedMetadata, mergeMobileOperations } from './mobile-sync.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 2 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
};

function fail(status, message, detail = {}) {
  return Object.assign(new Error(message), { status, detail });
}

function parseBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    request.resume();
    return Promise.reject(fail(415, '请使用 application/json 请求格式。'));
  }
  if (Number(request.headers['content-length'] || 0) > MAX_BODY) {
    request.resume();
    return Promise.reject(fail(413, '文件过大，请使用不超过 2 MB 的账本备份。'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        if (!rejected) reject(fail(413, '文件过大，请使用不超过 2 MB 的账本备份。'));
        rejected = true;
        chunks.length = 0;
      } else if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(fail(400, '无法读取 JSON，请选择有效的账本备份。')); }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(fail(400, '请求已中断，账本未保存。')));
  });
}

async function lockDataDirectory(directory, port) {
  const realDirectory = fs.realpathSync(directory);
  const canonical = process.platform === 'win32' ? realDirectory.toLowerCase() : realDirectory;
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  // A kernel-owned local pipe serializes lock-file recovery as well as normal use.
  // Unlike a lock file alone, two processes cannot both recover a stale lock.
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\money-lab-${digest}` : `\0money-lab-${digest}`;
  const mutex = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    const onError = error => reject(new Error(error.code === 'EADDRINUSE'
      ? '此数据目录已有账本实例运行，请使用原窗口；更换端口不能同时打开同一份账本。'
      : `无法取得本机账本进程锁：${error.message}`));
    mutex.once('error', onError);
    mutex.listen(address, () => { mutex.removeListener('error', onError); resolve(); });
  });
  mutex.unref();
  const lockFile = path.join(realDirectory, 'ledger.lock.json');
  const token = randomUUID();
  let owned = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    if (owned) {
      try {
        const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (current.pid === process.pid && current.token === token) fs.unlinkSync(lockFile);
      } catch (error) {
        if (error.code !== 'ENOENT') console.error(`账本锁文件保留，未强行删除：${error.message}`);
      }
    }
    mutex.close();
  };
  try {
    if (fs.existsSync(lockFile)) {
      let old;
      try { old = JSON.parse(fs.readFileSync(lockFile, 'utf8')); }
      catch { throw new Error(`账本锁记录无法确认，未自动删除。请关闭账本进程后检查 ${lockFile}。`); }
      if (!Number.isSafeInteger(old.pid) || old.pid <= 0 || typeof old.token !== 'string') {
        throw new Error(`账本锁记录无效，未自动删除。请关闭账本进程后检查 ${lockFile}。`);
      }
      let exited = false;
      try { process.kill(old.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') exited = true; }
      if (!exited) throw new Error(`账本锁属于仍运行或无法确认已退出的进程 ${old.pid}，已停止本次启动。`);
      fs.unlinkSync(lockFile);
    }
    const handle = fs.openSync(lockFile, 'wx');
    owned = true;
    try {
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, token, port, startedAt: new Date().toISOString() }), 'utf8');
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    process.once('exit', release);
    return release;
  } catch (error) { release(); throw error; }
}

export async function createLedgerServer({ port = 4317, dataDirectory = path.join(ROOT, 'data'), authToken, rateService, onlineRates = false, mobileSyncOptions = {}, now = () => new Date() } = {}) {
  if (!Number.isInteger(port) || (port !== 0 && port < 1024) || port > 65535) throw new Error('无效的本机服务端口。');
  if (authToken !== undefined && (typeof authToken !== 'string' || authToken.length === 0)) throw new Error('桌面账本访问凭据必须为非空字符串。');
  const tokenBytes = authToken === undefined ? null : Buffer.from(authToken, 'utf8');
  const ledgerFile = path.join(dataDirectory, 'ledger.json');
  const previousFile = path.join(dataDirectory, 'ledger.previous.json');
  const todayLocal = () => beijingDateTime(now()).date;
  let listeningPort = port;
  const allowedHosts = new Set();
  const allowedOrigins = new Set();
  function useListeningPort(boundPort) {
    listeningPort = boundPort;
    allowedHosts.clear();
    allowedOrigins.clear();
    for (const host of [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]) {
      allowedHosts.add(host);
      allowedOrigins.add(`http://${host}`);
    }
  }
  useListeningPort(port);
  fs.mkdirSync(dataDirectory, { recursive: true });
  const releaseLock = await lockDataDirectory(dataDirectory, port);
  try {

  function writeDisk(next, backup = true) {
    validateState(next);
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_BODY) throw fail(413, '账本超过 2 MB 保存上限，请先导出备份。');
    const temp = path.join(dataDirectory, `ledger.${process.pid}.${Date.now()}.tmp`);
    try {
      const handle = fs.openSync(temp, 'wx');
      try { fs.writeFileSync(handle, serialized, 'utf8'); fs.fsyncSync(handle); }
      finally { fs.closeSync(handle); }
      if (backup && fs.existsSync(ledgerFile)) fs.copyFileSync(ledgerFile, previousFile);
      fs.renameSync(temp, ledgerFile);
    } catch (error) {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* Keep the original error. */ }
      throw error;
    }
  }

  let state;
  if (fs.existsSync(ledgerFile)) {
    try {
      state = JSON.parse(fs.readFileSync(ledgerFile, 'utf8').replace(/^\uFEFF/, ''));
      validateState(state);
    } catch (error) {
      throw new Error(`本地账本无法读取，已保留原文件，未重置。请检查 ${ledgerFile} 或从备份恢复。原因：${error.message}`);
    }
  } else {
    state = makeEmptyState();
    writeDisk(state, false);
  }

  const rates = rateService || createRateService({ dataDirectory, enabled: onlineRates });
  let ratesApplyError = '', ratesClosed = false, automaticBookingError = '';

  function rateStatus() {
    return { ...rates.status(), applyError: ratesApplyError };
  }

  // Apply to the latest ledger, after the network request has completed. A refresh
  // must never replace edits made while it was awaiting public market data.
  function applyCachedRates(candidate) {
    const next = structuredClone(candidate), quotes = rates.status().rates || {};
    for (const account of next.accounts) {
      const code = accountCurrency(account), quote = quotes[code];
      if (code === 'CNY' || account.rateMode === 'manual' || !quote) continue;
      const stored = state.accounts.find(item => item.id === account.id && accountCurrency(item) === code);
      if (stored?.rateMode !== 'manual' && stored?.rateAsOf && quote.asOf < stored.rateAsOf && (!account.rateAsOf || account.rateAsOf <= stored.rateAsOf)) {
        account.cnyRate = stored.cnyRate;
        account.rateAsOf = stored.rateAsOf;
        if (stored.rateSource) account.rateSource = stored.rateSource;
        continue;
      }
      // A lagging provider must not rewind an account's more recent quote.
      if (account.rateAsOf && quote.asOf < account.rateAsOf) continue;
      account.cnyRate = quote.cnyRate;
      account.rateAsOf = quote.asOf;
      account.rateSource = quote.source;
    }
    validateState(next);
    return next;
  }

  function reconcileRates() {
    try {
      const next = applyCachedRates(state);
      if (JSON.stringify(next) !== JSON.stringify(state)) commit(next);
      ratesApplyError = '';
    } catch (error) {
      ratesApplyError = `已取得汇率，但当前账本暂未应用：${error.message}`;
    }
  }

  async function refreshRates(force = false) {
    await rates.refresh({ force });
    if (!ratesClosed) reconcileRates();
    return rateStatus();
  }

  function commit(next) {
    const saved = { ...structuredClone(next), revision: state.revision + 1 };
    writeDisk(saved);
    state = saved;
    return state;
  }

  function reconcile() {
    try {
      const result = applyRecurring(state, now());
      if (JSON.stringify(result.state) !== JSON.stringify(state)) commit(result.state);
      automaticBookingError = '';
      return result.added;
    } catch (error) {
      // A failed future debit must not lock the owner out of the last valid
      // ledger, its export, or the edits needed to repair the subscription.
      const message = error.message || String(error);
      if (automaticBookingError !== message) console.error(`自动记账失败：${message}`);
      automaticBookingError = message;
      return [];
    }
  }

  function checkRevision(expectedRevision) {
    if (!Number.isInteger(expectedRevision) || expectedRevision !== state.revision) {
      throw fail(409, '账本已更新，请刷新后再保存，避免覆盖其他窗口或自动记账的数据。', { currentRevision: state.revision });
    }
  }

  const mobileSync = createMobileSync({
    ...mobileSyncOptions,
    ensureBook() {
      if (!state._mobileSync) commit({ ...state, _mobileSync: newSyncMetadata() });
      checkedMetadata(state);
    },
    synchronize(payload) {
      reconcile();
      const result = mergeMobileOperations(state, payload, now());
      // Publish receipts, entity edits and their due bookings atomically. A
      // failed catch-up must not leave a partially acknowledged subscription.
      const reconciled = applyRecurring(result.next, now()).state;
      if (result.changed || JSON.stringify(reconciled) !== JSON.stringify(state)) commit(reconciled);
      automaticBookingError = '';
      const publicState = structuredClone(state);
      delete publicState._mobileSync;
      return { requestId: payload.requestId, protocolVersion: 2, bookId: checkedMetadata(state).bookId, state: publicState,
        accepted: result.accepted, conflicts: result.conflicts, summary: result.summary, syncedAt: Date.now() };
    },
  });

  function sendJson(response, status, data, extra = {}) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    response.end(JSON.stringify(data));
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
    try {
      if (!allowedHosts.has(request.headers.host)) throw fail(403, '仅允许通过本机账本地址访问。');
      if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) throw fail(403, '已拒绝来自其他网站的账本请求。');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '已拒绝来自其他网站的账本请求。');
      const url = new URL(request.url, `http://127.0.0.1:${listeningPort}`);
      const route = url.pathname;
      if (route.startsWith('/api/') && tokenBytes !== null) {
        const header = request.headers['x-ledger-token'];
        const supplied = typeof header === 'string' ? Buffer.from(header, 'utf8') : null;
        if (supplied === null || supplied.length !== tokenBytes.length || !timingSafeEqual(supplied, tokenBytes)) {
          throw fail(403, '桌面账本访问凭据无效。');
        }
      }

      if (route === '/api/health' && request.method === 'GET') {
        return sendJson(response, 200, { app: 'money-lab-local-ledger', ready: true, port: listeningPort, automaticBookingError });
      }
      if (route === '/api/mobile-sync/status' && request.method === 'GET') return sendJson(response, 200, mobileSync.status());
      if (route === '/api/mobile-sync/start' && request.method === 'POST') {
        const body = await parseBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.address !== undefined && typeof body.address !== 'string') throw fail(400, '同步地址格式无效。');
        return sendJson(response, 200, await mobileSync.start(body.address));
      }
      if (route === '/api/mobile-sync/stop' && request.method === 'POST') {
        await parseBody(request);
        mobileSync.stop();
        return sendJson(response, 200, mobileSync.status());
      }
      if (route === '/api/rates' && request.method === 'GET') {
        return sendJson(response, 200, rateStatus());
      }
      if (route === '/api/rates/refresh' && request.method === 'POST') {
        const body = await parseBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, '无效的汇率刷新请求。');
        return sendJson(response, 200, await refreshRates(true));
      }
      if (route === '/api/state' && request.method === 'GET') {
        reconcile();
        return sendJson(response, 200, state);
      }
      if (route === '/api/state' && request.method === 'PUT') {
        const body = await parseBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || !body.state) throw fail(400, '缺少要保存的账本数据。');
        reconcile();
        checkRevision(body.expectedRevision);
        let next;
        try {
          const edited = structuredClone(body.state);
          const previousById = new Map(state.subscriptions.map(sub => [sub.id, sub]));
          if (Array.isArray(edited.subscriptions)) for (const sub of edited.subscriptions) {
            const previous = previousById.get(sub?.id);
            if (!previous || subscriptionIntervalMonths(previous) === subscriptionIntervalMonths(sub)) continue;
            // Reject invalid schema/one-time fields before the writer can omit intervalMonths: 1.
            if (Object.hasOwn(sub, 'intervalMonths') && (edited.schemaVersion < 4 || sub.recurring !== true)) validateState(edited);
            // A whole-ledger PUT is an edit, not a backup import. Protect direct callers as well
            // as the renderer from booking elapsed months when a yearly plan becomes monthly.
            prepareSubscriptionEdit(previous, sub, edited.transactions, now());
          }
          validateState(edited);
          next = applyRecurring(applyCachedRates(edited), now()).state;
        }
        catch (error) { throw fail(400, error.message); }
        // Mobile receipts are server-owned and must survive edits from an older
        // renderer. A whole-ledger PUT cannot erase deduplication history.
        if (state._mobileSync) next._mobileSync = structuredClone(state._mobileSync);
        else delete next._mobileSync;
        const saved = commit(next);
        automaticBookingError = '';
        return sendJson(response, 200, saved);
      }
      if (route === '/api/import' && request.method === 'POST') {
        const body = await parseBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || !body.state) throw fail(400, '缺少要导入的账本数据。');
        reconcile();
        checkRevision(body.expectedRevision);
        try { validateState(body.state); } catch (error) { throw fail(400, error.message); }
        let next;
        try { next = applyRecurring(applyCachedRates(body.state), now()).state; }
        catch (error) { throw fail(400, error.message); }
        const backup = path.join(dataDirectory, `ledger.before-import.${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID().slice(0, 8)}.json`);
        fs.copyFileSync(ledgerFile, backup, fs.constants.COPYFILE_EXCL);
        // Restoring a backup starts a new pairing identity, so an offline phone
        // cannot silently reapply operations from a superseded ledger.
        delete next._mobileSync;
        const saved = commit(next);
        automaticBookingError = '';
        mobileSync.stop();
        return sendJson(response, 200, saved);
      }
      if (route === '/api/reset' && request.method === 'POST') {
        const body = await parseBody(request);
        if (!body || !['empty', 'demo'].includes(body.mode)) throw fail(400, '请选择新建空账本或加载示例账本。');
        reconcile();
        checkRevision(body.expectedRevision);
        const backup = path.join(dataDirectory, `ledger.before-reset.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.copyFileSync(ledgerFile, backup);
        const next = body.mode === 'demo' ? makeInitialState(todayLocal()) : makeEmptyState();
        const saved = commit(applyRecurring(next, now()).state);
        automaticBookingError = '';
        mobileSync.stop();
        return sendJson(response, 200, saved);
      }
      if (route === '/api/export' && request.method === 'GET') {
        reconcile();
        return sendJson(response, 200, state, { 'Content-Disposition': `attachment; filename="money-lab-${todayLocal()}.json"` });
      }
      if (route.startsWith('/api/')) throw fail(404, '没有找到这个账本接口。');
      if (!['GET', 'HEAD'].includes(request.method)) throw fail(405, '不支持此请求方式。');

      let relative;
      try { relative = decodeURIComponent(route === '/' ? '/index.html' : route).slice(1); }
      catch { throw fail(400, '无效的文件地址。'); }
      const topAllowed = new Set(['index.html', 'app.js', 'icon-select.js', 'icon-select.css', 'styles.css', 'dashboard.css', 'currency-ui.css', 'fresh-ui.css', 'update-ui.js', 'update-ui.css', 'mobile-sync-ui.js', 'mobile-sync.css', 'currencies.mjs', 'engine.mjs', 'subscription-catalog.mjs', 'subscription-overview.mjs', 'subscription-chart.js', 'account-presets.mjs', 'bank-catalog.mjs', 'account-groups.mjs', 'account-cards.js', 'account-cards.css', 'ledger-ui.css', 'subscription-polish.css', 'favicon.svg']);
      if (!topAllowed.has(relative) && !relative.startsWith('assets/')) throw fail(404, '没有找到此文件。');
      if (relative.includes('\\') || relative.includes('\0') || relative.split('/').includes('..') || relative.split('/').some(part => part.startsWith('.'))) throw fail(404, '没有找到此文件。');
      const filename = path.resolve(ROOT, relative);
      if (!filename.startsWith(`${ROOT}${path.sep}`)) throw fail(404, '没有找到此文件。');
      let file;
      try {
        if (!fs.statSync(filename).isFile()) throw new Error('Not a file');
        file = fs.readFileSync(filename);
      } catch { throw fail(404, '没有找到此文件。'); }
      response.writeHead(200, { 'Content-Type': MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream', 'Content-Length': file.length, 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : file);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const status = error.status || 500;
      if (status === 500) console.error(`[${new Date().toISOString()}] ${error.stack || error}`);
      sendJson(response, status, { error: status === 500 ? '本地保存或读取失败。原账本已保留，请检查运行日志及磁盘空间。' : error.message, ...(error.detail || {}) });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  let timer;
  server.on('listening', () => {
    const address = server.address();
    if (address && typeof address === 'object') useListeningPort(address.port);
    reconcileRates();
    try { reconcile(); } catch (error) { console.error(`自动记账失败：${error.message}`); }
    if (rates.status().enabled) void refreshRates().catch(error => { ratesApplyError = `汇率更新失败：${error.message}`; });
    timer = setInterval(() => {
      try { reconcile(); } catch (error) { console.error(`自动记账失败：${error.message}`); }
      if (rates.status().enabled) void refreshRates().catch(error => { ratesApplyError = `汇率更新失败：${error.message}`; });
    }, 60000);
    timer.unref();
  });
  server.on('error', releaseLock);
  server.on('close', () => { mobileSync.stop(); ratesClosed = true; rates.close(); clearInterval(timer); releaseLock(); });
  return server;
  } catch (error) { releaseLock(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.LEDGER_PORT || 4317);
  try {
    const server = await createLedgerServer({ port, onlineRates: true });
    server.on('error', error => {
      console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。如账本已启动，请打开 http://127.0.0.1:${port}。` : error.message);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`MONEY LAB 超级账本 · http://127.0.0.1:${port}`);
      console.log(`本机数据：${path.join(ROOT, 'data', 'ledger.json')}`);
      console.log('仅本机访问。订阅自动记账已启动；不会进行银行卡扣款。');
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { process.exitCode = 0; }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
