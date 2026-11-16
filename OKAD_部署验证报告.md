# OKAD AFRICA — 部署与验证报告

**日期**：2026-11-02
**生产域名**：okadafrica.com / www.okadafrica.com / okad-africa.pages.dev
**API 域名**：api.okadafrica.com（Cloudflare Worker `shrill-wave-7c04`）

---

## 一、登录 / 注册流程分离（本次核心需求）

| 项目 | 结果 |
|---|---|
| 登录框字段 | 仅 `loginContact`(邮箱) + `loginCode`(验证码) |
| 登录框是否含姓名/证件/国家 | **否**（已完全剥离） |
| 注册框字段 | `regName` / `regEmail` / `regCountry` / `regIDType` / `regIDPhoto` / `regCode` |
| 登录 → 注册入口 | 底部 "No account yet? **Register here →**" |
| 未注册邮箱登录 | 提示"未注册"，1.8s 后自动跳转注册页并预填邮箱 |
| 已注册邮箱登录 | 直接登录，**不弹注册页** |
| IP 限制 | 已全部移除（`ip` 仅作记录溯源，无任何拦截逻辑） |
| Guest 模式 | 保留，"Continue as Guest →" 可跳过登录 |

### 客户信息保留验证

清空本地 `localStorage`（模拟换设备）后，用已注册邮箱登录：

```
name     : sammy joo        ← 从 D1 恢复
country  : GH                ← 从 D1 恢复
idType   : passport         ← 从 D1 恢复
kycStatus: approved         ← 从 D1 恢复（含审核人、审核时间）
```

姓名、国家、证件类型、KYC 状态**全部自动恢复，无需重填任何信息**。

### OTP 安全机制

| 项目 | 验证结果 |
|---|---|
| 60 秒防刷 | ✅ 重复请求返回 `429 Please wait 60s` |
| 一次性核销 | ✅ 校验通过后 KV key 立即删除 |
| 验证码不回传前端 | ✅ `send-otp` 仅返回 `{ok, sent, channel}` |
| Brevo 发信通道 | ✅ `sammy71777@gmail.com (active)`，发信 201 |
| 错误验证码拦截 | ✅ `Wrong code` |

---

## 二、本次新发现并修复的缺陷

### 缺陷 1（严重）：搜索功能线上完全不可用

**根因**：前端 `doSearch()` 调用 `fetch('/api/search')` 走**相对路径**，打到的是 Pages 静态站（`okadafrica.com/api/search`），而 Worker 托管在 `api.okadafrica.com`。Pages 对 POST 返回 405 / SPA fallback → 搜索永远降级为 mock 数据。

**修复**：新增 `apiBase()` 统一取 Worker 绝对地址，两处调用改为 `apiBase() + '/api/search'`。

**验证**：线上搜索返回 `● Live web search`（真实数据），3 条真实商品结果。

### 缺陷 2：搜索结果标题为 URL / "Untitled" / 空白

**根因**：SerpAPI `google` 引擎的 `title` 字段可能是整条 URL，或字面量 "Untitled"。

**修复**：三级兜底 —— 网页 title → 图片 title → URL 路径 slug 提取；并显式丢弃 URL 形态和 "Untitled" 的 title。

### 缺陷 3：多条搜索结果共用同一张图片

**根因**：`matchImage()` 的同域名加分拿 `im.source`（站点名如 "Made-in-China.com"）去 `indexOf(result.url)`，字符串永远匹配不上 → 加分失效，全部结果落到同一张图。

**修复**：改为 host 对 host 比较；引入 `usedSet` 记录已分配图片，后续结果优先取未用过的。

### 缺陷 4：搜索 prompt 导致结果偏题

**根因**：prompt 追加了 `"Amazon US Amazon Europe Alibaba 1688 China manufacturer"`，搜索引擎把 "Amazon Europe" 当成地名 → 标题变成 "Europe"、链接指向维基百科。

**修复**：改为不含地名的 `" wholesale price supplier manufacturer buy"`。

**修复后实测结果**：

```
TOYOTA OEM FACTORY FRONT BRAKE PAD SET 2010-2018 4RUNNER 04465-60320
  url : https://www.ebay.com/itm/236632905123
  img : i.ebayimg.com/...  (eBay)

Brake Pads Front
  url : https://www.partzilla.com/product/automotive/FVP-NM52530
  img : cdn.revolutionparts.io/...  (Modern Toyota Parts)

Wholesale Toyota Brake Pads, Wholesale Toyota Brake Pads Manufacturer
  url : https://www.amayama.com/en/ajax/part/toyota/0446535040
  img : image.made-in-china.com/...  (Made-in-China.com)
```

标题 3/3 正常、图片 3/3 唯一、链接 3/3 指向真实商品页。

### 缺陷 5：Worker 不支持 DELETE，无法清理数据

**修复**：新增 DELETE 支持，带安全防护 —— 裸 DELETE（无过滤条件）返回 400；列名白名单防注入；支持 Supabase 风格 `?email=eq.xxx`。CORS 同步放开 DELETE。

---

## 三、原有 4 个前端问题 —— 全部验证通过

### 1. 搜索产品图片错位 ✅
图片与产品严格对应，图片卡片底部标注来源域名（eBay / Made-in-China.com），无占位图回退。

### 2. Self Purchase 跳转失效 ✅
从弹窗拦截改为 `location.href` 直接导航。实测点击后成功跳转：
`https://www.ebay.com/itm/236632905123`（真实商品页，不再是 1688 首页）。
同时会写入 `okad_inquiries` 记录（type=`self_purchase`），后台可查。

### 3. Admin 开关与价格布局重叠 ✅
改用 `.rt-card` 纵向卡片：
- 第一行：路线名（flex:1）+ 开关（flex-shrink:0 药丸型），各占一行
- 第二行：起点 → 终点（两个独立输入框 + 橙色箭头）
- 第三/四/五行：3 列 CSS grid 排布 9 个价格输入
- Delete 按钮与 ID 标注独立成行

开关切换**不再清空输入数据**（实测 `DATA PRESERVED: true`）。

### 4. 路线名称硬编码 ✅
路线名、起终点、价格全部来自 `getRoutes()`，管理员自行填写。公开页由 `renderPublicRoutes()` 动态渲染（当前 4 条 OPEN 路线）：
Shenzhen→Lagos、Shenzhen→Mombasa、Shenzhen→Tema、Shanghai→Alexandria。

---

## 四、生产环境回归

```
域名
  okadafrica.com             200
  www.okadafrica.com         200
  okad-africa.pages.dev      200
  api.okadafrica.com         200

API 端点
  /                          200
  /api/brevo-health          200
  /api/config                200
  /api/exchange-rates        200

数据表
  users            1 rows
  orders           3 rows
  cooperation      0 rows
  inquiries        1 rows
  kyc_logs         0 rows
  fx_snapshots     0 rows
```

---

## 五、变更文件

| 文件 | 说明 |
|---|---|
| `worker-okad.js` | Worker 主逻辑：DELETE 支持、搜索图片匹配、标题兜底、prompt 修正 |
| `deploy/index.html` | 前端源文件：`apiBase()`、登录/注册分离、Admin 路由卡片布局 |
| `index.html` / `okad_africa_app.html` / `site/index.html` | 与 `deploy/index.html` 完全同步（MD5 一致） |
| `wrangler.toml` | Worker `shrill-wave-7c04`，绑定 OTPS(KV) + DB(D1 okad-database) |

---

## 六、遗留说明

- **Cloudflare Token 权限**：当前 Token 无 D1 读写权限（错误码 7403），仅能通过 Worker API 间接访问数据库。如需直接用 `wrangler d1 execute` 排查数据，需补 D1:Edit 权限。
- **标题兜底**：个别 SerpAPI 结果本身无标题时，会从 URL slug 提取（如 "Brake Pads Front"）。这是降级展示，非错误。
