# 74: 四季来客与随机 3 小时窗口

**What to build:** 春·蛙雨、夏·野火、秋·熊獾、冬·巨鹿四位来客。蛙雨/野火在所属季节随机一个整分钟出现，熊獾/巨鹿固定在本地 15:00 出现；都持续 3 小时。窗口外不显示、不能结算，过期按"忽略"结算一次。提高破坏力并按 ADR-0022 的表格落地。

**Blocked by:** 67、68、70

**Status:** done

## 定义

- `src/season-omens.js`：`DEFS` 四位来客；`omenFor(seasonId)`、`omenForId(id)`；
  `omenWindowFor(season, meta)` 用 `${season.start}:${id}` 哈希到 `[start, end-3h]`；
  `freshOmen` 存 `day/season/id/start/end`；`normalizeOmen` 只认精确窗口；
  `omenView(omen, now)` 带 `active/remainingMs`；`resolveOmen` 返回
  `{ok,choice,success,loss:{crops,witherPlots,freezePlots,matureOnly},consume,reward}`，
  窗口外 `omen-inactive`。
- 数值：蛙雨守卫成功 45+3+1 豌豆种/失败枯萎 2；野火 55+4+1 西瓜种/失败烧 2 块成熟；
  熊獾 70+5+1 稻种/失败 5 作物；巨鹿 65+6+1 白萝卜种/失败冻 3 块。安抚代价见 README 表。
- `season.json.omen`：`{day,season,id,start,end,resolved,choice,result}`。
- `season-store.settle`：窗口结束或换日时只结算一次；同一天过期写
  `resolved:true, choice:null, result:{success:false,ignored:true}`，防止每 tick 重复扣。
- `service.seasonView` 只暴露 `active === true` 的 omen；`resolveFarmOmen` 支持
  `{crops,dew,coins}` 代价、作物/枯萎/冻住损失和回滚。
- 桌面 `shared.normalizeSeasonOmen` 校验通用 `choices/stakes`；`farm-view.omenCard`
  动态生成文案和禁用态；`farm.js` 只在 `active` 时画卡。

## 验收

- 四位来客在各自季节出现；同一季节重启/重开窗口，窗口起点不变。
- 窗口外 `season.omen === null`；强行结算返回 `omen-inactive`。
- 3 小时结束未处理只扣一次忽略损失，日志一条。
- `npm run check` 全绿；`test/season-omens`、`season-store`、`season-e2e` 覆盖。
