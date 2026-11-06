# 订阅服务官方图标来源

以下文件用于本地账本中识别对应的订阅服务，保留官方文件原始字节，没有使用 AI 生成、描摹、重绘、裁切、重新着色或格式转换。

所有本机下载请求均显式使用用户代理 `http://127.0.0.1:10090`，没有回退为直连；云端搜索不使用本机网络出口。本页面记录的是来源及文件校验，不代表各品牌对本账本提供背书。

## 应用采用的文件

| 服务 | 本地文件 | 格式 / 原始尺寸 | 官方来源页面 | 原文件地址 |
| --- | --- | --- | --- | --- |
| ChatGPT | `assets/brands/chatgpt.png` | PNG / 180 × 180 | [ChatGPT](https://chatgpt.com/) 的 apple-touch-icon 声明 | [原 PNG](https://chatgpt.com/cdn/assets/favicon-180x180.9e0103ce69.png) |
| Claude | `assets/brands/claude.svg` | SVG / 248 × 248 viewBox | [Claude](https://claude.com/) 的 icon 声明 | [原 SVG](https://claude.com/icon.svg) |
| Gemini | `assets/brands/gemini.png` | PNG / 512 × 512 | [Gemini](https://gemini.google.com/) 的 icon 声明 | [Google 静态资源](https://www.gstatic.com/lamda/images/gemini_sparkle_4g_512_lt_f94943af3be039176192d.png) |
| TT语音 | `assets/brands/ttvoice.png` | PNG / 350 × 100，完整白色字标 | [TT语音官网](https://52tt.com/) 的 logo 图片 | [官网原 PNG](https://52tt.com/_nuxt/img/logo_black.b38d682.png) |
| 酷狗音乐 | `assets/brands/kugou.ico` | ICO / 16 × 16 | [酷狗音乐](https://www.kugou.com/) 的 shortcut icon 声明 | [官网原 ICO](https://www.kugou.com/root/favicon.ico) |
| 百度网盘 | `assets/brands/baidu.ico` | ICO / 32 × 32 | [百度网盘](https://pan.baidu.com/) 的 icon 声明 | [百度静态资源](https://nd-static.bdstatic.com/m-static/wp-brand/favicon.ico) |
| 网易云音乐 | `assets/brands/netease.ico` | ICO / 32 × 32 | [网易云音乐](https://music.163.com/) 的 shortcut icon 声明 | [网易静态资源](https://s1.music.126.net/style/favicon.ico) |
| 哔哩哔哩 | `assets/brands/bilibili.ico` | ICO / 32 × 32 | [哔哩哔哩官网](https://www.bilibili.com/) | [官网原 ICO](https://www.bilibili.com/favicon.ico) |
| iCloud | `assets/brands/icloud.png` | PNG / 180 × 180 | [iCloud](https://www.icloud.com/) 的 apple-touch-icon；按页面 base URL 解析 | [Apple 静态资源](https://www.icloud.com/system/icloud.com/2640Build24/favicons/default-favicon-light-180x180.png) |

## 保留的官方备选原件

| 本地文件 | 原始尺寸 / 注意事项 | 原文件地址 |
| --- | --- | --- |
| `assets/brands/chatgpt.svg` | 180 × 180 viewBox；官方 SVG 会随系统深色模式变白，因此浅色界面优先使用固定样式 PNG | [原 SVG](https://chatgpt.com/cdn/assets/favicon.6a33781f61.svg) |
| `assets/brands/kugou.png` | 153 × 37，横向字标；不作为方形头像使用 | [酷狗官网 metadata 指向的原 PNG](https://staticssl.kugou.com/public/root/images/logo.png) |
| `assets/brands/kugou-wordmark.png` | 298 × 76，白色横向字标，需深色底 | [酷狗官网页头原 PNG](https://www.kugou.com/common/images/icon_logo_v20.png) |
| `assets/brands/icloud.ico` | 包含 16、32、48 像素原始图层 | [iCloud 原 ICO](https://www.icloud.com/favicon.ico) |

## 校验及使用约束

- SVG 经 XML 解析验证，根节点为 SVG，没有 script 节点；PNG/ICO 经 Pillow 读取真实格式和尺寸，下载结果不是 HTML 或错误页面。
- TT语音官网 favicon 指向 `https://ga-album-cdnqn.52tt.com/web/tt-backstage-system/20211221174054_45303550.ico`，该 CDN 在当前代理路径下 TLS 握手失败。未绕过代理，采用官网可访问的完整 PNG 字标。
- TT语音白色字标须使用深色容器并保持 `object-fit: contain`，保留完整比例，不要拉伸、裁切或把透明白色图案直接放在白底上。
- 酷狗方形官方 favicon 只有 16 × 16 像素，保留官方原件；没有通过 AI 或插值生成声称为官方的高分辨率替代品。
- 商标及标识的权利属于各自所有者；本地账本仅使用这些图标区分用户记录的服务。

## 账户预设图标

| 账户 | 本地文件 | 实际格式 / 原始尺寸 | 官方来源页面 | 原文件地址 |
| --- | --- | --- | --- | --- |
| 微信 | `assets/brands/wechat.png` | PNG / 32 × 32 | [微信官网](https://weixin.qq.com/) 的 shortcut icon 声明 | [微信官方资源](https://res.wx.qq.com/a/wx_fed/assets/res/NTI4MWU5.ico) |
| 支付宝 | `assets/brands/alipay.ico` | ICO / 32 × 32 | [支付宝官网](https://www.alipay.com/) 的 icon 声明 | [支付宝官网引用的阿里静态资源](https://img.alicdn.com/tfs/TB1qEwuzrj1gK0jSZFOXXc7GpXa-32-32.ico) |

- 两个最终图标均从官网 HTML 已声明的真实资源地址获取，使用 `http://127.0.0.1:10090` 显式代理。通过 Pillow 读取实际格式、尺寸并校验文件；不是 HTML、错误响应或重绘图。
- 微信资源 URL 虽以 `.ico` 结尾，原始内容实际是 PNG，因此仅按实际格式命名为 `wechat.png`；文件字节未转换或修改。
- 支付宝官网还声明了一个大尺寸 favicon 原件，已原样保留在 `assets/brands/alipay-source.png`：PNG 2600 × 1950，来自 [支付宝官方静态资源](https://mdn.alipayobjects.com/rms/afts/file/A*7EyORZxdNDkAAAAAAAAAAAAAARQnAQ)。该原件留白较多，账户卡片使用上表中官方方形 ICO，无裁切或重新排版。

## 安卓手机版资源适配（1.2.0）

- 手机账户、账单、来源和订阅页面复用此处已有品牌原件，没有重新下载或 AI 重绘。PNG 原件直接复制到 `android/app/src/main/res/drawable-nodpi/logo_*.png`，保持原始像素。
- 支付宝、百度、网易云、哔哩哔哩、酷狗及银行 ICO 转为安卓可读取的 PNG，保留可用最大原始图层的尺寸与完整图案：招商银行 48 × 48，支付宝/百度/网易云/哔哩哔哩 32 × 32，酷狗及建设/农业/中国/交通/邮储/平安银行 16 × 16。工商银行复用原 PNG。没有生成更高分辨率的替代图。
- Claude 的 `logo_claude.xml` 为现有 `claude.svg` 的 Android VectorDrawable 适配，沿用原始 pathData、颜色和 248 × 248 viewport，不改变图形。
- TT语音保持完整横向白色字标，手机使用紫色背景和等比例 FIT_CENTER 显示；其他品牌同样保持比例。未提供品牌图标的自定义账户使用名称首字作为占位，不声称是品牌标识。
