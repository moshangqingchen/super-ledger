# 会员服务与档位来源

核对日期：2026-11-05（用户所在时区 America/Los_Angeles）。预设数据位于 `subscription-catalog.mjs`，浏览器使用 `subscriptionCatalog` 导出。

这些内容用于记账时快速填写服务名称与会员档位；不是会员购买页面，也不代表某个账户或地区一定能购买对应方案。金额由用户按自己的实际账单填写。页面不根据预设名称自动填入价格、兑换汇率或发起付款。所有档位均应允许手动改写；自定义服务保存时省略 `serviceId` 字段。

## 已核对的预设

| 服务 ID | 显示名称 | 预设档位 | 一手来源与核对说明 |
| --- | --- | --- | --- |
| `chatgpt` | ChatGPT | Go、Plus、Pro 100、Pro 200、Pro 500 | [OpenAI 官方 Pricing / ChatGPT Learn](https://learn.chatgpt.com/docs/pricing)列出个人订阅；[Meet dots](https://learn.chatgpt.com/docs/dots)的 Access 段明确列出三个 Pro 档位名称。用户说的“GPT”映射为 ChatGPT。 |
| `claude` | Claude | Pro、Max、Ultra | [Claude 官方 Pricing](https://claude.com/pricing)当前页面及 FAQ 使用 Pro、Max、Ultra。搜索缓存中的旧 Max 5x / Max 20x 不作为当前显示名；旧账单名称仍可手填。 |
| `gemini` | Gemini | Google AI Plus、Google AI Pro、Google AI Ultra 5x、Google AI Ultra 20x | [Google One 官方 AI 方案页](https://one.google.com/about/google-ai-plans/)列出 Plus、Pro，并在方案比较表中区分 Ultra 5x / Ultra 20x。展示服务名 Gemini，档位保留实际订阅方案名。 |
| `suno` | Suno | Pro、Premier | [Suno 官方定价页](https://suno.com/pricing)当前列出两个付费档位；免费方案不列入付费订阅候选。只填服务及档位名称，金额、税费和计费周期由用户按实付填写。 |
| `grok` | Grok | Plus、Premium、Super、Ultra | [当前官方定价页](https://x.ai/pricing)及[官方 The X Subscription 文档](https://docs.x.ai/x-subscription/pricing)使用四个付费个人档位。官网目前将 Grok、Cursor、X 纳入 The X Subscription；旧 SuperGrok 方案可继续使用，历史档位可直接自填。未把搜索缓存中的旧方案当作新购方案，也未预填美元价格。 |
| `ttvoice` | TT语音 | 超级玩家、超级玩家SVIP | [TT语音“超级玩家”服务协议](https://activity.52tt.com/yy-act/rules/choajiwanjfuwuxieyi/)第 2.2 条明确区分这两种服务。协议页面标示的更新版本为 2024-04-26；本次核对其仍可公开访问。没有把财富等级、魅力等级或未经核对的贵族称号编成会员档位。 |
| `kugou` | 酷狗音乐 | 豪华VIP、超级VIP、音乐包 | [酷狗音乐会员服务协议](https://h5.kugou.com/voo/v-a019d10d/index.html)“特别提示”列出三类，页面更新及生效日期为 2026-06-29。未把酷狗概念版、听书、音箱等独立服务混入。 |
| `baidu` | 百度网盘 | 会员、超级会员 | [百度网盘官方 App Store 刊载页](https://apps.apple.com/cn/app/id547166701)的开发者为 Beijing Duyou Science and Technology Co.,Ltd.，订阅及内购清单分别列出会员、超级会员。百度网盘自己的部分网页在本次读取中超时，因此采用开发者在官方应用商店发布的内容；不引用用户评论。 |
| `netease` | 网易云音乐 | 黑胶VIP、黑胶SVIP、音乐包 | [网易云音乐官方 App Store 刊载页](https://apps.apple.com/cn/app/id590338362)由杭州网易云音乐科技有限公司发布；搜索可读取的开发者订阅说明明确出现三类名称。正文抓取结果因商店动态内容有所差异，未据此写入价格或权益。 |
| `bilibili` | 哔哩哔哩 | 大会员 | [bilibili 大会员服务协议](https://www.bilibili.com/html/big_protocol.html)确认该服务名称。本次只提供基础名称；具体月卡、年卡、联合会员等可手动补充。 |
| `icloud` | iCloud+ | 50GB、200GB、2TB、6TB、12TB | [Apple 中国大陆 iCloud+ 页面](https://www.apple.com.cn/icloud/)列出五种付费存储方案。免费 5GB 不列入付费订阅预设。 |

## 使用约定

- 预设保存的是核对当日的静态名称，不会在启动账本时联网更新或读取服务账户。
- `tiers` 为快捷填写候选，不是严格枚举。用户可直接手填历史档位、地区专属方案、联合会员或任意自定义名称。
- 月度、季度、年度属于扣费周期，不能只凭档位名称推断。应按实际日期、金额和续订设置记账。
- `logo` 路径使用 `/assets/brands/` 内实际取得的 SVG、PNG 或 ICO 原文件；Logo 资源及其取得方式见 `brand-assets.md`。TT语音使用官网完整白色字标 PNG，展示时应使用深色底与 `object-fit: contain`，不要裁切或拉伸。`color` 仅是界面配色，不宣称为官方品牌标准色。
- 本文仅摘取产品与档位名称，未复制服务协议全文，未保存任何用户账号、订单或凭据。

## 本次查询的路径

档位使用云端托管网页搜索与读取工具核对。无法核实该云端工具的实际网络出口，不宣称它经过本机代理。Suno、Grok 官方图标另由本机通过显式 `http://127.0.0.1:10090` 代理取得；来源、尺寸和校验值见 `brand-assets.md`，未回退直连。
