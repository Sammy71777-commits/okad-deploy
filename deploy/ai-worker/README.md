# 🎨 OKad Unified Worker — 全 Cloudflare 方案

> **5 路由 1 Worker + D1 数据库**:这是 OKAD 后端的全部
> - 🎨 **Muse Image** — OpenRouter Meta Muse 产品图
> - 📧 **Email Code** — Resend 6 位邮箱验证码
> - 📱 **SMS Code** — Africa's Talking 6 位短信验证码
> - 💱 **FX Rates** — 实时汇率(双源 + 1h 缓存)
> - 🗄️ **D1 CRUD** — `/api/db/{users|orders|cooperation|kyc_logs|fx_snapshots}`
>
> **总耗时**:~15 分钟 | **总成本**:$0-15/月 | **平台数**:1 个(Cloudflare)

---

## 📋 一键部署

```bash
cd /workspace/deploy/ai-worker
wrangler login
bash setup.sh
```

完成。详细看 `/workspace/deploy/DEPLOY-NOW.md`。

---

## 📋 架构图

```
┌─────────────────────────────────────────────┐
│  Cloudflare 一家架构            │
│  ├─ Worker (免费 10万请求/天) │
│  │  ├─ /api/muse        → OpenRouter (AI 图)
│  │  ├─ /api/email-code  → Resend (邮箱验证)
│  │  ├─ /api/sms-code    → Africa's Talking (SMS)
│  │  ├─ /api/exchange-rates → open.er-api.com
│  │  └─ /api/db/*        → D1 (本地 SQLite)
│  ├─ D1 数据库 (5GB 免费)         │
│  └─ Pages (可选,静态托管)         │
└─────────────────────────────────────────────┘
```

---

## 🛣️ 5 路由详情

| Method | Path | 用途 | 需要 Secret |
|---|---|---|---|
| POST | `/api/muse` | AI 图像生成 | OPENROUTER_API_KEY |
| POST | `/api/email-code` | 邮箱验证码 | RESEND_API_KEY |
| POST | `/api/sms-code` | SMS 验证码 | AFRICASTALKING_API_KEY |
| GET  | `/api/exchange-rates` | 实时汇率(无依赖) | — |
| GET/POST/PATCH/DELETE | `/api/db/{table}` | D1 CRUD | D1 binding |

**健康检查**:访问 `GET /` 返回所有路由状态:
```json
{
  "ok": true,
  "service": "OKAD Unified Worker",
  "routes": ["..."],
  "muse_configured": true,
  "email_configured": true,
  "sms_configured": true,
  "db_configured": true
}
```

---

## 🗄️ D1 数据库

### 表结构

| 表 | 主键 | 用途 |
|---|---|---|
| `users` | email (TEXT COLLATE NOCASE) | 注册用户 + KYC |
| `orders` | id | 订单 |
| `cooperation` | id | 商务合作询盘 |
| `kyc_logs` | id | KYC 审计日志 |
| `fx_snapshots` | id (AUTOINCREMENT) | 汇率历史快照 |

详细 schema:`/workspace/deploy/db/schema-d1.sql`

### REST 接口 (Worker 暴露)

```
GET    /api/db/{table}?field=value&order=field.col&limit=N   → 查询
POST   /api/db/{table}    { field: value, ... }             → upsert by PK
PATCH  /api/db/{table}?pk=value  { field: value, ... }      → 部分更新
DELETE /api/db/{table}?pk=value                              → 删除
```

字段白名单(防 SQL 注入):

```js
DB_TABLE_FIELDS = {
  users:        { pk: 'email', fields: [...] },
  orders:       { pk: 'id',    fields: [...] },
  cooperation:  { pk: 'id',    fields: [...] },
  kyc_logs:     { pk: 'id',    fields: [...] },
  fx_snapshots: { pk: 'id',    fields: [...] }
}
```

### 前端调用示例

```js
// 等价于 SELECT * FROM users WHERE email = 'foo@bar.com'
await DB.getUser('foo@bar.com');

// 等价于 INSERT INTO users ... ON CONFLICT(email) DO UPDATE
await DB.upsertUser({ email: 'foo@bar.com', name: 'Alice', ... });

// 等价于 UPDATE users SET kyc_status='approved' WHERE email='foo'
await DB.updateKyc('foo@bar.com', 'approved', 'verified docs', 'admin');
```

---

## 🔧 Wrangler 配置 (wrangler.toml)

```toml
name = "okad-unified"
main = "worker.js"
compatibility_date = "2026-01-15"

# D1 binding
[[d1_databases]]
binding = "DB"
database_name = "okad-db"
database_id = "REPLACE_WITH_YOUR_D1_ID"   # 创建后填入

[observability]
enabled = true
```

### 常用命令

```bash
# 创建数据库
wrangler d1 create okad-db

# 本地初始化(开发)
wrangler d1 execute okad-db --file=../db/schema-d1.sql

# 远程初始化(生产)
wrangler d1 execute okad-db --file=../db/schema-d1.sql --remote

# 查看表
wrangler d1 execute okad-db --remote --command="SELECT name FROM sqlite_master WHERE type='table'"

# 设置 Secret
wrangler secret put OPENROUTER_API_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put AFRICASTALKING_API_KEY

# 部署
wrangler deploy

# 实时日志
wrangler tail
```

---

## 💰 成本明细

| 服务 | 免费额度 | 50 客户/天成本 |
|---|---|---|
| Cloudflare Workers | 100K 请求/天 | **$0** |
| Cloudflare D1 | 5GB 存储,500万读/天 | **$0** |
| OpenRouter Meta Muse | $5 起充 | $0.50/天 = $15/月 |
| Resend Email | 100/天 | **$0**(免费额度) |
| Africa's Talking | 沙盒免费 | **$0**(测试用沙盒) |
| **合计** | | **$0-15/月** |

---

## 🆘 故障排查

**Worker 部署成功但访问 404?**  
检查路径拼写,只接受上面列出的 5 个路由。

**D1 操作 503 "DB not configured"?**  
`wrangler.toml` 里 `database_id` 没填,或 Cloudflare Dashboard → Worker → Bindings 没看到 D1。

**Schema 创建后报 "no such table"?**  
多半 `--remote` 漏了,跑本地了:
```bash
wrangler d1 execute okad-db --file=../db/schema-d1.sql --remote
```

**Secrets 设置后不生效?**  
设 Secret 后必须重新 `wrangler deploy` 才生效。

---

## 📁 文件结构

```
ai-worker/
├── worker.js              # 主 Worker 代码 (687 行)
├── wrangler.toml.example  # 配置模板
├── setup.sh               # 一键部署脚本
├── package.json           # npm 元数据
├── README.md              # 本文件
└── README-EN.md           # 英文版
```

数据库 schema 在 `/workspace/deploy/db/schema-d1.sql`。  
前端代码在 `/workspace/okad_africa_app.html`(DB 模块已对接 Worker)。

---

部署 URL:`https://okad-unified.YOUR-SUBDOMAIN.workers.dev`