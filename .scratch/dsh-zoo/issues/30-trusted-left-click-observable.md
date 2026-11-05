# 30: 真实左键的到达要可观测（+ Windows 真实输入回归）

**What to build:** 把「真实左键到底有没有送进渲染端」变成一个能看的数字，并补一条 Windows-only 的
真实 `SendInput` 冒烟。根因（Windows 输入层/点击穿透状态卡住）留给现场复现时用这些数字收。

**Blocked by:** —

**Status:** done

来由：2026-11-04 Windows 现场。宠物可见但拖不动：helper 状态 `ignoring=false`、`rendererRects` 新鲜、
右键能开菜单（`overlayRects` 0→2）；真实左键按下 `busy` 始终 false。直接
`PostMessage(WM_LBUTTONDOWN)` 给 `Chrome_RenderWidgetHostHWND`、或干净重启 helper 之后用
`SendInput`，都能 `busy=true`。也就是说拖拽链路（`pointerdown → startDrag → 租约`）是好的，
卡的是窗口「自称可交互、左键却没进来」。

现有 `status` 里没有这个信息：`ignoring=false` 只说明我们把 `WS_EX_TRANSPARENT` 摘了，
`busy=false` 只说明租约没立起来——两者之间没有任何东西能证明「点击真的到过渲染端」。

- [x] 渲染端只对 `isTrusted` 的 pointerdown / pointerup 计数，经 `dsh-zoo:input` 报给主进程
      （preload 原样转交；形状在 `shared.normalizeInputReport` 收一次）
- [x] `status` 暴露 `trustedInputs`（次数）与 `lastTrustedInputAgeMs`；宿主 `normalizeStatus`
      也放行这两个字段（ticket 28 的教训：白名单会一层层削）
- [x] `debug-kick-input`：重放一次 `setIgnoreMouseEvents(true → false)`，冒烟断言踢完窗口仍然可交互、
      命中矩形还在。**只有 debug 模式认这条命令**——它是冒烟/联调用的诊断工具，不是用户功能；
      用户侧的恢复路径还是右键「重载配置」（重启 helper，不占崩溃退避）
- [x] Windows-only 冒烟：PowerShell 的 `SetCursorPos + mouse_event` 真按下 + 移动 + 松开，断言
      `hover` → `busy=true` → 宠物位移 → 松手后租约释放；非 Windows 打印一行跳过
- [x] macOS 上已有断言不回归：`npm run check`（481 条）+ 全量冒烟
- [ ] 现场复跑：Windows 上 `DSH_ZOO_SMOKE_ONLY=helper npm run smoke:desktop` 必须包含
      SendInput 那几条断言并通过；bug 复发时把 `trustedInputs` 的变化带回来

> 现场复现时怎么用：打开 `/dsh-zoo/desktop`，一边在宠物上按左键一边刷新。
> `trustedInputs` 不动 = 左键确实没到渲染端（窗口/输入层的问题）；动了而 `busy` 不立 =
> 渲染端逻辑的问题。用户侧先右键「重载配置」（重启 helper）；把 `trustedInputs`、
> `lastTrustedInputAgeMs`、`ignoring`、`busy` 四个数一起带回来。
