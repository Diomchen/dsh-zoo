# local-pet 协议 v1

本文记录 **ticket 01–03 已落地** 的发现与放行协议。心跳、串门请求是 ticket 04–05 的事，
下面标了它们预留的接缝；不要提前实现。

## 传输

- UDP4，固定端口 `45871`，可用 `LOCAL_PET_PORT` 覆盖（非法值回落到默认）。
- 启动时立即广播一次，之后每 **5 秒** 一次，目标 `255.255.255.255:<port>`。
- 收到 `beacon` 后向来源地址**单播**一条 `beacon-ack`；同一来源 4.5 秒内最多回一次。
- 收到的 `beacon-ack` 也更新 `lastSeen`，因此两边通常在一秒内互相看见。
- 邻居 30 秒没有新报文就从客厅消失（Host 每秒 tick 一次；客户端最后 6 秒淡出）。

## 报文

JSON 对象，**只允许**这五个字段：

```json
{ "v": 1, "type": "beacon", "deviceId": "<uuid>", "nickname": "蓝毛小女仆", "port": 45871 }
```

| 字段 | 约束 |
| --- | --- |
| `v` | 必须是数字 `1`；其他版本整包忽略，只记一条日志 |
| `type` | `beacon` 或 `beacon-ack` |
| `deviceId` | 本机持久化的 UUID，见 `<dataDir>/identity.json`；不按 IP 认邻居 |
| `nickname` | 本地昵称，清洗控制字符后按码点截断到 32 |
| `port` | 本插件服务端口；目前与 UDP 发现端口相同，保留给 ticket 05 的 TCP 串门 |

`port` 不代表“发现端口可以变”：发现端口仍是固定的 45871。

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
  两个名单各有 256 条上限，
  超出丢最旧的；`denied` 优先于 `allowed`。损坏/读不出时按空名单运行并只记一条日志；
  写不进时内存里照常生效、也只记一条日志。
- 唯一出站门控是 `room.mayTalkTo(deviceId)`，只对 `allowed` 为真。ticket 03
  **仍不发送任何心跳**；ticket 04 的心跳和 ticket 05 的串门请求必须走这个门控。

## 敌意输入边界（必须保持）

- 单包 **4 KiB** 上限，超过在解析前丢弃。
- 只认上表字段；未知字段重建时丢弃，不报错、不转发。
- `deviceId` 必须是 UUID 形状，`port` 必须是 1..65535 的整数。
- 每来源滑动窗口限速（20 包 / 10 秒），超限丢弃而不是排队；回执另有 1 次 / 4.5 秒的上限。
- 邻居表最多 64 个，快照只暴露 `deviceId/nickname/status/lastSeen/port`；
  邻居地址只留在发现层（`discovery.addressOf()`），**永远不进快照**。
- 远端字段的唯一效果是**渲染**（邻居灯/名字/放行提示）和更新内存邻居表：
  不触发文件写入、命令执行、素材读取或本机状态回传。`peers.json` 只能由本机
  action 触发写入，且写入有界。
- 协议里永远没有坐标、项目名、文件路径或会话内容（ADR-0003）。

## 给 ticket 04（心跳）的接缝

- 出站：`discovery.sendTo(deviceId, encoded)` → `boolean`。它先过 `mayTalkTo`，再按
  `deviceId` 查地址单播；只接受非空、≤4 KiB 的已编码 `Uint8Array`。
  ticket 04 的 `sendHeartbeat` 只需要编码心跳并调用它，不要另开 socket。
- 地址：`discovery.addressOf(deviceId)` → `{ address, port } | null`；每次合法报文刷新，
  只保留最近 64 条，dispose 时清空。
- 门控：`room.mayTalkTo(deviceId)`（service 上也有一份透传）。只对 `allowed` 的邻居为真；
  未放行/已拒绝的邻居不得收到任何心跳或串门请求。
- 心跳类型要加进 `PACKET_TYPES` 并复用同一套解析/白名单/4 KiB/限速；
  心跳载荷同样只能是动作意图，不能包含坐标（ADR-0003）。
- 本仓库目前**不发送任何心跳**，所以“未放行就收不到心跳”在 ticket 03 是
  由门控谓词和 `sendTo` 共同保证的。
