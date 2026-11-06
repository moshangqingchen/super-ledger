const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const phoneIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4m-3 14h2"/></svg>';
const qrIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8V3h5m8 0h5v5m0 8v5h-5M8 21H3v-5"/><rect x="7" y="7" width="3" height="3"/><rect x="14" y="7" width="3" height="3"/><rect x="7" y="14" width="3" height="3"/><path d="M14 14h3v3h-3z"/></svg>';

export function mobileSyncSettingsCard() {
  return `<section class="panel mobile-sync-settings"><div class="panel-head"><div><h2>${phoneIcon} 手机扫码同步</h2><p>在外记下的每一笔，回家带回电脑</p></div><span class="category-tag">局域网</span></div><div class="mobile-sync-settings-content"><span class="mobile-sync-setting-symbol">${qrIcon}</span><div><b>安卓手机与电脑，共用一本账</b><p>连接同一 Wi-Fi 或手机热点，用手机 App 扫描电脑二维码。账户、账单、订阅、预算和心愿一起核对同步。</p></div></div><div class="mobile-sync-settings-footer"><span>本地保存 · 加密传输 · 无需云服务器</span><button type="button" class="btn btn-primary btn-sm" data-action="mobile-sync">${qrIcon} 打开同步</button></div></section>`;
}

function countdown(expiresAt) {
  const remaining = Math.max(0, Math.ceil((Number(expiresAt) - Date.now()) / 1000));
  return `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
}

function networkChoices(status) {
  const choices = status?.networkChoices || status?.networks || status?.interfaces || status?.addresses || [];
  return choices.map(value => {
    const address = typeof value === 'string' ? value : value.address || value.url;
    if (!address) return null;
    let host = address;
    try { if (address.includes('://')) host = new URL(address).hostname; } catch { return null; }
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
    return { address: host, label: typeof value === 'object' && (value.label || value.name) ? `${value.label || value.name} · ${host}` : host };
  }).filter((value, index, array) => value && array.findIndex(item => item?.address === value.address) === index);
}

export function createMobileSyncUI({ api, modal, refresh, toast, desktop }) {
  let opened = false, generation = 0, status = null, error = '', errorSource = '', working = false;
  let networkWorking = false;
  let timer, countdownTimer, busyPoll = false, lastResultKey = '', mutationChain = Promise.resolve();
  const root = () => document.getElementById('mobile-sync-panel');
  const isOpen = () => opened && Boolean(root());
  function mutate(path, body = {}, options = {}) {
    const operation = mutationChain.then(() => api(path, { method: 'POST', body: JSON.stringify(body), ...options }));
    mutationChain = operation.catch(() => {});
    return operation;
  }

  function drawQr() {
    const canvas = document.getElementById('mobile-sync-qr');
    if (!canvas || !status?.qrPayload) return;
    try {
      const library = globalThis.qrcodegen;
      if (!library?.QrCode) throw new Error('二维码组件未加载，请重新打开电脑端。');
      const qr = library.QrCode.encodeText(status.qrPayload, library.QrCode.Ecc.MEDIUM);
      const border = 4, scale = Math.max(2, Math.floor(286 / (qr.size + border * 2)));
      canvas.width = canvas.height = (qr.size + border * 2) * scale;
      canvas.style.width = `${canvas.width}px`;
      canvas.style.height = `${canvas.height}px`;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#201c30';
      for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) context.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
      }
    } catch (failure) {
      const container = document.getElementById('mobile-sync-code');
      container.innerHTML = `<div class="mobile-sync-qr-empty">${qrIcon}<b>二维码暂不可用</b><p>${escapeHtml(failure.message)}</p><p>也可以复制配对内容，在手机中粘贴。</p></div>`;
    }
  }

  function resultMarkup() {
    const result = status?.lastResult;
    if (!result) return '';
    const summary = result.summary || {};
    const time = new Date(result.syncedAt);
    const label = Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `<section class="mobile-sync-result" role="status"><div class="mobile-sync-result-head"><span class="mobile-sync-success-check">✓</span><div><strong>同步已完成</strong><p>${escapeHtml(result.deviceName || '安卓手机')} · ${escapeHtml(label)}</p></div></div><div class="mobile-sync-counts"><div><b>${Number(summary.added) || 0}</b><span>新增</span></div><div><b>${Number(summary.updated) || 0}</b><span>更新</span></div><div><b>${Number(summary.deleted) || 0}</b><span>删除</span></div><div><b>${Number(summary.duplicates) || 0}</b><span>已核对重复</span></div></div>${Number(result.conflicts) > 0 ? `<p class="mobile-sync-conflicts">${Number(result.conflicts)} 项修改需要在手机上确认。已保留双方内容，不会直接覆盖。</p>` : '<p class="mobile-sync-result-note">电脑账本已更新，手机端会显示同步结果。</p>'}</section>`;
  }

  function render() {
    const panel = root();
    if (!panel || !opened) return;
    const focusId = panel.contains(document.activeElement) ? document.activeElement.id : '';
    const selectedAddress = document.getElementById('mobile-sync-network')?.value;
    const active = Boolean(status?.active && status.qrPayload && Number(status.expiresAt) > Date.now());
    const choices = networkChoices(status);
    const statusText = working ? '正在准备同步' : active ? '等待手机扫码' : status?.expiresAt ? '本次同步已关闭' : '准备连接你的手机';
    panel.setAttribute('aria-busy', String(working));
    panel.innerHTML = `<div class="mobile-sync-intro"><span>${phoneIcon}</span><div><p class="mobile-sync-eyebrow">带上手机里的生活记录</p><h3>扫一扫，两端账本一起更新</h3></div><span class="mobile-sync-local-badge">本地同步</span></div>${desktop?.openMobileFiles ? `<div class="mobile-sync-install"><span>第一次使用？先把安卓 App 安装到手机。</span><button id="mobile-sync-install" type="button" class="btn btn-soft btn-sm" data-sync-action="install">获取安卓安装包</button></div>` : ''}<div class="mobile-sync-layout"><section class="mobile-sync-code-column"><div class="mobile-sync-code" id="mobile-sync-code">${active ? '<canvas id="mobile-sync-qr" role="img" aria-label="手机同步临时二维码，请用超级账本安卓 App 扫描"></canvas>' : `<div class="mobile-sync-qr-empty ${working ? 'is-loading' : ''}">${qrIcon}<b>${working ? '正在生成配对二维码' : '开启本次同步'}</b><p>${working ? '正在连接本机同步服务…' : '二维码短时有效，关闭窗口即停止配对。'}</p></div>`}</div><div class="mobile-sync-state ${active ? 'is-active' : ''}" role="status"><i></i><span>${statusText}</span>${active ? `<b id="mobile-sync-countdown">${countdown(status.expiresAt)}</b>` : ''}</div>${active ? '<p class="mobile-sync-code-caption">在手机「同步」中点击「扫一扫，开始同步」</p><button id="mobile-sync-copy" type="button" class="text-btn mobile-sync-copy" data-sync-action="copy">无法扫码？复制配对内容</button>' : ''}</section><div class="mobile-sync-guide"><ol class="mobile-sync-steps"><li><span>1</span><div><b>连到同一个网络</b><p>手机与电脑使用同一 Wi-Fi，或让电脑连接手机热点。</p></div></li><li><span>2</span><div><b>打开手机 App 扫码</b><p>首次合并两端账本；以后同步账户、收支、转账、订阅、预算与心愿。</p></div></li><li><span>3</span><div><b>确认结果，继续生活</b><p>重复记录会核对，冲突与信息不全的交易留在手机中确认。</p></div></li></ol>${choices.length > 1 ? `<div class="mobile-sync-network"><label for="mobile-sync-network">连接不上？选择手机所在网络</label><div><select id="mobile-sync-network">${choices.map(choice => `<option value="${escapeHtml(choice.address)}" ${choice.address === selectedAddress ? 'selected' : ''}>${escapeHtml(choice.label)}</option>`).join('')}</select><button id="mobile-sync-switch" type="button" class="btn btn-outline btn-sm" data-sync-action="switch" ${working ? 'disabled' : ''}>切换</button></div></div>` : ''}<details class="mobile-sync-help"><summary>扫码后连接不上怎么办？</summary><p>检查两端是否处于同一网络。访客 Wi-Fi 可能隔离设备，可改用手机热点。若 Windows 防火墙阻止连接，请使用随附工具允许超级账本接收本地网络连接。</p><p>无需开启公网端口或关闭防火墙。</p>${desktop?.enableMobileSyncNetwork ? `<button id="mobile-sync-network-permission" type="button" class="btn btn-outline btn-sm" data-sync-action="network-permission" ${networkWorking ? 'disabled' : ''}>${networkWorking ? '正在等待 Windows 授权…' : '允许局域网连接'}</button><small>需要 Windows 管理员授权，仅放行超级账本的本地网络连接。</small>` : ''}</details></div></div>${error || status?.error ? `<div class="mobile-sync-error" role="alert">${escapeHtml(error || status.error)}</div>` : ''}${resultMarkup()}<div class="mobile-sync-footer"><div><span class="mobile-sync-lock">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 6v2"/></svg>'}</span><span>账本加密传输<br><small>仅与你扫码连接的手机同步</small></span></div><button id="mobile-sync-toggle" type="button" class="btn ${active ? 'btn-outline' : 'btn-primary'}" data-sync-action="${active ? 'stop' : 'start'}" ${working ? 'disabled' : ''}>${working ? '请稍候…' : active ? '停止本次同步' : '生成同步二维码'}</button></div>`;
    if (active) drawQr();
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
    panel.onclick = async event => {
      const action = event.target.closest('[data-sync-action]')?.dataset.syncAction;
      if (!action || working) return;
      if (action === 'start') return start();
      if (action === 'switch') return start(document.getElementById('mobile-sync-network')?.value);
      if (action === 'stop') return stop();
      if (action === 'copy') return copyPairing();
      if (action === 'install') return openMobileFiles();
      if (action === 'network-permission') return allowNetwork();
    };
  }

  function updateCountdown() {
    if (!isOpen()) return;
    const element = document.getElementById('mobile-sync-countdown');
    if (!element || !status?.active) return;
    element.textContent = countdown(status.expiresAt);
    if (Number(status.expiresAt) <= Date.now()) { status = { ...status, active: false, qrPayload: null }; render(); }
  }

  async function useStatus(next, expectedGeneration) {
    if (!isOpen() || generation !== expectedGeneration) return;
    const previous = JSON.stringify(status), previousError = error;
    status = next;
    if (errorSource !== 'action') { error = ''; errorSource = ''; }
    const key = next.lastResult ? JSON.stringify(next.lastResult) : '';
    if (key && key !== lastResultKey) {
      lastResultKey = key;
      await refresh();
    }
    if (!isOpen() || generation !== expectedGeneration) return;
    if (previous !== JSON.stringify(next) || previousError !== error) render();
  }

  async function poll() {
    if (!isOpen() || working || busyPoll) return;
    busyPoll = true;
    const currentGeneration = generation;
    try { await useStatus(await api('/api/mobile-sync/status'), currentGeneration); }
    catch (failure) { if (isOpen() && generation === currentGeneration && errorSource !== 'action') { error = failure.message; errorSource = 'poll'; render(); } }
    finally { busyPoll = false; }
  }

  async function start(address) {
    if (working || !isOpen()) return;
    const currentGeneration = ++generation;
    working = true; error = ''; errorSource = ''; render();
    try {
      const next = await mutate('/api/mobile-sync/start', address ? { address } : {});
      // Close requests are queued after this start; a later window must not be stopped by an old response.
      if (!isOpen() || generation !== currentGeneration) return;
      await useStatus(next, currentGeneration);
    } catch (failure) { if (isOpen() && generation === currentGeneration) { error = failure.message; errorSource = 'action'; } }
    finally { if (generation === currentGeneration) { working = false; render(); } }
  }

  async function stop() {
    if (working || !isOpen()) return;
    const currentGeneration = ++generation;
    working = true; error = ''; errorSource = ''; render();
    try { await useStatus(await mutate('/api/mobile-sync/stop'), currentGeneration); }
    catch (failure) { if (isOpen() && generation === currentGeneration) { error = failure.message; errorSource = 'action'; } }
    finally { if (generation === currentGeneration) { working = false; render(); } }
  }

  async function openMobileFiles() {
    try { await desktop.openMobileFiles(); toast('已打开安装包文件夹，将 APK 传到手机后安装'); }
    catch (failure) { error = failure.message; errorSource = 'action'; render(); }
  }

  async function allowNetwork() {
    if (networkWorking || !desktop?.enableMobileSyncNetwork) return;
    networkWorking = true;
    error = ''; errorSource = '';
    const currentGeneration = generation;
    render();
    const details = root()?.querySelector('.mobile-sync-help');
    if (details) details.open = true;
    try {
      await desktop.enableMobileSyncNetwork();
      toast('局域网连接设置已完成，请用手机重新扫码');
    } catch (failure) { if (isOpen() && generation === currentGeneration) { error = failure.message; errorSource = 'action'; } }
    finally {
      networkWorking = false;
      if (isOpen() && generation === currentGeneration) {
        render();
        const help = root()?.querySelector('.mobile-sync-help');
        if (help) help.open = true;
      }
    }
  }

  async function copyPairing() {
    if (!status?.active || !status.qrPayload || Number(status.expiresAt) <= Date.now()) return;
    try { await navigator.clipboard.writeText(status.qrPayload); toast('配对内容已复制，请在手机 App 中粘贴；内容过期后失效'); }
    catch {
      const panel = root();
      if (!panel || !isOpen()) return;
      let input = document.getElementById('mobile-sync-pairing-text');
      if (!input) {
        const label = document.createElement('label');
        label.className = 'mobile-sync-manual';
        label.textContent = '复制以下临时配对内容，在手机 App 中粘贴（请勿分享给他人）';
        input = document.createElement('textarea');
        input.id = 'mobile-sync-pairing-text'; input.readOnly = true; input.rows = 3;
        label.appendChild(input); panel.appendChild(label);
      }
      input.value = status.qrPayload; input.focus(); input.select();
    }
  }

  function onModalClosed() {
    if (!opened) return;
    opened = false; generation++;
    clearInterval(timer); clearInterval(countdownTimer);
    working = false; status = null;
    void mutate('/api/mobile-sync/stop', {}, { keepalive: true }).catch(() => {});
  }

  async function open() {
    if (isOpen()) return;
    modal('手机扫码同步', '外出先记录，回家同步到你的电脑。', '<div id="mobile-sync-panel"></div>', true);
    opened = true; generation++; status = null; error = ''; errorSource = ''; lastResultKey = '';
    document.querySelector('.modal')?.classList.add('mobile-sync-modal');
    render();
    timer = setInterval(poll, 2000);
    countdownTimer = setInterval(updateCountdown, 1000);
    await start();
  }

  window.addEventListener('beforeunload', onModalClosed);
  return { open, onModalClosed, isOpen };
}
