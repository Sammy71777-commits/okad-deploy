# OKAD 个人中心 6 位密码登录 + 订单归属修复 交付报告

> 日期：2026-11-02 · 线上：okadafrica.com / api.okadafrica.com
> 范围：严格限定「个人中心 + 登录/密码」，其余业务代码未动

---

## 一、本轮交付清单

| # | 需求 | 状态 | 落点 |
|---|------|------|------|
| 1 | 个人中心 + login 页支持 **6 位数字密码**登录 | ✅ 已上线 | `deploy/index.html` / `worker-okad.js` |
| 2 | **10 分钟内**不需要再次输入 | ✅ 已上线 | 前端本地窗口 + 服务端 `PWD_FREE_WINDOW` |
| 3 | **同 IP + 同设备**不需要再次输入 | ✅ 已上线 | Worker `/api/auth/refresh` 静默续期 |
| 4 | **注册页**顺带设置 6 位密码(免去再进 Me 页单独设) | ✅ 已上线 | `registerModal` + `doRegister()` |
| 5 | 个人中心显示向导单（`waPhone` 过滤 bug） | ✅ 已上线 | `getMyOrders()` |
| 6 | 彻底清掉 `okadafrica.com/undefined` | ✅ 已上线 | 搜索卡片 + 自购跳转 + SW v8 |
| 7 | 6 段流程（仓库→…→送货）无回归 | ✅ 已复测 | `verify_flow6.py` |

---

## 二、6 位密码登录：设计

### 2.1 免密规则（按你的原话落地）

| 场景 | 行为 |
|------|------|
| 登录后 **10 分钟内**再次进入 | 直接放行，连密码框都不用填 |
| 超过 10 分钟，**同一 IP + 同一设备** | 静默续期，不弹密码框 |
| 换设备 / 换网络 | 必须重新输 6 位密码 |
| 主动点 Log out | 服务端会话立即销毁，不会被自动拉回 |

- **设备指纹**：首次访问生成 `okad_device_id`（localStorage 持久化）
- **IP 判定**：服务端读 `CF-Connecting-IP`，存在 KV 会话里，前端拿不到也改不了

### 2.2 后端接口（Worker `shrill-wave-7c04`）

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/api/auth/status?email=&deviceId=` | 查是否已设密码 / 当前设备是否免密 |
| POST | `/api/auth/set-password` | 设置或修改密码（须已注册） |
| POST | `/api/auth/login` | 密码登录 |
| POST | `/api/auth/refresh` | 静默续期（10 分钟窗口 or 同 IP+同设备） |
| POST | `/api/auth/logout` | 销毁免密会话 |

**安全实现**
- 密码**不落明文**：PBKDF2-HMAC-SHA256 + 每用户 16 字节随机盐，存 D1 `users` 表新增列
  `password_hash` / `password_salt` / `pw_set_at` / `device_id`（列不存在时自动 `ALTER` 惰性补齐）
- **在线爆破防护**：KV 计数，10 分钟内错 10 次锁定 10 分钟，返回 `triesLeft`
- **哈希绝不下发**：`GET /api/db/users` 响应中主动剔除 `password_hash` / `password_salt`

### 2.3 前端改动（`deploy/index.html`）

- **loginModal**：拆成「📧 Email code / 🔑 Password」双 tab，密码框 6 位数字居中大字
  - 切到 Password tab 时自动探测该邮箱在本机是否免密，提示语随之变化
  - 密码留空直接点 Log In → 走免密判定
- **registerModal**：新增「Login password (optional · 6 digits)」密码 + 确认密码两格
  - 留空不影响原有注册流程（老的注册路径完全兼容）
  - 填了就必须 6 位数字且两次一致，否则当场拦下不建号
  - 注册成功后会**等云端用户行建好再写密码**（否则 `set-password` 会 404），并自动开启本机免密
  - 注册完直接显示 Me 页密码卡片 `Active ✓`，不需要再单独去设置
- **个人中心 Me 页**：新增「🔑 LOGIN PASSWORD」卡片
  - 状态徽章：`Not set` / `Active ✓`
  - 按钮：`Set 6-digit password` → 设置后变 `Change password`
  - 提示：10 分钟免密 / 同设备同网络保持登录
- **静默登录**：`DOMContentLoaded` 与打开登录弹窗时自动检测并静默恢复登录（不弹 toast、不打断当前浏览）

---

## 三、顺手修掉的 3 个真问题

| 问题 | 后果 | 处理 |
|------|------|------|
| `DB.upsertUser` 用 `INSERT OR REPLACE` 只带档案列 | **用户一登录就会把已设的密码哈希抹成 NULL** | Worker `POST /api/db/users` 写入前回填服务端持有的密码列 |
| `GET /api/db/users` 返回全部字段 | 密码哈希会暴露给任何前端调用方 | 响应中剔除哈希与盐 |
| 搜索结果卡片把 `r.url` 直接拼进 `window.open` | 后端/mock 返回字符串 `"undefined"` 时 → 浏览器跳到 `okadafrica.com/undefined` | 统一走 `safeProductUrl()` 过滤，无效链接不生成可点击卡片 |

> `/undefined` 的**真正根因不是 Service Worker**，而是搜索结果渲染那一行未过滤的 `window.open`。SW 版本已一并提到 `okad-v8` 清旧缓存。

---

## 四、个人中心订单归属修复

原来只认 `customerPhone === currentUser.phone`，而 WhatsApp 向导单落库字段是 `waPhone`，所以向导单在个人中心永远显示不出来。

现在改为 `getMyOrders()` 多字段归一比对：

- 手机号候选：`customerPhone` / `waPhone` / `phone` / `contactPhone` / `whatsapp` / `customerWhatsapp`
- **号码归一**：`+2335xxxxxxxx` / `2335xxxxxxxx` / `05xxxxxxxx` 统一取后 9 位再比
- 邮箱兜底：`customerEmail` / `email` / `contactEmail`
- 用户 ID 兜底：`customerId` / `userId`

实测：向导单（`waPhone`）、普通单（`customerPhone` 写成 `0500000000`）都能显示，**别人的订单不会被误算入**。

---

## 五、验证结果（全部线上实测）

**后端 curl 实测**
```
设密码(未注册邮箱)      → 404 "Email not registered"
设密码(已注册)          → ok:true
status                  → hasPassword:true, trusted:true, reason:"within-10min"
错误密码                → 401 "Wrong password", triesLeft:9
正确密码                → ok:true, token, ttl:600000
静默续期(同 IP 同设备)   → renewed:true, reason:"within-10min"
静默续期(换设备)         → 401 "Different device" ✅ 必须重输密码
写档案后密码是否还在      → hasPassword:true ✅ 回归保护生效
users GET 是否泄漏哈希    → 无 password_hash ✅
logout → status          → trusted:false ✅
```

**Playwright 真实 UI 全流程**
```
[3] loginModal 出现双 tab           ✅
[4] 切到密码面板 / 验证码面板隐藏    ✅
[6] 6 位密码登录 → 进入已登录态      ✅ (sammy joo)
[7] 密码卡片 Active ✓ / 免密提示      ✅
[8] 10 分钟免密(密码留空直接登录)    ✅
[9] 向导单 + 普通单都显示, 订单数=2   ✅ 别人的订单未混入
[10] 清理测试数据                     ✅
```

**注册带密码专项验证（`verify_reg_password.py`）**
```
注册页出现 regPwd / regPwd2          ✅
两次密码不一致 → 当场拦下不建号        ✅
密码非 6 位     → 当场拦下不建号        ✅
注册成功 + 服务端已存哈希              ✅ hasPassword:true
注册完 Me 页密码卡片直接 Active ✓       ✅ 不用再单独设置
退出后用注册时的密码重新登录成功         ✅
```

**回归**
```
6 段流程(仓库→上船→运行→付款→清关→送货) 全绿,errors:0
/undefined 访问后 pathname 自动纠正为 "/"
safeProductUrl('undefined') === ''
SW CACHE_VERSION = okad-v8
页面中残留 undefined/null 的 onclick 数量 = 0
```

---

## 六、怎么用

1. **新客户注册**：注册表单里直接填「Login password (optional · 6 digits)」→ 一步到位，注册完就能用密码登录
2. **老客户**：Me → 🔑 LOGIN PASSWORD → 设 6 位密码（已设过的直接改）
3. 之后在 login 页切到 **🔑 Password** tab，输入邮箱 + 6 位密码即可登录
4. **10 分钟内**回来直接进；**同设备同网络**回来也直接进，不用输密码

> 注册时密码留空也完全不影响——老流程原样可用，随时能去 Me 页补设。
> 测试账号：`sammy71777@gmail.com` / `123456`（验证用，你可以在 Me 页里改成你自己的 6 位密码）

---

## 七、全量更新与整站回归（最新一次）

### 7.1 全量推送

| 目标 | 结果 |
|------|------|
| Worker `shrill-wave-7c04` | ✅ 重新部署成功（33.24 KiB / gzip 8.82 KiB），版本 `2ede9376-fd02-4954-9bb3-dafea63bd90f` |
| Pages `okad-africa` | ✅ 28 个文件全部上传完成，生产域名 okadafrica.com |
| 4 份前端副本 | ✅ `deploy/index.html` = `index.html` = `okad_africa_app.html` = `site/index.html`（MD5 `2063da25…` 一致） |
| 线上 vs 本地 | ✅ 线上首页 MD5 == 本地 `deploy/index.html`，**零差异** |
| Service Worker | ✅ 线上 `CACHE_VERSION = okad-v8` |
| 语法自检 | ✅ 内联 7 个 JS 块全部解析通过；`worker-okad.js` `node --check` 通过 |

### 7.2 整站回归（9 个脚本全跑）

| # | 脚本 | 结果 |
|---|------|------|
| 1 | `verify_password.py` 密码登录主流程 | ✅ 双 tab / 密码登录 / 10 分钟免密 / 订单归属 / 卡片 Active ✓ |
| 2 | `verify_reg_password.py` 注册带密码 | ✅ 位数校验 + 一致性校验 + 服务端存哈希 + 退出重登 |
| 3 | `verify_flow6.py` 六段物流流程 | ✅ 接单→处理→收款→完成，6/6 步，付款成功页，邮件已发，`errors: 0` |
| 4 | `verify_actions.py` 后台三键 + 幂等 | ✅ 接单/处理/完成，回执 2 张，重复点不重复追加（`receipts` 仍为 2） |
| 5 | `verify_receipt.py` 回执上传 | ✅ 客户上传 + 后台推进 + 缩略图 + WhatsApp 要回执链接，`0 错误` |
| 6 | `verify_admin_live.py` 后台实时 | ✅ 后台登录、三键、`☁ synced`、`✉ 邮件已发`，`0 错误` |
| 7 | `verify_wizard.py` WhatsApp 向导建单 | ✅ 4 步向导 → 报价 → 落库 → 追踪页回查 → `?track=` 直达，`0 错误` |
| 8 | `verify_final.py` 浮层遮挡 | ✅ 容器 opacity 恒为 1，底层被完全遮住，`0 错误` |
| 9 | `verify_sr_fix.py` 浮层透叠 | ✅ 底色 alpha 全程 1.0，无透叠，`0 错误` |

> 期间修了 `verify_actions.py` 两处**测试脚本自身**的问题（非产品缺陷）：按钮选择器未限定作用域会命中其它订单行；订单码写死会与线上既有单冲突。已改为「按订单号精确定位 + 每次生成唯一单号」。

### 7.3 线上探活

```
GET https://okadafrica.com/                  HTTP 200   3.8s
线上首页 MD5 == deploy/index.html            ✅ 2063da255f95dd15fbff408228b446a4
/service-worker.js  CACHE_VERSION            okad-v8
/api/auth/status    sammy71777@gmail.com     {"ok":true,"hasPassword":true,...}
/api/db/orders      OKAD02224211             存在, status=Confirmed
```

---

## 八、部署与文件

**已上线**
- Worker `shrill-wave-7c04` → `2ede9376-fd02-4954-9bb3-dafea63bd90f`
- Pages `okad-africa` → `https://071440bb.okad-africa.pages.dev`（生产域名 okadafrica.com）

**改动文件**
| 文件 | 改动 |
|------|------|
| `worker-okad.js` | 新增 `/api/auth/*` 5 个接口 + PBKDF2 + 免密会话；users 表密码列回填保护；GET 剔除哈希 |
| `deploy/index.html` | 个人中心密码卡片；login 双 tab；**注册页密码字段**；`getMyOrders()` 归属归一；`safeProductUrl` 兜底；静默登录 |
| `deploy/service-worker.js` | `CACHE_VERSION` v7 → v8 |
| `index.html` / `okad_africa_app.html` / `site/index.html` | 与 `deploy/index.html` 同步（MD5 一致） |
| `verify_password.py` | 密码登录端到端验证脚本 |
| `verify_reg_password.py` | 注册页设置密码专项验证脚本 |
| `verify_actions.py` | 已修正选择器作用域与订单码冲突（测试脚本问题，非产品缺陷） |
