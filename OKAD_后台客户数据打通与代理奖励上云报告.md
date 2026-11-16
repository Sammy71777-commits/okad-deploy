# OKAD 后台客户数据打通 + 代理奖励上云 交付报告

> 日期：2026-11-02 · 线上：okadafrica.com / api.okadafrica.com
> 起因：后台 KYC 审核「看不到客户上传的东西」、客户姓名「点不开数据」、统计口径是假数字

---

## 一、你的三个问题，查出来的真实答案

| 你的问题 | 查证结果 | 处理 |
|---|---|---|
| **上传信息后我们怎么检查，需要看到它的信息才可** | ❌ **证件照根本没入库**。它只存在浏览器 `sessionStorage`，而且被塞进了 `id` 字段（证件号位置）。后台拿到的 `id` 是空的，只能显示 `national_id: —`。**审核等于瞎审** | ✅ 证件照落 KV，注册即上传；后台 KYC 卡片有缩略图 + 点开看大图；照片与证件号字段彻底分离 |
| **在这个个人名字应该可以点击查看它的数据绑定在一起** | ❌ KYC 卡片姓名是纯文本；「Registered customers」名单里订单数是**写死的假数据**（云端用户一律 `orders: 0, totalSpent: 0`） | ✅ 两处姓名均可点击 → 同一个详情弹窗：档案 + 证件照 + 订单 + 总货物 + 总消费 + 代理奖励 |
| **这里只是总货物、总消费，总代理分享代金券后的他的奖励。这个机制我们有吗** | ⚠️ **机制齐全，但只活在本机**。`REFERRAL_TIERS`(Friend→Legend)、`okad_credit_balance`、`okad_coupon_gifts` 全在 localStorage → **后台看不到、客户换台手机余额就清零** | ✅ 奖励数据上云（D1 users 表），后台可见；客户换设备登录自动拉回 |

---

## 二、代理奖励机制（你问的那套）到底长什么样

**有，而且规则是完整的**：

| 等级 | 门槛 | 奖励 |
|---|---|---|
| 🥉 Friend | 邀请 1 人 | +$5 credit |
| 🥈 Connector | 邀请 3 人 | +$20 credit |
| 🥇 Ambassador | 邀请 5 人 + 1 人领券 | +$50 credit + 下一单免运费 |
| 💎 Legend | 邀请 10 人 + 3 人领券 | +$150 credit + VIP 客服 + 永久免运费 |

- **触发**：新客户首单完成 → 推荐人 +$5 credit（`processReferralReward`）
- **升级**：邀请数 / 领券数达标 → 自动升级并发放等级奖励（`checkTierUpgrade`）
- **分享**：赠送 $10 代金券给新客户也计入邀请数（`giftCoupon`）

**之前的问题不是没有，是「关在抽屉里」**——数据只写 localStorage。现在已全部上云。

---

## 三、后端新增接口

| 方法 | 路径 | 作用 |
|------|------|------|
| POST | `/api/kyc/photo` | 客户证件照上传（存 KV，key `kyc:<email>`，上限 3MB，只收 image/* data URL） |
| GET | `/api/kyc/photo?email=` | 后台取证件照 |
| GET | `/api/users/detail?email=` | 单客户聚合：档案 + 订单列表 + 总货物/总消费 + 代理奖励 |
| GET | `/api/users/stats` | 全量客户统计（订单数/消费额/奖励），供客户名单用 |
| POST | `/api/users/referral` | 代理奖励上云（referredBy / credit / tier / invites / gifters） |

**为什么证件照存 KV 不存 D1**：base64 图片几十~几百 KB，塞进 D1 行会把 users 表撑爆；KV 单值 25MB，D1 只留 `has_id_photo` 标记位。

---

## 四、前端改动

**后台 KYC 审核**
- 姓名变可点（虚线下划线 + `▸` 提示），点击 → 客户详情弹窗
- 卡片直接显示证件照缩略图，点击放大；无照片显示「🖼 查看证件照」按钮
- 证件号与照片分离：不再把 base64 当证件号显示成 `data***xx`

**客户详情弹窗（新增）**
```
👤 sammy joo                    KYC: APPROVED
EMAIL  sammy71777@gmail.com     PHONE  —
COUNTRY GH                      ID TYPE passport
ID NUMBER  not provided         IP 175.158.224.189
REGISTERED 2026-11-01

🖼 ID photo — click to enlarge   ← 真图,点开看原图

📊 汇总 / Totals
📦 总货物 TOTAL GOODS      7 orders · 41 pcs · 840 kg
💰 总消费 TOTAL SPENT      $473
🎁 代理奖励 AGENT REWARD   $35 credit · Connector
👥 邀请 / 赠券             3 invites · 1 gifters

📦 Orders (7)  ... 每单:单号 · 路线 · 方式 · 件数 · 金额
```

**Registered customers 名单**
- 姓名可点 → 同一个详情弹窗
- 统计改真实数字：`📦 6 orders · 💰 $389 · 🎁 $35`，并带 🖼 标识

**代理奖励上云**
- `processReferralReward` / `checkTierUpgrade` / `giftCoupon` / `attachReferralToUser` 四个动作全部触发同步
- 客户换设备登录 → `pullReferralFromCloud()` 把 credit/tier 拉回本机

---

## 五、顺手修掉的 4 个真 bug

| Bug | 后果 | 处理 |
|---|---|---|
| `POST /api/db/users` 用 `INSERT OR REPLACE` 只带档案列 | **客户一登录，代理奖励/证件照标记/统计全被抹成 NULL**（与之前密码哈希被抹是同一个坑） | Worker 写入前回填 12 个服务端持有列 |
| `mergeCloudStats` 无条件重绘 KYC | 正在看客户名单的人**被强行踢回 KYC 页** | 只刷新当前可见视图 |
| `adminAllUsers` 对本地已有用户跳过云端行 | 本地有该邮箱时统计拿不到云端值 → 一直显示 `0 orders · $0` | 渲染前按 email 补回云端统计 |
| 注册把 base64 照片塞进 `id` 字段 | 后台把照片当证件号显示 | `id` 与 `idPhoto` 彻底分离 |

---

## 六、验证结果（全部线上实测）

**后端 curl**
```
证件照上传            → ok:true, bytes:119947
证件照读取            → hasPhoto:true
用户详情聚合          → orders:6  totalQty:41  totalWt:840  totalSpent:389
奖励同步 + 回读       → credit:35  tier:t2  tierName:Connector
【回归】模拟登录 upsertUser 后复查
                       → hasIdPhoto 仍在 / credit 仍在 / 统计仍在  ✅
全量统计接口          → sammy71777: 6 orders, $389, $35, t2, photo=True
```

**Playwright 真实 UI**
```
KYC 审核区渲染              ✅
KYC 卡片出现证件照入口        ✅ (4 个按钮)
点姓名 → 弹窗显示姓名/完整邮箱 ✅
弹窗含「总货物/总消费/代理奖励」✅
弹窗显示云端 credit=$35      ✅
等级显示 Connector           ✅
证件照从云端加载并显示为图片    ✅
客户名单行可点击             ✅
名单显示 6 orders · $389 · $35 ✅
控制台错误                   0
```

**整站回归（8 个脚本全绿）**
```
verify_password.py       密码登录 + 免密 + 订单归属    ✅
verify_reg_password.py   注册带密码                    ✅
verify_flow6.py          六段流程 errors:0             ✅
verify_actions.py        后台三键 + 幂等               ✅
verify_receipt.py        回执上传 0 错误               ✅
verify_admin_live.py     后台实时 0 错误               ✅
verify_wizard.py         向导建单 0 错误               ✅
verify_final / sr_fix    浮层 0 错误                   ✅
```

---

## 七、改动文件

| 文件 | 改动 |
|------|------|
| `worker-okad.js` | 新增 5 个接口；`ensureRewardCols` 惰性加 8 列；users 写入回填 12 列；`normPhone`/`tierOf` |
| `deploy/index.html` | KYC 卡片证件照 + 姓名可点；`openKycUserDetail` / `viewIdPhoto`；名单真实统计；`uploadIdPhoto` / `fetchIdPhoto` / `syncReferralCloud` / `pullReferralFromCloud` / `mergeCloudStats` / `normPhoneLocal`；注册证件照上云 + 字段分离 |
| `index.html` / `okad_africa_app.html` / `site/index.html` | 与 `deploy/index.html` 同步（MD5 一致） |
| `verify_kyc_detail.py` | 新增：后台 KYC 详情端到端验证脚本 |

---

## 八、还需要你决定的一件事

**注册表单目前没有「证件号码」输入框**，只有证件类型 + 照片。所以后台 `ID NUMBER` 显示 `not provided`——照片是有的，号码从来没采集过。

要补的话：在注册表单加一个 ID Number 输入框（选填），后台就能把「照片 + 号码」一起核对。这会动注册流程，等你说要再加。
