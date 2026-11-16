# 76: Windows 上左键到不了桌面宠物窗（票 30 现场复跑失败）

**What to build:** 把「Windows 上左键按下到底有没有进 helper 窗口」变成 HWND 层的可观测事实，
再按观测结果修掉「移到宠物上立刻按住拖，宠物完全不动」；冒烟补一条**冷到达**用例，不再用
200ms 等待把竞态盖住。

**Blocked by:** —

**Status:** done（代码 + 单测 + macOS 冒烟 2026-11-16；Windows 现场验收待那台机器回来，见「验收」最后一条）

来由：2026-11-16 现场（`DESKTOP-699DN63`，外接鼠标）。用户报「宠物无法拖动」，
症状是**左键按住完全不动、松手也没反应；左键单击宠物同样没反应；只有右键菜单能开**。
这不是票 30 的观测缺一项的问题——票 30 的最后一条「现场复跑」一直没做，这次复跑失败。

## 现场事实（2026-11-16）

- 只有 dsh-zoo 在画：`dualLayer=null`、`dshPet.reachable=false`、`sceneItems=1`，dsh-pet 已停用
  → 排除「两个透明层，拖到的不是看到的那只」。
- helper 窗口 exstyle = `0x08200008`（`WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_NOREDIRECTIONBITMAP`），
  **没有** `WS_EX_TRANSPARENT`、**没有** `WS_EX_LAYERED` → 采样时刻 OS 层面不是整窗穿透。
- 右键 → 自定义菜单能开（渲染端活着、DOM 事件到得了）；菜单项左键点「重载配置」→ helper pid 不变、
  宿主 `status.restarts` 仍 0 → 那次左键也没到。
- 拖拽期间 `helperStatus.busy=false`；`helperStatus.trustedInputs` 累计仍为 0，
  而 `lastTrustedInputAgeMs` 有一次约 29ms → **只收到 up、没收到 down**（口径见下）。
- 仓库四个桌面页都没有 `-webkit-app-region`（已 grep 确认），`.lp-pet` 是 `pointer-events:auto` 的普通 div。
- **同一天又自行恢复了**：没改代码、没重装，用户报「现在又突然可以了」。说明这是**可自行解除的粘滞
  输入态**，不是硬故障；恢复条件还没记录（helper 有没有重启、有没有发生过一次
  `ignoring: true → false` 的翻转、Chromium 有没有收到一次干净的 down+up 循环）。
  → 修法必须包含**自愈**，不能只赌「提前接管」。

> 不确定项（必须在下一步先钉死）：上面的 `trustedInputs` 采样是 agent 用注入输入做的，
> 还没和「真实鼠标按下」的对照数据对齐；helper 期间有没有重启也没记录（重启会把计数清零）。

## 已经排除的（2026-11-16 14:26 现场探针）

- `WindowFromPoint`（宠物中心，物理 912,912）：`ignoring=false` 时命中
  `hwnd=2624380 class=Chrome_RenderWidgetHostHWND`（helper 的渲染子窗）；
  `ignoring=true` 时同一坐标命中下层 DSH 的渲染子窗（`hwnd=855352`）。
  → **命中层级是对的**，不是「宠物被别的窗口盖住」。
- `WM_NCHITTEST` 取不到可信值：探针会话对桌面进程 `SendMessage` 全部 `err=5`（UIPI 拒绝，
  连任务栏都一样）→ `0` 是拦截产物，`HTCAPTION` 假设既不能证实也不能证伪。
  要这个数得用与 helper 同完整性级别的进程（Spy++ / AutoHotkey UIA 提权）来发。
- `helperStatus.debug = false`：helper 不是 debug 模式起的（宿主 `status.debug` 里只有三条
  「helper stdout 非 JSON 行」）。

## 为什么现在才暴露

`scripts/win32-sendinput.ps1` 在按下前会**先小幅移动刷新 hover 心跳、再 sleep 200ms**等主进程兜底接管
（见该脚本头注释第 3 条）。这个等待恰好把「冷到达」的竞态盖住了，所以 0.4.2 的 Windows 冒烟是
`trustedInputs 0→1`、`busy=true` 全绿，真人「移过去就按」却会丢 down。

## 已修（1.6.2）

- **原因**：`setIgnore()` 在 `ignoreState.ignoring === next` 时直接 return。一次
  `setIgnoreMouseEvents(false)` 没在 Windows 上落住之后，主进程内部状态停在「已可交互」，
  100ms 看门狗每拍都因状态没变跳过 —— 永不重试，只能等一次真正的 `true → false` 翻转
  （光标移开再回来）或 helper 重启。票 30 现场的「重载配置就好了」就是这条。
- **修法一（定时重放）**：`main.js` 的 `applyDecision()` 末尾按 `shared.shouldReassert()`
  （`INTERACTIVE_REASSERT_MS = 2000`）调 `reassertInteractive()`，把 `setIgnoreMouseEvents(false)`
  重新落一遍；穿透态不重放。语义不变，只是让 native 层重新落一遍。
- **修法二（丢 down 自愈）**：渲染端 `onTrustedPointer` 记 `pressSeen`；收到 `pointerup` 却没有
  对应 `pointerdown` 时上报 `{type:'lost-down'}`（新白名单项）。主进程 `healLostDown()` 立刻
  `setIgnore(true) → applyDecision()`（等价 `debug-kick-input` 的生产版），
  `LOST_DOWN_HEAL_COOLDOWN_MS = 1000` 冷却。
- **观测**：Windows 上 `win.hookWindowMessage` 数 `WM_LBUTTONDOWN/UP`、`WM_RBUTTONDOWN/UP`
  （`windowMessages`），加 `lostDowns` / `lastLostDownAgeMs` / `reasserts`；宿主
  `normalizeStatus` 白名单同步放行。`WM_NCHITTEST` 的返回值拿不到（钩子只读），所以不数它。
- **没有做的事**：没有外扩命中矩形（避免在宠物旁边多吞一块点击）；没有改 `-webkit-app-region`
  （仓库里本来就没有）。冒烟的「冷到达」用例仍待补（见 C），但 1.6.2 的自愈不依赖它。
- 回归：`test/desktop-input.test.js` 新增 5 条（`lost-down`、status 白名单、`shouldReassert`、
  冷却常量）；`npm run check` 809 项全过；`npm run smoke:desktop` 全量通过。

## 要做的

### A. 补 HWND 层观测（先做，不改行为）

- [x] `desktop/main.js`（仅 Windows）：`win.hookWindowMessage('WM_LBUTTONDOWN' | 'WM_LBUTTONUP' |
      'WM_RBUTTONDOWN' | 'WM_RBUTTONUP')` 计数，退出时 `unhookWindowMessage`（1.6.2）
- [x] ~~`WM_NCHITTEST` 另存最后返回值~~ → **做不到**：`hookWindowMessage` 只读，拿不到 WndProc 的返回值；
      现场改用 `WindowFromPoint` 对账（见上）。要这个数只能上 Spy++ 一类同完整性级别的工具。
      用来区分「窗口被当成标题栏」和「客户区正常」
- [x] 渲染端补 DOM 侧信号：`pointerdown`/`pointerup` 上报之外，加 `lost-down`（up 没有对应 down）（1.6.2）
      （**不要**只数 `isTrusted` 的 pointerdown，forward 模式下可能只有 mouse 事件），经 `dsh-zoo:input` 上报
- [x] `helperStatus` 出口加 `windowMessages { leftDown, leftUp, rightDown, rightUp }`、`lostDowns`、
      `lastLostDownAgeMs`、`reasserts`；`shared.normalizeStatus` 白名单同步放行（1.6.2）
- [x] 现场口径写进 README 排错表：**WM_LBUTTONDOWN 有 / pointerdown 无 = Chromium 或窗口层吞的；
      两个都没有 = OS 没把消息给这个窗口**（1.6.2）

### B. 按观测结果修（三条，按证据选）

- [~] 若 `WM_NCHITTEST` 返回 `HTCAPTION`：显式 `no-drag` —— **未做**：仓库四个桌面页本来就没有
      `app-region`，且 1.6.2 的自愈不依赖它；等现场拿到 `HTCAPTION` 证据再补
- [~] 若是「可交互翻转滞后于按下」：命中矩形外扩 —— **没做**，故意不做：外扩会在宠物旁边多吞一块
      点击，而且 1.6.2 的「定时重放 + 丢 down 自愈」已经覆盖这条竞态（自愈不依赖人把鼠标移开）
- [x] **丢 down 兜底 + 自愈**（1.6.2）：`setIgnore()` 有
      `if (ignoreState.ignoring === next) return` 的短路——一旦某次 `setIgnoreMouseEvents(false)`
      在 Windows 上没真正生效，主进程内部状态就停在「已可交互」，之后 100ms 看门狗每拍都因状态没变
      直接返回，**永不重试**，只能等一次真正的 `true → false` 翻转（光标移开再回来）或 helper 重启。
      修法：主进程声称可交互、但 `TRUSTED_DOWN_MISS`（如 1.5s）内一个 down 都没收到时，强制重放
      一次 `setIgnore(true) → applyDecision()`（`debug-kick-input` 的生产版），不重启 helper；
      同时通知渲染端 abort 掉可能卡住的 drag 状态

### C. 冒烟不再掩盖竞态

- [ ] `scripts/win32-sendinput.ps1` 增加 `-Mode cold`（或参数 `-NoHoverRefresh -PreDownDelayMs 0`）：
      光标直接到目标坐标、**0ms** 内 `LEFTDOWN`
- [ ] `scripts/desktop-smoke.mjs` 的 Windows 段新增断言：冷到达后 `windowMessages.leftDown` 与
      `domInput.pointerdown` 都 +1、`busy=true`、宠物位移 > 0
- [ ] 保留现有「先刷新 hover 再按」的用例作为对照（它验证的是另一条路径，不是这条）

## 验收

- [ ] Windows 现场连续 10 次「光标移到宠物 → 立刻按住拖」都跟手；每次 `trustedInputs` +1
- [ ] 左键单击宠物能开小面板（现在完全没反应）
- [ ] `npm run smoke:desktop` 的冷到达用例通过，且**故意回退 A 的观测**时该用例变红
- [x] macOS 不回归：`npm run check` 809 项全绿 + `npm run smoke:desktop` 全量通过（2026-11-16）
- [ ] 现场把 `/dsh-zoo/desktop` 的前后 JSON 存进 `notes/`，把「WM 有/无、DOM 有/无」写进结论文档

## 备注

- 票 30 的观测（`trustedInputs`）只在 DOM 侧，**缺 HWND 层**，所以 2026-11-04 那次只能停在
  「窗口说可交互、左键却没进来」的猜测上；这次补上 HWND 层才算把链路钉全。
- 现场那台机器的输入是 agent 注入的（`SetCursorPos` 曾出现移不动），真人对照数据要人做一次：
  「移到宠物→立刻按」和「停 1 秒再按」各 5 次，四个数（`windowMessages.leftDown`、
  `domInput.pointerdown`、`busy`、宠物位移）一起记。
