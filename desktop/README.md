# 桌面 helper（ticket 07 骨架）

宿主是 `ELECTRON_RUN_AS_NODE=1` 的纯 Node，拿不到 `BrowserWindow`。这个目录是另起的
Electron 子进程：**一个**全屏透明窗，一次画完所有道具；与宿主只通过 stdin/stdout 的 JSON 行
通信，不开端口、不走 HTTP。

- `main.js` — Electron 主进程：窗口、点击穿透裁定、stdio 协议、截图
- `preload.js` — 渲染端唯一桥：`ready` / `reportHover` / `onScene`
- `index.html` + `renderer.js` — 透明画布；场景里每个 item 画成一个 div
- `shared.js` — 宿主/主进程/渲染端共用的纯逻辑：行协议、场景归一化、命中判定、穿透裁定

## 怎么跑

宿主侧（`src/desktop.js`）负责 spawn；也可以单独跑：

```bash
# 截图模式：自己放一个占位方块，抓 PNG + 同名 .json 后退出
env -u ELECTRON_RUN_AS_NODE \
  /Users/gensean/.dsh/electron/Electron.app/Contents/MacOS/Electron \
  desktop/main.js --local-pet-shot /tmp/local-pet.png --local-pet-shot-delay 900

# 交互式调试：手动喂 JSON 行
env -u ELECTRON_RUN_AS_NODE /Users/gensean/.dsh/electron/Electron.app/Contents/MacOS/Electron \
  desktop/main.js --local-pet-host-pid $$ --local-pet-debug
```

**所有 helper 自己的开关都必须带 `--local-pet-` 前缀**：Electron 会消费 `--debug` 之类的已知
开关（实测 `--debug` 直接以 exit 9 退出），前缀保证它们原样落到 `process.argv`。

真机冒烟（不进 `npm test`；没有 Electron 时应该跳过）：

```bash
npm run smoke:desktop
```

它会用 `capturePage()` 抓图并用 zlib 自己解 PNG，断言背景透明、方块位置/颜色对；再跑一遍
渲染端/主进程两条命中通道、崩溃重启、dispose、宿主被 SIGKILL 后 helper 自行退出。

## 宿主 → helper 命令

一行一个 JSON 对象，`\n` 结尾，单行上限 64 KiB。未知字段忽略，未知 `type`/坏字段整条丢弃。

| 命令 | 字段 | 说明 |
| --- | --- | --- |
| `show` | — | `showInactive()` 显示；不抢焦点 |
| `hide` | — | 先恢复穿透再隐藏 |
| `update` | `scene` | 替换整个场景；按新场景重新复核光标（可逐帧下发） |
| `shot` | `id?`, `path`（绝对路径） | `capturePage()` 写 PNG + `<path>.json`，回 `shot` 事件 |
| `ping` | `id?` | 回 `pong`；宿主每 5s 一次，helper 30s 没收到任何行就自行退出 |
| `status` | `id?` | 回 `status` 事件（诊断用） |
| `quit` | — | 优雅退出 |

只有 `--local-pet-debug` 下才接受：

| 命令 | 字段 | 说明 |
| --- | --- | --- |
| `pointer` | `x`,`y` 屏幕 DIP；或 `clear:true` | 用固定光标替代 `screen.getCursorScreenPoint()`（不动真实鼠标） |
| `debug-move` | `x`,`y` 屏幕 DIP | 设光标 + 向渲染端 `sendInputEvent` 一条合成 mousemove |
| `debug-freeze-hover` | `frozen` | 模拟渲染端死亡：忽略 hover 消息、清掉最近确认、**同时关掉主进程兜底** |

## helper → 宿主事件

| 事件 | 字段 | 说明 |
| --- | --- | --- |
| `ready` | `pid`, `workArea`, `displays`, `debug`, `shotMode` | 窗口显示后发；显示器变化时重发 |
| `hit` | `inside`, `interactive`, `point`, `rect`, `reason` | **只在穿透状态翻转时发**；`point`/`rect` 是屏幕 DIP |
| `shot` | `id?`, `path`, `width`, `height`, `bytes` | 像素尺寸是物理像素（Retina 上是 2×） |
| `error` | `code`, `message` | 非致命错误 |
| `pong` | `id?` | 对 `ping` |
| `status` | `id?`, `status` | `ignoring` / `sceneItems` / `hoverInside` / `lastHoverAgeMs` / `insideForMs` / `hoverFrozen` / `visible` / `focused` / `bounds` / `pointer` |

`ready` 里的 `workArea` 是**主屏**工作区（DIP）。窗口 bounds 永远等于它；场景坐标是窗口局部
CSS 像素，因此也就是工作区局部坐标。`hit.rect` 为了方便宿主/测试，换算成了屏幕坐标。

## 场景（`update.scene`）

```json
{
  "version": 1,
  "items": [
    {
      "id": "placeholder",
      "kind": "placeholder",
      "x": 2252, "y": 677, "width": 180, "height": 180,
      "label": "local-pet",
      "color": "#3b74d8"
    }
  ]
}
```

- `items` 上限 64；重复 `id`、未知 `kind`、非正尺寸、非 `#rrggbb` 颜色都会被丢弃/回落。
- `kind` 现在只有 `placeholder` / `pet` / `card` 三种画法；`pet` 与 `card` 是给 ticket 08 留的。
- **item 矩形就是命中矩形**。窗口默认整窗穿透；只有光标落在某个 item 上、且满足下面的裁定，
  才临时 `setIgnoreMouseEvents(false)`。
- 坐标是窗口局部坐标；宿主在 `ready` 后用 `workArea` 算场景（`shared.placeholderScene()`）。

## 点击穿透的裁定（ticket 08 必须理解）

`desktop/main.js` 每 100ms 以及在每次渲染端上报时，用 `shared.shouldBeInteractive()` 算一次：

1. 光标**不在**任何 item 里 → 一律穿透（渲染端说什么都不能翻案）；
2. 光标在 item 里，且渲染端在最近 1.2s 内确认过 `inside` → 接管鼠标（`reason: 'hovering'`）；
3. 渲染端一直没消息（macOS 后台应用可能收不到 Electron 的 forward 事件）→ 光标在 item 里连续
   停留 300ms 后由主进程兜底接管（`reason: 'main-fallback'`）。

渲染端在命中区期间每 350ms 发一次心跳；`forceIgnore()`（失焦、隐藏、宿主失联、退出）会清掉确认。
场景更新**不会**清掉确认：主进程每拍都用新场景复核真实光标，因此 ticket 08 可以逐帧 `update`
宠物位置而不会让交互闪断；光标被移出新的命中区时会立刻恢复穿透。**helper 进程死掉时窗口随进程
消失，不存在“幽灵全屏窗”。**

对 ticket 08 的直接含义：

- **拖拽前必须加输入租约**。现在的规则是“光标在 item 上就接管鼠标”；宠物被拖得比光标快时，
  光标会落到 item 外，窗口翻回穿透，渲染端的 `pointermove`/`pointerup` 会断（dsh-pet 的
  `inputBusy` 就是为这个）。建议在 ticket 08 加一个 `busy` 标志 + 对应命令/IPC，忙碌期间不因
  位置判定恢复穿透；释放时再交还。
- `focusable: false`：窗口永远不抢焦点，所以**没有键盘输入**。卡片上如果要输入文字，得改窗口
  配置（并重新评估抢焦点/全屏置顶的风险），不在 ticket 07 范围内。
- 场景更新是整包替换、整树重绘；每帧更新宠物位置时要控制消息大小（<64 KiB、≤64 items），
  必要时按 30–60Hz 批量发。ticket 08 若要做平滑动画，建议渲染端按 `id` 复用 DOM 节点，
  宿主只发“目标位置/物理状态”，插值放渲染端。逐帧 `update` 不会清掉悬停确认（见上一节），
  但渲染端每次都会整树重绘，性能上仍建议复用节点。
- `client.js`（v1 的 GUI 浮层）是浏览器 IIFE，有 `position:fixed`/`right:bottom` 的浮层坐标，
  不能直接塞进这个窗口；ticket 08 应把它的绘制部分搬进 `desktop/renderer.js`，动作/状态仍从
  宿主快照来。
- 多显示器：窗口只覆盖主屏工作区；其它屏不显示。显示器插入/拔出/改分辨率会重发 `ready`，
  宿主重算场景即可（窗口 bounds 会跟着主屏工作区走）。
- Spaces：`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` 已开，但
  `focusable:false` 的 accessory 窗口在“全屏应用/台前调度”下的实际层级没有在真机上验证过；
  `alwaysOnTop` 层级用的是 macOS 的 `floating`（不是 `screen-saver`，避免压过全屏应用和截图）。

## 进程存亡

- 宿主 spawn 时**删除 `ELECTRON_RUN_AS_NODE`**（`src/desktop-launch.js` 的 `helperEnv`）。
  设成空串会让 Electron abort，设成 `'0'` 仍是纯 Node 模式。
- 宿主注入 `LOCAL_PET_HOST_PID`；helper 每 2s `kill(pid,0)`，ESRCH 就自行退出。
- 宿主进程退出时同步 SIGKILL 子进程；`dispose()` 先 `quit`，再 SIGTERM，1s 后 SIGKILL。
- helper 的 stdin 关闭/EPIPE 也直接退出；stdout/stderr 错误都不会弹 Electron 的默认崩溃框。
- 崩溃重启由宿主 `src/desktop.js` 负责：300ms 起指数退避（300/600/1200/2400/4800），最多 5 次；
  稳定运行 60s 后计数清零。每次崩溃/熔断只打一行日志。
