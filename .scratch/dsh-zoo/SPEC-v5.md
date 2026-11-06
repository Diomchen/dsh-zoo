# SPEC v5 · 农场：种、偷、雇、交易所

> 承接 [ADR-0016](../../docs/adr/0016-farm-economy-federated.md)。
> v4 的发现、放行、串门、礼物、记录、桌面层全部保留；本文只加「农场」这一层。

## Problem Statement

串门到现在只交换三样轻东西：我是谁、我在干嘛、我说一句；带派是单向的，礼物送出去就
归对方。没有货币、价格、长期目标，也没有「明天还想打开」的理由。

用户要的是**农场模式**：种地、等它长、去邻居家偷菜、有一个交易所、还能雇佣别人的宠物
来看家。一句话：把「待机」「串门」「货币」接成一个循环：

> **种 → 等（离线也长，在线待机加速）→ 收 → 卖/买 → 去邻居家偷/帮忙 → 升级/雇工 → 再种。**

宠物不是农场的吉祥物：它在家时看家，出门偷菜或在外打工时自家就没人看。这是这套玩法
最自然的代价。

## Solution

一只宠物一块农场：4 块地、3 种作物、一个本机交易所、一份雇工合同位。农场长在桌面上
（一小块看得见的地），完整操作在一扇 focusable 小窗里。串门是去邻居农场的入口：
访客能偷成熟作物、帮生长中的地浇水，也能被主人雇来看家。

经济是**本地账本 + 联邦行情 + 宠物背货**：每个农场自己记账、自己的交易所做市；
行情每 30 秒 gossip 一次，各家取中位数；硬币和作物只有被宠物驮着时才跨机。
没有中心服务器，没有订单簿，没有跨机账本。

## 与 v4 的差别

**留**：UDP 发现、放行、心跳、串门状态机、`visits.json`、礼物/背包/礼物卡、桌面层、
`dshzoo://`、素材源、所有既有报文。

**改**：

- `GET /dsh-zoo/state` 多 `farm`、`market`、`contracts` 三项。
- 桌面场景多一个 `controls.farm`（地块摘要、硬币、露水、雇工）和一只带 `role:'worker'`
  的宠物；主窗仍然点穿，只有地块条和农场按钮接指针。
- 局域网只读服务多一条 `GET /dsh-zoo-farm/<visitId>`（访客拉主人的农场快照）。
- `POST /dsh-zoo/action` 多种地/收获/买卖/雇佣等动作。

**加**：`src/farm.js`、`src/market.js`、`src/contracts.js`、`src/farm-rules.js`；
`farm.json` / `market.json` / `contracts.json`；`market-digest` / `farm-action` /
`work-*` 报文；农场小窗（`desktop/farm.*`）；桌面地块条；偷菜/帮忙/雇工 UI。

**删**：无。

## 农场与作物

一只宠物一块农场，农场属于**身份**：换皮、改名、换外观都不动它。v1 固定 **4 块地**，
土地升级放第二层。

初始农场：4 块空地、**30 硬币**、**2 颗小番茄种子**、0 露水、0 作物。这样第一次打开
就能种，不用先去找钱。

| id | 名字 | 生长 | 种子价 | 产量 | 底价 | 定位 |
| --- | --- | --- | --- | --- | --- | --- |
| `tomato` | 小番茄 | 30 分钟 | 6 | 3 | 5 | 快，在线玩 |
| `carrot` | 胡萝卜 | 2 小时 | 14 | 5 | 6 | 中 |
| `pumpkin` | 南瓜 | 8 小时 | 36 | 3 | 30 | 慢，待机玩 |

底价只是交易所的起点，实际卖价随供需浮动（见「交易所」）。数字先按这张表，平衡在票 41
的测试里调。

**地块状态**：`{ id, crop, plantedAt, grownMs, growMs, waterings, fertilized,
stolenBy: [deviceId], helpedBy: [deviceId] }`。`grownMs >= growMs` 即成熟；成熟后不再
生长，也不枯萎。收获后清空，`stolenBy` / `helpedBy` 一起清空。

**动作**：

- **种**：地块为空 + 仓库有对应种子；扣 1 颗种子，写入 `plantedAt` / `grownMs: 0`。
- **浇水**：主人每株一次，+10% `growMs`；花 1 露水。访客的「帮忙」也走同一条增长，
  但算在 `helpedBy` 里。
- **施肥**：每株一次，+1 产量；花 5 露水。
- **收**：成熟才能收；产量 = 表里的产量 + 施肥 1 − 被偷数量（最低 0）；作物进仓库，
  地块清空。
- **不枯萎、不生病、没有虫害**。回来晚了只是晚收，不会少收（被偷除外）。

## 待机、露水与离线生长

**待机** = DSH 开着、主人 10 分钟没有做过农场动作。待机每 10 分钟攒 **1 露水**，
每天上限 **48**（= 8 小时），本地午夜重置。任何一次种/收/浇/施肥/买卖/雇佣都会重置
待机计时。露水是「开着但没在玩」的奖励，不是在线时长的无条件补贴。

**离线生长** = 关掉 DSH 后作物仍按真实时间生长。重新打开时，这次离线最多补 **12 小时**
的生长；超出的部分不推进（作物不会丢，只是停在 12 小时那一刻，回来继续长）。
运行中按真实时间走，不设上限。

> 为什么是 12 小时：一天回来两次正好；24 小时会变成「一天开一次就够」，日常就死了。

## 偷菜与帮忙

**偷菜永远允许**：没有「谢绝偷菜」开关，也没有成熟保护期。放行邻居 + 活跃串门 +
成熟作物，就能偷；只受每日上限和守卫影响。主人能看到是谁偷的，也可以偷回去。

**前置条件**：访客的宠物正作为访客待在主人的农场（`visitId` 有效）；目标地块成熟；
这块地这一轮还没被这位访客偷过。

**偷菜规则**：

- 一次偷 **1 个**作物；这块地标记 `stolenBy`，同一访客这一轮不能再偷同一块。
- 每日上限：同一访客对同一农场 ≤3 次；同一农场 ≤5 次；同一访客对所有农场 ≤10 次。
- **守卫**：主人宠物在家且没在打工/串门 = 0.3；有雇工 = 0.5；相加封顶 0.8。
  偷菜成功率 = `1 - 守卫`；失败 = 被抓住，这次白跑，没有罚款。
- 成功：访客仓库 +1 作物，主人的收获产量 −1（收获时结算）；主人的日志记一条
  「「昵称」偷了 1 个番茄」；失败记「被「昵称」抓住了」。
- 偷来的作物立刻进访客仓库，UI 显示「在驮包里」直到这次串门结束；串门结束不收回。
- 结果按 `requestId` 幂等：重发返回同一结果，不重复扣。

**帮忙规则**：

- 目标地块还在生长；这位访客这一轮没帮过这块地。
- 访客花 **1 露水**，地块 +10% `growMs`；访客得 **1 硬币**。
- 每日上限：同一访客对同一农场 ≤3 次；同一访客 ≤5 次；每块地每轮 ≤1 次。
- 帮忙是偷菜的正向对照：一个让主人长得快，一个让主人少收一点；两种都是访客的互动。

**没有保护期**：成熟就能偷，包括主人睡觉的时候。雇工和「收菜要及时」是唯一防线。

## 雇佣与看家

**挂牌**：主人在农场小窗的「雇工」页打开 `hire`，写时薪（1–100 硬币/小时）、
可雇时段（2–8 小时）、守卫值（v1 固定 0.5）。挂牌随行情 digest 广播；只有在线、
在家、没在打工/串门的宠物能被雇。

**雇佣**：

- 雇主选宠物、选时长，付 `时薪 × 时长`，另加 **5% 手续费**（向上取整、最低 1；烧掉，作为回收口）。
- 雇工进入 `working` 状态：它不在自己家，出现在雇主农场的桌面地块旁（带「打工」角标），
  合同期内不能再去串门、不能被别人雇。
- 雇主农场多一个雇工守卫 0.5；主人自家农场因为宠物不在，守卫为 0。
- v1 一个农场最多一个雇工；一个宠物同时只能有一份合同；不能雇自己。

**合同**：

- 2–8 小时，预付；`startedAt` / `endsAt` / `status`。
- 主人可以提前召回（`work-recall`），雇主可以提前结束（`work-end`）；按实际服务时长
  结算：`earned = floor(工资 × 服务毫秒 / 合同毫秒)`；主人拿 `earned`，雇主拿回剩下的；
  5% 手续费不退。
- 任一方离线：合同结束，按最后心跳的时间结算；未结算的部分在重连后按 `contractId`
  幂等补发。
- 结算报文 `work-settle` + `work-settle-ack`，重复不重复加钱。
- 工资显示在雇工的驮包里；主人结算时取走应得部分，剩下的由宠物带回雇主。跨机补发是
  幂等报文，不是跨机账本。

**守卫**：主人宠物在家 0.3 + 雇工 0.5 = 0.8 封顶；宠物出门串门/打工时自家守卫为 0。
v1 不做技能/等级，守卫值固定；狗/篱笆/装饰放第二层。

## 交易所与行情

**每个农场一个本机做市商**：买种子、卖作物永远能成交；价格随本机供需浮动。

- 作物有一个 `base`（上表）和当前 `price`；`bid = round(effective × 0.9)`，
  `effective = 0.85 × price + 0.15 × 局域网指数`。
- 卖 `q` 个：`price = clamp(price × (1 − 0.12 × q / 20), base×0.5, base×2)`。
- 每 10 分钟均值回归：`price += (base − price) × 0.03`。
- 种子按表里的固定价卖；买种子不影响作物价（未来供应市场看不见）。
- 历史保留最近 200 笔；交易所页显示 `bid`、局域网指数、base、24 小时曲线（可后补）。
- 买卖限速 10 次/分钟；单次 1–99 个。

**行情 gossip**：每 30 秒向放行邻居发一条 `market-digest`，带本机每种作物的 `price`
和自己的 `hire` 挂牌。收方只认新鲜（<2 分钟）、已知作物、在 `[base×0.5, base×2]`
内的价格；取中位数作为局域网指数；坏条目丢掉，不整包丢。1 个 peer 30 秒最多 1 条。

**联邦的意思**：成交永远在本机；想让邻居的交易所成交，得派宠物把货/币背过去（v1.5）。
各家价格会短暂不同——这是背货套利的机会，不是 bug。

**v1 不做**：玩家挂单、订单簿、拍卖、访客在主人交易所成交（v1.5）、跨机账本、中心主机。

## 货币、仓库与限额

- **硬币**：农场货币；买种子、雇工、将来的土地/工具都用它。v1 只存在本机仓库。
- **仓库**：种子、作物、硬币的计数；不是带派背包。带派背包仍然只管待送礼物（最多 2 件）。
- **驮包**：宠物出门时背的货（偷来的作物、工资）；UI 显示，不占带派背包。
- **上限**：硬币 ≤1,000,000；每种种子/作物 ≤999；露水 ≤48/天；地块 4；合同
  outgoing/incoming 各 ≤20；农场日志 ≤50；行情历史 ≤200；价格夹在 `[0.5×, 2×] base`。
- **回收口**：种子价、雇工 5% 手续费、交易所买卖价差、将来的土地/工具/装饰。
- **不做强防作弊**：邻居能改自己的 JSON；只防误操作、刷屏、路径和重复结算。

## 桌面与小窗

**桌面地块条**：宠物旁边 4 块小地，显示作物阶段（emoji/SVG）、成熟角标和「农场」按钮。
点击打开农场小窗。地块条和按钮进 `overlay-rects`，其余照旧穿透。雇工站在地块旁，
带「打工」角标；主人自己的宠物出门/打工时，地块条上显示「看家中」或「在外打工」。

**农场小窗**（focusable，仿改名/带派）：四个页签：

- **农场**：地块网格、种子/作物/硬币/露水、浇水/施肥/收获、被偷记录、雇工状态。
- **交易所**：作物价目、本机 `bid`、局域网指数、买种子/卖作物、最近成交。
- **雇工**：自己的挂牌（开关/时薪/时段）、邻居的挂牌（来自 digest）、雇佣、合同列表、
  召回/结束。
- **记录**：最近 50 条农场日志（种/收/偷/帮/雇/结算）。

**访客视图**：访客打开主人的农场时，同一扇窗进入只读模式：看到主人的地块和守卫值，
每块地给「偷」或「帮」按钮；按钮显示上限/已偷/可能被抓。结果用 toast/日志反馈。

**跨进程白名单**（任何新字段四处都过，漏一处就是静默丢）：

1. wire：`src/protocol.js` 的新报文/字段；
2. 宿主：`src/desktop-pets.js` 的 `controlsFromSnapshot`；
3. helper：`desktop/shared.js` 的 `emptyControls` / `normalizeControls` / 动作白名单；
4. 渲染：`desktop/renderer.js` 的 `uiRects` / `requestAction`。

`plotId` / `contractId` / `requestId` / `visitId` 还要过 `handleDesktopAction`、
`desktop/preload.js`、`desktop/main.js` 的 IPC、`shared.js` 的动作归一化——和 `giftId`
一样是窄口，少一处就静默丢。

## 协议

**新报文**（都带 `v:1` / `type` / `deviceId` / UUID id；4 KiB；未知字段丢弃；旧邻居
静默丢掉新类型，串门/礼物照常）：

| 类型 | 方向 | 内容 |
| --- | --- | --- |
| `market-digest` | 放行邻居，30s | 每种作物的 `price` + 自己的 `hire` 挂牌 |
| `farm-action` | 访客 → 主人 | `visitId` / `requestId` / `action: steal\|help` / `plotId` |
| `farm-action-result` | 主人 → 访客 | 同一 `requestId`；`ok` / `error` / `crop` / `qty` / `caught` |
| `work-request` | 雇主 → 主人 | `requestId` / 时长 / 时薪 / 手续费 |
| `work-ack` | 主人 → 雇主 | `contractId` / `startedAt` / `endsAt` / 守卫值 |
| `work-recall` / `work-recall-ack` | 主人 ↔ 雇主 | 召回 |
| `work-end` / `work-end-ack` | 雇主 ↔ 主人 | 提前结束 |
| `work-settle` / `work-settle-ack` | 雇主 → 主人 | `contractId` / `requestId` / `earned` |

**农场快照**走只读 HTTP：`GET /dsh-zoo-farm/<visitId>`，只在这次串门活跃期间可读；
结束/超时/失联立刻 404。返回主人的地块（阶段/成熟/守卫/雇工）、行情和挂牌；**不含
任何路径**。访客的宿主服务去拉，helper 不联网。

**动作流**：访客 helper → 访客宿主（`farm-steal` / `farm-help`）→ UDP `farm-action`
→ 主人宿主校验 `visitId`/`deviceId`/成熟/上限/守卫 → 更新主人的农场 + 结果 → UDP
`farm-action-result` → 访客宿主更新自己的仓库 → helper 刷新。主人侧按 `requestId`
缓存最近 200 条结果，重发返回同一结果。

**雇佣流**：雇主 helper → 雇主宿主（`hire`）→ UDP `work-request` → 主人宿主校验
在线/在家/挂牌/上限 → `work-ack` → 双方落合同 → 雇工进 `working`；结束走
`work-end`/`work-recall` + `work-settle`。

所有新 id 用 UUID 形状；枚举固定；不加坐标、不传路径、不传自由文本；重发 2–3 次，
按 id 幂等。

## 存储

三个新文件，和 `visits.json` / `backpack.json` 同一套路：`{version:1}`、损坏 → 默认 +
每个原因只告警一次、写入串行 + tmp/rename、可手改、可删。

**`farm.json`**：

```json
{ "version": 1, "coins": 30, "seeds": { "tomato": 2 }, "crops": {},
  "dew": 0, "dewAt": 1700000000000, "dewDay": "2026-11-06",
  "lastTickAt": 1700000000000,
  "plots": [ { "id": "p1", "crop": "tomato", "plantedAt": 1700000000000,
               "grownMs": 0, "waterings": 0, "fertilized": false,
               "stolenBy": [], "helpedBy": [] } ],
  "hire": { "enabled": false, "wagePerHour": 10, "minHours": 2, "maxHours": 8 },
  "log": [ { "at": 1700000000000, "kind": "harvest", "crop": "tomato", "qty": 3 } ] }
```

**`market.json`**：

```json
{ "version": 1,
  "prices": { "tomato": { "base": 5, "price": 5.2, "volume24h": 12, "at": 1700000000000 } },
  "history": [ { "crop": "tomato", "side": "sell", "qty": 3, "price": 4, "at": 1700000000000 } ],
  "index": { "tomato": { "price": 5.1, "at": 1700000000000, "samples": 2 } } }
```

**`contracts.json`**：

```json
{ "version": 1,
  "outgoing": [ { "id": "…", "workerDeviceId": "…", "workerNickname": "…",
                  "hours": 4, "wage": 40, "fee": 2, "startedAt": 0, "endsAt": 0,
                  "status": "active", "earned": 0 } ],
  "incoming": [ { "id": "…", "employerDeviceId": "…", "employerNickname": "…",
                  "hours": 4, "wage": 40, "fee": 2, "startedAt": 0, "endsAt": 0,
                  "status": "active", "earned": 0 } ] }
```

**tick**：每 60 秒推进生长、露水、合同到期、行情均值回归、过期清理；保存节流（有变化
或每 30 秒）。`dispose()` 停 tick。账本**绝不能**放进 `gifts/`（配额清理会按最旧删目录）。

## 状态出口与动作

`GET /dsh-zoo/state` 多三项：

- `farm`：`{ plots, coins, seeds, crops, dew, guard, worker, hire, log }`（log 最近 20）。
- `market`：`{ prices, index, history }`（history 最近 50）。
- `contracts`：`{ outgoing, incoming }`。

`POST /dsh-zoo/action` 新增：

| action | 入参 | 说明 |
| --- | --- | --- |
| `plant` | `{ plotId, cropId }` | 种一株 |
| `harvest` | `{ plotId }` | 收一株 |
| `water` | `{ plotId }` | 花 1 露水，+10% 生长 |
| `fertilize` | `{ plotId }` | 花 5 露水，+1 产量 |
| `buy-seed` | `{ cropId, qty }` | 从交易所买种子 |
| `sell-crop` | `{ cropId, qty }` | 卖给交易所 |
| `hire` | `{ deviceId, hours }` | 雇一位邻居的宠物 |
| `recall-worker` | `{ contractId }` | 主人召回自己的雇工 |
| `end-contract` | `{ contractId }` | 雇主提前结束 |

访客的偷/帮不是本地 action：helper 发 `farm-steal` / `farm-help`（带 `visitId` /
`plotId`），宿主转成 UDP；结果回同一扇窗。

错误码：`bad-plot` / `bad-crop` / `plot-occupied` / `not-mature` / `no-seed` /
`no-coin` / `no-dew` / `already-stolen` / `already-helped` / `cap` / `guard` /
`no-visit` / `worker-unavailable` / `already-working` / `own-pet` / `bad-wage` /
`contract-not-found` / `contract-ended` / `market-busy`。

## 降级

| 情况 | 看到 |
| --- | --- |
| 旧版本邻居 | 串门/礼物照常；没有农场入口；不能偷/帮/雇；行情忽略 |
| 没有桌面层 | HTTP 动作与 state 可用；没有地块条/农场窗 |
| 对方离线 | 不能去/偷/帮/雇；行情过期；合同结束 |
| 对方没开局域网端口 | 串门照常；农场快照取不到，不能偷/帮；雇工不可用 |
| 偷菜结果丢失 | 同 `requestId` 重试；仍失败这次白跑（主人已扣） |
| 合同一方离线 | 合同结束，按最后心跳结算，重连补发 |
| 行情不一致 | 各家短暂不同价；背货套利是特性 |
| 主人离线 | 没人能偷（对方离线）；作物照常长，回来收 |
| 没有种子/硬币/露水 | 明确错误码 + 一句人话 |

## 测试决定

沿用现有分工：纯函数优先，store 用临时目录，集成用两个 service + fake peer。

- **纯**：作物表、生长（离线 12h 上限、浇水/施肥、成熟）、露水（10 分钟/上限/跨日重置）、
  收获（被偷扣减）、价格（卖价冲击/夹取/均值回归）、指数（中位数/新鲜度/坏条目）、
  守卫/抓住（注入随机）、上限、合同按比例结算、三个文件的归一化。
- **store**：`farm.json` / `market.json` / `contracts.json` 的损坏/缺失/上限/tmp+rename/
  只告警一次；账本不从 `gifts/` 读。
- **协议**：`market-digest`、`farm-action(-result)`、`work-*` 的编解码、4 KiB、UUID/枚举、
  坏字段只丢字段；旧 peer 丢新类型不崩。
- **room/service**：快照 `controls.farm`、守卫状态、雇工状态、日志、上限；`farm-action`
  的 `visitId` 校验与幂等。
- **集成**：两个 service + fake peer：串门 → 拉农场快照；偷成功/被抓/上限；帮忙；
  雇工 → 看家 → 结算；行情 gossip 收敛；合同离线结束；重发不双花。
- **桌面**：`controls.farm` 四处白名单；地块条命中矩形；农场窗打开/动作回路；
  雇工角标；冒烟截图。
- 全量 `npm test` + `npm run smoke:desktop`。

## 票

按依赖顺序（每张票的验收在 `.scratch/dsh-zoo/issues/` 对应文件里）：

| # | 票 | 依赖 | 交付 |
| --- | --- | --- | --- |
| 39 | 农场数据与纯规则 | 无 | `farm.json` + 作物表 + 生长/露水/收获 + `plant`/`harvest`/`water`/`fertilize` + 单测 |
| 40 | 农场小窗与桌面地块 | 39 | 右键「农场」、focusable 小窗、桌面 4 块地、`controls.farm` 四处白名单、冒烟 |
| 41 | 交易所本机做市 | 39, 40 | `market.json`、买卖、价格公式、交易所页、`buy-seed`/`sell-crop` |
| 42 | 行情 gossip | 41 | `market-digest`、局域网指数、价格板、挂牌摘要 |
| 43 | 偷菜与帮忙 | 39, 40 | `GET /dsh-zoo-farm/<visitId>`、`farm-action(-result)`、上限/守卫/日志、访客视图 |
| 44 | 雇佣合同与雇工守卫 | 42, 43 | 挂牌、`work-*`、`working` 状态、雇工画面、守卫/抓住、结算 |
| 45 | 状态出口、限额、文档与验收 | 41–44 | state/action 文档、限额、README、全量测试与冒烟、版本号 |

## Out of Scope

- 中心化交易所主机、订单簿、拍卖、玩家挂单。
- 访客在主人交易所成交（v1.5，走宠物背货）。
- 多币种、生产链、配方、职业、排行榜。
- 「谢绝偷菜」开关、成熟保护期、完全免疫、罚款。
- 土地升级、狗/篱笆、装饰、作物图鉴、宠物技能/等级（v1.5）。
- 作物枯萎、虫害、天气、随机产量。
- 真实货币、端到端加密、跨网段/NAT、手机/网页农场。
- 大于 4 KiB 的农场快照走 UDP（快照走 HTTP）。
