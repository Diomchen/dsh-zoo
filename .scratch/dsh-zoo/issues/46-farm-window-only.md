# 46: 农场只在小窗里——删掉桌面地块条

**What to build:** 农场不再在桌面上常驻一块 4 格地。桌面只留宠物（含雇工宠物）；农场从右键
「农场」唤醒，再点一次关闭；小窗保留 × 和 Esc。农场数据、交易所/雇工/记录页签、
`GET /state` 与 `farm-window` 协议都不变。

**Blocked by:** None（40/44/45 的后续修正）

**Status:** ready-for-agent

决策依据：[SPEC v5](../SPEC-v5.md)、[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)。
拍板：**雇工宠物保留在桌面**（它是宠物，不是农场）；只删地块条和 `controls.farm` 摘要。

- [ ] 渲染端删掉桌面地块条：`ui.farm`、`buildFarmStrip` / `buildFarmPlot` /
      `updateFarmPlot` / `syncFarm` / `syncFarmStatus` / `hideFarm`、`FARM_CROP_META`、
      `ui:farm-strip` / `ui:farm:p*` / `ui:farm-open` 命中矩形、每帧刷新条件、
      `desktop/index.html` 的 `.lp-farm-*` CSS；其余点击穿透不变
- [ ] `src/desktop-pets.js` 删掉 `controls.farm` / `farmFromSnapshot` /
      `normalizeFarmSummary` 的引用；`desktop/shared.js` 的 `emptyControls` /
      `normalizeControls` 不再带 `farm`（`normalizeFarmWindow` 保留，窗口还要用）
- [ ] `src/service.js` 的 `syncDesktop` 回到 `room.snapshot()`；`desktopSnapshot()` /
      `farmStateView()` 只保留 `/state.farm` 所需；`/state` 的 farm/market/contracts 不变
- [ ] 唤醒/关闭：右键「农场」发 `farm-open`；宿主若 `desktop.status().farmOpen === true`
      就发 `farm-window {open:false}` 关闭，否则打开/聚焦；新增 `farm-close` 动作给脚本；
      小窗 × / Esc 继续关闭（helper 已有，不用改）；菜单文案仍叫「农场」
- [ ] 雇工宠物：继续由 `petsFromSnapshot` 以 `role:'worker'` 出现在桌面，带「打工」角标；
      不再依赖地块条位置；`controls.farm.owner.presence` 的「看家中/在外打工」角标删掉
      （它只服务地块条）
- [ ] SPEC v5：把「农场长在桌面上（一小块看得见的地）」「桌面地块条」改成
      「农场只在小窗里，从右键菜单唤醒/关闭」；`与 v4 的差别`、`桌面与小窗`、`降级`、
      `测试决定`、票表同步；40 的完成注记标一句「46 收掉地块条」
- [ ] README / `desktop/README.md` / `45-acceptance.md`：删掉「桌面 4 块地」，
      加「右键农场开/关、×/Esc、雇工仍是桌面宠物」；旧 45 截图带地块条，注明被 46 取代
- [ ] 测试：删/改 `desktop.test.js`、`desktop-pets.test.js` 的地块条/controls.farm 断言；
      `farm-window.test.js` 加「点农场开→再点关」「farm-close」「窗口 ×/Esc」；
      雇工 `role:'worker'` 仍出现在 pets；`npm test` + `npm run check` 全绿
- [ ] 冒烟：农场段去掉地块条断言，改成右键「农场」开窗→再点关闭→×/Esc 关闭→雇工角标
      仍在；新截图写 `.scratch/dsh-zoo/notes/46-*.png`；farm-only 绿
- [ ] 不做：删雇工宠物、改农场窗四个页签/数据、改协议/存储/限额、动交易所逻辑
