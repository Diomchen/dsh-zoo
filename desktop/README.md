# 桌面 helper（ticket 07 + 08）

宿主是 `ELECTRON_RUN_AS_NODE=1` 的纯 Node，拿不到 `BrowserWindow`。这个目录是另起的
Electron 子进程：**一个**全屏透明窗，一次画完所有宠物；与宿主只通过 stdin/stdout 的 JSON 行
通信，不开端口、不走 HTTP。

- `main.js` — Electron 主进程：窗口、点击穿透裁定、输入租约、`localpet://` 素材协议、stdio、截图
- `preload.js` — 渲染端唯一桥：`ready` / `reportHover` / `reportRects` / `setBusy` / `onScene`
- `index.html` + `renderer.js` — 透明画布；每只宠物一个 DOM 节点，60fps 本地物理
- `shared.js` — 宿主/主进程/渲染端共用的纯逻辑：行协议、场景 v2、物理、命中判定、穿透裁定

## 怎么跑

宿主侧（`src/desktop.js`）负责 spawn；也可以单独跑：

```bash
# 截图模式：自己放三只演示宠物（真实 dsh-pet 素材），抓 PNG + 同名 .json 后退出
env -u ELECTRON_RUN_AS_NODE \
  /Users/gensean/.dsh/electron/Electron.app/Contents/MacOS/Electron \
  desktop/main.js \
  --local-pet-shot /tmp/local-pet.png \
  --local-pet-shot-delay 1200 \
  --local-pet-assets ~/.dsh/profiles/desktop/node_modules/dsh-pet/assets/webm

# 交互式调试：手动喂 JSON 行
env -u ELECTRON_RUN_AS_NODE /Users/gensean/.dsh/electron/Electron.app/Contents/MacOS/Electron \
  desktop/main.js --local-pet-host-pid $$ --local-pet-debug \
  --local-pet-assets ~/.dsh/profiles/desktop/node_modules/dsh-pet/assets/webm
```

**所有 helper 自己的开关都必须带 `--local-pet-` 前缀**：Electron 会消费 `--debug` 之类的已知
开关（实测 `--debug` 直接以 exit 9 退出），前缀保证它们原样落到 `process.argv`。

`--local-pet-assets <dir>` 可以重复，按顺序查找素材；宿主侧由 `src/pet-assets.js` 解析
（`$DSH_HOME/dsh-pet/main-animation/webm` → 包内 `assets/webm` → `profiles/*/node_modules/...`），
**不写死 profile 名**。没有素材时宠物退成内置 SVG 色块，串门不受影响。

真机冒烟（不进 `npm test`；没有 Electron 时应该跳过）：

```bash
npm run smoke:desktop
LOCAL_PET_SMOKE_NOTES=1 npm run smoke:desktop   # 额外写 .scratch/local-pet/notes/08-*.png
```

它用 `capturePage()` 抓图并用 zlib 自己解/编码 PNG：断言背景透明、每只宠物的媒体区和昵称条
有像素、`localpet://` 真的加载了 WebM；再跑点击穿透两条通道、输入租约（含超时）、拖拽/投掷、
场景增删/reset、素材缺失时的 SVG 降级、崩溃重启、dispose、宿主被 SIGKILL 后 helper 自行退出。

## 宿主 → helper 命令

一行一个 JSON 对象，`\n` 结尾，单行上限 64 KiB。未知字段忽略，未知 `type`/坏字段整条丢弃。

| 命令 | 字段 | 说明 |
| --- | --- | --- |
| `show` | — | `showInactive()` 显示；不抢焦点 |
| `hide` | — | 先恢复穿透并入租约再隐藏 |
| `update` | `scene` | 替换整个场景 v2；按新场景 + 渲染端矩形重新复核光标 |
| `shot` | `id?`, `path`（绝对路径） | `capturePage()` 写 PNG + `<path>.json`，回 `shot` 事件 |
| `ping` | `id?` | 回 `pong`；宿主每 5s 一次，helper 30s 没收到任何行就自行退出 |
| `status` | `id?` | 回 `status` 事件（诊断用） |
| `quit` | — | 优雅退出 |

只有 `--local-pet-debug` 下才接受：

| 命令 | 字段 | 说明 |
| --- | --- | --- |
| `pointer` | `x`,`y` 屏幕 DIP；或 `clear:true` | 用固定光标替代 `screen.getCursorScreenPoint()`（不动真实鼠标） |
| `debug-move` | `x`,`y` | 设光标 + 向渲染端 `sendInputEvent` 一条合成 mousemove |
| `debug-input` | `x`,`y`,`action:'move'\|'down'\|'up'` | 合成鼠标事件（走真实输入管线；会被真实光标干扰，拖拽冒烟优先用 `debug-dispatch`） |
| `debug-dispatch` | `x`,`y`,`phase:'down'\|'move'\|'up'\|'blur'` | 在渲染端派发合成 `PointerEvent` / blur（走同一套处理器） |
| `debug-renderer` | `id?` | 回 `renderer-state` 事件：渲染端探针（宠物位置/速度/素材/拖拽态） |
| `debug-freeze-hover` | `frozen` | 模拟渲染端死亡：忽略 hover 消息、清掉最近确认、**同时关掉主进程兜底** |
| `debug-freeze-busy` | `frozen` | 模拟渲染端卡死：不再接受 busy 续期，已有租约按时间戳自然过期 |
| `debug-lock-input` | `locked` | 调试/冒烟：锁住真实鼠标/焦点事件，只接受 `debug-dispatch` 的合成输入（同时清掉悬停与租约） |

## helper → 宿主事件

| 事件 | 字段 | 说明 |
| --- | --- | --- |
| `ready` | `pid`, `workArea`, `displays`, `debug`, `shotMode` | 窗口显示后发；显示器变化时重发 |
| `hit` | `inside`, `interactive`, `itemId`, `point`, `rect`, `reason` | **只在穿透状态翻转时发**；`point`/`rect` 是屏幕 DIP；`reason` 见下 |
| `shot` | `id?`, `path`, `width`, `height`, `bytes` | 像素尺寸是物理像素（Retina 上是 2×）；sidecar 里还带渲染端探针 |
| `renderer-state` | `id?`, `state` | 仅 `debug-renderer` 的回复 |
| `error` | `code`, `message` | 非致命错误 |
| `pong` | `id?` | 对 `ping` |
| `status` | `id?`, `status` | 含 `ignoring` / `sceneItems` / `busy` / `rendererRects` / `hoverInside` / `bounds` / `pointer` 等 |

`ready` 里的 `workArea` 是**主屏**工作区（DIP）。窗口 bounds 永远等于它；场景坐标是窗口局部
CSS 像素，因此也就是工作区局部坐标。`hit.rect` 为了方便宿主/测试，换算成了屏幕坐标。

穿透翻转的 `reason`：`initial` / `hovering` / `main-fallback` / `busy-lease` / `outside` /
`waiting-for-confirmation` / `stale-renderer-confirmation` / `no-scene` / `scene-updated` /
`renderer-busy` / `renderer-idle` / `renderer-rects` / `hide` / `blur` / `display-changed` 等。

## 场景协议 v2（`update.scene`）

```json
{
  "version": 2,
  "reset": false,
  "items": [
    {
      "id": "self",
      "kind": "pet",
      "role": "self",
      "anim": "东张西望",
      "x": 48, "y": 1201, "width": 169, "height": 201,
      "label": "小蓝",
      "color": "#3b74d8"
    },
    {
      "id": "guest:6f1c…",
      "kind": "pet",
      "role": "guest",
      "anim": null,
      "x": 1181, "y": 1201, "width": 169, "height": 201,
      "label": "阿蟹",
      "color": "#2f8f5b"
    }
  ]
}
```

- **谁是权威**：宿主只决定「有谁 / 叫什么 / 在播什么」（`id`/`role`/`label`/`anim`/`color`）。
- **位置**：只把 `x`/`y` 当**出生点**。已经在场的宠物由渲染端保留自己的位置/速度；宿主改
  `x`/`y` 不会让它瞬移。`reset: true` 才会让渲染端按 `x`/`y` 重新出生全部宠物
  （`src/desktop.js` 的 `manager.resync(scene)`）。
- **尺寸**：`width`/`height` 是整只宠物的命中矩形；渲染端用同一个矩形做物理边界和上报。
- **谁在画**：宿主目前只下发 `self` / `visitor`（心跳影子不下发，它不是客人）；
  场景协议仍接受 `guest` 给截图/演示用。`kind` 留了 `card` 给 ticket 11。
- **动作降级**：`anim` 是 dsh-pet 动画名；渲染端先试它，404/解码失败退到内置待机片段轮播，
  全失败才画带昵称的 SVG 色块。
- `items` 上限 64；重复 `id`、未知 `kind`、非正尺寸、非 `#rrggbb` 颜色都会被丢弃/回落。
- 宿主只在宠物集合/动作/昵称变化时下发（签名比较），**不逐帧**：位置与物理在渲染端。
  500ms 的巡检兜底所有状态变化路径（心跳、tick、dsh-pet 轮询、action）。

## 渲染端持有位置，主进程怎么保持命中正确

这是 ticket 08 的关键 seam：

1. 渲染端每次物理步进后用 `local-pet:rects` 上报所有宠物矩形（移动 ~30Hz，静止 300ms 心跳，
   窗口局部 DIP）。矩形带 `id`；主进程按 `id` 把场景里已经删掉的宠物立刻从命中区移除。
2. 主进程的 `shouldBeInteractive()` **只认**这份矩形（超过 `RENDERER_RECT_MAX_AGE_MS` 就当作
   没有命中区）。场景刚更新、渲染端还没上报时，用出生矩形兜底最多 800ms。
3. 光标位置仍由主进程用自己的 `screen.getCursorScreenPoint()` 独立复核；渲染端只能申请，
   不能单方面把窗口变成可交互。
4. 拖拽时渲染端通过 `local-pet:busy` 持有**输入租约**：宠物落后于光标、光标已经离开矩形，
   窗口也必须保持可交互，否则 `pointermove`/`pointerup` 全断（ticket 07 的坑）。
5. 租约每 `BUSY_HEARTBEAT_MS`（400ms）续期一次，主进程超过 `BUSY_LEASE_MS`（1500ms）没收到
   就自动释放；`pointerup`/`pointercancel`/window `blur`/页面隐藏/2.5s 无移动也会主动释放。
   `forceIgnore()`（隐藏、失焦、显示器变化、宿主失联、退出）会收回租约并要求渲染端重新确认。
   **窗口失焦/渲染端死掉时，最多 1.5s 就恢复穿透。**

## 素材协议 `localpet://`

页面是 `file://`，拿不到 DSH 的 `/dsh-pet-7340/thumb/...`。主进程在 app ready 前把
`localpet` 注册成 standard/secure/stream scheme，再从宿主传入的绝对目录里只读地取
`localpet://asset/<encodeURIComponent(动画名)>.webm`：

- 只接受 `<name>.webm`，拒绝 `/`、`\`、控制字符、以 `.` 开头的名字；解析后必须仍在素材根内。
- 单文件上限 8 MiB；支持 `Range`（206）让 `<video>` 边下边播/循环。
- 根目录按优先级查找（用户素材覆盖包内素材），找不到就 404 → 渲染端降级。
- 页面 CSP 只放行 `media-src localpet:`，没有网络、没有新端口。

## 进程存亡

- 宿主 spawn 时**删除 `ELECTRON_RUN_AS_NODE`**（`src/desktop-launch.js` 的 `helperEnv`）。
  设成空串会让 Electron abort，设成 `'0'` 仍是纯 Node 模式。
- 宿主注入 `LOCAL_PET_HOST_PID`；helper 每 2s `kill(pid,0)`，ESRCH 就自行退出。
- 宿主进程退出时同步 SIGKILL 子进程；`dispose()` 先 `quit`，再 SIGTERM，1s 后 SIGKILL。
- helper 的 stdin 关闭/EPIPE 也直接退出；stdout/stderr 错误都不会弹 Electron 的默认崩溃框。
- 崩溃重启由宿主 `src/desktop.js` 负责：300ms 起指数退避（300/600/1200/2400/4800），最多 5 次；
  稳定运行 60s 后计数清零。每次崩溃/熔断只打一行日志。
- helper 重启后宿主会重新下发生成场景；`pid` 变了说明是新的渲染端，`reset: true` 让它重新出生。

## 多显示器 / 分辨率

窗口只覆盖主屏工作区；其它屏不显示。插入/拔出/改分辨率会重发 `ready`，宿主重算窗口 bounds。
同一个 helper 的 `ready`（渲染端没重启）不会 `reset`：渲染端收到 `resize` 后用
`shared.resizeBodies()` 把所有宠物夹回新工作区（不穿地、不出界、不清速度），再重报矩形。

## 已知限制

- `focusable: false`：没有键盘输入；ticket 11 的「送客」按钮只能是鼠标点击。
- macOS 上 `forward: true` 依赖 Electron 的鼠标转发钩子；hook 失效时靠主进程 300ms 兜底接管。
- `setVisibleOnAllWorkspaces` + `focusable:false` 在「全屏应用/台前调度」下的实际层级没有真机
  验证；置顶层级用 `floating`，不压截图。
- 宠物之间没有物理碰撞（SPEC v2 out of scope）；同屏数量不设产品上限，但场景协议单条消息
  最多 64 个 item（渲染上限），且每个宠物一个 `<video>`，客人非常多时解码开销线性增长。
- 截图是这台机器上唯一能看到窗口的办法（没有屏幕录制权限）。
