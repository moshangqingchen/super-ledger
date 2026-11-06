# Windows 1.8.7 与 Android 1.3.5 验证记录

桌面七个页面和主要弹窗使用统一的材质、字阶、边框和操作状态。窄屏账单显示名称、金额、账户和日期，订阅卡区分费用、到期提醒和余额，账户保留银行归组与原币明细。Android 原生界面更新了卡片、底部导航、表单和订阅详情。

自动订阅补记失败时，服务保留最后一致账本，可继续读取与导出，修复后可保存。自动记账状态通过独立健康接口提供，界面更新提示时保留表单草稿。另修复了账单搜索中文组词中断、日历提示泄露隐藏金额、零折合金额分类占比异常和总览订阅长文本溢出。

- Node 全量回归 204/204 通过。日志 `artifacts/ledger-polish-final-tests.log`。
- 隔离 Electron 完整流程 103 项，最终样式复核 79 项，自动记账异常提示 7 项，均通过。总览、账单、账户、订阅、分析、心愿、设置及主要弹窗在 1440/960/390 像素宽度完成验证。报告 `artifacts/project-ui-final/verification-summary.md`。
- Android 离线 Java 业务测试 11 组通过，Java 至 Node 局域网账本互操作 17 项通过。日志 `artifacts/ledger-polish-android-tests.log` 和 `artifacts/ledger-polish-android-interop.log`。

Windows 候选安装包 `release/超级账本-安装-1.8.7.exe`，107,458,721 字节，SHA-256 `428ec0479fc4de4f0f16720cc7a494f4666621516162113a6b2df8cef441faf3`。离线打包完成，ASAR 中 22 份源码和素材与工作区逐字节一致。审计报告 `artifacts/ledger-polish-package-check.json`。

Android 候选包 `android/release/SuperLedger-Mobile-1.3.5.apk`，版本号 10305，1,640,645 字节，SHA-256 `0a56de7aeb47dfc863d83d938ab18fbf01f2ce47e56773f6a39237b14c658518`。通过签名、对齐、包名、SDK 与版本检查，证书与 Android 1.3.4 一致。Windows 内附 APK 字节一致。

Windows 安装包独立启动及 Android 隐藏模拟器启动此前被自动审批以 `blocked by policy` 拒绝，未给出具体原因。当前界面验证运行在隔离的桌面 Electron 源码环境；Android 验证覆盖构建、签名和离线业务，设备界面仍未实测。两个包均为本地候选版。
