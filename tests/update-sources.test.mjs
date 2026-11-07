import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getEventListeners } from 'node:events';

const { registeredSources, validatedSources, isRegisteredMirror, rankSources } = createRequire(import.meta.url)('../desktop/update-sources.cjs');
const canonical = 'https://github.com/moshangqingchen/super-ledger/releases/download/v1.8.13/SuperLedger-Setup-1.8.13.exe';
const sources = registeredSources(canonical);
const size = 2 * 1024 * 1024;
const prefix = Buffer.alloc(512 * 1024, 7);
prefix.write('MZ');
const aborted = () => Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' });
function validateUrl(url) {
  if (url !== canonical && !isRegisteredMirror(url) && !url.startsWith('https://release-assets.githubusercontent.com/')) throw new Error('Unregistered test URL');
}
function complete(options, { statusCode = 206, headers = { 'content-range': `bytes 0-${prefix.length - 1}/${size}`, 'content-length': String(prefix.length) }, body = prefix } = {}) {
  options.onResponse({ statusCode, headers });
  options.onChunk(body);
  return { statusCode, headers, bytes: body.length };
}

test('registered routes name the exact same Windows release and legacy manifests retain one source', () => {
  assert.deepEqual(sources, [
    { id: 'gh-proxy', label: '加速线路 1', url: 'https://gh-proxy.org/' + canonical },
    { id: 'ghfast', label: '加速线路 2', url: 'https://ghfast.top/' + canonical },
    { id: 'github', label: 'GitHub 原始', url: canonical },
  ]);
  assert.deepEqual(validatedSources({ url: canonical }), [sources[2]]);
  assert.deepEqual(validatedSources({ url: canonical, sources: [sources[1], sources[0]] }), [sources[1], sources[0]]);
  assert.equal(validatedSources({ url: canonical, sources: [{ ...sources[0], label: '<untrusted>' }] })[0].label, '加速线路 1');
});

test('registered mirrors reject URL tricks, alternate repositories, mismatched versions and arbitrary files', () => {
  assert.equal(isRegisteredMirror(sources[0].url), true);
  assert.equal(isRegisteredMirror(sources[1].url), true);
  for (const url of [canonical, null, {}, sources[0].url + '?extra=1', sources[0].url + '#hash',
    sources[0].url.replace('https:', 'http:'), sources[0].url.replace('gh-proxy.org/', 'gh-proxy.org:443/'),
    sources[0].url.replace('gh-proxy.org/', 'user:password@gh-proxy.org/'), sources[0].url.replace('gh-proxy.org/', 'gh-proxy.org.evil.invalid/'),
    sources[0].url.replace('moshangqingchen', 'someone'), sources[0].url.replace('Setup-1.8.13', 'Setup-1.8.12'),
    sources[0].url.replace('v1.8.13', 'v01.8.13'), sources[0].url.replace('.exe', '.apk'), sources[0].url.replace('/https://', '/https%3A%2F%2F')]) {
    assert.equal(isRegisteredMirror(url), false, String(url));
  }
  for (const url of [canonical + '?x=1', canonical.replace('Setup-1.8.13', 'Setup-1.8.14'), canonical.replace('1.8.13', '1234567.8.13')]) assert.throws(() => registeredSources(url));
});

test('declared sources must be a bounded unique list of registered identities and immutable URLs', () => {
  for (const declared of [null, undefined, [], {}, [sources[0], sources[0]], [...sources, sources[0]],
    [{ id: 'custom', url: canonical }], [{ ...sources[0], url: sources[1].url }], [{ ...sources[0], url: sources[0].url + '?redirect=1' }],
    [{ ...sources[0], url: sources[0].url.replaceAll('1.8.13', '1.8.14') }], [null], [['github', canonical]]]) {
    assert.throws(() => validatedSources({ url: canonical, sources: declared }));
  }
});

test('a legacy single source skips probes and keeps the existing download contract', async () => {
  let calls = 0;
  const result = await rankSources({ sources: [sources[2]], size, validateUrl, request: async () => { calls++; throw new Error('Unexpected probe'); } });
  assert.deepEqual(result, [sources[2]]);
  assert.equal(calls, 0);
});

test('parallel prefix probes put the first verified completion first and abort every remaining attempt', async () => {
  const pending = new Map();
  const parent = new AbortController();
  const ranking = rankSources({ sources, size, signal: parent.signal, validateUrl, request: (url, options) => new Promise((resolve, reject) => {
    pending.set(url, { options, resolve, reject });
    options.signal.addEventListener('abort', () => reject(aborted()), { once: true });
  }) });
  assert.equal(pending.size, 3);
  for (const { options } of pending.values()) {
    assert.equal(options.rangeStart, 0);
    assert.equal(options.rangeEnd, prefix.length - 1);
    assert.equal(options.maxBytes, size);
    assert.equal(options.timeoutMs, 8000);
  }
  const fastest = pending.get(sources[1].url);
  fastest.resolve(complete(fastest.options));
  assert.deepEqual(await ranking, [sources[1], sources[0], sources[2]]);
  assert.ok([...pending.values()].every(attempt => attempt.options.signal.aborted));
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('a source ignoring Range is stopped after its valid prefix instead of downloading the whole installer', async () => {
  let consumed = 0, winningSignal;
  const result = await rankSources({ sources: sources.slice(0, 2), size, validateUrl, request: async (url, options) => {
    if (url !== sources[0].url) return new Promise(() => {});
    winningSignal = options.signal;
    options.onResponse({ statusCode: 200, headers: { 'content-length': String(size) } });
    for (let offset = 0; offset < size && !options.signal.aborted; offset += 16 * 1024) {
      const chunk = Buffer.alloc(16 * 1024, 7);
      if (!offset) chunk.write('MZ');
      consumed += chunk.length;
      options.onChunk(chunk);
    }
    throw aborted();
  } });
  assert.equal(result[0], sources[0]);
  assert.equal(consumed, prefix.length);
  assert.equal(winningSignal.aborted, true);
});

test('MZ verification tolerates a split magic prefix and buffered request adapters', async () => {
  const result = await rankSources({ sources: sources.slice(0, 2), size, validateUrl, request: async (url, options) => {
    if (url === sources[1].url) throw new Error('Unavailable');
    options.onResponse({ statusCode: 206, headers: { 'content-range': `bytes 0-${prefix.length - 1}/${size}` } });
    options.onChunk(prefix.subarray(0, 1));
    options.onChunk(prefix.subarray(1));
    return { statusCode: 206 };
  } });
  assert.equal(result[0], sources[0]);
  const buffered = await rankSources({ sources: sources.slice(0, 2), size, validateUrl, request: async url => {
    if (url === sources[0].url) throw new Error('Unavailable');
    return { statusCode: 206, headers: { 'content-range': `bytes 0-${prefix.length - 1}/${size}` }, body: prefix };
  } });
  assert.equal(buffered[0], sources[1]);
});

test('invalid response ranges, lengths, compression and installer magic cannot win the probe race', async () => {
  const invalid = [
    { headers: {} },
    { headers: { 'content-range': `bytes 1-${prefix.length}/${size}` } },
    { headers: { 'content-range': `bytes 0-${prefix.length - 2}/${size}` } },
    { headers: { 'content-range': `bytes 0-${prefix.length - 1}/${size + 1}` } },
    { headers: { 'content-range': `bytes 0-${prefix.length - 1}/*` } },
    { headers: { 'content-range': `bytes 0-${prefix.length - 1}/${size}`, 'content-length': '1' } },
    { headers: { 'content-range': `bytes 0-${prefix.length - 1}/${size}`, 'content-encoding': 'gzip' } },
    { statusCode: 200, headers: { 'content-length': String(size + 1) } },
    { statusCode: 503, headers: {} },
    { body: Buffer.alloc(prefix.length, 7) },
    { body: prefix.subarray(0, prefix.length - 1) },
    { body: Buffer.concat([prefix, Buffer.from([1])]) },
  ];
  for (const badResponse of invalid) {
    const result = await rankSources({ sources: sources.slice(0, 2), size, validateUrl, request: async (url, options) => {
      if (url === sources[0].url) return complete(options, badResponse);
      await Promise.resolve();
      return complete(options);
    } });
    assert.equal(result[0], sources[1], JSON.stringify(badResponse.headers || { bodyBytes: badResponse.body?.length }));
  }
});

test('redirects are individually validated and cannot leave the fixed asset sources', async () => {
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/public?signature=test';
  const visited = [];
  const checked = [];
  const result = await rankSources({ sources: [sources[2], sources[0]], size, validateUrl: url => { checked.push(url); validateUrl(url); }, request: async (url, options) => {
    visited.push(url);
    if (url === sources[0].url) return new Promise(() => {});
    if (url === canonical) return { statusCode: 302, headers: { location: cdn } };
    return complete(options);
  } });
  assert.equal(result[0], sources[2]);
  assert.ok(checked.includes(cdn));
  assert.ok(visited.includes(cdn));
  const unsafeVisited = [];
  const fallback = await rankSources({ sources: sources.slice(0, 2), size, validateUrl, request: async (url, options) => {
    unsafeVisited.push(url);
    if (url === sources[0].url) return { statusCode: 302, headers: { location: 'https://attacker.invalid/setup.exe' } };
    await Promise.resolve();
    return complete(options);
  } });
  assert.equal(fallback[0], sources[1]);
  assert.equal(unsafeVisited.some(url => url.includes('attacker.invalid')), false);
});

test('redirect loops and wholly unavailable probes retain the original fallback order', async () => {
  let redirectCalls = 0;
  const result = await rankSources({ sources: sources.slice(0, 2), size, validateUrl, request: async url => {
    if (url === sources[1].url) throw new Error('Unavailable');
    redirectCalls++;
    return { statusCode: 302, headers: { location: url } };
  } });
  assert.equal(redirectCalls, 6);
  assert.deepEqual(result, sources.slice(0, 2));
  const unavailable = await rankSources({ sources, size, validateUrl, request: async () => { throw new Error('Unavailable'); } });
  assert.deepEqual(unavailable, sources);
});

test('parent cancellation rejects immediately and stops probes even if the request adapter ignores abort', async () => {
  const parent = new AbortController();
  const signals = [];
  const ranking = rankSources({ sources, size, signal: parent.signal, validateUrl, request: (_url, options) => { signals.push(options.signal); return new Promise(() => {}); } });
  parent.abort();
  await assert.rejects(ranking, error => error.code === 'ABORT_ERR');
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  let calls = 0;
  await assert.rejects(rankSources({ sources, size, signal: parent.signal, validateUrl, request: async () => { calls++; } }), error => error.code === 'ABORT_ERR');
  assert.equal(calls, 0);
});

test('unresponsive probes stop at the eight-second deadline and preserve every fallback source', { timeout: 15000 }, async () => {
  const signals = [];
  const result = await rankSources({ sources, size, validateUrl, request: (_url, options) => { signals.push(options.signal); return new Promise(() => {}); } });
  assert.deepEqual(result, sources);
  assert.ok(signals.every(signal => signal.aborted));
});
