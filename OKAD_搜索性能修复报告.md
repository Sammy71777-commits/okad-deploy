# OKAD AFRICA — 搜索("查一下")性能修复报告

**日期**:2026-11-02
**影响范围**:`worker-okad.js`(Worker `shrill-wave-7c04`)**单文件**,前端未改动,无需重新发布 Pages
**最终部署版本**:`be3363a1-419c-4649-9c56-e322d54a0f39`

---

## 一、问题现象

用户反馈"查一下问题这么久"。实测线上 `POST /api/search`:

| 场景 | 修复前实测 |
|---|---|
| 常规查询(基线) | **6.95s** |
| 部分查询 | **13.8s / 16.0s / 17.6s** |
| 最坏情况 | **30s 直接挂死**(curl 超时,code 000,前端一直转圈) |

## 二、根因定位(逐层收敛,不扩散)

问题全部集中在 `handleSearch()` 一个函数内,共 4 条叠加:

1. **两个外部请求串行** — 先 `await` 网页搜索拿到 JSON,再发图片搜索再 `await`。耗时 ≈ 两次之和,而非取较慢的一次。
2. **主搜索没有超时** — `fetch` 到 SerpAPI 无任何超时保护。上游 google 引擎抖动时(实测 1.7s~30s+ 波动),请求会一直挂着,前端无限转圈。**这是 30s 挂死的直接原因。**
3. **没有任何缓存** — 每次查询都实时打外部接口,重复查同一批品类完全重复付费、重复等待。
4. **没有兜底** — SerpAPI 一失败就直接返回 502,不会退到备用的 Google CSE;前端只能退回 mock 数据,真实结果白白丢失。

## 三、修复措施(全部就地落在 `handleSearch`)

| # | 措施 | 位置 |
|---|---|---|
| 1 | 网页 + 图片搜索改 `Promise.all` **并行**发出,耗时从「相加」降为「取慢」 | `handleSearch` |
| 2 | 图片请求加 **5s 硬上限**(race 定时器)。图片是锦上添花,超时即丢弃,改用 web 结果自带的 `thumbnail` 顶上 | `handleSearch` |
| 3 | 主搜索加 **8s 硬超时**(`fetchWithTimeout`),上游再慢也绝不挂死 | 新增 `fetchWithTimeout` |
| 4 | **超时/失败自动走 Google CSE 兜底**;CSE 也没有则返回空结果让前端走 mock,**不再 502** | 新增 `googleCseSearch` + catch 分支 |
| 5 | **两级缓存**:L1 isolate 内存 + L2 **KV 全局缓存**(TTL 30min),重复查询秒回 | `_cacheGet/_cacheSet` + `env.OTPS` |
| 6 | KV 写入用 `ctx.waitUntil()` **保活**,否则响应返回时写入被回收,缓存永远不生效 | 路由传 `ctx` |

> KV 复用 `OTPS` 命名空间,键前缀 `search:`,与 OTP 验证码互不冲突。

## 四、修复效果实测

**冷查询(全新关键词,每次都实时打外部接口)**

| 查询词 | 修复前 | 修复后 |
|---|---|---|
| commercial ice maker 500kg price | 6.95s | **2.06s** |
| 40ft shipping container china | — | **2.59s** |
| kids water bottle bpa free | — | **2.36s** |
| solar inverter hybrid 5kva | — | **3.31s** |
| cattle feed mill machine | — | **5.37s** |
| ~~某查询~~ | **30s 挂死** | **不再出现,全部 ≤8s 封顶** |

**重复查询(缓存命中)**

| 命中层 | 实测 | 标识 |
|---|---|---|
| L1 内存 | **0.057s** | `cached: "memory"` |
| L2 KV | **0.072s ~ 0.080s** | `cached: "kv"` |

**线上真实浏览器端到端**(Playwright,414×896 移动视口)

| 步骤 | 用时 | 结果 |
|---|---|---|
| 冷查询 | **0.10s** | 卡片 3 个、含图 2 张 |
| 同词重搜 | **0.09s** | 卡片 3 个、含图 2 张 |
| 控制台错误 | — | **0 条** |

截图:`verify_search_cold.png`、`verify_search_cached.png`

**回归检查**:`/` `ok:true` · `/api/config` 200 · `/api/db/orders` 200 · 前端首页 200 · `node --check` 语法通过

## 五、附带修掉的一个隐性 Bug

添加 `if (ir)` 空值守卫时,`const idata` 被包进 `if` 块、但 `const imgs = idata...` 留在外层 → `idata` 越出作用域抛 `ReferenceError`,导致**图片结果永远为空**。已修正缩进并补齐 `if (ir)` 闭合括号。

## 六、备注(未处理,待确认)

线上搜索浮层 `srPage` 打开时,首页内容会透过半透明背景叠在一起,文字有重叠感。这是**前端既有的视觉问题**,与本次性能修复无关,前端本次未改动。如需一并处理请告知。
