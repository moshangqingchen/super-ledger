# 银行 Logo 来源

获取日期：2026-11-05。所有本机下载均显式通过 `http://127.0.0.1:10090`，代理不可用时不直连。图标随桌面应用打包，运行时不请求银行网站。

使用银行官网提供的原始 favicon 字节，未使用 AI 生成、描摹或重新绘制品牌图标。工商官网的 `.ico` URL 实际返回 PNG，因此仅将文件扩展名更正为 `.png`。图片解码校验已通过。

| 银行 | 本地文件 | 原始格式 / 最大尺寸 | 官方来源 |
| --- | --- | --- | --- |
| 工商银行 | `assets/brands/banks/icbc.png` | PNG / 32 × 32 | https://www.icbc.com.cn/favicon.ico |
| 建设银行 | `assets/brands/banks/ccb.ico` | ICO / 16 × 16 | https://www.ccb.com/favicon.ico |
| 农业银行 | `assets/brands/banks/abc.ico` | ICO / 16 × 16 | https://www.abchina.com.cn/favicon.ico |
| 招商银行 | `assets/brands/banks/cmb.ico` | ICO / 48 × 48（另含 16 / 24 / 32） | https://s3gw.cmbimg.cn/srd-a2549394cd7491f-1255000101/cmb.ico |
| 中国银行 | `assets/brands/banks/boc.ico` | ICO / 16 × 16 | https://www.boc.cn/favicon.ico |
| 交通银行 | `assets/brands/banks/bocom.ico` | ICO / 16 × 16 | https://www.bankcomm.com/favicon.ico |
| 邮储银行 | `assets/brands/banks/psbc.ico` | ICO / 16 × 16 | https://www.psbc.com/favicon.ico |
| 平安银行 | `assets/brands/banks/pingan.ico` | ICO / 16 × 16 | https://bank.pingan.com/favicon.ico |

招商 CDN 资源由招商银行官方移动站 `https://m.cmbchina.cn/` 的 `rel="icon"` / `shortcut icon` 链接确认；网页存档为 `artifacts/bank-cmb-home.html`。其余图标来自相应银行官网同源 favicon。16 px 图标为官网原生尺寸，界面采用小尺寸展示。

其他仅供来源比对、未用于界面的原文件保留在 `artifacts/bank-cmb-touch-icon.png`（官方 114 × 114 PNG，包含文字）及 `artifacts/bank-psbc-alternative-logo.png`（官方 381 × 310 PNG，边缘较模糊）。

品牌图标仅用于用户选择与辨识自己的账户，不表示银行授权、银行服务接入或实际支付能力。银行选项不会自动建立账户或设置余额。
