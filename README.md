# dsh-local-pet

局域网里的 DSH 宠物客厅：看见自己的宠物，也看见同一网段里别人的邻居灯。
当前落地的是 **ticket 01（本地影子）**、**ticket 02（邻居灯）** 和
**ticket 03（第一次见面放行）**；访客、串门、记录见 `.scratch/local-pet/issues/`。

## 它做什么

- **本地影子**：Host 轮询 `dsh-pet` 的 loopback `/state`，把本机宠物的名字和
  “被点播过的动作”放进 `snapshot.self.pet`；浏览器半边用
  `/dsh-pet-7340/thumb/main/<动画名>.webm` 播放。没有动作时轮播几段内置待机片段。
- **邻居灯**：每 5 秒 UDP 广播一次 `{v,type,deviceId,nickname,port}`，
  收到广播即单播回执。邻居 30 秒没有新报文就淡出，不需要填任何地址。
- **放行**：第一次见到某个 `deviceId` 时，客厅右下角出现一张小卡片，带对方昵称
  和“接受 / 拒绝”。接受后不再询问；拒绝后那盏灯不再出现，也不再提示。
  名单在 `<dataDir>/peers.json`，只按 `deviceId` 认，可手改、可删
  （删掉就会重新问；改完重启 DSH 生效）。
  放行之前本机不向对方发任何心跳（心跳是 ticket 04 的事）。
- **身份**：`deviceId` 是持久化在 `<dataDir>/identity.json` 的随机 UUID；
  昵称默认取本机宠物名，没有则取主机名，可以双击宠物名字修改（或直接编辑该文件）。

## 端口与防火墙

- 发现/服务端口默认 **45871**（UDP），可用环境变量 `LOCAL_PET_PORT` 覆盖。
  同一网段的所有机器要用同一个端口。
- macOS 首次监听会弹一次“允许传入连接”，允许后才会收到邻居广播。
- 广播只走 IPv4；v1 不支持跨网段、NAT 穿透或中继。

## 已知限制

- `dsh-pet` **不上报随机待机动画**。客厅里的影子只能镜像被 `/anim` 点播过的动作；
  其余时间播放插件内置的待机片段，因此它和桌面层那只不会每一帧都同步。
- 没有装 `dsh-pet`、`/state` 不通、或 dsh-pet 里没有宠物时，客厅显示一行说明；
  邻居灯和网络发现不受影响。
- 放行提示最多同时排 8 位；点“稍后再说”会让这张卡片收起，十分钟内不再问同一位
  （它离线 30 秒后再回来会立刻重问），不改变任何信任状态。
- v1 只有 GUI 浮层（ADR-0004）；不打开 DSH GUI 就看不见客厅。

## 开发

```sh
npm test          # node --test，零依赖
node --check client.js
```

- 协议与敌意输入边界：`docs/protocol.md`
- 领域词汇：`CONTEXT.md`；决策：`docs/adr/`
- 宿主逻辑是“纯状态机 + 薄外壳”：`src/room.js` 不碰 socket/fs，I/O 在
  `src/identity.js`、`src/peers.js`、`src/discovery.js`、`src/pet-bridge.js`、`src/service.js`。
