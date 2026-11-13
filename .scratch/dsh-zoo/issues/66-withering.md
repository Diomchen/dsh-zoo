# 66: 枯萎阶段与农场集成

**What to build:** 给地块加 `withered` 阶段：换季时未熟的四季作物枯萎，成熟的和旧六种不受影响；
枯萎地不能收/浇/肥，但可以直接重种。

**Blocked by:** 64

**Status:** ready-for-agent

## 规则

- `plot.withered = true`（可选字段；老存档没有 = false）
- `plotStage(plot)` 优先级：`withered` → `empty` → `mature` → `growing`
- `isMature(plot)` 对枯萎返回 false；`plotRemainingMs(plot)` 返回 0
- `advanceGrowth(plot, elapsedMs, factor = 1)`：`grownMs += elapsedMs * factor`；
  枯萎直接 return；成熟后不长
- 换季判定：当前季 ≠ `cropSeason(plot.crop)` 且未成熟 → 枯萎；旧六种永不枯萎
- `#settleLoad` / `#advance` 按 `seasonSegments(lastTickAt, now)` 分段生长；
  离线仍只补最近 12 小时，但换季枯萎按"最后一次 tick 的季"和"现在"比较，跨几天也能枯
- 每次换季最多写一条 `wither` 日志：`{ kind:'wither', qty, crop? }`；同一次合并
- 枯萎地 `harvest/water/fertilize` 返回 `{ ok:false, code:'withered' }`
- `plant` 允许覆盖枯萎地；不返还旧种子
- `batchHarvestTargets` / `batchPlantTargets` 跳过/包含枯萎地的口径由票 69 处理

## 文件

- [ ] `src/season-rules.js`：`cropSeason` / `seasonSegments`（票 63 已有）
- [ ] `src/farm-rules.js`：`advanceGrowth` 第三参、`plotStage`、`isMature`、`plotRemainingMs`
- [ ] `src/farm.js`：`#witherSeasonal(now)`、`#settleLoad`/`#advance` 分段、`#plant` 覆盖、
      `#harvest`/`#water`/`#fertilize` 拒绝、`LOG_KINDS` 加 `wither`
- [ ] `src/farm-text.js`：`withered` 文案
- [ ] `desktop/shared.js` 的 `FARM_STAGES` / `normalizeFarmPlot` 在票 71 接

## 验收

- [ ] 春天最后 10 分钟种豌豆，跨到夏天：豌豆枯萎，不能收；可以重种夏天的西瓜
- [ ] 春天种豌豆并留到成熟，跨到夏天：仍然可收，不枯萎
- [ ] 旧六种跨季不枯萎，生长时间不变
- [ ] 枯萎地浇水/施肥/收获都返回 `withered`
- [ ] 离线跨午夜：未熟四季作物枯萎；成熟保留；只补 12 小时生长
- [ ] `test/farm-season.test.js` 覆盖以上；`npm test` 全绿
