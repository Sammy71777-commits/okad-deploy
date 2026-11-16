# 🗄️ OKAD 数据库 — Cloudflare D1 (B 方案)

> OKAD 使用 **Cloudflare D1**(SQLite 兼容)作为唯一数据存储。  
> 通过 Worker `/api/db/{table}` REST 接口访问,**无需** Supabase。

---

## 5 张表

| 表 | 主键 | 字段数 | 用途 |
|---|---|---|---|
| `users` | email (TEXT COLLATE NOCASE) | 17 | 注册用户 + KYC |
| `orders` | id | 8 | 订单 + 完整货物信息(JSON) |
| `cooperation` | id | 4 | 商务合作询盘 |
| `kyc_logs` | id | 6 | KYC 审计日志 |
| `fx_snapshots` | id (AUTOINCREMENT) | 5 | 汇率历史快照(可选) |

---

## 创建 + 初始化

### 方法 1 — 一键脚本(推荐)

```bash
cd /workspace/deploy/ai-worker
bash setup.sh
```

脚本自动:
1. `wrangler d1 create okad-db` → 拿到 database_id
2. 写入 `wrangler.toml`
3. `wrangler d1 execute okad-db --file=../db/schema-d1.sql --remote`
4. 部署 Worker

### 方法 2 — 手动命令

```bash
# 1. 创建数据库
wrangler d1 create okad-db
# 输出包含 database_id,粘贴到 wrangler.toml

# 2. 初始化(本地)
wrangler d1 execute okad-db --file=./schema-d1.sql

# 3. 初始化(远程/生产)
wrangler d1 execute okad-db --file=./schema-d1.sql --remote

# 4. 验证
wrangler d1 execute okad-db --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table'"
```

应该看到:
```
cooperation
fx_snapshots
kyc_logs
orders
users
```

### 方法 3 — Cloudflare Dashboard

1. 登录 https://dash.cloudflare.com
2. 左侧 → **Workers & Pages** → **D1** → **Create database**
3. 命名 `okad-db` → Region 选 **APAC**
4. 进入数据库 → **Console** → 粘贴 `schema-d1.sql` → **Execute**

---

## Worker 暴露的 REST API

### GET — 查询

```bash
# 单条
curl https://okad-unified.XXX.workers.dev/api/db/users?email=foo@bar.com

# 多条件
curl "https://okad-unified.XXX.workers.dev/api/db/orders?user_email=foo@bar.com&order=created_at.desc&limit=10"

# 列表
curl "https://okad-unified.XXX.workers.dev/api/db/users?order=reg_ts.desc&limit=50"
```

返回:
```json
{
  "ok": true,
  "rows": [...],
  "count": 1
}
```

### POST — Upsert (插入或更新)

```bash
curl -X POST https://okad-unified.XXX.workers.dev/api/db/users \
  -H "Content-Type: application/json" \
  -d '{
    "email": "foo@bar.com",
    "name": "Alice",
    "phone": "+233241234567",
    "country": "Ghana",
    "kyc_status": "pending"
  }'
```

返回:
```json
{ "ok": true, "action": "upserted", "pk": "foo@bar.com" }
```

> Worker 自动用 `ON CONFLICT(email) DO UPDATE` 实现 — 重复 POST 不会报错,会更新。

### PATCH — 部分更新

```bash
curl -X PATCH "https://okad-unified.XXX.workers.dev/api/db/users?email=foo@bar.com" \
  -H "Content-Type: application/json" \
  -d '{ "kyc_status": "approved", "kyc_reason": "verified docs" }'
```

返回:
```json
{ "ok": true, "action": "updated", "changes": 1 }
```

### DELETE — 删除

```bash
curl -X DELETE "https://okad-unified.XXX.workers.dev/api/db/users?email=foo@bar.com"
```

返回:
```json
{ "ok": true, "action": "deleted", "changes": 1 }
```

---

## 字段白名单(防注入)

Worker 只接受以下字段。**额外字段会被忽略**:

```js
users:        email, name, phone, country, id_type, id_number, ip,
              kyc_status, kyc_reason, kyc_ts, kyc_by,
              reg_ts, last_login, orders_count, total_spent
orders:       id, user_email, data, status, amount, currency,
              created_at, updated_at
cooperation:  id, data, status, created_at
kyc_logs:     id, user_email, action, reason, operator, created_at
fx_snapshots: id, base, rates_json, source, cached, created_at
```

---

## 数据迁移(从 localStorage)

在 OKAD Admin → AI Tab → 点 **⬆️ Sync Local → Cloud** 按钮,前端会自动:

1. 读 localStorage 里所有用户/订单/询盘
2. 批量 POST 到 Worker
3. Worker upsert 到 D1

**反方向**:点 **⬇️ Pull Cloud → Local** → Worker 查 D1 → 写回 localStorage(用于换设备)

---

## 数据备份

### 自动备份(推荐开启)

D1 默认每日自动备份,保留 7 天。Cloudflare Pro 账号可延长到 30 天。

### 手动备份(导出全表)

```bash
# 导出所有 users
wrangler d1 execute okad-db --remote \
  --command="SELECT * FROM users" --json > users-backup.json

# 备份所有表
for table in users orders cooperation kyc_logs; do
  wrangler d1 execute okad-db --remote \
    --command="SELECT * FROM $table" --json > "$table-backup.json"
done
```

### 从备份恢复

```bash
wrangler d1 execute okad-db --remote --file=restore.sql
```

其中 restore.sql 是 `INSERT INTO users ...` 格式。

---

## 常见问题

**Q: 数据库文件大小上限?**  
A: D1 免费版 5GB。OKAD 单条记录 < 10KB,够存 50 万用户。

**Q: 索引在哪里?**  
A: schema-d1.sql 里已建好(email、status、created_at 等常用查询字段)。

**Q: 外键约束?**  
A: `PRAGMA foreign_keys = ON` 在 schema 顶部开启。删除 user 时,orders 会 cascade 删除。

**Q: 性能?**  
A: 单表 < 1万条查询 < 5ms。D1 在 Cloudflare 内网,比 Supabase 跨网络快。

**Q: 多管理员同时写?**  
A: SQLite 是文件锁。OKAD 是单租户运营,冲突概率极低,无需额外处理。

---

## 完整 Schema

看 [`schema-d1.sql`](./schema-d1.sql) 117 行,带中文注释。