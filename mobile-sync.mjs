import http from 'node:http';
import os from 'node:os';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { validateState } from './engine.mjs';

export const SESSION_MS = 10 * 60 * 1000;
const MAX_WIRE_BYTES = 4 * 1024 * 1024;
const MAX_OPERATIONS = 500;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Canonical ordering lets Java and JS serialize object keys differently without
// creating false edit conflicts. No financial arithmetic uses floating point.
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const same = (a, b) => canonical(a) === canonical(b);
const hash = value => createHash('sha256').update(value).digest('hex');

export function isPrivateIPv4(address) {
  if (typeof address !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) return false;
  const parts = address.split('.').map(Number);
  if (parts.some((n, i) => n > 255 || String(n) !== address.split('.')[i])) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

export function networkChoices() {
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family !== 'IPv4' || item.internal || !isPrivateIPv4(item.address)) continue;
      if (found.some(n => n.address === item.address)) continue;
      found.push({ address: item.address, label: name, virtual: /virtual|vmware|vethernet|wsl|hyper-v|vpn|tun|tap|loopback|clash|mihomo|sing-box/i.test(name) });
    }
  }
  return found.sort((a, b) => Number(a.virtual) - Number(b.virtual) || a.label.localeCompare(b.label));
}

export function newSyncMetadata() { return { bookId: randomUUID(), receipts: {} }; }

export function checkedMetadata(state) {
  const value = state._mobileSync;
  if (!object(value) || typeof value.bookId !== 'string' || !ID.test(value.bookId) || !object(value.receipts)
      || Object.entries(value.receipts).some(([key, digest]) => !/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(digest))) {
    throw fail(409, '同步记录无法读取，请先导出账本备份，再重新导入建立新的手机配对。');
  }
  return value;
}

function captureValid(capture) {
  if (!object(capture)) return false;
  return typeof capture.sourcePackage === 'string' && /^[A-Za-z0-9_.]{1,160}$/.test(capture.sourcePackage)
    && typeof capture.sourceKey === 'string' && capture.sourceKey.length > 0 && capture.sourceKey.length <= 256
    && Number.isSafeInteger(capture.occurredAt) && capture.occurredAt > 0
    && ['reference', 'merchant'].every(k => !own(capture, k) || typeof capture[k] === 'string' && capture[k].length <= 160);
}

function duplicateOf(state, incoming) {
  const capture = incoming.mobileCapture;
  if (!capture) return null;
  // A source notification/reference is strong evidence. Amount alone is never
  // enough to discard a transaction: weaker matches become review conflicts.
  for (const tx of state.transactions) {
    const old = tx.mobileCapture;
    if (old && old.sourcePackage === capture.sourcePackage
        && (old.sourceKey === capture.sourceKey || capture.reference && old.reference === capture.reference)) {
      return { transaction: tx, exact: tx.type === incoming.type && tx.amount === incoming.amount && tx.date === incoming.date && tx.accountId === incoming.accountId };
    }
  }
  return null;
}

function suspectedDuplicate(state, incoming) {
  if (!incoming.mobileCapture) return null;
  const capture = incoming.mobileCapture;
  return state.transactions.find(tx => {
    if (tx.type !== incoming.type || tx.amount !== incoming.amount || (tx.currency || 'CNY') !== (incoming.currency || 'CNY') || tx.date !== incoming.date) return false;
    if (tx.mobileCapture) {
      return Math.abs(tx.mobileCapture.occurredAt - capture.occurredAt) <= 120000
        && (tx.accountId === incoming.accountId || tx.mobileCapture.sourcePackage !== capture.sourcePackage);
    }
    // Subscription schedules are estimates of payment. Ask before creating a
    // second debit on the same account/date, even when merchant text differs.
    if (tx.subscriptionId && tx.accountId === incoming.accountId) return true;
    return tx.accountId === incoming.accountId && tx.title === incoming.title;
  });
}

export function mergeMobileOperations(state, payload) {
  const metadata = checkedMetadata(state);
  if (!object(payload) || typeof payload.deviceId !== 'string' || !ID.test(payload.deviceId)
      || typeof payload.requestId !== 'string' || !ID.test(payload.requestId)
      || !Array.isArray(payload.operations) || payload.operations.length > MAX_OPERATIONS) throw fail(400, '手机同步请求格式不正确，单次最多同步 500 项。');
  if (payload.bookId !== metadata.bookId && !(payload.bookId === null && payload.operations.length === 0)) {
    throw fail(409, '此手机绑定的是另一份账本，或电脑账本已恢复/重置。请在手机上处理未同步记录，再重新配对。');
  }
  let next = structuredClone(state);
  const accepted = [], conflicts = [], summary = { added: 0, updated: 0, deleted: 0, duplicates: 0 };
  const batchIds = new Set();
  for (const operation of payload.operations) {
    const operationId = operation?.id;
    if (!object(operation) || typeof operationId !== 'string' || !ID.test(operationId) || batchIds.has(operationId)) throw fail(400, '同步操作标识缺失或重复。');
    batchIds.add(operationId);
    const receiptKey = hash(payload.deviceId + ':' + operationId);
    const digest = hash(canonical(operation));
    const receipt = next._mobileSync.receipts[receiptKey];
    if (receipt) {
      if (receipt !== digest) { conflicts.push({ operationId, reason: '同一操作标识的内容发生变化，请重新确认并生成新的操作。' }); continue; }
      accepted.push(operationId); summary.duplicates++; continue;
    }
    const transactionId = operation.kind === 'delete' ? operation.transactionId : operation.transaction?.id;
    const current = next.transactions.find(tx => tx.id === transactionId) || null;
    const reject = (reason, candidate) => conflicts.push({ operationId, reason, current, ...(candidate ? { candidate } : {}) });
    if (!['put', 'delete'].includes(operation.kind) || typeof transactionId !== 'string' || !ID.test(transactionId)) { reject('不支持的手机账单操作。'); continue; }
    if (operation.base !== null && (!object(operation.base) || operation.base.id !== transactionId)) { reject('缺少编辑前的账单，无法安全合并。'); continue; }
    if (operation.kind === 'delete' && operation.base === null) { reject('删除账单需要原始记录。'); continue; }
    if (operation.kind === 'put' && !object(operation.transaction)) { reject('缺少账单内容。'); continue; }
    // An already-applied edit may have lost its acknowledgement. Do not write
    // it again; a durable receipt is still committed together with the ledger.
    if (operation.kind === 'put' && current && same(current, operation.transaction)) {
      next._mobileSync.receipts[receiptKey] = digest; accepted.push(operationId); summary.duplicates++; continue;
    }
    if (operation.kind === 'delete' && current === null) {
      next._mobileSync.receipts[receiptKey] = digest; accepted.push(operationId); summary.duplicates++; continue;
    }
    if (!same(current, operation.base)) { reject(current ? '电脑端也修改了这笔账，请选择保留哪一版。' : '电脑端已删除这笔账，手机修改尚未覆盖电脑。'); continue; }
    if (current && ((current.currency || 'CNY') !== 'CNY' || current.type === 'transfer')) { reject('外币账单和账户转账请在电脑端修改。'); continue; }
    const candidate = structuredClone(next);
    if (operation.kind === 'delete') {
      candidate.transactions = candidate.transactions.filter(tx => tx.id !== transactionId);
    } else {
      const tx = structuredClone(operation.transaction);
      // The phone validates its own local transaction date; the PC may be in a
      // different time zone. validateState still enforces real calendar dates.
      if (!['income', 'expense'].includes(tx.type) || (tx.currency || 'CNY') !== 'CNY') { reject('手机端目前支持人民币收入和支出。'); continue; }
      if (tx.mobileCapture && !captureValid(tx.mobileCapture)) { reject('付款通知来源记录无效。'); continue; }
      if (current?.subscriptionId && (tx.subscriptionId !== current.subscriptionId || tx.occurrenceKey !== current.occurrenceKey)) { reject('订阅账单的关联信息不能由手机移除。'); continue; }
      if (!current && (tx.subscriptionId || tx.occurrenceKey)) { reject('订阅计划请在电脑端创建。'); continue; }
      const duplicate = !current && duplicateOf(next, tx);
      if (duplicate?.exact) {
        next._mobileSync.receipts[receiptKey] = digest; accepted.push(operationId); summary.duplicates++; continue;
      }
      if (duplicate) { reject('同一条付款通知的金额或账户发生变化，请核对原账单。', duplicate.transaction); continue; }
      const suspected = !current && operation.allowDuplicate !== true && suspectedDuplicate(next, tx);
      if (suspected) { reject('可能与现有支付记录或订阅扣账重复，请核对后选择保留现有账单或仍然新增。', suspected); continue; }
      if (current) candidate.transactions[candidate.transactions.findIndex(item => item.id === transactionId)] = tx;
      else candidate.transactions.push(tx);
    }
    try { validateState(candidate); }
    catch (error) { reject(error.message); continue; }
    candidate._mobileSync.receipts[receiptKey] = digest;
    next = candidate;
    accepted.push(operationId);
    summary[operation.kind === 'delete' ? 'deleted' : current ? 'updated' : 'added']++;
  }
  return { next, accepted, conflicts, summary, changed: !same(state, next) };
}

function decode(value, size) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail(400, '无效的加密消息。');
  const bytes = Buffer.from(value, 'base64url');
  if (size !== undefined && bytes.length !== size || bytes.toString('base64url') !== value) throw fail(400, '无效的加密消息。');
  return bytes;
}

export function encryptMessage(key, sessionId, direction, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`superledger-sync-v1:${sessionId}:${direction}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64url'), data: data.toString('base64url') };
}

export function decryptMessage(key, sessionId, direction, envelope) {
  if (!object(envelope)) throw fail(400, '无效的加密消息。');
  const iv = decode(envelope.iv, 12), data = decode(envelope.data);
  if (data.length < 17 || data.length > MAX_WIRE_BYTES) throw fail(400, '无效的加密消息。');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`superledger-sync-v1:${sessionId}:${direction}`));
    decipher.setAuthTag(data.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8'));
  } catch { throw fail(403, '二维码已失效或加密校验失败，请重新扫码。'); }
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw fail(415, '仅接受加密同步消息。');
  if (Number(request.headers['content-length'] || 0) > MAX_WIRE_BYTES) throw fail(413, '同步消息过大，请分批同步。');
  const chunks = []; let count = 0;
  for await (const chunk of request) {
    count += chunk.length;
    if (count > MAX_WIRE_BYTES) throw fail(413, '同步消息过大，请分批同步。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, '同步消息格式无效。'); }
}

// The desktop HTTP UI remains loopback-only. This separate, temporary listener
// exposes exactly one encrypted endpoint, no static files or ledger API.
export function createMobileSync({ ensureBook, synchronize, interfaces = networkChoices, now = Date.now, sessionMs = SESSION_MS }) {
  let current = null, lastResult = null, starting = false, generation = 0;
  const sockets = new Set();
  const stop = () => {
    generation++;
    const old = current; current = null;
    if (old) { clearTimeout(old.timer); old.key.fill(0); old.server.close(); old.server.closeAllConnections(); }
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
  const status = () => {
    if (current && now() >= current.expiresAt) stop();
    const choices = interfaces();
    return { active: Boolean(current), expiresAt: current?.expiresAt || null, addresses: current ? [current.address] : [], networkChoices: choices,
      qrPayload: current ? JSON.stringify({ app: 'superledger', v: 1, addresses: [current.address], sessionId: current.id, key: current.key.toString('base64url'), expiresAt: current.expiresAt }) : null,
      lastResult };
  };
  async function start(address) {
    if (starting) throw fail(409, '正在生成二维码，请稍候。');
    starting = true;
    try {
      stop();
      const requestedGeneration = generation;
      const choices = interfaces(), selected = address || choices.find(item => !item.virtual)?.address || choices[0]?.address;
      if (!selected || !choices.some(item => item.address === selected) || !isPrivateIPv4(selected)) throw fail(409, '未找到可用的局域网地址。请连接 Wi-Fi、网线或手机热点后重试。');
      ensureBook();
      const session = { id: randomBytes(16).toString('hex'), key: randomBytes(32), expiresAt: now() + sessionMs, deviceId: null, replay: new Map(), attempts: 0, window: now() };
      const send = (res, code, body) => {
        if (res.destroyed) return;
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
        res.end(JSON.stringify(body));
      };
      const server = http.createServer(async (req, res) => {
        let payload;
        try {
          if (current !== session || now() >= session.expiresAt) throw fail(410, '二维码已过期，请重新生成。');
          const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '');
          if (!isPrivateIPv4(remote) || req.headers.origin || req.headers['sec-fetch-site']) throw fail(403, '仅允许同一局域网的手机同步。');
          if (req.method !== 'POST' || req.url !== `/sync/v1/${session.id}` || req.headers.host !== `${selected}:${server.address().port}`) throw fail(404, '没有此同步接口。');
          if (now() - session.window > 60000) { session.window = now(); session.attempts = 0; }
          if (++session.attempts > 90) throw fail(429, '请求过于频繁，请稍后重新扫码。');
          payload = decryptMessage(session.key, session.id, 'request', await readBody(req));
          if (current !== session || now() >= session.expiresAt) throw fail(410, '二维码已过期，请重新生成。');
          if (!object(payload) || typeof payload.requestId !== 'string' || !ID.test(payload.requestId) || typeof payload.deviceId !== 'string' || !ID.test(payload.deviceId)) throw fail(400, '同步设备信息无效。');
          if (session.deviceId && session.deviceId !== payload.deviceId) throw fail(409, '此二维码已由另一台手机使用，请重新生成。');
          const requestHash = hash(canonical(payload)), previous = session.replay.get(payload.requestId);
          if (previous && previous.digest !== requestHash) throw fail(409, '重复请求的内容不一致，请重新发起同步。');
          if (!previous && session.replay.size >= 512) throw fail(429, '本次二维码使用次数已达上限，请重新生成。');
          // A replay never re-applies operations. Return a fresh state so later
          // desktop edits cannot be rewound by an old cached response.
          const result = synchronize(payload);
          session.deviceId = payload.deviceId;
          session.replay.set(payload.requestId, { digest: requestHash });
          const deviceName = typeof payload.deviceName === 'string' ? payload.deviceName.replace(/[\u0000-\u001f]/g, '').slice(0, 80) : '安卓手机';
          lastResult = { deviceName, syncedAt: result.syncedAt, summary: result.summary, conflicts: result.conflicts.length };
          send(res, 200, encryptMessage(session.key, session.id, 'response', result));
        } catch (error) {
          const code = error.status || 500;
          const message = code === 500 ? '电脑保存失败，手机记录仍保留，请检查磁盘空间后重试。' : error.message;
          // Authenticated clients receive authenticated errors, including book
          // mismatch; unauthenticated callers receive no ledger information.
          if (payload && current === session && ID.test(payload.requestId || '')) send(res, code, encryptMessage(session.key, session.id, 'response', { requestId: payload.requestId, error: message }));
          else send(res, code, { error: message });
        }
      });
      session.server = server;
      server.headersTimeout = 10000; server.requestTimeout = 20000; server.timeout = 20000; server.maxConnections = 12;
      server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, selected, resolve); });
      if (generation !== requestedGeneration) { session.key.fill(0); server.close(); throw fail(409, '同步已取消。'); }
      server.on('error', () => { if (current === session) stop(); });
      session.address = `http://${selected}:${server.address().port}`;
      session.timer = setTimeout(() => { if (current === session) stop(); }, sessionMs); session.timer.unref();
      current = session; lastResult = null;
      return status();
    } finally { starting = false; }
  }
  return { status, start, stop };
}
