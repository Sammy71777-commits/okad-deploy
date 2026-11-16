# OKAD AFRICA — 后台推送链路 & Clients 页逻辑说明

> 回答这一轮的 5 个问题：
> 1. Clients 第二个区块展示是不是逻辑错误？
> 2. 这里的 WhatsApp 是直接把信息发出去，还是链接到我们的 WhatsApp？
> 3. Asking payment 不是图片上传吗，为什么还要我们去问？
> 4. POD 什么意思？
> 5. 是不是必须绑定公司账户？所有客户都通过这一个账户发出去吗？

---

## 一、先说结论（5 句话）

| 问题 | 答案 |
|---|---|
| Clients 第二块有 bug 吗 | **有，而且是真 bug**，已修复并上线 |
| WhatsApp 按钮是直接发出去吗 | **不是。它只打开聊天窗口 + 预填消息，必须你点一下「发送」** |
| 为什么还要"要付款凭证" | 图片**确实是客户在网页上传的**；这个按钮只是**催他去上传**（给他一个能点开的链接），不是让他在 WhatsApp 里发图给我们 |
| POD 是什么 | **Proof of Delivery = 签收单/签收证明**，客户签字的送货单照片，跟付款回执是两码事 |
| 要绑定公司账户吗 | **不需要绑定任何账号**。所有外发统一走公司号 **233505615533**；按钮里填的号码是**客户的号码**（表示"打开我和他的对话"） |

---

## 二、三条推送链路的真实走向

### 链路 A：✉ 邮件 —— 唯一全自动的通道

```
后台点「✉ 重发邮件」
      ↓
前端 → POST /api/notify/email  (Cloudflare Worker)
      ↓
Brevo (邮件服务商)
      ↓
客户邮箱 📥  ← 到这里就结束了，不需要任何人点确认
```

- **全自动**：点下去就发出去了，没有人肉环节。
- 系统也会在下单、状态变更时自动触发，不需要人工。
- 邮件正文里带的 `https://okadafrica.com/?track=OKADxxxx` 是**我们网站的追踪页**。

### 链路 B：📲 WhatsApp —— 半自动（预填 + 人工点发送）

```
后台点「📤 推送进度」/「📲 要付款凭证」/「📦 要签收单 POD」
      ↓
window.open('https://wa.me/<客户号码>?text=<预填好的消息>')
      ↓
浏览器打开 WhatsApp（网页版 or 手机 App）
      ↓
对话已打开、输入框里话已经写好
      ↓
🖐 你按一下「发送」  ← 这一步必须人工
      ↓
客户收到 ✅
```

**为什么不能全自动？**
因为我们用的是**个人 WhatsApp 号**（+233 505 615 533），不是 **WhatsApp Business API**。
个人号在网页上能做的极限就是 `wa.me` 这个官方深链：**帮你把号码填对、把话写好、把窗口打开**。
发消息这个动作没有任何程序接口，只能人按。

要真全自动必须申请 **WhatsApp Cloud API（Business API）**，门槛：

| 项目 | 要求 |
|---|---|
| Meta 商务管理平台账号 | 必须有 |
| 企业认证 | 营业执照等资料 |
| 手机号 | 一个**专用号码**，不能是现在在用的个人号 |
| 消息模板 | 每条模板要 Meta 审核通过 |
| 费用 | 按会话计费，约 $0.01–0.05 / 条（视国家） |

**所以现在的设计是对的**：按钮帮你省掉"复制号码 → 打开 WhatsApp → 找对话 → 粘贴话术"这 4 步，只留最后 1 步点发送。

### 链路 C：📎 回执图片 —— 客户在网页上传，完全不经过 WhatsApp

```
客户打开 ?track=OKADxxxx
      ↓
点「📎 Upload receipt 上传回执」
      ↓
选图 → 上传 → 存进我们的 D1 数据库
      ↓
后台「🔍 看全部 N」直接看图 ✅
```

**关键**：图片是上传到**我们的网站**，不是发到 WhatsApp 聊天里。
后台看回执也不去翻 WhatsApp 记录，直接点订单行里的「🔍 看全部 N」。

---

## 三、「为什么还要问客户要付款凭证？」

你的疑问是对的：**图片本来就是上传的**。这个按钮的真实作用是「**催**」，不是「**收**」。

现实情况：客户付完款经常不上传、忘了上传、或者传错单号。所以后台留一个催办按钮。

点「📲 要付款凭证」实际发出去的是这条预填消息：

```
Please upload your payment receipt for order OKAD99924315
— tap here: https://okadafrica.com/?track=OKAD99924315
```

客户收到后点链接 → 打开我们的网页 → 上传图片 → 存进数据库。

**所以完整闭环是：**

```
① 客户付款（线下转账 / Mobile Money）
② 客户自己上传回执  ← 大多数情况到这就完了
③ 如果没上传 → 客服点「📲 要付款凭证」催一下
④ 客户点链接 → 网页上传
⑤ 后台「🔍 看全部」看到图 → 审核 → 推进物流状态
```

按钮存在的价值只是补上第 ③ 步。

---

## 四、POD 是什么意思

**POD = Proof of Delivery = 签收证明 / 签收单。**

货送到客户手上时，让客户在送货单上**签字（+ 日期，有时盖章）**，然后拍照上传的那张纸。

跟「付款回执」是完全不同的两个东西：

| | 付款回执 Payment Receipt | POD 签收单 |
|---|---|---|
| 英文 | Payment Receipt | Proof of Delivery |
| 谁给谁 | 客户 **付钱给** 我们 | 我们 **把货交给** 客户 |
| 长什么样 | 银行转账截图 / Mobile Money 回单 | 客户签字的送货单照片 |
| 发生在 | 流程第 4 段（付款） | 流程第 6 段（送货） |
| 作用 | 证明钱到账了 | 证明货送到了、责任转移 |

后台一共支持 5 种回执类型：

```
💳 Payment 付款回执      → 付款凭证
📦 POD 签收单            → 客户签字的送货单
🛃 Customs 清关单        → 清关文件
🏭 Warehouse 入库照      → 仓库收货照片
📎 Other 其他            → 其他
```

---

## 五、公司账户：要不要绑定？所有客户走一个号吗？

### 不需要绑定任何账号

WhatsApp 的机制是「我的号 → 你的号」。只要我们有 **1 个号码**，就能给世界上任何一个 WhatsApp 用户发消息，**不需要给每个客户建账号、配绑定关系**。

### 是的，所有客户都从同一个号发出去

**外发统一走公司号：`+233 505 615 533`**

- 配置位置：Worker 环境变量 `WHATSAPP_NUMBER` → `/api/config` → 前端 `cachedConfig.whatsapp.number`
- 后台「AI 设置」Tab 里可以改
- 改一次，全站所有 WhatsApp 入口同步生效

### 但有个容易混淆的点：按钮里填的是**客户的**号码

| 场景 | 链接 | 含义 |
|---|---|---|
| 后台订单行「📤 推送进度」 | `wa.me/<客户号码>` | 打开「**我 ↔ 这个客户**」的对话 |
| 网站上的「联系我们 / Chat on WhatsApp」 | `wa.me/233505615533` | 打开「**客户 ↔ 我们公司**」的对话 |

**两者都是从 233505615533 这个号出去的**，区别只是"打开哪个对话窗口"。

### ⚠️ 已修复的一个真 bug

之前代码里有一行兜底逻辑：订单没有客户号码时，就 fallback 到公司号。
结果：客服点「要付款凭证」，弹出的是**我们自己的聊天窗口**，"请上传凭证"这条消息发给了自己。

已改成：**没有客户号码就直接提示「⚠ 这单没有客户 WhatsApp 号 — 请先在订单里补上号码」，不发。**

---

## 六、Clients 页第二块：确实是逻辑错误（已修复并上线）

### 现象
Clients 页面只剩两块，第三块「Customer Profit Summary 客户利润汇总」从来不出现。

### 根因（不是样式问题，是 HTML 结构问题）

第一块「Registered customers」的渲染函数 `registeredUsersInner()` 在没有注册用户时**提前 return，但少闭合了一个 `</div>`**：

```js
if(!users.length){
  h += '<div class="adm-empty">No registered customer yet</div>';
  return h;          // ← 这里没闭合最外层的 <div class="admin-sec">
}
```

后果链条：

```
第一块的 admin-sec 没闭合
   ↓
浏览器把后面的「💬 WhatsApp 登录请求」和「Customer Profit Summary」
当成第一块盒子的子节点嵌进去
   ↓
40ms 后执行 regUsersBox.innerHTML = registeredUsersInner()
   ↓
整块内容被重写 → 后两块被抹掉 ❌
```

### 修复

```js
if(!users.length){
  h += '<div class="adm-empty">No registered customer yet</div>';
  /* 必须闭合最外层 admin-sec：否则后面的 WhatsApp 请求块 / 客户利润块
     会被浏览器当成子节点嵌进这里，再被 regUsersBox.innerHTML 覆盖掉 */
  h += '</div>';
  return h;
}
```

### 顺带修的数据源错误

利润这块原来用 `getOrders()`（读**本机 localStorage**）。后台机器从没在本机下过单 → 永远是空 → 利润永远是 $0。

改成从云端拉：`DB.listAllOrders()` → 解析 D1 的 `notes` 字段 → 按归一化手机号（`normPhoneLocal`）归组 → 汇总报价/成本/利润。

现在三块都正常，实测输出：

```
Registered customers — total 6     ← 6 行
💬 WhatsApp sign-in requests       ← 1 行
Customer Profit Summary            ← 8 行（来自云端订单）
```

### ⚠️ 一个数据缺口（不是 bug，但要处理）

利润现在显示 `—`，下面带一行提示：

> ⚠️ 利润显示为「—」是因为订单里**没有成本数据**（下单时只记了报价，没记采购/运费成本）。

查到根因：`lastQuote` 这个对象**根本没有 `cost` 字段**（只有 from/to/wt/vol/pcs/ctn/unit/method/quote/date），向导流程里写的是 `quote: d.cost, cost: d.cost, profit: 0` —— 报价和成本写成同一个数，利润必然是 0。

我选择显示 `—` 而不是假的 `+$0`，避免给你看一个错的利润。**要看到真实利润，需要在下单流程或后台补录每单的实际成本。**

---

## 七、顺带修的：订单弹窗排版重叠

你截图里弹窗内容叠在订单行上，这个也是真 bug，而且很离谱：

**`.modal-card` 这个类在 CSS 里从来没定义过**（只有 `.modal` 有样式）。

结果：卡片背景透明、无定位、无阴影 → 内容直接画在底下的订单卡片上面。

已补齐：

```css
.modal-card{
  position:relative;
  background:#fff;
  color:var(--text);
  width:100%;
  padding:18px 16px;
  border-radius:18px;
  box-shadow:0 18px 50px rgba(0,0,0,.35);
  max-height:88vh;
  overflow-y:auto;
  animation:slideUp .25s;
}
[data-theme="dark"] .modal-card{background:#1E293B;color:var(--text)}
@media(min-width:720px){
  .modal-overlay.admin-modal{align-items:center}
  .modal-overlay.admin-modal .modal-card{border-radius:18px;padding:22px 20px}
}
```

外加 z-index：`modal.style.zIndex = 10001`（必须高于 `.admin-overlay` 的 9999，否则后台弹窗被面板压住）。

---

## 八、按钮文案已统一成中文 + 加了说明行

订单行现在的按钮：

```
📤 推送进度     → wa.me 预填物流进度，你点发送
✉ 重发邮件     → 全自动，Brevo 直接发
📲 要付款凭证   → wa.me 催客户去网页上传付款截图
📦 要签收单 POD → wa.me 催客户去网页上传签字送货单
🔍 看全部 N     → 直接看这单所有已上传的回执图片
```

下面固定一行说明（避免以后再混淆）：

> 📲 WhatsApp 按钮 = 打开对话并预填消息，**你点一下发送**才发出去（个人号没法全自动）。✉ 邮件是程序自动发的。

---

## 九、部署状态

| 项 | 状态 |
|---|---|
| Pages 部署 | ✅ 已上线（deployment `https://9ffa0b55.okad-africa.pages.dev`） |
| 正式域名 | ✅ https://okadafrica.com |
| 4 份前端副本 | ✅ MD5 一致 `f4be565b…` |
| 线上回归 | ✅ ALL PASS，控制台 0 错误 |
| Worker | 本轮未改动，无需重新部署 |

---

## 十、一句话总结

> **邮件全自动，WhatsApp 半自动（打开+预填，你点发送），回执图片客户在网页上传。**
> **客户不需要绑定任何账号，所有 WhatsApp 都从公司号 233505615533 出去；按钮里填的是客户号码，用来打开「我 ↔ 他」的对话。**
> **POD = 签收单（货送到客户手上、他签字的那张纸），和付款回执是两回事。**
