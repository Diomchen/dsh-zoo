# 07: 桌面窗骨架

**What to build:** 插件启动时拉起一个 Electron helper，在桌面最上层开一块透明、无边框、置顶的窗口，里面画一个占位方块；方块以外的地方点击全部穿透到桌面；DSH 退出、helper 崩溃、插件卸载时窗口都要消失，且不能留下一个吃掉所有点击的幽灵窗口。

**Blocked by:** 无（可以先做）

**Status:** done（2026-11-12 核实；实现在 v2 骨架里落地，这份票当时没回填）

- [x] helper 复用 `~/.dsh/electron/Electron.app`，找不到时降级为"不显示宠物"并只打一行日志
      —— `src/desktop-launch.js:88` `resolveElectronBinary()`（`electron-missing` / `unsupported-platform`），
      `:217` `fallbackReason()` 出那一行人话；Linux 直接判不支持。
- [x] 窗口全屏、透明、无边框、置顶、不进任务栏、不抢焦点
      —— `desktop/main.js:325-333`（`frame:false` / `transparent` / `alwaysOnTop` / `skipTaskbar` /
      `hasShadow:false` / `focusable:false`），多显示器工作区并集见 `setVisibleOnAllWorkspaces`（`:365`，ADR-0015）。
- [x] 默认点穿；光标进入占位方块时才临时接管鼠标，离开后恢复
      —— `desktop/main.js:660` `setIgnoreMouseEvents(next, { forward: true })`，
      命中判定在渲染端上报的矩形上；smoke 有"悬停接管 / 离开恢复 / 冻结 fail-closed"三段断言。
- [x] helper 与宿主通过 stdio 的 JSON 行通信，开一个端口都不新开
      —— `src/desktop.js` 的行协议 + `desktop/shared.js` 的 `MAX_LINE_LENGTH` 窄口；局域网端口是插件自己的 LAN 服务，不是 helper 开的。
- [x] 宿主退出/插件卸载/helper 崩溃 → 窗口都不残留；helper 崩溃后宿主不崩
      —— `desktop/main.js` 的 host-pid 看门狗 + `shutdown()`；`scripts/desktop-smoke.mjs` 覆盖 quit / 崩溃重启 / dispose / 宿主被 SIGKILL。
- [x] 非桌面环境（web profile）下自动跳过，不报错
      —— `src/service.js` 只在下发 `desktopHost` 时起 helper（ticket 05/ADR-0005），否则整层不出现。

> 占位方块本身由票 08 换成真宠物；本票只负责"壳"。
