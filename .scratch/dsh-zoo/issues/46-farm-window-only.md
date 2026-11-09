# 46: 农场只在小窗里——删掉桌面地块条

**What to build:** 农场不再在桌面上常驻一块 4 格地。桌面只留宠物（含雇工宠物）；农场从右键
「农场」唤醒，再点一次关闭；小窗保留 × 和 Esc。农场数据、交易所/雇工/记录页签、
`GET /state` 与 `farm-window` 协议都不变。

**Blocked by:** None（40/44/45 的后续修正）

**Status:** done

决策依据：[SPEC v5](../SPEC-v5.md)、[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)。
拍板：**雇工宠物保留在桌面**（它是宠物，不是农场）；只删地块条和 `controls.farm` 摘要。

- [x] 渲染端删掉桌面地块条：`ui.farm`、`buildFarmStrip` / `buildFarmPlot` /
      `updateFarmPlot` / `syncFarm` / `syncFarmStatus` / `hideFarm`、`FARM_CROP_META`、
      `ui:farm-strip` / `ui:farm:p*` / `ui:farm-open` 命中矩形、每帧刷新条件、
      `desktop/index.html` 的 `.lp-farm-*` CSS；其余点击穿透不变
- [x] `src/desktop-pets.js` 删掉 `controls.farm` / `farmFromSnapshot` /
      `normalizeFarmSummary` 的引用；`desktop/shared.js` 的 `emptyControls` /
      `normalizeControls` 不再带 `farm`（`normalizeFarmWindow` 保留，窗口还要用）
- [x] `src/service.js` 的 `syncDesktop` 回到 `room.snapshot()`；`desktopSnapshot()` /
      `farmStateView()` 只保留 `/state.farm` 所需；`/state` 的 farm/market/contracts 不变
- [x] 唤醒/关闭：右键「农场」发 `farm-open`；宿主若 `desktop.status().farmOpen === true`
      就发 `farm-window {open:false}` 关闭，否则打开/聚焦；新增 `farm-close` 动作给脚本；
      小窗 × / Esc 继续关闭（helper 已有，不用改）；菜单文案仍叫「农场」
- [x] 雇工宠物：继续由 `petsFromSnapshot` 以 `role:'worker'` 出现在桌面，带「打工」角标；
      不再依赖地块条位置；`controls.farm.owner.presence` 的「看家中/在外打工」角标删掉
      （它只服务地块条）
- [x] SPEC v5：把「农场长在桌面上（一小块看得见的地）」「桌面地块条」改成
      「农场只在小窗里，从右键菜单唤醒/关闭」；`与 v4 的差别`、`桌面与小窗`、`降级`、
      `测试决定`、票表同步；40 的完成注记标一句「46 收掉地块条」
- [x] README / `desktop/README.md` / `45-acceptance.md`：删掉「桌面 4 块地」，
      加「右键农场开/关、×/Esc、雇工仍是桌面宠物」；旧 45 截图带地块条，注明被 46 取代
- [x] 测试：删/改 `desktop.test.js`、`desktop-pets.test.js` 的地块条/controls.farm 断言；
      `farm-window.test.js` 加「点农场开→再点关」「farm-close」「窗口 ×/Esc」；
      雇工 `role:'worker'` 仍出现在 pets；`npm test` + `npm run check` 全绿
- [x] 冒烟：农场段去掉地块条断言，改成右键「农场」开窗→再点关闭→×/Esc 关闭→雇工角标
      仍在；新截图写 `.scratch/dsh-zoo/notes/46-*.png`；farm-only 绿
- [x] 不做：删雇工宠物、改农场窗四个页签/数据、改协议/存储/限额、动交易所逻辑

> 完成情况：桌面地块条端到端删除（`ui.farm` / `FARM_CROP_META` / 六个构建/同步函数 /
> `ui:farm-*` 矩形 / 每帧刷新 / `.lp-farm-*` CSS）；`controls.farm`、`farmFromSnapshot`、
> `normalizeFarmSummary`、`owner.presence` 一并删除；`syncDesktop` 回到 `room.snapshot()`，
> `/state` 仍带 `farm`。右键「农场」按 `desktop.status().farmOpen` 开/关；新增
> `farm-close`（HTTP/脚本）与 helper → 宿主 `farm-window-state`；×/Esc 路径未改。
> 雇工宠物继续由 `petsFromSnapshot` 以 `role:'worker'` + `work` 角标出现在桌面。
> `npm test` 744/744、`npm run check` 744/744；farm-only 冒烟 33 项断言通过，
> menu-only 冒烟 43 项通过；`46-*` 截图已落盘。提交见 `git log -1`。
