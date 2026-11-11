# 49: 地块解锁——农场窗与批量操作

**What to build:** 农场小窗只画已解锁的地块，末尾多一张「下一块」锁定卡（价格 + 解锁按钮），
头部显示 `x/50`；点锁定卡弹确认，列出接下来 5 块的价格。一键播种从「种 1 块」升级为
「种满」，交易所加「买满空地」的快捷数量。visitor 模式不显示解锁入口。

**Blocked by:** 48

**Status:** done

决策依据：[ADR-0017](../../../docs/adr/0017-plot-unlock-economics.md)。

- [x] `desktop/shared.js`：`MAX_FARM_PLOTS = 50`、`MAX_FARM_LOG = 200`、日志类型加 `unlock`；
      新 `FARM_LAND_ACTIONS = ['farm-unlock']` 进 `FARM_ACTIONS`；`normalizeFarmAction`
      接受可选 `expectedUnlocked`（整数 4–50）；visit 动作的 pN 上限放到 p50；
      `normalizeFarm` 透传 `unlocked`/`maxPlots`/`nextCost`
- [x] `desktop/main.js`：`farm-unlock` 走同一条 IPC 窄口；`expectedUnlocked` 原样带下去
- [x] `desktop/farm-view.js`：`headerStats` 增加 `x/50` 文案；`unlockCard(farm, {coins,busy})`
      返回锁定卡模型（nextCost、affordable、reserve 提示）；`batchPlantTargets(farm)`
      按空地与种子库存返回队列；导出保持同一份给测试
- [x] `desktop/farm.js`：渲染锁定卡 + 确认弹层（价格、余额、解锁后余额、接下来 5 块价格）；
      提交 `farm-unlock` 带 `expectedUnlocked`；成功 toast + 宿主推新视图；
      一键播种改成串行队列（种满），结束 toast「种了 x 块」；visitor 模式隐藏解锁入口
- [x] 交易所「买满空地」：数量快捷按钮 = 当前空地数（夹 1–99）
- [x] `desktop/farm.html`：锁定卡/确认弹层/头部 `x/50` 的样式；50 块网格可滚动
- [x] 测试：`farm-window.test.js` 渲染 50 块、锁定卡、确认、连点、visitor 隐藏；
      `farm-view` 单测覆盖地价档位与种满队列；真实 helper 窄口 50 块不被截；
      `npm test` + `npm run check` 全绿
- [x] 冒烟：farm-only 跑农场窗，锁定卡/地价/按钮可见，原有种/收/买卖/雇工/偷帮不回归；
      解锁弹层用真页面截图写 `.scratch/dsh-zoo/notes/49-*.png`
- [ ] 后续：真 Electron 的「解锁下一块 → 种满 → 买满 → 收割」全流程冒烟
      （未做；点击与动作路径由 headless 页面截图 + service 集成测试覆盖）

> 不做：拖动排序、地块装饰、批量施肥、按地块命名。

> 完成情况：农场窗末尾一张「下一块」锁定卡（徽标带地价，按钮直达确认弹层）；
> 头部 `x/50 · 下一块 N`；确认弹层列出接下来 5 块价格；`farm-unlock` 经 helper 窄口
> 带 `expectedUnlocked`；一键播种升级为「种满」（串行队列）；交易所每行「买满」；
> 记录页 100 条。visitor 模式隐藏锁定卡与解锁入口。
> 冒烟：`DSH_ZOO_SMOKE_ONLY=farm` 48 项断言通过，含「锁定卡存在 + 徽标带地价 60」的
> 真实 DOM 断言；截图里能看到锁定卡/地价/按钮；
> 解锁弹层用真页面（Chrome headless）验过：`notes/49-farm-unlock-modal.png`；
> 新增 `farm-view` 锁定卡/种满/50 块单测与静态窄口检查。
> review 修复（ticket 49）：买不起时锁定卡按钮仍可点开确认层（确认键禁用），弹层始终显示
> 解锁后余额；smoke 增加「锁定卡存在 + 徽标带地价 60」的真实 DOM 断言（48 项）；
> `expectedUnlocked` / `unlocked` 的窗口区间收到 4–50；日志用 `plot` 记第几块地。
> 仍留后续：没有新增专门的 Electron「解锁→种满→买满→收割」全流程冒烟。
