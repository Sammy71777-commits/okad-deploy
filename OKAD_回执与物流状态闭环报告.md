# OKAD AFRICA — 回执图片 + 物流状态闭环

> 场景：新客户从 WhatsApp 进来（**个人号**）→ 确定商品与重量 → 拿到公司代码（OKAD 单号）
> → 客户回传**物流回执图片** → 后台查看并更新状态 → 客户随时查"到什么地方了"

---

## 一、先说清个人号的技术现实

| 方案 | 能不能自动收 WhatsApp 图片 | 结论 |
|---|---|---|
| WhatsApp 个人版 App | ❌ 无任何官方 API | 不能接 webhook，只能人工 |
| 第三方自动回复机器人（Tasker / 无障碍 / 逆向） | ⚠️ 能，但违反 WhatsApp 服务条款 | **不建议**，有封号风险，号码是公司的核心资产 |
| WhatsApp Business App（免费，个人号可迁移） | ❌ 仍无 API，但有标签/快捷回复 | 可选，人工效率略高 |
| Business App + Cloud API **共存模式** | ✅ 能收图 + 自动回复 | **唯一官方全自动路径**，需 Meta 商业账号验证 |

**所以本次交付的是不依赖任何 API、今天就能用的闭环**：客户发图这一步，改成"客服一键发链接 → 客户点开上传"。
人工只多一次「复制链接发给客户」，其他全部自动化。等将来开了 Cloud API，上传入口和数据结构**一行都不用改**。

---

## 二、本次闭环（4 步）

```
① 客服后台点 "📲 Ask payment receipt"
      ↓  自动打开 WhatsApp，文案已带上该客户的订单链接
② 客户点开链接 → 直达追踪页 → "📎 Upload receipt" → 拍照/选图
      ↓  图片压缩后绑到该订单（本机 + 云端 D1 双写）
③ 客服后台 Orders 页立刻看到回执缩略图 → 点开看大图
      ↓  下拉推进里程碑，弹窗填"现在到哪了"
④ 客户再查 code → 进度条 + 📍位置文字 + 回执图片全部可见
```

### 客服日常操作（3 个按钮）
- **📲 Ask payment receipt** — 发付款回执上传链接
- **📦 Ask POD** — 发签收单上传链接
- **🔍 View all** — 查看该单所有回执大图（可删除传错的）

链接形如：`https://okadafrica.com/?track=OKAD95924865`，客户点开直接看到自己的单。

---

## 三、顺手修掉两个真 bug（否则闭环根本不通）

这两个不是新功能的边角问题，是**已有的线上故障**，直接卡死"后台更新状态 → 客户查得到"：

### bug 1：跨设备查单会查到别人的单
Worker 的 `GET /api/db/orders` **忽略所有过滤条件**，永远 `SELECT *` 全表；前端 `getOrderById()` 取 `rows[0]`。

线上实测：
```
GET /api/db/orders?id=eq.OKAD95924865&limit=1
→ 返回 6 行，第一行 id = TEST-002     ← 客户查自己的单，拿到的是测试单
```
> 之前没暴露，是因为 `doTrackQuery` 先查本机 localStorage（同一台手机刚下单，本机有），
> 走不到云端。**换个设备就废。**

修复：Worker GET 支持 `?id=eq.xxx` / `?status=eq.xxx` / `?order=col.desc` / `?limit=N`，
列名走白名单防 SQL 注入；排序列不存在时自动去掉排序重试（兼容前端历史写法 `created_at` 而表里是 `createdTs`）。

### bug 2：后台改状态从来没有同步到云端
前端 `DB.updateOrderFields` 发 **PATCH**，而 Worker 只实现 GET/POST/DELETE：

```
PATCH /api/db/orders?id=eq.OKAD95924865
→ HTTP 405 {"ok":false,"error":"Method not allowed"}
```
返回 null → 调用处 `.catch(function(){})` 静默吞掉。
**结果：后台推进里程碑、改订单状态、审批支付，全部只写本地 localStorage，客户永远看不到更新。**

修复：改为「取出整单 → 合并字段 → 走 `createOrder` 整行 `INSERT OR REPLACE`」
（摘要进固定列，完整 JSON 进 `notes`）。这一步也顺带解决了动态字段问题——
D1 orders 表只有固定列，直接 PATCH `trackLog`/`receipts` 会报 `has no column named X`。

**额外防御**：`_loadOrderObj` 校验返回的 `id` 必须一致，否则宁不同步。
否则在 Worker 部署生效前，拿错行整行写回会**覆盖别人的订单**。

---

## 四、改动清单

| 文件 | 改动 |
|---|---|
| `worker-okad.js` | GET 增加过滤 / 排序 / limit（修 bug 1） |
| `deploy/index.html` | `DB.updateOrderFields` 改为整行写回 + `_loadOrderObj` id 校验（修 bug 2） |
| `deploy/index.html` | 新增回执模块：`RCPT_TYPES` / `orderReceipts` / `compressImageFile` / `openReceiptUpload` / `submitReceipt` / `rcptStripHtml` / `viewReceipts` / `deleteReceipt` / `waAskReceipt` / `rcptAdminBlock` |
| `deploy/index.html` | `pushOrderMilestone` 支持 note + `lastLocation`；新增 `advanceOrderStep`（推进时弹窗问"现在到哪了"） |
| `deploy/index.html` | 追踪页：回执缩略图条 + 上传按钮 + 节点下方显示 📍位置 |
| `deploy/index.html` | 后台：普通订单行 & WhatsApp 询价单卡片共用 `rcptAdminBlock`（回执 + 位置 + 要回执按钮） |
| `deploy/index.html` | CSS：`.rcpt-strip` / `.rcpt-item` / `.rcpt-tag` |

四份前端副本（`deploy/index.html`、`index.html`、`okad_africa_app.html`、`site/index.html`）md5 一致。

---

## 五、实测结果（本地 Chromium 414×900）

| # | 检查项 | 结果 |
|---|---|---|
| 1 | 追踪页查单 + 上传按钮 + 无回执提示 | ✅ |
| 2 | 上传弹窗（类型/选图/备注/预览） | ✅ |
| 3 | 回执落库：type=payment, note, by=customer, **35KB**（1600×1200 原图压缩后） | ✅ |
| 4 | 追踪页出现回执缩略图 | ✅ 1 张 |
| 5 | 后台推进里程碑：lastLocation + trackLog.note 写入 | ✅ "Tema Port, awaiting customs" |
| 6 | 客户视角看到 📍 位置文字 | ✅ |
| 7 | 后台订单卡片：图 / 位置 / Ask receipt / Ask POD | ✅ 全部 |
| 8 | WhatsApp 链接带订单 code 与追踪链接 | ✅ |
| — | 控制台错误 | ✅ 0 个 |

---

## 六、⚠️ 待办：需要 Cloudflare 部署凭据

代码已就绪并通过全部实测，但**尚未部署到线上**——当前沙箱没有 Cloudflare 凭据
（`wrangler whoami` 返回未认证，环境变量与 `~/.wrangler` 均为空）。

请提供 API Token（权限：Workers Scripts:Edit + Pages:Edit + D1:Edit），创建地址
https://dash.cloudflare.com/profile/api-tokens ，然后执行：

```bash
export CLOUDFLARE_API_TOKEN=你的token
cd /workspace && bash deploy_now.sh
```

部署后需复验（这两项依赖线上 Worker）：
1. `GET /api/db/orders?id=eq.OKAD95924865` 应只返回 1 行且 id 正确
2. 后台推进里程碑后 toast 显示 `☁ synced`（显示 `⚠ local only` 说明云端未通）

---

## 七、关于"回执是图片"的处理

- 图片走 **canvas 压缩**：长边 ≤1100px，JPEG 质量从 0.72 逐步下调，硬压到 **≤260KB**
  （实测 1600×1200 截图 → 35KB），base64 随整单 JSON 存进 D1 `notes` 列。
- **不新增存储组件**：完全复用现有 `paymentProof` 的落库姿势，没有引入 R2/KV 绑定。
- 历史单兼容：旧的 `paymentProof`（单张付款截图）会被 `orderReceipts()` 自动识别为
  `type:'payment'` 的回执，无需数据迁移。
- 回执分类：💳 付款 / 📦 签收单 / 🛃 清关单 / 🏭 入库照 / 📎 其他。

---

## 八、下一步（可选：真正的全自动）

如果后面想连"客户在 WhatsApp 里直接发图、系统自动入库"都省掉，路径是：

1. 个人号 → 免费迁移到 **WhatsApp Business App**（聊天记录可一起迁移）
2. 在 Meta 后台为该号码开通 **Cloud API 共存模式**（手机 App 与 API 同时在线）
3. Worker 增加 `POST /api/wa/webhook` 收图片消息 → 落到对应订单的 `receipts`

届时**前端上传入口、订单结构、后台界面全部不用改**，只是多一个入库来源。
需要 Meta 商业验证（通常 1–3 个工作日）与模板消息审核。
