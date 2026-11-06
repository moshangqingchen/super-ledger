# Windows 1.6.0 / Android 1.1.0 更新验证

本版本将公开 GitHub 发布接入两端应用。自动检查只获取版本信息；下载和安装均由用户选择。源码和安装包分别存入 Git 仓库、GitHub Releases，签名材料留在本机。

## 已完成的本地验证

- 108 项 Node 回归通过，含原有账本/币种/订阅/迁移/扫码同步，以及 12 项更新器校验、代理限制、取消、重试、缓存复核和提醒推迟测试。
- 安卓 80 项离线检查通过：27 项通知解析、13 项手机存储、40 项更新策略。更新策略覆盖篡改签名、错误来源、版本、下载长度/哈希、包名和证书等拒绝路径。
- Android 1.1.0 / versionCode 10100 最终 APK 编译通过，包名 `com.moneylab.superledger.mobile`，minSdk 26 / targetSdk 35；v2/v3 签名、16 KB ZIP 对齐通过，签名身份与原版一致。
- Windows 1.6.0 源码隔离启动通过：界面加载正常、授权 API 为 200、无凭据 API 为 403。测试模式不启动外网更新或汇率查询。
- Windows 最终离线安装包生成成功，打包后隔离启动同样通过。运行代码、公钥与源码逐字节匹配，随附 APK 与独立 APK 完全一致，包内无个人账本或签名私钥。
- 已用两端实际更新验证代码和生产公钥检查正式签名清单；Windows EXE 与 Android APK 的长度及 SHA-256 一致，安卓同版不更新、清单篡改拒绝通过。
- Windows 安装参数已按本机 electron-builder 26.15.3 NSIS 模板核对：用户确认后使用 `/S --updated --force-run`，复用原安装目录并在完成后重新打开。未保存编辑表单会阻止退出安装。

安装包 SHA-256 与字节数记录在发布页附件及签名清单中。发布工具验证 GitHub 返回的上传状态、大小与 digest；线上更新入口仅在安装包可下载后发布。

## 验证范围

Java 单元检查使用测试专用平台适配器，不等于 Android 运行时测试。未连接 vivo X200 Ultra，未运行真机或模拟器，未实际执行 Android 系统覆盖安装。相机、付款通知、厂商后台限制和安装权限界面仍需手机安装后验证。

测试没有覆盖用户正在使用的 Windows 安装，也没有读取或修改个人账本。Windows 下载验证使用独立目录与替代安装回调，不执行 EXE。当前桌面安装包未配置 Windows Authenticode 发布者证书；清单签名与 APK 签名不能代替该证书。

## 复跑入口

```powershell
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File android/tools/test-unit.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File android/tools/test-published-update.ps1 -Manifest release/stable.json
node tools/verify-published-update.mjs --manifest release/stable.json --windows release/超级账本-安装-1.6.0.exe
node tools/verify-published-update.mjs
```

最后一条会通过固定本机代理读取已发布清单并下载 Windows 安装包；只模拟安装回调。离线模式验证本地签名清单和本地安装包，不发出外网请求。所有结果及缓存放入忽略提交的 `artifacts/update-release/`。
