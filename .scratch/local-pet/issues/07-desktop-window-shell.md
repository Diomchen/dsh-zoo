# 07: 桌面窗骨架

**What to build:** 插件启动时拉起一个 Electron helper，在桌面最上层开一块透明、无边框、置顶的窗口，里面画一个占位方块；方块以外的地方点击全部穿透到桌面；DSH 退出、helper 崩溃、插件卸载时窗口都要消失，且不能留下一个吃掉所有点击的幽灵窗口。

**Blocked by:** 无（可以先做）

**Status:** ready-for-agent

- [ ] helper 复用 `~/.dsh/electron/Electron.app`，找不到时降级为"不显示宠物"并只打一行日志
- [ ] 窗口全屏、透明、无边框、置顶、不进任务栏、不抢焦点
- [ ] 默认点穿；光标进入占位方块时才临时接管鼠标，离开后恢复
- [ ] helper 与宿主通过 stdio 的 JSON 行通信，开一个端口都不新开
- [ ] 宿主退出/插件卸载/helper 崩溃 → 窗口都不残留；helper 崩溃后宿主不崩
- [ ] 非桌面环境（web profile）下自动跳过，不报错
