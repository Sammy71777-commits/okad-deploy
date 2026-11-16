# OKAD AFRICA — 登录改版说明（密码为默认 · 找回密码 · WhatsApp 登录）

上线时间：2026-11-02 · Worker `shrill-wave-7c04` · Pages `okad-africa` · SW 缓存 `okad-v10`

---

## 一、你提的四点，逐条落地

| 你的要求 | 落地情况 |
|---|---|
| 注册表单只有「证件类型 + 照片」，不加别的 | ✅ 保持原样，**没有**加证件号输入框（后台 ID NUMBER 仍显示 not provided） |
| 密码框放在证件下面 | ✅ 顺序改为：姓名 → 邮箱 → 国家 → **证件类型 → 证件照片 → 6 位密码 → 验证码**（实测纵向坐标：证件照 609px < 密码 685px < 验证码 805px） |
| 注册成功返回就是密码登录 | ✅ 登录弹窗默认就是密码面板；注册成功 / 邮箱已注册 / 站内所有「Log in」入口，打开的都直接是密码面板并预填邮箱 |
| 找回密码发邮件 code | ✅ 密码面板下方「Forgot password? Email code →」→ 填邮件码 + 新 6 位密码 + 确认 → 校验通过即改密码并**直接登录**，不用再输一次 |
| 正常就是密码登录，不需要其它 code | ✅ 邮箱验证码降级为次要入口（密码面板底部小字「No password yet? Log in with email code →」），不再是默认 |
| 可以链接 WhatsApp 登录吗 | ✅ 见下节 |

---

## 二、WhatsApp 登录怎么走（重要：个人号的技术边界）

**结论：能做，但只能做「一次性登录链接」，做不了「WhatsApp 收 6 位验证码」。** 因为个人号没有 WhatsApp Business API，我们只能生成 `wa.me` 深链，不能自动向客户发消息。

实际链路（两条通道并行，客户任选其一）：

```
客户点「💬 Log in with WhatsApp」→ 填邮箱 + WhatsApp 号
        ↓
服务端生成一次性 token（24 位，30 分钟有效，用过即焚）
        ↓
① 邮件通道：链接自动发到客户邮箱（Brevo 已配，实测 emailed:true）
② 人工通道：页面直接给出链接 + 「📲 Send to our agent on WhatsApp」按钮
        + 后台 Clients 页也列出请求，客服复制链接用 WhatsApp 发给客户
        ↓
客户点链接 → okadafrica.com/?wa=<token> → 自动校验、自动登录、地址栏 token 立即抹掉
```

后台位置：**Admin → Clients → 底部「💬 WhatsApp sign-in requests」**，显示邮箱、WhatsApp 号、时间、**PENDING / USED** 状态、链接，以及「Send on WhatsApp」「Copy」两个按钮。

> 补充发现：清理测试数据时发现 08:06 有一条 `+639171426789` 的真实请求（PENDING），说明已经有客户在试这个功能了。

---

## 三、本次新增 / 改动的文件

**后端 `worker-okad.js`**
- `POST /api/auth/reset-password` — 邮件码校验 → 改密码 → 直接开免密会话
- `POST /api/auth/wa-request` — 生成一次性链接（60 秒节流，防刷）
- `GET /api/auth/wa-verify` — 校验 token → 建立会话 → 返回 email
- `GET /api/auth/wa-requests` — 后台待处理请求列表
- 表 `wa_login_requests` 惰性建表；`wa_login_requests` 已加入 `/api/db/{table}` 白名单（后台可清理）
- **所有鉴权响应加 `Cache-Control: no-store`**（否则 CDN 会把「一次性」响应缓存回放）
- WhatsApp 链接双重防重放：KV 删除 + `used:` 标记（KV 删除全球收敛最多 60 秒，单靠 delete 有 60 秒重放窗口）

**前端 `deploy/index.html`**
- 注册表单：密码块移到证件照片下方
- 登录弹窗重写：四面板 `pwd`（默认）/ `code` / `reset` / `wa`，去掉原来的 Email code / Password 双 tab
- 新增 `openLoginModal(email)`：统一登录入口，默认密码面板 + 预填邮箱
- 新增 `doResetPassword()`、`requestWaLogin()`、`handleWaLoginToken()`
- `sendCode()` 支持 `reset` 模式（用 `loginResetCode` 框，且同样校验邮箱是否已注册）
- 后台 Clients 页新增 WhatsApp 登录请求区块 + `loadWaLoginRequests()`
- 页面加载自动处理 `?wa=token`

---

## 四、验证结果（全绿）

| 验证项 | 结果 |
|---|---|
| 登录弹窗默认密码面板 | ✅ `loginMode=pwd`，pwd 可见 / code 隐藏 |
| 找回密码面板（码 + 新密码 + 确认） | ✅ 三个输入框齐全，可展开 / 可退回 |
| WhatsApp 面板 | ✅ 手机号输入框 + 生成按钮 |
| 注册表单顺序 | ✅ 证件照 609 < 密码 685 < 验证码 805 |
| 申请链接 → 后台列表可见 | ✅ 请求进入列表 |
| 点链接自动登录 | ✅ `currentUser = sammy71777@gmail.com`，地址栏 token 已清除 |
| 链接重放 | ✅ 第二次返回 "already been used" |
| 找回密码成功路径 | ✅ 注入 code → 改密成功 → 新密码可登录、旧密码被拒 |
| 找回密码失败路径 | ✅ 未注册 / 无码 / 错码 / 密码非 6 位 全部正确拒绝 |
| 密码登录（老路径） | ✅ 仍可用 |
| 注册带密码 | ✅ 全流程通过 |
| KYC 客户详情 | ✅ 7 orders · $473 · $35 |
| 六段物流流程 | ✅ errors: 0 |
| 后台三键 / 回执 / 实时 | ✅ 通过 |

控制台错误：**0**。

---

## 五、两个需要你知道的点

1. **找回密码依赖客户能收到邮件。** Brevo 发件人目前是已验证的 `sammy71777@gmail.com`（`okadafrica.com` 还没做 SPF/DKIM 域名验证），部分邮箱会进垃圾箱。等域名验证完成后把 `MAIL_FROM` 改成 `noreply@okadafrica.com` 会更好。

2. **邮箱验证码登录没有删掉，只是降级。** 保留了「No password yet?」入口，因为老客户里有一部分从没设过密码 —— 直接删掉会把他们锁在门外。如果你确认要彻底移除，说一声我去掉。

---

## 六、线上数据里的测试残留

- 我造的 4 条 WhatsApp 登录测试记录已删除，后台现在只剩 1 条真实客户请求。
- 测试账号 `pwdreg1793602189@gmail.com` 的密码已从 `222222` 改回 `654321`，可继续用于回归。
- D1 里还有早期密码验证阶段留下的 `pwdreg*` 测试账号，需要的话我可以一并清掉。
