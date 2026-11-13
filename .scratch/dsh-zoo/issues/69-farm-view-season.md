# 69: 桌面纯视图模型：日历、节日卡、来客卡、枯萎卡

**What to build:** 在 `desktop/farm-view.js` 里把季节数据变成可直接渲染的纯数据；不碰 DOM，
不碰 IPC。窗口只负责画。

**Blocked by:** 63、64

**Status:** ready-for-agent

## 范围

- [ ] `BUILTIN_META` 加豌豆/西瓜/稻米/白萝卜（名字、emoji、`crops/<id>.svg`、价格、产量、生长）
- [ ] `fillMeta` / `setCrops` 保留每条的可选 `season`；没有 `season` 的条目视为中性
- [ ] `STAGE_TEXT` 加 `withered: '枯萎'`
- [ ] `seasonCalendar(season)` → `{ days:[{id,name,emoji,today,past,festival}], remainingText, warning }`；
      `warning` 在 `remainingMs <= 4h` 时为 true
- [ ] `eventCard(season, farm)` → `{ kind:'event', title, detail, progressText, percent,
      ready, claimed, rewardText, claimDisabled, reason }`
- [ ] `omenCard(season, farm)` → `{ kind:'omen', title, text, resolved, resultText,
      choices:[{ id,label,disabled,reason,chanceText }] }`；无来客返回 null
- [ ] `seedAvailability(cropId, seasonId)` → `{ buyable, plantable, reason }`；
      四季作物错季返回 `下季才有`
- [ ] `plotCards`：`withered` 地块 `badge:'枯萎'`、`detailText:'换季了，这株没来得及熟'`、
      `actions:[]`、`openPlant:true`、`progress:0`
- [ ] `batchPlantTargets(farm, seasonId)`：跳过错季的四季种子；不传 `seasonId` 时保持旧行为
- [ ] `batchHarvestTargets(farm)`：跳过 `withered`
- [ ] 导出新函数；旧函数签名不变

## 验收

- [ ] 四个季节各跑一遍 `seasonCalendar`，today 只有一格
- [ ] 节日进度 7/15 → `percent ≈ 46.7`；ready 时 `claimDisabled:false`
- [ ] 来客投喂且仓库只有 2 个作物 → `disabled:true`，reason 是"仓库不够 3 个"
- [ ] 枯萎卡没有收/浇/肥按钮，只有重种 CTA
- [ ] `test/farm-view.test.js` 或新的 `test/season-view.test.js` 全绿
