#!/bin/bash
# ========================================================
#  OKAD AFRICA 全自动部署到 Cloudflare Pages
#  用法:
#    1) 去 https://dash.cloudflare.com/profile/api-tokens 创建 token
#       模板选 "Edit Cloudflare Pages"
#    2) export CF_API_TOKEN=你的token
#       export CF_ACCOUNT_ID=你的account_id(在域名overview页右栏)
#    3) bash auto_deploy.sh
# ========================================================

set -e
PROJECT="okad-africa"

echo "=== OKAD AFRICA 全自动部署 ==="

if [ -z "$CF_API_TOKEN" ] || [ -z "$CF_ACCOUNT_ID" ]; then
  echo ""
  echo "❌ 需要 Cloudflare 凭证:"
  echo ""
  echo "   1) 注册 Cloudflare(免费): https://dash.cloudflare.com/sign-up"
  echo "   2) 创建 API Token: https://dash.cloudflare.com/profile/api-tokens"
  echo "      点 'Create Token' → 模板 'Edit Cloudflare Pages'"
  echo "   3) 复制 Account ID(域名页右栏)"
  echo ""
  echo "   然后运行:"
  echo "   export CF_API_TOKEN=你的token"
  echo "   export CF_ACCOUNT_ID=你的account_id"
  echo "   bash auto_deploy.sh"
  echo ""
  exit 1
fi

# 准备部署包
echo "📦 准备部署包..."
mkdir -p /tmp/okad-deploy
cp /workspace/index.html /workspace/landing.html /workspace/vercel.json /tmp/okad-deploy/
ls /tmp/okad-deploy/

# 检查项目是否已存在
echo "🔍 检查项目是否存在..."
EXIST=$(curl -s -X GET \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects/$PROJECT" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json")

if echo "$EXIST" | grep -q '"success":true'; then
  echo "✓ 项目 $PROJECT 已存在,直接部署..."
  DEPLOY_URL="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects/$PROJECT/deployments"
else
  echo "📝 创建项目 $PROJECT..."
  CREATE=$(curl -s -X POST \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"name\":\"$PROJECT\",\"production_branch\":\"main\",\"build_config\":{\"root_dir\":\"/tmp/okad-deploy\",\"build_command\":\"\",\"destination_dir\":\".\"}}")
  if echo "$CREATE" | grep -q '"success":true'; then
    echo "✓ 项目创建成功"
  else
    echo "❌ 创建失败: $CREATE"
    exit 1
  fi
fi

echo "🚀 部署中..."
RESP=$(curl -s -X POST \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -F "manifest={\"production_branch\":\"main\",\"build_config\":{\"root_dir\":\"/tmp/okad-deploy\",\"build_command\":\"\",\"destination_dir\":\".\"}};type=application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects/$PROJECT/deployments")

echo "$RESP" | head -c 500
echo ""

DEPLOY_ID=$(echo "$RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$DEPLOY_ID" ]; then
  echo ""
  echo "✓ 部署成功!"
  echo "🌐 你的网站:"
  echo "   https://$PROJECT.pages.dev"
  echo ""
  echo "📊 部署ID: $DEPLOY_ID"
fi