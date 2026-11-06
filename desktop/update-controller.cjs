'use strict';

// Presentation stays in the isolated renderer. This controller retains the
// final unsaved-editor guard and never installs as a result of downloading.
function createUpdateController({ updater, isVisible, hasOpenEditor, notify, quit }) {
  let lastOffered = '', installing = false;
  async function offer(manual = false) {
    const value = updater.status();
    if (!manual) {
      if (!updater.shouldPrompt() || !isVisible()) return value;
      const key = `${value.availableVersion}:${value.phase}`;
      if (lastOffered === key) return value;
      lastOffered = key;
    }
    notify({ manual, reason: value.phase });
    return value;
  }
  async function check(manual = false) {
    const value = await updater.check();
    if (manual || ['available', 'ready'].includes(value.phase)) await offer(manual);
    return updater.status();
  }
  async function download() { return updater.download(); }
  async function install() {
    if (installing) throw new Error('正在准备安装，请稍候。');
    if (!updater.status().ready) throw new Error('请先下载并验证新版本。');
    installing = true;
    try {
      if (await hasOpenEditor()) throw new Error('请先保存或关闭正在编辑的账单，再确认退出并安装。');
      await updater.install();
      quit();
      return updater.status();
    } finally { installing = false; }
  }
  return { offer, check, download, install,
    defer: () => { const value = updater.defer(); lastOffered = ''; return value; },
    resetPrompt: () => { lastOffered = ''; },
  };
}

/** Check once after startup and on explicit reopening, without checking on focus. */
function createUpdateLifecycle({ check, enabled, intervalMs, onResult = () => {}, onError = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let started = false, closed = false, timer = null, pending = null;
  function run(reason) {
    if (!started || closed || !enabled()) return Promise.resolve(null);
    if (pending) return pending;
    pending = Promise.resolve().then(() => {
      if (closed || !enabled()) return null;
      return check();
    }).then(value => {
      if (!closed && value) onResult(value, reason);
      return value;
    }).catch(error => {
      if (!closed) onError(error, reason);
      return null;
    }).finally(() => { pending = null; });
    return pending;
  }
  return {
    start() {
      if (started || closed) return pending || Promise.resolve(null);
      started = true;
      if (!enabled()) return Promise.resolve(null);
      timer = setIntervalFn(() => { void run('periodic'); }, intervalMs);
      timer?.unref?.();
      return run('startup');
    },
    opened: () => run('open'),
    close() { closed = true; if (timer !== null) clearIntervalFn(timer); timer = null; },
  };
}

module.exports = { createUpdateController, createUpdateLifecycle };
