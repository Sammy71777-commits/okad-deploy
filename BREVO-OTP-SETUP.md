# OKAD 邮箱验证码（Brevo）上线步骤

代码已经改好了，API Key 也已经**用真实接口验证过可用**。

剩下的是**你去点鼠标的部分**，而且只剩 Cloudflare 那一处（Brevo 侧我已经替你验完了）。按顺序走完就能用，约 10 分钟。

> **现在最大的是第 2 步（可选）和"Deploy"这两件事** —— 第 1 步已经做完了。

---

## 第 1 步：~~注册 Brevo~~ ✅ 已完成（key 已实测可用）

我拿你的 key 直接打过 Brevo 官方接口，返回如下：

| 检查项 | 实测结果 |
|---|---|
| API Key 有效性 | ✅ 有效（`/v3/account` 返回 200） |
| 账号 | `sammy71777@gmail.com`（Joo Sammy / okad africa） |
| 套餐 | **Free，300 封/天**，永久免费 |
| 已验证发件人 | 只有 `sammy71777@gmail.com`（active） |
| `okad.africa` 域名 | ❌ **未验证**（所以不能当发件人，见第 2 步） |
| 实际发信测试 | ✅ 返回 201 `messageId`，**信能发出去** |

**你的 API Key（第 3.2 步直接复制这个）：**

```
<YOUR_BREVO_API_KEY>
```

> ⚠️ **安全提醒**：这串 key 相当于你 Brevo 账号的密码，能发邮件、能看账号信息。
> 它已经出现在聊天记录里了，**建议上线跑通后去 Brevo 后台重新生成一次并替换**（免费，一分钟的事）。
> 另外**绝对不要**把它写进 `index.html` 或任何前端文件 —— 前端代码用户 F12 就能看到。

---

## 第 2 步：验证发信域名（**可选，先跳过也行**）

你的 Brevo 账号里**唯一已验证的发件人是 `sammy71777@gmail.com`**。

**我已经把 Worker 的默认发件人改成它了**（`DEFAULT_MAIL_FROM`），所以你现在**什么都不用做就能发信**，先跑通链路。

等有空了再升级成品牌域名（收件箱里显示 "OKAD Africa <noreply@okad.africa>" 而不是 gmail，进垃圾箱的概率也低很多）：

1. Brevo 后台 → 账号名 → **Senders & Domains** → **Domains** → **Add a new domain**
2. 填 `okad.africa`，勾上 "Authorize this domain for email sending"
3. Brevo 会给 2–3 条 DNS 记录，加到域名 DNS 里：
   - 一条 **TXT**（SPF，值里含 `include:spf.brevo.com`）
   - 一条 **TXT**，主机名 `brevo._domainkey`（DKIM）
4. 回 Brevo 点 **Verify**，等生效（10 分钟 ~ 24 小时）
5. 生效后回 Cloudflare，把 `MAIL_FROM` 改成 `noreply@okad.africa`

> 补充一个容易踩的坑：我用未验证的 `noreply@okad.africa` 也试发过，Brevo **照样返回 201**。
> 也就是说 —— **接口不报错 ≠ 客户收到了**。未验证域名的邮件基本都进垃圾箱。
> 这就是为什么默认走已验证的 gmail，别被 201 骗了。

---

## 第 3 步：Cloudflare Worker 配置

打开 https://dash.cloudflare.com → **Workers & Pages** → 点你的 `shrill-wave-7c04` worker。

### 3.1 建 KV（存验证码用的）
1. 左上角回 **Workers & Pages** → **KV** → **Create a namespace**
2. 名字填 `otps` → 创建
3. 回到 worker → **Settings** → **Bindings** → **Add** → 选 **KV namespace**
   - Variable name：**必须填 `OTPS`**（大写）
   - KV namespace：选刚才建的 `otps`
   - Save

### 3.2 加环境变量
**Settings** → **Variables and Secrets** → **Add**：

| 变量名 | 值 | 类型 |
|---|---|---|
| `BREVO_API_KEY` | `<YOUR_BREVO_API_KEY>` | **Secret**（务必选 Secret 加密，别选 Text） |
| `MAIL_FROM` | 先**留空**（Worker 默认用已验证的 `sammy71777@gmail.com`）。等 `okad.africa` 验证通过再填 `noreply@okad.africa` | Text（可选） |

> 原来的 `RESEND_API_KEY` 可以留着，不影响。新代码已经不用它了。

### 3.3 粘贴新代码
1. 打开 `/workspace/worker-okad.js`（已经改好，**直接复制全部**）
2. worker 页面 → **Edit Code** → 全选覆盖 → **Deploy**

> 也可以打开 `/workspace/worker-lite.html` 点「📋 复制代码」，内容是一样的。
> 注意：那个文件里代码显示在 `<pre>` 中，看到 `&lt;` 是正常的，点复制按钮拿到的是正确代码。

---

## 第 4 步：验证是否通了

把下面整段复制进终端跑（一条一条来，看每条的输出）：

```bash
W=https://shrill-wave-7c04.sammy71777.workers.dev
ME=sammy71777@gmail.com

# 1) 配置有没有生效 —— 三个都要 true
curl -s $W/
# 期望: "email_configured":true, "otp_kv_bound":true, "mail_from":"sammy71777@gmail.com"
# 期望: routes 里出现 /api/send-otp 和 /api/verify-otp（出现说明新代码已部署）

# 2) 确认 Brevo key 通、发件人已验证
curl -s $W/api/brevo-health
# 期望: {"ok":true,"brevo_status":200,"senders":["sammy71777@gmail.com (active)"],...}

# 3) 发一封真邮件到你自己的邮箱
curl -s -X POST $W/api/send-otp -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"to\":\"$ME\"}"
# 期望: {"ok":true,"sent":true,"channel":"email"}
# 同时去邮箱（含垃圾箱）找 6 位数字

# 4) 用邮件里的码校验（把 123456 换成你收到的真码）
curl -s -X POST $W/api/verify-otp -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"to\":\"$ME\",\"code\":\"123456\"}"
# 期望: {"ok":true,"verified":true}

# 5) 同一个码再校验一次 → 必须失败（一次性）
# 期望: {"ok":false,"error":"Code expired or never requested"}
```

**4 和 5 全对就说明链路彻底通了**。之后记得把站点也发布一次（前端已经改成调新接口了，Worker 和站点要都上线）。

---

## 报错对照表

| 返回 | 原因 | 怎么修 |
|---|---|---|
| `KV namespace OTPS not bound` | 3.1 没做，或变量名不是 `OTPS` | 回去检查 Bindings |
| `BREVO_API_KEY not configured` | 3.2 没加 | 加 Secret 后重新 Deploy |
| `Brevo 401` | key 错了或被删了 | 重新生成 key（或确认 Secret 粘贴时没多带空格/换行） |
| `Brevo 403 ... domain not verified` | 你把 `MAIL_FROM` 填成了未验证域名 | `MAIL_FROM` 留空，用默认的 `sammy71777@gmail.com` |
| `Please wait 60s` | 同一个邮箱 60 秒内重复请求 | 等 60 秒（这是云端防刷，清浏览器缓存也没用） |
| 收到邮件但填码提示 `Wrong code` | 码过期了（5 分钟）或填错 | 重新发一次 |
| **发了但邮箱里找不到** | 用未验证域名发的，进垃圾箱了 | 去垃圾箱翻；或把 `MAIL_FROM` 留空走已验证邮箱 |
| `send-otp` 返回 404 | Worker 还是旧代码 | 3.3 没 Deploy 成功，回去重新 Deploy |
| 前端点 Send Code 报 404 | 同上 | 同上（**Worker 必须先于站点上线**） |

---

## 这次改了什么（代码侧）

### Worker（`/workspace/worker-okad.js`，291 行）
- 新增 `POST /api/send-otp`：生成 6 位码 → **存进 KV（5 分钟过期）** → 用 Brevo 发邮件
- 新增 `POST /api/verify-otp`：从 KV 取出比对，通过即删除（一次性）
- 新增 `GET /api/brevo-health`：列出 Brevo 里已验证的发件人（排错用）
- 云端 60 秒防刷（清 localStorage 也绕不过）
- **不再把验证码回给前端**（原来 `return {... code: code}` 是明文泄漏）
- 旧的 `/api/email-code` 路由保留，指向新流程（老版本前端不会报错）
- 默认发件人改成已验证的 `sammy71777@gmail.com`（`MAIL_FROM` 留空即可）

### 前端（`index.html` + 3 份副本）
- `sendCode()`：读可见输入框发真请求；**失败就明说，不再自动填 `888888`**
- `verifyOtpRemote()`：真正把码送服务端比对
- `doLogin()` 改 async：IP 已注册过的账号，必须过服务端校验才放行
- 个人中心新增「📧 Verify email」按钮 → 验证后显示「✓ Email verified」
- 三语文案修正（原来写"填了手机号走 SMS"，但 SMS 通道根本不存在）

### 顺手挖出来的真 Bug
`loginEmail` 和 `loginPhoneOpt` 是 **hidden input，全站没有任何一处往里写值**。
原来的 `sendCode()` 读的就是这两个空字段 → 永远拿到空字符串 → 直接弹 "Invalid email" 退出，
**连网络请求都没发出去过**。这才是"验证码功能不通"的第一层原因（第二层才是 Worker 500）。
已改成读取可见输入框 `loginContact`。

---

## 还没做的

- **WhatsApp OTP**：Worker 里留了 `channel: 'whatsapp'` 分支，目前返回 "not enabled yet"。等你做完 Meta 企业验证再补一个 `sendWaOtp()` 就能用，底座（KV + send/verify）已经通用了。
- **后台显示邮箱验证状态**：现在状态只存本机 localStorage（换设备要重新点一次验证）。要后台客户名单也能看到，得再存一份到云端——你的 `users` 表加不了列，得走 `orders` 表的 CFG 行方案。需要的话跟我说。
