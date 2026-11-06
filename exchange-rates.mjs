import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { normalizeRate } from './currencies.mjs';

export const FIAT_CODES = Object.freeze(['USD', 'JPY', 'EUR', 'HKD', 'GBP', 'KRW', 'SGD', 'AUD', 'CAD', 'CHF']);
export const FIAT_URL = `https://api.frankfurter.dev/v2/rates?base=CNY&quotes=${FIAT_CODES.join(',')}&providers=ECB`;
export const USDT_URL = 'https://api.kraken.com/0/public/Ticker?pair=USDTUSD';
export const RATE_CACHE_FILENAME = 'exchange-rates.json';
const ALLOWED_URLS = new Set([FIAT_URL, USDT_URL]);
const MAX_RESPONSE = 64 * 1024;
const RETRY_MS = 60 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 60 * 1000;
const RATE_SCALE = 100000000n;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/** Only an HTTP CONNECT tunnel to the user's fixed loopback proxy can create a socket. */
export function proxyJson(url, { signal, timeoutMs = 15000, maxBytes = MAX_RESPONSE } = {}) {
  if (typeof url !== 'string' || !ALLOWED_URLS.has(url)) return Promise.reject(new Error('汇率请求地址不在固定来源列表中'));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE) return Promise.reject(new Error('无效的汇率请求限制'));
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    let tunnelRequest, tunnelSocket, secureSocket, providerRequest, providerResponse, agent;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      providerResponse?.destroy();
      providerRequest?.destroy();
      agent?.destroy();
      secureSocket?.destroy();
      tunnelSocket?.destroy();
      tunnelRequest?.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error('汇率请求已取消'));
    const timer = setTimeout(() => finish(new Error('汇率请求超时，已停止本次代理连接')), timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      tunnelRequest = http.request({
        hostname: '127.0.0.1', port: 10090, method: 'CONNECT',
        path: `${target.hostname}:443`, agent: false,
        headers: { Host: `${target.hostname}:443` },
      });
      tunnelRequest.once('error', () => finish(new Error('无法连接本机代理 127.0.0.1:10090，未尝试直连')));
      tunnelRequest.once('connect', (response, socket, head) => {
        tunnelSocket = socket;
        if (settled) { socket.destroy(); return; }
        if (response.statusCode !== 200 || head.length) { finish(new Error(`本机代理未建立安全隧道（${response.statusCode}）`)); return; }
        socket.once('error', () => finish(new Error('本机代理隧道连接中断')));
        secureSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
        secureSocket.once('error', () => finish(new Error('汇率来源的 TLS 安全连接失败')));
        secureSocket.once('secureConnect', () => {
          if (settled) return;
          if (!secureSocket.authorized) { finish(new Error('汇率来源证书验证失败')); return; }
          // Override the agent's sole connection factory: it cannot resolve or dial the remote host.
          agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
          agent.createConnection = () => secureSocket;
          providerRequest = https.request({
            hostname: target.hostname, port: 443, path: target.pathname + target.search,
            method: 'GET', agent,
            headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'SuperLedger/1.4 exchange-rate-cache' },
          }, response => {
            providerResponse = response;
            if (response.statusCode !== 200) { finish(new Error(`汇率来源返回 HTTP ${response.statusCode}，未跟随重定向`)); return; }
            if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '')) { finish(new Error('汇率来源未返回 JSON 数据')); return; }
            if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { finish(new Error('汇率来源返回不支持的压缩数据')); return; }
            if (Number(response.headers['content-length'] || 0) > maxBytes) { finish(new Error('汇率响应超过大小限制')); return; }
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
              size += chunk.length;
              if (size > maxBytes) { finish(new Error('汇率响应超过大小限制')); return; }
              chunks.push(chunk);
            });
            response.once('error', () => finish(new Error('汇率响应读取失败')));
            response.once('aborted', () => finish(new Error('汇率响应未完整接收')));
            response.once('end', () => {
              if (settled) return;
              try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
              catch { finish(new Error('汇率来源返回无效 JSON')); }
            });
          });
          providerRequest.once('error', () => finish(new Error('汇率来源请求失败')));
          providerRequest.end();
        });
      });
      tunnelRequest.end();
    } catch { finish(new Error('无法建立汇率代理请求，未尝试直连')); }
  });
}

function localDay(value) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
function validDay(value) {
  if (typeof value !== 'string' || !/^(?:19|20|21)\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function latestAllowedDay(date) {
  const ceiling = new Date(date);
  ceiling.setUTCDate(ceiling.getUTCDate() + 1);
  return ceiling.toISOString().slice(0, 10);
}
function errorText(error) {
  return String(error?.message || error || '汇率更新失败').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 180);
}
function rational(value) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('汇率数值格式无效');
  const raw = String(value);
  if (raw.length > 48) throw new Error('汇率数值过长');
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d{1,2}))?$/i.exec(raw);
  if (!match) throw new Error('汇率数值格式无效');
  const fraction = match[2] || '';
  const exponent = Number(match[3] || 0) - fraction.length;
  if (exponent < -24 || exponent > 18) throw new Error('汇率精度超出支持范围');
  const digits = BigInt(match[1] + fraction);
  if (digits <= 0n) throw new Error('汇率必须大于零');
  return exponent >= 0 ? { n: digits * 10n ** BigInt(exponent), d: 1n } : { n: digits, d: 10n ** BigInt(-exponent) };
}
function rateString(numerator, denominator) {
  const units = (numerator * RATE_SCALE + denominator / 2n) / denominator;
  const fraction = String(units % RATE_SCALE).padStart(8, '0').replace(/0+$/, '');
  return normalizeRate(`${units / RATE_SCALE}${fraction ? '.' + fraction : ''}`);
}
function nextMidnight(date) {
  const next = new Date(date);
  next.setHours(24, 0, 0, 0);
  return next.toISOString();
}

/** Reads a separate cache synchronously; network access begins only when refresh is called. */
export function createRateService({ dataDirectory, requestJson = proxyJson, now = () => new Date(), enabled = true } = {}) {
  if (typeof dataDirectory !== 'string' || !dataDirectory || typeof requestJson !== 'function' || typeof now !== 'function') throw new Error('无效的汇率服务配置');
  const cacheFile = path.join(dataDirectory, RATE_CACHE_FILENAME);
  let closed = false, inFlight = null, controller = null, cacheError = null, cacheUnreadable = false;
  let lastAttemptAt = null, lastSuccessAt = null, nextAttemptAt = null;
  let rates = {}, errors = { fiat: null, usdt: null };
  const clock = () => {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('汇率服务时间无效');
    return new Date(value);
  };
  const startup = clock();
  try {
    const stat = fs.lstatSync(cacheFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RESPONSE) throw new Error('汇率缓存文件格式无效');
    const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (!saved || saved.version !== 1 || !saved.rates || typeof saved.rates !== 'object' || Array.isArray(saved.rates)) throw new Error('汇率缓存版本无效');
    for (const code of [...FIAT_CODES, 'USDT']) {
      if (!own(saved.rates, code)) continue;
      const entry = saved.rates[code];
      try {
        if (!entry || entry.source !== (code === 'USDT' ? 'Kraken × ECB' : 'ECB') || !validDay(entry.asOf) || !validInstant(entry.fetchedAt) || new Date(entry.fetchedAt).getTime() > startup.getTime() + 300000) throw new Error('缓存来源或日期无效');
        const ceiling = latestAllowedDay(new Date(entry.fetchedAt));
        if (entry.asOf > ceiling) throw new Error('缓存日期超出获取日期');
        if (code === 'USDT' && entry.fiatAsOf !== undefined && (!validDay(entry.fiatAsOf) || entry.fiatAsOf > ceiling)) throw new Error('交叉汇率日期无效');
        rates[code] = { cnyRate: normalizeRate(entry.cnyRate), asOf: entry.asOf, source: entry.source, fetchedAt: entry.fetchedAt, ...(code === 'USDT' && entry.fiatAsOf ? { fiatAsOf: entry.fiatAsOf } : {}) };
      } catch { /* Invalid entries are ignored individually; the original cache is not touched here. */ }
    }
    for (const key of ['fiat', 'usdt']) if (typeof saved.errors?.[key] === 'string') errors[key] = errorText(saved.errors[key]);
    if (validInstant(saved.lastAttemptAt) && new Date(saved.lastAttemptAt).getTime() <= startup.getTime() + 300000) lastAttemptAt = saved.lastAttemptAt;
    if (validInstant(saved.lastSuccessAt) && new Date(saved.lastSuccessAt).getTime() <= startup.getTime() + 300000) lastSuccessAt = saved.lastSuccessAt;
    if (validInstant(saved.nextAttemptAt) && new Date(saved.nextAttemptAt).getTime() <= startup.getTime() + 48 * RETRY_MS) nextAttemptAt = saved.nextAttemptAt;
    if ([...FIAT_CODES, 'USDT'].some(code => !rates[code])) nextAttemptAt = null;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      cacheUnreadable = true;
      cacheError = '旧汇率缓存无法读取，已保留原文件；联网成功后可重新建立缓存';
    }
  }
  const status = () => structuredClone({ enabled: Boolean(enabled) && !closed, refreshing: Boolean(inFlight), lastAttemptAt, lastSuccessAt, nextAttemptAt, rates, errors, cacheError });
  function persist() {
    if (cacheUnreadable && !Object.keys(rates).length) return;
    const temporary = path.join(dataDirectory, `exchange-rates.${process.pid}.${randomUUID()}.tmp`);
    try {
      fs.mkdirSync(dataDirectory, { recursive: true });
      const handle = fs.openSync(temporary, 'wx');
      try {
        fs.writeFileSync(handle, JSON.stringify({ version: 1, lastAttemptAt, lastSuccessAt, nextAttemptAt, rates, errors }, null, 2) + '\n', 'utf8');
        fs.fsyncSync(handle);
      } finally { fs.closeSync(handle); }
      fs.renameSync(temporary, cacheFile);
      cacheError = null;
      cacheUnreadable = false;
    } catch {
      cacheError = '汇率已保留在本次运行内，但本机缓存未能保存';
      try { fs.unlinkSync(temporary); } catch { /* Preserve the original disk condition. */ }
    }
  }
  function refresh({ force = false } = {}) {
    if (inFlight) return inFlight;
    if (!enabled || closed) return Promise.resolve(status());
    const started = clock();
    if (lastAttemptAt && started.getTime() - new Date(lastAttemptAt).getTime() < MANUAL_COOLDOWN_MS) return Promise.resolve(status());
    if (!force && nextAttemptAt && started < new Date(nextAttemptAt)) return Promise.resolve(status());
    lastAttemptAt = started.toISOString();
    controller = new AbortController();
    const requestSignal = controller.signal;
    inFlight = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => requestJson(FIAT_URL, { signal: requestSignal })),
        Promise.resolve().then(() => requestJson(USDT_URL, { signal: requestSignal })),
      ]);
      if (closed) return;
      const fetched = clock(), fetchedAt = fetched.toISOString(), fetchedDay = localDay(fetched);
      const nextRates = { ...rates };
      const nextErrors = { fiat: null, usdt: null };
      let updated = 0, freshUsdQuote = null;
      if (results[0].status === 'rejected') nextErrors.fiat = errorText(results[0].reason);
      else {
        const rows = results[0].value;
        if (!Array.isArray(rows) || rows.length > 100) nextErrors.fiat = '法币来源返回的数据格式无效';
        else {
          const missing = [];
          for (const code of FIAT_CODES) {
            try {
              const matching = rows.filter(row => row && row.quote === code);
              if (matching.length !== 1) throw new Error('缺失或重复币种');
              const row = matching[0];
              if (row.base !== 'CNY' || !validDay(row.date) || row.date > latestAllowedDay(fetched)) throw new Error('汇率基准或日期无效');
              if (nextRates[code] && row.date < nextRates[code].asOf) throw new Error('来源日期早于已保存的汇率');
              const quote = rational(row.rate);
              const cnyRate = rateString(quote.d, quote.n);
              nextRates[code] = { cnyRate, asOf: row.date, source: 'ECB', fetchedAt };
              if (code === 'USD') freshUsdQuote = quote;
              updated++;
            } catch { missing.push(code); }
          }
          if (missing.length) nextErrors.fiat = `未取得有效汇率：${missing.join('、')}，已保留这些币种的上次值`;
        }
      }
      if (results[1].status === 'rejected') nextErrors.usdt = errorText(results[1].reason);
      else {
        try {
          const payload = results[1].value;
          if (!payload || !Array.isArray(payload.error) || payload.error.length || !Array.isArray(payload.result?.USDTZUSD?.c)) throw new Error('USDT 来源返回的数据格式无效');
          const price = rational(payload.result.USDTZUSD.c[0]);
          if (!nextRates.USD) throw new Error('缺少美元兑人民币汇率，暂不能折算 USDT');
          if (nextRates.USDT && fetchedDay < nextRates.USDT.asOf) throw new Error('当前日期早于已保存的 USDT 汇率');
          const usd = freshUsdQuote ? { n: freshUsdQuote.d, d: freshUsdQuote.n } : rational(nextRates.USD.cnyRate);
          const cnyRate = rateString(price.n * usd.n, price.d * usd.d);
          nextRates.USDT = { cnyRate, asOf: fetchedDay, fiatAsOf: nextRates.USD.asOf, source: 'Kraken × ECB', fetchedAt };
          updated++;
        } catch (error) { nextErrors.usdt = errorText(error); }
      }
      rates = nextRates;
      errors = nextErrors;
      if (updated) lastSuccessAt = fetchedAt;
      nextAttemptAt = errors.fiat || errors.usdt ? new Date(fetched.getTime() + RETRY_MS).toISOString() : nextMidnight(fetched);
      persist();
    })().catch(error => {
      if (closed) return;
      errors = { fiat: errorText(error), usdt: errorText(error) };
      nextAttemptAt = new Date(started.getTime() + RETRY_MS).toISOString();
      persist();
    }).then(() => {
      inFlight = null;
      controller = null;
      return status();
    });
    return inFlight;
  }
  function close() { closed = true; controller?.abort(); }
  return { status, refresh, close };
}
