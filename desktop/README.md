# 桌面 helper（ticket 07–27）

宿主是 `ELECTRON_RUN_AS_NODE=1` 的纯 Node，拿不到 `BrowserWindow`。这个目录是另起的
Electron 子进程：**一个**全屏透明窗，一次画完所有宠物；与宿主只通过 stdin/stdout 的 JSON 行
通信，不开端口、不走 HTTP。

- `main.js` — Electron 主进程：窗口、点击穿透裁定、输入租约、`dshzoo://` 素材协议、stdio、截图
- `preload.js` — 渲染端唯一桥：`ready` / `reportHover` / `reportRects` / `reportOverlayRects` /
  `setBusy` / `requestAction` / `onActionResult` / `onScene`
- `index.html` + `renderer.js` — 透明画布；每只宠物一个 DOM 节点，60fps 本地物理；
  悬停/点击控件（串门/召回/送客/放行卡/提示气泡）也在这里
- `shared.js` — 宿主/主进程/渲染端共用的纯逻辑：行协议、场景 v3（含 `controls` / `menu`）、物理、
  命中判定、穿透裁定

## 怎么跑

宿主侧（`src/desktop.js`）负责 spawn；也可以单独跑：

```bash
# 截图模式：自己放三只演示宠物（真实 dsh-pet 素材），抓 PNG + 同名 .json 后退出
env -u ELECTRON_RUN_AS_NODE \
  /Users/gensean/.dsh/electron/Electron.app/Contents/MacOS/Electron \
  desktop/main.js \
  --dsh-zoo-shot /tmp/dsh-zoo.png \
  --dsh-zoo-shot-delay 1200 \
  --dsh-zoo-assets ~/.dsh/profiles/desktop/node_modules/dsh-pet/assets/webm

# 交互式调试：手动喂 JSON 行
env -u ELECTRON_RUN_AS_NODE /Users/gensean/.dsh/electron/Electron.app/Contents/MacOS/Electron \
  desktop/main.js --dsh-zoo-host-pid $$ --dsh-zoo-debug \
  --dsh-zoo-assets ~/.dsh/profiles/desktop/node_modules/dsh-pet/assets/webm

# 不开 argv、只靠环境变量也能进 debug 模式（宿主 spawn helper 时会继承自己的环境）：
env -u ELECTRON_RUN_AS_NODE DSH_ZOO_DESKTOP_DEBUG=1 \
  /Users/gensean/.dsh/electron/Electron.app/Contents/MacOS/Electron \
  desktop/main.js --dsh-zoo-host-pid $$
```

debug 模式 = `--dsh-zoo-debug` **或** 环境变量 `DSH_ZOO_DESKTOP_DEBUG=1`。
它打开 devTools，并接受下面那组 `debug-*` / `pointer` 命令；两者效果完全一样。
后者只是方便在宿主 spawn 出来的 helper 上临时开调试，不用改 argv。
普通运行（没有 `--dsh-zoo-debug`）的 helper 在 `normalizeHostCommand` 就拒绝全部 `debug-*`，
不会执行、也不会静默通过。

**所有 helper 自己的开关都必须带 `--dsh-zoo-` 前缀**：Electron 会消费 `--debug` 之类的已知
开关（实测 `--debug` 直接以 exit 9 退出），前缀保证它们原样落到 `process.argv`。

`--dsh-zoo-assets <dir>` 可以重复，按顺序查找素材；宿主侧由 `src/pet-assets.js` 解析
（`$DSH_HOME/dsh-pet/main-animation/webm` → 包内 `assets/webm` → `profiles/*/node_modules/...`），
**不写死 profile 名**。没有素材时宠物退成内置 SVG 色块，串门不受影响。

`--dsh-zoo-gifts <dir>`（ticket 25）是收到的礼物根目录（宿主传 `<dataDir>/gifts`），
只用于 `dshzoo://gifts/...` 的**缩略图**读取；不传时这条读路径不注册（所有 gifts URL 404）。
它和 `--dsh-zoo-assets` 一样是绝对路径，helper 不自己拼数据目录。

真机冒烟（不进 `npm test`；没有 Electron 时应该跳过）：

```bash
npm run smoke:desktop
DSH_ZOO_SMOKE_NOTES=1 npm run smoke:desktop   # 额外写 .scratch/dsh-zoo/notes/08-*.png、11-*.png
```

它用 `capturePage()` 抓图并用 zlib 自己解/编码 PNG：断言背景透明、每只宠物的媒体区和昵称条
有像素、`dshzoo://` 真的加载了 WebM；再跑点击穿透两条通道、输入租约（含超时）、拖拽/投掷、
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
| `open-url` | `url`（http/https） | 用系统浏览器/默认应用打开（菜单里的「打开软件」）。非 http(s) 在命令白名单处就被丢掉，helper 不执行。地址可能带 DSH 的 launch token：helper 只转交，不写日志、也不回传给渲染端 |
| `bring-window` | `open`, `items[]`（`id`/`kind`/`text?`/`name?`/`state`） | 打开或刷新「带派」小窗（ticket 24）。**不带路径**：背包内容由宿主算好下发，`count`/限额由 helper 侧 `shared.normalizeBringWindow` 补齐 |
| `farm-window` | `open`, `close?`, `farm`, `market`, `contracts`, `mode?:'owner'\|'visitor'\|'look'`, `visit?`, `look?`, `neighbors?`, `plotId?` | 打开/刷新/关闭农场小窗（ticket 40/41/43/44/46/52/55）。`close:true` 才关窗（再点一次「农场」或 `farm-close`），`open:false` 只刷新。数据全部由宿主算好；helper 只按 `shared.normalizeFarmWindow` 重建白名单字段，不读盘、不联网 |
| `shot` | `id?`, `path`（绝对路径）, `window?:'bring'\|'farm'` | `capturePage()` 写 PNG + `<path>.json`，回 `shot` 事件；`window:'bring'` / `window:'farm'` 抓对应小窗 |
| `ping` | `id?` | 回 `pong`；宿主每 5s 一次，helper 30s 没收到任何行就自行退出 |
| `status` | `id?` | 回 `status` 事件（诊断用） |
| `quit` | — | 优雅退出 |

只有 debug 模式（`--dsh-zoo-debug` 或 `DSH_ZOO_DESKTOP_DEBUG=1`）下才接受：

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
| `debug-gift-submit` | `text` | 调试/冒烟：在「带派」小窗里填一段字条并按提交（走真实 form submit 处理器），验窗口 → 主进程 → 宿主的申请链路 |
| `debug-gift-remove` | — | 调试/冒烟：点「带派」小窗背包列表里第一个可撤的「撤掉」 |
| `debug-farm-submit` | `action`, `plotId?`, `cropId?`, `qty?`, `deviceId?`, `hours?`, `contractId?`, `enabled?`, `wagePerHour?`, `minHours?`, `maxHours?` | 调试/冒烟：在农场小窗里提交一次动作，走和用户点击相同的 preload → IPC 窄口 |
| `debug-farm-tab` | `tab:'farm'\|'market'\|'hire'\|'log'` | 调试/冒烟：切到农场小窗的某个页签，用来分别截图 |
| `debug-farm-plant-open` | — | 调试/冒烟：点第一张空地卡，打开真实的播种底部弹窗 |
| `debug-farm-plant-close` | — | 调试/冒烟：点播种弹窗的 × 关上 |
| `debug-farm-batch` | `kind:'plant'\|'harvest'` | 调试/冒烟：点「一键种满 / 一键收割」，验批量队列真的发动作 |
| `debug-farm-close` | `via:'button'\|'escape'` | 调试/冒烟：像用户一样点 × 或按 Esc 关农场小窗（走真实 IPC，不直接 destroy） |

## 右键菜单（ticket 22）

菜单内容由宿主随场景下发（`scene.menu`），helper 只画：

- 只挂**自己**（`role: 'self'`）；访客和空白桌面都不弹，也不吞鼠标。
- 一级 = 工具项（`open-site` / `bring` / `home` / `reload`）+「动作」；二级 = 分类；三级 = 动画名。
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
| `farm-window-state` | `open` | 农场小窗真的开了/关了（含用户点 ×/Esc）；宿主靠它把右键「农场」变成开/关切换 |
| `action` | `id`, `action`, `deviceId?`, `nickname?`, `name?`, `giftId?`, `gift?`, `plotId?`, `cropId?`, `qty?`, `hours?`, `contractId?`, `enabled?`, `wagePerHour?`, `minHours?`, `maxHours?` | 渲染端控件/菜单/小窗申请宿主动作（`visit`/`recall`/`end-visit`/`admit`/`reject`/`dismiss`/`rename`/`play-anim`/`reload`/`open-site`/`bring`/`unbring`/`gift-*`/`farm-*`/`hire`/`recall-worker`/`end-contract`/`hire-listing`/`farm-open`）。宿主执行后用 `action-result` 回同一个 `id`；**渲染端不直接改状态**。`rename` 带 `nickname`、`play-anim` 带动画名 `name`（必须是安全动画名）、礼物卡动作带 `giftId`、`bring` 带 `gift:{kind,text\|path}`（右键菜单的 `bring` 不带，表示开窗），农场动作只带 `plotId`/`cropId`/`qty`，雇佣只带 `deviceId`/`hours`/`contractId`/挂牌四字段；helper 只校验形状，清洗交给宿主 |
| `shot` | `id?`, `path`, `width`, `height`, `bytes` | 像素尺寸是物理像素（Retina 上是 2×）；sidecar 里还带渲染端探针 |
| `renderer-state` | `id?`, `state` | 仅 `debug-renderer` 的回复 |
| `error` | `code`, `message` | 非致命错误 |
| `pong` | `id?` | 对 `ping` |
| `status` | `id?` 等扁平字段 | 含 `ignoring` / `sceneItems` / `busy` / `busyHeldMs` / `busyBlocked` / `busyCapMs` / `rendererRects` / `overlayRects` / `hoverInside` / `bounds` / `pointer` / `renameOpen` / `bringOpen` / `farmOpen` / `farmVisible` / `farmFocused` 等 |

`ready` 里的 `workArea` 是**整张虚拟桌面**：所有显示器工作区的并集（DIP），也就是窗口实际
覆盖的那块矩形；`displays` 里带每块屏的 `bounds` / `workArea` / `scaleFactor` / `primary`。
窗口 bounds 永远等于它；场景坐标是窗口局部 CSS 像素，因此也就是并集局部坐标。
`hit.rect` 为了方便宿主/测试，换算成了屏幕坐标。

穿透翻转的 `reason`：`initial` / `hovering` / `main-fallback` / `busy-lease` / `outside` /
`waiting-for-confirmation` / `stale-renderer-confirmation` / `no-scene` / `scene-updated` /
`renderer-busy` / `renderer-idle` / `renderer-rects` / `hide` / `blur` / `display-changed` 等。

## 场景协议 v3（`update.scene`）

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
    "gifts": [{ "deviceId": "6f1c…", "giftId": "…", "kind": "file", "name": "照片.png",
                "title": "「阿蟹」捎来一个文件", "status": "received",
                "thumb": "dshzoo://gifts/20261103-153245-ab12cd/照片.png" }],
    "prompt": { "deviceId": "9a2b…", "nickname": "泡泡" },
    "notice": { "text": "「阿蟹」没有回应，宠物先留在家里了。", "at": 1762000000000 }
  },
  "menu": { "tools": [], "groups": [] },
  "floors": [
    { "x": 0, "y": 0, "width": 1440, "height": 875 },
    { "x": 1440, "y": 0, "width": 1440, "height": 875 }
  ]
}
```

`controls` 是 ticket 11 的宿主权威状态（全部可缺省，缺省即“没有控件”）：

- `visit`：串门按钮；`enabled:false` 时 `reason` 必须是能直接显示给人看的一句话。
- `recall`：自己出门时桌面没有 `self`，渲染端用一个常驻「召回」胶囊代替；
  `nickname` 用来显示“在「阿蟹」家”。
- `visitors`：当前可送客的访客；`item.id` 是 `visitor:<deviceId>`，两边按 deviceId 对上。
- `gifts`：贴着访客的礼物卡（ticket 23/25）。状态与标题由宿主算好；`text` 只在
  `received` 时给，`thumb` 只给图片且只接受 `dshzoo://gifts/...`。卡片/按钮/桥接矩形
  都进 `overlay-rects`，按钮 id 带 `giftId`，两张卡不会撞名。
- `prompt`：放行 FIFO 队首；渲染端在宠物旁边画 接受 / 拒绝 / 稍后再说，绝不遮挡宠物本体。
- `notice`：最近一条人话提示。异步失败（超时、对方失联、被送客）不经过 `action-result`，
  渲染端靠 `notice.at` 变化冒泡；超过 30s 的旧 notice 不会在 helper 重启后重新弹出。
- `menu`（ticket 22）：右键自己的宠物时画的一级工具项 + 「动作」三级树；内容由宿主下发，
  渲染端只画、只发申请。

位置仍是渲染端拥有；`controls` 只描述“能点什么、为什么不能点”，点击只发 `action` 申请。

- **谁是权威**：宿主只决定「有谁 / 叫什么 / 在播什么」（`id`/`role`/`label`/`anim`/`color`）。
- **位置**：只把 `x`/`y` 当**出生点**。已经在场的宠物由渲染端保留自己的位置/速度；宿主改
  `x`/`y` 不会让它瞬移。`reset: true` 才会让渲染端按 `x`/`y` 重新出生全部宠物
  （`src/desktop.js` 的 `manager.resync(scene)`）。
- **尺寸**：`width`/`height` 是整只宠物的命中矩形；渲染端用同一个矩形做物理边界和上报。
- **谁在画**：宿主目前只下发 `self` / `visitor`（心跳影子不下发，它不是访客）；
  场景协议仍接受 `guest` 给截图/演示用。`kind` 留了 `card` 给 ticket 11，但礼物卡走的是
  `controls.gifts`，**不**塞进 `items`。
- **动作降级**：`anim` 是 dsh-pet 动画名；渲染端先试它，404/解码失败退到内置待机片段轮播，
  全失败才画带昵称的 SVG 色块。
- **多屏地面带**：`floors` 是每块屏工作区在窗口局部坐标里的矩形（宿主从 `ready.displays` 换算，
  每块屏一条）。渲染端先用 `shared.walkBands()` 把**底边相同且水平相邻**的屏合成一条地面带
  （两块同高并排的屏 = 一条，可以在上面来回走），再用 `shared.bandAt()` 找宠物所在带。
  走路只在带内：x 夹在带的左右边界、y 贴带底边——高度不同的屏各自一条带，宠物不会走进
  矮屏下方那块没有显示器的黑区。拖拽不吃这个限制（整张并集都能拖），松手时
  `shared.confineBodyToBand()` 把 x、y 都夹回落点所在的带。
  空数组/缺省 = 老宿主或单屏，物理退回整张桌面（旧行为）。
- `items` 上限 256；重复 `id`、未知 `kind`、非正尺寸、非 `#rrggbb` 颜色都会被丢弃/回落。
- 宿主只在宠物集合/动作/昵称变化时下发（签名比较），**不逐帧**：位置与物理在渲染端。
  500ms 的巡检兜底所有状态变化路径（心跳、tick、dsh-pet 轮询、action）。

## 渲染端持有位置，主进程怎么保持命中正确

这是 ticket 08 的关键 seam：

1. 渲染端每次物理步进后用 `dsh-zoo:rects` 上报所有宠物矩形（移动 ~30Hz，静止 300ms 心跳，
   窗口局部 DIP）。矩形带 `id`；主进程按 `id` 把场景里已经删掉的宠物立刻从命中区移除。
2. 控件（弹层、放行卡、召回胶囊、按钮）用另一条 `dsh-zoo:overlay-rects` 上报，同样带
   时间戳、同样 900ms 过期。它们不参与物理，但决定了“光标压在按钮上”时窗口是否接管鼠标；
   **宠物矩形排在控件矩形后面**，重叠时宠物优先（`hit.itemId` 不会变成 `ui:*`）。
   弹层还多报一条 `ui:bridge:popover`：宠物与弹层之间 8px 间隙的并集，光标横穿时不会落空。
3. 主进程的 `shouldBeInteractive()` **只认**这些矩形（超过 `RENDERER_RECT_MAX_AGE_MS` 就当作
   没有命中区）。场景刚更新、渲染端还没上报时，用出生矩形兜底最多 800ms。
   渲染端上报的矩形是不可信输入：单边超过 `MAX_HIT_RECT_SIZE`（1024）直接拒绝、越界的
   裁到工作区里（裁完为空就丢掉）、数量上限 `MAX_HIT_RECTS`（256）。
4. 光标位置仍由主进程用自己的 `screen.getCursorScreenPoint()` 独立复核；渲染端只能申请，
   不能单方面把窗口变成可交互。
5. **只有拖拽**会让渲染端通过 `dsh-zoo:busy` 持有**输入租约**：宠物是弹簧跟随，快速拖动
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

## 素材协议 `dshzoo://`

页面是 `file://`，拿不到 DSH 的 `/dsh-pet-7340/thumb/...`。主进程在 app ready 前把
`dshzoo` 注册成 standard/secure/stream scheme，再从宿主传入的绝对目录里只读地取：

- `dshzoo://asset/<encodeURIComponent(动画名)>.webm` —— 宠物素材（ticket 07–17）；
- `dshzoo://gifts/<礼物目录>/<图片文件名>` —— 礼物缩略图（ticket 25）。只认**两层**路径：
  第一层必须是礼物目录名（`^\d{8}-\d{6}-[0-9a-f]{8}(-\d+)?$`），文件名只认
  `jpg/jpeg/png/gif/webp`，解析后必须仍在 `--dsh-zoo-gifts` 根内；不列目录、不返回
  非图片文件。`desktop/index.html` 的 CSP 为此在 `img-src` 里加了 `dshzoo:`。

素材（WebM）一侧的规则：

- 素材只接受 `<name>.webm`，拒绝 `/`、`\`、控制字符、以 `.` 开头的名字；解析后必须仍在素材根内。
- 单文件上限 8 MiB；支持 `Range`（206）让 `<video>` 边下边播/循环。
- 根目录按优先级查找（用户素材覆盖包内素材），找不到就 404 → 渲染端降级。
- 礼物缩略图只读不做 Range：图片是完整返回的，且只用于 `<img>`。
- 页面 CSP 放行 `media-src dshzoo:` 与 `img-src dshzoo:`，没有网络、没有新端口。

## 进程存亡

- 宿主 spawn 时**删除 `ELECTRON_RUN_AS_NODE`**（`src/desktop-launch.js` 的 `helperEnv`）。
  设成空串会让 Electron abort，设成 `'0'` 仍是纯 Node 模式。
- 宿主注入 `DSH_ZOO_HOST_PID`；helper 每 2s `kill(pid,0)`，ESRCH 就自行退出。
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

- 悬停自己那只 → 弹层多一项「改名」→ `dsh-zoo:rename-open` → 主进程开一扇
  `rename.html` 小窗（360×168，无边框、置顶、`focusable: true`，贴在宠物上方，
  放不下就落到下方，再不行夹在工作区里）。
- 小窗 `ready` 后主进程发 `dsh-zoo:rename-init { name, maxLength }`；提交走
  `dsh-zoo:rename-submit`，主进程转成一条 `{type:'action', action:'rename', nickname}` 交给宿主。
- 宿主回的 `action-result` 按 action id 认领：成功就关窗，失败把 `notice` 发回小窗显示
  （`dsh-zoo:rename-result`），窗口不关、输入保留。
- 失焦、Esc、主窗 `hide`、helper 退出都会关掉小窗；10 秒等不到宿主答复就报一句人话。
- 主窗的穿透/租约状态**完全不受影响**：小窗是另一个 BrowserWindow，关掉它不会改动任何
  `ignoreState` / `busy`。

## 带派小窗（ticket 24）

背包是宿主的东西（`<dataDir>/backpack.json`），helper 只负责画与收输入；访客捎来的
礼物卡由场景 `controls.gifts` 下发（宿主管状态与文案），缩略图走
`dshzoo://gifts/<礼物目录>/<图片>`，与素材读路径同一套夹取规则。

- 右键自己那只 → 一级工具项「带派」→ 渲染端只发一个**空** `{action:'bring'}`；
  宿主开窗，并用 `bring-window` 把背包内容（id/kind/文案/state，**没有路径**）交给 helper。
- 小窗（`gift.html`，380×480，无边框、置顶、`focusable: true`）显示字条框（≤500，实时字数）、
  选文件按钮与背包列表；`out` 中的条目不可撤。
- 视觉与邻居面板同一套「奶油纸 + 粗墨线 + 贴纸投影」：窗口上沿一条和纸胶带、标题旁一个
  小包裹 mascot、右上角一枚按 kind 写「信 / 件」的小邮票。全部是内联 SVG / CSS，
  CSP 不需要放行 `img-src`，也没有任何网络请求；礼物卡同样用这套纸片样式。
- 文件选择只由主进程 `dialog.showOpenDialog` 完成；渲染端只看到名字/大小，提交时主进程
  还会核对「就是刚才选中的那个绝对路径」。
- 小窗桥只有 `ready / submit / cancel / remove / onInit / onResult` 六个原语，没有 Node 能力。
- 提交走 `{type:'action', action:'bring', gift}` 或 `{action:'unbring', giftId}`；宿主的
  `action-result` 按 action id 认领：`bring` 成功关窗，失败留在窗里显示 `notice`；
  `unbring` 成功后宿主再发一条 `bring-window {open:false}` 刷新列表，窗口不关。
- 只有这扇窗自己的 `webContents` 能发 `dsh-zoo:gift-*`（`isGiftSender`），与改名窗同一个模型。

## 农场小窗（ticket 40 / 43 / 44 / 46 / 47）

农场小窗和改名/带派同一种模型：**宿主算数据，helper 只画和收输入**。窗口是 `file://`
页面，没有 Node、没有网络、读不到 `/state`；地块、种子、作物、交易所、合同和访客快照
全部随 `farm-window` 命令下发，成功/失败走 `action-result`，窗口不自动关。

- **新外壳（ticket 47）**：奶白 `#FAF8F5` 底 + 祖母绿/琥珀/天空蓝，16–24px 圆角卡片、
  软阴影、胶囊、进度条、成熟轻微弹跳、细滚动条；系统字体 + emoji/内联 SVG，CSP 仍然
  是 `default-src 'none'`，不加载任何 CDN/远程字体/图标库。窗口仍是 420×560
  （`FARM_WIDTH` / `FARM_HEIGHT` 未改），内容区自己滚动。
  header 是「我的农场 / X/Y 已种植 / 🪙·💧 胶囊 / ×」，下面是 4 段页签、农场页专属的
  「一键种满 · 一键收割」行、可滚动内容区和常驻 footer（种子背包 / 收获仓库）。
- **雇工挂牌（ticket 44）**：`contracts.listings[]` 带 `expiresAt`——宿主按**本机收到行情**
  的时刻 + `peerLostMs` 算（默认 120 秒 = 4 个 30 秒广播），不是邻居的墙上时钟。
  窗口每秒自己比一次：到点把「可雇」变「行情过期」并收起雇佣控件，不用等下一次 push；
  `stale` 保留作老宿主兜底。
- **地块卡**：空地显示「＋ 种植」，整张卡点开播种底部弹窗；生长中显示倒计时、进度条和
  浇水/施肥；成熟轻微弹跳并给收获/施肥。动作 id 仍是 `farm-plant` / `farm-harvest` /
  `farm-water` / `farm-fertilize`，`plotId` / `cropId` 的窄口不变。
- **播种弹窗**：三种种子的库存、生长时长、产量；库存 0 禁用；「去交易所买种」只切页签，
  没有随机买种。批量：一键种满 = 按空地与种子库存逐块种下（种子用完即停）；一键收割 = 所有成熟
  地块按顺序逐条发 `farm-harvest`，busy 守卫 + 逐条 toast，不新增宿主动作。
- **不写死 4 块地**：`desktop/farm-view.js` 是纯视图模型（渲染页和 Node 测试共用），
  卡片、标题计数和 `plot.id` 标签都按 `farm.plots.length` / id 推；CSS 用
  `repeat(auto-fill, minmax(150px, 1fr))`。helper 的 `MAX_FARM_PLOTS` 是 50、`MIN_FARM_PLOTS`
  是 4；宿主开局发 4 块、最多 50 块，传 20 块的 `farm-window` 会画 20 张卡、标题显示 20（有测试）。
- 打开：右键菜单「农场」→ 渲染端只发一个 `farm-open`（不带 `plotId`）；宿主发
  `farm-window { open:true, mode:'owner'|'visitor', farm, market, contracts, plotId? }`。
  小窗开着时再点「农场」= 宿主发 `farm-window { open:false, close:true }` 关窗；
  宿主按 helper 回报的 `farm-window-state` / `desktop.status().farmOpen` 决定开还是关。
  桌面没有地块条，也没有 `controls.farm`（ticket 46）。
  正出门串门时同一扇窗进入访客模式，先推 `visit.state:'loading'`，拿到主人快照后变
  `ready`，404/结束变 `ended`；窗口保留最后一帧只读，不自动关。访客保留 banner、
  偷/帮卡与次数/守卫提示，隐藏一键种满/收割、播种弹窗与解锁卡。
- 页签：农场 / 交易所 / 雇工 / 记录。记录页自己滚动，最多 100 条；窗口顶部的「驮包」
  只显示偷来的作物与在途工资（宿主算好下发，窗口不记账）。
- 动作窄口：农场 `farm-plant` / `farm-harvest` / `farm-water` / `farm-fertilize`
  （只带 `plotId`，种地再带 `cropId`）；解锁 `farm-unlock`（只带可选的
  `expectedUnlocked`，4–50 的乐观锁，价格由宿主算）；交易所 `farm-buy-seed` /
  `farm-sell-crop`（只带 `cropId` + 1–99 的 `qty`，单价/总价由宿主算）；雇工 `hire` /
  `recall-worker` / `end-contract` / `hire-listing`；访客偷/帮 `farm-steal` / `farm-help`。
  `shared.normalizeFarmAction` 与 `main.js` 的 `farmPending` 双重防串 id；一次只能有
  一个在飞动作，宿主回 `action-result` 后窗口才解锁。
- 成功不关窗：种/收/买卖/挂牌/雇佣都只 toast 并刷新数据；失败留在窗里显示 `notice`。
  偷/帮由宿主等 UDP 结果（最多约 1.8 秒），窗口只发一次申请。
- 每块地、每份合同、每条日志都有二次校验：`shared.normalizeFarm` 只重建白名单字段，
  未知作物/坏阶段/坏价格/坏合同只丢自己，不把错误数据画进窗口。
- ×、Esc、主窗 `hide`、helper 退出都会关窗；失焦不关（macOS 中文输入法候选窗会触发
  blur，和改名/带派同一条取舍）。×/Esc 走窗口自己的 `dsh-zoo:farm-close` IPC，
  宿主只负责打开/刷新/显式 `close:true`。
- 冒烟：`DSH_ZOO_SMOKE_ONLY=farm DSH_ZOO_SMOKE_NOTES=1 npm run smoke:desktop` 会验
  右键「农场」开窗、再点关闭、×/Esc 关闭和雇工仍带「打工」角标；并截农场菜单、
  农场页、播种弹窗、一键收割、交易所页、雇工页、记录页和访客偷/帮视图，
  小窗截图笔记为 `.scratch/dsh-zoo/notes/47-*.png`。
  `debug-farm-tab` / `debug-farm-plant-open` / `debug-farm-plant-close` /
  `debug-farm-batch` / `debug-farm-close` 只用于这一步。

## 多显示器 / 分辨率

**一扇窗铺满所有显示器工作区的并集**，宠物可以在任意一块屏上被看见、被拖动、被点击。
为什么不是每屏一扇窗：跨屏拖动依赖指针捕获，而指针捕获不能跨窗口——光标一离开 A 窗，
`pointermove`/`pointerup` 就断了。单屏时并集就是那块屏的工作区，行为与以前完全一致。

- 宠物**出生在主屏**中央，不会骑在两块屏的接缝上（宿主按 `ready.displays` 里的 `primary`
  把主屏换算成窗口局部矩形，传给 `shared.petScene` 的 `homeArea`）；尺寸也按主屏算。
- 场景里的物理区域是整张并集：拖到任意一块屏、丢在任意位置都行。**走路有地面带**
  （场景里的 `floors` → `shared.walkBands()`）：底边相同且水平相邻的屏合成一条带，
  宠物可以来回走；高度不同的屏各自一条带，走到接缝就停住，不会掉进矮屏下方那块没有
  显示器的黑区（Windows 的“黑边”）。拖拽不受带限制，松手时 x、y 都夹回落点所在的带
  （`shared.confineBodyToBand()`），所以拖到黑区里松手也会回到脚下的那块屏。
- 屏幕之间有水平空洞（非矩形摆法）时，走路同样停在带边界；拖拽可以经过，
  松手按水平范围回到脚下那块屏。读取位置时不要假设“宠物一定在某个显示器里”。
- 插入/拔出/改分辨率会重算并集、重设窗口 bounds，再重发 `ready`，宿主重算场景（含 `floors`）。
  同一个 helper 的 `ready`（渲染端没重启）不会 `reset`：渲染端收到 `resize` 后用
  `shared.resizeBodies()` 把所有宠物夹回新的并集（不穿地、不出界、不清速度），再重报矩形。
- `/dsh-zoo/desktop` 的 `status.displays`、`helperStatus.floors` 与 `helperStatus.bounds`
  是排查多屏/混合 DPI 的三组数：先确认显示器列表本身是否连续，再看窗有没有铺对。
- 不同缩放比的屏并排时，Electron/Chromium 只能给一扇窗一个 device scale factor，
  非主屏那一侧可能略糊；坐标与点击判定仍按 DIP，不受影响。`enableLargerThanScreen: true`
  已经是构造参数，窗口可以大于单个屏幕。

## 已知限制

- `focusable: false`：没有键盘输入。所有控件（串门/召回/送客/改名/放行卡）都是鼠标点击，没有
  Tab/Enter/Esc；放行卡的“稍后再说”是一个 × 按钮。唯一的例外是 **改名小窗**、
  **带派小窗**与**农场小窗**（见上）。
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
