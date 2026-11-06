const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function formatUpdateBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function formatUpdateRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '待估算';
  const total = Math.ceil(seconds);
  if (total < 60) return `约 ${total} 秒`;
  if (total < 3600) return `约 ${Math.ceil(total / 60)} 分钟`;
  const minutes = Math.ceil(total / 60);
  return `约 ${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`;
}

const WAITING_AFTER_MS = 8000;
const nonnegative = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

/** Only a current, measured speed can produce an estimate; waiting is not a failure. */
export function updateTransferDetails(status = {}, idleForMs = 0) {
  const downloaded = nonnegative(status.downloadedBytes), total = nonnegative(status.totalBytes);
  const retry = Number.isSafeInteger(status.retryAttempt) && status.retryAttempt > 0 ? status.retryAttempt : 0;
  const pending = { speed: '—', remaining: '待估算' };
  if (retry) return { ...pending, state: 'retrying', label: '重试中', message: `正在等待第 ${retry} 次自动重试，可以继续后台等待或取消下载。` };
  if (total > 0 && downloaded >= total) return { ...pending, state: 'verifying', label: '校验中', remaining: '下载完成', message: '下载完成，正在校验安装包；校验通过后才能安装。' };
  if (idleForMs >= WAITING_AFTER_MS) return { ...pending, state: 'waiting', label: '等待中', message: downloaded > 0 ? '暂未收到新数据，正在等待下载继续；仍可后台等待或取消。' : '正在等待下载源响应；仍可后台等待或取消。' };
  const speed = nonnegative(status.bytesPerSecond);
  if (speed > 0) return {
    state: 'downloading', label: '下载中', speed: `${formatUpdateBytes(speed)}/s`,
    remaining: total > downloaded ? formatUpdateRemaining((total - downloaded) / speed) : '待估算',
    message: '正在下载，剩余时间会随当前速度调整。'
  };
  return { ...pending, state: 'connecting', label: '下载中', message: downloaded > 0 ? '正在计算下载速度，收到更多数据后会显示剩余时间。' : '正在连接下载源，收到数据后会显示速度与剩余时间。' };
}

export function releaseHighlights(notes, limit = 3) {
  const paragraphs = String(notes || '').replace(/\r\n?/g, '\n').split(/\n+/).map(text => text
    .replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)、]\s*)/, '').replace(/\*\*/g, '').trim()).filter(Boolean);
  const metadataPrefix = /^(?:Windows\s+\d|Android\s+\d|版本[：:]|验证[：:]|下载前|先更新电脑|安装说明[：:])/i;
  const useful = paragraphs.filter(text => !metadataPrefix.test(text) && !/^更新说明[：:]?$/.test(text));
  return useful.slice(0, Math.max(0, limit)).map(text => {
    const sentence = text.match(/^.*?[。！？]/)?.[0]?.trim() || text;
    return Array.from(sentence).length > 94 ? `${Array.from(sentence).slice(0, 93).join('')}…` : sentence;
  });
}

function checkedTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

const stableStatus = status => JSON.stringify([status.phase, status.enabled, status.currentVersion, status.availableVersion, status.notes, status.error, status.totalBytes, status.ready, status.operation, status.lastCheckedAt]);

/** App-owned update surfaces. Release notes are always rendered as plain, escaped text. */
export function createUpdateUI({ desktop, icon = () => '', onStatus = () => {}, initialStatus = null } = {}) {
  let status = initialStatus || { phase: 'idle', currentVersion: '', enabled: Boolean(desktop?.checkForUpdates) };
  let opened = false, installConfirm = false, pendingPrompt = null, lastFocus = null, lastFocusAction = '', previousOverflow = '', detailsOpen = false;
  let latestAction = 'check', destroyed = false, cancelPending = false;
  let lastProgressAt = Date.now(), progressTimer = null;
  const running = new Set(), unsubscribe = [];
  let root = document.getElementById('update-root');
  if (!root) { root = document.createElement('div'); root.id = 'update-root'; document.body.append(root); }

  const glyph = (name, size = 20) => `<span class="update-glyph" aria-hidden="true">${icon(name, size)}</span>`;
  const version = value => value ? `v${String(value).replace(/^v/i, '')}` : '—';
  const actionButton = (action, label, primary = false, disabled = false, extra = '') => `<button type="button" class="update-button ${primary ? 'update-button--primary' : 'update-button--secondary'} ${extra}" data-update-action="${action}"${disabled ? ' disabled' : ''}>${label}</button>`;
  const progressPercent = () => nonnegative(status.totalBytes) > 0 ? Math.max(0, Math.min(100, Math.floor(nonnegative(status.downloadedBytes) / nonnegative(status.totalBytes) * 100))) : 0;
  const progressText = () => `${formatUpdateBytes(status.downloadedBytes)}${status.totalBytes > 0 ? ` / ${formatUpdateBytes(status.totalBytes)}` : ''}`;
  const transferDetails = () => updateTransferDetails(status, Math.max(0, Date.now() - lastProgressAt));
  const progress = () => {
    const transfer = transferDetails();
    return `<div class="update-progress-wrap" data-update-transfer-state="${transfer.state}"><div class="update-progress-caption"><span data-update-bytes>${progressText()}</span><strong data-update-percent>${status.totalBytes > 0 ? `${progressPercent()}%` : '准备中'}</strong></div><div class="update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin="0" aria-valuemax="100" ${status.totalBytes > 0 ? `aria-valuenow="${progressPercent()}"` : ''}><span style="width:${progressPercent()}%"></span></div><div class="update-transfer-metrics"><span>速度 <strong data-update-speed>${transfer.speed}</strong></span><span>预计剩余 <strong data-update-eta>${transfer.remaining}</strong></span></div><p class="update-transfer-status" data-update-transfer-status role="status" aria-live="polite">${transfer.message}</p></div>`;
  };
  const latestText = () => checkedTime(status.lastCheckedAt) ? `上次检查 ${checkedTime(status.lastCheckedAt)}` : '可以随时检查新版本';

  function receiveStatus(next) {
    if (next.phase === 'downloading' && (status.phase !== 'downloading' || next.availableVersion !== status.availableVersion || nonnegative(next.downloadedBytes) !== nonnegative(status.downloadedBytes) || next.retryAttempt !== status.retryAttempt)) lastProgressAt = Date.now();
    status = { ...next };
    if (!destroyed && status.phase === 'downloading') {
      if (progressTimer === null) progressTimer = window.setInterval(patchProgress, 1000);
    } else if (progressTimer !== null) {
      window.clearInterval(progressTimer); progressTimer = null;
    }
  }

  function settingsContent(value) {
    const current = value && typeof value === 'object' ? value : status;
    // The optional argument is useful during the app's first render, before the first IPC event.
    if (current !== status) receiveStatus(current);
    const phase = status.phase || 'idle', available = Boolean(status.availableVersion);
    let label = '版本更新', detail = '新变化，会在这里和你见面。', badge = '', actions = '';
    if (status.enabled === false) {
      label = '自动更新暂不可用'; detail = '请在已安装的 Windows 桌面版中检查更新。';
    } else if (phase === 'checking') {
      label = '正在检查新版本'; detail = '稍等一下，正在获取版本信息。'; badge = '<span class="update-chip is-muted">检查中</span>';
      actions = actionButton('show', '查看进度');
    } else if (phase === 'downloading') {
      label = `正在下载 ${escapeHTML(version(status.availableVersion))}`; detail = '可以继续记账，下载完成后由你决定何时安装。'; badge = `<span class="update-chip" data-update-download-label>${transferDetails().label}</span>`;
      actions = actionButton('show', '查看下载', true);
    } else if (phase === 'ready') {
      label = `新版本 ${escapeHTML(version(status.availableVersion))} 已下载`; detail = '安装包已校验，准备好后即可升级。'; badge = '<span class="update-chip is-success">准备就绪</span>';
      actions = actionButton('install', '准备安装', true) + actionButton('show', '查看详情');
    } else if (phase === 'installing') {
      label = '正在启动安装程序'; detail = '完成覆盖安装后，继续使用原来的账本。'; badge = '<span class="update-chip is-muted">安装中</span>';
    } else if (phase === 'error') {
      label = '更新暂时没完成'; detail = '你的账本不受影响，可以查看详情后重试。'; badge = '<span class="update-chip is-warning">需要重试</span>';
      actions = actionButton('show', '查看详情', true) + actionButton('retry', '重试');
    } else if (available) {
      label = `发现新版本 ${escapeHTML(version(status.availableVersion))}`;
      detail = '更新内容已经整理好，花一点时间看看吧。'; badge = '<span class="update-chip">有更新</span>';
      actions = actionButton('show', '查看更新', true) + actionButton('check', '检查更新');
    } else {
      label = status.lastCheckedAt ? '已经是最新版本' : '保持更新，轻松记账';
      detail = status.lastCheckedAt ? '当前版本已是最新，安心使用吧。' : '有新版本时会提醒你，升级时间由你决定。';
      badge = status.lastCheckedAt ? '<span class="update-chip is-success">已是最新</span>' : '';
      actions = actionButton('check', '检查更新');
    }
    return `<div class="update-settings"><div class="update-settings-top"><div class="update-settings-heading">${glyph('download', 19)}<h2>应用更新</h2></div>${badge}</div><div class="update-settings-main"><div class="update-settings-copy"><h3>${label}</h3><p>${detail}</p></div><div class="update-settings-actions">${actions}</div></div>${phase === 'downloading' ? progress() : ''}<div class="update-settings-meta"><span>Windows ${escapeHTML(version(status.currentVersion))}</span>${status.enabled!==false?'<span>每次打开自动检查</span>':''}<span>${escapeHTML(latestText())}</span></div></div>`;
  }

  function refreshSettings() {
    const panel = document.getElementById('desktop-update-panel');
    if (!panel) return;
    const focused = panel.contains(document.activeElement) ? document.activeElement?.dataset.updateAction : null;
    panel.innerHTML = settingsContent();
    if (focused && !opened) panel.querySelector(`[data-update-action="${focused}"]`)?.focus({ preventScroll: true });
  }

  function versionStrip() {
    return `<div class="update-version-strip"><div><span class="update-version-label">当前版本</span><strong>${escapeHTML(version(status.currentVersion))}</strong></div>${status.availableVersion ? `${glyph('right', 17)}<div class="update-new-version"><span class="update-version-label">新版本</span><strong>${escapeHTML(version(status.availableVersion))}</strong></div>` : ''}${status.totalBytes > 0 ? `<span class="update-size">${formatUpdateBytes(status.totalBytes)}</span>` : '<span class="update-size">Windows 桌面版</span>'}</div>`;
  }

  function notesContent() {
    const notes = String(status.notes || '').trim();
    if (!notes) return '<p class="update-empty-notes">此版本暂无详细更新说明。</p>';
    const highlights = releaseHighlights(notes);
    return `${highlights.length ? `<div class="update-highlights"><h3>这次有哪些新变化</h3><ul>${highlights.map((text, index) => `<li><span class="update-highlight-index" aria-hidden="true">0${index + 1}</span><p>${escapeHTML(text)}</p></li>`).join('')}</ul></div>` : ''}<details class="update-notes"${detailsOpen ? ' open' : ''}><summary>完整更新说明 ${glyph('down', 15)}</summary><div class="update-notes-text">${escapeHTML(notes)}</div></details>`;
  }

  function dialogContent() {
    const phase = status.phase || 'idle';
    let title, subtitle, mark = 'download', body = '', actions = '', statusText = '';
    if (status.enabled === false) {
      title = '自动更新暂不可用'; subtitle = '请在已安装的 Windows 桌面版中检查更新。'; mark = 'info';
      body = versionStrip(); actions = actionButton('close', '知道了', true);
    } else if (installConfirm && (phase === 'ready' || status.ready)) {
      title = '准备好升级了吗？'; subtitle = '安装程序将打开，完成后继续使用你的账本。';
      body = `${versionStrip()}<div class="update-install-note">${glyph('shield', 23)}<div><strong>原来的账本，会好好保留</strong><p>升级沿用现有账本与设置。请先完成当前操作，再退出应用并覆盖安装。</p></div></div>`;
      actions = actionButton('back', '再等一下') + actionButton('confirm-install', '退出并安装', true);
    } else if (phase === 'checking') {
      title = '正在寻找新变化'; subtitle = '检查版本信息，马上就好。';
      body = `${versionStrip()}<div class="update-state-box"><span class="update-spinner" aria-hidden="true"></span><p>正在检查更新…</p></div>`;
      actions = actionButton('close', '后台检查'); statusText = '正在检查更新';
    } else if (phase === 'downloading') {
      title = '新版本正在路上'; subtitle = '下载可以在后台进行，继续安心记账。';
      body = `${versionStrip()}<div class="update-download-box">${progress()}<p>下载完成后会校验安装包，再由你确认安装。</p></div>`;
      actions = actionButton('cancel', cancelPending ? '正在取消…' : '取消下载', false, cancelPending) + actionButton('close', '后台下载', true);
    } else if (phase === 'ready') {
      title = '新版本，准备好了'; subtitle = '安装包已下载并完成校验，随时可以升级。'; mark = 'check';
      body = versionStrip() + notesContent();
      actions = actionButton('defer', '稍后安装') + actionButton('install', '准备安装', true); statusText = '更新已下载完成';
    } else if (phase === 'installing') {
      title = '正在启动安装程序'; subtitle = '请在安装窗口中继续完成升级。';
      body = `${versionStrip()}<div class="update-state-box"><span class="update-spinner" aria-hidden="true"></span><p>正在安全退出并开始安装…</p></div>`;
      actions = actionButton('close', '知道了'); statusText = '正在启动安装程序';
    } else if (phase === 'error') {
      title = '这次更新没完成'; subtitle = '账本不受影响，稍后再试也没关系。'; mark = 'info';
      body = `${versionStrip()}<div class="update-error"><strong>遇到了一点问题</strong><p>${escapeHTML(status.error || '暂时无法完成更新，请稍后重试。')}</p></div>`;
      actions = actionButton('close', '稍后再说') + actionButton('retry', '重新尝试', true); statusText = '更新未完成';
    } else if (status.availableVersion) {
      title = '给账本，升个级'; subtitle = '看看这次的新变化，准备好后再升级。';
      body = versionStrip() + notesContent();
      actions = actionButton('defer', '稍后提醒') + actionButton('download', '下载更新', true); statusText = `发现新版本 ${version(status.availableVersion)}`;
    } else {
      title = '已经是最新版本'; subtitle = '美好生活，继续认真记录。'; mark = 'check';
      body = `${versionStrip()}<div class="update-current-note">${glyph('shield', 22)}<p>${escapeHTML(latestText())}<br><span>有新版本时，我们会提醒你。</span></p></div>`;
      actions = actionButton('close', '继续记账', true); statusText = '已经是最新版本';
    }
    return `<div class="update-overlay"><section class="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title" aria-describedby="update-dialog-subtitle"><button type="button" class="update-close" data-update-action="close" aria-label="关闭更新窗口">${glyph('close', 18)}</button><header class="update-dialog-header"><div class="update-dialog-symbol ${phase === 'ready' || (!status.availableVersion && phase === 'idle') ? 'is-success' : ''}">${glyph(mark, 28)}<span class="update-symbol-spark">✦</span></div><span class="update-eyebrow">超级账本 · 应用更新</span><h2 id="update-dialog-title">${title}</h2><p id="update-dialog-subtitle">${subtitle}</p></header><div class="update-dialog-body">${body}</div><footer class="update-dialog-footer"><p class="update-retention">${glyph('shield', 14)}<span>覆盖升级，保留现有账本与设置</span></p><div class="update-dialog-actions">${actions}</div></footer><span class="update-sr-only" role="status" aria-live="polite">${statusText}</span></section></div>`;
  }

  function renderDialog({ focus = false } = {}) {
    if (!opened || destroyed) return;
    const active = root.contains(document.activeElement) ? document.activeElement : null;
    const activeAction = active?.dataset.updateAction, summaryFocused = active?.tagName === 'SUMMARY';
    const scroll = root.querySelector('.update-dialog-body')?.scrollTop || 0;
    const notesScroll = root.querySelector('.update-notes-text')?.scrollTop || 0;
    root.innerHTML = dialogContent();
    const body = root.querySelector('.update-dialog-body');
    if (body) body.scrollTop = scroll;
    const notes = root.querySelector('.update-notes-text');
    if (notes) notes.scrollTop = notesScroll;
    root.querySelector('.update-notes')?.addEventListener('toggle', event => { detailsOpen = event.target.open; });
    const target = activeAction ? root.querySelector(`[data-update-action="${activeAction}"]:not(:disabled)`) : summaryFocused ? root.querySelector('summary') : null;
    if (target) target.focus({ preventScroll: true });
    else if (focus || active) (root.querySelector('.update-button--primary:not(:disabled)') || root.querySelector('.update-close'))?.focus({ preventScroll: true });
  }

  function patchProgress() {
    if (destroyed || status.phase !== 'downloading') return;
    const transfer = transferDetails();
    for (const host of [root, document.getElementById('desktop-update-panel')].filter(Boolean)) {
      const patches = {
        '[data-update-bytes]': progressText(),
        '[data-update-percent]': status.totalBytes > 0 ? `${progressPercent()}%` : '准备中',
        '[data-update-speed]': transfer.speed,
        '[data-update-eta]': transfer.remaining,
        '[data-update-transfer-status]': transfer.message,
        '[data-update-download-label]': transfer.label
      };
      for (const [selector, text] of Object.entries(patches)) for (const element of host.querySelectorAll(selector)) {
        if (element.textContent !== text) element.textContent = text;
      }
      for (const element of host.querySelectorAll('[data-update-transfer-state]')) element.dataset.updateTransferState = transfer.state;
      for (const element of host.querySelectorAll('.update-progress')) {
        if (status.totalBytes > 0) element.setAttribute('aria-valuenow', progressPercent()); else element.removeAttribute('aria-valuenow');
        element.firstElementChild.style.width = `${progressPercent()}%`;
      }
    }
  }

  function update(next) {
    if (destroyed || !next || typeof next !== 'object') return;
    const changed = stableStatus(status) !== stableStatus(next);
    const oldVersion = status.availableVersion;
    receiveStatus(next);
    if (oldVersion !== status.availableVersion) detailsOpen = false;
    if (status.phase !== 'ready') installConfirm = false;
    onStatus(status);
    if (changed) { refreshSettings(); renderDialog(); } else patchProgress();
  }

  function show(options = {}) {
    if (destroyed) return;
    if (document.querySelector('.modal')) { pendingPrompt = options; return; }
    pendingPrompt = null;
    if (opened) { renderDialog(); return; }
    opened = true;
    lastFocus = document.activeElement;
    lastFocusAction = lastFocus?.dataset?.updateAction || '';
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.classList.add('has-update-dialog');
    renderDialog({ focus: true });
  }

  function close({ defer = true } = {}) {
    if (!opened) { pendingPrompt = null; return; }
    opened = false; installConfirm = false; pendingPrompt = null;
    root.innerHTML = '';
    document.body.style.overflow = previousOverflow;
    document.body.classList.remove('has-update-dialog');
    if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
    else if (lastFocusAction) (document.querySelector(`#desktop-update-panel [data-update-action="${lastFocusAction}"]`) || document.querySelector('#desktop-update-panel button'))?.focus({ preventScroll: true });
    if (defer && status.availableVersion && ['available', 'ready', 'idle'].includes(status.phase)) {
      // Remember the user's choice without interrupting a running download.
      Promise.resolve(desktop?.deferUpdate?.()).then(value => { if (value) update(value); }).catch(() => {});
    }
  }

  function flushPrompt() {
    if (pendingPrompt && !document.querySelector('.modal')) show(pendingPrompt);
  }

  async function invoke(method, operation) {
    if (destroyed || running.has(method) || typeof desktop?.[method] !== 'function') return;
    running.add(method);
    latestAction = operation;
    try {
      const value = await desktop[method]();
      if (value && typeof value === 'object' && typeof value.phase === 'string') update(value);
      return value;
    } catch (error) {
      update({ ...status, phase: 'error', operation, error: error?.message || String(error) });
    } finally { running.delete(method); }
  }

  async function check() {
    if (['downloading', 'installing'].includes(status.phase)) { show({ manual: true }); return; }
    if (status.enabled === false) { show({ manual: true }); return; }
    if (!running.has('checkForUpdates')) update({ ...status, phase: 'checking', error: '', operation: 'check' });
    show({ manual: true });
    return invoke('checkForUpdates', 'check');
  }

  async function download() {
    if (status.phase === 'downloading' || running.has('downloadUpdate')) { show({ manual: true }); return; }
    if (status.ready || status.phase === 'ready') { show({ manual: true }); return; }
    if (!status.availableVersion) return check();
    update({ ...status, phase: 'downloading', error: '', downloadedBytes: 0, bytesPerSecond: 0, retryAttempt: 0, operation: 'download' });
    show({ manual: true });
    return invoke('downloadUpdate', 'download');
  }

  async function cancel() {
    if (cancelPending || status.phase !== 'downloading') return;
    cancelPending = true; renderDialog();
    try { return await invoke('cancelUpdateDownload', 'download'); }
    finally { cancelPending = false; renderDialog(); }
  }

  function install() {
    if (!status.ready && status.phase !== 'ready') { show({ manual: true }); return; }
    installConfirm = true; show({ manual: true });
  }

  async function confirmInstall() {
    if (!installConfirm || (!status.ready && status.phase !== 'ready') || running.has('installUpdate')) return;
    installConfirm = false;
    update({ ...status, phase: 'installing', error: '', operation: 'install' });
    return invoke('installUpdate', 'install');
  }

  function retry() {
    const operation = status.operation || latestAction;
    if (operation === 'install' && status.ready) { update({ ...status, phase: 'ready', error: '' }); install(); return; }
    if (operation === 'download' && status.availableVersion) return download();
    return check();
  }

  const actions = { show: () => show({ manual: true }), check, download, cancel, install, 'confirm-install': confirmInstall, defer: () => close(), close: () => close(), retry, back: () => { installConfirm = false; renderDialog({ focus: true }); } };
  function onClick(event) {
    const button = event.target.closest('[data-update-action]');
    if (!button || button.disabled || (!root.contains(button) && !document.getElementById('desktop-update-panel')?.contains(button))) return;
    const handler = actions[button.dataset.updateAction];
    if (handler) { event.preventDefault(); handler(); }
  }

  function onKeyDown(event) {
    if (!opened) return;
    // Keep the ledger's shortcuts and its independent modal handler out of this dialog.
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...root.querySelectorAll('button:not(:disabled), summary, a[href], [tabindex="0"]')].filter(node => node.getClientRects().length);
    const first = nodes[0], last = nodes.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (!root.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown, true);
  const observer = new MutationObserver(flushPrompt);
  const ledgerModalRoot = document.getElementById('modal-root');
  if (ledgerModalRoot) observer.observe(ledgerModalRoot, { childList: true, subtree: true });
  window.addEventListener('focus', flushPrompt);
  if (desktop?.onUpdateStatusChanged) unsubscribe.push(desktop.onUpdateStatusChanged(update));
  if (desktop?.onUpdatePrompt) unsubscribe.push(desktop.onUpdatePrompt(options => show(options || {})));
  receiveStatus(status);

  return {
    settingsContent, update, show, check, download, cancel, install, defer: () => close(), flushPrompt,
    destroy() {
      close({ defer: false }); destroyed = true;
      if (progressTimer !== null) { window.clearInterval(progressTimer); progressTimer = null; }
      observer.disconnect();
      for (const off of unsubscribe) if (typeof off === 'function') off();
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('focus', flushPrompt);
    }
  };
}
