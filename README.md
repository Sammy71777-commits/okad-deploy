# OKAD AFRICA — 启动包

## 文件清单

| 文件 | 用途 | 部署 |
|------|------|------|
| `okad_africa_app.html` | 主应用(H5+Web,后台管理、5大功能) | 部署到根域名 |
| `landing.html` | 英文落地页(适合Google/Facebook广告) | 部署到 `/` 或 `/landing` |
| `marketing_1_hero.png` | 应用Hero截图 | Product Hunt主图 |
| `marketing_2_compare.png` | AI比价结果图 | Product Hunt配图 |
| `marketing_3_analytics.png` | 后台Analytics图 | 给投资人/合作伙伴看 |
| `marketing_4_mobile.png` | 移动端截图 | Product Hunt移动端展示 |
| `marketing_5_landing.png` | 落地页Hero | 广告主图 |
| `marketing_6_landing_features.png` | 落地页Features区 | 广告配图 |
| `vercel.json` | Vercel部署配置 | 自动 |
| `deploy.sh` | 一键部署脚本 | `bash deploy.sh` |
| `build.py` | 生成index.html | 自动) |
| `screenshot.py` | 重新生成截图 | `python3 screenshot.py` |

---

## 立即部署(5分钟)

### 方法A:拖拽上传(最简单)
1. 打开 https://vercel.com/dashboard
2. 注册/登录(免费)
3. 点 "Add New Project" → "Browse" → 选中 `/workspace` 整个文件夹
4. 点 "Deploy"
5. 30秒后获得 `https://xxx.vercel.app`

### 方法B:命令行(适合持续开发)
```bash
bash deploy.sh
```
首次运行会要求登录Vercel账号。

---

## 发布文案(直接复制粘贴)

### Reddit r/africa
```
Title: I built a free tool that shows shipping cost from China → your country in 30 seconds

Hi everyone 👋

I made a web app that solves a problem I kept hearing from African importers:
"How much does it cost to ship 100kg of [product] from China to Lagos?"

It's an AI-powered calculator that compares Sea / Air / Full-Container prices
across 5 Chinese ports × 5 African ports in real time.

Built for: importers, small business owners, sourcing agents.
Try it: https://你的域名.vercel.app

It's free to use, no signup needed for quotes.
```

### Product Hunt
```
Name: OKAD AFRICA
Tagline: Ship from China to Africa. Get 3 quotes in 30 seconds.
Description:
Stop emailing 10 freight forwarders for quotes. OKAD compares Sea, Air, and
Full-Container shipping across 25 routes (5 Chinese ports × 5 African ports)
in real time. Built for African importers who source from 1688/Alibaba.
```

### 非洲华人微信群(中文)
```
【分享个工具】OKAD AFRICA 刚上线 🚢
免注册、30秒出3家报价(海运/空运/整柜)。
支持航线:广州/深圳/上海/宁波/义乌 → 拉各斯/蒙巴萨/德班/特马/亚历山大
试用: https://你的域名.vercel.app
```

---

## 发布节奏(30天)

| 周 | 动作 | 目标数据 |
|----|------|---------|
| W1 | 部署+微信群发布(2-3群) | 500 PV, 5个真实反馈 |
| W2 | 优化价格/文案后 → Reddit r/africa | 1500 PV, 20个搜索 |
| W3 | Product Hunt发布 | 3000 PV, 50个真实用户 |
| W4 | 复盘 → 邮件回访W1/W2用户 | 5-10个真实订单 |

---

## 实时数据查看

部署后,客户访问你的网站,你可以通过后台看到:

1. **访问**: 你的域名 → 连点logo 5次 → 进入后台
2. **Analytics Tab**: 看国家分布/流量来源/搜索词/航线热度
3. **Orders Tab**: 每笔订单的客户/路线/利润
4. **Export CSV**: 一键导出所有数据做分析

---

## 价格说明

目前25条航线的价格是默认值(基于2025年市场行情)。你可以:

1. 进入后台 → Price Tab → 直接改任意航线的报价率+成本
2. 利润率自动计算
3. Save后,新客户比价立刻按新价格走
4. 旧订单不受影响(订单保存的是当时快照)

---

## 后续步骤

- ✅ 完成: 核心功能 + 后台管理 + 埋点 + UI升级
- ✅ 完成: 部署配置 + 营销截图 + 英文落地页
- ⏭️ 下一步: 域名(okadafrica.com) + 真实支付(Stripe/Flutterwave)
- ⏭️ 虚拟号码功能(差异化卖点)

---

最后更新: 2025
联系: hello@okadafrica.com