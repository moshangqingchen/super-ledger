# 发布新版与维护自动更新

仓库：<https://github.com/moshangqingchen/super-ledger>。Git 只保存源码、公开资源、文档与测试；安装包放 GitHub Releases。

Windows 1.6.0 / Android 1.1.0 是带更新器的首版。更早的已安装版本无法凭空获得更新器，需手动覆盖安装一次；之后打开应用可检查自己平台的升级，用户选择后才下载、确认安装。

## 需要保留的本机材料

- `android/.signing/`：安卓既有安装的签名身份与口令文件，不能删除、重新生成或上传公共仓库。
- `.release-signing/update-signing-private.pem`：签署更新清单的 RSA 私钥。两端应用已固定其公钥；不能随意轮换。公钥分别为 `assets/update-public-key.pem`、`android/app/src/main/res/raw/update_public_key.der`。
- 对以上目录做独立的私密备份。丢失它们会影响已有安装的后续升级；GitHub 源码不能代替私钥备份。

## 版本与构建

1. 更新功能并完成测试。
2. Windows 版本修改 `package.json`；Android 在 `android/build.ps1` 递增版本名和整数 versionCode。更新 `package.json` 的 Android extraResources 路径、用户说明和发布说明。不要复用已发布的版本号或替换同版本安装包。
3. 用原安卓签名构建 APK，再构建桌面安装包。两端测试必须通过后才发布。

```powershell
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File android/tools/test-unit.ps1
node android/tools/test-android-interop.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File android/build.ps1
node desktop/build.cjs
```

Windows 构建在项目 `node_modules` 或 `LEDGER_DESKTOP_TOOLROOT` 指定目录寻找固定版本的 Electron 和打包工具，全程离线。Android 依赖下载仅在 `android/tools/setup.ps1` 中显式经 `http://127.0.0.1:10090` 代理进行，失败不回退。手机运行时通过手机网络获取公开更新，账本不上传 GitHub。

## 发布顺序

先提交经过检查的源码到 `main`。`tools/github-release.py` 使用已有 Git credential manager 登录，先校验账户，所有 API 与安装包上传都经本机固定代理；不会打印或保存 token。

以桌面 1.6.0 / 安卓 1.1.0 为例（未来发布替换对应版本）：

```powershell
python tools/github-release.py create-release v1.6.0 --body-file release/release-notes.md
# 记录返回的草稿 release ID，下面的 <ID> 使用该值。
python tools/github-release.py upload <ID> release/超级账本-安装-1.6.0.exe --name SuperLedger-Setup-1.6.0.exe
python tools/github-release.py upload <ID> android/release/SuperLedger-Mobile-1.1.0.apk
node tools/create-update-manifest.mjs --windows release/超级账本-安装-1.6.0.exe --android android/release/SuperLedger-Mobile-1.1.0.apk --android-version 1.1.0 --android-code 10100 --notes release/release-notes.md
python tools/github-release.py upload <ID> release/stable.json --name update-manifest.json
python tools/github-release.py assets <ID>
```

确认三个附件均上传完成且远端 digest/size 与本地一致，再发布草稿：

```powershell
python tools/github-release.py publish <ID>
```

确认发布后的安装包可访问，再将生成的 `release/stable.json` 复制为 `updates/stable.json`，提交并推送到 `main`。**清单最后推送**，避免应用提示一个安装包还没发布的版本。标签对应构建时的源码提交；清单提交可在其后。

若上传中断，先用 `assets <ID>` 追查该草稿，不盲目创建重复 Release 或覆盖已发布资产。源码 push 本身不会通知升级；只有完整安装包发布且签名清单更新后，客户端才会提示。

## 更新信任与安装行为

两端固定读取 `https://raw.githubusercontent.com/moshangqingchen/super-ledger/main/updates/stable.json`。清单是 `{schema,payload,signature}`：payload 为原始 UTF-8 JSON 的 Base64，signature 为 RSA-SHA256 PKCS#1 v1.5 签名的 Base64。签名覆盖发布仓库、各端版本、安装包地址、长度和 SHA-256。

客户端验证仓库、签名、版本递增、平台包名和地址，下载后再核验长度/哈希。Windows 通过显式 CONNECT 隧道使用本机代理并验证 TLS，失败不直连；下载取消/校验失败不触发安装。安卓额外验证 APK 包名、versionCode 和与当前安装相同的签名证书，由 PackageInstaller 处理用户确认覆盖安装。

Windows 在用户点击「退出并安装」且没有打开的编辑表单后，正常退出当前应用，使用已验证安装包静默覆盖原安装并重新打开；账本数据目录保持不变。

这里的清单签名不等于 Windows Authenticode 发布者签名。当前桌面安装包仍未配置 Windows 发布者证书。APK 与更新清单的私钥始终留在本机，不写入 CI 配置或公开仓库。

关闭的应用不会为更新自行启动。检查/下载失败不会改动账本；同一个版本选择稍后后会暂缓提醒，可随时在设置手动检查。
