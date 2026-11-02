# dsh-local-pet

局域网里的 DSH 宠物：自己的宠物活在桌面上，同一网段里邻居的宠物也会来串门，
留下串门记录。没有客厅，没有第二块屏幕——整个桌面就是它们待的地方。

当前落地的是 **ticket 01–10**：发现/心跳/放行/串门/记录、v2 桌面层（全屏透明
helper、真实宠物、物理、拖拽/投掷、点击穿透与输入租约），以及宠物自发出门、
客人常驻与「送客」/失联清理的完整状态机。**ticket 11（桌面控件）还没做**，所以
现在桌面上只有宠物，没有「串门 / 召回 / 送客」按钮，也没有放行卡片；这三个动作
和两个开关都可以通过 `POST /local-pet/action` 完成（见下）。

## 它做什么

- **桌面宠物**：宿主轮询 `dsh-pet` 的 loopback `/state`，把自己的宠物（名字 +
  被点播过的动作）和所有正在串门的客人画在一个**全屏透明、置顶、默认点击穿透**的窗口里。
  在线邻居的心跳影子不画——心跳只说明它在，不代表它来了。
  素材来自 `dsh-pet` 的 WebM；动作取不到就轮播待机片段，仍取不到就画带昵称的 SVG 色块。
- **物理**：每只宠物有本地坐标与速度，重力、落地反弹、地面摩擦、撞边、工作区夹取；
  可以用鼠标拖起来（弹簧跟随），松手按最近轨迹投掷。位置永不过网（ADR-0003）。
- **点击穿透**：窗口默认整窗 `setIgnoreMouseEvents(true, { forward: true })`；只有光标
  真的在宠物命中矩形内、且渲染端心跳确认过，才临时接管鼠标。拖拽期间渲染端持有
  **输入租约**（busy，400ms 续期 / 1.5s 过期），光标离开宠物矩形也不会断。
- **发现**：每 5 秒 UDP 广播 `{v,type,deviceId,nickname,port}`，收到广播即单播回执。
  邻居 30 秒没有新报文就淡出，不需要填任何地址。
- **放行**：第一次见到某个 `deviceId` 时入队一条 prompt；放行/拒绝名单在
  `<dataDir>/peers.json`，只按 `deviceId` 认，可手改（改完重启 DSH 生效）。
  v2 的桌面放行卡片属于 ticket 11；现在可以：
  ```sh
  curl -s http://127.0.0.1:<DSH端口>/local-pet/state | jq '.neighbors, .prompt'
  curl -s -X POST http://127.0.0.1:<DSH端口>/local-pet/action \
    -H 'content-type: application/json' \
    -d '{"action":"admit","deviceId":"<邻居 UUID>"}'
  ```
- **两个开关**：`{"action":"accept-visits","enabled":false}` 管入站（默认开），
  `{"action":"auto-visits","enabled":true}` 管自发出门（默认关）。状态都存在
  `<dataDir>/settings.json`，重启后保持。关掉入站仍能看见邻居、照常收发心跳，只是
  入站串门请求会被拒绝；关掉自动出门不影响手动「串门」。
- **心跳**：放行之后每 2 秒向对方单播一条 `{v,type,deviceId,anim}`，只带本机宠物
  当前动作名；动作变化和刚放行时会立刻补发。收到心跳不仅证明对方在线，也证明
  **对方放行了我**（心跳只发给发送方的放行名单）。
- **自动出门**：默认关。打开后（`{"action":"auto-visits","enabled":true}`）还要同时满足
  四道门：本机最近 10 分钟有活动（`session/event` 优先，桌面指针兜底）、距上次出门
  ≥15 分钟、随机挑中的邻居在线且**互相放行**。出门后它从自己桌面消失、出现在对方
  桌面；对方「送客」、自己「召回」、30 分钟上限、或对方 2 分钟失联都会让它回家。
- **客人常驻**：别人家的宠物来了就待着，直到你点「送客」；没有 TTL，也不设同屏上限。
  唯一的自动清场是对方 2 分钟没有心跳（失联），双方各写一条记录。
- **串门**：`POST /local-pet/action {"action":"visit"}`（不带 `deviceId` 时随机挑一位
  在线且互相放行的邻居；一个都没有返回 `no-admitted` / `no-online`）。也可以显式带
  `deviceId`。请求走现有 UDP socket（`visit-request` / `visit-ack` / `visit-deny` /
  `visit-recall`），共发三次；未放行、离线、超时、被拒绝、对方关掉了串门、已经在
  串门都会留一条可读提示。
- **召回 / 送客**：`{"action":"recall"}` 让自己的宠物立刻回家；
  `{"action":"end-visit","deviceId":"<访客 UUID>"}` 送走一位客人。两者都立即清场、
  写记录并尽力通知对方。
- **串门记录**：每次串门在双方各留一条 `{direction, nickname, startedAt, durationMs}`，
  `durationMs` 是真实停留时长（封顶 30 分钟），存在 `<dataDir>/visits.json`，
  滚动上限 200 条；记录文件损坏或不可写时只丢历史。
- **身份**：`deviceId` 是持久化在 `<dataDir>/identity.json` 的随机 UUID；
  昵称默认取本机宠物名，没有则取主机名，可通过 `{"action":"rename","nickname":"…"}` 修改
  （或直接编辑该文件）。

## 安装

```sh
node scripts/install.mjs            # 默认装进 ~/.dsh/profiles/desktop
node scripts/install.mjs --dry-run  # 先看它会改什么
node scripts/install.mjs --profile web
```

它只做两件事：在 profile 的 `node_modules` 里放一个指向本仓库的符号链接（`link:` 依赖），
把这个包名登记进 `profile.dsh.profile.bundles`。改 `package.json` 之前会留一份 `.bak`。

**装完要重启 DSH**：宿主半边是新代码，不会热加载。桌面版 DSH 重启后桌面上应该出现宠物；
web profile / 非 macOS / 没找到 Electron 时只打一行日志，宠物不显示，网络功能照常。

卸载：

```sh
node scripts/uninstall.mjs          # 摘掉登记与链接；<DSH_HOME>/local-pet/ 的用户数据保留
```

如果 DSH 自己被卡住，把 profile 的 `package.json` 从 `.bak` 还原即可。

## 端口与防火墙

- 发现/服务端口默认 **45871**（UDP），可用环境变量 `LOCAL_PET_PORT` 覆盖。
  同一网段的所有机器要用同一个端口。串门复用同一条 UDP socket，不再另开 TCP 端口。
- 桌面 helper 与宿主只走 **stdio 的 JSON 行**，不开新端口；素材走 helper 自己注册的
  `localpet://` 协议（本机文件，仅渲染页可读）。
- macOS 首次监听会弹一次“允许传入连接”，允许后才会收到邻居广播。
- 广播只走 IPv4；不支持跨网段、NAT 穿透或中继。

## 出问题时先关掉它

桌面窗是**置顶全屏**的。如果它在你的机器上行为不对（挡住点击、位置怪），先关掉它：

```sh
LOCAL_PET_DESKTOP=0    # 加在 DSH 的环境里，重启 DSH；宠物不显示，网络与串门照常
```

或者直接杀掉那一个进程（窗口随进程消失，宿主会在 300ms 后重启它，最多 5 次）：

```sh
pkill -f "local-pet/desktop/main.js"
```

## 已知限制

- `dsh-pet` **不上报随机待机动画**。桌面宠物只能镜像被 `/anim` 点播过的动作；
  其余时间播放内置待机片段，和 dsh-pet 自己那只不会每一帧同步。
- 访客跟随动作的链路是“本机桥接最多 1 秒轮询 + 立即补发心跳 + 对方场景巡检 500ms”，
  不是逐帧同步；动作变化通常在一两秒内出现在对面。
- 自动出门的“活动”里，`session/event` 是主信号；桌面指针兜底只能看到光标进入宠物
  （helper 只在点击穿透翻转时发 `hit`），不读取全局鼠标/键盘。没有桌面层时，只有
  `session/event` 能打开活动门。
- 心跳影子 30 秒没有心跳时 Host 在下一次 tick 移除；入站串门访客没有 TTL，
  只靠「送客」或对方 2 分钟失联清理。同屏不设上限；每个宠物一个 `<video>`，
  客人很多时解码开销线性增长。
- 没有装 `dsh-pet`、`/state` 不通、或 dsh-pet 里没有宠物时，自己的宠物显示为带昵称的色块；
  网络发现、放行、串门都不受影响。**访客不需要本机装 `dsh-pet`**：素材取不到就退到 idle，
  再取不到就画成色块。
- 放行提示最多同时排 8 位；点“稍后再说”会让队列前进，十分钟内不再问同一位。
- 心跳影子表最多 8 位（超出挤掉最久没心跳的）；串门访客不设上限。
- 串门请求最多发 3 次、约 600ms 一次；约 1.8 秒没有 ack 就明确超时。出门在外的宠物
  最多待 30 分钟；接收方没有 TTL，只按对方心跳判断失联。UDP 丢 ack 时接收方可能先
  看到访客、发起方报超时；重复请求按 `visitId` 幂等，不会重复写记录。
- 串门记录滚动上限 200 条；`visits.json` 损坏或不可写时，本次运行仍能在内存里看到新记录，
  但磁盘历史会丢失。
- 桌面 helper 是 `focusable: false`：没有键盘输入；ticket 11 的按钮只能是鼠标点击。
- 多显示器只保证主屏工作区；其它屏不显示。显示器变化后渲染端会把宠物夹回新工作区。
- 宠物之间没有物理碰撞（SPEC v2 out of scope）。
- 没有屏幕录制权限，**看窗口只能靠 helper 的 `capturePage()`**：
  ```sh
  npm run smoke:desktop
  LOCAL_PET_SMOKE_NOTES=1 npm run smoke:desktop   # 写 .scratch/local-pet/notes/08-*.png
  ```
  最近的整窗截图：`.scratch/local-pet/notes/08-desktop-pets-composited.png`；
  宠物特写：`.scratch/local-pet/notes/08-desktop-pets-crop-composited.png`。

## 在本机假装一个邻居

没有第二台机器也能验完整条链：

```sh
npm run fake-peer                                  # 默认叫「隔壁的小鲸鱼」
npm run fake-peer -- --name 楼下的柯基 --auto-visit 5
```

它是一颗真的 UDP socket，说的是真协议（真 beacon、真心跳、真串门请求），只是 bind 在
45872 而不是 45871——同一台机器上两个进程绑同一个 UDP 端口在 macOS 上会打架。
报文里的 `port` 字段本来就会告诉对方“回我发这里”，所以它和真机没有区别。

流程：启动 → `/local-pet/state` 的 `neighbors` 里出现它 → 用上面的 `admit` 放行 →
按 `v` 让它来串门，它的宠物作为访客出现在你的桌面上，待到你送客。
ticket 11 之后会改成桌面上的放行卡片。
带上 `--auto-visit N` 会在放行 N 秒后自动来串门一次。

键盘：`v` 让它来串门 · `a <动画名>` 换动作 · `n <新名字>` 改名 · `q` 退出。
每次启动都是新的 `deviceId`，所以每次都会重新问一遍放行。

### 走真的网卡

上面默认只走回环。让它从本机网卡发出去、再被自己的插件收回来，就是第二台机器会走的那条路：

```sh
# 先看本机网卡：ipconfig getifaddr en1  →  10.10.11.11，广播地址 10.10.11.255
npm run fake-peer -- --bind 10.10.11.11 --to 10.10.11.255
```

这一步能证明：插件确实在收**广播**（不是只收单播回执）、报文能出网卡再回来、
回执能找到广告的服务端口。剩下没被它证明的只有“另一台机器的广播能不能到这”。

## 第二台机器

两边都做同样的事：

1. 把本仓库放到 B 上（clone 或直接拷目录），`node scripts/install.mjs`，重启 B 的 DSH。
2. 两台机器同一网段，**UDP 45871 都不能被别的进程占**。
3. macOS 会问一次“允许传入连接”，要允许（这台机器的防火墙当前是关的，所以没弹）。
4. 两边的 `/local-pet/state` 里出现对方 → 各 `admit` 一次。
5. 任何一边都可以 `curl http://127.0.0.1:<端口>/local-pet/state` 看 `neighbors` 里有没有对方。

看不到邻居时，先在自己这台上跑上面那条 `--bind/--to` 的命令：
自己这台都收不到广播，就不用怀疑对面了。

## 看桌面宠物长什么样

没有屏幕录制权限，真机验证和截图都走 helper：

```sh
npm run smoke:desktop                            # 透明断言 / 点击穿透 / 输入租约 / 物理 / 场景
LOCAL_PET_SMOKE_NOTES=1 npm run smoke:desktop    # 额外写两张棋盘格合成图
```

截图模式单独跑：

```sh
env -u ELECTRON_RUN_AS_NODE \
  ~/.dsh/electron/Electron.app/Contents/MacOS/Electron \
  desktop/main.js --local-pet-shot /tmp/pet.png --local-pet-shot-delay 1200 \
  --local-pet-assets ~/.dsh/profiles/desktop/node_modules/dsh-pet/assets/webm
```

协议、点击穿透裁定、场景 v2、素材协议的细节见 [`desktop/README.md`](desktop/README.md)。

## 开发

```sh
npm test              # node --test，零依赖
npm run smoke:desktop # 真 Electron 冒烟（不进 npm test）
```

- 协议与敌意输入边界：`docs/protocol.md`
- 领域词汇：`CONTEXT.md`；决策：`docs/adr/`
- 宿主逻辑是“纯状态机 + 薄外壳”：`src/room.js` 不碰 socket/fs，I/O 在
  `src/identity.js`、`src/peers.js`、`src/settings.js`、`src/visits.js`、`src/discovery.js`、
  `src/pet-bridge.js`、`src/service.js`；桌面场景是 `src/desktop-pets.js` +
  `src/pet-assets.js`，物理/命中/场景归一化在 `desktop/shared.js`（纯函数，单测覆盖）。
- v1 的 GUI 客厅（`client.js`、`shell.overlay`、预览器）已按 ADR-0005 删除，代码留在
  `v0.1.0` 标签里。
