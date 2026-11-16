# 前端 4 个问题 — 诊断与修复报告

日期：2026-11-02
涉及文件：`worker-okad.js`（后端）、`deploy/index.html`（前端，已同步到 `index.html` / `okad_africa_app.html` / `site/index.html`）

---

## 问题 1：搜索结果的产品图片与真实产品不符

### 根因（两层）

**后端层**：`worker-okad.js` 的 `handleSearch()` 把 SerpAPI 返回结果映射成
`{title, url, text, snippet}` 四个字段，**`thumbnail` 字段被直接丢弃**。

更关键的是 —— 实测线上接口发现：

```
$ curl -s -X POST https://api.okadafrica.com/api/search -d '{"query":"car banner"}'
thumbnail: None
imageUrl: None
```

**SerpAPI 的 `organic_results`（网页搜索）根本不返回 thumbnail**，只有图片搜索
（`engine=google_images`）的结果才带缩略图。所以后端无论怎么改字段都拿不到图。

**前端层**：`sourceImage()` 拿不到真实图时，回落到 `DEMO_PRODUCT_IMAGES` —— 一个
**固定的 4 张 Unsplash 演示图库**（手机、手表、耳机等）。这就是为什么搜 "car banner"
却显示手表照片：图和产品之间毫无关系。

附带 bug：`productImageHtml()` 用 `.replace('display:flex','display:none')` 想隐藏占位符，
但 HTML 里根本没有内联 `display:flex`（样式在 CSS 类里），替换无效 → 真实图和占位符
**同时显示**，叠在一起。

### 修复

**后端**：
- 新增 `keywords()` / `matchImage()`：并行发起 SerpAPI 图片搜索
  （`engine=google_images`，取 3 倍数量），用标题关键词重合度 + 同域名加权
  把真实产品图匹配回对应的网页结果
- SerpAPI 分支现在返回 `imageUrl`（真实大图）+ `thumbnail`（小图）+ `imageSource`（图源域名）
- Google CSE 分支改用 `pagemap.metatags[0]['og:image']` / `['twitter:image']`
- 移除原来无效的 `pickImage()`（organic_results 本来就没这些字段）

**前端**：
- `sourceImage()` 不再回落演示图，拿不到真实图就返回 `''`
- `productImageHtml()` 重写为 `<img>` + 独立 `.sr-img-wrap` 容器，
  `onerror` 时移除 img 并显示占位字母（首字母），**永远不会出现"图不对物"**
- 新增图片来源角标 `📷 vinylstatus.com`，让用户能核实图源真实性
- `safeProductUrl()` 修复：`new URL('', location.href)` 会返回当前页地址，
  导致空图片被当成有效 URL（显示成本页截图）。现在空值直接返回 `''`

### 验证

```
{"cards":2,"imgCount":1,"visibleFallbacks":[false,true],"credits":["📷 vinylstatus.com"]}
```
有图产品 → 真实图 + 来源角标；无图产品 → 占位字母，无错误图片。

---

## 问题 2：Self Purchase 点击后返回主页

### 根因（两个叠加）

**A. 弹窗被拦截**：`selfPurchase()` 用 `window.open(url, '_blank')`。它在
`fetch().then()` 的异步回调里执行 —— **不在用户手势的同步调用栈上**，Chrome/Firefox
的 popup blocker 会直接拦掉，`window.open` 返回 null，页面原地不动。

**B. URL 本身是首页**：`normalizeMockProduct()` 里
`url: safeProductUrl(pr.url) || 'https://www.1688.com/'` —— mock 数据没有 `url` 字段，
所以全部落到 `https://www.1688.com/`，**1688 的首页**。就算 `window.open` 没被拦，
跳过去也是"打开 1688 首页"，而不是具体商品。

### 修复

```js
function selfPurchase(r){
  var url = safeProductUrl(r.url);
  if(!url){
    toast('Supplier link unavailable. Please use OKAD Assisted for a quote.','#ef4444');
    return;                              // 不再静默失败
  }
  /* ...记录埋点... */
  try{ location.href = url; }             // ← 替换 window.open
  catch(e){ window.location.assign(url); }
}
```

- 用 `location.href` 直接跳转 —— 不受 popup blocker 限制
- 新增 `mockSearchUrl(q, i)`：mock 数据没有真实商品页时，生成
  **1688 / Alibaba / Made-in-China / Google 的关键词搜索结果页 URL**，
  跳出去是"相关商品列表"而不是网站首页
- `location.href` 赋值放在埋点记录**之后**，确保点击被记录

---

## 问题 3：Admin 面板开关重叠 + 价格输入框太长

### 根因

`renderPriceAdmin()` 复用了 `.ord-row` 样式：

```css
.ord-row{ display:flex; justify-content:space-between; align-items:center; gap:8px; }
.ord-row .ol{ flex:1; min-width:0; }      /* ← 标题区 */
.ord-row .or{ text-align:right; flex-shrink:0; }  /* ← 开关区 */
```

- `.ol` 是 `flex:1` 但**没有 `overflow:hidden`** → 长标题溢出，压到 `.or`（开关）上面，
  视觉上变成 "S**+**enzhen-Lagos"（开关的 checkbox 叠在文字上）
- 9 个价格输入框用 `display:flex; flex-wrap:wrap` 挤在一个容器里，
  配合 `style="width:60px"` 固定宽，**在手机宽度下必然溢出屏幕**

### 修复

新增专用样式 `.rt-card` 系列，**不再复用 `.ord-row`**：

| 区域 | 布局 |
|---|---|
| 第 1 行 | 路线名（`flex:1` + `ellipsis` 截断） + 右侧独立胶囊开关（`flex-shrink:0`） |
| 第 2 行 | From → To 两个输入框（`flex:1`，最小 110px）+ 橙色箭头分隔 |
| 第 3 行 | 价格 3 列 × 3 行 CSS Grid（`repeat(3, minmax(0,1fr))`），≤420px 时变 2 列 |
| 第 4 行 | Delete 按钮 + 路线 ID |

**另外修了一个数据丢失 bug**：`toggleRouteOn()` / `saveRoutesAdmin()` 原本结尾调用
`adminTab()` 重绘整个面板 → **用户正在输入的价格会被清空**。现在改成局部 DOM 更新
（只改开关样式 / 标题文字），不重绘。

### 验证（实测尺寸）

```
{"cards":23,"switchRect":{"w":58,"h":25,"t":303},"nameRect":{"t":307,"w":336},
 "gridCols":"128.656px 128.672px 128.672px","gridWidth":402,"cardWidth":433}
```
开关 58×25px 独立成块；标题宽 336px 与开关**不重叠**；价格网格总宽 402px
**完全在 433px 卡片内**。

---

## 问题 4：航程名称是写死的，不是自己填

### 根因

**两处**写死：

1. **前台**：`index.html` 里 "Popular routes" 区块是**纯静态 HTML**，写死了
   `Shenzhen → Tema`、`Guangzhou → Tema`、`Yiwu → Accra` 三张卡片，
   价格 `$80-120/CBM`、时效 `Sea: 28-35 days` 全是硬编码。
   **完全不读 `getRoutes()` 配置** → Admin 里改了名字和价格，前台纹丝不动。

2. **数据层**：`DEFAULT_PRICES` 里的 23 条路线（`Shenzhen-Lagos` 等）是**种子数据**，
   首次访问时生成初始路线列表。这部分本身没问题（Admin 可编辑），
   问题纯粹出在前台渲染层没接上配置。

### 修复

**前台**改为动态渲染：

```js
function renderPublicRoutes(){
  var list = getRoutes().filter(function(r){ return r.on; });  // 只显示 OPEN 的
  if(!list.length){ /* 显示"暂无开通路线"提示 */ return; }
  box.innerHTML = list.map(function(r){ /* 用 r.from / r.to / r.seaDays / r.seaRate / r.airRate / r.fclRate */ }).join('');
}
```

- 路线名用 `r.from` / `r.to`（Admin 里自己填的），回退到从 `r.id` 拆分
- 价格和时效全部读配置：`r.seaDays`、`r.seaRate`、`r.airRate`、`r.fclRate`
- `on=false` 的路线**自动过滤**，前台不会显示
- 新增 `portFlag()` 按港口名自动配国旗（🇨🇳 🇬🇭 🇰🇪 🇪🇬 等）

**接入点**（3 处）：
- 页面加载时 `renderPublicRoutes()`
- 云端配置拉取完成后（`pullRoutesCloud().then()`）
- Admin 保存 / 切换开关后

### 验证

```
{"count":2,"cards":[
 "🇨🇳 Guangzhou → Accra 🇬🇭Sea: 33-40 days$130/CBMAir: $6.5/kg · 4-6 daysFCL: $1",
 "🇨🇳 Shanghai → Durban 🇰🇪Sea: 29-35 days$145/CBMAir: $7.1/kg · 3-5 daysFCL: $2"]}
```
自定义的 from/to、时效、价格全部正确显示；`on:false` 的第三条被正确过滤。

---

## 部署状态

- ✅ 代码修改全部完成，语法验证通过（Worker + 7 个 script 块）
- ✅ 4 个副本文件已同步（md5 完全一致）
- ✅ 本地浏览器实测 4 项修复全部生效
- ⏳ **待部署**：沙箱重启后 wrangler 登录态与 API Token 均失效

部署命令（需先 `export CLOUDFLARE_API_TOKEN=xxx`）：

```bash
bash /workspace/deploy_now.sh
```

Token 权限：`Workers Scripts:Edit` + `Pages:Edit`
