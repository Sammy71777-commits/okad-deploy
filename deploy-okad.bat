@echo off
chcp 65001 >nul
title OKAD Worker 一键部署
color 0B

echo ============================================
echo   OKAD Worker 一键部署脚本
echo ============================================
echo.
echo 这个脚本会自动：
echo   1. 安装 wrangler（Cloudflare 部署工具）
echo   2. 登录你的 Cloudflare 账号（浏览器弹窗点 Allow）
echo   3. 下载 worker.js 代码
echo   4. 配置 D1 数据库绑定
echo   5. 设置 OpenRouter API Key
echo   6. 部署到 Cloudflare
echo.
echo 你只需要：双击这个文件 → 浏览器弹窗点 Allow → 等 2 分钟
echo.
pause

echo.
echo [1/6] 检查 Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js 未安装！
    echo 请先去 https://nodejs.org 下载安装 LTS 版本
    echo 安装完关闭这个窗口，重新双击运行
    pause
    exit /b 1
)
echo ✅ Node.js 已安装

echo.
echo [2/6] 安装 wrangler...
npm install -g wrangler
if errorlevel 1 (
    echo ❌ wrangler 安装失败
    pause
    exit /b 1
)
echo ✅ wrangler 安装完成

echo.
echo [3/6] 登录 Cloudflare（浏览器会弹窗，请点 Allow）...
wrangler login
if errorlevel 1 (
    echo ❌ 登录失败
    pause
    exit /b 1
)
echo ✅ 登录成功

echo.
echo [4/6] 创建项目目录...
mkdir okad-deploy 2>nul
cd okad-deploy

echo.
echo [5/6] 下载 worker.js...
curl -L -o worker.js "https://raw.githubusercontent.com/okad-africa/okad-worker/main/worker.js"
if errorlevel 1 (
    echo ⚠️ 下载失败，使用备用方式...
    echo 请手动复制 worker.js 代码到这个目录
    pause
)

echo.
echo [6/6] 配置并部署...

echo 创建 wrangler.toml...
(
echo name = "shrril-wave-7c04"
echo main = "worker.js"
echo compatibility_date = "2026-01-15"
echo.
echo [[d1_databases]]
echo binding = "DB"
echo database_name = "okad-db"
echo database_id = "021adffc-4517-451f-9c76-e2955ad1bdb4"
) > wrangler.toml

echo 设置 API Key...
echo <YOUR_OPENROUTER_API_KEY> | wrangler secret put OPENROUTER_API_KEY

echo 部署中...
wrangler deploy

echo.
echo ============================================
echo   🎉 部署完成！
echo ============================================
echo.
echo 请访问以下链接验证：
echo   https://shrril-wave-7c04.sammy71777.workers.dev/
echo.
echo 如果显示 {"ok":true,"muse_configured":true,"db_configured":true}
echo 说明部署成功！
echo.
pause
