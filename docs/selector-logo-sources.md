# 账户选择器 Apple / Google / QQ 图标来源

获取日期：2026-11-06（America/Los_Angeles）。用于本地账本中辨识账户、关联登录账号，不表示品牌授权、服务接入或实际登录功能。

所有本机 HTTP 请求均通过显式代理 `http://127.0.0.1:10090`：requests Session 禁用环境继承，分别指定 HTTP / HTTPS 代理，没有直连回退。一次 Google 下载在此代理路径下遇到 TLS EOF，随后通过同一显式代理重试成功；没有关闭证书验证。云端网页检索不使用本机出口。图标随应用打包，运行时不向官网发请求。

## Apple

- 文件：`assets/brands/apple.svg`。
- 官方来源：[Apple 官网](https://www.apple.com/)，`a.globalnav-link-apple` 内第一个（regular）SVG。
- 完整保留官网原始 `<path>` 字符串，没有描摹、AI 生成、修改轮廓或重新着色；SVG 默认黑色。
- 官网导航 SVG 画布为 `0 0 14 44`。本地容器使用 `viewBox="0 11 14 18"`（14 × 18），去除导航条上下留白，完整保留 Apple 图案，便于小尺寸等比显示。此文件是提取并调整容器的 SVG，不声称与官网完整 SVG 字节相同。
- 原始 path 字符串 SHA-256：`9d94f0133e5ad336d5282043026443c6578a4e39bc0a6017f965a247481d288c`。
- 本地文件 SHA-256：`fbe714b64345dc4f3d8a3c86ea98e0ae6bfc7c917472870dcac309ced8cdb153`。
- Apple 余额预设使用此图标，没有用 iCloud 的云图标替代 Apple 标识。保留原有 `gift` 类型标记作为兼容信息。

## Google

- 文件：`assets/brands/google.svg`。
- 官方来源：[Sign in with Google 品牌规范](https://developers.google.com/identity/branding-guidelines) 中的 “Google G icon” 图片；[原始 PNG](https://developers.google.com/static/identity/images/g-logo.png)。
- 原图为 200 × 204 RGBA PNG，33,661 字节，官方当前渐变 G。下载后通过 PNG 解码校验并目视确认完整图案。
- 为沿用选择器的 `.svg` 资源路径，将完整原始 PNG 字节以 base64 内嵌到同尺寸 SVG `<image>` 容器。**它不是原生矢量 Google Logo**；没有调整像素、裁切、重绘、重新着色或 AI 生成，解码后的 PNG 与官方原件逐字节相同。
- 内嵌 PNG SHA-256：`d1ce9c2af0b10a7333abc99bc706f9a6a199e5b65bf3e3009624f076b8638e6a`。
- SVG 容器文件 SHA-256：`930686d12cdbb4e0814c8168d637ec66c8176d74b408c9fd921b0f104fbb825f`。
- 官方规范链接的 [signin-assets.zip](https://developers.google.com/static/identity/images/signin-assets.zip) 包含渐变 SVG，但使用 `foreignObject` / CSS `conic-gradient`，作为外部 `<img>` 存在兼容风险，因此采用官网直接提供的完整 PNG。官网 HTML 按钮生成器仍输出旧四色路径，本项目不以旧图替换当前渐变 G。
- 按原比例、小尺寸、白色背景展示，仅作为已填写账号的品牌识别标记，不把选择器伪装为 Google 登录按钮。

## QQ

- 文件：`assets/brands/qq.png`。
- 官方来源：[QQ 官网](https://im.qq.com/index/)。页面同时用 `rel="shortcut icon"` 与 `rel="icon"` 声明 [qq-logo.png 原件](https://static-res.qq.com/static-res/imqq/qq-logo.png)。
- PNG 原件为 62 × 62、调色板模式、1,167 字节。已通过 PNG 解码和目视检查：确为黑白企鹅、红围巾、黄脚的 QQ 标识，不是腾讯门户或腾讯公司的其他 Logo。
- 完整保存官方原始字节；没有重绘、裁切、重新着色或 AI 生成。
- SHA-256：`ee3ab39d757df98d57d676779b97fb8e20d70c97900976b4ffe239f3b6a54bfe`。
- 获取页面和 PNG 均显式通过同一本机代理，无直连回退。腾讯门户 `www.qq.com` 返回 HTTP 501 后未采用其图标；最终图标来自 QQ 产品官网的明确声明。

## 校验

两个 SVG 均通过 XML 解析；Apple 只有官网原始 path，Google 仅内嵌经过校验的官方 PNG，不含脚本、事件处理器、foreignObject 或对外资源引用。QQ PNG 通过图像解码校验。品牌标识权利归各自所有者。
