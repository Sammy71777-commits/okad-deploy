# OKAD AFRICA — 自动化询价流程（Shipping Enquiry）交付报告

日期：2026-11-02
范围：第一步（纯网站内，零外部依赖，已上线）；第二步（WhatsApp Cloud API 全自动）待 Meta 账号权限

---

## 一、要解决的业务问题

现状：WhatsApp 进来的新客户，**商品、重量、路线、公司代码** 全靠人工在对话里确认，
再手工去网站/后台建单、发 code、查物流。重复劳动多、易漏单、无法规模化。

目标：客户自助走完 4 步 → 系统自动报价 → 自动生成追踪码 → 推送到客户 WhatsApp →
后续客户自己查物流。人工只做「最终报价确认」这一件事。

---

## 二、落地位置（为什么选这里）

**新增 1 个页面 `wizPage`（Shipping Enquiry）+ 1 组 Worker 可复用逻辑。**

| 入口 | 位置 | 说明 |
|---|---|---|
| 首页 | 新增 **FAST 📲 Shipping Enquiry** 卡片 | 4 步 → 即时报价 + WhatsApp 收 code |
| AI 搜索结果卡 | 每张卡新增 **💰 Get shipping quote for this** | 商品名自动带入向导，不用重打 |
| WhatsApp 消息 | `?track=OKADxxxxx` 链接 | 客户点开直达追踪页，自动查单 |

**没有把向导塞进现有 Get Quote 页**——那页是运营算运费的专业工具（每箱重量、每 CBM 重量、密度），
客户不懂。向导用客户语言（"多少公斤"），算完后**走同一套 `getQuoteRules()` + `getPriceTable()`**。

---

## 三、代码共用清单（本次未重复开发的部分）

| 复用的现有资产 | 用途 | 代码位置 |
|---|---|---|
| `getQuoteRules()` | 最低计费体积/最低收费/体积密度/估算密度 | 规则后台可改，向导自动跟随 |
| `getPriceTable()` + `getRouteKey()` | 航线单价与时效 | 与 Get Quote 页同源 |
| `compareShipping()` 的计费公式 | 海运 `max(体积×$/CBM, 重量÷1000×$/ton)`、空运 `max(实重,体积重)×$/kg` | **未重写，仅复用** |
| `getRoutes()` | 只列后台已开通的 (from,to) 组合 | 路线开关自动生效 |
| `isValidTrackCode()` | `OKAD` + 6~12 位数字 | 与现有追踪码规则完全一致 |
| `order` 对象结构 | 复用全部字段，只加 `waPhone` / `source:'wizard'` | **Admin 订单页 / 追踪页 / 状态机零改动** |
| `DB.createOrder()` 的写入姿势 | 固定列放摘要、完整 JSON 放 `notes` | D1 表结构不需改 |
| `doTrack()` / `findLocalOrder()` / `DB.getOrderById()` | 客户查件全链路 | 早已实现，无需开发 |
| `openWhatsApp()` 的号码来源 | `cachedConfig.whatsapp.number` | 同一号码源 |

**新增代码仅 3 处**：
1. `wizPage` 页面结构 + `.wiz-*` 样式
2. `wiz*` 系列函数（约 300 行，收集 + 调现有引擎 + 落库 + 渲染）
3. `DB.upsert()` 通用方法（见下，这是修 bug）

---

## 四、顺手修掉的一个致命 Bug

> `submitOrder()` 第 4142 行调用 `DB.upsert('orders', order)`，
> 但 **`DB` 对象从来没有定义过 `upsert` 方法** —— 只有 `upsertUser`。
> 抛 `TypeError: DB.upsert is not a function`，订单**根本同步不到云端**。

影响：客户在正常下单流程里下的单，运营在后台看不到、跨设备查不到。**静默失败**，因为外面套了 `.catch()`。

修复：新增 `DB.upsert(table, data)`，且**写入姿势必须与 `createOrder` 一致**——
D1 `orders` 表固定列只有 `id/email/name/product/qty/total/status/route/method/createdTs/updatedTs/notes`，
完整订单本体放 `notes`(JSON)，固定列只放摘要。
（直接平铺写入会被"缺列自适应"机制砍掉 `waPhone/wt/vol/source` 等关键字段。）

---

## 五、后台：新增 WhatsApp Enquiries 区块

位置：**Admin → Orders 页顶部**，橙色边框，与原有 Assisted Purchase 看板并列。

每条询价单显示：商品名 / 时间 / 追踪码 / 数量 / 重量 / 体积 / 路线 / 估价 / 客户备注，
两个操作按钮：
- **📲 WhatsApp** — 一键打开 `wa.me/<客户号>?text=已带code` 的对话，客服不用手打
- **🔍 Track** — 直接跳追踪页并自动查这单

数据来源：云端 D1 `listAllOrders()` 实时拉取 → 运营在**任何设备**都能看到客户提交的单。

---

## 六、完整流程（上线实测）

```
客户从 WhatsApp / 网站进来
   ↓
首页点 "Shipping Enquiry"（或从 AI 搜索结果点"Get shipping quote for this"）
   ↓
① 商品 + 数量        （从搜索进来已自动填好）
② 重量（kg）或体积（m³）—— 体积可留空，按估算密度自动反推
③ 起运地/目的地 + WhatsApp 号（+ 邮箱、备注选填）
④ 点 "Get my quote"
   ↓
系统（复用 Get Quote 同一套规则）自动算海运/空运 → 推荐更便宜的那个
   ↓
生成追踪码 OKADxxxxxxxx → 写入本机 + 云端 D1
   ↓
结果页：橙色 code 卡 + 完整报价明细 + 3 个按钮
   ├─ 📲 Send this code to my WhatsApp  → wa.me 带全部参数 + 追踪链接
   ├─ 🔍 Track my shipment               → 追踪页自动查单
   └─ ↩ Start a new enquiry
   ↓
客服在 Admin → Orders → WhatsApp Enquiries 点 "📲 WhatsApp" 直接回客户
   ↓
客户点收到的 `?track=OKADxxx` 链接 → 直达追踪页，随时查进度
```

---

## 七、上线实测结果

浏览器端到端（Playwright，线上真站点）：

| 验证项 | 结果 |
|---|---|
| 向导 4 步走通 | ✓ Step1→2→3→4 |
| 自动报价（200×太阳能板 / 850kg / Shenzhen→Tema） | ✓ 海运 $357 / 28-35 天 |
| 生成追踪码 | ✓ `OKAD95924865` |
| 订单落本机 | ✓ `waPhone` / `source=wizard` / `wt=850` / `vol=3.4` / `quote=357` 全在 |
| 订单同步云端 D1 | ✓ 固定列摘要 + `notes` 完整 JSON |
| 追踪页回查 | ✓ 显示"Awaiting review" + 7 个里程碑 |
| `?track=OKADxxx` 链接直达 | ✓ 自动打开追踪页并查单 |
| 后台询价单区块 | ✓ 计数(2)、卡片字段完整、WhatsApp/Track 按钮就位 |
| **报价一致性（关键）** | ✓ **向导 $84 = Get Quote 页 $84**（同参数），证明同一套规则 |
| 控制台错误 | ✓ **0 个** |

回归（原有功能未破坏）：

| 验证项 | 结果 |
|---|---|
| AI 搜索结果卡新按钮 | ✓ `💰 Get shipping quote for this` |
| Get Quote 页报价引擎 | ✓ 正常出价（100pcs/200kg → $84 Sea / $1160 Air） |
| 首页卡片 | ✓ 5 张，含新增 FAST 卡片 |
| Track 页 | ✓ 正常 |
| JS 语法 / CSS 括号 | ✓ 全通过 |

---

## 八、改动文件

| 文件 | 改动 |
|---|---|
| `deploy/index.html` | `wizPage` 页面 + `.wiz-*` 样式 + `wiz*` 系列函数 + `DB.upsert()` + `wizLeadCardHtml`/`wizAdminTrack` + 搜索卡按钮 + 首页卡片 + `?track=` URL 处理 |
| `index.html` / `okad_africa_app.html` / `site/index.html` | 同步（md5 一致：`4e5fffeb...`） |

部署：Cloudflare Pages（`wrangler pages deploy`，已修正 manifest 假成功问题）

---

## 九、第二步：WhatsApp Cloud API 全自动（待账号权限）

第一步已把**所有业务逻辑、订单结构、报价引擎**做完并上线。第二步只是把"人看消息"换成"机器看消息"，
前面的代码**一行都不用改**。

需要新增（Worker 端）：

| 端点 | 作用 | 存储 |
|---|---|---|
| `POST /api/wa/webhook` | 收 Meta 消息，解析意图 → 引导填商品/重量/路线 → 调现有报价引擎 → 发 code | KV 存会话状态（天然 TTL） |
| `POST /api/wa/send` | 发消息给客户 | 复用 `cachedConfig.whatsapp.number` |
| `GET /api/wa/status` | 健康检查 | KV |

**开工前必须确认两件事**：
1. **WhatsApp 账号类型** —— 个人号（`wa.me/233505615533`）**无法做自动应答**，
   只能半自动（客户点预填链接发给我们，后台 webhook 或人工回复）；
   已开通 WhatsApp Business API 才能全自动（需 Meta 开发者账号 + Business Manager + 模板消息审核，1-3 天）。
2. **客户回传单据的形式** —— 文字 / 图片（物流回执）/ 两者都有。图片需走 Meta 媒体下载 API，
   落地方式复用现有 `payment_proof` 的 base64 机制（加 `delivery_proof` 字段）。

**已知约束**：WhatsApp Cloud API 有 **24 小时客服窗口**，窗口外只能发模板消息。
流程设计需保证客户在窗口内完成，或用模板消息兜底。
