import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateUI, releaseHighlights, formatUpdateBytes, formatUpdateRemaining, updateTransferDetails } from '../update-ui.js';

test('release highlights omit platform and installation metadata from actual release structure', () => {
  const notes = `Windows 1.7.0 / Android 1.2.0

手机升级为完整账本：总资产、账户余额、今日和月度收支、预算与分类统计。加入支付平台、银行和会员服务 Logo。

改进微信、支付宝扫码消费识别：优先实付金额，区分优惠、原价、余额与手续费。同订单通知/页面和订阅扣账避免重复。

可选「付款页面辅助识别」默认关闭，由你自行开启并在系统授权。

先更新电脑，再更新手机，均选择覆盖安装并保留数据。

验证: 离线 Android 编译与签名校验、Java 业务规则测试、Node 回归。

下载前会验证发布签名，下载后会校验安装包。`;
  assert.deepEqual(releaseHighlights(notes), [
    '手机升级为完整账本：总资产、账户余额、今日和月度收支、预算与分类统计。',
    '改进微信、支付宝扫码消费识别：优先实付金额，区分优惠、原价、余额与手续费。',
    '可选「付款页面辅助识别」默认关闭，由你自行开启并在系统授权。'
  ]);
  assert.deepEqual(releaseHighlights('Windows 1.7.0 / Android 1.2.0\n验证：测试完成\n下载前检查签名\n安装说明：覆盖安装\n更新说明：'), []);
});

test('release highlights normalize markdown without inventing absent content', () => {
  assert.deepEqual(releaseHighlights('## 更新说明\r\n- **更清爽的布局**。新的导航。\r\n2. 新增下载进度。'), ['更清爽的布局。', '新增下载进度。']);
  assert.deepEqual(releaseHighlights(''), []);
  assert.deepEqual(releaseHighlights('唯一一条说明'), ['唯一一条说明']);
  assert.deepEqual(releaseHighlights('第一条\n第二条', 1), ['第一条']);
});

test('highlight clipping respects Unicode characters and a compact length', () => {
  const [result] = releaseHighlights('🌱'.repeat(110));
  assert.equal(Array.from(result).length, 94);
  assert.ok(result.endsWith('🌱…'));
  assert.ok(!result.includes('\ufffd'));
});

test('download byte formatting handles partial, unknown and invalid totals', () => {
  assert.equal(formatUpdateBytes(0), '0 B');
  assert.equal(formatUpdateBytes(-1), '0 B');
  assert.equal(formatUpdateBytes(Infinity), '0 B');
  assert.equal(formatUpdateBytes(512), '512 B');
  assert.equal(formatUpdateBytes(1536), '1.5 KB');
  assert.equal(formatUpdateBytes(1024 ** 2 * 83.125), '83.1 MB');
});

test('remaining time uses a rounded estimate only for a finite positive duration', () => {
  for (const value of [0, -1, NaN, Infinity, undefined]) assert.equal(formatUpdateRemaining(value), '待估算');
  assert.equal(formatUpdateRemaining(.2), '约 1 秒');
  assert.equal(formatUpdateRemaining(59), '约 59 秒');
  assert.equal(formatUpdateRemaining(61), '约 2 分钟');
  assert.equal(formatUpdateRemaining(3600), '约 1 小时');
  assert.equal(formatUpdateRemaining(3661), '约 1 小时 2 分钟');
  assert.equal(formatUpdateRemaining(7199), '约 2 小时');
});

test('download speed and remaining time come from current measured bytes, not an assumed rate', () => {
  const status = { downloadedBytes: 25 * 1024 ** 2, totalBytes: 100 * 1024 ** 2, bytesPerSecond: 1.5 * 1024 ** 2 };
  assert.deepEqual(updateTransferDetails(status), {
    state: 'downloading', label: '下载中', speed: '1.5 MB/s', remaining: '约 50 秒',
    message: '正在下载，剩余时间会随当前速度调整。'
  });
  assert.equal(updateTransferDetails({ ...status, totalBytes: 0 }).remaining, '待估算');
  for (const speed of [0, -10, Infinity, NaN, undefined]) {
    const value = updateTransferDetails({ ...status, bytesPerSecond: speed });
    assert.equal(value.speed, '—'); assert.equal(value.remaining, '待估算');
  }
  const invalid = updateTransferDetails({ totalBytes: Infinity, downloadedBytes: NaN, bytesPerSecond: 1024 });
  assert.equal(invalid.remaining, '待估算'); assert.equal(invalid.speed, '1.0 KB/s');
});

test('automatic route selection and the active download route are shown without a fabricated speed', () => {
  const selecting = updateTransferDetails({ selectingSource: true, sourceLabel: '', bytesPerSecond: 1024 }, 9000);
  assert.equal(selecting.state, 'selecting'); assert.equal(selecting.speed, '—'); assert.match(selecting.message, /自动选择/);
  assert.match(updateTransferDetails({ sourceLabel: '加速线路 1', bytesPerSecond: 1024 }).message, /^加速线路 1 · /);
});

test('retry, stalled transfer and verification suppress outdated speed and estimates', () => {
  const status = { downloadedBytes: 25, totalBytes: 100, bytesPerSecond: 10 };
  const retry = updateTransferDetails({ ...status, retryAttempt: 2 }, 12000);
  assert.equal(retry.state, 'retrying'); assert.match(retry.message, /第 2 次自动重试/);
  assert.equal(retry.speed, '—'); assert.equal(retry.remaining, '待估算');
  const waiting = updateTransferDetails(status, 8000);
  assert.equal(waiting.state, 'waiting'); assert.match(waiting.message, /暂未收到新数据/);
  assert.equal(waiting.speed, '—'); assert.equal(waiting.remaining, '待估算');
  assert.equal(updateTransferDetails(status, 7999).state, 'downloading');
  assert.match(updateTransferDetails({ downloadedBytes: 0 }, 8000).message, /等待下载源响应/);
  assert.equal(updateTransferDetails({ ...status, retryAttempt: 0 }).state, 'downloading');
  assert.equal(updateTransferDetails({ ...status, retryAttempt: '<script>' }).state, 'downloading');
  const verified = updateTransferDetails({ ...status, downloadedBytes: 100 }, 12000);
  assert.equal(verified.state, 'verifying'); assert.equal(verified.remaining, '下载完成');
  assert.equal(verified.speed, '—'); assert.match(verified.message, /校验通过后才能安装/);
});

test('progress-only changes patch both surfaces without replacing the open dialog and stop their timer', t => {
  let clock = 1000000;
  t.mock.method(Date, 'now', () => clock);
  const originals = Object.fromEntries(['document', 'window', 'MutationObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let ui;
  t.after(() => {
    ui?.destroy();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const makeHost = () => {
    const nodes = new Map(['data-update-bytes', 'data-update-percent', 'data-update-speed', 'data-update-eta', 'data-update-transfer-status', 'data-update-download-label', 'data-update-transfer-state'].map(key => [`[${key}]`, [{ textContent: '', dataset: {} }]]));
    const bar = { setAttribute() {}, removeAttribute() {}, firstElementChild: { style: {} } };
    nodes.set('.update-progress', [bar]);
    return { nodes, innerHTML: '', contains: () => false, querySelector: () => null, querySelectorAll: selector => nodes.get(selector) || [] };
  };
  const root = makeHost(), panel = makeHost(), timers = new Map(); let timerId = 0;
  globalThis.document = {
    getElementById: id => id === 'update-root' ? root : id === 'desktop-update-panel' ? panel : null,
    activeElement: null, querySelector: () => null, addEventListener() {}, removeEventListener() {},
    body: { style: { overflow: '' }, classList: { add() {}, remove() {} } }
  };
  globalThis.window = {
    setInterval: callback => { timers.set(++timerId, callback); return timerId; }, clearInterval: id => timers.delete(id),
    addEventListener() {}, removeEventListener() {}
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const status = { enabled: true, currentVersion: '1.8.7', availableVersion: '1.8.8', phase: 'downloading', totalBytes: 102400, downloadedBytes: 10240, bytesPerSecond: 1024, retryAttempt: 0 };
  ui = createUpdateUI({ initialStatus: status });
  ui.show(); const before = root.innerHTML;
  ui.update({ ...status, downloadedBytes: 20480, bytesPerSecond: 2048 });
  assert.equal(root.innerHTML, before); assert.equal(timers.size, 1);
  for (const host of [root, panel]) {
    assert.equal(host.nodes.get('[data-update-speed]')[0].textContent, '2.0 KB/s');
    assert.equal(host.nodes.get('[data-update-eta]')[0].textContent, '约 40 秒');
    assert.equal(host.nodes.get('[data-update-percent]')[0].textContent, '20%');
  }
  clock += 8000; [...timers.values()][0]();
  assert.equal(root.innerHTML, before);
  assert.equal(root.nodes.get('[data-update-transfer-state]')[0].dataset.updateTransferState, 'waiting');
  assert.equal(root.nodes.get('[data-update-speed]')[0].textContent, '—');
  ui.update({ ...status, downloadedBytes: 20480, bytesPerSecond: 2048 });
  assert.equal(root.nodes.get('[data-update-transfer-state]')[0].dataset.updateTransferState, 'waiting');
  ui.update({ ...status, downloadedBytes: 21504, bytesPerSecond: 2048 });
  assert.equal(root.nodes.get('[data-update-transfer-state]')[0].dataset.updateTransferState, 'downloading');
  ui.update({ ...status, retryAttempt: 1 });
  assert.equal(root.innerHTML, before);
  assert.equal(root.nodes.get('[data-update-transfer-state]')[0].dataset.updateTransferState, 'retrying');
  assert.match(root.nodes.get('[data-update-transfer-status]')[0].textContent, /第 1 次自动重试/);
  ui.update({ ...status, phase: 'available' }); assert.equal(timers.size, 0);
  ui.update(status); assert.equal(timers.size, 1);
  ui.destroy(); assert.equal(timers.size, 0);
});
