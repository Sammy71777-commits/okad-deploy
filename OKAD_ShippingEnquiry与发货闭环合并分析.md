# Shipping Enquiry 与发货闭环的关系分析

> 问题原话：*"帮我一下 shipping enquiry 这个地方和我们现在要改的地方有什么相同之处，真的需要单独展示吗，还是说可以放在里面。这是产生代码的地方，可否直接加入到这个流程的第一步，然后在下单，到最后完成，后台查询。帮我分析一下"*

结论先说：**不需要单独展示，Shipping Enquiry 已经按你的设想被合并成整条流程的第 1 步**，代码已实现并上线验证。

---

## 一、两者到底是不是同一件事

**是。** 它们是同一条交易链的两端，不是两个并列的功能。

| | Shipping Enquiry（询价向导） | 新增的 Deliver Now 发货闭环 |
|---|---|---|
| 回答的问题 | "这批货大概多少钱、走哪条线、多久到？" | "价格定了，怎么把货发给我们？" |
| 产生的数据 | 追踪码 `OKADxxxx` + 产品/数量/重量/体积/路线/报价 | 同一个追踪码 + 入仓环节 + 送货单 + 完成标记 |
| 客户动作 | 填 4 步表单 → 拿报价 | 复制地址 → 通知发货 → 传送货单 → 完成 |

关键重叠点在于**两者共用同一个订单实体**：询价建单时 `source:'wizard'`，发货建单时 `source:'delivery'`，字段结构完全一致（`id / status / product / qty / wt / vol / route / method / quote / trackLog / receipts`），所以后台订单页、追踪页、状态机**零改动**就能同时吃下两种来源的订单。

这正是"询价合一"能成立的技术前提。

---

## 二、原先为什么要分开展示（以及为什么现在必须合并）

原来的割裂感来自一个具体缺陷：**询价算完价就断了**。

```
旧路径：Enquiry → 拿到报价 + 追踪码 → [???] → 客户不知道下一步该干嘛
```

客户拿着一个价格和追踪码，却没人告诉他"把货发到我们的中国仓库"。仓库地址页（`whPage`）虽然存在，但只是首页 7 步流程卡片里的一个并列入口——客户得自己猜这两个东西有关系。

所以**分开展示的真正代价是流程断裂**，而不是信息架构不好看。报价和发货本来就是一次交易的两步，拆成两个页面等于逼客户自己做状态跳转。

---

## 三、现在的合并方案（已实现）

### 3.1 一条线，五个动作

```
Shipping Enquiry（4 步向导，第 1 步）
   └─ 报价结果页
        ├─▶ [主按钮] Deliver Now ──▶ 仓库地址页（本次发货信息 + 一键复制/下载图片）
        │      ├─ 第 1 步 复制仓库地址 → 发给中国供应商
        │      ├─ 第 2 步 通知已发货 → 立刻生成/复用追踪码
        │      ├─ 第 3 步 上传送货单（回执）→ 解锁完成按钮
        │      └─ 第 4 步 点「完成」→ 硬闸门通过
        │             └─▶ 追踪页 + 个人中心「我的货物」
        ├─▶ [次按钮] 仓库地址（纯查地址，不进入发货流程）
        ├─ Send this code to my WhatsApp
        └─ Track my shipment
```

### 3.2 入口是"可跳过、可直入"的两条，不是二选一

- 首页核心卡片保留独立的 **Shipping Enquiry**（`openWizard()`），供"只想问价、货还没买"的客户使用 —— 这类客户**必须**有个不进入发货流程的入口，否则会被硬推进仓库地址页。
- 报价结果页的主按钮改成 **Deliver Now**（`wizDeliverNow()`），让"已经决定要发"的客户一步到位跳进仓库地址页。

同屏承载两条路径，而不是二选一。

### 3.3 报价页（quotePage）也接上了同一条线

`compareShipping()` 算出价格后，同样渲染一个 `deliver-cta` 主按钮（`deliverNow()`），带报价上下文进仓库地址页。两条报价入口（向导 + 报价页）共用同一套发货闭环。

---

## 四、"一个下单展示一条"是怎么做到的

这是你强调的核心诉求，技术上有两道保险：

### 4.1 第一道：向导内直接复用单号

`wizDeliverNow()` 把 `wizQuoteResult.code`（向导刚生成的追踪码）写进 `pendingDelivery.code`，后面 `notifyShipped()` 直接拿它当追踪码，不再生成新的。

### 4.2 第二道：跨来源查重

`deliverNow()`（报价页入口）会先调 `findReusableEnquiry(q)`：

```
匹配条件 = 同一客户（手机号归一 OR 邮箱）
        AND 同一产品
        AND 同一路线
        AND 状态 ∈ {Pending, Quoted}
        AND 未发货（无 shippedAt / deliveryCompleted）
```

命中则复用那个单号，**不新建**。`notifyShipped()` 里对应分支只做**原地升级**：

- `status`: `Pending` → `Confirmed`
- 补 `trackLog`: `[{ key:'warehouse', by:'customer' }]`
- 本机：`arr[idx] = Object.assign({}, arr[idx], order, {...})`（保留原创建时间与客户信息）
- 云端：`DB.upsert()` 失败时退回 `DB.mutateOrder()` 整单写回

**结果**：同一次交易在货物记录中心只裂出一条卡片。

---

## 五、货物记录中心（个人中心 Me 区）

原来 Me 区只有 "Order History"，只读本机 `localStorage`，不含云端单，没有数量/产品/付款/ETA —— 客户换台手机就什么都看不到。

现在的实现：

| 需求 | 实现 |
|---|---|
| 拉云端订单 | `loadCargoCenter()` → `DB.listAllOrders()` 拉全表 → `orderBelongsToMe()` 按手机号归一 + 邮箱 + userId 三重匹配 |
| 合并去重 | 以 `id` 为键合并，同 id 走 `mergeOrderCopies()` 做**字段级合并**（云端为准，本机补缺） |
| 一个下单一条 | map 按 `String(o.id)` 建索引，天然去重 |
| **付款状态（你强调"很重要"）** | `orderIsPaid()` = `status==='Paid'` \|\| `paidAt` \|\| `trackLog` 含 `payment` 节点 → 显示 💰 已付 / ⏳ 未付 / 🕐 尚未下单 |
| 产品/数量/重量/体积 | 卡片 `cargo-grid` 三格 |
| ETA | `cargoETA()`：routeKey → `getPriceTable()` → 取 seaDays/airDays，从首个 trackLog ts 起算 |
| 当前物流阶段 | `buildMilestones()` + `TRACK_STEPS`（warehouse/packed/transit/payment/customs/pickup），带进度条百分比 |
| 追踪入口 | 卡片「🔍 Track」按钮 → 追踪页 |

> **付款按钮的坑（已修）**：判定"是不是正式订单"**不能**用 `hasTrack`。正常「下单→付款」流程创建的订单 `status='review_pending'` 且此时后台还没推任何里程碑（`trackLog` 为空），用 `hasTrack` 判断会把待付款单误判成"还没下单"，付款按钮直接消失，客户没法付款。现在改用独立的 `isEnquiryOnly`：
> ```js
> var isEnquiryOnly = (o.source === 'wizard' || status==='Pending' || status==='Quoted')
>                     && !hasTrack && !o.deliveryCompleted;
> // 付款按钮：!paid && !isEnquiryOnly
> ```

---

## 六、上传送货单 → 完成按钮硬闸门

这是你要求的"上传后才可以点击完成"，实现成**双重锁**：

1. **UI 层**：`renderShipSteps()` 里 `unlocked = (stage >= 3) && !done`，未解锁时按钮加 `.btn-locked` + `disabled`，并显示提示文案 `Upload your delivery note first to unlock this button`。
2. **逻辑层**：`finishDelivery()` 开头再判一次 `if(!d.noteUploaded){ toast(...); return; }` —— 绕过 UI 直接调函数也点不动。

送货单存进订单的 `receipts`（`type:'delivery'`），后台订单页立刻可见。

---

## 七、后台查询链路

后台所有改单动作统一走 `adminFindOrder(orderId)`：

```
本机 localStorage → 云端 D1 (DB.getOrderById) → null
```

因为客户在自己手机上下的单**只存在于 D1**，后台那台电脑的 localStorage 里没有。以前直接报 "Order not found"，后台根本推不动里程碑，客户也就永远看不到位置更新。

改单动作：

- `pushOrderMilestone(id, key, note)` —— 推物流里程碑，支持跳推（前置环节自动补齐，时间轴保持单调）
- `updateOrderStatus(id, newStatus)` —— 改状态，按 `STATUS_TO_MILESTONE` 自动补齐隐含里程碑
- `approveReview()` / `rejectReview()` —— 付款审批

写回云端统一用 `DB.mutateOrder()`（整行 `INSERT OR REPLACE`，完整订单 JSON 存在 `notes` 列）—— 因为 Worker 侧 `PATCH` 返回 405，且动态字段会因 D1 缺列失败。

客户侧：追踪页有 30 秒自动刷新（`startTrackAutoRefresh`），停留页面时后台推进会自动显示。

---

## 八、顺带修掉的两个生产级 Bug

### 8.1 Service Worker 缓存了 API 响应（严重）

原 SW 对所有跨域 GET 走 `staleWhileRevalidate`，把 `https://api.okadafrica.com/api/db/orders?...` 的响应也写进了缓存。

后果：**客户第一次拉完云端订单后，之后换设备/换会话拿到的都是那份旧列表**，货物记录中心看不到新单，后台推的里程碑也读不到。API 是实时数据，必须永远走网络。

修复：
```js
if (url.pathname.startsWith('/api/')) {
  event.respondWith(networkOnly(req));  // 只走网络,失败就报错(绝不返回旧缓存)
  return;
}
```
`CACHE_VERSION` 推进 `okad-v17 → v18 → v19`（v19 用于强制清掉客户端已缓存的旧 API 响应）。

### 8.2 付款按钮误伤待付款正式订单

见第五节的 `isEnquiryOnly` 修正。

---

## 九、仓库地址一键复制 / 下载图片

原来只有分项复制（code / 中英文地址 / 收货人），现在增加：

- **📋 Copy everything at once** —— `warehouseAllText()` 一次复制全字段
- **🖼️ Download address image** —— `downloadWarehouseImage()`，**纯 Canvas 绘制，零外部依赖**：
  - 2 倍分辨率导出 PNG（760px 逻辑宽）
  - 先用离屏 canvas 量高度，避免文字溢出裁切
  - 内容：品牌头 / 入仓号 / 中英文地址 / 收货人 / 上班时间 / 联系方式 / 底部提示（"请把入仓号写在每件货物外包装上"）
  - 生成后先在页内 `whImgPreview` 预览，再触发下载

---

## 十、最终闭环（一张图）

```
① Shipping Enquiry（4 步向导）          ← 流程第 1 步，已是主入口
      ↓ 报价 + 追踪码
② Deliver Now                            ← 报价页主按钮，直入仓库地址页
      ↓ 复制地址给供应商
③ 通知已发货                             ← 复用/生成追踪码，写入本机 + D1
      ↓
④ 上传送货单（回执）                      ← 存进 receipts，后台可见
      ↓ ▓▓▓ 硬闸门：未上传则「完成」锁定 ▓▓▓
⑤ 点「完成」                             ← deliveryCompleted = true
      ↓
   后台查询：adminFindOrder() → 找到云端单 → pushOrderMilestone() / updateOrderStatus()
      ↓ DB.mutateOrder() 整单写回 D1
   客户侧：追踪页（30s 自动刷新）+ 个人中心「我的货物」（付款状态 / ETA / 进度条 / Pay now）
```

---

## 十一、验证状态

| 项目 | 结果 |
|---|---|
| `verify_ship_flow.py` | 45 项断言 **ALL PASS**（线上 `okadafrica.com`） |
| `verify_deliver_cargo.py` | 全部通过（含 4 条付款/询价徽章回归用例） |
| 其他回归（wizard / flow6 / actions / admin_fixes / flow_wh / receipt） | 全部通过 |
| 四份 HTML 副本 md5 | `968d4f3b2c4c4b08464641d335e0228e`（完全一致） |
| SW 版本 | `okad-v19`（线上已确认） |
| 生产库污染检查 | 无测试残留 |

测试隔离：所有端到端测试改接本地内存 mock D1（`mock_d1.py`），通过 Playwright `ctx.route()` 在网络层转发到 `mock.okad.test` 假域名，**从机制上杜绝测试再碰生产库**（绕开了 HTTPS 混合内容拦截 + Chrome 145 强制 Private Network Access 双重障碍）。
