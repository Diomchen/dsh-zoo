# 40: 农场小窗与桌面地块

**What to build:** 右键宠物 →「农场」打开一扇 focusable 小窗；桌面宠物旁出现 4 块看得见的地；窗里能种/收/浇/施肥，桌面地块跟着变。

**Blocked by:** 39

**Status:** ready-for-agent

决策依据：[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)、[SPEC v5](../SPEC-v5.md)。

- [ ] 菜单工具项「农场」三处同改：`src/menu.js` 的标签与 `menuTools`、
      `desktop/shared.js` 的 `MENU_TOOL_IDS`——少一处就被当未知项丢掉
- [ ] 新 focusable 小窗 `desktop/farm.html` + `farm.js` + `farm-preload.js`（仿
      `rename.*` / `gift.*`）：无边框透明、`hadFocus` 后失焦关闭、10s 超时；
      桥只暴露 `ready / submit / close / onState / onResult`，不放 Node 能力
- [ ] 小窗「农场」页：4 块地、作物阶段、剩余时间、种子/作物/硬币/露水、浇水/施肥/收获/
      种；结果用 toast；页签壳先留「农场」，交易所/雇工/记录在 41/44 接
- [ ] `src/desktop-pets.js` 的 `controls.farm`：`{ plots: [{id,crop,stage,mature}],
      coins, dew, worker, contractCount }`；`desktop/shared.js` 的 `emptyControls` /
      `normalizeControls` / 动作白名单、`desktop/renderer.js` 的 `uiRects` /
      `requestAction` 四处都放行；`plotId` 过 `handleDesktopAction` / `preload` /
      `main.js` IPC / `shared` 归一化
- [ ] 渲染端：宠物旁 4 块小地（emoji/SVG，成熟角标），点地块/「农场」开窗；
      地块条和按钮进 `overlay-rects`，其余照旧穿透；没有桌面层时只保留 HTTP
- [ ] helper 命令 `farm-window`（开/刷新）与 `farm-open`；只认自己那扇窗的
      `event.sender`；窗外点击穿透
- [ ] 真机冒烟：截图里能看到 4 块地、种下后阶段变化、点开小窗；`npm test` 全绿
- [ ] 不做：交易所/偷菜/雇工（41/43/44）
