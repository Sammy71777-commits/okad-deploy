# ⚠️ 待办:修复 okadafrica.com 的 NS 委派(注册商侧)

## 问题现状

`okadafrica.com` 和 `api.okadafrica.com` **在公网完全无法解析**,导致客户注册时报
"Network error"。这不是代码问题,是域名委派问题。

### 诊断结论(2026-11-13 核实)

| 层面 | 状态 |
|---|---|
| Cloudflare zone `okadafrica.com` | ✅ `active`,未暂停 |
| Cloudflare NS 上的 A 记录 | ✅ 正确(`104.21.6.75` / `172.67.134.154`) |
| Pages 自定义域名绑定 | ✅ `active`(okadafrica.com + www) |
| Worker 自定义域 `api.okadafrica.com` | ✅ `enabled`,证书已签发 |
| **`.com` 父区(Verisign)的 NS 委派** | ❌ **NOANSWER —— 断在这里** |
| 原 NS `dns1/dns2.digitalplat.org` | ⚠️ 存活但对本域不返回 A 记录 |

父区没有把 `okadafrica.com` 委派给 Cloudflare 的 NS,而是指向注册商原始 NS
`dns1.digitalplat.org` / `dns2.digitalplat.org`(注册商 Global Domain Group)。
那套 DNS 里没有本域的记录 → 所有公共解析器(8.8.8.8 / 1.1.1.1 / 9.9.9.9 / 223.5.5.5)
全部返回 NOANSWER。

## 解决办法(只有域名所有者能做)

登录域名注册商后台,把 **Nameserver** 改成 Cloudflare 给的两个:

```
coen.ns.cloudflare.com
fay.ns.cloudflare.com
```

### Cloudflare 侧核对值

```
Zone ID  : e93444c5f5a69a57b25f531c3c1b3fff
Zone 状态: active
Cloudflare NS:
  coen.ns.cloudflare.com  (A: 108.162.195.151 / 162.159.44.151 / 172.64.35.151)
  fay.ns.cloudflare.com   (A: 108.162.192.115 / 172.64.32.115 / 173.245.58.115)
```

改完后等待 0–30 分钟生效(最长可能 24–48 小时)。验证:

```bash
# 应该返回 Cloudflare 的 IP
dig +short okadafrica.com @1.1.1.1
# 父区应该能看到委派
dig +short okadafrica.com NS @192.5.6.30
```

## 临时方案(已上线,不需要等 DNS)

在 DNS 修好之前,站点已经通过 **Pages 同源 `/api/*` 反向代理**工作:

- `deploy/_worker.js`(Advanced 模式)把 `/api/*` 转发到后端 Worker
- 前端所有 API 调用改为走 `apiBase()`(同源相对路径),不再硬编码死域
- 可用地址:`https://okad-africa.pages.dev`

**注意:** 客户如果访问的是 `okadafrica.com` 本身,DNS 不修好就还是打不开。
必须让客户用 `https://okad-africa.pages.dev`,或者尽快修注册商的 NS。

## 相关文件

| 文件 | 作用 |
|---|---|
| `deploy/_worker.js` | Pages Advanced 模式 Worker,`/api/*` → 后端 Worker 反向代理 |
| `index.html` → `apiBase()` | 全站唯一 API 入口,自动过滤死域 `api.okadafrica.com` |
| `index.html` → `apiReady()` | 判断 API 是否可用(注意:`apiBase()` 返回 `''` 是合法的同源路径,不能用 `if(!base)` 判断) |
| `wrangler.toml` | 后端 Worker(`shrill-wave-7c04`)配置,D1 + KV + 密钥绑定 |

## 后端 Worker 直连地址(备用)

若 `workers.dev` 在本账号未启用,可在 Pages 项目里加环境变量:

```
WORKER_ORIGIN = https://<可达的后端 Worker 地址>
```

默认值为 `https://shrill-wave-7c04.sammy71777.workers.dev`。
