# 68: 宿主季节 API、动作与午夜结算

**What to build:** 把季节接进 `src/service.js`：`/state` 和农场窗口带 `season`；新增
`farm-event-claim` / `farm-omen-resolve`；种/收/卖/浇成功后计数；本地 00:00 结算枯萎和来客。

**Blocked by:** 65、67

**Status:** ready-for-agent

## 范围

- [ ] 启动时创建 `createSeasonStore(dataDir, { now: farmClock, log })`；目录不存在就建
- [ ] `seasonView(now)`：返回 SPEC v8 的形状；`calendar` 来自 `calendarFor`；
      `event.progress` 取当前计数；`omen.choices[].chance` 用 `farmGuard().guard`；
      `omen.choices[].disabled` 按仓库作物数 < 3
- [ ] `farmWindowPayload` 顶层加 `season: seasonView(now)`
- [ ] `/state` 顶层加 `season: seasonView(now)`
- [ ] `handleAction` 新增：
  - `farm-event-claim`：`season.claim(now)`；成功则 `farm.addCoins(reward.coins)`、
    `farm.addDew(reward.dew)`、`farm.noteSeason('event', ...)`、`refreshFarmWindow()`
  - `farm-omen-resolve`：校验 `choice` 与 `expectedStart`；`season.resolveOmen(...)`；
    按结果发奖励/扣作物；写 `omen` 日志；`refreshFarmWindow()`
- [ ] 计数（只在成功后）：
  - `farm-plant` → `season.note('plant', 1, now)`
  - `farm-harvest` → `season.note('harvest', qty, now)`
  - `farm-sell-crop` → `season.note('sell', qty, now)`
  - `farm-water` → `season.note('water', 1, now)`
- [ ] 午夜结算 `settleSeason(now)`：
  - `season.settle(now)` 返回 `{ unresolvedOmen }` 时，`farm.takeCrops(1)`、
    `farm.noteSeason('omen', ...)`、标记已解决
  - 换季时写一条 `season` 日志（"秋天到了"），并刷新窗口
  - 由 60 秒 `farm` tick 调用；`/state` 读之前也调用一次，避免窗口开着不刷新
- [ ] `farmRandom` 注入：service 已有随机源就用它；没有就用 `Math.random`；测试可固定
- [ ] 错误码映射到 `farm-text.js`：`out-of-season`、`withered`、`event-not-ready`、
      `event-claimed`、`stale-season`、`omen-resolved`、`not-enough-crops`、`bad-choice`
- [ ] 不修改 LAN 协议；不做邻居节日/来客同步

## 验收

- [ ] 春天种 8 块 → 播种节 ready；`farm-event-claim` 后硬币 +30、露水 +3，再领报错
- [ ] 秋天收 15 个 → 丰收祭 ready；跨午夜未领 → 作废，新节日进度归零
- [ ] 秋·熊獾守夜成功/失败、投喂、重复结算、`expectedStart` 过期各一条 e2e
- [ ] 窗口开着跨午夜：`onState` 收到新 `season`，枯萎地块/新节日/新来客立即出现
- [ ] `/state` 和 `farm-window` 都有 `season`；访客/看田窗没有来客卡
- [ ] `npm test` 全绿；没有网络用例被新增
