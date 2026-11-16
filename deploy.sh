#!/bin/bash
# ========================================================
#  OKAD AFRICA 一键部署到 Vercel
#  用法: bash deploy.sh
# ========================================================

set -e
echo "========================================="
echo "  OKAD AFRICA · Vercel 部署脚本"
echo "========================================="

# 检查Node
if ! command -v node &> /dev/null; then
  echo "❌ Node.js 未安装 → https://nodejs.org"
  exit 1
fi
echo "✓ Node.js $(node -v)"

# 检查/安装Vercel CLI
if ! command -v vercel &> /dev/null; then
  echo "📦 安装 Vercel CLI..."
  npm i -g vercel
fi
echo "✓ Vercel CLI $(vercel --version)"

# 进入工作目录
cd "$(dirname "$0")"

# 准备index.html
if [ ! -f "index.html" ]; then
  echo "📋 生成 index.html..."
  cp okad_africa_app.html index.html
fi

# 登录
echo ""
echo "🔐 首次部署需要登录 Vercel 账号"
echo "   (没有账号? → https://vercel.com/signup 免费注册)"
echo ""
vercel login

# 部署
echo ""
echo "🚀 部署到生产环境..."
vercel --prod --yes

echo ""
echo "========================================="
echo "  ✅ 部署完成!"
echo "  📋 访问后台:"
echo "     1. 打开你获得的域名(形如 https://okad-africa.vercel.app)"
echo "     2. 连点 logo 5次 → 进入后台"
echo "     3. Analytics Tab 即可看到实时数据"
echo "========================================="