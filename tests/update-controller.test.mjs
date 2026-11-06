import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createUpdateController } = createRequire(import.meta.url)('../desktop/update-controller.cjs');

// All dependencies are in-memory. These tests cannot access the network,
// launch an installer, quit Electron, or read an actual ledger.
function fixture() {
  const state = { enabled: true, phase: 'available', currentVersion: '1.7.0', availableVersion: '1.8.0', ready: false, deferredUntil: 0 };
  const calls = { checks: 0, downloads: 0, installs: 0, guards: 0, quits: 0, prompts: [] };
  let visible = true, editor = false, now = 1000;
  let guard = async () => editor;
  let launch = async () => { state.phase = 'installing'; };
  const updater = {
    status: () => ({ ...state }),
    shouldPrompt: () => state.enabled && ['available', 'ready'].includes(state.phase) && now >= state.deferredUntil,
    check: async () => { calls.checks++; return updater.status(); },
    download: async () => { calls.downloads++; state.phase = 'ready'; state.ready = true; return updater.status(); },
    install: async () => { calls.installs++; return launch(); },
    defer: () => { state.deferredUntil = now + 86400000; return updater.status(); },
  };
  const controller = createUpdateController({
    updater,
    isVisible: () => visible,
    hasOpenEditor: async () => { calls.guards++; return guard(); },
    notify: value => calls.prompts.push(value),
    quit: () => { calls.quits++; },
  });
  return { controller, updater, state, calls,
    setVisible: value => { visible = value; },
    setEditor: value => { editor = value; },
    setGuard: value => { guard = value; },
    setLaunch: value => { launch = value; },
    advance: milliseconds => { now += milliseconds; },
  };
}

test('a check while hidden does not consume the prompt when the window is shown again', async () => {
  const f = fixture();
  f.setVisible(false);
  assert.equal((await f.controller.check()).availableVersion, '1.8.0');
  assert.deepEqual(f.calls.prompts, []);
  f.setVisible(true);
  await f.controller.offer();
  await f.controller.offer();
  assert.deepEqual(f.calls.prompts, [{ manual: false, reason: 'available' }]);
});

test('automatic offers deduplicate focus/check events, but a new phase or version can be offered', async () => {
  const f = fixture();
  await Promise.all([f.controller.offer(), f.controller.offer(), f.controller.check()]);
  assert.equal(f.calls.prompts.length, 1);
  f.state.phase = 'ready'; f.state.ready = true;
  await f.controller.offer();
  await f.controller.check();
  assert.equal(f.calls.prompts.length, 2);
  f.state.availableVersion = '1.9.0'; f.state.phase = 'available'; f.state.ready = false;
  await f.controller.check();
  assert.equal(f.calls.prompts.length, 3);
});

test('manual checks always present the result including deferred, latest, and failed checks', async () => {
  const f = fixture();
  await f.controller.offer();
  f.controller.defer();
  await f.controller.check(true);
  f.state.phase = 'idle'; f.state.availableVersion = null;
  await f.controller.check(true);
  f.state.phase = 'error'; f.state.error = 'proxy unavailable';
  await f.controller.check(true);
  assert.deepEqual(f.calls.prompts.map(value => [value.manual, value.reason]), [
    [false, 'available'], [true, 'available'], [true, 'idle'], [true, 'error'],
  ]);
  assert.equal(f.calls.downloads, 0);
  assert.equal(f.calls.installs, 0);
});

test('choosing later suppresses the reminder only until the persisted cooldown expires', async () => {
  const f = fixture();
  await f.controller.offer();
  f.controller.defer();
  await f.controller.offer();
  f.advance(86400001);
  await f.controller.check();
  await f.controller.offer();
  assert.equal(f.calls.prompts.length, 2, 'the same version should be offered once again after its cooldown');
});

test('renderer reload can request a fresh prompt after automatic deduplication', async () => {
  const f = fixture();
  await f.controller.offer();
  f.controller.resetPrompt();
  await f.controller.offer();
  assert.equal(f.calls.prompts.length, 2);
});

test('checking, offering, and downloading never install; only the explicit install action quits', async () => {
  const f = fixture();
  await f.controller.check(true);
  const result = await f.controller.download();
  assert.equal(result.ready, true);
  await f.controller.offer();
  assert.equal(f.calls.installs, 0);
  assert.equal(f.calls.quits, 0);
  await f.controller.install();
  assert.equal(f.calls.installs, 1);
  assert.equal(f.calls.quits, 1);
});

test('an unverified download cannot be installed', async () => {
  const f = fixture();
  await assert.rejects(f.controller.install(), /下载并验证/);
  assert.equal(f.calls.guards, 0);
  assert.equal(f.calls.installs, 0);
  assert.equal(f.calls.quits, 0);
});

test('an open editor blocks installation and saving it allows a later explicit attempt', async () => {
  const f = fixture();
  await f.controller.download();
  f.setEditor(true);
  await assert.rejects(f.controller.install(), /保存或关闭/);
  assert.equal(f.calls.installs, 0);
  assert.equal(f.calls.quits, 0);
  assert.equal(f.state.ready, true);
  f.setEditor(false);
  await f.controller.install();
  assert.equal(f.calls.installs, 1);
  assert.equal(f.calls.quits, 1);
});

test('a failed editor guard fails closed and releases its lock for a later retry', async () => {
  const f = fixture();
  await f.controller.download();
  f.setGuard(async () => { throw new Error('renderer unavailable'); });
  await assert.rejects(f.controller.install(), /renderer unavailable/);
  assert.equal(f.calls.installs, 0);
  assert.equal(f.calls.quits, 0);
  f.setGuard(async () => false);
  await f.controller.install();
  assert.equal(f.calls.quits, 1);
});

test('installer failure keeps the app open and permits another explicit installation attempt', async () => {
  const f = fixture();
  await f.controller.download();
  f.setLaunch(async () => { f.state.phase = 'error'; throw new Error('installer could not start'); });
  await assert.rejects(f.controller.install(), /could not start/);
  assert.equal(f.calls.installs, 1);
  assert.equal(f.calls.quits, 0);
  assert.equal(f.state.ready, true);
  f.setLaunch(async () => { f.state.phase = 'installing'; });
  await f.controller.install();
  assert.equal(f.calls.installs, 2);
  assert.equal(f.calls.quits, 1);
});

test('concurrent install requests are rejected while checking edits and while launching', async () => {
  const f = fixture();
  await f.controller.download();
  let allowGuard, allowLaunch, markLaunch;
  const launchStarted = new Promise(resolve => { markLaunch = resolve; });
  f.setGuard(() => new Promise(resolve => { allowGuard = resolve; }));
  f.setLaunch(() => { markLaunch(); return new Promise(resolve => { allowLaunch = resolve; }); });
  const first = f.controller.install();
  await assert.rejects(f.controller.install(), /正在准备安装/);
  assert.equal(f.calls.installs, 0);
  allowGuard(false);
  await launchStarted;
  await assert.rejects(f.controller.install(), /正在准备安装/);
  assert.equal(f.calls.installs, 1);
  assert.equal(f.calls.quits, 0);
  allowLaunch();
  await first;
  assert.equal(f.calls.quits, 1);
});
