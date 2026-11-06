# 1.5.0 桌面端 / 1.0.0 安卓端验证记录

交付日期：2026-11-05（America/Los_Angeles）。所有测试使用独立测试账本，未读取或修改用户现有账本。

已通过：

- 96 项 Node 回归测试：原有金额、币种、订阅、迁移、本地 API 与新增手机同步。
- 27 项通知解析测试：明确收支、银行余额排除、验证码/失败/营销/统计摘要过滤、未知来源/多金额/退款转账待确认等。
- 13 项手机存储业务测试：原子写入恢复、同步中收到通知、丢确认后删除、保留旧冲突、重新配对归档、2 MB UTF-8 分批。
- 9 项实际 Java 客户端 ↔ Node 服务互通：AES-GCM 配对、非法地址拒绝、500 项批次、跨进程重启重试、并发冲突、后续批次保留冲突、采用电脑版本、丢确认后删除防复活、长中文备注分批。
- 桌面二维码与 ZXing 跨库解码；桌面源界面 9 项隔离检查，包括二维码实际绘制、整数像素、关闭撤销、快速重开和辅助按钮仅点击触发。
- 安卓 APK 编译、包名 `com.moneylab.superledger.mobile`、minSdk 26 / targetSdk 35、v2/v3 签名、16 KB ZIP 对齐。
- Windows 1.5.0 离线安装包生成；打包后隔离启动：rendererLoaded=true、授权接口 200、无凭据接口 403。
- 电脑版随附 APK 与独立交付 APK 的 SHA-256 一致。

范围限制：Java 单元/互通测试使用测试专用平台适配器，不等于 Android 运行时测试。隔离安卓模拟器启动被自动审批拒绝，工具仅返回 `blocked by policy`，未运行模拟器。没有连接 vivo X200 Ultra 真机，因此相机扫码、系统权限、通知实际样式和后台存活仍需手机安装后验证。

本次没有自动覆盖正在运行的旧版桌面安装。运行新版安装包即可升级；安装包及未安装目录都包含安卓 APK。Windows 局域网防火墙辅助操作需要用户在产品按钮触发后，通过操作系统的管理员授权；没有更改全局网络类别、代理或其他应用策略。

复跑：

```powershell
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File android/tools/test-unit.ps1
node android/tools/test-android-interop.mjs
node android/tools/test-qr.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File android/build.ps1
node desktop/build.cjs
```

主要记录：`artifacts/mobile-sync-regression.log`、`android/tools/native-interop-latest.json`、`artifacts/mobile-sync-ui-smoke/report.json`、`artifacts/mobile-sync-packaged-smoke-*/smoke-report.json`。打包界面检查记录另存 `artifacts/mobile-sync-packaged-ui/`。
