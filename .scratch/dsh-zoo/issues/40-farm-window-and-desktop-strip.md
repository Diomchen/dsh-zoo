# 40: 农场小窗与桌面地块

**What to build:** 右键宠物 →「农场」打开一扇 focusable 小窗；桌面宠物旁出现 4 块看得见的地；窗里能种/收/浇/施肥，桌面地块跟着变。

**Blocked by:** 39

**Status:** done

决策依据：[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)、[SPEC v5](../SPEC-v5.md)。
桌面接线细节见 `/Users/gensean/sean_project/test/dsh-zoo-farm-t40-notes.md`（本地勘察笔记，含 file:line）。

- [x] 菜单工具项「农场」**三处 + 第四处**：`src/menu.js` 的标签与 `menuTools`、
      `desktop/shared.js` 的 `MENU_TOOL_IDS`，以及 `desktop/renderer.js` 的
      `runMenuTool`——少了第四处，菜单项会渲染但点了没反应；同时改 6 处硬编码菜单断言
- [x] 动作白名单：`farm-open`（可带 `plotId`）进 `MENU_ACTION_IDS`；
      `farm-plant` / `farm-harvest` / `farm-water` / `farm-fertilize` 进
      `CONTROL_ACTIONS` / 新的 `FARM_ACTIONS` / `DESKTOP_ACTIONS`；少一处
      `requestAction` 静默返回
- [x] 新 focusable 小窗 `desktop/farm.html` + `farm.js` + `farm-preload.js`（仿
      `gift.*` 的 host-driven 窗，不是 `rename.*`）：无边框透明、**不按失焦关闭**
      （macOS 中文输入法会打断，和 gift/rename 的 IME 取舍一致）、显式关闭 + 10s 超时；
      桥只暴露 `ready / submit / close / onState / onResult`
- [x] 窗口数据与场景分开：宿主用 `farm-window` 命令推**完整** farm view
      （`plots` 带 `remainingMs`（从 `grownMs`/`growMs` 用 `src/farm-rules.js` 的
      `plotStage`/`plotRemainingMs` 推）、`seeds` / `crops` / `coins` / `dew` / `log`）；
      `controls.farm` 只拿摘要 `{ plots: [{id,crop,stage,mature}], coins, dew, worker,
      contractCount }`——不要把 `/state.farm` 直接塞进场景
- [x] `src/desktop-pets.js` 的 `controls.farm` 从 service 的 `desktopSnapshot()` 来
      （`stateView` 和 droppedVisitors 后那次 re-snapshot 两处都要喂）；room 保持纯；
      `desktop/shared.js` 的 `emptyControls` / `normalizeControls` / 动作白名单、
      `desktop/renderer.js` 的 `uiRects` / `requestAction` 四处都放行
- [x] `plotId` / `cropId` 过 `handleDesktopAction` / `preload` / `main.js` IPC /
      `shared.normalizeHelperEvent` / 窗的 `normalizeFarmAction`——六道窄口，少一处就是
      `bad-plot` 且没有线索
- [x] 渲染端：宠物旁 4 块小地（emoji/SVG，成熟角标），点地块/「农场」开窗；
      地块条和按钮进 `overlay-rects`；`ui.farm` 必须进每帧刷新条件，否则 900ms 后
      看得见点不着；没有桌面层时只保留 HTTP
- [x] helper 命令 `farm-window`（`{open, farm, plotId}`）：`desktop.js` 的 `farmWindow`
      + `main.js` 的 `applyCommand` case；`isFarmSender` 只认这扇窗；
      `action-result` 成功**不关窗**、只 toast；`update` 命令要补推 `farm-window` 状态
- [x] `package.json` 的 `check` 加 `desktop/farm.js` / `farm-preload.js`；
      `shot` / `debug-blur` 的窗口枚举加 `farm`，否则冒烟截不到
- [x] 真机冒烟：截图里能看到 4 块地、种下后阶段变化、点开小窗；`npm test` 全绿
- [x] 不做：交易所/偷菜/雇工（41/43/44）

> 完成情况：`desktop/farm.*`（host-driven、显式关闭、不按失焦关）、菜单 3+1 处、
> `farm-open` + 四个 `farm-*` 动作、`controls.farm` 摘要与 `farm-window` 全量视图分流、
> 桌面 4 块地与 `ui.farm` 每帧刷新、`src/farm-text.js` 统一错误文案。
> 合并后 `npm test` 596/596（39 的露水补丁 + 40 的 9 条新测试）；`npm run check` 同。
> 冒烟：farm-only 26 条反复通过；全量 457 条通过一次，后续重跑遇到的是既有的
> rename focus / street panel 时序 flake（外部 helper 共用 Electron profile），与农场无关。
> 偏离：按指示不做失焦关闭；加了 `src/farm-text.js` 与只在 smoke 用的
> `debug-farm-submit`。
> 留给 44：地块条在宠物出门/打工时的文案目前是反的（away 显示「看家中」），
> 44 用 `owner.presence`（home/visiting/working）一并修。
> 提交：`5f26919`。
