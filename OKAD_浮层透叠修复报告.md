# OKAD AFRICA — 搜索浮层透叠修复报告

**日期**: 2026-11-02
**线上地址**: https://okadafrica.com
**部署 ID**: `f8715055` (Pages, branch `main`)

---

## 一、问题现象

搜索结果页(`srPage`)打开时，首页内容整层透过半透明背景叠在搜索结果上，文字互相重叠：

- 顶部横幅大字 "Ship from China to Africa. Start with 1KG." 压在搜索标题栏上
- `Live Orders` 计数条 (2,843 Orders · 25 · $17B) 叠在结果卡片中间
- `OUR SERVICES` / `AI Find Goods` 板块压在价格对比行上
- 底部 tabbar (Home / Ship / Track / Pay / Me) 透上来盖在按钮区

在 414px 移动视口下最为明显；1280px 桌面视口下因容器较宽反而被裁切掩盖。

---

## 二、根因

**不是持续半透明，是入场动画造成的瞬时重叠。**

CSS 规则：

```css
.sr-page.show{display:flex;animation:fadeUp .3s}

@keyframes fadeUp{
  from{opacity:0;transform:translateY(10px)}
  to{opacity:1;transform:none}
}
```

`fadeUp` 的 `from{opacity:0}` 作用在**带白色背景的容器 `.sr-page` 本身**上 —— 整个浮层连背景一起淡入，动画期间（0→337ms）底层页面内容必然透上来。

**实测 opacity 时间轴（修复前）**：

| 时刻 | 容器 opacity | 现象 |
|---|---|---|
| 0ms | 0 | 完全透明 |
| 84ms | 0.35 | 大幅透叠 |
| 170ms | 0.80 | 仍透叠 |
| 337ms | 1 | 恢复 |

因为搜索已优化到 0.1s 秒回，结果渲染几乎瞬间完成，截图恰好稳定抓在动画中段 —— 所以每次都能稳定复现。

**同样的病灶还有 3 处**（同一 `fadeUp` 挂在带背景容器上）：

| 位置 | 原规则 | 影响 |
|---|---|---|
| `.sr-page` | `animation:fadeUp .3s` | 搜索结果页透叠 |
| `.page-section` | `animation:fadeUp .2s` | 报价/支付/物流等全屏页透叠 |
| `.admin-overlay` | `animation:fadeUp .3s` | 后台管理面板透叠 |
| `.cs-panel` | `animation:fadeUp .3s` | 客服面板透叠 |

---

## 三、修复方案

**核心原则：不透明的全屏浮层，容器底色必须从第一帧就不透明；淡入只作用于内层内容。**

四处统一改为 —— 容器去掉入场动画，把淡入下移到内容层：

```css
/* 浮层底色必须全程不透明:淡入动画只能作用在内容层。 */
.sr-page.show{display:flex}
.sr-page.show .sr-body{animation:fadeUp .28s}

.page-section.show{display:block}
.page-section.show .page-body{animation:fadeUp .22s}

.admin-overlay.show{display:flex}
.admin-overlay.show .admin-body{animation:fadeUp .3s}

.cs-panel.show{display:flex;flex-direction:column}
.cs-panel.show .cs-body{animation:fadeUp .3s}
```

**安全性核查**：`transform` 会为 `position:fixed` 后代创建包含块。已全量扫描确认 —— 所有 `position:fixed` 均位于 body 级（tabbar / 弹窗遮罩等），浮层容器内部**无 fixed 后代**；`position:sticky` 仅存在于 `.page-head` / `.sr-head`（父级无 transform，不受影响）。

---

## 四、顺带修掉的两个问题

### 1. Service Worker "新版本"误报（首次安装也弹提示）

`controllerchange` 事件在 **SW 首次安装**（首次 claim 客户端）时同样会触发，不只在版本更新时。原代码因此让**每个新用户第一次打开网站**都看到假的 "New version available — refresh to update" 橙色胶囊，且该胶囊 z-index 9999 会压在搜索结果上。

修复 —— 用页面加载时是否已有 controller 区分首次安装与真实更新：

```js
var __okad_hadController = !!navigator.serviceWorker.controller;
navigator.serviceWorker.addEventListener('controllerchange', function() {
  if (!__okad_hadController) return;      // 首次安装,不提示
  if (window.__okad_sw_updated) return;
  window.__okad_sw_updated = true;
  if (typeof toast === 'function') {
    toast('New version available — refresh to update', 'var(--orange)');
  }
});
```

同时 SW 缓存版本 `okad-v6` → `okad-v7`，旧缓存自动清理、新 HTML 立即生效。

### 2. Pages 部署"假成功"（本次最隐蔽的一个坑）

首次部署反馈 `success: true`、`deploy stage: success`、别名已切到 `okadafrica.com`，**但线上内容纹丝未动**。

真相：裸 multipart 上传 API 的 `manifest` 若缺少 `assets` 字段（路径 → sha256 映射），Cloudflare 不知道上传文件对应哪个路径，结果**实际收录 0 个文件**：

- 部署详情 `files=0`
- 部署专属 URL `https://<id>.okad-africa.pages.dev/` 返回 **404 / size=0**
- 历史成功部署的专属 URL 返回 200（对比确认格式差异）

修复：改用官方 CLI —— `wrangler pages deploy` 会自动计算 sha256 并生成正确 manifest。

**已同步修正 `deploy_now.sh`**，避免以后再踩同一个坑。

---

## 五、验证结果（线上实测）

### 浮层不透明度时间轴（修复后）

| 时刻 | 容器 opacity | 容器底色 alpha | 内容层 opacity |
|---|---|---|---|
| 0ms | **1** | **1.0** | 0 |
| 75ms | **1** | **1.0** | 0.382 |
| 148ms | **1** | **1.0** | 0.778 |
| 222ms | **1** | **1.0** | 0.968 |
| 297ms+ | **1** | **1.0** | 1 |

淡入只发生在内容层，**容器底色全程 alpha = 1.0**。

### 端到端回归

| 检查项 | 结果 |
|---|---|
| 新用户首访 toast | ✓ 无误报 |
| 容器 opacity 恒为 1 | ✓ |
| 底层内容被完全遮住 (`elementFromPoint` 命中浮层内) | ✓ |
| 关闭浮层后首页恢复 | ✓ `display:none`，首页可见 |
| 控制台错误 | ✓ **0 个** |
| 线上版本 | ✓ 555710 字节，含新 CSS + SW 修复 |
| 四份前端副本 | ✓ md5 一致 `82ad3b78...` |
| `okadafrica.com` / `www.okadafrica.com` | ✓ 200，0.11s / 0.18s |

### 视觉对比

- 修复前：首页横幅、Live Orders、OUR SERVICES、tabbar 全部透过半透明背景叠在结果卡片上，文字重叠
- 修复后：纯白底，仅搜索结果清晰呈现

---

## 六、涉及文件

| 文件 | 改动 |
|---|---|
| `deploy/index.html` | 4 处浮层动画改为「容器不透明 + 内容层淡入」；SW 提示误报修复 |
| `deploy/service-worker.js` | `CACHE_VERSION` v6 → v7 |
| `index.html` / `okad_africa_app.html` / `site/index.html` | 同步 |
| `deploy_now.sh` | Pages 部署改用 `wrangler pages deploy`（修 manifest 缺 assets 的假成功问题） |

---

## 七、结论

搜索浮层透叠问题的根因是 **入场动画的 `from{opacity:0}` 作用在了带背景的容器上**，而非 CSS 背景色本身有问题。修复方式不是调背景色或加 `z-index`，而是**把动画的作用对象从容器下移到内容层** —— 这是同类问题的通用解法，四处浮层已统一处理。

排查过程中还暴露了两个独立问题：SW 首次安装误报更新提示、Pages 裸 API 部署收录 0 文件导致"部署成功但线上不变"，均已修复并同步更新部署脚本。
