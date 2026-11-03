# local-pet 协议 v1

本文记录 **ticket 01–27 已落地** 的发现、放行、心跳、串门（含自发出门与访客常驻）、
串门记录，以及「带派」礼物（wire 字段、拉取路由、送达回执、限额）协议。
v1 的 GUI 客户端行为（灯条、卡片、同屏 4 位、`expiresAt` 淡出）已随 ADR-0005 删除，
这里只留线路上的事实。
实现修正：串门走现有 UDP socket，而不是原计划的 TCP（原因见文末）；礼物本体走
既有的只读 HTTP 素材源端口，不新增监听端口（ADR-0011）。

## 传输

- UDP4，固定端口 `45871`，可用 `LOCAL_PET_PORT` 覆盖（非法值回落到默认）。
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
```

| 字段 | 适用于 | 约束 |
| --- | --- | --- |
| `v` | 全部 | 必须是数字 `1`；其他版本整包忽略，只记一条日志 |
| `type` | 全部 | `beacon` / `beacon-ack` / `heartbeat` / `visit-request` / `visit-ack` / `visit-deny` / `visit-recall` / `visit-recall-ack` / `gift-received` |
| `deviceId` | 全部 | 本机持久化的 UUID，见 `<dataDir>/identity.json`；不按 IP 认邻居 |
| `nickname` | `beacon`、`beacon-ack`、`visit-request` | 本地昵称，清洗控制字符后按码点截断到 32 |
| `port` | `beacon`、`beacon-ack` | 本插件服务端口；串门不再另开 TCP，所以这个字段不参与串门 |
| `anim` | `heartbeat`、`visit-request` | 本机宠物当前动作名，或 `null`；必须是安全文件名（无路径分隔符/控制字符，≤64）。旧端只读它 |
| `action` | `heartbeat`、`visit-request` | 本机宠物当前动作的**语义名**（自由字符串，≤64）；缺省时消费端回退到 `anim`。和 `anim` 相同时不必重复发 |
| `semantic` | `heartbeat`、`visit-request` | 动作的固定语义标签：`working` / `eating` / `sleeping` / `idle` / `other`；不认识的动作靠它画通用表情 |
| `say` | `heartbeat`、`visit-request` | `{ text, until }`：气泡文本（清洗、≤80 码点）与过期时刻；`until` 最多 `now + 30s`，过期不显示 |
| `skinPort` | `beacon`、`beacon-ack`、`heartbeat`、`visit-request` | 本机素材源端口（1..65535）；没有素材源就不带 |
| `skinId` | 同上 | 素材源 id（`[A-Za-z0-9_-]{1,32}`）；缺省用 `deviceId` |
| `visitId` | `visit-*` | 一次串门的随机 UUID；与 `deviceId` 同一种形状，但只用于关联这一次串门 |
| `gift` | `visit-request` | 可选，一次串门最多一件；`kind:'text'` 或 `kind:'file'`，字段规则见「礼物字段」 |
| `giftId` | `gift-received` | 礼物的 UUID（与报文里的 `gift.id` 同一个键）；只用于确认「哪一件到了」 |
| `reason` | `visit-deny` | 固定枚举 `not-admitted` / `visits-off`；缺失按 `not-admitted`，其他值整包丢弃 |

**兼容口径（v 仍为 1）**：以上新字段全部可选。旧端解析时会丢弃未知字段，行为不变；
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
- 本机页面通过 `POST /local-pet/action` 发信任动作，`deviceId` 必须是 UUID：
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

`POST /local-pet/action`，body 里的 `action` 是固定枚举；远端 UDP 永远走不到这些分支。
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
| `gift-discard` | `{ "giftId": "<uuid>" }` | 扔掉：立刻整目录删除，并记进本次运行的黑名单 |
| `gift-copy` | `{ "giftId": "<uuid>" }` | 字条正文进剪贴板；文件没有可复制正文，明确拒绝 |

### 名字只有一份（ADR-0007）

一只宠物只有一个名字。它住在 `dsh-pet` 的 `pets[].name` 里，本机的 `identity.json`
只是它的**镜像**：每次配置轮询（`CONFIG_TTL_MS`，30 秒）发现配置里的名字变了，就跟着改、
落盘、立刻补发一次广播。`dsh-pet` 缺席时镜像值就是唯一的名字（可改），它回来之后重新覆盖。

`rename` 在装了 `dsh-pet` 的机器上走它的官方接口：`GET /dsh-pet-7340/config` →
只改正在桥接那只的 `name` → `PUT /dsh-pet-7340/config`（body 是**用户层**的扁平
`{ "pets": [...] }`，不是 GET 那种按条目聚合的形状）。写成功之后才写镜像并广播。

**写不进去就整个不改**：`dsh-pet` 不可达 `409 dsh-pet-unreachable`、被它拒绝
`409 dsh-pet-write-failed`（带 `status`），本地昵称、桌面标签、广播内容一个都不动。
不在错误路径上制造“本地叫 A、`dsh-pet` 叫 B”的分叉。

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
- `GET /local-pet/state` 是**本机**的状态出口：在 `snapshot` 之外多 `backpack` 与
  `gifts` 两项（见 README 的「带派」段）。它们只反映本机磁盘上的背包与已收下的礼物，
  不是线路协议的一部分，远端写不进来。

## 礼物字段（`visit-request.gift`，ticket 23 / 25）

礼物只随串门走：它只出现在 `visit-request` 里，一次串门最多一件。没有单独的「送礼」报文。

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
与素材共用同一个端口（默认 `45873`，`LOCAL_PET_SKIN_PORT` 可覆盖）：

```
GET /local-pet-gift/<giftId>   → 文件本体
```

- **只在 armed 期间可读**：发起方发出这次 `visit-request` 之后 5 分钟内，且这次串门没有结束。
  其他时间一律 `404`；不列目录、不认识任何别的路径。
- 只读**背包里登记过的那一个本机绝对路径**：报文里没有任何路径字段，路由也不拼用户输入。
- `200` + `Content-Type: application/octet-stream` + `Content-Length`；v1 不做 Range。
- 文件在发送之后被改动或删掉（大小或 sha256 不符）→ `410 gone`，一个字节都不发。
- 超过 16 MiB → `413`；非 GET/HEAD → `405`。
- 串门结束（回家 / 送客 / 超时 / 失联 / 被拒绝）立即 unarm；5 分钟到点也自然失效。
- 没装素材源的用户也会监听这个端口——它必须保持**只读、只按 id 白名单、不列目录**。

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
- 协议里永远没有坐标、朝向、拖拽状态、项目名、文件路径或会话内容（ADR-0003）。
  礼物报文只有 `id`/`kind`/`name`/`size`/`sha256`/`text`；本机路径只留在发送端的背包与
  接收端的 `gifts/` 里，连 `/local-pet/state` 的礼物 `path` 也只是本机回环页面能读到。
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
