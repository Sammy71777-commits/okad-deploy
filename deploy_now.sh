#!/bin/bash
# ========================================================
#  OKAD AFRICA — 一键部署 (Worker + Pages)
#  用法:
#    export CLOUDFLARE_API_TOKEN=你的token
#    bash deploy_now.sh
#  Token 权限: Workers Scripts:Edit + Pages:Edit + D1:Edit
#  创建地址: https://dash.cloudflare.com/profile/api-tokens
#             模板 "Edit Cloudflare Workers" 或 自定义权限
# ========================================================
set -e
cd /workspace

ACCOUNT_ID="252c97d55b93ab211e9836a0893e0566"
PROJECT="okad-africa"

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "❌ 请先设置 token:"
  echo "   export CLOUDFLARE_API_TOKEN=你的token"
  exit 1
fi
export CLOUDFLARE_API_TOKEN

echo "=== 1/2 部署 Worker (shrill-wave-7c04) ==="
npx wrangler deploy --config wrangler.toml 2>&1 | tail -12

echo ""
echo "=== 2/2 部署 Pages (${PROJECT}) ==="
# ⚠️ 必须用 wrangler CLI,不要用裸 multipart API:
#    API 的 manifest 若缺 assets 字段(路径->sha256 映射),
#    Cloudflare 会"部署成功"但实际收录 0 个文件 —— 线上毫无变化,
#    且 API 返回里 files=0,专属部署 URL 直接 404。
#    wrangler 会自动算 sha256 并生成正确的 manifest。
CLOUDFLARE_ACCOUNT_ID="${ACCOUNT_ID}" \
npx wrangler pages deploy deploy \
  --project-name "${PROJECT}" \
  --branch main \
  --commit-dirty=true 2>&1 | tail -8

echo ""
echo "✓ 部署完成!"
echo "🌐 https://okadafrica.com"
