#!/usr/bin/env bash
# ============================================================
#   OKAD Worker 一键部署脚本 (B 方案 - 全 Cloudflare)
# ============================================================
#   支持两种登录模式:
#     模式 A (推荐): export CLOUDFLARE_API_TOKEN=xxx → 全自动
#     模式 B (传统): wrangler login → 浏览器 OAuth
#
#   跑这个脚本前,确保以下环境变量已设置:
#     - CLOUDFLARE_API_TOKEN      (Worker 部署 + D1)
#     - OPENROUTER_API_KEY        (AI 图像)
#     - RESEND_API_KEY            (邮件验证码, 可选)
#     - AFRICASTALKING_API_KEY    (SMS 验证码, 可选)
#
#   用法:
#     bash setup.sh                # 自动检测模式
#     bash setup.sh --dry-run      # 只校验, 不真跑
# ============================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

echo ""
echo -e "${GREEN}🚀 OKAD Worker 一键部署${NC}"
echo "================================"
echo ""

# -----------------------------------------------
# 0. Dry-run 标记
# -----------------------------------------------
if $DRY_RUN; then
  echo -e "${CYAN}🔍 DRY-RUN 模式: 只校验不执行${NC}"
  echo ""
fi

# -----------------------------------------------
# 1. 登录检查 (支持 token / login 两种模式)
# -----------------------------------------------
echo -e "${YELLOW}[1/6] 检查 Cloudflare 认证...${NC}"

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo -e "${GREEN}✅ 使用 API Token 模式 (免 OAuth)${NC}"
  echo "    Token: ${CLOUDFLARE_API_TOKEN:0:12}...${CLOUDFLARE_API_TOKEN: -4}"
  export CLOUDFLARE_API_TOKEN
elif wrangler whoami 2>&1 | grep -q "not authenticated"; then
  echo -e "${RED}❌ 未登录。请选择以下方式之一:${NC}"
  echo ""
  echo "   方式 A (推荐, 无需浏览器):"
  echo "     1. Cloudflare Dashboard → My Profile → API Tokens"
  echo "     2. Create Token → Edit Cloudflare Workers template"
  echo "     3. 加上 Account — D1: Edit 权限"
  echo "     4. 复制 token,然后:"
  echo "        export CLOUDFLARE_API_TOKEN=你的token"
  echo "        bash setup.sh"
  echo ""
  echo "   方式 B (需要浏览器):"
  echo "        wrangler login"
  exit 1
else
  echo -e "${GREEN}✅ wrangler 已登录${NC}"
fi

# -----------------------------------------------
# 2. 准备 wrangler.toml
# -----------------------------------------------
echo ""
echo -e "${YELLOW}[2/6] 准备 wrangler.toml...${NC}"

if [ ! -f wrangler.toml ] && [ -f wrangler.toml.example ]; then
  cp wrangler.toml.example wrangler.toml
  echo -e "${GREEN}✅ 从 .example 复制 wrangler.toml${NC}"
fi

if ! $DRY_RUN; then
  # 尝试自动获取 D1 database_id
  DB_ID=$(wrangler d1 list --json 2>/dev/null | python3.11 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for db in data:
        if db.get('name') == 'okad-db':
            print(db.get('uuid',''))
            break
except: pass
" 2>/dev/null || echo "")

  # 创建 D1 (如果不存在)
  if [ -z "$DB_ID" ]; then
    echo -e "    创建 D1 数据库 okad-db ..."
    DB_ID=$(wrangler d1 create okad-db 2>&1 | python3.11 -c "
import sys, re
out = sys.stdin.read()
m = re.search(r'database_id = \"([a-f0-9-]+)\"', out) or re.search(r'\"uuid\":\s*\"([a-f0-9-]+)\"', out)
print(m.group(1) if m else '')
" || echo "")
  fi

  if [ -n "$DB_ID" ]; then
    sed -i "s/database_id = \"REPLACE_WITH_YOUR_D1_ID\"/database_id = \"$DB_ID\"/" wrangler.toml
    echo -e "${GREEN}✅ D1 database_id: ${DB_ID}${NC}"
  else
    echo -e "${YELLOW}⚠️  无法自动获取 database_id,请手动填入 wrangler.toml${NC}"
  fi
fi

# -----------------------------------------------
# 3. 跑 schema 创建表
# -----------------------------------------------
echo ""
echo -e "${YELLOW}[3/6] 跑 D1 schema...${NC}"
SCHEMA_FILE="../db/schema-d1.sql"
[ ! -f "$SCHEMA_FILE" ] && SCHEMA_FILE="../../db/schema-d1.sql"
echo "    Schema: $SCHEMA_FILE"

if ! $DRY_RUN && [ -n "$DB_ID" ]; then
  wrangler d1 execute okad-db --file="$SCHEMA_FILE" --remote
  echo -e "${GREEN}✅ 5 张表创建完成${NC}"
else
  echo -e "${CYAN}    ⏭️  跳过 (dry-run 或无 D1 ID)${NC}"
fi

# -----------------------------------------------
# 4. 设置 Secrets (从环境变量读取)
# -----------------------------------------------
echo ""
echo -e "${YELLOW}[4/6] 设置 Secrets...${NC}"

set_secret() {
  local name=$1
  local env_var=$2
  local desc=$3
  local required=$4

  local val="${!env_var:-}"

  if [ -n "$val" ]; then
    echo -e "    ${desc}: ${GREEN}${val:0:8}...${NC}"
    if ! $DRY_RUN; then
      echo "$val" | wrangler secret put "$name" 2>/dev/null
      echo -e "    ${GREEN}✅ $name 已设置${NC}"
    fi
  else
    if [ "$required" = "true" ]; then
      echo -e "    ${RED}❌ $env_var 未提供 (必需)${NC}"
    else
      echo -e "    ${YELLOW}⏭️  $env_var 未提供 (可选)${NC}"
    fi
  fi
}

set_secret "OPENROUTER_API_KEY" "OPENROUTER_API_KEY" "OpenRouter    (AI 图像)"       "true"
set_secret "RESEND_API_KEY"     "RESEND_API_KEY"     "Resend        (邮箱验证码)" "false"
set_secret "AFRICASTALKING_API_KEY" "AFRICASTALKING_API_KEY" "Africa's Talking (SMS 验证码)" "false"

# -----------------------------------------------
# 5. 部署 Worker
# -----------------------------------------------
echo ""
echo -e "${YELLOW}[5/6] 部署 Worker...${NC}"

if $DRY_RUN; then
  echo -e "${CYAN}    ⏭️  dry-run 跳过部署${NC}"
else
  wrangler deploy
fi

# -----------------------------------------------
# 6. 提取 URL
# -----------------------------------------------
echo ""
echo -e "${YELLOW}[6/6] 提取 Worker URL...${NC}"

if ! $DRY_RUN; then
  DEPLOY_OUTPUT=$(wrangler deploy 2>&1 || true)
  WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' | head -1)
  if [ -n "$WORKER_URL" ]; then
    echo -e "${GREEN}✅ Worker URL: $WORKER_URL${NC}"
    echo ""
    echo "测试健康检查:"
    echo "  curl $WORKER_URL/"
  fi
fi

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}✅ 部署完成!${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
echo "下一步:"
echo "  1. 复制 Worker URL (上面或 wrangler deploy 输出里)"
echo "  2. OKAD Admin → AI Tab → 粘贴 → 取消 Demo Mode → Save"
echo "  3. 点 ⬆️ Sync Local → Cloud 推送数据"
echo ""
echo "快捷测试命令:"
echo "  curl https://你的URL/                        # 健康检查"
echo "  curl https://你的URL/api/exchange-rates      # 实时汇率"
echo ""