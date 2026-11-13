# 75: 冻住与解冻

**What to build:** 冬季巨鹿的失败/忽略改为冻住地块，而不是枯萎。冻住地块保留作物、停止生长，不能收/浇水/施肥/重种；主人花 2 露水 + 5 硬币解冻后可继续长。换季还没解冻则冻死成枯萎。同步提高四季来客的破坏力。

**Blocked by:** 74

**Status:** done

## 定义

- `src/farm-rules.js`：`THAW_COST={dew:2,coins:5}`；`plotStage` 优先级
  `frozen → withered → empty → mature → growing`；frozen 的 `isMature=false`、
  `plotRemainingMs=0`、`advanceGrowth` 跳过、`canWater/canFertilize/helpPlot` 拒绝、
  `harvestYield=0`。
- `src/farm.js`：`normalizePlot` 保留 `frozen/frozenAt`；`freezePlots(qty,{matureOnly})`
  选未冻/未枯的地块；`thaw(plotId)` 扣 2 露水 + 5 硬币，清除冻结，保留作物/进度；
  `#witherSeasonal` 在 `seasonAt(frozenAt) != current` 时把冻住转枯萎；
  `#plant/#harvest/#water/#fertilize` 对 frozen 返回 `frozen`；日志新增 `freeze`/`thaw`。
- `src/service.js`：`farm-thaw` 动作与 `thawFarmPlot`；`farmWindowView` 输出 `frozen`；
  `resolveFarmOmen`/`settleSeasonTick` 应用 `freezePlots`，无目标时回退 1 个作物。
- `desktop/shared.js`：`farm-thaw` 白名单、`FARM_STAGES` 加 frozen、日志类型、
  `normalizeFarmPlot` frozen、omen stakes `failFreeze`。
- `desktop/farm-view.js`：frozen 卡、`THAW_COST`、可负担性、`farm-thaw` 动作。
- `desktop/farm.html` / `farm.js`：冰蓝卡样式、`解冻` 按钮、frozen/not-frozen/thaw 文案。
- 冬季巨鹿失败冻 3 块、忽略冻 2 块；春季 2 枯萎、夏季 2 块成熟枯萎、秋季 5/2 作物。

## 验收

- 冻结后不能收/浇/肥/重种，生长进度停住；解冻后继续长。
- 解冻成功扣 2 露水 + 5 硬币；不足时按钮禁用/返回错误。
- 不处理跨季：冻住变枯萎，只能重种；不会重复扣。
- `test/season-frozen.test.js` 3 条 + `season-e2e` 冬季用例通过；`npm run check` 全绿。
