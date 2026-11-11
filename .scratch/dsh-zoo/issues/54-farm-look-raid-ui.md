# 54: 界面与验收——看看农场、派它去偷、偷菜角标

**What to build:** 把 52/53 接上桌面：邻居菜单多两项，农场小窗多一个只读的 `look` 模式，
偷客带「偷菜」角标出现在主人桌面。老版本邻居的入口要禁用并说明原因。

**Blocked by:** 52, 53

**Status:** done

决策依据：[ADR-0018](../../../docs/adr/0018-farm-open-to-lan.md)、[SPEC v7](../SPEC-v7.md)「界面」。

- [x] `desktop/shared.js`：`FARM_ACTIONS` 加 `farm-look` / `farm-raid`（窄口校验：
      `deviceId` 是 UUID、`plots` 是 ≤50 个 `pN` 或省略）；`normalizeFarmWindow` 认
      `mode: 'look'` 与 `look: { view }`；`PET_BADGES` 加 `steal`
- [x] `desktop/main.js` + `desktop/farm-preload.js`：两个动作走同一条 IPC 窄口
- [x] `desktop/farm-view.js`：`lookCards(farm, { view, busy })` —— 只读地块卡（作物/阶段/倒计时，
      没有种/收/浇/肥/解锁）、头部「「小黄」的农场 · 守卫 30% · 这趟最多 3 块」、底部按钮
      「派它去偷」；`stolenByMe` 的地块画成"已经拿过"
- [x] `desktop/farm.js` + `desktop/farm.html`：`mode === 'look'` 走只读渲染；按钮提交
      `farm-raid`；成功 toast「派「小蓝」去「小黄」家偷了 2 个」；`look` 模式隐藏所有 owner 入口
- [x] 邻居小街 / 右键邻居宠物：菜单加「看看农场」「派它去偷」；邻居 `caps` 缺 `look`/`raid`
      时禁用 + 文案「对方版本太老」
- [x] 偷客渲染四层：`PET_ROLES`/`normalizeScene`/`petScene`/`normalizeItem`/`renderer`——
      `role:'visitor'` + `kind:'raid'` + `badge:'steal'`，复用访客素材；能送客
- [x] `scripts/two-pets.mjs`：`look`（打印对方公开视图摘要）与 `raid <p1 p2…>`（派 A 去偷 B，
      打印回执）两条命令；`--lucky` 同样作用于守卫
- [x] 文档：README「单机验收」补两行；`notes/1.3.0-windows-test-plan.md` 新增「远程看田 / 派它去偷」
      一节（含"不放行也能偷"的验收步骤）；`CONTEXT.md` 已在本票前同步
- [x] 冒烟：`npm run smoke:desktop` 增加 `look` 模式截图（只读窗 + 按钮）与偷客角标特写，
      写进 `notes/54-*.png`
- [x] `npm test` + `npm run check` 全绿；`two-pets --lucky` 手工走一遍 `look → raid → 回家`

> 不做：偷客专属动画、偷菜特效、邻居列表排序调整。

---

## 进度（2026-11-11）

已完成：窄口的三个文件（`shared.js` / `farm-preload.js` / `service.handleDesktopAction`）、
`mode:'look'` 的只读窗（只画地块 + 一条「派它去偷」、页签整块藏起、标题与横幅换成对方的名字）、
`normalizeFarmLook` 白名单、`PET_BADGES` 加 `steal`、`two-pets` 的 `look`/`raid` 两条命令、
README 与测试计划的 §7.2。测试：`test/farm-look-window.test.js` 三条 + `desktop-work` 的角标断言。
`npm run check` 796/796。

**还没做（下一轮）**：

- [x] 邻居小街 / 右键邻居的两项菜单「看看农场」「派它去偷」——现在只能走 `two-pets` 或 HTTP。
- [x] 邻居 `caps` 的保存与「对方版本太老」的禁用文案：`caps` 目前只在报文里，宿主没有存下来。
- [x] 偷客的四层渲染：`PET_BADGES` 已经有 `steal`，但 `desktop-pets.js` 还没把
      `kind:'raid'` 映射成角标（窗口里那条 `kind` 已经能看到了）。
- [x] `smoke:desktop` 的 look 模式截图（`notes/54-*.png`）。

> 完成情况：窄口三处（`shared.js` / `farm-preload.js` / `service.handleDesktopAction`）、
> `mode:'look'` 只读窗（无页签、无单块按钮、底部「派它去偷」）、`PET_BADGES` 加 `steal`
> 并在 `desktop-pets.js` 里把 `kind:'raid'` 映射成角标、`caps` 进邻居表并让 `farm-look`/`farm-raid`
> 对老版本回 `old-neighbor`（`farm-text.js` 有对应人话）、`two-pets` 的 `look`/`raid`、
> README 与测试计划 §7.2、冒烟截图 `notes/54-farm-look-composited.png`。
> 798/798（`npm test` 与 `npm run check`）；farm-only 冒烟 100% 通过。
>
> 两处偏离：
> 1. 「菜单两项」落成**右键邻居房子 = 看田**，**看田窗底部 = 派它去偷**——没有另做一层
>    弹出菜单：街道那一格本来只有一个手势，右键是空的现成入口，再叠一层菜单反而要重画交互。
> 2. 老版本邻居不是"按钮禁用"，而是**点了会明确告诉你**「对方的版本太老」：街道 UI 目前
>    拿不到邻居的 `caps`（只有 `/state.neighbors` 有），预禁用要等街道数据带上它。
>
> 彩蛋：`farm-look` 现在会顺手把窗切到 look 模式——所以右键房子是一步到位，不用先开窗。

