import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEmptyState, validateState } from '../engine.mjs';
import { formatMoney } from '../currencies.mjs';
import { captureDeletion, restoreDeletion } from '../assets/ledger-actions.mjs';

// Run the actual UI functions with small in-memory DOM/API doubles. No app startup,
// listening server, browser profile or real ledger storage is involved.
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}
const toastSource = section('function toast(', 'async function api(');
const undoSource = section('async function undoDeletion(', 'async function deleteItem(');

function clock() {
  let now = 0, nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].due;
        next[1].callback();
      }
      now = end;
    },
  };
}

function toastHarness() {
  const time = clock();
  const document = {
    activeElement: null,
    createElement(tag) { return element(tag); },
  };
  function element(tag) {
    const classes = new Set(), listeners = new Map();
    const node = {
      tagName: tag.toUpperCase(), children: [], parent: null, disabled: false,
      tabIndex: tag === 'button' ? 0 : -1, text: '',
      get textContent() { return this.text + this.children.map(child => child.textContent).join(''); },
      set textContent(value) {
        this.text = String(value);
        this.children.forEach(child => { child.parent = null; });
        this.children = [];
      },
      set innerHTML(_) { assert.fail('toast must not assign innerHTML'); },
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      append(child) { child.parent = this; this.children.push(child); },
      querySelector(selector) { return selector === 'button' ? this.children.find(child => child.tagName === 'BUTTON') || null : null; },
      remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
        this.parent = null;
      },
      addEventListener(type, handler, options) { listeners.set(type, { handler, once: options?.once }); },
      focus() { if (!this.disabled && this.tabIndex >= 0) document.activeElement = this; },
      async click() {
        if (this.disabled) return;
        const listener = listeners.get('click');
        if (!listener) return;
        if (listener.once) listeners.delete('click');
        await listener.handler();
      },
    };
    return node;
  }
  const root = element('div');
  const environment = {
    $: selector => selector === '#toast' ? root : null,
    document, toastTimer: undefined,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
  };
  const toast = new Function('environment', `with(environment){${toastSource};return toast;}`)(environment);
  return { toast, root, document, time };
}

function fixture(rows = [], revision = 0) {
  const state = makeEmptyState();
  state.accounts = [{ id: 'cash', name: '现金', type: '现金', color: '#123456', openingBalance: 0 }];
  state.transactions = rows.map(id => ({
    id, title: id, type: 'expense', amount: 100, accountId: 'cash',
    category: '其他支出', date: '2026-11-08', note: '',
  }));
  state.revision = revision;
  assert.equal(validateState(state), true);
  return state;
}

function undoHarness({ state = fixture(['before'], 2), latest = state, now = 0, apiError, commitResult = true, lastError, commitError } = {}) {
  const calls = [], messages = [];
  const environment = {
    state, busy: false, Date: { now: () => now }, restoreDeletion,
    toast: message => messages.push(message),
    api: async path => {
      calls.push({ type: 'api', path });
      if (apiError) throw apiError;
      return structuredClone(latest);
    },
    commit: Object.assign(async (next, message) => {
      calls.push({ type: 'commit', next, message });
      if (commitError) throw commitError;
      return commitResult;
    }, { lastError }),
  };
  const undo = new Function('environment', `with(environment){${undoSource};return undoDeletion;}`)(environment);
  return { undo, environment, calls, messages };
}

test('action toasts keep messages as text and expose a native focusable button in the live region', async () => {
  const { toast, root, document } = toastHarness();
  let executions = 0;
  toast('<img src=x onerror=bad()> 已删除', { label: '撤销', run: async () => { executions += 1; } });
  assert.equal(root.text, '<img src=x onerror=bad()> 已删除');
  assert.equal(root.children.length, 1);
  const button = root.querySelector('button');
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.type, 'button');
  assert.equal(button.textContent, '撤销');
  assert.equal(button.disabled, false);
  assert.equal(button.tabIndex, 0);
  button.focus();
  assert.equal(document.activeElement, button);
  await button.click();
  await button.click();
  assert.equal(executions, 1);
  assert.equal(button.disabled, true);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="toast"[^>]*role="status"[^>]*aria-live="polite"/);
  const css = readFileSync(new URL('../ledger-ui.css', import.meta.url), 'utf8');
  assert.match(css, /#toast\.toast-visible\s+\.toast-action\s*\{[^}]*pointer-events:\s*auto\s*;/);
});

test('undo action is removed after six seconds and replacing a toast cancels the earlier timeout', () => {
  const { toast, root, time } = toastHarness();
  toast('已删除', { label: '撤销', run: async () => {} });
  time.advance(5999);
  assert.ok(root.querySelector('button'));
  assert.equal(root.classList.contains('toast-visible'), true);
  time.advance(1);
  assert.equal(root.querySelector('button'), null);
  assert.equal(root.classList.contains('toast-visible'), false);
  toast('普通提示');
  time.advance(1000);
  toast('又删除了一笔', { label: '撤销', run: async () => {} });
  time.advance(2500);
  assert.ok(root.querySelector('button'), 'the earlier ordinary-toast timeout was cancelled');
  time.advance(3500);
  assert.equal(root.querySelector('button'), null);
});

test('an asynchronous action failure becomes a safe text toast with no rejected event promise', async () => {
  const { toast, root, time } = toastHarness();
  toast('已删除', { label: '撤销', run: async () => { throw new Error('<b>连接失败</b>'); } });
  await assert.doesNotReject(() => root.querySelector('button').click());
  assert.equal(root.textContent, '撤销失败：<b>连接失败</b>');
  assert.equal(root.querySelector('button'), null);
  time.advance(3499);
  assert.equal(root.classList.contains('toast-visible'), true);
  time.advance(1);
  assert.equal(root.classList.contains('toast-visible'), false);
});

test('undo fetches current state before restoring and preserves the new revision and synchronized bills', async () => {
  const deletion = captureDeletion(fixture(['before', 'deleted'], 1), 'transaction', 'deleted');
  const state = fixture(['before'], 2);
  const latest = fixture(['before', 'sync-added'], 5);
  latest.transactions[0].note = '同步修改';
  const harness = undoHarness({ state, latest });
  await assert.doesNotReject(() => harness.undo(deletion, 6000));
  assert.deepEqual(harness.calls.map(call => call.type), ['api', 'commit']);
  assert.equal(harness.calls[0].path, '/api/state');
  const committed = harness.calls[1];
  assert.equal(committed.next.revision, 5);
  assert.deepEqual(committed.next.transactions.map(row => row.id), ['before', 'deleted', 'sync-added']);
  assert.equal(committed.next.transactions[0].note, '同步修改');
  assert.equal(committed.message, '已撤销删除');
  assert.deepEqual(harness.messages, []);
  assert.equal(state.transactions.length, 1, 'the stale input snapshot is not mutated');
});

test('undo never downgrades a state newer than its API response', async () => {
  const deletion = captureDeletion(fixture(['before', 'deleted']), 'transaction', 'deleted');
  const harness = undoHarness({ state: fixture(['before', 'local-newer'], 7), latest: fixture(['before'], 6) });
  await harness.undo(deletion, 6000);
  assert.equal(harness.calls[1].next.revision, 7);
  assert.ok(harness.calls[1].next.transactions.some(row => row.id === 'local-newer'));
});

test('expired and busy undo attempts report the reason without reading or writing the ledger', async () => {
  const deletion = captureDeletion(fixture(['deleted']), 'transaction', 'deleted');
  const expired = undoHarness({ now: 6001 });
  await assert.doesNotReject(() => expired.undo(deletion, 6000));
  assert.deepEqual(expired.calls, []);
  assert.match(expired.messages[0], /超过 6 秒撤销期限/);
  const busy = undoHarness();
  busy.environment.busy = true;
  await assert.doesNotReject(() => busy.undo(deletion, 6000));
  assert.deepEqual(busy.calls, []);
  assert.match(busy.messages[0], /正在保存其他修改/);
});

test('an undo that becomes busy while reading current state does not race a second commit', async () => {
  const deletion = captureDeletion(fixture(['deleted']), 'transaction', 'deleted');
  const harness = undoHarness();
  harness.environment.api = async () => {
    harness.environment.busy = true;
    return fixture(['new'], 8);
  };
  await assert.doesNotReject(() => harness.undo(deletion, 6000));
  assert.equal(harness.calls.some(call => call.type === 'commit'), false);
  assert.match(harness.messages[0], /正在保存其他修改/);
});

test('undo reports ID conflicts, network failures and thrown save failures without unhandled rejection', async () => {
  const deletion = captureDeletion(fixture(['before', 'deleted']), 'transaction', 'deleted');
  for (const [options, expected, commits] of [
    [{ latest: fixture(['before', 'deleted'], 3) }, /相同 ID/, 0],
    [{ apiError: new Error('连接不可用') }, /连接不可用/, 0],
    [{ commitError: new Error('保存被拒绝') }, /保存被拒绝/, 1],
  ]) {
    const harness = undoHarness(options);
    await assert.doesNotReject(() => harness.undo(deletion, 6000));
    assert.equal(harness.calls.filter(call => call.type === 'commit').length, commits);
    assert.match(harness.messages[0], expected);
  }
});

test('a false commit result explains the conflict using lastError or the fallback message', async () => {
  const deletion = captureDeletion(fixture(['before', 'deleted']), 'transaction', 'deleted');
  for (const [lastError, expected] of [
    ['账本已被另一设备更新（409）', /另一设备更新（409）/],
    [undefined, /账本已更新，请检查后重试/],
  ]) {
    const harness = undoHarness({ commitResult: false, lastError });
    await assert.doesNotReject(() => harness.undo(deletion, 6000));
    assert.equal(harness.calls.filter(call => call.type === 'commit').length, 1);
    assert.match(harness.messages[0], expected);
    assert.equal(harness.messages.length, 1);
  }
});

test('goal adjustment modal masks all three amounts and escapes the goal name and amount draft', () => {
  const modalSource = [
    source.match(/^const esc\s*=[^\r\n]+/m)[0],
    section('function insightMoney(', 'function chart('),
    source.match(/^function field\([^\r\n]+/m)[0],
    section('function goalDepositModal(', 'function goalModal('),
  ].join('\n');
  for (const hidden of [false, true]) {
    let rendered;
    const environment = {
      state: { goals: [{ id: 'goal', name: '<img src=x> 心愿', saved: 12345, target: 98765 }] },
      hidden, yuan: value => formatMoney(value, 'CNY'), footer: () => '',
      modal: (title, subtitle, body) => { rendered = { title, subtitle, body }; },
      toast: () => assert.fail('existing goal should open a modal'),
    };
    const show = new Function('environment', `with(environment){${modalSource};return goalDepositModal;}`)(environment);
    show('goal', 'withdraw', '\"><script>bad</script>');
    assert.equal(rendered.title, '从心愿中取出');
    assert.equal(rendered.subtitle, '&lt;img src=x&gt; 心愿');
    assert.equal((rendered.body.match(/<input\b/g) || []).length, 1);
    assert.match(rendered.body, /&quot;&gt;&lt;script&gt;bad&lt;\/script&gt;/);
    assert.doesNotMatch(rendered.body, /<script>/);
    assert.match(rendered.body, /不影响总资产/);
    assert.equal((rendered.body.match(/class="money"/g) || []).length, 3);
    if (hidden) {
      assert.equal((rendered.body.match(/••••/g) || []).length, 3);
      assert.doesNotMatch(rendered.body, /123\.45|987\.65|864\.20/);
    } else {
      assert.match(rendered.body, /¥ 123\.45/);
      assert.match(rendered.body, /¥ 987\.65/);
      assert.match(rendered.body, /¥ 864\.20/);
    }
  }
});
