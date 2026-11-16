#!/bin/bash
# ============================================================
#   OKAD Worker 一键部署脚本 (Mac)
# ============================================================
#   用法：
#     1. 下载这个文件到桌面
#     2. 打开终端（Terminal）
#     3. 拖这个文件到终端窗口，按回车
#     4. 浏览器弹窗点 Allow，等 2 分钟
# ============================================================

set -e

echo ""
echo "============================================"
echo "  OKAD Worker 一键部署"
echo "============================================"
echo ""
echo "这个脚本会自动："
echo "  1. 安装 wrangler（Cloudflare 部署工具）"
echo "  2. 登录你的 Cloudflare 账号（浏览器弹窗点 Allow）"
echo "  3. 下载 worker.js 代码"
echo "  4. 配置 D1 数据库绑定"
echo "  5. 设置 OpenRouter API Key"
echo "  6. 部署到 Cloudflare"
echo ""
echo "你只需要：拖这个文件到终端 → 按回车 → 浏览器弹窗点 Allow → 等 2 分钟"
echo ""
read -p "按回车继续..."

echo ""
echo "[1/6] 检查 Node.js..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js 未安装！"
    echo "请先去 https://nodejs.org 下载安装 LTS 版本"
    echo "安装完关闭终端，重新拖这个文件运行"
    read -p "按回车退出..."
    exit 1
fi
echo "✅ Node.js 已安装: $(node --version)"

echo ""
echo "[2/6] 安装 wrangler..."
npm install -g wrangler
echo "✅ wrangler 安装完成"

echo ""
echo "[3/6] 登录 Cloudflare（浏览器会弹窗，请点 Allow）..."
wrangler login
echo "✅ 登录成功"

echo ""
echo "[4/6] 创建项目目录..."
mkdir -p ~/okad-deploy
cd ~/okad-deploy

echo ""
echo "[5/6] 下载 worker.js..."
curl -L -o worker.js "https://a830e4ff7cb85da66.sg.agentos-app.run/code-helper.html" || {
    echo "⚠️ 下载失败"
    echo "请手动复制 worker.js 代码到 ~/okad-deploy/ 目录"
    read -p "按回车继续..."
}

echo ""
echo "[6/6] 配置并部署..."

cat > wrangler.toml << 'EOF'
name = "shrril-wave-7c04"
main = "worker.js"
compatibility_date = "2026-01-15"

[[d1_databases]]
binding = "DB"
database_name = "okad-db"
database_id = "021adffc-4517-451f-9c76-e2955ad1bdb4"
EOF

echo "设置 API Key..."
echo "<YOUR_OPENROUTER_API_KEY>" | wrangler secret put OPENROUTER_API_KEY

echo "部署中..."
wrangler deploy

echo ""
echo "============================================"
echo "  🎉 部署完成！"
echo "============================================"
echo ""
echo "请访问以下链接验证："
echo "  https://shrril-wave-7c04.sammy71777.workers.dev/"
echo ""
echo "如果显示 {\"ok\":true,\"muse_configured\":true,\"db_configured\":true}"
echo "说明部署成功！"
echo ""
read -p "按回车退出..."
