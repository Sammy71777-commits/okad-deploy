# OKAD 六段物流流程 + 付款闭环（已上线）

部署时间：2026-11-02 · Worker `shrill-wave-7c04` + Pages `okad-africa` 均已更新

---

## 一、流程改成你要的 6 段

```
1 仓库 → 2 上船 → 3 在途 → 4 付款 → 5 清关 → 6 送货
```

| 段 | 节点 key | 客户看到（中/英） | 变更 |
|---|---|---|---|
| 1 仓库 | `warehouse` | 货物已入仓 / Warehouse received | 保留 |
| 2 上船 | `packed` | 已上船 / Loaded on vessel | 文案改（原"已打包发出"） |
| 3 在途 | `transit` | 海运·空运途中 / In transit | 保留 |
| **4 付款** | `payment` | **已收款 / Payment received** | **新增** |
| 5 清关 | `customs` | 清关中 / Customs clearance | 保留 |
| 6 送货 | `pickup` | 送货上门 / Out for delivery | 文案改（原"可提货"） |

**已删除**：`confirmed` 订单已确认、`arrived` 已抵达特马港 —— 三语言文案同步处理。

历史订单的 `trackLog` 里仍带这两个旧 key，已在 `buildMilestones()` 加过滤，
不会污染"x/6"的进度计数，老单照常显示。

---

## 二、第 4 段「付款」闭环

```
客户查单 → 进度到第 4 段 → 点「💳 Pay now 去付款」
    ↓
直达付款页（选 MoMo / 银行 / USDT → 传凭证）
    ↓
后台 1-3 天审核 → 点「💰 收款 确定收款成功」
    ↓
第 4 段「付款」点亮 + 状态置 Paid + 自动发邮件通知
    ↓
客户再查 → 「✅ 付款成功 · Payment received」
```

要点：

- **已收款的订单不再让客户重复付款** —— 再点进去直接落到成功态，不显示付款按钮。
- 判断依据三条取其一：状态 `Paid` / 有 `paidAt` / 时间轴已点亮 `payment` 节点。
- 后台「收款」键会**自动补齐前序节点**（仓库/上船/在途），符合"到港后付款"的实际时序。

---

## 三、三种推送（你要的三件套）

### 1. 邮件 — 真的发出去

复用 Worker **已有的 Brevo 通道**（就是发验证码那一套，`env.BREVO_API_KEY`），
新增 `POST /api/notify/email`，**零新组件、零新绑定**。

- 发件人：`sammy71777@gmail.com`（Brevo 已验证，实测 active）
- 额度：Brevo 免费版 300 封/天
- 触发：后台每次推进节点**自动发送**，toast 回显 `✉ 邮件已发`
- 失败可手动补：后台订单卡 `✉ 重发邮件`

邮件内容：订单号 + 最新状态 + 📍 现在到哪了 + 「查看实时进度」按钮（带 `?track=` 直达链接）。

### 2. WhatsApp — 一键话术

个人号**没有官方 API，无法自动发**。做法是生成一条话术，客服点一下即发出：

```
🚚 OKAD 物流更新 · OKAD99417223
📦 进度 4/6
📍 已收款 · MTN MoMo TX8891 confirmed
👉 查看实时进度：https://okadafrica.com/?track=OKAD99417223
```

后台订单卡 `📤 推送进度 WhatsApp` 按钮直接打开 `wa.me` 带好这段文字。

### 3. 页面自动刷新

客户停在追踪页时每 30 秒轮询云端，状态一变就地重绘并弹 `🔔 有新进展`。
用订单指纹比对（状态+节点+位置+回执数），不会无意义重绘；离开页面自动停掉。

---

## 四、顺手修掉的两个真 bug

**bug 1：连续点后台动作会丢记录。**
`_loadOrderObj` 每次从云端重读，而 D1 写入后立刻读可能返回旧版本（最终一致）。
连续点「接单→处理→收款→完成」时，后一次基于旧行覆盖，把前一次冲掉——
实测 `actionLog` 只剩 3 条，丢了「处理」。
**修复**：写回成功后在 `_orderCache` 存一份，下次优先读它。复测 `actionLog` 完整 4 条。

**bug 2：历史单旧节点污染 6 段计数。**
老单 `trackLog` 含 `confirmed`/`arrived`，改版后会让"x/6"失真。
**修复**：加 `TRACK_STEPS_RETIRED` 过滤表，进度计数与后台"x/6"徽标都只算有效节点。

---

## 五、实测结果（线上真实跑通）

测试单 `OKAD99417223`（向导建单，带真实邮箱）

| 检查项 | 结果 |
|---|---|
| 向导建单 | ✅ `OKAD99417223` |
| 追踪页显示 6 段 | ✅ 含付款节点、含已上船 |
| 已移除「订单已确认」 | ✅ |
| 已移除「已抵达特马港」 | ✅ |
| 未付款 → 「去付款」按钮 | ✅ |
| 点击 → 付款页打开 | ✅ |
| 后台 接单 / 处理 / 收款 / 完成 | ✅ 全部 `☁ synced` + `✉ 邮件已发` |
| 客户复查 → 付款成功 | ✅ |
| 进度 / 位置 | ✅ `6 of 6` + `Accra Spintex` |
| 控制台错误 | **0** |

云端 `notes` 落库核对：

```
trackLog:   warehouse → packed → transit → payment → customs → pickup
payment 由 admin:payconfirm 点亮   ✅
actionLog:  accept, process, payconfirm, complete  （4/4 完整）
paidAt:     2026-11-02T06:04:12Z   status: Delivered
```

邮件接口实测：`POST /api/notify/email` → `{"ok":true}`，真实投递成功。

---

## 六、改动文件

| 文件 | 改动 |
|---|---|
| `worker-okad.js` | 新增 `sendNotifyEmail()` + `POST /api/notify/email`（复用 Brevo） |
| `deploy/index.html` | `TRACK_STEPS` 改 6 段 + `TRACK_STEPS_RETIRED` 过滤表；三语言文案；`STATUS_TO_MILESTONE` 重映射；`ORDER_ACTIONS` 新增「收款」键；`openPayForOrder()` 付款跳转；`orderIsPaid()` 已收款判断；`notifyCustomerEmail()` 邮件直发；`waNotifyProgress()` WhatsApp 话术；`startTrackAutoRefresh()` 自动刷新；`_orderCache` 修复连续写覆盖 |

四份前端副本 md5 一致。

---

## 七、一个遗留小问题

**`/undefined`**：你截图里地址栏是 `okadafrica.com/undefined`，页面显示 Sample Demo。
兜底代码已上线（`replaceState` 拉回首页），但 Pages 对未知路径会 fallback 到 index.html，
所以路径能打开、只是 `?track=` 参数丢了才落到示例页。
如果还在复现，多半是 Service Worker 缓存了旧页面 —— 强刷一次即可。需要的话我可以把 SW 缓存版本再提一级强制刷新。
