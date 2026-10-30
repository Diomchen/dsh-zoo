# local-pet 协议 v1

本文记录 **ticket 01–06 已落地** 的发现、放行、访客、串门与串门记录协议。
实现修正：串门走现有 UDP socket，而不是原计划的 TCP（原因见文末）。

## 传输

- UDP4，固定端口 `45871`，可用 `LOCAL_PET_PORT` 覆盖（非法值回落到默认）。
- 启动时立即广播一次 `beacon`，之后每 **5 秒** 一次，目标 `255.255.255.255:<port>`。
- 收到 `beacon` 后向来源地址**单播**一条 `beacon-ack`；同一来源 4.5 秒内最多回一次。
- **放行之后**每 **2 秒** 向每个已放行邻居单播一条 `heartbeat`；放行动作和本机动作
  变化时立刻补发一条，所以动作切换通常不用等满 2 秒。
- **串门**复用同一条 socket 单播：`visit-request` → `visit-ack` / `visit-deny`，
  任一方可用 `visit-recall` 提前结束。不为串门另开监听端口。
- 邻居 30 秒没有新报文/心跳就从客厅消失（Host 每秒 tick 一次；客户端最后 6 秒淡出）。
- 访客（心跳影子）30 秒没有心跳由同一条 tick 清掉；被拒绝或被移除时立即消失。
- 串门访客（`visitors`）有独立的 **60 秒 TTL**，不会被 30 秒邻居 TTL 提前清掉；
  双方各自跑这个计时器，谁都不依赖对方还活着。

## 报文

JSON 对象。**字段集按类型固定**，多出来的字段在解析时丢弃：

```json
{ "v": 1, "type": "beacon", "deviceId": "<uuid>", "nickname": "蓝毛小女仆", "port": 45871 }
{ "v": 1, "type": "beacon-ack", "deviceId": "<uuid>", "nickname": "隔壁同事", "port": 45871 }
{ "v": 1, "type": "heartbeat", "deviceId": "<uuid>", "anim": "东张西望" }
{ "v": 1, "type": "heartbeat", "deviceId": "<uuid>", "anim": null }

{ "v": 1, "type": "visit-request", "deviceId": "<uuid>", "visitId": "<uuid>", "nickname": "隔壁同事", "anim": "东张西望" }
{ "v": 1, "type": "visit-ack", "deviceId": "<uuid>", "visitId": "<uuid>" }
{ "v": 1, "type": "visit-deny", "deviceId": "<uuid>", "visitId": "<uuid>" }
{ "v": 1, "type": "visit-recall", "deviceId": "<uuid>", "visitId": "<uuid>" }
```

| 字段 | 适用于 | 约束 |
| --- | --- | --- |
| `v` | 全部 | 必须是数字 `1`；其他版本整包忽略，只记一条日志 |
| `type` | 全部 | `beacon` / `beacon-ack` / `heartbeat` / `visit-request` / `visit-ack` / `visit-deny` / `visit-recall` |
| `deviceId` | 全部 | 本机持久化的 UUID，见 `<dataDir>/identity.json`；不按 IP 认邻居 |
| `nickname` | `beacon`、`beacon-ack`、`visit-request` | 本地昵称，清洗控制字符后按码点截断到 32 |
| `port` | `beacon`、`beacon-ack` | 本插件服务端口；串门不再另开 TCP，所以这个字段不参与串门 |
| `anim` | `heartbeat`、`visit-request` | 本机宠物当前动作名，或 `null`；必须是安全文件名（无路径分隔符/控制字符，≤64） |
| `visitId` | `visit-*` | 一次串门的随机 UUID；与 `deviceId` 同一种形状，但只用于关联这一次串门 |

`port` 不代表“发现端口可以变”：发现端口仍是固定的 45871。`heartbeat` **没有**
`nickname` 和 `port`：访客的昵称来自邻居表或放行名单，心跳不能改名字；
地址来自发现层，心跳只负责证明“它还活着、它现在在做什么”。
`visit-ack` / `visit-deny` / `visit-recall` 只有 `visitId`，没有昵称、端口或动作：
它们只表达“这一次串门怎么了”，不承载任何新的远端状态。

心跳与串门请求都不带坐标。访客在本机自己跑物理，双方看到的轨迹可以不一样（ADR-0003）。

## 放行（ticket 03，本机状态）

放行不是一种网络报文，而是**本机决定**：

- 第一次见到某个 `deviceId` 时，它进入待放行队列，`snapshot.prompt` 是队首
  `{ deviceId, nickname }`；FIFO 最多 8 位，其余等下一次广播再排。
- 本机页面通过 `POST /local-pet/action` 发三个动作，`deviceId` 必须是 UUID：
  - `{ "action": "admit", "deviceId": "<uuid>" }` → `status: "allowed"`
  - `{ "action": "reject", "deviceId": "<uuid>" }` → `status: "denied"`
  - `{ "action": "dismiss", "deviceId": "<uuid>" }` → 收起卡片，十分钟内不再问同一位
    （它从邻居表消失后再回来会立刻重问），不改变信任
- `snapshot.neighbors[].status` 为 `pending` / `allowed` / `denied`；拒绝过的邻居
  不再进入提示队列，客户端也不把它画成邻居灯。
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

## 访客（ticket 04）

- 只有 `mayTalkTo` 为真的邻居心跳才会创建/刷新访客。`pending` / `denied` / 自己的
  心跳在 `room.observeHeartbeat()` 里直接丢弃，不产生任何可见效果。
- 访客形状（`snapshot.guests[]`）：

  ```json
  { "deviceId": "<uuid>", "nickname": "隔壁同事", "anim": "东张西望", "since": 1700000000000 }
  ```

  `since` 是这一轮访客第一次出现在本机客厅的时刻；后续心跳只更新 `anim` 和昵称，
  不改 `since`。访客表最多 8 位，满了挤掉最久没有心跳的那位。
- 心跳同时刷新邻居的 `lastSeen`：心跳也是“它还在线”的证据，邻居灯不必等下一次广播。
- 客户端同屏最多画 4 位访客，多出来的折进灯条 `+N`；素材取不到就退到 idle，
  仍然取不到则画带昵称的色块。访客是**本机画出来的影子**，不需要本机装 `dsh-pet`。

## 串门（ticket 05）

### 发起

- 本地页面把宠物拖到邻居灯上，`POST /local-pet/action`：

  ```json
  { "action": "visit", "deviceId": "<邻居 uuid>" }
  ```

  不需要二次确认；宿主生成一个随机 `visitId`，把 `self.out` 置为 `requesting`，
  然后发 `visit-request`。
- 同一只本地宠物同时只能有一次出门。还在请求中或已经抵达时，再拖一次会得到
  `already-out` 和一句提示，不会覆盖第一次的状态。
- 未放行的邻居（`pending` / `denied`）直接得到 `not-admitted`；发现层没有地址
  （还没广播 / 刚离线）得到 `peer-offline`。
- 请求最多发 **3 次**（首次 + 两次重试，间隔约 600ms）。约 **1.8 秒**还没收到
  `visit-ack`，就清掉请求状态、报 `timeout`，宠物留在家。
- 只有拿到 `visit-ack` 才算抵达：`self.out.phase` 从 `requesting` 变成 `active`，
  `startedAt` 是 ack 时刻，`endsAt` 是 `startedAt + 60s`。

### 接收

- 收到合法 `visit-request` 时，`mayTalkTo(deviceId)` 为真 → 创建/刷新一位入站访客，
  回 `visit-ack`；否则回 `visit-deny`。未知字段、坏版本、坏 UUID、超 4 KiB 的包
  在协议层就丢了，什么都不回。
- 入站访客形状（`snapshot.visitors[]`）：

  ```json
  {
    "deviceId": "<uuid>",
    "nickname": "隔壁同事",
    "anim": "东张西望",
    "visitId": "<uuid>",
    "since": 1700000000000,
    "endsAt": 1700000060000
  }
  ```

  `since` 是请求被接受的本机时刻，`endsAt` 是 `since + 60s`。昵称优先取邻居表/
  放行名单，取不到才用请求里的昵称；`visit-request` 不能改本机 `self.nickname`。
- 同一 `deviceId` 只有一位入站访客。重试（同 `visitId`）只刷新动作与 id，
  不重置 `since`/`endsAt`，也不会多写一条记录；换了 `visitId` 也仍然只保留一位，
  防止记录被重复请求刷爆。
- 接收方自己跑 60 秒计时器：到点就清掉访客、写一条 `in` 记录，**不依赖发起方还在**。
  邻居灯 30 秒过期不会把串门访客一起带走。

### 召回与结束

- 发起方 60 秒到点（`tick`）→ 写 `out` 记录、清 `self.out`、发一条 `visit-recall`；
  接收方收到 recall 立即清掉访客并写 `in` 记录。接收方按 `deviceId` 认那一位访客
  （同一设备最多一位），所以迟到或携带旧 `visitId` 的 recall 也能立即清场；发起方
  仍然严格按 `visitId` 匹配，避免旧 recall 误伤一次新的出门。
- 本地页面随时可以召回：

  ```json
  { "action": "recall" }
  ```

  还在请求中 → 只取消，不写记录、不发包；已抵达 → 写 `out` 记录并发 `visit-recall`。
- 接收方也可以提前结束：

  ```json
  { "action": "end-visit", "deviceId": "<访客 uuid>" }
  ```

  写 `in` 记录、立即清场，并发 `visit-recall` 让对方回家。对方收到后写 `out` 记录，
  不再回 recall。
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
| `already-out` | 宠物已经在「甲」家了，先召回来再说。 |

本地页面只看 `text`，不解析 code；没有堆栈、没有 socket 细节。

### `visit-deny` 的应用层出站例外

`discovery.sendTo()` 必须先过 `mayTalkTo`。但“没放行”的接收方需要回一句明确的
`visit-deny`，否则发起方只能等到超时，分不清“被拒绝”和“没人理”。因此
除发现层对合法 beacon 的自动回执外，`discovery.sendReply()` 是唯一绕过
`mayTalkTo` 的应用层出口：

- 只用于 `visit-deny`，且只发给刚刚发来合法 `visit-request` 的来源；
- 仍然是同一条 socket、同一张地址表、同样的 4 KiB 上限；
- 每来源 **2 次 / 5 秒** 限速，不给反射放大留空间；
- 心跳、`visit-request`、`visit-ack`、`visit-recall` 全部继续走 `sendTo`。

## 串门记录（ticket 06）

- 每次串门完成时，双方各追加一条记录（召回、60 秒到期、对方结束、清场都算）。
  记录形状固定为四个字段：

  ```json
  { "direction": "out", "nickname": "隔壁同事", "startedAt": 1700000000000, "durationMs": 60000 }
  ```

  `direction` 是 `out`（我出门）或 `in`（对方来我家）；`nickname` 是**对方**的昵称；
  `startedAt` 是这次串门在本机开始的时刻；`durationMs` 是停留时长。
  请求中就被取消/超时/拒绝的串门没有抵达，不写记录。
- 文件是 `<dataDir>/visits.json`：

  ```json
  {
    "version": 1,
    "visits": [
      { "direction": "out", "nickname": "隔壁同事", "startedAt": 1700000000000, "durationMs": 60000 }
    ]
  }
  ```

  最新在前，滚动上限 **200** 条，超出丢最旧的；单次写入是整个有界数组。
  正常写上面这个对象；手改成裸数组也认，下一次写入会恢复对象形状。
- 容错与 `peers.json` 一致：文件不存在 = 空记录；损坏/形状不对 = 空记录 + 一条日志；
  单条非法 = 跳过该条 + 一条日志；写不进去 = 内存里照常有记录 + 一条日志。
  **记录坏掉不影响客厅和串门本身**：`room` 始终有一份内存记录，快照照常可读。
- 快照只给最近 5 条（`snapshot.visits`，最新在前）。客户端点访客或出门时的本地宠物
  打开串门卡片，显示这 5 条；卡片是 ticket 06 唯一新增的、opt-in 指针事件的元素，
  并且可关闭、不铺满主界面。

## 敌意输入边界（必须保持）

- 单包 **4 KiB** 上限，超过在解析前丢弃。
- 只认上表字段；未知字段重建时丢弃，不报错、不转发。每种类型只校验/重建自己的字段。
- `deviceId` 与 `visitId` 必须是 UUID 形状，`port` 必须是 1..65535 的整数；
  心跳的 `anim` 必须是 `null` 或安全动画名；`visit-request` 的昵称必须可读，
  `anim` 必须显式存在且为 `null` 或安全动画名；缺失/路径/控制字符一律拒绝。
- 每来源滑动窗口限速（20 包 / 10 秒），超限丢弃而不是排队；回执另有 1 次 / 4.5 秒，
  `visit-deny` 另有 2 次 / 5 秒的上限。心跳是每邻居 5 包 / 10 秒，串门请求最多 3 包 / 次。
- 邻居表最多 64 个，快照只暴露 `deviceId/nickname/status/lastSeen/port`；
  邻居地址只留在发现层（`discovery.addressOf()`），**永远不进快照**。
  心跳没有 `port`，刷新地址时保留已知服务端口（没有已知值时退回 UDP 源端口），
  不能把回程地址覆盖成空。
- 入站串门访客按 `deviceId` 去重，最多 64 位；本地宠物同时只能出门一次。
- 远端字段的唯一效果是**渲染**（邻居灯/名字/访客/放行提示/串门提示）和更新内存
  邻居/访客/串门表；一次串门完成时最多写一条有界记录（`visits.json`，≤200 条）。
  不触发其他文件写入、命令执行、素材读取或本机状态回传。`peers.json` 只能由本机
  action 触发写入；`visits.json` 只能由本机完成的串门触发写入，且写入有界。
- 协议里永远没有坐标、项目名、文件路径或会话内容（ADR-0003）。

## 为什么串门走 UDP 而不是 TCP

原 SPEC 写的是 TCP 上的单次请求/响应。实现时改成同一条 UDP socket 上的
`visit-request` / `visit-ack` / `visit-deny` / `visit-recall`，原因：

- 第二个 TCP 监听端口意味着第二个要在广播里广告的端口、第二条要单独维护的
  信任/限速/地址路径；而局域网里我们已经有一条经过校验的 UDP 单播出口。
- UDP 没有连接状态，但“到底到没到”仍然可以确定：请求重试三次，收到 ack 才算抵达；
  收不到就在约 1.8 秒后明确报超时。失败是可读的，不是静默无反应——这是真正要守住的承诺。
- 代价是 ack 可能丢：接收方可能已经创建了访客，而发起方超时。为此 `visit-request`
  按 `visitId` 幂等，接收方按 `deviceId` 去重，重复请求不会重置 60 秒，也不会重复写记录；
  双方仍然各自在 TTL 到点时清理。
