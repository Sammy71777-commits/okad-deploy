# OKAD AFRICA — 项目交接状态（新会话读这一个文件即可接手）

## 项目
- 单页移动应用，主文件 `/workspace/index.html`（约 9500 行）。
- 副本必须同步：`site/index.html`、`okad_africa_app.html`、`deploy/index.html`（`cp` + `md5sum` 校验）。
- 后台入口：URL 加 `#admin`，密码 `okad@2026`。
- 语言：前台锁英文（`curLang='en'`，语言入口已隐藏），后台已清掉硬编码中文。

## 云端（关键约束）
- Worker：`https://shrill-wave-7c04.sammy71777.workers.dev`，路由 `/api/db/{table}`。
- **只认 4 张表**：`users`、`orders`、`kyc_logs`、`cooperation`。新建表名一律返回 `Invalid table`，改不了数据库结构。
- **老 Worker 的 GET 忽略 `id=eq.` 过滤，返回全表**！查单必须 `DB.listAllOrders()` 拉全表后本地匹配，否则会拿到第一条垃圾行并写坏数据。
- 只有 GET / POST，无 PATCH。POST 是 `INSERT OR REPLACE`（整行覆盖）。
- `/api/config` 接口不存在（返回 Not found），不要试图用。
- orders 真实列：`id,email,name,product,qty,total,status,route,method,createdTs,updatedTs,notes`；完整对象存 `notes`（JSON 字符串）。
- 通用配置可借用 orders 表写一行 `id='CFG-...'`（与业务单 `INQ-` 前缀区分）。

## 本次会话已完成的改动（都已实测）
1. **代购闭环**：客户提交 → `status='lead'` 写 D1；后台 Orders 页顶部「Assisted Purchase」看板。
   - 状态机：`ASSIST_STEPS` = lead → contacted → quoted → purchased → shipped → done。
   - 函数：`assistUnpack / assistCardHtml / updateAssistOrder / setAssistStatus / advanceAssist / saveAssistGoods / exportAssistCSV`。
   - 弹窗强制填 WhatsApp（`exaWhatsapp`，登录用户也填，`currentUser.phone` 常为空）。
2. **服务费**：`OKAD_SVC_PCT = 0.07`、`OKAD_SVC_MIN = 5`（第 2455 行 `calcSvcFee`）。后台报价可**逐单选费率 7% / 5% / 3%**（下拉 `rate_<id>`），最低 $5 仍兜底。
3. **前台积分**：Me 页新增「Assisted Done / Points」两格；`ASSIST_POINTS_PER_ORDER = 10`。积分**不落存储**，由云端 `status='done'` 的订单数实时算出（`refreshAssistStats`）。
4. Service Worker 版本已升到 `okad-v3`（`site/` 与 `deploy/`）。

## 待办：路线（价格）云端化 —— 已分析完，未动手
**问题**：后台改价格前端永远不变。根因两条：
- `savePriceTable()`（第 2414 行）只写 localStorage，从不上云；客户看到的仍是代码里的 `DEFAULT_PRICES`。
- 前端城市下拉是 HTML 硬编码（第 1333-1344 行 `<option value="Shenzhen">`），后台的 `FROM_PORTS/TO_PORTS`（第 2405 行）只被后台页面自己用。
- 兜底写死：`tbl[c.route] || tbl['Shenzhen-Tema']`（第 4231 行）；首页示例第 1679 行。

**方案（已与用户确认方向）**：
- 数据结构：路线数组，每条 `{id, from, to, on, seaRate, seaCost, seaTonRate, airRate, airCost, fclRate, fclCost, seaDays, airDays}`，`on` = 开工键（关了前端下拉里消失）。
- 起点/终点在后台自由填写（不再固定 5 个城市），每条路线独立价格。
- 存储：orders 表写一行 `id='CFG-PRICES'`，整份配置放 `notes`。前端启动时拉云端覆盖本地。
- 后台价格页重写成「路线列表」：新增 / 编辑 / 开关 / 删除。
- 前端 `#cmpFrom`、`#cmpTo` 两个下拉改为动态生成，只列已开通路线涉及的城市。
- 现有 25 条路线全部迁移进新结构，**默认只开通 3 条**（建议 Shenzhen→Tema、Shenzhen→Lagos、Shenzhen→Mombasa），其余 `on=false` 保留价格待开。

## 踩过的坑（务必避免）
- **不要用 `String.replace(a,b)` 改这个文件**：源码里到处是 `$'`（如 `'$' + x`），会被当成"匹配后缀"展开，把文件撑到 26000 行。一律用 `s.split(a).join(b)`。
- 改完必须同步 4 个副本并 `md5sum` 校验。
- 验证：本地 `python3 -m http.server 8899` + python playwright（已装）；后台 `pg.fill('#adminPwInput','okad@2026')` + `tryAdminLogin()`。
- 语法检查：提取 `<script>` 块用 `new Function()` 校验（第 1 块是 JSON-LD，报错属正常）。

## 还没做
- 线上未重新发布（用户看到的仍是旧版）。

---

# 第二轮改动（KYC 同步 + 后台数据面板）

## 1. 修复：个人页一直显示 pending（根因有三个）
| # | 问题 | 原因 | 修法 |
|---|---|---|---|
| 1 | 客户手机上的「个人页」永远 pending | Me 页只读本机 localStorage 的 `currentUser.kycStatus`，**全站没有任何一处把云端 KYC 拉回客户端** | 新增 `syncMyKycFromCloud(force)`：按 email/phone 匹配云端 users 表，命中就更新 `currentUser` + localStorage 并重绘徽章；`renderMeSection()` 每次渲染都会调（20s 节流） |
| 2 | 客户重新登录会把后台的 approved 冲回 pending | `doLogin()` 里 `upsertUser` 无脑写本地 `kycStatus`（老用户本地还是 pending） | 登录时先 `syncMyKycFromCloud(true)`，再把**云端真实状态**回写云端 |
| 3 | 后台"云端优先"合并会把后台自己审过的状态改回 pending | 同上，云端被覆盖后 admin 合并时以云端为准 → 状态回退 | 修 1、2 后云端始终正确，合并即正确 |

另外把 `DB.updateKyc(...).catch(function(){})` 这种静默吞错改成 `pushKycCloud()`：成功弹「☁️ Synced to cloud」，失败弹「⚠️ Local saved, cloud push failed」，不再假装成功。

实测通过（浏览器 + 云端核对）：
- 全新浏览器 → 后台 KYC 页点 Approve → 云端 `e2ecustomer@example.com` 变 `approved`
- 另一台"设备"（本地 pending）打开个人页 → 自动变「✓ Identity verified」，localStorage 同步为 approved

## 2. 新增：后台数据面板
- **Tab 徽章**：Orders / Clients / Leads / KYC 四个 Tab 右上角红色数字角标，0 时自动隐藏。
- **概览条**（Tab 栏正下方）：USERS(注册用户总量) / KYC WAIT(待审) / OPEN ORDERS / LEADS / ASSIST OPEN(云端代购未完成数)。
- **自动提醒**：后台打开时每 25s 轮询，某个数字变大会弹 toast「🔔 New customer registered (+1)」这类提示。
- **注册客户名单 1..N**：Clients 页新增「Registered customers — total N」，按注册先后编号 1,2,3…，每行显示 姓名+国旗 / KYC 状态 / 手机 / 邮箱 / 订单数 / 注册日期。

## 3. 关键修正：后台原本只看本机数据
后台所有名单都来自 localStorage，客户在各自手机注册 → 后台在别的设备上什么都看不到。
新增 `ADMIN_CLOUD_USERS` 缓存 + `adminAllUsers()`（本机 + 云端按 email/phone 去重合并）+ `loadCloudUsersThen(cb)`。
`adminCounts()` / `renderRegisteredUsers()` / `kycApprove()` / `kycReject()` 全部改用合并后的名单。

实测：空浏览器打开后台 → USERS 8 / KYC WAIT 5 / ASSIST OPEN 2，客户名单编号 1..8 正常显示。

## 4. 坑
- 后台角标一开始用 `el.style.display = ''`，但 CSS 类里写的是 `display:none`，结果永远隐藏。显示要用 `el.style.display = 'block'`。
- **个人页 KYC 徽章是"绿底绿字"根本看不见**：`.me-verified` 的 CSS 写死 `color:var(--green)`，而 JS 又把 `style.background` 改成同色 `#10B981`，于是文字和背景同色。
  修法：styles 表里每项补 `fg:'#fff'`，并加 `kycEl.style.color = m.fg;`。（注意 `m.fg` 原来根本没定义，写了等于没写，要先补 fg 字段。）
  这个 bug 与"数据回调慢"无关，但它让用户根本判断不出状态，必须一起修。
- 再次踩到 `s.replace(a,b)` 的 `$'` 展开坑 —— 本文件所有替换一律用 `new.join(s.split(old))`。

---

# 第三轮排查：邮箱验证码功能（未改动代码，仅结论）

## 1. 个人中心里根本没有这个功能
`renderMeSection()` 只渲染：头像 / 打码邮箱（`maskEmail`，`📧 s***y@gmail.com`）/ 国家 / ID 类型 / 注册日期 / KYC 徽章 / 数据总览 / 推荐等级 / 券 / 订单历史。
**没有**「验证邮箱」按钮、**没有**邮箱验证状态字段、**没有**改邮箱入口。
全站唯一的验证码输入框在登录/注册弹窗（`loginCode` + "Send Code"，`sendCode()` 第 6039 行）。

## 2. 发码链路实测：断的
| 环节 | 实测 |
|---|---|
| `GET /`（Worker 根） | 200，routes 含 `/api/email-code`，`email_configured: true` |
| `POST /api/email-code`（带 email） | **HTTP 500 `error code: 1101`**（Worker 未捕获异常） |
| `POST /api/sms-code` | **404 Not found** —— Worker 根本没有这个路由 |
| 前端反应 | `res.ok=false` → 自动填 `888888` + toast「🟡 DEMO mode: 888888」 |

→ 真实邮件**一封都发不出去**，用户永远只看到 DEMO 提示。

## 3. Worker 源码三个硬伤（`/workspace/worker-lite.html` 第 126 行 `handleEmailCode`）
1. `from: 'OKAD Africa &lt;noreply@okad.africa&gt;'` —— 尖括号被 HTML 实体转义，发信人是**非法地址**；且 `okad.africa` 大概率未在 Resend 完成域名验证 → Resend 直接拒绝。
2. `return json({ ok:true, sent:true, code: code })` —— **把验证码明文回给前端**，F12 看网络响应即可拿到。
3. **服务端不保存 code，也没有任何比对接口** → 即便能发信也无从校验。
4. 没有全局 try/catch，异常直接冒泡成 Cloudflare 1101。

## 4. 前端校验是假的（最严重）
`doLogin()` 第 6208 行：
```js
if(!code || (code !== '888888' && !/^\d{6}$/.test(code))){
```
只判断「是不是 6 位数字」，**不与任何真实验证码比对** —— 填 `123456`、`000000` 都能过。
且该校验**只在「该 IP 已注册过」时触发**，新 IP 走 `code = code || '888888'` 免验证放行。
60 秒防刷只写 localStorage，清缓存即绕过。

## 5. 云端存储限制（若要新增「邮箱已验证」状态）
- `users` 表**不能加列**：POST 带 `emailVerified` → `D1_ERROR: table users has no column named emailVerified`。
  注意：前端 `_postUsersAdaptive()` 会自动删掉未知列重试，所以「不报错」但**实际被静默丢弃**。
- `kyc_logs` 的 `id` 是 INTEGER 自增，写字符串 id → `datatype mismatch`，**不能当 KV 用**。
- 唯一可用：沿用 `orders` 表的 CFG 行套路（上轮 `CFG-PRICES` 已验证可行），可存 `EV-<email>`。

## 6. 三个可选方案（待用户定，未动手）
| 方案 | 内容 | 前提 |
|---|---|---|
| A 真闭环 | 改 Worker：存 code + 加 `/api/verify-code` + 修 from 域名；前端个人中心加「验证邮箱」按钮与状态徽章 | 需要能改 Cloudflare Worker 并在 Resend 验证发信域名 |
| B 只做状态展示 | 用 CFG 行存验证状态，个人中心 + 后台 Clients 名单显示「邮箱已验证 ✓」；发信仍走 DEMO | 只改前端 |
| C 关闭入口 | 去掉 Send Code 按钮与 DEMO 提示，避免误导用户 | 只改前端，最省事 |

---

# 第四轮：Brevo 邮箱验证码（已改代码，等你配置密钥后上线）

## 新增文件
- `/workspace/worker-okad.js` —— **可直接粘贴到 Cloudflare 的纯 JS**（265 行，含新增 OTP 接口）
- `/workspace/worker-lite.html` —— 展示页同步更新（pre 内是 HTML 转义写法，点「复制代码」拿到的是正确 JS）
- `/workspace/BREVO-OTP-SETUP.md` —— 上线操作手册（Brevo 注册 / 域名验证 / KV 绑定 / curl 自检 / 报错对照表）

## Worker 改动
| 项 | 内容 |
|---|---|
| 新接口 | `POST /api/send-otp` {channel,to} → 生成码 → **存 KV（TTL 300s）** → Brevo 投递 |
| 新接口 | `POST /api/verify-otp` {channel,to,code} → 比对 KV，通过即 `delete`（一次性） |
| 兼容 | 旧 `/api/email-code` 路由保留，转发到 `handleSendOtp` |
| 安全修复 | **不再 `return {code}`**（原来是明文把验证码回给前端） |
| 防刷 | 云端 60s cooldown（`cd:` 前缀），清 localStorage 也绕不过 |
| 需要的绑定 | KV namespace 变量名 **`OTPS`**；环境变量 `BREVO_API_KEY`（Secret）、`MAIL_FROM`（可选，默认 `noreply@okad.africa`） |
| 自检 | 根路由新增 `otp_kv_bound`；`email_configured` 改判 `BREVO_API_KEY` |

## 前端改动
| 位置 | 改动 |
|---|---|
| `sendCode()` | 整体重写：读可见输入框 → 真发请求；**失败明说，不再兜底填 888888**；成功清空并聚焦输入框 |
| 新增 `verifyOtpRemote(to,code)` | 把码送服务端比对，返回 true/false，错误 toast 用服务端返回的 error |
| 新增 `startEmailVerify()` / `submitEmailVerify()` / `isEmailVerified()` / `markEmailVerified()` / `evKey()` | 个人中心邮箱验证闭环，状态存 `localStorage['okad_ev_<email>']` |
| `doLogin()` | 改成 `async`；IP 已注册过的账号改为**真校验**，不通过不放行；新 IP 仍免验证（保留原策略）。手机号登录暂不校验（SMS/WhatsApp 通道未开） |
| `renderMeSection()` | 新增 `meEmailVerify` 区块：未验证显示「📧 Verify email」按钮，已验证显示「✓ Email verified」 |
| i18n | 三语 `modal_phone_hint` 去掉"填了走 SMS"的误导文案（SMS 通道根本不存在） |

## ⚠️ 本轮挖出的真 Bug（验证码之所以"完全不通"的第一层原因）
`loginEmail` 和 `loginPhoneOpt` 两个 input 是 **`type="hidden"` 且全站没有任何 JS 往里写值**。
原 `sendCode()` 读的正是这两个字段 → 永远拿到空字符串 → `validateEmail('')` 失败 → 直接 toast「Invalid email」退出，
**连一个网络请求都没发出去过**。
修法：改读可见输入框 `#loginContact`（`doLogin()` 一直读的就是它）。

> 修正上一轮的误判：`worker-lite.html` 里 `from: 'OKAD Africa &lt;noreply@okad.africa&gt;'`
> 的 `&lt;` 不是 bug —— 那段 JS 放在 `<pre>` 里，必须 HTML 转义，点复制按钮拿到的 `<>` 是正常的。
> 真正导致 `/api/email-code` 返回 Cloudflare 1101 的原因未在线上定位（疑为 Resend 域名未验证 + 无全局 try/catch），
> 现已整体换成 Brevo + 全局每层 try/catch，不再依赖 Resend。

## 实测（Worker 未部署，用 playwright 拦截 mock `/api/send-otp` `/api/verify-otp`）
| 用例 | 结果 |
|---|---|
| 个人中心初始 | `📧 Verify email` 按钮出现 |
| 点按钮 | 发出 `{channel:'email', to:'brevo@okad.dev'}`，展开 6 位码输入框，提示 "Code sent to …" |
| 填错码 `999999` | 提示 Wrong code，状态回到按钮，**未打勾** |
| 填对码 `123456` | 变 `✓ Email verified` |
| 刷新页面 | 状态保持（localStorage `okad_ev_brevo@okad.dev`） |
| 填手机号发码 | 被拦截，提示走邮箱（不发请求） |
| 服务端返回 502 | 输入框保持空，**不再是 888888** |
| JS 报错 | 0 |

## 待办
- 用户去 Brevo 注册 + 验证域名 + Cloudflare 绑 KV 和 Secret + Deploy（见 BREVO-OTP-SETUP.md）
- WhatsApp OTP：Worker 已留 `channel:'whatsapp'` 分支，补一个 `sendWaOtp()` 即可，底座通用
- 邮箱验证状态目前只在本机 localStorage；若要在后台客户名单显示，需走 `orders` 表 CFG 行方案（users 表加不了列）

---

# 第五轮：Brevo API Key 已提供并实测（代码已就绪，待用户 Deploy）

## 1. Key 实测结果（直接打 Brevo 官方接口，不是猜的）
| 检查项 | 结果 |
|---|---|
| `GET /v3/account` | 200，key 有效 |
| 账号 | `sammy71777@gmail.com`（Joo Sammy / okad africa） |
| 套餐 | Free，**300 封/天** |
| `GET /v3/senders` | 已验证发件人**只有** `sammy71777@gmail.com`（active） |
| `okad.africa` 域名 | **未验证** |
| 用 `noreply@okad.africa` 试发 | 201（Brevo 照样接单！但会进垃圾箱） |
| 用 `sammy71777@gmail.com` 试发 | 201，正常 |

> **重要认知修正**：Brevo 对未验证域名也返回 201。
> **接口不报错 ≠ 客户能收到**。所以默认发件人必须用已验证邮箱。

## 2. Worker 改动（本轮）
- 新增常量 `DEFAULT_MAIL_FROM = 'sammy71777@gmail.com'`，`sender.email` 改用它（原来写死 `noreply@okad.africa`）
- 新增 `GET /api/brevo-health` → 返回 Brevo 已验证发件人列表 + 当前发件人，排错用
- 根路由新增 `mail_from` 字段
- `handleSendOtp` 增加**前置检查**：`channel==='email' && !env.BREVO_API_KEY` 时返回 503 `BREVO_API_KEY not configured`
  （原来放在 60s 防刷之后，导致没配 key 时只看到 429，排错时被误导）

## 3. 本地全链路实测（用真实 key + 模拟 KV，Node 直接 import worker-okad.js）
| 用例 | 结果 |
|---|---|
| 根路由 | `email_configured:true, otp_kv_bound:true, mail_from:sammy71777@gmail.com` ✓ |
| `/api/brevo-health` | `senders:["sammy71777@gmail.com (active)"]` ✓ |
| `send-otp` | 200 `{"ok":true,"sent":true}`，**真实发信成功**，KV 存了码，响应里无 code ✓ |
| 60s 内重复发 | 429 `Please wait 60s` ✓ |
| 填错码 | `Wrong code` ✓ |
| 填对码 | `{"ok":true,"verified":true}` ✓ |
| 同码二次用 | `Code expired or never requested`（一次性）✓ |
| 缺 key | 503 `BREVO_API_KEY not configured` ✓ |
| 缺 KV | 503 `KV namespace OTPS not bound` ✓ |

> 测试期间真的发了 3 封邮件到 sammy71777@gmail.com（码 495368 / 371632 等），可去收件箱验证。

## 4. 文档更新
`BREVO-OTP-SETUP.md` 已重写第 1、2 步（标记已完成 + 填好 key + 域名验证改为可选），
验证命令改成可直接复制的整段（含 `W=` / `ME=` 变量），报错对照表补 3 条。

## 5. 剩余待办（用户侧）
1. Cloudflare：建 KV（变量名 `OTPS`）+ 加 Secret `BREVO_API_KEY` + 粘贴 `worker-okad.js` + **Deploy**
2. 跑 `BREVO-OTP-SETUP.md` 第 4 步的 5 条 curl
3. **发布站点**（顺序：Worker 先，站点后）
4. 安全：key 已暴露在聊天里，跑通后建议去 Brevo 重新生成替换

## 6. 线上现状（截至本轮）
`https://shrill-wave-7c04.sammy71777.workers.dev/` 返回的 routes **仍是旧的**
（只有 `/api/muse`, `/api/email-code`, `/api/exchange-rates`, `/api/db/{table}`）—— **还没 Deploy**。
### 7. 本轮又挖出一个「上线即废」的 Bug（`getAIConfig`）
```js
c.workerUrl = raw.workerUrl || '';   // 原写法
```
`getAIConfig()` 里默认值是 `https://shrill-wave-7c04.sammy71777.workers.dev`，但只要 localStorage 存在
`okad_ai_config`（用户进后台保存过 AI 配置，哪怕只改了 mockMode），`raw.workerUrl` 为 undefined →
**默认值被清空** → `sendCode/verifyOtpRemote/startEmailVerify` 三处都走 `if(!workerUrl) toast('❌ No server configured')`。
即：**用户一旦在后台存过 AI 配置，邮箱验证码就彻底不能用**，且报错信息完全指不到真因。
修法：`c.workerUrl = raw.workerUrl || c.workerUrl;`（保留默认兜底）
实测：写入 `okad_ai_config={mockMode:true}` 后 `getAIConfig().workerUrl` 仍返回正确地址，发码请求正常发出。

---

# 2026-11-05 后台"颜色/分辨率"修复 + QQ 账户登录修复

## 1. 后台数据看不清（用户截图两处）
实测（Chromium 1440×900，`okadafrica.com/#admin`）定位到三个根因，**都不是猜测**：

| 现象 | 根因 | 修法 |
|---|---|---|
| 客户详情弹窗"完全看不见数据" | `.modal` 背景是 `#fff` 白底，但 `.cli-detail-row .val` 用的是深色主题的白字 `#fff` → **白底白字** | 弹窗作用域内改白底深字（`#0B1F3A`） |
| 标签/小标题太淡 | `.lbl` 是 `#6B7280`（白底对比度 ≈2.6:1） | 标签 `#475569`、小标题 `#334155`、行底 `#F7F8FA` + 边框 |
| 后台在电脑上只有窄窄一条 | `.admin-overlay` 继承 `body` 的 `max-width:var(--max)` = **480px**，报表表格被压到 448px | `@media(min-width:900px)` 单独放宽到 `min(1180px,96vw)`，前台 body 宽度不动 |

**附带发现（重要）**：页面从头到尾**从未设置 `data-theme` 属性**（实测 `htmlThemeAttr=null`），
所以原有那批 `[data-theme="light"]` 覆盖规则**一条都没生效**，`[data-theme="dark"]` 同理。
本次修复不再依赖 `data-theme`，直接给实测可读色值。

**附带修掉的 bug**：`.modal` 没有 `position:relative`，`.modal-close`(×) 的 absolute 定位参照的是
全屏 fixed overlay → **关闭按钮跑到屏幕右上角**。给后台弹窗补 `position:relative` 归位。

## 2. 改动文件
- `deploy/index.html`（主改）→ 同步到 `index.html` / `site/index.html`（三份 md5 一致 `bf2c3116`）
- `deploy/service-worker.js` + `site/service-worker.js`：`CACHE_VERSION` `okad-v24` → **`okad-v25`**
- 已部署 Pages：https://b14bb97f.okad-africa.pages.dev （2 文件更新：index.html + service-worker.js）

## 3. 线上验证（2026-11-05）
```
LIVE: adminW=1180  modalW=920  modalBg=rgb(255,255,255)
      val=rgb(11,31,58)  lbl=rgb(71,85,105)  gridCols=212.5px×4
```
手机端（390×844）实测 `bodyW=390`、无横向溢出、底部 `.tabbar` 390px —— **前台零影响**。

## 4. QQ 账户 `2271539398@qq.com` 登录修复
- D1 里**原本没有这个用户**（`/api/users/detail` → `User not found`）→ 已补建用户行
- 登录 1101 的真因：**Workers KV 免费版日写入 1000 次配额耗尽**（code `10048`），
  未捕获的 `env.OTPS.put` → Worker 异常 1101，登录/验证码/证件照/搜索缓存全部连坐
- 修法：加 `kvPut()` / `kvDel()` 包装，**写失败只记日志不打断业务**；
  `rateAllow()` 改为内存优先、KV 最多每分钟写一次；OTP/证件照写失败返回明确 503
- 现在：`{"ok":true,"token":...}` 登录正常；错密码正常返回 `Wrong password, triesLeft:9`（不再 1101）

## 5. 仍然存在的限制（需用户决策）
1. **KV 日写入配额今天已耗尽** → `/api/send-otp` 仍返回
   `Verification storage is busy`，**新用户注册仍会卡在验证码这一步**。
   根治二选一：① KV 升级付费版；② **改用 D1 存 OTP**（D1 无日写上限，推荐）。
2. 预览域 `https://a830e4ff7cb85da66.sg.agentos-app.run` 仍被 Origin 白名单 403，
   要用它看真实后台数据需把该域加进 `ALLOWED_ORIGIN_RE` 并重部署 Worker。
3. 该 QQ 用户行是**手工补建的最小数据**：`phone`/`id` 为空、`hasIdPhoto:false`，
   所以个人中心的订单/余额/优惠券会是空的（按 phone 索引）。建议让客户重新走完整注册流程补齐。

---

# 2026-11-05 个人中心「退出登录」入口（名字下方）

## 用户需求
截图反馈：个人中心（My Profile）只有名字，没有明显的退出入口；
底部「设置」卡片里的 Log out 要滚动很久才看得到。要求**名字下面直接有退出**，
点完**回到登录页面**。

## 实现
1. **新增 `.me-logout-btn` 胶囊按钮**，插在 `.me-name` 正下方（与名字同一个 `.me-info` 容器）：
   - 浅红底 `rgba(239,68,68,.07)` + 红描边 `rgba(239,68,68,.38)` + 红字 `#DC2626`
   - 亮色/暗色主题下都实测可读（暗色卡片底 `rgb(30,41,59)`）
   - 文案走 i18n `me_logout`（en/zh/fr 已有，无需新增词条）
2. **新增 `logoutAndGoLogin()`**：
   - 复用 `logout()` 清登录态（`okad_user` / `okad_last_login_email` / 免密窗口 / 服务端会话）
   - `switchTab('me')` → Me 页切到**未登录态**（Sign in to view your profile + Log In / Register）
   - 延迟 260ms 调 `openLoginModal()` → 直接弹出「Welcome Back」登录框
   - ⚠️ 关键点：`logout()` 已清掉 `okad_last_login_email`，所以 `openLoginModal()` 里
     触发的 `maybeSilentLogin()` 拿不到邮箱 → **不会被静默登回**（已实测确认）
3. **底部设置里的旧 Log out 按钮**也改调 `logoutAndGoLogin()`，两处行为一致
4. **连带修掉头像错位**：卡片内容变高后 `.me-profile{align-items:center}` 让 54px 头像
   掉到中间、与名字错位 → 改 `flex-start` + 头像 `margin-top:2px`，实测头像/名字顶部差 2px

## 实测（Chromium 430×900 移动视口，注入 sammy joo 登录态）
```
ALIGN:  avatarTop=339  nameTop=337  avatarAlignDelta=2
        btnTop=369  nameBottom=363  btnBelowName=true
DARK:   btnColor=rgb(220,38,38)  btnBg=rgba(239,68,68,.07)
        themeAttr=dark  cardBg=rgb(30,41,59)   ← 暗色下可读
AFTER:  loginModal=true  user=null  localStorage.okad_user=null  ← 退出并回到登录页
```

## 文件
- `deploy/index.html` → 同步 `index.html` / `site/index.html`（三份 md5 一致 `77235dbcf4d5`）
- `deploy/service-worker.js` + `site/service-worker.js`：`okad-v25` → **`okad-v26`**

---

# 2026-11-05 KV 10048 配额 + 验证码 15 分钟硬冷却

## 用户需求
> `10048` free usage limit / 「怎么可能用了 1000 次，这个是短信吗」「你要做限制啊，
> 要有时间限制前端，20 分钟内有效，不要一直发啊」

澄清后确认：**OTP 保持 15 分钟有效（`OTP_TTL=900`），前端/后端都只冷却 15 分钟，
发一次，15 分钟内按钮锁死、后端也不接受第二次**（用户明确否掉了更短的 60 秒冷却）。

## 根因（不是短信）
- `10048` = **Workers KV 免费版每天 1000 次写入/删除**打满，**不是短信、不是 Brevo 邮件额度**。
  项目根本没有短信通道（WhatsApp 通道返回 `not enabled yet`），验证码走 **Brevo 邮件**。
- 「1000 次」不是 1000 个客户、也不是 1000 封邮件，是 **1000 次 KV put/delete 操作**。
  读不计费；短 TTL 临时键写满 1000 次后 KV 里只剩 9 个存活 key（实测 `auth 5 / kyc 3 / otp 1`）。
- 高频写入点盘点（改前 27 处 put/delete）：限流器每请求写、搜索结果缓存每次写、
  SERP 熔断标记、静默登录刷新每次页面加载写、OTP 发送连写 4 个键、密码登录/登出/KYC 照片/
  WhatsApp 登录令牌等。**大头是高频临时键，不是验证码本身**。
- 原冷却只有 60 秒而有效期 15 分钟 + 前端「没收到？重新发送」会带 `force=true`
  绕过冷却作废旧码重发 → 一个窗口可发多封，同时每次都烧 KV 写入。
- 未捕获的 `put` 异常曾让 `/api/auth/*` 直接崩成 Worker `1101`。

## 本轮改动

### 前端 `deploy/index.html`（+ 同步 `index.html` / `site/index.html`）
- `CODE_COUNTDOWN_SEC: 60 → 900`；`_cdText(left)` 输出 `mm:ss`；
  按钮文案 `T('btn_code_sent', {left})` 三语言（en/zh/fr）显示「已发送 · 剩余 · 15 分钟内有效」。
- 时间戳 key `okad_sendcode_ts_email_<email>` 跨刷新恢复倒计时；
  `sendCode()` / `startEmailVerify()` 共用同一 key，冷却期内连请求都不发。
- 请求体改为 `{channel:'email', to}` 且**不再带 `force`**；`force` 后端彻底废弃。
- **新增**：后端返回 `429` / `alreadySent`（换设备、清缓存场景）时，前端同样锁死按钮，
  与 `startEmailVerify()` 行为一致，不再只弹一个错误让用户反复点。

### 后端 `worker-okad.js`
- `OTP_COOLDOWN: 60 → 900`，`_otpSentMem` isolate 内存兜底；`cd:` 键存**时间戳**而非 `1`，
  可返回精确 `expiresIn` / `retryAfter`。冷却期内：旧码还在 → `alreadySent`，
  已被校验消耗 → `429`。`OTP_DAILY_MAX=5` 保留防慢速刷。
- **削减高频 KV 写入**：
  - `rateAllow()` 改纯内存 Map，零 KV 写；
  - `cacheSearchResult()` 只写内存，读侧仍兼容旧 KV 缓存；
  - `markSerpBlocked()` 熔断标记只放内存；
  - `/api/auth/refresh` 持久化节流到 5 分钟一次；
  - 删掉每小时 `mailHourKey` 写入；KYC 删除改走受保护的 `kvDel()`；
  - 一次发码从 4 个键降到 3 个（`otp` / `cd` / `otpday`）。
- **关键顺序修正**：原来是「先发 Brevo 邮件 → 再写 KV」，配额满时邮件已发出但码存不进去，
  客户反复点就反复收**无效码**。改成 **先 `kvPut(otpKey)`，写失败直接 503、一封邮件都不发**。
  实测配额满时连点 3 次全是 503、KV 存活 key 数不变（9 个）、零邮件副作用。
- **完整事务回滚**：Brevo 投递失败时同时删 `otp:` / `cd:` / `otpday:` 三个键 + 清内存占位，
  否则残留 `cd:` 会把客人误锁 15 分钟、日上限白扣一次（本地集成测试抓到并修掉）。
- `kvPut()` / `kvDel()` 继续兜住 `10048`，关键路径返回明确 503，Worker 不再 `1101`。

## 部署
| 项 | 版本 / 地址 |
|---|---|
| Worker | `14335c2f-832a-48aa-b78e-f912ef983f88`（`shrill-wave-7c04`） |
| Pages | `https://241de1c6.okad-africa.pages.dev`，主域 `https://okadafrica.com` |
| 三份 HTML | md5 一致 `e9d61b08253382d933b2048d19e49f38` |
| SW | `okad-v26` → **`okad-v28`**（`deploy/` + `site/`） |

## 验证
- **线上资源**：HTML `CODE_COUNTDOWN_SEC = 900`、SW `okad-v28`、
  `429` 锁按钮补丁均已生效。
- **线上前端**（Chromium 430×900 移动视口）：
  `LOCKED_BTN {"text":"✅ Sent · 12:00 · valid 15 min","disabled":true,"cooling":true}`、
  冷却期重复点击 `REPEAT_REQUESTS: []`、到期恢复 `Send Code`、
  后端 `429` 时 `ON_429 {"text":"✅ Sent · 14:00","disabled":true,"cooling":true}`、
  三语文案 en/zh/fr 全部正确。
- **Worker 本地集成测试**（原样 import 线上 Worker，mock KV + mock Brevo）：
  **19 通过 / 0 失败** —— 覆盖发一次、force 后门被挡、只发 1 封邮件、只写 3 个键、
  15 分钟窗口结束可重发、配额满零邮件零写入、Brevo 失败可重试。
  脚本：`verify_otp_local.mjs`、`verify_cooldown_live.py`（artifact 目录）。
- **线上冒烟**：`/api/send-otp` 返回
  `{"ok":false,"error":"Verification storage is busy. Please try again in a minute."}` `503`，
  结构化 JSON，Worker 未崩。

## ⚠️ 仍需注意
1. **今天的 KV 写入配额已经打满，改动只防复发、不能退回今天的额度**。
   实测时 UTC `2026-11-05 11:15`，配额按 UTC 日重置 → 约 **12 小时 45 分钟后（UTC 00:00）自动恢复**。
   在此之前验证码发不出去，但**不会再发任何无效邮件**（这正是本次顺序修正的价值）。
   若想今天就恢复，只能：把 OTP 存储迁到 D1（D1 写入不计入 KV 1000/天）、或升级 KV 付费。
2. KV 配额打满时 `cd:` 键也写不进去，跨边缘节点的硬冷却只能等额度恢复后由 KV 保证；
   `_otpSentMem` 仅同 isolate 有效（实测 Cloudflare 多 isolate 不共享）。
   但此时**根本不发信**，所以不存在重复发邮件的问题。
3. 预览域 `a830e4ff7cb85da66.sg.agentos-app.run` 仍被 Origin 白名单 403，未改动。

---

## 📦 热门航线：后台改了前台不显示 + 自动轮播

### 根因（4 个问题叠加，缺一都不会出现）
1. **Worker Origin 白名单把自家域挡在门外** —— `okad-africa.pages.dev` 和平台预览域
   `*.sg.agentos-app.run` 被判 `403 Forbidden origin`，从这两个域名进后台时所有写操作都被拒。
   已把 `okad-africa.pages.dev` / 部署子域 / 平台预览域加入白名单，第三方域仍然 403。
2. **前台拉配置是扫全表** —— `pullRoutesCloud()` 走 `listAllOrders()`，即
   `order=created_at.desc&limit=500`，而 `orders` 表列名其实是 `createdTs`，排序必然失败 →
   Worker 降级成无序取前 500 行。订单一多，`CFG-PRICES` 配置行就被挤出这 500 行，
   前台永远拿不到后台刚改的路线，只显示本地旧缓存。改成直接
   `GET /api/db/orders?id=eq.CFG-PRICES&limit=1`。
3. **后台保存是「静默失败」** —— `pushRoutesCloud()` 只 `return true/false`，调用方既不 `await`
   也不看结果，界面照样弹 "✓ Saved"。这就是"后台明明改了、前台就是没有"的直接原因。
   现在返回 `{ok, msg}`，并在推送后用 `verifyRoutesCloud()` 回读云端比对 OPEN 线路列表，
   失败就把 Worker 的真实错误原文弹出来，不再假装成功。
4. **删除路线不同步云端** —— `deleteRoute()` 只存本地，云端还留着旧的那条，已一并同步。

### 新增：前台自动轮播
- 每 **3.2 秒**自动推进一张卡片，走到末尾回到第一张，循环播放；
- 鼠标悬停 / 手指滑动 / 滚轮时**暂停**，不打断客户手动查看；
- 桌面端左右箭头 + 底部圆点，圆点与当前最靠左的卡片同步高亮；
- 隐藏滚动条，保留触摸惯性滑动；
- **末尾留白 `routesFitTail()`**：可视宽度不足以让最后一张左对齐时补一段自适应留白。
  没有它自动轮播会**卡在末尾回不去**（实测卡在 dot=4，圆点既到不了 5、也回不到 0）；
- **`scroll-padding-left/right: 20px`**：修正 `scroll-snap` 把首卡对齐到 padding 边距、
  导致第一张左侧被裁 20px（`Sea` 显示成 `€ea`）的问题；
- 页面隐藏（切到后台标签）时暂停计时，不浪费 CPU。

### 部署
| 项 | 值 |
|---|---|
| Worker | `79eeabc8-7ea8-47cc-bd08-8e0efc5c57d8`（Origin 白名单放宽，未改其它逻辑） |
| Pages | `https://07d66260.okad-africa.pages.dev`，主域 `https://okadafrica.com` |
| 三份 HTML | md5 一致 `38a7c8704b8a4d61481e9ce87ab0c11d` |
| SW | `okad-v28` → **`okad-v31`**（`deploy/` + `site/`） |

### 验证
- **线上**：主域 + Pages 预览均为 6 张卡片、含 `Guangzhou → Tema $105/CBM`、
  `verifyRoutesCloud` 返回 ok、无控制台报错；OTP 冷却仍是 `CODE_COUNTDOWN_SEC = 900`。
- **自动轮播**：dot 序列 `0→1→2→3→4→5→0→1→2` 完整循环；悬停暂停 PASS；箭头切换 PASS。
- **端到端**：后台真实切换 `Shenzhen-Alexandria` → toast `✓ Route open — now visible to customers`
  → 云端 7 条 → 前台刷新卡片 6→7 且显示该线路 → 还原后云端 6 条、前台 6 张（**全 PASS，状态已复位**）。
- **来源白名单**：主域 / `okad-africa.pages.dev` / 预览域均 `200`，第三方 `evil.example.com` 仍 `403`。
- **数据清理**：诊断期写入的假价格 `Guangzhou-Tema.seaRate 777` **已还原为 105**；
  诊断行 `DIAG-WRITE-TEST` / `DIAG-ORIGIN-TEST` 已删除。

### ⚠️ 仍需注意
1. **前台只在页面加载时拉一次云端配置**。后台改完线路，客户需要刷新页面才会看到新线路
   （本页刻意不做轮询，避免和"后台正在编辑但还没点 Save"的本地状态互相覆盖）。
2. `Guangzhou-Tema` 已按你的要求保持 **开启**，其 `seaRate` 已还原为原值 **$105/CBM**。
   如果你后台原本改的是别的价格，请在后台重新填一次并点 Save。
3. 上一次会话遗留的 KV 配额问题依旧：今天的 KV 写入额度已打满，
   验证码发不出去（配额按 UTC 日重置），详见下一节。

---

## 2026-11-05 · 认证存储迁移到 D1（KV 配额打满的根治方案）

### 背景
Cloudflare Workers KV 免费版**每天只有 1000 次写入**（账户级，UTC 0 点重置）。
2026-11-05 上午该额度被打满（错误码 `10048`），连锁后果：

| 键 | 用途 | 配额满时的后果 |
|---|---|---|
| `otp:` | 验证码 | 写失败 → `/api/send-otp` 直接 503，客户完全无法注册 |
| `cd:` / `otpday:` | 15 分钟冷却 / 每日 5 封 | 写失败被吞 → 冷却形同虚设 |
| `otp:` 删除 | 验证后「用完即焚」 | 删失败被吞 → 同一个码 15 分钟内可重复使用 |
| `auth:` | 免密会话 | 登录返回成功但刷新即掉线；退出删不掉 → 点「退出」仍在登录态 |
| `pwfail:` | 密码错误计数 | 写失败被吞 → 暴力破解不受限 |
| `walogin:` | WhatsApp 一次性登录链接 | 写失败被吞 → 链接点开无效 |
| `kyc_photo:` | 证件照 | 直接 503（3MB 超 D1 单行 2MB 上限，**未迁移**） |

关键前提：**削减后续写入不能退还当天已用额度**，所以必须换存储才能当天恢复。

### 方案对比
| 方案 | 当天恢复 | 成本 | 改动 | 以后还会再满 |
|---|---|---|---|---|
| 等 UTC 0 点重置 | ❌ 12h 后 | 0 | 0 | 会（1000 写/天对注册+登录+搜索本就偏紧） |
| 升级 Workers Paid | ✅ 5 分钟 | $5/月起 | 0 | 不会（KV 写入不限量） |
| **认证存储切 D1** | ✅ 部署后立刻 | **0** | **Worker 1 个文件** | 不会（D1 免费 10 万行写/天 = 100 倍余量） |
| 只改 send-otp | 假恢复 | 0 | 小 | 会，其它链路全断 |

官方额度依据：KV Free `1,000 writes/day`（KV limits 页）；D1 Free `100,000 rows written/day`、
`5,000,000 rows read/day`（D1 pricing 页）。两者都是**账户级**、UTC 0 点重置 ——
所以新建 KV namespace 无效，删库重建也不能重置。

### 实施（只改 `/workspace/worker-okad.js` 一个文件）
新增一层存储抽象，认证类数据统一走它：

- `storePut(env,key,value,{expirationTtl})` → **D1 优先**（表 `okad_store(k TEXT PRIMARY KEY, v TEXT, exp INTEGER)`，
  `INSERT ... ON CONFLICT(k) DO UPDATE`），D1 不可用时降级写 KV；
- `storeGet(env,key,{type:'json'})` → **D1 优先、KV 兜底** → 迁移前落在 KV 的旧验证码仍校验得了，不丢数据；
- `storeDel(env,key)` → 删 D1；D1 已删干净且 KV 已知不可写时，跳过无效删除请求；
- `storeOk(env)` → 有 DB 或 KV 即可用，取代原来的 `if (!env.OTPS) return 503`；
- `markKvDead()` 熔断：识别到 `10048` 后 1 小时内不再做无效 KV 写/删（UTC 0 点 KV 恢复后可自动接住）。

**刻意不迁的两类**（避免拿高频/大对象去耗 D1 额度）：
- `search:` 搜索缓存 —— 已是内存 L1 + KV 只读 L2，完全不受影响；
- `kyc_photo:` 证件照 —— 最大 3MB，超过 D1 单行 2MB 上限，继续走 `kvPut`（今天仍会 503，见待办）。

**没有动**：三份 HTML、Pages、SW `okad-v31`、热门航线轮播、Tavily 搜索、Brevo 邮件、
Origin 白名单、OTP 15 分钟冷却逻辑。

### 部署
| 项 | 值 |
|---|---|
| Worker | `f4ea5ccc-06e8-4e66-be40-82a154ef69d2` |
| 改动前原件 | `worker-before-d1.js`（可一键回滚） |
| 健康检查新增字段 | `otp_store: "d1" \| "kv" \| "none"` |

### 验证
- **本地集成测试**：`verify_d1_store.mjs` **27/27 通过**，7 个场景覆盖
  D1 主路径 / KV 10048 仍能发码 / Brevo 失败三键全回滚 / 15 分钟后可重发 /
  D1 挂自动降级 KV / 无 D1 兼容旧配置 / 两边都挂仍安全失败 / 旧 KV 码仍可校验；
  原 `verify_otp_local.mjs` **19/19 通过**，无回归。
- **线上**：`otp_store=d1`；发码 `200 {"ok":true,"sent":true,"expiresIn":900}`（原本 503）；
  错误码校验返回 `Wrong code`（证明码已落 D1）；冷却期内重发返回 `alreadySent`（零第二封邮件）；
  `/api/auth/status|refresh|logout` 全部正常返回，不再 503。
- **浏览器端到端**：主域注册流程真实发送 → 状态条
  `✅ Code sent to … valid 15 minutes` → 按钮 `✅ Sent · 14:59 · valid 15 min` →
  冷却时间戳已写 localStorage，无控制台错误。
- **回归**：热门航线 6 张卡片、自动滚动 `0 → 272` 正常；云端 6 条 OPEN 线路未变；
  搜索健康 `active=tavily status=200`；Origin 白名单三个自家域 `200`、`evil.example.com` `403`；
  主域 SW 仍 `okad-v31`，三份 HTML md5 一致 `38a7c870…`。

### 过程中修掉的两个真实边界
1. **降级写被熔断挡住**：原来 KV 写失败会置 1 小时熔断，导致 D1 挂掉时连「降级写 KV」都跳过，
   UTC 0 点 KV 恢复后接不住。→ 降级写不套熔断；`storeDel` 仅在 D1 已删干净时才跳过 KV。
2. **D1 删失败时旧码残留**：`storeDel` 原来只要 KV 被熔断就完全跳过 → 改为 D1 没删成时无论如何都试一次 KV。

### 待办
1. **证件照（KYC）今天仍传不了**：仍在 KV，配额满 → 503。要彻底解决需选一条：
   前端压缩到 <1.5MB 再走 D1，或改用 R2（免费 10GB）存证件照。**待你定**。
2. `okad_store` 不做自动清理，`otpday:` 按天累积（每邮箱每天 1 行，约 60 字节），
   按当前量级一年约 22MB，D1 免费 5GB 容量完全够；真需要时再加定时清理。
3. D1 免费额度同样是账户级且超额会报错 —— 搜索缓存必须继续留在内存/KV，不要往 D1 塞高频写。

