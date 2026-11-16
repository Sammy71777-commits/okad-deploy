# OKAD Worker 部署指南（5 分钟完成）

## 目标
把 OKAD 后端代码部署到 Cloudflare Worker，让前端能调用真实 API。

---

## 前提
- 已有 Cloudflare 账号：Sammy71777@gmail.com（已登录）
- 已有 Worker：shrril-wave-7c04
- 已有 D1 数据库：okad-db
- 已有 OpenRouter API Key

---

## 步骤 1：打开 Worker 编辑器

1. 打开 https://dash.cloudflare.com/workers-and-pages
2. 点击 `shrril-wave-7c04`
3. 点击右上角 `Edit code`

---

## 步骤 2：清空默认代码

在编辑器里：
- 按 `Ctrl + A`（全选）
- 按 `Delete`（删除）
- 编辑器变空白

---

## 步骤 3：粘贴代码

1. 打开这个链接：
   ```
   https://a830e4ff7cb85da66.sg.agentos-app.run/code-helper.html
   ```

2. 点击橙色按钮 **"📋 复制完整代码"**

3. 回到 Cloudflare 编辑器，按 `Ctrl + V` 粘贴

4. 按 `Ctrl + S` 保存

---

## 步骤 4：Deploy

点击编辑器右上角 **Deploy** 按钮（紫色/蓝色）。

等 10 秒，显示 "Deployed"。

---

## 步骤 5：配置 Secrets

1. 点击顶部菜单 **Settings**
2. 点击左边 **Variables and secrets**
3. 点击 **+ Add variable**
4. 填写：
   - Name: `OPENROUTER_API_KEY`
   - Value: `<YOUR_OPENROUTER_API_KEY>`
   - 勾选 **Encrypt**
5. 点击 **Save**
6. 点击 **Deploy to production**

---

## 步骤 6：绑定 D1 数据库

1. 在 Settings 页面，点击左边 **Bindings**
2. 点击 **+ Add binding**
3. 选择：
   - Type: `D1 database`
   - Variable name: `DB`
   - Database: `okad-db`
4. 点击 **Deploy**

---

## 步骤 7：验证

打开浏览器，访问：
```
https://shrril-wave-7c04.sammy71777.workers.dev/
```

应该返回：
```json
{
  "ok": true,
  "service": "OKAD Unified Worker",
  "muse_configured": true,
  "db_configured": true
}
```

---

## 完成！

把 Worker URL 发给 OKAD 开发者：
```
https://shrril-wave-7c04.sammy71777.workers.dev
```

---

## 常见问题

**Q: 粘贴代码后 Deploy 报错？**
A: 代码太大（25KB），Dashboard 编辑器可能有限制。改用 wrangler CLI：
```bash
npm install -g wrangler
wrangler login
curl -o worker.js "https://a830e4ff7cb85da66.sg.agentos-app.run/code-helper.html"
# 复制页面里的代码保存为 worker.js
echo "<YOUR_OPENROUTER_API_KEY>" | wrangler secret put OPENROUTER_API_KEY
wrangler deploy --name shrril-wave-7c04
```

**Q: D1 数据库找不到？**
A: 数据库 ID 是 `021adffc-4517-451f-9c76-e2955ad1bdb4`，名字是 `okad-db`。

---

部署者签名：________________ 日期：________________
