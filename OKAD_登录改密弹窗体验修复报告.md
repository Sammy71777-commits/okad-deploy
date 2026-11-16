# OKAD 登录/改密弹窗体验修复报告

日期:2026-11-02 · 版本:`okad-v13` · 线上:https://okadafrica.com

---

## 一、用户提出的 4 个问题与根因

| # | 用户原话 | 真实根因 |
|---|---|---|
| 1 | "code 发出后应该有时间倒计时" | `sendCode()` 只有一条 `localStorage` 60 秒静默节流,**按钮文案从不变化**,没有任何计时 UI |
| 2 | "任何操作结束后,在本页面应该有反馈……更看不到任何东西" | **`.toast` 的 `z-index:9999` 小于 `.modal-overlay` 的 `10000`** → 弹窗打开时,所有 toast 都渲染在遮罩层**下面**,等于"什么都没发生" |
| 3 | "成功后应该自动跳的登录进入页面" | `doResetPassword()` 先 `setLoginMode('pwd')` 再把新密码填回密码框,之后才调 `finishLoginByEmail()`;成功反馈又只走 toast(被遮住),用户感知停在原地 |
| 4 | "下面 back to password 的这个地方…没有必要要一个这个" | 找回密码面板底部确实有一条 `← Back to password login` 链接 |

---

## 二、修改清单(全部在 `deploy/index.html`)

### 1. 弹窗内反馈可见(根因修复)
- `.toast` 的 `z-index` 由 `9999` 提升到 **100000**,高于所有弹窗(`.modal-overlay` 10000 / `okadModal` 10001 / `#orderDetailModal` 99999),**toast 不再被遮罩吞掉**。
- 新增 `.form-status` 样式(ok / err / warn / info 四态)。
- 登录弹窗内新增 `#loginStatus`,注册弹窗内新增 `#regStatus`,两者都是弹窗**内部**的反馈条。
- 新增 `setFormStatus(id, msg, type)` / `clearFormStatus(id)` 两个全局函数。
- 接入行内反馈的操作:
  - `sendCode()`(登录码 / 找回密码码 / 注册码)
  - `doLoginWithPassword()`(密码登录)
  - `doLogin()`(验证码登录)
  - `doResetPassword()`(重置密码)
  - `requestWaLogin()`(WhatsApp 登录链接)
  - `doRegister()`(注册)
  - `finishLoginByEmail()`(邮箱未注册 → 引导注册)

### 2. 验证码 60 秒倒计时
新增 `startCodeCountdown(mode, email)` / `syncCodeCountdown()` / `sendCodeBtn(mode)`:
- 发送成功后按钮变灰、置 `disabled`,文案变为 `⏳ 剩余秒数`(每 250ms 刷新)。
- 三个发送按钮分别加了 id:`sendCodeBtnLogin` / `sendCodeBtnReset` / `sendCodeBtnReg`。
- 时间戳存 `localStorage: okad_sendcode_ts_email_<email>`,**刷新页面 / 切换面板 / 重新打开弹窗后自动恢复剩余秒数**。
- 冷却结束按钮自动恢复为 "Send Code"。
- 用户改了邮箱 → 立即解除该按钮的禁用状态。
- 与后端一致:Worker `/api/send-otp` 本身就有 `cd:email:<to>` 60 秒冷却,前后端同频,不会出现前端能点、后端报错。

### 3. 重置密码成功后自动登录并进入 Me 页
`doResetPassword()` 改动:
- 删除 `setLoginMode('pwd')` 与 `lp.value = pw` 两行(不再回退到密码面板)。
- 成功后直接走 `finishLoginByEmail(em)` → 服务端已返回会话 token → 关闭弹窗 → `loadUser()` → `switchTab(me)` → 渲染 Me 页。
- 期间行内显示 `✅ Password reset — signing you in…`,成功后清空。
- `finishLoginByEmail()` 的 Me 页跳转增加了兜底:`switchTab(null,'me')`,即使 tab 按钮选择器失效也能进 Me 页。

### 4. 去掉底部 Back to password
删除 `#loginPaneReset` 底部的 `← Back to password login` 整段。
(验证码面板与 WhatsApp 面板底部的同名链接保留,那里没有别的返回入口。)

### 附带
- `service-worker.js` 的 `CACHE_VERSION` 由 `okad-v12` 升到 **`okad-v13`**,旧缓存自动清理。
- 四份前端副本已同步:`deploy/index.html` = `index.html` = `okad_africa_app.html` = `site/index.html`(md5 一致)。

---

## 三、验证结果

### 本地(Playwright + 拦截后端)
| 检查项 | 结果 |
|---|---|
| 找回密码面板是否含 "Back to password" | ✅ False(已移除) |
| 点击 Send Code 后按钮 | ✅ `⏳ 60s`,`disabled=true`,`btn-cooling` |
| 2.5 秒后按钮 | ✅ `⏳ 57s`(实时递减) |
| 弹窗内行内反馈条 | ✅ `form-status show ok`:"✅ Code sent to …" |
| toast / modal 层级 | ✅ toast `100000` > modal `10000` |
| 重置成功 → 弹窗关闭 | ✅ 关闭 |
| 重置成功 → 当前用户 | ✅ "Reset Tester" |
| 重置成功 → Me 页 | ✅ `display: block`(My Profile 已渲染) |
| 错误输入(码长/两次密码不一致) | ✅ `form-status show err`:"❌ Enter the 6-digit code we emailed you" |
| 登录码面板 / 注册面板倒计时 | ✅ 均为 `⏳ 60s disabled=true` |
| 刷新后倒计时恢复 | ✅ `⏳ 58s disabled=true` |
| 换邮箱后按钮恢复 | ✅ 按新邮箱的剩余时间重新计算 |

### 线上(https://okadafrica.com,真实后端)
| 检查项 | 结果 |
|---|---|
| 线上首页含新代码 | ✅ `form-status` ×9,`sendCodeBtnReset` ×2 |
| 线上 `service-worker.js` | ✅ `CACHE_VERSION = 'okad-v13'` |
| 线上 toast 层级 | ✅ `100000` |
| 线上找回密码面板 | ✅ 无 "Back to password" |
| 线上未注册邮箱点发送 | ✅ 行内提示"📧 This email is not registered — opening the registration page…",并自动跳到注册页 |

### 截图
- `ux_1_code_sent.png` — 发送成功:toast 浮在弹窗之上 + 弹窗内绿条 + `⏳ 60s` 灰按钮 + 底部链接已消失
- `ux_2_after_reset.png` — 重置成功:自动登录并停在 My Profile 页
- `ux_3_error.png` — 错误:toast 红色 + 弹窗内红色反馈条
- `ux_live_1.png` — 线上未注册邮箱的真实提示

---

## 四、涉及文件

| 文件 | 变更 |
|---|---|
| `deploy/index.html` | 主改动(反馈条 / 倒计时 / 自动登录 / 去链接) |
| `index.html`、`okad_africa_app.html`、`site/index.html` | 同步副本 |
| `deploy/service-worker.js` | `CACHE_VERSION` → `okad-v13` |
| `verify_reset_ux.py` | 新增:自动化回归验证脚本 |

`worker-okad.js` **本轮无需改动** —— `/api/send-otp`(60 秒冷却)、`/api/verify-otp`(一次性核销)、`/api/auth/reset-password`(校验码 → 改密 → 直接下发会话 token)链路本身是正确的,问题全在前端表现层。
