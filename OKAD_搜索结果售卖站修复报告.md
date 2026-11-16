# OKAD AFRICA — 搜索结果「跳过去全是错网站」修复报告

> 反馈原文：
> "这里的自己购买过去的网站全部是错的，是什么原因api接口还是？必须是售卖网站不是其它网站，中国工程网站为主，然后美国欧洲网站，这个可以完成吗不行就中国，你查一下代码接口，还有就是报价连接口是写死的，不工作就去了吧为什么放在那边"

---

## 一、先给结论

| 你的问题 | 排查结论 |
|---|---|
| 是 API 接口的问题吗？ | **接口本身是通的**（SerpAPI 正常返回 `ok:true`）。错在**查询词构造**和**完全没有域名过滤** |
| 能只出售卖站吗？ | **能，已实现**。中国站为主 + 美欧站为辅，已上线 |
| 报价链接写死、不工作 | 不是写死，是**被搜索页盖住了**（z-index bug）。已修复，**没删除** —— 它是从搜索结果一键询价的入口，删了反而没用 |

修复前你截图里看到的：

```
Best Buy | Official Online Store        → bestbuy.com 首页
BUY Definition & Meaning                → merriam-webster.com 词典页
Buy America | FTA                       → transit.dot.gov 政府站
```

修复后（实测 `phone accessories`）：

```
Alibaba        electronics.alibaba.com/supplier/android-phone-accessories-supplier
Alibaba        www.alibaba.com/countrysearch/CN/accessories-to-iphone.html
Made-in-China  www.made-in-china.com/manufacturers/mobile-phone-accessories.html
AliExpress     www.aliexpress.com/w/wholesale-phone-case-suppliers.html
AliExpress     www.aliexpress.com/store/1724742
Amazon US      www.amazon.com/clp/B0CPF7XGX4
Amazon Europe  www.amazon.fr/-/en/gp/bestsellers/electronics/...
```

---

## 二、根因：三个独立缺陷叠加

### 缺陷 1：查询词里塞了 `buy`，把词典页推到第一

前端 `doSearch()` 拼的查询词：

```js
var searchPrompt = q + ' wholesale price supplier manufacturer buy';
```

实测 `phone accessories wholesale price supplier manufacturer buy` → Google 把 `buy` 当名词匹配，第一条就是 **merriam-webster.com/dictionary/buy**（"BUY Definition & Meaning"）。这正好是你截图里的第二条结果。

### 缺陷 2：完全没有域名过滤

Worker 拿到 SerpAPI 结果后**原样返回**，不做任何域名判断。所以词典、百科、政府站、首页全部被当成"Web result"放行，`Self Purchase` 照跳不误。

### 缺陷 3：`site:` 语法在 SerpAPI 上无效（重要发现）

第一反应是用 `site:alibaba.com` 限定，但实测**完全无效**：

```
$ query = "site:alibaba.com phone accessories"
  → argomtech.com / plug.tech / yahoo.com       ← 根本没有 alibaba

$ query = "site:1688.com phone accessories"
  → argomtech.com / plug.tech / yahoo.com       ← 和上面一模一样
```

两个不同 `site:` 返回完全相同的结果，证明这个操作符被忽略了。

但**"产品词 + 站点名"** 的方式是有效的：

| 查询词 | 实际命中域名 |
|---|---|
| `phone accessories alibaba` | electronics.alibaba.com / alibaba.com ✅ |
| `phone accessories 1688` | 1688.com / pinterest（少量噪音） |
| `phone accessories made-in-china` | made-in-china.com ✅ |
| `phone accessories aliexpress` | aliexpress.com ×3 ✅ |
| `phone accessories amazon` | amazon.com ×3 ✅ |
| `phone accessories amazon.de` | amazon.de ×3 ✅ |

所以最终方案采用**按站点分组并行查询**。

---

## 三、修复方案

### 后端 `worker-okad.js`

**1. 域名白名单（66 个）+ 噪音黑名单（34 条规则）**

```
中国供应商：alibaba.com / 1688.com / made-in-china.com / globalsources.com
           aliexpress.com / dhgate.com / chinagoods.com / hc360.com ...
中国零售：  taobao.com / tmall.com / jd.com / pinduoduo.com ...
美国：      amazon.com / ebay.com / walmart.com / etsy.com / newegg.com ...
欧洲：      amazon.co.uk/.de/.fr/.it/.es/.nl/.pl/.se / ebay.co.uk/.de/.fr
           allegro.pl / otto.de / cdiscount.fr / bol.com ...
```

黑名单专门挡：wikipedia、merriam-webster、dictionary、facebook、pinterest、
youtube、reddit、twitter、medium、blogspot、apps.apple.com、`.gov`、`.edu` 等。

**2. 按站点分组并行查询（8 组，中国优先）**

```js
const SEARCH_GROUP_QUERIES = [
  { tier:'alibaba',       q: k => k + ' alibaba' },
  { tier:'1688',          q: k => k + ' 1688 wholesale' },
  { tier:'made_in_china', q: k => k + ' made-in-china supplier' },
  { tier:'aliexpress',    q: k => k + ' aliexpress wholesale' },
  { tier:'globalsources', q: k => k + ' globalsources supplier' },
  { tier:'amazon_us',     q: k => k + ' amazon.com' },
  { tier:'amazon_eu',     q: k => k + ' amazon.co.uk amazon.de amazon.fr' },
  { tier:'ebay_us',       q: k => k + ' ebay.com' },
];
```

8 个请求 `Promise.all` 并发，总耗时仍取最慢的那一个。

**3. 排序：中国站权重 90-100，美欧站 50-70**

```js
merged.sort((a,b) => b.weight - a.weight);
```

保证中国站永远排在美国/欧洲站前面 —— 就是你要的"中国站为主，然后美国欧洲"。

**4. URL 路径层面过滤（挡登录页/百科页/空频道页）**

光看域名不够，还有这些漏网：

```
supplier.globalsources.com/login                          ← 登录页
insights.made-in-china.com/...-Definition-Types-...html   ← 百科页
www.alibaba.com/                                          ← 首页
www.amazon.fr/-/en/b                                      ← 空频道页(没 node= 参数)
```

加了 27 条路径规则 `/login` `/signin` `/register` `/cart` `/blog` `-Definition-` `/buyingguides/` `/how-to-` 等，
以及 Amazon 频道页特判：`/b` 结尾但**没有** `node=`/`k=`/`rh=` 参数 → 拦截（带 `node=` 的真实类目页放行）。

**5. 图片链接替换也要过白名单（隐藏最深的一个）**

```js
const url = (sameSite && img.link) ? img.link : r.url;   // 旧代码
```

这行会把网页结果链接**替换成图片的来源页链接**，而图片链接**从未经过白名单校验**。
实测就是它把 made-in-china 的百科页重新放进了结果里，而且两条结果匹配同一张图时会产生**完全重复的 URL**。

修复：

```js
let url = r.url;
if (sameSite && img && img.link && isSellingProductPage(img.link)) url = img.link;
```

再补一道输出前的最终去重。

### 前端 `deploy/index.html`

| 改动 | 说明 |
|---|---|
| 查询词去掉 `buy` | `q + ' wholesale supplier manufacturer'` |
| 新增 `isSellingProductPage()` | 白名单 + 路径校验，前后端各一份 |
| `selfPurchase()` 加校验 | 非售卖站直接 toast 提示，不再跳 |
| Self Purchase 按钮禁用态 | 非售卖站按钮置灰 + tooltip 说明 |
| 搜索结果再过滤一次 | 兜底防漏网 |
| 报价按钮改用索引传参 | 原来用 `JSON.stringify` 拼 onclick，商品名带引号会打断 HTML 属性 |
| `wizFromProduct` 先关搜索页 | 修 z-index 遮挡 |
| demo 兜底去掉 google.com | 换成 AliExpress，四个都指向真实 B2B 站 |
| 补充来源标签 | AliExpress / eBay / Walmart / Global Sources 等 |

**报价按钮的真相**：它不是写死的，是**被盖住了**

```js
// 修复前：搜索页 z-index 9999 > 向导页 9998
// 点击后 wizShow=true，但最上层元素仍是 si-name（搜索结果）
```

实测点击后 `topEl: 'si-name'` —— 向导确实打开了，只是压在下面看不见，所以"点了没反应"。
现在点开前先 `closeSearch()`，实测 `srShow:false`、`topClass:'wiz-next'`、商品名正确带入。

---

## 四、实测结果

### 接口层

| 品类 | 结果数 | 中国站 | 美欧站 | 重复 | 垃圾站 |
|---|---|---|---|---|---|
| phone accessories | 11 | 6 | 5 | 0 | 0 |
| solar panel 100w | 12 | 5 | 7 | 0 | 0 |
| toyota brake pads ceramic | 8 | 6 | 2 | 0 | 0 |
| usb c charger 3a | 12 | 11 | 1 | 0 | 0 |

### 白名单判定（14/14 全对）

```
BLOCK  supplier.globalsources.com/login
BLOCK  insights.made-in-china.com/...-Definition-Types-...
BLOCK  www.alibaba.com/
BLOCK  www.amazon.fr/-/en/b            (无 node= 参数的空频道)
BLOCK  merriam-webster / wikipedia / bestbuy / facebook
ALLOW  s.1688.com/selloffer/offer_search.htm
ALLOW  alibaba.com/trade/search
ALLOW  electronics.alibaba.com/supplier/...
ALLOW  aliexpress.com/w/wholesale-...
ALLOW  amazon.com/cell-phone-accessories/b?node=2407755011  (真实类目页)
ALLOW  amazon.com/dp/B0CPF7XGX4
ALLOW  made-in-china.com/productdirectory.do?word=...
ALLOW  ebay.com/itm/267690154517
```

### 端到端（`verify_search_fix.py`）

```
✅ 有搜索结果 (11 条)
✅ 全部为售卖站 (非法 0 条)
✅ 中国站排在美欧站之前
✅ 售卖站的 Self Purchase 全部可点 (禁用 0 个)
✅ 报价按钮存在 / 向导页已打开 / 搜索页已关闭
✅ 向导在最上层 (点击真的有效)
✅ 商品名已带入
✅ 白名单判定正确
✅ 控制台 0 错误
=== ALL PASS ===
```

后台回归 `verify_admin_fixes.py` 同样 ALL PASS（本轮改动未影响后台）。

---

## 五、部署

| 项 | 状态 |
|---|---|
| Worker `shrill-wave-7c04` | ✅ 已部署（版本 `f478d5ba`） |
| Pages `okad-africa` | ✅ 已部署 |
| 前端 4 份副本 | ✅ MD5 一致 |
| Service Worker | ✅ `okad-v11` → `okad-v12` |

⚠️ 关键细节：搜索缓存键带**版本号**（`v2`→`v3`→`v4`）。每次改搜索逻辑都必须 +1，
否则 KV 里 30 分钟的旧缓存会继续把垃圾链接返回给前端 —— 中途我就踩了这个坑，
改完代码结果没变，就是因为命中了旧缓存。

---

## 六、一句话

> **搜索从"通用网页搜索"改成了"按站点分组的 B2B/电商定向搜索"，
> 加了 66 个域名白名单 + 34 条黑名单 + 27 条路径规则，
> 排序强制中国站优先。现在 Self Purchase 只会跳到真正能买货的页面。**
