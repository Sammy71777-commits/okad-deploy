# WhatsApp 登录「跳转不了」修复 —— 部署说明

生成时间：2026-11-10

---

## 一、问题根因（已实测复现）

### 症状
客户点 WhatsApp 一次性登录链接后，页面**看起来什么都没发生** —— 右上角还是「Log In」，
没有登录、没有报错、没有跳转。用户的描述是「登入直接跳转不了」。

### 根因
线上前端（`okad-v41`）的 `handleWaLoginToken()` 走的是这条链路：

```
wa-verify 成功 → 拿到 email
  → finishLoginByEmail(em)
      → 查本地 localStorage 的 okad_users   ← 换设备 / 清缓存 → 没有
      → 查云端 DB.listAllUsers()            ← 拉 500 条用户，手机网络慢就超时
      → 两个都没查到 → 跳注册页 ❌
```

`listAllUsers()` 一次拉 500 条用户记录，手机上网络稍慢就超时。
`catch` 只 `console.warn`，`existing` 保持 `null` → 直接跳注册页。

**实测对照**（全新浏览器 + 拦截 `api/db/users` 返回 504）：

| 版本 | 结果 |
|---|---|
| 线上旧版 | ❌ 未登录，右上角仍是「Log In」，页面无任何提示 |
| 修复版 | ✅ 已登录 `xxx@okad-test.com / Slow Net Test`，落在首页 |

### 次要问题（也已修）
1. **竞态**：`handleWaLoginToken`（DOMContentLoaded+300ms）与 `maybeSilentLogin`（+800ms）
   竞争，慢网下静默登录会抢先用旧用户登录。→ 已加 `_silentLoginBusy` 锁。
2. **链接域名不一致**：`wa-request` 生成链接用 `SITE_URL || Origin || okadafrica.com`，
   但后台 `wa-requests` 面板硬编码 `https://okadafrica.com/?wa=`。
   `SITE_URL` 一旦配置成别的域名，客服从后台复制的链接会跟客户申请时拿到的对不上。
   → 已抽出 `waSiteUrl()`，两处共用同一个域名解析。
3. **`wa-verify` 返回档案不完整**：只返回 `email` + `name`，缺 `phone/country/regTs/kycStatus`，
   前端兜底建档会丢字段。→ 已补全。

### 客服 WhatsApp 按钮 —— 没问题 ✅
首页底部「WhatsApp Us」绿色圆形按钮和右下角浮动客服按钮都实测正常：
点击后正确打开 `https://api.whatsapp.com/send/?phone=233505615533&text=...`，
能在手机 / 桌面正常跳转 WhatsApp。**这两个按钮不需要改。**

---

## 二、改了哪些文件

| 文件 | 改动 |
|---|---|
| `/workspace/worker-okad.js` | ① 新增 `waSiteUrl(env, req)` 统一链接域名<br>② `wa-verify` 返回完整用户档案（phone/country/regTs/kycStatus/idType）<br>③ 7 处 `if (env.OTPS)` → `if (storeOk(env))`（防御性，防止只有 D1 时"写了读不到"） |
| `/workspace/deploy/index.html` | ① `finishLoginByEmail(email, silent, goHome, trustedProfile)` 新增第 4 参<br>② `handleWaLoginToken` 把 wa-verify 返回的档案作为 `trustedProfile` 传入，绕开脆弱的本地+云端查找<br>③ `_silentLoginBusy` 竞态锁 |
| `/workspace/index.html`、`/workspace/site/index.html` | 与 `deploy/index.html` 同步（MD5 一致） |
| `/workspace/deploy/service-worker.js`、`/workspace/site/service-worker.js` | `CACHE_VERSION`: `okad-v43` → `okad-v44` |

---

## 三、部署步骤

### 前端（Cloudflare Pages）
三份 HTML 任选一份上传到 `okad-africa` 项目即可（内容完全一致）：

```
/workspace/index.html
/workspace/site/index.html
/workspace/deploy/index.html
```

外加 `service-worker.js`（用 `/workspace/site/service-worker.js`，v44）。

> ⚠️ **必须让 SW 版本号升到 v44**，否则老用户浏览器继续吃 v41 的缓存，
> 修复不会生效。SW 对导航请求是 network-first，HTML 本身会更新；
> 但静态资源缓存要靠版本号清。

### Worker
```bash
export CLOUDFLARE_API_TOKEN=<你的 token>
cd /workspace
wrangler deploy worker-okad.js --name shrill-wave-7c04
```
或先 `wrangler login` 再 `wrangler deploy`。

### 建议顺手加的环境变量
`wrangler.toml` 里加上（消除对 Origin 头的依赖）：
```toml
[vars]
SITE_URL = "https://okadafrica.com"
```

---

## 四、部署后验证

```bash
# 1. 确认线上 SW 已到 v44
curl -s https://okadafrica.com/service-worker.js | grep CACHE_VERSION
# 期望：const CACHE_VERSION = 'okad-v44';

# 2. 确认线上 HTML 已含修复（trustedProfile）
curl -s https://okadafrica.com/ | grep -c "trustedProfile"
# 期望：≥ 2

# 3. 端到端：注册 → 申请链接 → 点链接 → 应直接进首页
```

浏览器端验证（模拟手机慢网）：
1. 全新无痕窗口打开 `https://okadafrica.com/?wa=<token>`
2. DevTools → Network → 拦 `**/api/db/users*` 返回 504
3. 刷新 → **右上角应显示用户名，而不是「Log In」**

---

## 五、遗留事项

- 登录链接**一次性**（用过即焚）、30 分钟过期 —— 这是设计如此，不是 bug。
- 60 秒节流：同一邮箱 60 秒内只能申请一次链接（429）。
- `wa-requests` 后台面板需要 `ADMIN_KEY`，线上已配置。
- 部署需要 Cloudflare 授权；当前沙箱无 `CLOUDFLARE_API_TOKEN`、Wrangler 未登录。
