# dsh-zoo 协议 v1

本文记录 **ticket 01–45 已落地** 的发现、放行、心跳、串门（含自发出门与访客常驻）、
串门记录、「带派」礼物（wire 字段、拉取路由、送达回执、限额），以及农场 v1.1 的
农场快照、行情 gossip、偷/帮和雇佣合同。
v1 的 GUI 客户端行为（灯条、卡片、同屏 4 位、`expiresAt` 淡出）已随 ADR-0005 删除，
这里只留线路上的事实。
实现修正：串门走现有 UDP socket，而不是原计划的 TCP（原因见文末）；礼物本体走
既有的只读 HTTP 素材源端口，不新增监听端口（ADR-0011）。

## 传输

- UDP4，固定端口 `45871`，可用 `DSH_ZOO_PORT` 覆盖（非法值回落到默认）。
- 启动时立即广播一次 `beacon`，之后每 **5 秒** 一次，目标 `255.255.255.255:<port>`。
- 收到 `beacon` 后向来源地址**单播**一条 `beacon-ack`；同一来源 4.5 秒内最多回一次。
- **放行之后**每 **2 秒** 向每个已放行邻居单播一条 `heartbeat`；放行动作和本机动作
  变化时立刻补发一条，所以动作切换通常不用等满 2 秒。
- **串门**复用同一条 socket 单播：`visit-request` → `visit-ack` / `visit-deny`，
  任一方可用 `visit-recall` 提前结束。不为串门另开监听端口。
- `visit-recall` 同样发 **3 次**（首次 + 两次重试，间隔约 500ms）：UDP 丢一包不会让
  对方把出门状态挂到 30 分钟上限。收到 `visit-recall-ack`（或对方已经不可达）就提前收手；
  重发按 `visitId` 幂等，接收方清场/写记录都只发生一次。
- 邻居 30 秒没有新报文/心跳就从桌面邻居表消失（Host 每秒 tick 一次）。
- 心跳影子（`guests`）30 秒没有心跳由同一条 tick 清掉。它只表示“这位邻居在线、并且
  放行了我”，**不是**串门访客：v2 只渲染 `visitors`，`guests` 不画。
- 串门访客（`visitors`）**没有时间上限**（ticket 10）：待到主人点「送客」为止，
  唯一的自动清场是对方 **2 分钟没有心跳**（对方失联）。
- 出门在外的本机宠物有 **30 分钟上限**（ticket 09）：到点、被送客、被召回或对方
  失联都会回家并写一条记录。

## 报文

JSON 对象。**字段集按类型固定**，多出来的字段在解析时丢弃：

```json
{ "v": 1, "type": "beacon", "deviceId": "<uuid>", "nickname": "蓝毛小女仆", "port": 45871 }
{ "v": 1, "type": "beacon-ack", "deviceId": "<uuid>", "nickname": "隔壁同事", "port": 45871 }
{ "v": 1, "type": "heartbeat", "deviceId": "<uuid>", "anim": "东张西望" }
{ "v": 1, "type": "heartbeat", "deviceId": "<uuid>", "anim": null }

{ "v": 1, "type": "visit-request", "deviceId": "<uuid>", "visitId": "<uuid>", "nickname": "隔壁同事", "anim": "东张西望" }
{ "v": 1, "type": "visit-request", "deviceId": "<uuid>", "visitId": "<uuid>", "nickname": "隔壁同事", "anim": "东张西望",
  "gift": { "id": "<uuid>", "kind": "text", "text": "给你留了张便条" } }
{ "v": 1, "type": "visit-ack", "deviceId": "<uuid>", "visitId": "<uuid>" }
{ "v": 1, "type": "visit-deny", "deviceId": "<uuid>", "visitId": "<uuid>", "reason": "not-admitted" }
{ "v": 1, "type": "visit-deny", "deviceId": "<uuid>", "visitId": "<uuid>", "reason": "visits-off" }
{ "v": 1, "type": "visit-recall", "deviceId": "<uuid>", "visitId": "<uuid>" }
{ "v": 1, "type": "visit-recall-ack", "deviceId": "<uuid>", "visitId": "<uuid>" }
{ "v": 1, "type": "gift-received", "deviceId": "<uuid>", "visitId": "<uuid>", "giftId": "<uuid>" }
{ "v": 1, "type": "farm-action", "deviceId": "<uuid>", "visitId": "<uuid>", "requestId": "<uuid>",
  "action": "steal", "plotId": "p1" }
{ "v": 1, "type": "farm-action-result", "deviceId": "<uuid>", "requestId": "<uuid>",
  "ok": true, "crop": "tomato", "qty": 1 }
{ "v": 1, "type": "farm-action-result", "deviceId": "<uuid>", "requestId": "<uuid>",
  "ok": false, "error": "guard", "caught": true }

{ "v": 1, "type": "market-digest", "deviceId": "<uuid>", "at": 1700000000000,
  "prices": { "tomato": 5.2, "carrot": 6.1, "pumpkin": 31 },
  "hire": { "enabled": true, "wagePerHour": 10, "minHours": 2, "maxHours": 8,
            "guard": 0.5, "available": true, "reason": "ready" } }

{ "v": 1, "type": "work-request", "deviceId": "<uuid>", "requestId": "<uuid>",
  "hours": 4, "wagePerHour": 10, "fee": 2 }
{ "v": 1, "type": "work-ack", "deviceId": "<uuid>", "requestId": "<uuid>", "ok": true,
  "contractId": "<uuid>", "startedAt": 1700000000000, "endsAt": 1700000014400, "guard": 0.5 }
{ "v": 1, "type": "work-recall", "deviceId": "<uuid>", "contractId": "<uuid>" }
{ "v": 1, "type": "work-recall-ack", "deviceId": "<uuid>", "contractId": "<uuid>", "ok": true }
{ "v": 1, "type": "work-end", "deviceId": "<uuid>", "contractId": "<uuid>", "reason": "employer-end" }
{ "v": 1, "type": "work-end-ack", "deviceId": "<uuid>", "contractId": "<uuid>", "ok": true }
{ "v": 1, "type": "work-settle", "deviceId": "<uuid>", "contractId": "<uuid>",
  "requestId": "<uuid>", "servedMs": 7200000, "earned": 20, "reason": "recall" }
{ "v": 1, "type": "work-settle-ack", "deviceId": "<uuid>", "contractId": "<uuid>",
  "requestId": "<uuid>", "ok": true, "earned": 20 }
```

| 字段 | 适用于 | 约束 |
| --- | --- | --- |
| `v` | 全部 | 必须是数字 `1`；其他版本整包忽略，只记一条日志 |
| `type` | 全部 | `beacon` / `beacon-ack` / `heartbeat` / `visit-request` / `visit-ack` / `visit-deny` / `visit-recall` / `visit-recall-ack` / `gift-received` / `market-digest` / `farm-action` / `farm-action-result` / `work-request` / `work-ack` / `work-recall` / `work-recall-ack` / `work-end` / `work-end-ack` / `work-settle` / `work-settle-ack` |
| `deviceId` | 全部 | 本机持久化的 UUID，见 `<dataDir>/identity.json`；不按 IP 认邻居 |
| `nickname` | `beacon`、`beacon-ack`、`visit-request` | 本地昵称，清洗控制字符后按码点截断到 32 |
| `port` | `beacon`、`beacon-ack` | 本插件服务端口；串门不再另开 TCP，所以这个字段不参与串门 |
| `anim` | `heartbeat`、`visit-request` | 本机宠物当前动作名，或 `null`；必须是安全文件名（无路径分隔符/控制字符，≤64）。旧端只读它 |
| `action`（宠物动作） | `heartbeat`、`visit-request` | 本机宠物当前动作的**语义名**（自由字符串，≤64）；缺省时消费端回退到 `anim`。和 `anim` 相同时不必重复发 |
| `action`（访客动作） | `farm-action` | 只能是 `steal` 或 `help`；别的值整包丢 |
| `semantic` | `heartbeat`、`visit-request` | 动作的固定语义标签：`working` / `eating` / `sleeping` / `idle` / `other`；不认识的动作靠它画通用表情 |
| `say` | `heartbeat`、`visit-request` | `{ text, until }`：气泡文本（清洗、≤80 码点）与过期时刻；`until` 最多 `now + 30s`，过期不显示 |
| `skinPort` | `beacon`、`beacon-ack`、`heartbeat`、`visit-request` | 本机素材源端口（1..65535）；没有素材源就不带 |
| `skinId` | 同上 | 素材源 id（`[A-Za-z0-9_-]{1,32}`）；缺省用 `deviceId` |
| `visitId` | `visit-*`、`farm-action` | 一次串门的随机 UUID；与 `deviceId` 同一种形状，但只用于关联这一次串门 |
| `gift` | `visit-request` | 可选，一次串门最多一件；`kind:'text'` 或 `kind:'file'`，字段规则见「礼物字段」 |
| `giftId` | `gift-received` | 礼物的 UUID（与报文里的 `gift.id` 同一个键）；只用于确认「哪一件到了」 |
| `requestId` | `farm-action`、`farm-action-result`、`work-request`、`work-ack`、`work-end`、`work-settle`、`work-settle-ack` | UUID 幂等键；重发复用同一个。访客动作按 `${deviceId}:${requestId}` 回放；`work-*` 的 ack 也按同一键回放 |
| `plotId` | `farm-action` | 地块 id，固定 `p1`–`p4`；不能是路径或自由文本 |
| `ok` / `error`（访客动作） | `farm-action-result` | `ok` 布尔；失败时 `error` 是固定枚举（`no-visit` / `bad-plot` / `bad-action` / `not-mature` / `already-stolen` / `already-helped` / `cap` / `guard` / `starting`） |
| `ok` / `error`（合同） | `work-ack`、`work-recall-ack`、`work-end-ack`、`work-settle-ack` | `ok` 布尔；失败时 `error` 是固定枚举（`own-pet` / `worker-unavailable` / `already-working` / `already-hired` / `bad-wage` / `bad-hours` / `no-coin` / `contract-not-found` / `contract-ended` / `contract-busy` / `busy` / `starting`）。`timeout` / `bad-device-id` / `disposed` 只在本机 HTTP/桌面结果里出现，不上线 |
| `crop` / `qty` | `farm-action-result` | 成功时作物 id（`tomato`/`carrot`/`pumpkin`）与 0..1 的数量；失败不带 |
| `caught` | `farm-action-result` | 只能与 `error:'guard'` 一起出现；表示被守卫抓住（没有罚款） |
| `reason`（访客） | `visit-deny` | 固定枚举 `not-admitted` / `visits-off`；缺失按 `not-admitted`，其他值整包丢弃 |
| `reason`（合同结束） | `work-end` | 固定枚举 `expired` / `offline` / `recall` / `employer-end` / `denied` / `cancelled` / `shutdown` / `restart` / `completed` |
| `reason`（结算） | `work-settle` | 固定枚举 `completed` / `recall` / `employer-end` / `offline` / `expired` |
| `at` | `market-digest` | 发起方时钟的正整数毫秒；接收方只认与本机时钟相差 ≤2 分钟的样本 |
| `prices` | `market-digest` | `{ <cropId>: number }`；只认三种作物、有限数、夹在 `[base×0.5, base×2]`；坏条目只丢那一种 |
| `hire` | `market-digest` | `{ enabled, wagePerHour, minHours, maxHours, guard, available, reason }`；`reason` 为 `ready`/`off`/`visiting`/`working`（旧版本可能给 `null`）；`available` 只在这只宠物真的能被雇时为 true；坏形状整包丢 |
| `contractId` | `work-ack`、`work-recall`、`work-end`、`work-settle` | 合同 UUID；`work-end` 在取消一笔还没 ack 的请求时可改用 `requestId` |
| `hours` / `wagePerHour` / `fee` | `work-request` | 时长 2–8 小时、时薪 1–100 的整数；`fee` 是 1..40 的整数，必须等于 `ceil(时薪 × 时长 × 5%)`（最低 1） |
| `startedAt` / `endsAt` | `work-ack` | 正整数毫秒；`endsAt > startedAt` 且差值 ≤8 小时 |
| `guard` | `work-ack`、`market-digest.hire` | 0..0.8 的有限数；`work-ack` 是雇工贡献的 0.5，`market-digest.hire` 同样是**雇工贡献的 0.5**，不是 `farmGuard()` 的合成值（0.3/0.5/0.8） |
| `servedMs` / `earned` | `work-settle` | 服务毫秒 0..8 小时；工钱 0..800 的整数；`work-settle-ack` 回的 `earned` 同一范围 |

**兼容口径（v 仍为 1）**：以上新字段全部可选。新增的**报文类型**（`market-digest` /
`farm-action` / `farm-action-result` / 8 种 `work-*`）旧端不认识时整包静默丢弃，既不回复
也不崩；原有类型的新字段旧端只丢字段。新端收到旧端时，缺字段就按下面的降级规则处理。
新端缺 `action` 时回退 `anim`，缺 `skinPort`/`skinId` 时只用本机素材或通用小人，
`say` 过期或形状不对就整条不显示，缺 `gift` 就是一次没有礼物的串门。任何新字段非法都只丢
那一个字段，不整包失败——`anim` 仍然必发，所以新旧两端始终能至少对上动作名。
`gift` 的例外规则见「礼物字段」：**礼物坏了绝不丢掉这次串门**。

`port` 不代表“发现端口可以变”：发现端口仍是固定的 45871。`heartbeat` **没有**
`nickname` 和 `port`：访客的昵称来自邻居表或放行名单，心跳不能改名字；
地址来自发现层，心跳只负责证明“它还活着、它现在在做什么”。
`visit-ack` / `visit-recall` / `visit-recall-ack` 只有 `visitId`，没有昵称、端口或动作：
它们只表达“这一次串门怎么了”，不承载任何新的远端状态。`visit-recall-ack` 是
`visit-recall` 的**回执**：收到并处理了召回的一方回一条，让对方停止重发。
`visit-deny` 多一个固定枚举 `reason`：`not-admitted`（没放行）或 `visits-off`
（本机桌面关掉了入站串门）。发起方据此显示不同的人话提示，但不能借这个字段传任意内容。

心跳与串门请求都不带坐标，也不带朝向或“是否被拖拽”（ADR-0003）。访客在本机自己跑物理，双方看到的轨迹可以不一样。

## 放行（ticket 03，本机状态）

放行不是一种网络报文，而是**本机决定**：

- 第一次见到某个 `deviceId` 时，它进入待放行队列，`snapshot.prompt` 是队首
  `{ deviceId, nickname }`；FIFO 最多 8 位，其余等下一次广播再排。
- 本机页面通过 `POST /dsh-zoo/action` 发信任动作，`deviceId` 必须是 UUID：
  - `{ "action": "admit", "deviceId": "<uuid>" }` → `status: "allowed"`
  - `{ "action": "reject", "deviceId": "<uuid>" }` → `status: "denied"`
  - `{ "action": "dismiss", "deviceId": "<uuid>" }` → 收起卡片，十分钟内不再问同一位
    （它从邻居表消失后再回来会立刻重问），不改变信任
- `snapshot.neighbors[].status` 为 `pending` / `allowed` / `denied`；拒绝过的邻居
  不再进入提示队列。
- 名单文件是 `<dataDir>/peers.json`，只按 `deviceId` 认，不按 IP 认：

  ```json
  {
    "allowed": { "<uuid>": { "nickname": "隔壁同事", "allowedAt": 1700000000000 } },
    "denied":  { "<uuid>": { "nickname": "发广告的", "deniedAt":  1700000000000 } }
  }
  ```

  文件可手改、可删：删掉一条 = 下次见面重新询问（启动时读取，改完重启生效）。
  两个名单各有 256 条上限，超出丢最旧的；`denied` 优先于 `allowed`。
  损坏/读不出时按空名单运行并只记一条日志；写不进时内存里照常生效、也只记一条日志。
- 应用层唯一出站门控是 `room.mayTalkTo(deviceId)`，只对 `allowed` 为真。心跳、串门请求、
  ack 与 recall 都必须走这个门控；`discovery.sendTo` 内部会再检查一次。
  **应用层唯一例外**是 `visit-deny`（见下）；发现层对合法 beacon 的自动回执是既有例外，
  与串门无关。

### 页面动作一览（只接受本地页面）

`POST /dsh-zoo/action`，body 里的 `action` 是固定枚举；远端 UDP 永远走不到这些分支。
未知 action 返回 `409 { "ok": false, "error": "not-implemented" }`。

| action | body | 结果 |
| --- | --- | --- |
| `admit` / `reject` / `dismiss` | `deviceId` | 见上 |
| `rename` | `{ "nickname": "..." }` | 装了 `dsh-pet` 就写进它的 `pets[].name`（见下），否则写回 `identity.json`；成功后立刻补发一次广播。非法昵称 `409 bad-nickname` |
| `visit` | `deviceId` 可省略 | 省略时随机挑一位在线且**互相放行**的邻居；没有目标返回 `no-admitted` / `no-online` |
| `recall` | 无 | 见“串门·召回与结束” |
| `end-visit` | `deviceId` | 主人「送客」：立即清场、写记录、发 recall |
| `accept-visits` | `{ "enabled": true\|false }` | 写 `settings.json`；见“串门开关” |
| `auto-visits` | `{ "enabled": true\|false }` | 自发出门总开关（默认关），写 `settings.json` |
| `bring` | `{ "kind": "text", "text" }` 或 `{ "kind": "file", "path" }` | 放进背包（≤2 件）；文件只存绝对路径，`size`/`sha256` 在发送那一刻才算 |
| `unbring` | `{ "giftId": "<uuid>" }` | 从背包撤掉；只有 `idle` 件能撤，`out` 中的东西可能已经在对方磁盘上 |
| `gift-open` | `{ "giftId": "<uuid>" }` | 用系统程序打开（字条=`note.txt`，文件=本体）；**永不自动打开** |
| `gift-reveal` | `{ "giftId": "<uuid>" }` | 在文件夹里显示 |
| `gift-discard` | `{ "giftId": "<uuid>" }` | 扔掉：有磁盘记录就立刻整目录删除；没有记录（`pending` / `receiving` / `failed` / `refused`）只拉黑、不碰文件。两种情况都记进本次运行的黑名单 |
| `gift-copy` | `{ "giftId": "<uuid>" }` | 字条正文进剪贴板；文件没有可复制正文，明确拒绝 |
| `use-skin` | `{ "skinId": "<源 id>" }` | 换成本机素材注册表里的另一张皮（ticket 32 / ADR-0013）：只换外观、动作和对外 `skinId`；名字、身份、串门记录、礼物不动。未知 id `409 unknown-skin` |
| 农场 / 交易所 | `plant` / `harvest` / `water` / `fertilize` / `buy-seed` / `sell-crop`，小窗用同义 `farm-*` | 见「农场、交易所与雇佣 · 本机动作」。成功 `200`，失败 `409 { ok:false, error }` |
| 雇佣 | `hire` / `hire-listing` / `recall-worker` / `end-contract` | 见「农场、交易所与雇佣 · 雇佣」。雇佣请求最多等 1.8 秒（3 次发送） |
| 访客农场 | `farm-steal` / `farm-help` | 只在串门期间；`{ plotId, visitId? }`。宿主等 UDP 结果（~1.8 秒）后回一次 `action-result` |
| 农场小窗 | `farm-open` / `farm-close` | `farm-open`（`{ plotId? }`）是开关：窗口开着就关、否则打开/聚焦；`farm-close` 只关（幂等）。没有桌面层回 `409 desktop-off` |

### 名字只有一份（ADR-0007）

一只宠物只有一个名字。它住在 `dsh-pet` 的 `pets[].name` 里，本机的 `identity.json`
只是它的**镜像**：每次配置轮询（`CONFIG_TTL_MS`，30 秒）发现配置里的名字变了，就跟着改、
落盘、立刻补发一次广播。`dsh-pet` 缺席时镜像值就是唯一的名字（可改），它回来之后重新覆盖。

`rename` 在装了 `dsh-pet` 的机器上走它的官方接口：`GET /dsh-pet-7340/config` →
只改正在桥接那只的 `name` → `PUT /dsh-pet-7340/config`（body 是**用户层**的扁平
`{ "pets": [...] }`，不是 GET 那种按条目聚合的形状）。写成功之后才写镜像并广播。

**接口根本没挂载时直写配置文件**：`GET /config` 回 **404**（这个 DSH 里没有 dsh-pet 的路由，
例如它不在 profile 的 `dsh.profile.bundles` 里）→ 读改写 `<DSH_HOME>/dsh-pet/main-config.jsonc`
本身，只换目标那只的 `name`，别的顶层与宠物字段一个不动。名字的真相没搬家：用户把 dsh-pet
启用回来，它读到的就是新名字。代价是这条路径会丢 JSONC 注释（dsh-pet 自己的 `PUT /config`
同样会丢）。

**写不进去就整个不改**：`dsh-pet` 不可达 `409 dsh-pet-unreachable`、被它拒绝
`409 dsh-pet-write-failed`（带 `status`），本地昵称、桌面标签、广播内容一个都不动。
不在错误路径上制造“本地叫 A、`dsh-pet` 叫 B”的分叉。超时、连接被拒、5xx 都算不可达，
不会退化成直写文件——那种时候它可能正自己写这份配置。

名字按 32 码点截断（`MAX_NICKNAME`），与线路上的 `nickname` 同一个上限；空名在
`dsh-pet` 里是合法状态（回落成宠物 `id`），镜像照抄这个语义。

## 串门开关（用户故事 22，本机状态）

- `snapshot.acceptVisits` 是布尔值，默认 `true`；`snapshot.autoVisit.enabled` 默认 `false`。
  两个开关都落盘在 `<dataDir>/settings.json`：

  ```json
  { "version": 1, "acceptVisits": true, "autoVisits": false }
  ```

  文件不存在 = 接受入站串门、不自动出门；老文件没有 `autoVisits` 也按默认关；
  损坏/读不出 = 按默认值运行并只记一条日志；写不进 = 本次运行仍生效、也只记一条日志。
- 关掉后，**只拒绝入站 `visit-request`**：回 `visit-deny`，`reason` 为 `visits-off`，
  不创建访客、不写记录。发现广播、入站/出站心跳和本机出门都不受影响。
- 发起方收到 `visits-off` 时显示“「甲」关掉了串门，宠物这次没能进去。”，
  与没放行的“「甲」没有放行你”是两条不同的提示。
- `autoVisits` 是 ticket 09 的**自发出门**总开关，默认关。关掉时绝不自动出门，
  手动「串门」照常可用；打开后还要同时满足下面的四道门。

## 自发出门（ticket 09）

- 纯策略在 `src/visit-policy.js`：`planSpontaneousVisit({ now, enabled, lastActivityAt,
  lastDepartureAt, neighbors, neighborTtlMs, alreadyOut, random })`，四道门同时满足才返回
  `go: true` 和 `candidate`：
  1. `enabled`：总开关打开（默认关）；
  2. `lastActivityAt` 在最近 **10 分钟**内（`session/event` 优先，桌面指针活动兜底）；
  3. `lastDepartureAt` 为空或距今 **≥15 分钟**（手动出门也计入冷却）；
  4. 邻居表里存在**在线**（`lastSeen` 新鲜）、**我放行了它**（`status: allowed`）
     且**它放行了我**（`heartbeatAt` 新鲜）的邻居，随机挑一位。
- 没出门时 `reason` 是 `disabled` / `already-out` / `no-activity` / `cooldown` /
  `no-neighbor`，并写进快照 `autoVisit.lastDecision`；service 每次评估打一行节流日志，
  包含实际使用的活动信号（`session` / `pointer` / `none`）。
- `snapshot.visitTargets` 是同一套筛选规则算出的“现在可以手动去谁家”；
  手动按钮可以用它决定置灰。
- `snapshot.street` 是桌面邻居面板读的**派生视图**（ticket 20），形状
  `[ { deviceId, nickname, action, say, anim, canVisit, blockedReason, lastSeen } ]`：
  能去的在前、各自按 `lastSeen` 倒序，最多 16 户；`canVisit` 就是 `visitTargets` 的成员关系，
  不另立判定。`blockedReason` 只会是 `not-admitted` / `not-mutual` / `peer-offline` 之一。
  它**不上线**：不新增报文字段，远端无论发什么都写不进来；掉线的邻居靠内存里的
  `recentSeen` 灰着留 10 分钟，过后自动消失。

## 心跳影子（ticket 04，`snapshot.guests`）

v1 把心跳影子画成“访客”；v2 不画它。它现在是**在线/互放行的影子**：只用来回答
“这位邻居还在线吗、它放行我吗”，桌面上的宠物只有 `self` 与 `visitors`。

- 只有 `mayTalkTo` 为真的邻居心跳才会创建/刷新影子。`pending` / `denied` / 自己的
  心跳在 `room.observeHeartbeat()` 里直接丢弃，不产生任何可见效果。
- 影子形状（`snapshot.guests[]`）：

  ```json
  {
    "deviceId": "<uuid>",
    "nickname": "隔壁同事",
    "anim": "东张西望",
    "since": 1700000000000,
    "expiresAt": 1700000030000
  }
  ```

  `since` 是这一轮影子第一次被创建的时刻；后续心跳只更新 `anim` 和昵称，不改 `since`。
  `expiresAt` 是**最后一次心跳 + 30 秒**（additive 字段）；Host 在 TTL 到点时移除这条影子。
  影子表最多 8 位，满了挤掉最久没有心跳的那位。
- 心跳同时刷新邻居的 `lastSeen`：心跳也是“它还在线”的证据，不必等下一次广播。

## 串门（ticket 05）

### 发起

- 手动「串门」由本地页面发起：

  ```json
  { "action": "visit" }
  ```

  不带 `deviceId` 时由宿主随机挑一位**在线且已放行我**的邻居（见 `snapshot.visitTargets`；
  一个都没有时返回 `no-admitted` 或 `no-online` 和一句人话）。也可以显式指定
  `{ "action": "visit", "deviceId": "<邻居 uuid>" }`。手动永远不受总开关/活动窗口限制。
  宿主生成一个随机 `visitId`，把 `self.out` 置为 `requesting`，然后发 `visit-request`。
- 同一只本地宠物同时只能有一次出门。还在请求中或已经抵达时，再发起一次会得到
  `already-out` 和一句提示，不会覆盖第一次的状态。
- 未放行的邻居（`pending` / `denied`）直接得到 `not-admitted`；发现层没有地址
  （还没广播 / 刚离线）得到 `peer-offline`。如果对方关掉了入站串门，会得到
  `visits-off`（见“串门开关”）。
- 请求最多发 **3 次**（首次 + 两次重试，间隔约 600ms）。约 **1.8 秒**还没收到
  `visit-ack`，就清掉请求状态、报 `timeout`，宠物留在家。
- 只有拿到 `visit-ack` 才算抵达：`self.out.phase` 从 `requesting` 变成 `active`，
  `startedAt` 是 ack 时刻，`endsAt` 是 `startedAt + 30 分钟`（出门硬上限）。

### 接收

- 收到合法 `visit-request` 时，先看本机 `acceptVisits` 开关：关着 → 回 `visit-deny`，
  `reason` 为 `visits-off`，不创建访客。开关开着时，`mayTalkTo(deviceId)` 为真 →
  创建/刷新一位入站访客，回 `visit-ack`；否则回 `visit-deny`（`reason` 为
  `not-admitted`）。未知字段、坏版本、坏 UUID、超 4 KiB 的包在协议层就丢了，什么都不回。
- 入站访客形状（`snapshot.visitors[]`）：

  ```json
  {
    "deviceId": "<uuid>",
    "nickname": "隔壁同事",
    "anim": "东张西望",
    "visitId": "<uuid>",
    "since": 1700000000000,
    "lastSeen": 1700000000000,
    "endsAt": null
  }
  ```

  `since` 是请求被接受的本机时刻，`lastSeen` 是最近一次心跳；入站访客没有时间上限，
  `endsAt` 固定为 null。昵称优先取邻居表/放行名单，取不到才用请求里的昵称；
  `visit-request` 不能改本机 `self.nickname`。访客身上可能还有一个可选的 `gift`
  对象（只在这次串门带了礼物时出现），形状与状态见「礼物字段」。
- 同一 `deviceId` 只有一位入站访客。重试（同 `visitId`）只刷新动作、`lastSeen` 与 id，
  不重置 `since`，也不会多写一条记录；换了 `visitId` 也仍然只保留一位，
  防止记录被重复请求刷爆。**不设同屏上限**：只有放行名单里的 deviceId 能进来。
- 接收方自己跑失联计时：对方 2 分钟没有心跳就清掉访客、写一条 `in` 记录，
  **不依赖发起方还在**。邻居 30 秒过期不会把串门访客一起带走。

### 召回与结束

- 出门结束的四种方式：对方「送客」、本机「召回」、30 分钟上限、对方 2 分钟失联。
  每种都只写一条 `out` 记录，`durationMs` 是真实停留时长（封顶 30 分钟）。
- 发出 `visit-recall` 的一方按 **3 次**重发（首次 + 两次，间隔约 500ms），收到
  `visit-recall-ack` 或对方已不可达就停；1.5 秒内都没有回执也不再发。
  重发是幂等的：接收方按 `deviceId` 清掉同一位访客，只写一条 `in` 记录。
- 发起方 30 分钟到点或对方失联（`tick`）→ 写 `out` 记录、清 `self.out`、发一条
  `visit-recall`；接收方收到 recall 立即清掉访客并写 `in` 记录，并回一条
  `visit-recall-ack`。接收方按 `deviceId`
  认那一位访客（同一设备最多一位），所以迟到或携带旧 `visitId` 的 recall 也能立即清场；
  发起方仍然严格按 `visitId` 匹配，避免旧 recall 误伤一次新的出门。
- 本地页面随时可以召回：

  ```json
  { "action": "recall" }
  ```

  还在请求中 → 只取消，不写记录、不发包；已抵达 → 写 `out` 记录并发 `visit-recall`。
- 接收方也可以提前结束：

  ```json
  { "action": "end-visit", "deviceId": "<访客 uuid>" }
  ```

  写 `in` 记录、立即清场，并发 `visit-recall`（带重试）让对方回家。对方收到后写
  `out` 记录并回一条 `visit-recall-ack`，**不再回 recall**。入站访客没有 TTL，
  主人不点「送客」它就一直待着；对方 2 分钟没有心跳时由本机自己清场并写 `in`
  记录（用户看到“对方失联”）。
- 双方各写各的记录，不交换记录内容。

### 失败：永远是一句可读的话

`snapshot.notices` 是 `{ text, at }` 的数组（最新在前，最多保留 3 条给客户端）。
串门失败各自有不同文案：

| 内部 code | 用户看到的提示（示例） |
| --- | --- |
| `not-admitted` | 还没放行「甲」，先接受它的放行卡片，宠物才能过去。 |
| `peer-offline` | 「甲」好像不在线，宠物这次没出门。 |
| `timeout` | 「甲」没有回应，等了一会儿，宠物先留在家里了。 |
| `denied` | 「甲」没有放行你，宠物没能进门。 |
| `visits-off` | 「甲」关掉了串门，宠物这次没能进去。 |
| `already-out` | 宠物已经在「甲」家了，先召回来再说。 |

本地页面只看 `text`，不解析 code；没有堆栈、没有 socket 细节。

### `visit-deny` 的应用层出站例外

`discovery.sendTo()` 必须先过 `mayTalkTo`。但“没放行”的接收方需要回一句明确的
`visit-deny`，否则发起方只能等到超时，分不清“被拒绝”和“没人理”。因此
除发现层对合法 beacon 的自动回执外，`discovery.sendReply()` 是唯一绕过
`mayTalkTo` 的应用层出口：

- 只用于 `visit-deny`，且只发给刚刚发来合法 `visit-request` 的来源；
- `reason` 只会是 `not-admitted` 或 `visits-off`，不带自由文本；
- 仍然是同一条 socket、同一张地址表、同样的 4 KiB 上限；
- 按 **UDP 源地址** 限速 **2 次 / 5 秒**（不按报文里的 `deviceId`——那是可以每次换的），
  不给反射放大留空间；
- 心跳、`visit-request`、`visit-ack`、`visit-recall` 全部继续走 `sendTo`。

## 串门记录（ticket 06）

- 每次串门完成时，双方各追加一条记录（送客、召回、30 分钟上限、对方失联、清场都算）。
  `durationMs` 是真实停留时长，**封顶 30 分钟**。记录固定四个字段，外加一个可选的 `gift`：

  ```json
  { "direction": "out", "nickname": "隔壁同事", "startedAt": 1700000000000, "durationMs": 60000 }
  { "direction": "in", "nickname": "楼下的柯基", "startedAt": 1700000000000, "durationMs": 60000,
    "gift": { "kind": "file", "name": "报价单.pdf" } }
  ```

  `direction` 是 `out`（我出门）或 `in`（对方来我家）；`nickname` 是**对方**的昵称；
  `startedAt` 是这次串门在本机开始的时刻；`durationMs` 是停留时长（≤30 分钟）。
  请求中就被取消/超时/拒绝的串门没有抵达，不写记录。
- `gift` 是 ticket 27 加的可选摘要：`{ kind: 'text'|'file', name? }`。**只记摘要，不记字条正文**；
  文件只记清洗后的显示名。字段非法只丢 `gift`，整条记录照常保留；旧文件没有这个字段照常读，
  下次写入也不会补出来。
- 文件是 `<dataDir>/visits.json`：

  ```json
  {
    "version": 1,
    "visits": [
      { "direction": "out", "nickname": "隔壁同事", "startedAt": 1700000000000, "durationMs": 60000,
        "gift": { "kind": "text" } }
    ]
  }
  ```

  最新在前，滚动上限 **200** 条，超出丢最旧的；单次写入是整个有界数组。
  正常写上面这个对象；手改成裸数组也认，下一次写入会恢复对象形状。
- 容错与 `peers.json` 一致：文件不存在 = 空记录；损坏/形状不对 = 空记录 + 一条日志；
  单条非法 = 跳过该条 + 一条日志；写不进去 = 内存里照常有记录 + 一条日志。
  **记录坏掉不影响桌面和串门本身**：`room` 始终有一份内存记录，快照照常可读。
- 快照只给最近 5 条（`snapshot.visits`，最新在前）：`visits.json` 仍保留 200 条，
  只是 `snapshot` 这一层不把全部历史交给客户端。快照里的记录同样可能带 `gift`，
  形状与 `visits.json` 完全一致（`in` / `out` 都写）。
- `GET /dsh-zoo/state` 是**本机**的状态出口：在 `snapshot` 之外多 `backpack` / `gifts` /
  `skin` 三项（见 README 的「带派」与「换皮」段）。`skin` 是当前那张皮
  `{ id, size, idle }`（没有素材源时是 `null`）。它们只反映本机的背包、已收下的礼物
  与当前皮，不是线路协议的一部分，远端写不进来。

## 礼物字段（`visit-request.gift`，ticket 23 / 25）

礼物只随串门走：它只出现在 `visit-request` 里，一次串门最多一件。没有单独的礼物报文。

```json
{ "id": "<uuid>", "kind": "text", "text": "给你留了张便条…" }
{ "id": "<uuid>", "kind": "file", "name": "报价单.pdf", "size": 23194,
  "sha256": "sha256:…64 位小写十六进制…" }
```

规则：

- `id` 是 UUID 形状（复用 `isVisitId`），是线路上的键、`gift-received` 的关联键，也是
  礼物路由的拉取键；它**不是**落盘目录名。目录名由 `receivedAt` 与 `id` 前 8 位推出，
  拼路径前一律严格正则，绝不信报文里的字符串。
- `kind` 只能是 `text` 或 `file`，别的值整条 `gift` 丢弃。
- `text`：≤500 码点；清洗时**保留换行**，去掉其余控制字符与双向覆盖符，首尾空白裁掉。
  字条正文只出现在这条报文与接收方磁盘上，**不进记录、不进 `/state`**。
- `name`：≤120 码点，去掉路径分隔符、控制字符、双向覆盖符与前导点；清洗后为空退成 `file`。
- `size`：整数，`1 … 16 MiB`；`sha256`：`sha256:` + 64 位小写十六进制。
- **礼物坏了不丢串门**：`gift` 校验不过就整条丢掉，`visit-request` 照常 ack，接收方只是
  没有卡片。这与 `anim` 非法整包丢弃不同——一道便条不该把一次串门搞砸。
- 编码后整包超过 4 KiB：丢掉 `gift` 重编一次，并在本机说一句「字条太长了，这次没带上」。
  实测最坏基准包 945 B，500 码点 emoji 字条约 3.0 KB——正常触不到，这是防御路径。
- 旧版本收到 `gift` 直接忽略（白名单重建）；新版本收到没有 `gift` 的旧报文就是没有礼物。

接收方在内存里把礼物挂在**这一次访客**上（`snapshot.visitors[].gift`）：

```json
{ "id": "<uuid>", "kind": "file", "name": "报价单.pdf", "size": 23194, "status": "received" }
```

`status` 只会是 `pending`（刚到）/ `receiving`（取回中）/ `received`（收下了）/
`failed`（没取到）/ `refused`（没收下）。字条在 `received` 时才带 `text`；文件在
`received` 时才带缩略图地址。状态只由本机 service 改（写盘成功、拉取失败、超限/限速），
远端报文不能直接写 `status`。

## `gift-received`（送达回执，ticket 26）

接收方**真的把字条或文件写进 `gifts/` 之后**才发这条回执：

```json
{ "v": 1, "type": "gift-received", "deviceId": "<uuid>", "visitId": "<uuid>", "giftId": "<uuid>" }
```

- 发 3 次（首次 + 两次重试，间隔约 400ms）；任意一次送达即可，重复回执照旧忽略。
- 发起方收到才把背包里那件删掉，并说一句「「某某」收下了。」；没收到就等这次串门结束，
  把礼物退回背包，说一句「没送到」。
- 失败（`failed` / `refused`）**不发回执**：东西没有真的落盘，不能假装送到了。
- `gift-received` 是独立报文类型，**不塞进** `visit-ack` / `visit-recall` 那条只重建四个
  字段的 `visit-*` 分支；落到未知类型会被当成 `beacon` 静默吞掉，不报错但礼物永远删不掉。
- 它只表达「哪一件到了」：不带文件名、大小、路径或任何自由文本。

## 礼物路由（HTTP，只读，ticket 25）

文件本体不进 UDP，由接收方在访客抵达时向对方**拉取**。路由挂在既有的只读素材源上，
与素材共用同一个端口（默认 `45873`，`DSH_ZOO_SKIN_PORT` 可覆盖）：

```
GET /dsh-zoo-gift/<giftId>   → 文件本体
```

- **只在 armed 期间可读**：发起方发出这次 `visit-request` 之后 5 分钟内，且这次串门没有结束。
  其他时间一律 `404`；不列目录、不认识任何别的路径。
- 只读**背包里登记过的那一个本机绝对路径**：报文里没有任何路径字段，路由也不拼用户输入。
- `200` + `Content-Type: application/octet-stream` + `Content-Length`；v1 不做 Range。
- 文件在发送之后被改动或删掉（大小或 sha256 不符）→ `410 gone`，一个字节都不发。
- 超过 16 MiB → `413`；非 GET/HEAD → `405`。
- 串门结束（回家 / 送客 / 超时 / 失联 / 被拒绝）立即 unarm；5 分钟到点也自然失效。
- 没装素材源的用户也会监听这个端口——它必须保持**只读、只按 id 白名单、不列目录**。

## 农场、交易所与雇佣（ticket 39–45）

农场是本机账本（`farm.json` / `market.json` / `contracts.json`）；成交永远在本机交易所，
只有偷/帮/雇和行情 gossip 跨机。所有新报文都遵守文末的 4 KiB、白名单和旧邻居规则。

### 状态出口 `GET /dsh-zoo/state`

在原有 room 快照之外多三项（只加字段）：

```json
{
  "farm": {
    "plots": [
      { "id": "p1", "crop": "tomato", "plantedAt": 1700000000000,
        "grownMs": 0, "growMs": 1800000, "waterings": 0,
        "fertilized": false, "stolenBy": ["<uuid>"], "helpedBy": [] }
    ],
    "coins": 30,
    "seeds": { "tomato": 2 },
    "crops": {},
    "dew": 0,
    "dewEarned": 0,
    "guard": 0.3,
    "worker": null,
    "hire": { "enabled": false, "wagePerHour": 10, "minHours": 2, "maxHours": 8 },
    "log": [ { "at": 1700000000000, "kind": "harvest", "crop": "tomato", "qty": 3 } ]
  },
  "market": {
    "prices": { "tomato": { "base": 5, "price": 5.2, "volume24h": 12, "at": 1700000000000 } },
    "index": { "tomato": { "price": 5.1, "at": 1700000000000, "samples": 2 } },
    "history": [ { "crop": "tomato", "side": "sell", "qty": 3, "price": 4, "at": 1700000000000 } ]
  },
  "contracts": { "outgoing": [], "incoming": [] }
}
```

- `farm.plots` 固定 `p1`–`p4`。空地是 `crop: null`、`plantedAt: null`、`growMs: 0`；
  成熟看 `grownMs >= growMs`，日志里不另给阶段。
- `farm.seeds` / `farm.crops` 是**稀疏计数**：缺键就是 0；每种上限 999。`coins` 上限 1,000,000。
- `farm.dew` 是当前余额，`farm.dewEarned` 是「今天已经挣到」的露水（花掉不会回退）。
  两者都 ≤48；跨本地日归零。`dewEarned` 是对 SPEC v5 字段表的一个 additive 字段。
- `farm.guard` 是 0..0.8 的守卫值；`farm.worker` 是 `null` 或
  `{ nickname, contractId, endsAt, guard: 0.5 }`——**不带 deviceId**。
- `farm.hire` 就是本机挂牌；`farm.log` 最新在前，**文件/农场小窗最多 50 条**，
  `/state.farm.log` 只给最近 **20** 条。条目字段 `{ at, kind, crop?, qty, who?, hours?, wage?, earned? }`。
  `kind` 是 `plant` / `harvest` / `steal` / `help` / `hire` / `settle`；`who` 出现在
  偷/帮/雇/结算日志里（昵称，≤32 码点），被抓住是 `qty: 0`。`hire` 带 `hours`/`wage`，
  `settle` 带 `wage`/`earned`，都只用于显示。
- `market.prices` 保持 `market.json` 的形状（`base/price/volume24h/at`），**不带 `bid`**；
  `bid` 只出现在农场小窗的交易所页。`market.history` 最新在前，最多 50 笔；
  `market.index` 在 store 起来后每种作物都有一条：有新鲜 peer 时是 peer 价格的中位数
  （`samples` = peer 数），没有 peer 时是本机价、`samples: 0`（窗口画成「本机行情」）。
- `contracts` 的每一项是公开视图：
  `{ id, requestId, workerDeviceId, workerNickname, hours, wagePerHour, wage, fee,
     startedAt, endsAt, ackedAt, status, earned, endedAt, endReason, settled,
     settledAt, recallRequested, remainingMs, provisionalEarned }`（`outgoing`），
  `incoming` 把前两项换成 `employerDeviceId` / `employerNickname`。每侧最多 20 条；
  `status` 是 `pending` / `active` / `ended` / `cancelled`；`provisionalEarned` 只给 UI，
  绝不用于结算。`contracts` 是**本机**出口，才允许出现 deviceId；访客快照不含。

### 本机动作（`POST /dsh-zoo/action`）

成功 `200`，失败 `409 { ok: false, error, ... }`。桌面小窗的地块/交易动作使用带
`farm-` 前缀的同义写法，两种走同一个分支；雇佣动作同名。所有数量、价格、总价都由宿主算，
请求体只给 id / 枚举。

| action | body | 成功返回 | 主要错误 |
| --- | --- | --- | --- |
| `plant` / `farm-plant` | `{ plotId, cropId }` | `{ ok, action, plotId, crop, plot, coins, seeds, crops, dew, dewEarned, persisted }` | `bad-plot` `bad-crop` `plot-occupied` `no-seed` `starting` |
| `harvest` / `farm-harvest` | `{ plotId }` | 同上，另带 `qty`，`plot` 是空地 | `bad-plot` `not-mature` `starting` |
| `water` / `farm-water` | `{ plotId }` | `{ ok, action, plotId, plot, coins, seeds, crops, dew, dewEarned, persisted }` | `bad-plot` `already-watered` `no-dew` `starting` |
| `fertilize` / `farm-fertilize` | `{ plotId }` | 同上 | `bad-plot` `already-fertilized` `no-dew` `starting` |
| `buy-seed` / `farm-buy-seed` | `{ cropId, qty }` | `{ ok, action, cropId, qty, unitPrice, total, price, coins, seeds, crops, dew, dewEarned, notice, persisted }` | `bad-crop` `bad-qty` `no-coin` `cap` `market-busy` `starting` |
| `sell-crop` / `farm-sell-crop` | `{ cropId, qty }` | 同上，`action` 是 `sell-crop`，`price` 是成交后的本机价 | `bad-crop` `bad-qty` `no-crop` `market-busy` `starting` |
| `hire` | `{ deviceId, hours }` | `{ ok, action: "hire", contractId }`（收到 `work-ack` 才算成功） | `bad-device-id` `bad-hours` `own-pet` `worker-unavailable` `already-hired` `busy` `no-coin` `starting` `disposed` |
| `recall-worker` | `{ contractId }` | `{ ok, action, contractId }`；合同已结束时带 `alreadyEnded: true` | `bad-device-id` `contract-not-found` `contract-ended` `starting` |
| `end-contract` | `{ contractId }` | `{ ok, action, contractId }`；还在 pending 时带 `cancelled: true` | `bad-device-id` `contract-not-found` `starting` |
| `hire-listing` | `{ enabled, wagePerHour, minHours, maxHours }` | `{ ok, action, hire }` | `bad-enabled` `bad-wage` `bad-hours` `starting` |
| `farm-steal` / `farm-help` | `{ plotId, visitId? }` | `{ ok, action, plotId, crop?, qty?, caught?, notice }` | 见「偷菜与帮忙」 |
| `farm-open` | `{ plotId? }` | 开关：关着时打开/聚焦，返回 `{ ok, action:"farm-open", window:"opened", mode }`；已开着时关闭，返回 `{ ok, action:"farm-open", window:"closed" }` | `desktop-off` |
| `farm-close` | 无 | `{ ok, action:"farm-close", window:"closed" }`；已经关着也成功（幂等） | `desktop-off` |

`plant` / `harvest` / `water` / `fertilize` 的 `plot` 是修改后的完整地块；
`buy-seed` / `sell-crop` 的 `qty` 必须是 1–99，每分钟最多 10 笔（买 + 卖共享），
超了是 `market-busy`。卖作物时仓库不够是 `no-crop`（和买种子的 `no-seed` 分开），
与买种子时的“没有种子”区分。`hire-listing` 的 `minHours <= maxHours`，范围 2–8；
`hire` 的 `hours` 也必须在 2–8 之间，且落在对方挂牌的 `minHours..maxHours` 内。

`farm-steal` / `farm-help` 不是本机农场动作：它们只在串门期间有效，宿主把它转成 UDP
`farm-action`，等结果后再更新本机仓库。`visitId` 可省略（宿主用当前出门的 `visitId`）；
给了但和当前串门不一致时是 `no-visit`。

主要错误码（人话在 `src/farm-text.js`，HTTP 不返回路径/堆栈）：

| 错误码 | 含义 |
| --- | --- |
| `bad-plot` | 地块不是 `p1`–`p4`，或这块地不能做这个动作（空地浇水、成熟地帮忙等） |
| `bad-crop` | 作物不是三种之一 |
| `plot-occupied` | 这块地已经种了 |
| `not-mature` | 收获时还没熟 |
| `already-watered` / `already-fertilized` | 这一株已经浇过 / 施过 |
| `no-seed` | 仓库没有这种种子（买种子的语境） |
| `no-crop` | 卖作物时仓库没有这种作物 |
| `no-coin` / `no-dew` | 硬币 / 露水不够 |
| `bad-qty` | 数量不是 1–99 的整数 |
| `cap` | 仓库/次数到上限：种子或作物 999、偷菜/帮忙日限额、访客本机跨农场限额 |
| `market-busy` | 一分钟内已经成交 10 笔，或交易所还没准备好 |
| `no-visit` | 这次串门已经结束，或 `visitId` 与当前串门不一致 |
| `no-port` | 对方没有开局域网端口，拿不到农场快照 / 发不出访客动作 |
| `already-stolen` / `already-helped` | 这一轮已经偷过 / 帮过这块地 |
| `guard` | 被守卫抓住；同时带 `caught: true`，没有罚款 |
| `worker-unavailable` | 对方不在家 / 在串门 / 在打工 / 没挂牌 / 挂牌时段不含这次时长 |
| `own-pet` | 不能雇自己 |
| `already-working` / `already-hired` | 对方宠物已在打工 / 我家已有一位雇工 |
| `bad-wage` / `bad-hours` / `bad-enabled` | 挂牌或雇佣参数不合法 |
| `contract-not-found` / `contract-ended` / `contract-busy` | 合同不存在 / 已结束 / 正在结算 |
| `busy` / `starting` / `disposed` | 上一笔还在联系中 / 宿主还没起来 / 正在关闭 |
| `timeout` | 1.8 秒内没收到对方结果；访客动作可能白跑，雇佣请求会退款 |

### 农场快照（HTTP，ticket 43）

访客打开主人的农场时，由**访客的宿主服务**（不是 helper）向主人拉一份只读 JSON：

```
GET /dsh-zoo-farm/<visitId>   → 访客视角的快照
```

- **只在这次串门活跃期间可读**：授权直接从 room 的 `visitors` 派生（`visitorByVisitId`），
  送客 / 对方召回 / 失联 / 信任收紧 / 宿主 dispose 五条结束路径都会让下一次请求自然
  `404`。没有第二张 armed 表，也没有“曾经来过”的 410/403。
- 形状：
  `{ v, visitId, host:{nickname}, guard, guardParts:{ownerHome,worker}, plots[], limits, hire, market, at }`。
  `plots` 固定 `p1..p4`，每块只给 `id/crop/stage/mature/remainingMs` 与
  **`stolenByMe`/`helpedByMe` 两个布尔**；绝不回传 `stolenBy`/`helpedBy` 原数组
  （那里是别的访客 deviceId），也不含任何路径。`market` 是交易所页的摘要
  （含 `bid` / 新鲜指数），不带历史。
- `limits` 是主人侧给这位访客的计数：
  `{ steal: { perVisit, usedInVisit, perFarm, usedOnFarm, perDay, usedToday },
     help: { perVisit, usedInVisit, perFarm, usedOnFarm, perDay, usedToday } }`。
  `usedToday` 是访客本机账本（跨农场），只有访客自己算得清；主人侧只保证
  `usedInVisit` / `usedOnFarm` 是这家农场的账。
- `200` + `application/json; charset=utf-8` + `cache-control: no-store`；
  坏 `visitId`、未知/已结束、多一段路径一律 `404`；非 GET/HEAD → `405`；HEAD 只回头。
- 访客侧只连私网/回环：2 秒超时、响应 ≤64 KiB、失败按 `address:port` 冷却 60 秒；
  `404` 等同于“这次串门结束了”，窗口切到 `ended`，不再重试。

### 偷菜与帮忙（`farm-action` / `farm-action-result`）

访客 helper → 访客宿主（`farm-steal` / `farm-help`）→ UDP `farm-action` →
主人校验 → 落账 → UDP `farm-action-result` → 访客宿主更新仓库（偷来的作物、帮忙的硬币）
→ helper 刷新。

- 主人按 `${deviceId}:${requestId}` 缓存最近 **200** 条结果（10 分钟 TTL）；
  **落账之后**才写缓存（失败也写），重发原样回放，不重新 roll 守卫、不重复扣。
- 未授权的 `farm-action`（`visitId` 不匹配当前访客 / `deviceId` 冒用）**静默丢弃**，
  不回错误，避免把“这个 visitId 存在过”变成 oracle。
- 访客侧首次 + 两次重发（间隔约 500ms），**1.8 秒**没结果就 settle `timeout`；
  重发复用同一个 `requestId` 和同一串字节。
- 偷：目标成熟；一次 1 个；这块地这一轮还没被这位访客偷过。成功 → 访客仓库 +1、
  主人 `stolenBy` + 访客、收获时少 1、主人日志一条；失败 → 这次白跑，没有罚款。
  **被抓也消耗一次当日次数**（访客本机跨农场 10、这家的访客 3、这家农场 5），
  `stolenBy` 只在成功时标记；换新 `requestId` 重试不能绕过上限。
- 帮：目标还在生长；这位访客这一轮没帮过这块地。访客花 **1 露水**（**发出前**扣，
  失败/超时退回），地块 +10% 生长，访客得 **1 硬币**。成熟地/空地帮忙是 `bad-plot`。
- 上限：偷 3/访客/农场/天、5/农场/天、10/访客/天；帮 3/访客/农场/天、5/访客/天；
  每块地每轮每访客各一次。“10/访客/天”和“5/访客/天”是访客本机跨农场账本，
  主人只回自己农场的计数。
- 守卫 = 主人在家 0.3（主人在串门/打工时为 0）+ 雇工 0.5，封顶 **0.8**；
  成功率 `1 − 守卫`。守卫判定在主人侧，随机源可注入；被抓住只写一条 `qty:0` 的日志，
  同一访客每天的桌面提示只发一次（日志仍每次一条、有界 50）。

### 行情 gossip（`market-digest`）

每 **30 秒**（或本机价格/挂牌签名变化时）向所有放行邻居单播一条：

```json
{ "v": 1, "type": "market-digest", "deviceId": "<uuid>", "at": 1700000000000,
  "prices": { "tomato": 5.2, "carrot": 6.1, "pumpkin": 31 },
  "hire": { "enabled": true, "wagePerHour": 10, "minHours": 2, "maxHours": 8,
            "guard": 0.5, "available": true, "reason": "ready" } }
```

- 发送走 `discovery.sendTo`（内部再查 `mayTalkTo`），失败不重试，下一拍自然补；
  没有放行邻居时不算“发过”。
- 接收端四道门：只认已放行邻居；`at` 与本机时钟相差 ≤**2 分钟**；同一 peer
  **30 秒最多 1 条**；价格只认三种作物、有限数、`[base×0.5, base×2]`。坏价格只丢那一种，
  坏 `hire`/形状/时间才整包丢。未知字段在解析时丢掉。
- 每家按 `deviceId` 只留最近一条 digest；指数只取**新鲜 peer 价格的中位数**（不含本机），
  `samples` 是 peer 样本数（一个 peer 时是 1）。没有 peer 样本时指数退化为本机价、
  `samples: 0`，交易所页显示「本机行情」。
- 成交价：`effective = 0.85 × 本机 price + 0.15 × 新鲜指数`；没有新鲜指数时只用本机价。
  `bid = round(effective × 0.9)`。价格夹在 `[base×0.5, base×2]`；每 10 分钟向 base
  回归 3%。卖 `q` 个：`price = clamp(price × (1 − 0.12 × q / 20), base×0.5, base×2)`；
  种子按表里的固定价卖，买种子不影响作物价。
- 指数过期后保留最后一次值（交易所页画灰），但不再参与定价；邻居被拒绝/移除时
  它的 digest 和指数贡献一起清掉。

### 雇佣合同（8 种 `work-*`，ticket 44）

合同是**预付 + 按实际时长结算**；没有托管账户，钱只在双方本机账本和报文里走。

| 类型 | 方向 | 字段 | 幂等键 |
| --- | --- | --- | --- |
| `work-request` | 雇主 → 雇工主人 | `requestId` / `hours` / `wagePerHour` / `fee` | `requestId` |
| `work-ack` | 雇工主人 → 雇主 | 同上 + `ok`；成功带 `contractId` / `startedAt` / `endsAt` / `guard` | `deviceId:requestId` |
| `work-recall` | 雇工主人 → 雇主 | `contractId` | `contractId` |
| `work-recall-ack` | 雇主 → 雇工主人 | `contractId` / `ok` | `contractId` |
| `work-end` | 雇主 → 雇工主人 | `contractId` 或 `requestId` / `reason` | 目标 id |
| `work-end-ack` | 对方 → 发起方 | `contractId` / `requestId` / `ok` | 目标 id |
| `work-settle` | 雇主 → 雇工主人 | `contractId` / `requestId` / `servedMs` / `earned` / `reason` | `requestId` |
| `work-settle-ack` | 雇工主人 → 雇主 | `contractId` / `requestId` / `ok` / `earned` | `contractId` |

流程与规则：

1. **挂牌**：主人在 `farm.json` 的 `hire` 里写 `enabled/wagePerHour/minHours/maxHours`，
   随 `market-digest.hire` 广播；`available`/`reason` 是真实可用性（ready/off/visiting/
   working），`guard` 是雇工贡献的 0.5（不是合成后的农场守卫）。只有在线、在家、
   没在串门/打工的宠物能被雇。
2. **请求**：雇主选 `deviceId` + `hours`，宿主算 `wage = 时薪 × 时长`、
   `fee = ceil(wage × 5%)`（最低 1，烧掉），先落 pending 合同并扣 `wage + fee`，再发
   `work-request`。首次 + 两次重发（约 500ms），1.8 秒没 ack 就取消并全额退款。
3. **确认**：雇工主人再校验一遍在线/在家/挂牌/时段/时薪/手续费；落 `incoming` 合同、
   进 `working`、创建 `contractId` 后回 `work-ack`。雇主收到 ack 才把合同置 active，
   `ackedAt` 用雇主本地时钟。
4. **`working`**：雇工不出现在自己家（`self.work`），出现在雇主农场（`worker` 镜像 +
   `role:'worker'`/`badge:'work'`），雇主守卫 +0.5。合同期内它不能再串门、不能再被雇；
   v1 一个农场最多一位雇工，不能雇自己（D2 允许同一位宠物既当雇主又当雇工）。
5. **结束**：主人 `work-recall`；雇主 `work-end`（`reason` 为 `employer-end`）；
   到期 `expired`；任一方离线按最后心跳 `offline`。结束写 `ended` / `endReason`，
   然后双方走 `work-settle` / `work-settle-ack`。
6. **结算**：`earned = floor(wage × servedMs / contractMs)`；`servedMs` 只取**雇主本地时钟**
   从收到 ack 到结束的差值，跨机只用 `endsAt − startedAt` 这个差值。雇工主人用自己的
   合同重算并夹在 0..wage，给 `earned` 入账一次并回 ack；雇主拿回 `wage − earned`，
   手续费不退。`requestId`/`contractId` 重发只回放、不重复加钱。
7. **离线/重启**：合同的一方在最后心跳后判离线，按最后心跳结算；重连后按 `contractId`
   幂等补发。`work-*` ack 缓存最近 **200** 条 / 10 分钟；结算/召回重试 1 秒起步、
   指数退避封顶 30 秒。
8. **枚举**：合同 `status` 是 `pending` / `active` / `ended` / `cancelled`；
   结束原因见字段表；结算原因只允许 `completed` / `recall` / `employer-end` / `offline` /
   `expired`。`contractId` / `requestId` 都是 UUID 形状。

### 限额与边界

| 项 | 值 |
| --- | --- |
| 地块 / 作物 / 初始 | 4 块 / 3 种 / 30 硬币 + 2 番茄种子 + 0 露水 |
| 硬币 / 每种种子或作物 | 1,000,000 / 999 |
| 露水 | 每 10 分钟待机 +1，每天最多挣 48、余额 48；本地午夜重置 |
| 离线生长 | 一次最多补 12 小时；运行中按真实时间 |
| 农场日志 / 行情历史 | 50 / 200（`/state` 分别 20 / 50） |
| 合同 | 每侧 20 条，未结算的不淘汰；2–8 小时；时薪 1–100；手续费 5%（向上取整、最低 1） |
| 偷菜 / 帮忙 | 3/5/10 与 3/5/1（每地每轮）；帮忙每次 1 露水 / +1 硬币 |
| 行情 | 1 条/30 秒/peer；样本 2 分钟内；价格夹在 `[base×0.5, base×2]` |
| 买卖 | 1–99 个/次；10 笔/分钟；价格夹取；`bid = round(effective × 0.9)` |
| 幂等缓存 | `farm-action` 200 条/10 分钟；`work-*` ack 200 条/10 分钟 |
| 守卫 | 0.3（主人在家）/ 0.5（雇工）/ 0.8（两者），宠物出门/打工时自家 0 |
| 快照 | HTTP ≤64 KiB；访客宿主 2 秒超时、60 秒冷却 |

### 4 KiB、白名单与旧邻居

- **4 KiB**：所有 UDP 报文都是单个 JSON，超过 4 KiB 在解析前丢弃；不回复、不报错。
  `market-digest` 和 8 种 `work-*` 都很小（价格 3 个数、合同 6 个字段），正常触不到上限。
  农场快照走 HTTP，不受 UDP 4 KiB 限制，但访客客户端仍只收 ≤64 KiB。
- **字段白名单**：每种类型只重建自己的字段；未知字段、未知作物、未知枚举、越界数字
  一律丢弃或整包拒绝。所有 id 只从校验过的字段拼，不拼路径。
- **旧邻居**：旧版本只认识自己的报文类型，`market-digest` / `farm-action(-result)` /
  `work-*` 会被当成未知类型静默丢掉，不报错、不崩。新端收到旧端：缺 `action`/`skin*`/
  `gift` 都按本文的兼容口径降级；没有农场报文时，本地农场照常运行，只是不能跨机偷/帮/雇。
- **降级**：旧邻居 → 串门/礼物/记录照常，没有农场入口；对方没开局域网端口 → 串门照常、
  快照取不到、偷/帮/雇不可用；对方离线 → 不能偷/帮/雇，行情过期，合同按最后心跳结束；
  没有桌面层 → HTTP 动作与 `state` 可用，没有农场窗，也没有雇工宠物。

### 改名前后的路径（ADR-0014）

项目从 `dsh-local-pet` 改名为 `dsh-zoo`，路由随之改成 `/dsh-zoo-skin/*` 与
`/dsh-zoo-gift/<giftId>`。为了和改名前的邻居混跑：

- 服务端同时接受旧路径 `/local-pet-skin/*`、`/local-pet-gift/<giftId>`；两组都是只读的。
- 新客户端拉 manifest、素材或礼物文件时先试新路径，`404` 后再回落旧路径；`410` / `413` 等
  不回落（那是对方给出的真实结论）。
- 旧路径只用于兼容，不写进 beacon，也不在 README 的新用法里出现。

## 敌意输入边界（必须保持）

- 单包 **4 KiB** 上限，超过在解析前丢弃。
- 只认上表字段；未知字段重建时丢弃，不报错、不转发。每种类型只校验/重建自己的字段。
- `deviceId`、`visitId`、`gift.id`、`giftId` 必须是 UUID 形状，`port` 必须是 1..65535 的整数；
  `visit-deny` 的 `reason` 只接受固定枚举（缺失按 `not-admitted`）；
  心跳的 `anim` 必须是 `null` 或安全动画名；`visit-request` 的昵称必须可读，
  `anim` 必须显式存在且为 `null` 或安全动画名；缺失/路径/控制字符一律拒绝。
- 礼物字段各自过白名单：`text` ≤500 码点且保留换行，`name` ≤120 码点且去路径分隔符/控制字符/
  前导点，`size` 是 1…16 MiB 的整数，`sha256` 是 `sha256:` + 64 位小写十六进制。
  任何一项不合格只丢 `gift`，`visit-request` 照常；`gift` 里的未知字段全部丢弃。
- 每来源（UDP 源地址）滑动窗口限速（20 包 / 10 秒），超限丢弃而不是排队；
  回执另有 1 次 / 4.5 秒，`visit-deny` 另有 2 次 / 5 秒的上限（同样按源地址）。
  心跳是每邻居 5 包 / 10 秒，串门请求最多 3 包 / 次，`visit-recall` 最多 3 包 / 次，
  `visit-recall-ack` 每条 recall 最多 1 包。
- 礼物另有**按 deviceId** 的频率限额：同一邻居 ≤10 件/小时、≤50 件/天。字条与文件两条
  接收路径共用这道闸；超了标 `refused`（原因 `rate`），**不落盘、不回执**。同一 `giftId`
  的重发/重试不重复计数（否则一次串门的三包重试就会吃掉三件额度）。状态只在本次运行的内存里。
- 礼物磁盘同样有界：`gifts/` 总量 ≤500 MiB 且 ≤200 件，超了按 `receivedAt` 删最旧，
  **整目录删**；每次新礼物写成功之后剪一次，先写后剪，新件不会因为限额写不进去。
  「扔掉」= 立刻删目录并记进本次运行的黑名单；重发的同一件不会再长回来。
- 邻居表最多 64 个，快照只暴露 `deviceId/nickname/status/lastSeen/port/heartbeatAt`；
  邻居地址只留在发现层（`discovery.addressOf()`），**永远不进快照**。
  心跳没有 `port`，刷新地址时保留已知服务端口（没有已知值时退回 UDP 源端口），
  不能把回程地址覆盖成空。
- 入站串门访客按 `deviceId` 去重，不设同屏上限（能进来的只有放行名单里的 deviceId）；
  本地宠物同时只能出门一次。
- 远端字段的唯一效果是**渲染**（名字/访客/放行卡/串门提示/礼物卡）和更新内存
  邻居/心跳影子/访客/串门表；一次串门完成时最多写一条有界记录（`visits.json`，≤200 条，
  礼物只留 `kind`/文件名，不留字条正文）。礼物本体最多写进 `gifts/` 的一个隔离目录，
  且受单件/总量/件数/频率四道限额约束。除此之外不触发其他文件写入、命令执行、
  素材读取或本机状态回传。`peers.json` 与 `settings.json` 只能由本机 action 触发写入；
  `visits.json` 只能由本机完成的串门触发写入，且写入有界。
- 礼物路由只读、不列目录、不接受任何用户路径；只返回 `armedGifts` 里按 `giftId` 查到的那一个
  本机绝对路径，且在 armed 窗口外一律 `404`。这一层是 ADR-0011 唯一新增的局域网攻击面。
- 农场快照同样是局域网只读面：没有路径、没有别人的 deviceId、只在串门活跃期可读，
  响应 ≤64 KiB；`farm-action` 的 `visitId`/`requestId` 必须是 UUID、`plotId` 必须 `p1..p4`、
  `action`/`error` 是固定枚举，`caught` 只能跟 `guard` 一起出现。
  `farm-action-result` 只按 `requestId` 回放已落账的结果；未授权动作静默丢弃。
  动作的日限额与每块地每轮一次把刷屏限制在有界范围内，不另叠滑动窗口。
- `market-digest` 只读三种作物、有限数、`[base×0.5, base×2]` 的价格与固定形状的 `hire`；
  只认放行邻居、2 分钟内、每 peer 30 秒 1 条。坏价格只丢那一种，坏形状整包丢。
- 8 种 `work-*` 各自校验 UUID/整数范围/固定枚举；`work-*` 不落进 `VISIT_TYPES` 的
  四字段分支。合同只能由本机 action（`hire` / `hire-listing` / `recall-worker` /
  `end-contract`）或已放行邻居的合法报文创建/推进；`work-*` ack 按
  `${deviceId}:${requestId}` 回放最近 200 条 / 10 分钟。
- `farm.json` / `market.json` / `contracts.json` 只由本机 store 写，写入串行 + tmp/rename、
  每份有界（日志 50、历史 200、合同每侧 20）；远端报文不能直接写文件或指定路径。
  访客动作的落账同样只经 `farm.store`，并受日限额/每地每轮/`requestId` 幂等约束。
- 协议里永远没有坐标、朝向、拖拽状态、项目名、文件路径或会话内容（ADR-0003）。
  礼物报文只有 `id`/`kind`/`name`/`size`/`sha256`/`text`；本机路径只留在发送端的背包与
  接收端的 `gifts/` 里，连 `/dsh-zoo/state` 的礼物 `path` 也只是本机回环页面能读到。
- 礼物**永不自动打开、永不执行**；卡片用 `textContent` 画，不渲染 HTML/Markdown。

## 为什么串门走 UDP 而不是 TCP

原 SPEC 写的是 TCP 上的单次请求/响应。实现时改成同一条 UDP socket 上的
`visit-request` / `visit-ack` / `visit-deny` / `visit-recall`，原因：

- 第二个 TCP 监听端口意味着第二个要在广播里广告的端口、第二条要单独维护的
  信任/限速/地址路径；而局域网里我们已经有一条经过校验的 UDP 单播出口。
- UDP 没有连接状态，但“到底到没到”仍然可以确定：请求共发三次（首次 + 两次重试），
  收到 ack 才算抵达；收不到就在约 1.8 秒后明确报超时。失败是可读的，不是静默
  无反应——这是真正要守住的承诺。
- 代价是 ack 可能丢：接收方可能已经创建了访客，而发起方超时。为此 `visit-request`
  按 `visitId` 幂等，接收方按 `deviceId` 去重，重复请求不会重置 `since`、也不会重复写记录；
  双方仍然各自在失联/上限到点时清理。`visit-recall` 用同一套办法：有界重发 + 回执，
  丢一包不会把对方的出门状态挂到 30 分钟上限。
