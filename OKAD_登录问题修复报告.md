# OKAD AFRICA — 登录问题修复报告

日期：2025-10-03
范围：okadafrica.com 前端（deploy/index.html + 3 份同步副本）

---

## 用户报告的现象

> 「我点了 login 最后还是退出，或者没有进入到登陆页」

截图显示：登录框已填入邮箱和验证码，点击 Log In 后没有进入用户中心，底部仍显示 "Currently logged in: Guest"，地址栏变成 `okadafrica.com/undefined`。

---

## 根因分析

问题不在登录逻辑本身，而在**登录成功后的页面导航**。修复过程中连带发现并修掉了 7 个缺陷。

### 核心缺陷 1：switchTab 参数错位 → 整个页面变空白

```js
// 修复前（loadUser 内）
loginBtn.onclick = function(){ switchTab('me'); };
```

`switchTab(el, sec)` 需要两个参数。这里只传了 `'me'`，导致：
- `el` = `'me'`（字符串，没有 `classList`）
- `sec` = `undefined`

执行时 `el.classList.add('active')` 直接抛 `TypeError: Cannot read properties of undefined (reading 'add')`。

**致命后果**：异常发生在"隐藏所有面板"之后、"显示目标面板"之前 → **所有面板全被隐藏 → 页面一片空白**。用户看到的正是"退出了"。

### 核心缺陷 2：CSS 选择器子串匹配陷阱

```js
// 修复前
document.querySelector(".tab[onclick*='me']");
```

`[onclick*='me']` 是子串匹配，而 Home tab 的 `onclick="switchTab(this,'home')"` 里 **`'home'` 含有 `ho-me`** → 匹配到了 Home 而非 Me。

即使前面的崩溃被修掉，切页依然会去错的地方。

### 核心缺陷 3：showMap 使用了一堆已删除的 id

```js
// 修复前
['hero','liveStrip','trend','shareBarWrap','quick','compare','track','pay','connect','me','stats','routes','services']
```

实测 `trend` / `shareBarWrap` / `quick` / `compare` / `track` / `pay` / `connect` **这 7 个 id 在 DOM 里根本不存在**（旧版遗留）。而真正需要隐藏的首页区块 `liveStrip`（Live Orders）和 `services`（OUR SERVICES）**没有 id**，从未被纳入管理。

结果：切到 Me 页时，首页内容仍留在页面上方，Me 页在 978px 之下需要滚动才看得到 → **视觉上"没进去"**。

---

## 全部修复清单

| # | 缺陷 | 位置 | 修复 |
|---|---|---|---|
| 1 | `switchTab('me')` 参数错位致页面空白 | `loadUser` | 改为 `switchTab(meTab, 'me')`；`switchTab` 本身加容错（省略 `el` 时自动定位 tab） |
| 2 | `[onclick*='me']` 误匹配 Home | `loadUser` / `doLogin` | 改为 `[onclick*="this,'me'"]` 精确匹配 |
| 3 | `showMap` 使用已删除 id | `switchTab` | 只列实际存在的 `hero/liveStrip/services/me/stats/routes` |
| 4 | 首页区块无 id，无法被隐藏 | HTML | 给 Live Orders 区块加 `id="liveStrip"`、OUR SERVICES 区块加 `id="services"` |
| 5 | 登录成功后不切页 | `doLogin` | 成功后自动切到 Me 页并 `renderMeSection()` |
| 6 | 采购页 3 个函数完全未实现 | `doProcureSearch` / `quickProcure` / `showProcureHistory` | 全部补齐：接入主搜索逻辑 + 快捷标签 + 最近搜索历史 |
| 7 | 登录框打开时抛 `reading 'value'` | `onLoginCountryChange` | 登录/注册分离后 `loginCountry`/`loginIDType`/`loginID` 已删除，加空值保护 |
| 8 | 提交订单后跳不到 Pay 页 | 订单提交 | Pay tab 走 `showPage('payPage')` 浮层，不是 `switchTab` 面板 |
| 9 | 商务合作表单 IP 永远为空 | 合作表单 | `loginIP` 元素已删，改从 `okad_geo` 缓存读取 |
| 10 | 物流跟踪按钮单参调用 | `switchTab("track")` | 改为 `switchTab(null, 'track')` |

---

## 验证结果

### 登录全流程（生产环境实测）

```
A 打开登录框错误      = none
B 登录成功            = true
B 恢复客户信息        = country=GH idType=passport kyc=approved
B 自动切到 Me 页      = true
B hero 已隐藏         = true
B active tab          = 👤Me
B Me 页内容           = ME My Profile … SJ sammy joo 📧 s***7@gmail.com
B 登录过程错误        = none
C 点顶部按钮错误      = none
```

### 全站功能回归（零错误）

```
1 点击 5 个底部 tab      → 错误: none
2 点击 4 个核心卡片      → 错误: none
3 搜索 Solar Panel       → srPage.show=true 结果数=3 错误=none
4 登录                   → name=sammy joo Me可见=true 错误=none
5 注册框                 → show=true 字段数=6 错误=none
```

### 首页 ↔ Me 双向切换

```
切回 Home: hero=vis liveStrip=vis services=vis me=none stats=vis routes=vis
切回 Me  : hero=none me=vis  错误=none
```

### 部署一致性

- 4 份前端副本 md5 一致
- 4 个域名（okadafrica.com / www / pages.dev / api）全部 HTTP 200
- 7 个 JS 脚本块语法检查全部通过

---

## 用户侧提示

1. **CDN 缓存**：直接刷新可能仍是旧版。加时间戳参数 `?v=xxx` 或等 1 分钟。
2. **验证码有效期短**，且**一次性核销**（用完即焚）。填错需重新点 Send Code，且有 60 秒节流。
3. **未注册邮箱**点 Send Code 会提示未注册，1.5 秒后自动跳到注册页并预填邮箱——这是设计行为，不是故障。

---

## 涉及文件

| 文件 | 说明 |
|---|---|
| `deploy/index.html` | 主源码（已修改） |
| `index.html` / `okad_africa_app.html` / `site/index.html` | 同步副本 |
| `worker-okad.js` | 本轮未改动（上一轮已加 DELETE 支持） |
