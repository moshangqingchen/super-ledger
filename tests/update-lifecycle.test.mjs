import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createUpdateLifecycle } = createRequire(import.meta.url)('../desktop/update-controller.cjs');

function fixture() {
  let enabled = true, task = async () => ({ phase: 'idle' });
  const calls = { checks: 0, timers: [], cleared: [], results: [], errors: [] };
  const lifecycle = createUpdateLifecycle({
    check: () => { calls.checks++; return task(); }, enabled: () => enabled, intervalMs: 21600000,
    setIntervalFn: (fn, delay) => { const timer = { fn, delay }; calls.timers.push(timer); return timer; },
    clearIntervalFn: timer => calls.cleared.push(timer),
    onResult: (value, reason) => calls.results.push({ value, reason }),
    onError: (error, reason) => calls.errors.push({ message: error.message, reason }),
  });
  return { lifecycle, calls, setEnabled: value => { enabled = value; }, setTask: fn => { task = fn; } };
}

test('opening before ready is covered by exactly one immediate startup check', async () => {
  const f = fixture();
  await f.lifecycle.opened(); assert.equal(f.calls.checks, 0);
  await f.lifecycle.start(); await f.lifecycle.start();
  assert.equal(f.calls.checks, 1); assert.equal(f.calls.timers.length, 1);
  assert.equal(f.calls.timers[0].delay, 21600000);
  assert.equal(f.calls.results[0].reason, 'startup');
});

test('each explicit reopen checks again, and periodic checks remain enabled', async () => {
  const f = fixture(); await f.lifecycle.start();
  await f.lifecycle.opened(); await f.lifecycle.opened();
  f.calls.timers[0].fn(); await f.lifecycle.opened();
  assert.equal(f.calls.checks, 4);
  assert.deepEqual(f.calls.results.map(r => r.reason), ['startup', 'open', 'open', 'periodic']);
});

test('startup and duplicate tray events share one in-flight check', async () => {
  const f = fixture(); let finish;
  f.setTask(() => new Promise(resolve => { finish = resolve; }));
  const first = f.lifecycle.start(); const next = f.lifecycle.opened();
  assert.equal(first, next); await Promise.resolve(); assert.equal(f.calls.checks, 1);
  finish({ phase: 'available' }); await Promise.all([first, next]);
  assert.equal(f.calls.results.length, 1);
});

test('disabled test/development mode neither checks nor starts a timer', async () => {
  const f = fixture(); f.setEnabled(false);
  await f.lifecycle.start(); await f.lifecycle.opened();
  assert.equal(f.calls.checks, 0); assert.equal(f.calls.timers.length, 0);
});

test('failure releases the in-flight guard so the next opening retries', async () => {
  const f = fixture(); f.setTask(async () => { throw new Error('proxy unavailable'); });
  await f.lifecycle.start();
  assert.deepEqual(f.calls.errors, [{ message: 'proxy unavailable', reason: 'startup' }]);
  f.setTask(async () => ({ phase: 'idle' })); await f.lifecycle.opened();
  assert.equal(f.calls.checks, 2); assert.equal(f.calls.results[0].reason, 'open');
});

test('quit cancels the timer and suppresses queued or late work', async () => {
  const queued = fixture(); const first = queued.lifecycle.start();queued.lifecycle.close();await first;
  assert.equal(queued.calls.checks, 0); assert.equal(queued.calls.cleared.length, 1);
  const f = fixture(); let finish;
  f.setTask(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.lifecycle.start(); await Promise.resolve(); f.lifecycle.close();
  finish({ phase: 'available' }); await pending;
  await f.lifecycle.opened(); await f.lifecycle.start();f.calls.timers[0].fn();await Promise.resolve();
  assert.equal(f.calls.checks, 1);assert.equal(f.calls.results.length, 0);assert.equal(f.calls.cleared.length, 1);
});
