import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseHighlights, formatUpdateBytes } from '../update-ui.js';

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
