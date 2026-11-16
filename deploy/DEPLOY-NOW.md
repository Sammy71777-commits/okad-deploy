# 🚀 OKAD 全 Cloudflare 一键部署 — 15 分钟,$0/月

> **B 方案**:1 个 Cloudflare 账号 + 1 个 Worker = 4 个外部服务 + 数据库 + 静态托管
>
> ✅ AI 图像生成 / ✅ 邮箱验证 / ✅ SMS 验证 / ✅ 实时汇率 / ✅ D1 数据库  
> **总耗时**:15 分钟 | **月成本**:**$0**

---

## 为什么 B 方案最佳

```
┌─────────────────────────────────────────────┐
│  Cloudflare 一家架构            │
│  ├─ Worker (免费 10万请求/天) │
│  │  ├─ /api/muse        → OpenRouter AI
│  │  ├─ /api/email-code  → Resend
│  │  ├─ /api/sms-code    → Africa's Talking
│  │  ├─ /api/exchange-rates → 双源 FX
│  │  └─ /api/db/{table}  → D1 (本文件)
│  ├─ D1 数据库 (5GB 免费)         │
│  └─ Pages (静态托管)          │
└─────────────────────────────────────────────┘
```

vs A 方案:GitHub + Cloudflare + Supabase = 3 个平台,3 套密码  
vs B 方案:1 个 Cloudflare = 1 个 dashboard 管所有

---

## 极简部署 — 3 步

### Step 1 — 注册账号 (5 分钟)

只需要注册 2 个账号:

| 服务 | 用途 | URL | 备注 |
|---|---|---|---|
| **Cloudflare** | Worker + D1 + 托管 | https://dash.cloudflare.com/sign-up | 免费,无需绑卡 |
| **OpenRouter** | AI 图像生成 | https://openrouter.ai | 充值 $5(够用 3 个月) |

可选(没配也能用,DEMO 码 888888):
- **Resend**: https://resend.com (邮箱验证)
- **Africa's Talking**: https://africastalking.com (SMS 验证)

---

### Step 2 — 一键部署脚本 (5 分钟)

```bash
cd /workspace/deploy/ai-worker
wrangler login                                  # 打开浏览器登录 Cloudflare
bash setup.sh                                   # 自动化:创建 D1 → 跑 schema → 设 key → 部署
```

**脚本会问你:**
1. OpenRouter API key (粘贴 `sk-or-v1-...`)
2. Resend API key (可选,跳过回车)
3. Africa's Talking API key (可选,跳过回车)

**脚本会自动:**
1. ✅ 创建 D1 数据库 `okad-db`
2. ✅ 跑 `schema-d1.sql` 创建 5 张表
3. ✅ 把 `database_id` 填入 `wrangler.toml`
4. ✅ 加密保存 3 个 Secret
5. ✅ 部署 Worker

**完成输出:**
```
✅ 部署完成!
Worker URL: https://okad-unified.你的子域.workers.dev
```

---

### Step 3 — OKAD 后台填配置 (2 分钟)

1. 打开 OKAD 网站 → 访问 `#admin` → 密码 `okad@2026`
2. **AI Tab** → 粘贴 Worker URL → 取消勾选 **Force Demo Mode** → **Save**
3. 点 **🔌 Test Connection** → 看到 `Worker + D1 connected!`
4. 点 **⬆️ Sync Local → Cloud** → 数据自动上云
5. 完成 ✅

---

## 已就绪的文件清单

```
/workspace/
├── ai-worker/                   # Cloudflare Worker (统一后端)
│   ├── worker.js              # 4 路由 + D1 CRUD (687 行)
│   ├── wrangler.toml.example  # D1 binding 配置模板
│   ├── setup.sh               # 一键部署脚本
│   ├── package.json           # npm 元数据
│   ├── README.md              # 完整文档
│   └── README-EN.md           # 英文版
├── db/                         # 数据库
│   ├── schema-d1.sql          # D1 (SQLite) 兼容版
│   ├── schema.sql             # 旧版 (Supabase,已弃用)
│   └── README.md
├── DEPLOY-NOW.md               # 本文件
├── index.html                  # 前端(同步)
├── okad_africa_app.html        # 主前端(6577 行)
└── ...                       # 图标、manifest 等
```

---

## 4 个路由一览

### `POST /api/muse` — AI 图像生成
```bash
curl -X POST https://okad-unified.XXX.workers.dev/api/muse \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A premium shea butter jar on marble background","userId":"user@email.com"}'
```
→ `{ image: "data:image/png;base64,..." }`

### `POST /api/email-code` — 邮箱 6 位验证码
```bash
curl -X POST https://okad-unified.XXX.workers.dev/api/email-code \
  -H "Content-Type: application/json" \
  -d '{"email":"user@email.com"}'
```
→ `{ ok:true, mock:false, message_id:"..." }`

### `POST /api/sms-code` — SMS 6 位验证码
```bash
curl -X POST https://okad-unified.XXX.workers.dev/api/sms-code \
  -H "Content-Type: application/json" \
  -d '{"phone":"+233241234567"}'
```
→ `{ ok:true, mock:false }` (沙盒模式自动成功)

### `GET /api/exchange-rates` — 实时汇率
```bash
curl https://okad-unified.XXX.workers.dev/api/exchange-rates
```
→ `{ base:"USD", rates:{GHS,NGN,KES,ZAR,EGP,TZS,UGX,XOF,MAD,CNY,EUR,GBP,USD}, source:"open.er-api.com", cached:false }`

---

## D1 数据库 5 张表

| 表 | 用途 | 主键 |
|---|---|---|
| **users** | 注册用户 + KYC | email |
| **orders** | 订单 + 完整货物信息 | id |
| **cooperation** | 商务合作询盘 | id |
| **kyc_logs** | KYC 审核审计日志 | id |
| **fx_snapshots** | 汇率历史快照(预留) | id |

D1 通过 Worker 暴露 REST 接口:

```
GET    /api/db/users?email=foo@bar.com          → 查询
GET    /api/db/users?order=reg_ts.desc&limit=50 → 列表
POST   /api/db/users    { email, name, ... }    → upsert by email
PATCH  /api/db/users?email=foo@bar.com  {...}   → 部分更新
DELETE /api/db/users?email=foo@bar.com          → 删除
```

同样的格式适用于所有 4 张业务表。

---

## 💰 成本明细

| 服务 | 免费额度 | 实际消耗(50 客户/天) | 月成本 |
|---|---|---|---|
| Cloudflare Workers | 100,000 请求/天 | ~5,000/天 | **$0** |
| Cloudflare D1 | 5GB 存储 | <50MB | **$0** |
| OpenRouter Meta Muse | $5 一次性 | 50 张/天 = $0.50/天 | **$15/月** |
| Resend Email | 100/天 | 50/天 | **$0** |
| Africa's Talking | 沙盒免费 | 50 SMS/天(沙盒) | **$0** |
| **合计** | | | **$15/月** |

降本建议:生产 SMS 模式(~38/月)才需要付费。沙盒模式下 $0。

---

## 🆘 故障排查

**Q: 部署后访问 Worker URL 报 404?**  
A: 检查 `path` 拼写。Worker 默认路由:`/api/muse`, `/api/email-code`, `/api/sms-code`, `/api/exchange-rates`, `/api/db/{table}`。

**Q: D1 操作报 "D1 database binding (DB) not configured"?**  
A: `wrangler.toml` 里的 `database_id` 没填。跑 `wrangler d1 list` 拿到 ID,粘贴进去,重新 `wrangler deploy`。

**Q: 测试连接提示 "✗ HTTP 503"?**  
A: 大概率 D1 没绑。检查 Worker → Settings → Bindings → 应该有 D1 一项,binding name = `DB`。

**Q: 同步数据失败?**  
A: DevTools Console 看具体错误。常见原因:Worker URL 错 / D1 没建表 / 表名字大小写。

**Q: schema 已建但 worker 报错 "no such table"?**  
A: `--remote` 标志可能漏了。`wrangler d1 execute okad-db --file=./schema-d1.sql --remote`

---

## 🎉 完成后可以做的事

| 功能 | 测试方法 |
|---|---|
| 邮箱注册 | 用真实邮箱注册 → 查收 6 位码 |
| SMS 注册 | 用 `+233241234567` 注册 → 查 SMS |
| AI 产品图 | 首页 🎨 AI Image → 输入提示词 |
| 实时汇率 | Admin → AI Tab → 看到 11 种货币 |
| 数据云端 | Admin → Sync Local → Cloud |
| 多设备同步 | 另一台浏览器打开 Admin → Pull Cloud → Local |
| 用户审核 | Admin → KYC Tab → 看到所有注册用户 |
| 订单管理 | Admin → Orders Tab → 看每笔订单详情 |
| 询盘管理 | Admin → Cooperation Tab → 商务合作 |

**任何步骤卡住?** 打开 Admin → AI Tab → 🔌 Test Connection 自动诊断。

---

部署 URL 示例:`https://okad-unified.你的子域.workers.dev`  
访问 `https://okad-unified.你的子域.workers.dev/` 看健康检查 JSON。