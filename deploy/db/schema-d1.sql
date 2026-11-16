-- ============================================================
--   OKAD Africa — Cloudflare D1 Schema (SQLite)
-- ============================================================
-- 全 Cloudflare 方案 — D1 替代 Supabase PostgreSQL
--
-- 部署方法(2 选 1):
--   方案 1: wrangler d1 execute okad-db --file=./schema-d1.sql --remote
--   方案 2: Cloudflare Dashboard → D1 → Create database → Console → 粘贴执行
--
-- 数据库名: okad-db
-- 创建命令: wrangler d1 create okad-db
-- ============================================================

-- 启用外键约束(D1 默认关闭)
PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. users (注册用户 + KYC 信息)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,                       -- 应用层生成 UUID
  email        TEXT UNIQUE NOT NULL COLLATE NOCASE,    -- 大小写不敏感
  name         TEXT DEFAULT '',
  phone        TEXT DEFAULT '',
  country      TEXT DEFAULT '',
  id_type      TEXT DEFAULT 'national_id',
  id_number    TEXT DEFAULT '',
  ip           TEXT DEFAULT '',
  kyc_status   TEXT DEFAULT 'pending',                  -- pending|approved|rejected|resubmit
  kyc_reason   TEXT DEFAULT '',
  kyc_ts       INTEGER DEFAULT 0,                      -- Unix ms
  kyc_by       TEXT DEFAULT '',
  reg_ts       INTEGER,                                -- Unix ms
  last_login   INTEGER,                                -- Unix ms
  orders_count INTEGER DEFAULT 0,
  total_spent  REAL DEFAULT 0,
  created_at   INTEGER DEFAULT (unixepoch() * 1000)    -- Unix ms
);

CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_kyc_status  ON users(kyc_status);
CREATE INDEX IF NOT EXISTS idx_users_reg_ts      ON users(reg_ts DESC);
CREATE INDEX IF NOT EXISTS idx_users_phone       ON users(phone);

-- ============================================================
-- 2. orders (订单 + 完整货物信息)
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,                        -- OKAD 业务订单号,用户可见
  user_email  TEXT COLLATE NOCASE,
  data        TEXT NOT NULL,                    -- JSON.stringify(order)
  status      TEXT DEFAULT 'review_pending',   -- review_pending|paid|shipped|completed|cancelled
  amount      REAL DEFAULT 0,                  -- 冗余字段,便于统计
  currency    TEXT DEFAULT 'USD',
  created_at  INTEGER DEFAULT (unixepoch() * 1000),
  updated_at  INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_orders_user      ON orders(user_email);
CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created   ON orders(created_at DESC);

-- ============================================================
-- 3. cooperation (商务合作询盘)
-- ============================================================
CREATE TABLE IF NOT EXISTS cooperation (
  id          TEXT PRIMARY KEY,
  data        TEXT NOT NULL,                    -- JSON.stringify(inquiry)
  status      TEXT DEFAULT 'new',               -- new|contacted|rejected|partner
  created_at  INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_cooperation_created ON cooperation(created_at DESC);

-- ============================================================
-- 4. kyc_logs (KYC 审核审计日志)
-- ============================================================
CREATE TABLE IF NOT EXISTS kyc_logs (
  id          TEXT PRIMARY KEY,                  -- 应用层生成 UUID
  user_email  TEXT COLLATE NOCASE,
  action      TEXT NOT NULL,                     -- approved|rejected|resubmit|pending
  reason      TEXT DEFAULT '',
  operator    TEXT DEFAULT 'admin',
  created_at  INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_kyc_logs_user    ON kyc_logs(user_email);
CREATE INDEX IF NOT EXISTS idx_kyc_logs_created ON kyc_logs(created_at DESC);

-- ============================================================
-- 5. fx_snapshots (汇率历史快照,可选,用于以后画汇率走势图)
-- ============================================================
CREATE TABLE IF NOT EXISTS fx_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  base        TEXT DEFAULT 'USD',
  rates_json  TEXT NOT NULL,                     -- JSON.stringify(rates)
  source      TEXT DEFAULT 'open.er-api.com',
  cached      INTEGER DEFAULT 0,                 -- 0=实时,1=缓存
  created_at  INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_fx_created ON fx_snapshots(created_at DESC);

-- ============================================================
-- 6. config (站点配置: WhatsApp 号码、推荐码、联系方式等)
-- ============================================================
CREATE TABLE IF NOT EXISTS config (
  key         TEXT PRIMARY KEY,                   -- 'site' = 全站配置
  data        TEXT NOT NULL                       -- JSON.stringify({whatsapp:{...}, referral:{...}, contact:{...}})
);

-- 默认配置数据
INSERT OR IGNORE INTO config (key, data) VALUES ('site', '{"whatsapp":{"number":"233505615533","label":"Chat on WhatsApp","text":"Hello OKAD AFRICA, I want a shipping quote from China to Africa."},"referral":{"code":"OKAD-NEW10","reward":"$10","title":"Share OKAD & Earn $10","desc":"Invite friends — they get $10 off first order, you earn $10 credit"},"contact":{"email":"support@okad.africa","hours":"Mon-Fri 9:00-18:00 GMT"}}');

-- ============================================================
-- Done! Verify with:
-- ============================================================
-- SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
-- 应该看到 6 张表: config / cooperation / fx_snapshots / kyc_logs / orders / users

-- ============================================================
-- 关键差异(对比 PostgreSQL schema):
-- ============================================================
-- 1. uuid PRIMARY KEY → TEXT PRIMARY KEY (应用层用 crypto.randomUUID())
-- 2. jsonb → TEXT (JSON 序列化)
-- 3. timestamptz → INTEGER (毫秒时间戳)
-- 4. boolean → INTEGER (0/1)
-- 5. on delete cascade → 需要先 PRAGMA foreign_keys=ON
-- 6. 不需要 RLS + grant — D1 通过 Worker 访问,权限在 Worker 层控制
-- 7. 大小写不敏感邮箱 — 用 COLLATE NOCASE

-- ============================================================
-- 旧数据迁移(从 Supabase 导出的):
-- ============================================================
-- INSERT INTO users (id, email, name, ...) VALUES (...);
-- INSERT INTO orders (id, user_email, data, status) VALUES (..., json(data));
-- 或者在 Admin → AI Tab → Sync Local → Cloud 一键完成