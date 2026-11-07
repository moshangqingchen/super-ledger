'use strict';

const CANONICAL_INSTALLER = /^https:\/\/github\.com\/moshangqingchen\/super-ledger\/releases\/download\/v((?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5}))\/SuperLedger-Setup-\1\.exe$/;
const MIRROR_PREFIXES = ['https://gh-proxy.org/', 'https://ghfast.top/'];
const PREFIX_BYTES = 512 * 1024;
const PROBE_TIMEOUT_MS = 8000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function cancelled() {
  return Object.assign(new Error('更新下载已取消。'), { code: 'ABORT_ERR' });
}

function registeredSources(canonicalUrl) {
  if (typeof canonicalUrl !== 'string' || !CANONICAL_INSTALLER.test(canonicalUrl)) throw new Error('更新安装包地址不属于固定仓库的对应版本。');
  return [
    { id: 'gh-proxy', label: '加速线路 1', url: MIRROR_PREFIXES[0] + canonicalUrl },
    { id: 'ghfast', label: '加速线路 2', url: MIRROR_PREFIXES[1] + canonicalUrl },
    { id: 'github', label: 'GitHub 原始', url: canonicalUrl },
  ];
}

function validatedSources(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('更新来源格式无效。');
  const registered = registeredSources(update.url);
  if (!own(update, 'sources')) return [registered[2]];
  if (!Array.isArray(update.sources) || update.sources.length < 1 || update.sources.length > registered.length) throw new Error('更新来源数量无效。');
  const seen = new Set();
  return update.sources.map(source => {
    const match = source && typeof source === 'object' && !Array.isArray(source)
      ? registered.find(item => item.id === source.id && item.url === source.url) : null;
    if (!match || seen.has(match.id)) throw new Error('更新来源不属于已注册的同一版本安装包。');
    seen.add(match.id);
    return match;
  });
}

function isRegisteredMirror(input) {
  if (typeof input !== 'string') return false;
  const prefix = MIRROR_PREFIXES.find(value => input.startsWith(value));
  return Boolean(prefix && CANONICAL_INSTALLER.test(input.slice(prefix.length)));
}

function probeSource(source, size, request, validateUrl, controller) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const signal = controller.signal;
    const prefixBytes = Math.min(PREFIX_BYTES, size);
    const finish = failure => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      if (failure) reject(failure);
      else resolve(source);
    };
    const aborted = () => finish(cancelled());
    const fail = failure => { finish(failure); controller.abort(); };
    const timer = setTimeout(() => fail(new Error('更新线路测速超时。')), PROBE_TIMEOUT_MS);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }

    const run = async () => {
      let url = source.url;
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (finished) return;
        if (validateUrl(url) === false) throw new Error('更新线路地址未通过验证。');
        let responseSeen = false, accepted = false, received = 0, magicBytes = 0, expectedBytes;
        const acceptResponse = ({ statusCode, headers = {} }) => {
          if (finished) return;
          if (responseSeen) throw new Error('更新线路测速响应头重复。');
          responseSeen = true;
          if (REDIRECTS.has(statusCode)) return;
          if (statusCode !== 200 && statusCode !== 206) throw new Error('更新线路测速响应无效。');
          if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') throw new Error('更新线路返回了不支持的压缩数据。');
          expectedBytes = size;
          if (statusCode === 206) {
            const range = typeof headers['content-range'] === 'string' && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range']);
            const [start, end, total] = range ? range.slice(1).map(Number) : [];
            if (!range || ![start, end, total].every(Number.isSafeInteger) || start !== 0 || end !== prefixBytes - 1 || total !== size) throw new Error('更新线路测速范围与安装包不符。');
            expectedBytes = prefixBytes;
          }
          const length = headers['content-length'];
          if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) !== expectedBytes)) throw new Error('更新线路测速响应长度不符。');
          accepted = true;
        };
        const consume = chunk => {
          if (finished) return;
          if (!accepted || !Buffer.isBuffer(chunk)) throw new Error('更新线路测速数据未通过响应头验证。');
          received += chunk.length;
          if (received > expectedBytes) throw new Error('更新线路测速响应超过声明长度。');
          for (let index = 0; index < chunk.length && magicBytes < 2; index++, magicBytes++) {
            if (chunk[index] !== (magicBytes === 0 ? 0x4d : 0x5a)) throw new Error('更新线路未返回 Windows 安装包。');
          }
          if (received >= prefixBytes) {
            finish();
            controller.abort();
          }
        };
        const response = await request(url, { signal, maxBytes: size, timeoutMs: PROBE_TIMEOUT_MS,
          rangeStart: 0, rangeEnd: prefixBytes - 1, onResponse: acceptResponse, onChunk: consume });
        if (finished) return;
        if (REDIRECTS.has(response.statusCode)) {
          if (redirects === 5 || typeof response.headers?.location !== 'string') throw new Error('更新线路重定向无效或次数过多。');
          url = new URL(response.headers.location, url).href;
          continue;
        }
        if (!responseSeen) acceptResponse(response);
        if (!received && Buffer.isBuffer(response.body)) consume(response.body);
        if (!finished) throw new Error('更新线路测速前缀未完整接收。');
      }
    };
    run().catch(fail);
  });
}

async function rankSources({ sources, size, request, signal, validateUrl }) {
  if (signal?.aborted) throw cancelled();
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 3 || sources.some(source => !source || typeof source.url !== 'string')) throw new Error('更新线路测速来源无效。');
  if (!Number.isSafeInteger(size) || size < 64 * 1024 || size > 512 * 1024 * 1024 || typeof request !== 'function' || typeof validateUrl !== 'function') throw new Error('更新线路测速参数无效。');
  if (sources.length === 1) return [...sources];
  const controllers = sources.map(() => new AbortController());
  const abortAll = () => controllers.forEach(controller => controller.abort());
  signal?.addEventListener('abort', abortAll, { once: true });
  try {
    const winner = await Promise.any(sources.map((source, index) => probeSource(source, size, request, validateUrl, controllers[index])));
    if (signal?.aborted) throw cancelled();
    return [winner, ...sources.filter(source => source !== winner)];
  } catch (failure) {
    if (signal?.aborted) throw cancelled();
    return [...sources];
  } finally {
    signal?.removeEventListener('abort', abortAll);
    abortAll();
  }
}

module.exports = { registeredSources, validatedSources, isRegisteredMirror, rankSources };
