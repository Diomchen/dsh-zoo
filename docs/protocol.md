# local-pet 协议 v1

本文记录 **ticket 01–04 已落地** 的发现、放行与访客协议。串门请求是 ticket 05 的事，
末尾留了它的接缝；不要提前实现。

## 传输

- UDP4，固定端口 `45871`，可用 `LOCAL_PET_PORT` 覆盖（非法值回落到默认）。
- 启动时立即广播一次 `beacon`，之后每 **5 秒** 一次，目标 `255.255.255.255:<port>`。
- 收到 `beacon` 后向来源地址**单播**一条 `beacon-ack`；同一来源 4.5 秒内最多回一次。
- **放行之后**每 **2 秒** 向每个已放行邻居单播一条 `heartbeat`；放行动作和本机动作
  变化时立刻补发一条，所以动作切换通常不用等满 2 秒。
- 邻居 30 秒没有新报文/心跳就从客厅消失（Host 每秒 tick 一次；客户端最后 6 秒淡出）。
- 访客 30 秒没有心跳由同一条 tick 清掉；邻居被拒绝或被移除时访客立即消失。

## 报文

JSON 对象。**字段集按类型固定**，多出来的字段在解析时丢弃：

```json
{ "v": 1, "type": "beacon", "deviceId": "<uuid>", "nickname": "蓝毛小女仆", "port": 45871 }
{ "v": 1, "type": "beacon-ack", "deviceId": "<uuid>", "nickname": "隔壁同事", "port": 45871 }
{ "v": 1, "type": "heartbeat", "deviceId": "<uuid>", "anim": "东张西望" }
{ "v": 1, "type": "heartbeat", "deviceId": "<uuid>", "anim": null }
```

| 字段 | 适用于 | 约束 |
| --- | --- | --- |
| `v` | 全部 | 必须是数字 `1`；其他版本整包忽略，只记一条日志 |
| `type` | 全部 | `beacon` / `beacon-ack` / `heartbeat` |
| `deviceId` | 全部 | 本机持久化的 UUID，见 `<dataDir>/identity.json`；不按 IP 认邻居 |
| `nickname` | `beacon`、`beacon-ack` | 本地昵称，清洗控制字符后按码点截断到 32 |
| `port` | `beacon`、`beacon-ack` | 本插件服务端口；目前与 UDP 发现端口相同，保留给 ticket 05 的 TCP 串门 |
| `anim` | `heartbeat` | 本机宠物当前动作名，或 `null`；必须是安全文件名（无路径分隔符/控制字符，≤64） |

`port` 不代表“发现端口可以变”：发现端口仍是固定的 45871。`heartbeat` **没有**
`nickname` 和 `port`：访客的昵称来自邻居表或放行名单，心跳不能改名字；
地址来自发现层，心跳只负责证明“它还活着、它现在在做什么”。

心跳不带坐标。访客在本机自己跑物理，双方看到的轨迹可以不一样（ADR-0003）。

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
- 唯一出站门控是 `room.mayTalkTo(deviceId)`，只对 `allowed` 为真。心跳和 ticket 05
  的串门请求都必须走这个门控；`discovery.sendTo` 内部会再检查一次。

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

## 敌意输入边界（必须保持）

- 单包 **4 KiB** 上限，超过在解析前丢弃。
- 只认上表字段；未知字段重建时丢弃，不报错、不转发。每种类型只校验/重建自己的字段。
- `deviceId` 必须是 UUID 形状，`port` 必须是 1..65535 的整数；心跳的 `anim` 必须是
  `null` 或安全动画名，缺失/路径/控制字符一律拒绝。
- 每来源滑动窗口限速（20 包 / 10 秒），超限丢弃而不是排队；回执另有 1 次 / 4.5 秒的上限。
  心跳是每邻居 5 包 / 10 秒，仍在窗口内。
- 邻居表最多 64 个，快照只暴露 `deviceId/nickname/status/lastSeen/port`；
  邻居地址只留在发现层（`discovery.addressOf()`），**永远不进快照**。
  心跳没有 `port`，刷新地址时保留已知服务端口（没有已知值时退回 UDP 源端口），
  不能把回程地址覆盖成空。
- 远端字段的唯一效果是**渲染**（邻居灯/名字/访客/放行提示）和更新内存邻居/访客表：
  不触发文件写入、命令执行、素材读取或本机状态回传。`peers.json` 只能由本机
  action 触发写入，且写入有界。
- 协议里永远没有坐标、项目名、文件路径或会话内容（ADR-0003）。

## 给 ticket 05（串门）的接缝

- 出站：`discovery.sendTo(deviceId, encoded)` → `boolean`。它先过 `mayTalkTo`，再按
  `deviceId` 查地址单播；只接受非空、≤4 KiB 的已编码 `Uint8Array`。
  串门请求必须复用这个出口，不要另开 UDP socket。
- 地址：`discovery.addressOf(deviceId)` → `{ address, port } | null`；每次合法报文刷新，
  只保留最近 64 条，dispose 时清空。ticket 05 若用 TCP，端口从这里取。
- 门控：`room.mayTalkTo(deviceId)`（service 上也有一份透传）。只对 `allowed` 的邻居为真；
  未放行/已拒绝的邻居不得收到任何心跳或串门请求。
- 收件人：`room.heartbeatTargets()` 列出放行名单里的 `deviceId`；没有地址的会被
  `sendTo` 静默丢掉。
- 编解码：在 `src/protocol.js` 的 `PACKET_TYPES` 里新增类型，沿用按类型的字段白名单、
  4 KiB 上限、版本/UUID 校验和未知字段丢弃；不要给报文加坐标。
- 本机“立刻让对方看见我”的现成路径：`service.sendHeartbeats()`（已放行后手动补发一轮）。
  串门请求可以照着它编码后调用 `service.sendTo()`。
- 访客渲染：客户端 `GuestPet` / `PetMedia` 已经能画“任意远端宠物 + 昵称 + 动作名”；
  ticket 05 只需要把串门状态折进 `snapshot.guests`（或另加一个同形状字段），
  不要另写一套素材/降级逻辑。
