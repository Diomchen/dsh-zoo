# 桌面 helper（ticket 07–11）

宿主是 `ELECTRON_RUN_AS_NODE=1` 的纯 Node，拿不到 `BrowserWindow`。这个目录是另起的
Electron 子进程：**一个**全屏透明窗，一次画完所有宠物；与宿主只通过 stdin/stdout 的 JSON 行
通信，不开端口、不走 HTTP。

- `main.js` — Electron 主进程：窗口、点击穿透裁定、输入租约、`localpet://` 素材协议、stdio、截图
- `preload.js` — 渲染端唯一桥：`ready` / `reportHover` / `reportRects` / `reportOverlayRects` /
  `setBusy` / `requestAction` / `onActionResult` / `onScene`
- `index.html` + `renderer.js` — 透明画布；每只宠物一个 DOM 节点，60fps 本地物理；
  悬停/点击控件（串门/召回/送客/放行卡/提示气泡）也在这里
- `shared.js` — 宿主/主进程/渲染端共用的纯逻辑：行协议、场景 v2（含 `controls`）、物理、
  命中判定、穿透裁定

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

# 不开 argv、只靠环境变量也能进 debug 模式（宿主 spawn helper 时会继承自己的环境）：
env -u ELECTRON_RUN_AS_NODE LOCAL_PET_DESKTOP_DEBUG=1 \
  /Users/gensean/.dsh/electron/Electron.app/Contents/MacOS/Electron \
  desktop/main.js --local-pet-host-pid $$
```

debug 模式 = `--local-pet-debug` **或** 环境变量 `LOCAL_PET_DESKTOP_DEBUG=1`。
它打开 devTools，并接受下面那组 `debug-*` / `pointer` 命令；两者效果完全一样，
后者只是方便在宿主 spawn 出来的 helper 上临时开调试，不用改 argv。

**所有 helper 自己的开关都必须带 `--local-pet-` 前缀**：Electron 会消费 `--debug` 之类的已知
开关（实测 `--debug` 直接以 exit 9 退出），前缀保证它们原样落到 `process.argv`。

`--local-pet-assets <dir>` 可以重复，按顺序查找素材；宿主侧由 `src/pet-assets.js` 解析
（`$DSH_HOME/dsh-pet/main-animation/webm` → 包内 `assets/webm` → `profiles/*/node_modules/...`），
**不写死 profile 名**。没有素材时宠物退成内置 SVG 色块，串门不受影响。

真机冒烟（不进 `npm test`；没有 Electron 时应该跳过）：

```bash
npm run smoke:desktop
LOCAL_PET_SMOKE_NOTES=1 npm run smoke:desktop   # 额外写 .scratch/local-pet/notes/08-*.png、11-*.png
```

它用 `capturePage()` 抓图并用 zlib 自己解/编码 PNG：断言背景透明、每只宠物的媒体区和昵称条
有像素、`localpet://` 真的加载了 WebM；再跑点击穿透两条通道、输入租约（含超时）、拖拽/投掷、
场景增删/reset、素材缺失时的 SVG 降级、崩溃重启、dispose、宿主被 SIGKILL 后 helper 自行退出。
ticket 11 又加了：悬停 → 弹层、按钮点击真的把 `action` 写给宿主、失败 `notice` 冒泡、
放行卡接受/拒绝、送客、自己出门时的召回胶囊，以及点击穿透的几条硬线（A2/A3）：
弹层打开但光标离开宠物与弹层时整窗必须穿透、宠物与弹层之间的空隙由桥接矩形接管、
拖拽租约必须在 `ui:drag` 盖住光标时才生效、租约超时（冻住心跳）和连续持有硬上限
（心跳仍在续租，`debug-busy-max` 缩短到 700ms）。

## 宿主 → helper 命令

一行一个 JSON 对象，`\n` 结尾，单行上限 256 KiB（一条场景最多 256 个 item，留足余量）。
未知字段忽略，未知 `type`/坏字段整条丢弃。

| 命令 | 字段 | 说明 |
| --- | --- | --- |
| `show` | — | `showInactive()` 显示；不抢焦点 |
| `hide` | — | 先恢复穿透并入租约再隐藏 |
| `update` | `scene` | 替换整个场景 v3（含 `controls` / `menu`）；按新场景 + 渲染端矩形重新复核光标 |
| `action-result` | `id`, `ok`, `notice?`, `error?` | 回复渲染端的一次控件申请；失败必须带人话 `notice`，渲染端会冒泡 |
| `open-url` | `url`（http/https） | 用系统浏览器/默认应用打开（菜单里的「打开软件」）。非 http(s) 在命令白名单处就被丢掉，helper 不执行 |
| `shot` | `id?`, `path`（绝对路径） | `capturePage()` 写 PNG + `<path>.json`，回 `shot` 事件 |
| `ping` | `id?` | 回 `pong`；宿主每 5s 一次，helper 30s 没收到任何行就自行退出 |
| `status` | `id?` | 回 `status` 事件（诊断用） |
| `quit` | — | 优雅退出 |

只有 debug 模式（`--local-pet-debug` 或 `LOCAL_PET_DESKTOP_DEBUG=1`）下才接受：

| 命令 | 字段 | 说明 |
| --- | --- | --- |
| `pointer` | `x`,`y` 屏幕 DIP；或 `clear:true` | 用固定光标替代 `screen.getCursorScreenPoint()`（不动真实鼠标） |
| `debug-move` | `x`,`y` | 设光标 + 向渲染端 `sendInputEvent` 一条合成 mousemove |
| `debug-input` | `x`,`y`,`action:'move'\|'down'\|'up'` | 合成鼠标事件（走真实输入管线；会被真实光标干扰，拖拽冒烟优先用 `debug-dispatch`） |
| `debug-dispatch` | `x`,`y`,`phase:'down'\|'move'\|'up'\|'click'\|'blur'` | 在渲染端派发合成 `PointerEvent` / blur（走同一套处理器）；`click` 先在屏幕坐标做 `elementFromPoint`，再点按钮或宠物 |
| `debug-renderer` | `id?` | 回 `renderer-state` 事件：渲染端探针（宠物位置/速度/素材/拖拽态/控件/overlay 矩形） |
| `debug-freeze-hover` | `frozen` | 模拟渲染端死亡：忽略 hover 消息、清掉最近确认、**同时关掉主进程兜底** |
| `debug-freeze-busy` | `frozen` | 模拟渲染端卡死：不再接受 busy 续期，已有租约按时间戳自然过期 |
| `debug-busy-max` | `ms`（0 = 恢复默认） | 调试/冒烟：临时缩短连续租约硬上限（200ms..60s），用来几秒内验证 fail-closed |
| `debug-lock-input` | `locked` | 调试/冒烟：锁住真实鼠标/焦点事件，只接受 `debug-dispatch` 的合成输入（同时清掉悬停与租约） |

## 右键菜单（ticket 22）

菜单内容由宿主随场景下发（`scene.menu`），helper 只画：

- 只挂**自己**（`role: 'self'`）；访客和空白桌面都不弹，也不吞鼠标。
- 一级 = 工具项（`open-site` / `home` / `reload`）+「动作」；二级 = 分类；三级 = 动画名。
- 每级是**平级面板**：贴右/贴下自动翻到另一侧，各自独立滚动；面板矩形进 `overlay-rects`，
  一级面板与宠物之间有桥接矩形。
- 菜单打开时宠物停住（不飞、不漫游、不轮播换段）。
- **浮层存在期间，overlay 矩形必须按心跳续报**（`reportOverlayRects(false)`，300ms 节流）。
  主进程对这批矩形只认 `RENDERER_RECT_MAX_AGE_MS`（900ms），过期就当没有：窗口翻回穿透，
  菜单画着但点击落到后面的 app 上。只在"变化时"报一次是不够的。
- 收起只有三条路：点中某项 / 光标离开菜单与宠物 `UI_LEAVE_GRACE_MS` / `UI_MAX_OPEN_MS` 超时。
  **点菜单外不关**——窗口在该处是穿透的，那一击要落到桌面；窗口 `focusable:false`，Esc 也收不到。
- 「回到初始位置」在渲染端本地完成（回到该宠物的出生点）；其余两项与「动作」都只是申请。

## helper → 宿主事件

| 事件 | 字段 | 说明 |
| --- | --- | --- |
| `ready` | `pid`, `workArea`, `displays`, `debug`, `shotMode` | 窗口显示后发；显示器变化时重发 |
| `hit` | `inside`, `interactive`, `itemId`, `point`, `rect`, `reason` | **只在穿透状态翻转时发**；`point`/`rect` 是屏幕 DIP；`reason` 见下 |
| `action` | `id`, `action`, `deviceId?`, `nickname?`, `name?` | 渲染端控件/菜单申请宿主动作（`visit`/`recall`/`end-visit`/`admit`/`reject`/`dismiss`/`rename`/`play-anim`/`reload`/`open-site`）。宿主执行后用 `action-result` 回同一个 `id`；**渲染端不直接改状态**。`rename` 带 `nickname`、`play-anim` 带动画名 `name`（必须是安全动画名），helper 只截长度/校验形状，清洗交给宿主 |
| `shot` | `id?`, `path`, `width`, `height`, `bytes` | 像素尺寸是物理像素（Retina 上是 2×）；sidecar 里还带渲染端探针 |
| `renderer-state` | `id?`, `state` | 仅 `debug-renderer` 的回复 |
| `error` | `code`, `message` | 非致命错误 |
| `pong` | `id?` | 对 `ping` |
| `status` | `id?`, `status` | 含 `ignoring` / `sceneItems` / `busy` / `busyHeldMs` / `busyBlocked` / `busyCapMs` / `rendererRects` / `overlayRects` / `hoverInside` / `bounds` / `pointer` 等 |

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
      "id": "visitor:6f1c…",
      "kind": "pet",
      "role": "visitor",
      "anim": null,
      "x": 1181, "y": 1201, "width": 169, "height": 201,
      "label": "阿蟹",
      "color": "#2f8f5b"
    }
  ],
  "controls": {
    "visit": { "enabled": true, "reason": null },
    "recall": { "enabled": false, "nickname": null },
    "visitors": [{ "deviceId": "6f1c…", "label": "阿蟹" }],
    "prompt": { "deviceId": "9a2b…", "nickname": "泡泡" },
    "notice": { "text": "「阿蟹」没有回应，宠物先留在家里了。", "at": 1762000000000 }
  }
}
```

`controls` 是 ticket 11 的宿主权威状态（全部可缺省，缺省即“没有控件”）：

- `visit`：串门按钮；`enabled:false` 时 `reason` 必须是能直接显示给人看的一句话。
- `recall`：自己出门时桌面没有 `self`，渲染端用一个常驻「召回」胶囊代替；
  `nickname` 用来显示“在「阿蟹」家”。
- `visitors`：当前可送客的访客；`item.id` 是 `visitor:<deviceId>`，两边按 deviceId 对上。
- `prompt`：放行 FIFO 队首；渲染端在宠物旁边画 接受 / 拒绝 / 稍后再说，绝不遮挡宠物本体。
- `notice`：最近一条人话提示。异步失败（超时、对方失联、被送客）不经过 `action-result`，
  渲染端靠 `notice.at` 变化冒泡；超过 30s 的旧 notice 不会在 helper 重启后重新弹出。

位置仍是渲染端拥有；`controls` 只描述“能点什么、为什么不能点”，点击只发 `action` 申请。

- **谁是权威**：宿主只决定「有谁 / 叫什么 / 在播什么」（`id`/`role`/`label`/`anim`/`color`）。
- **位置**：只把 `x`/`y` 当**出生点**。已经在场的宠物由渲染端保留自己的位置/速度；宿主改
  `x`/`y` 不会让它瞬移。`reset: true` 才会让渲染端按 `x`/`y` 重新出生全部宠物
  （`src/desktop.js` 的 `manager.resync(scene)`）。
- **尺寸**：`width`/`height` 是整只宠物的命中矩形；渲染端用同一个矩形做物理边界和上报。
- **谁在画**：宿主目前只下发 `self` / `visitor`（心跳影子不下发，它不是访客）；
  场景协议仍接受 `guest` 给截图/演示用。`kind` 留了 `card` 给 ticket 11。
- **动作降级**：`anim` 是 dsh-pet 动画名；渲染端先试它，404/解码失败退到内置待机片段轮播，
  全失败才画带昵称的 SVG 色块。
- `items` 上限 256；重复 `id`、未知 `kind`、非正尺寸、非 `#rrggbb` 颜色都会被丢弃/回落。
- 宿主只在宠物集合/动作/昵称变化时下发（签名比较），**不逐帧**：位置与物理在渲染端。
  500ms 的巡检兜底所有状态变化路径（心跳、tick、dsh-pet 轮询、action）。

## 渲染端持有位置，主进程怎么保持命中正确

这是 ticket 08 的关键 seam：

1. 渲染端每次物理步进后用 `local-pet:rects` 上报所有宠物矩形（移动 ~30Hz，静止 300ms 心跳，
   窗口局部 DIP）。矩形带 `id`；主进程按 `id` 把场景里已经删掉的宠物立刻从命中区移除。
2. 控件（弹层、放行卡、召回胶囊、按钮）用另一条 `local-pet:overlay-rects` 上报，同样带
   时间戳、同样 900ms 过期。它们不参与物理，但决定了“光标压在按钮上”时窗口是否接管鼠标；
   **宠物矩形排在控件矩形后面**，重叠时宠物优先（`hit.itemId` 不会变成 `ui:*`）。
   弹层还多报一条 `ui:bridge:popover`：宠物与弹层之间 8px 间隙的并集，光标横穿时不会落空。
3. 主进程的 `shouldBeInteractive()` **只认**这些矩形（超过 `RENDERER_RECT_MAX_AGE_MS` 就当作
   没有命中区）。场景刚更新、渲染端还没上报时，用出生矩形兜底最多 800ms。
   渲染端上报的矩形是不可信输入：单边超过 `MAX_HIT_RECT_SIZE`（1024）直接拒绝、越界的
   裁到工作区里（裁完为空就丢掉）、数量上限 `MAX_HIT_RECTS`（256）。
4. 光标位置仍由主进程用自己的 `screen.getCursorScreenPoint()` 独立复核；渲染端只能申请，
   不能单方面把窗口变成可交互。
5. **只有拖拽**会让渲染端通过 `local-pet:busy` 持有**输入租约**：宠物是弹簧跟随，快速拖动
   时光标会跑到宠物矩形外，位置判定已经失效，窗口也必须保持可交互，否则
   `pointermove`/`pointerup` 全断（ticket 07 的坑）。为此拖拽期间额外上报一条以光标为
   中心、半径 80px 的 `ui:drag` 矩形（并集上宠物本体），约 30Hz 跟着指针走。
   **租约本身不能把窗口变成可交互**：光标必须真的压在一条活的命中矩形上（`ui:drag` 也算），
   否则一律 fail closed 回穿透。
6. 弹层**不持有输入租约**：它靠 `ui:popover` + `ui:bridge:popover` 接管鼠标，光标离开
   宠物与弹层后窗口立刻穿透（点桌面别处不会被弹层吃掉）。关闭/移开/失焦/12s 超时/场景
   reset 都会撤掉它的矩形。
7. 租约每 `BUSY_HEARTBEAT_MS`（300ms）续期一次，主进程超过 `BUSY_LEASE_MS`（1200ms）没收到
   就自动释放；`pointerup`/`pointercancel`/window `blur`/页面隐藏/2.5s 无移动也会主动释放。
   另外还有一条 `BUSY_MAX_MS`（30s）的**连续持有硬上限**：即使渲染端活着且一直续租，
   到点也必须收回；硬上限触发的收回是粘滞的，只认一次显式 `busy:false`（普通超时可由新的
   悬停确认恢复）。
   `forceIgnore()`（隐藏、失焦、显示器变化、宿主失联、退出）会收回租约并要求渲染端重新确认。
   **窗口失焦/渲染端死掉时，最多 1.2s + 一个 100ms 轮询就恢复穿透。**
8. 放行卡/召回胶囊是常驻控件，**不持有租约**；它们靠 `overlay-rects` 在光标真正压上去时
   接管鼠标，并用“宠物 + 控件”的桥接矩形盖住间隙。

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
- 宿主每 5s 发一次 `ping`；helper 30s 没收到任何一行就自行退出。
- **pong 看门狗**：`ready` 之后超过 15s 没有收到 `pong`（3 个 ping 周期，正常长 GC 不会误杀），
  宿主按卡死处理：SIGKILL 掉，然后走同一套退避重启。helper 卡在死循环/无响应时，
  桌面上不会留下一个永远不动的窗口。
- helper 重启后宿主会重新下发生成场景；`pid` 变了说明是新的渲染端，`reset: true` 让它重新出生。

## 改名小窗（ticket 13）

主窗 `focusable: false` 是刻意的（ADR-0005），所以**键盘输入只能单开一扇窗**：

- 悬停自己那只 → 弹层多一项「改名」→ `local-pet:rename-open` → 主进程开一扇
  `rename.html` 小窗（360×168，无边框、置顶、`focusable: true`，贴在宠物上方，
  放不下就落到下方，再不行夹在工作区里）。
- 小窗 `ready` 后主进程发 `local-pet:rename-init { name, maxLength }`；提交走
  `local-pet:rename-submit`，主进程转成一条 `{type:'action', action:'rename', nickname}` 交给宿主。
- 宿主回的 `action-result` 按 action id 认领：成功就关窗，失败把 `notice` 发回小窗显示
  （`local-pet:rename-result`），窗口不关、输入保留。
- 失焦、Esc、主窗 `hide`、helper 退出都会关掉小窗；10 秒等不到宿主答复就报一句人话。
- 主窗的穿透/租约状态**完全不受影响**：小窗是另一个 BrowserWindow，关掉它不会改动任何
  `ignoreState` / `busy`。

## 多显示器 / 分辨率

窗口只覆盖主屏工作区；其它屏不显示。插入/拔出/改分辨率会重发 `ready`，宿主重算窗口 bounds。
同一个 helper 的 `ready`（渲染端没重启）不会 `reset`：渲染端收到 `resize` 后用
`shared.resizeBodies()` 把所有宠物夹回新工作区（不穿地、不出界、不清速度），再重报矩形。

## 已知限制

- `focusable: false`：没有键盘输入。所有控件（串门/召回/送客/改名/放行卡）都是鼠标点击，没有
  Tab/Enter/Esc；放行卡的“稍后再说”是一个 × 按钮。唯一的例外是**改名小窗**（见下）。
- 悬停弹层依赖渲染端收到 `pointermove`；macOS 上 `forward: true` 失效时，主进程仍能靠 300ms
  兜底让弹层打开后的按钮可点，但“悬停即出现”本身可能延迟到兜底接管。
- 控件位置每 100ms 跟一次宠物；宠物被快速拖动时弹层会有一点跟手延迟（不影响点击）。
- macOS 上 `forward: true` 依赖 Electron 的鼠标转发钩子；hook 失效时靠主进程 300ms 兜底接管。
- `setVisibleOnAllWorkspaces` + `focusable:false` 在「全屏应用/台前调度」下的实际层级没有真机
  验证；置顶层级用 `floating`，不压截图。
- 宠物之间没有物理碰撞（SPEC v2 out of scope）；同屏数量不设产品上限，但场景协议单条消息
  最多 256 个 item（渲染上限），超过时宿主会写一条“还有 N 位没有画出来”的提示；
  每个宠物一个 `<video>`，访客非常多时解码开销线性增长。
- 截图是这台机器上唯一能看到窗口的办法（没有屏幕录制权限）；合成输入走
  `debug-dispatch`/`debug-lock-input`，没有用真实鼠标点过这些按钮。
