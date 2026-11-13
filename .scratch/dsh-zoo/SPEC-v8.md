# SPEC v8 · 四季与季候来客

> 承接 [ADR-0020](../../docs/adr/0020-season-clock.md)、[ADR-0021](../../docs/adr/0021-seasonal-crops-and-withering.md)、[ADR-0022](../../docs/adr/0022-seasonal-omen.md)。
> SPEC v5 / v6 / v7 的农场、地块、交易所、雇工、看田、偷菜全部保留；本文只**加**季节层，不改旧经济。

**Status:** done

## Problem Statement

农场现在没有时间感：一块地可以永远种同一种作物，今天和下周打开是同一幅画面。玩家收获的是
数字，不是"今年"。星露谷用季节换作物表、换种子店、换节日；饥荒用季节换压力、换来客。
dsh-zoo 两样都缺。

玩家要的是：**打开农场，先知道今天是什么季节；种下去的东西和季节有关；每天有一点可做的事件；
偶尔来一个不速之客，需要做一个选择。**

## Solution

**1 个本地自然日 = 1 个季节，4 天一轮：春 → 夏 → 秋 → 冬。** 换季发生在本地 00:00，
不看 DSH 启动时间。季节是**算出来的**，不写进存档。

在季节之上加三层：

1. **季相**：四季作物表、种子店轮换、季末枯萎。
2. **节日**：每天一个正向目标（种/收/卖/浇），完成后领硬币和露水。
3. **季候来客**：v1 只做秋·熊獾，四天来一次，一张卡，两个选择，立即结算。

不新增实时战斗、HP、倒计时 boss；来客复用现有的守卫、雇工、仓库和日志。

## User Stories

1. 作为农场主，我想打开窗口就知道今天是什么季节、离换季还有多久，以便安排种什么。
2. 作为农场主，我想在春天种豌豆、夏天种西瓜、秋天种稻、冬天种萝卜，以便每个季节都有当季作物。
3. 作为农场主，我不想因为出差两天回来发现老作物全死了，以便旧六种永远安全。
4. 作为农场主，我想在换季前看到"未熟四季作物会枯萎"的提醒，以便决定收还是赌。
5. 作为农场主，我想每天有一个小目标（种 8 块/收 15 个/卖 8 个/浇 5 次），以便有理由打开农场。
6. 作为农场主，我想在秋天遇到熊獾时选择守夜或投喂，以便用现有守卫/仓库做一次有代价的决定。
7. 作为看田/串门的邻居，我不该被别人的季节事件打扰，也不该看到别人的来客卡。
8. 作为老存档，我不该因为升级而丢地、丢作物、丢硬币；没有 `season.json` 也能正常打开。

## Implementation Decisions

### 季节时钟

- `SEASON_ORDER = ['spring','summer','autumn','winter']`；元数据：
  - `spring` 春 🌱；`summer` 夏 ☀️；`autumn` 秋 🍂；`winter` 冬 ❄️。
- `SEASON_ANCHOR = '2026-10-26'`（本地日，春的第一天）。2026-11-13 = 秋，11-14 = 冬，
  11-15 = 春，11-16 = 夏，11-17 = 秋。
- `seasonAt(now)` 用**本地 00:00** 切日：`start` = 当天 00:00，`end` = 次日 00:00，
  `remainingMs = end - now`。返回 `{id,name,emoji,start,end,remainingMs}`。
- 不存 `day` / `daysLeft`；UI 显示"今日 · 距入冬 8 小时 12 分"。
- `seasonSegments(from,to)` 把任意区间切成 `[{season,start,end,ms}]`，用于离线生长；
  跨午夜时按段计算，不把整段都算成旧季。
- `cropSeason(cropId)` 只对四种四季作物返回季节 id，其余返回 `null`。
- `seasonGrowthFactor(cropId, seasonId)`：当季四季作物 `1.1`，其余 `1`。

### 四季作物

`BUILTIN_CROPS` 增加四种；旧六种数值一字不改：

| id | 名字 | 季 | 生长 | 种子 | 产量 | 基价 |
|---|---|---|---|---|---|---|
| `pea` | 豌豆 | 春 | 25 分钟 | 6 | 3 | 4 |
| `watermelon` | 西瓜 | 夏 | 6 小时 | 30 | 8 | 10 |
| `rice` | 稻米 | 秋 | 3 小时 | 18 | 10 | 4 |
| `radish` | 白萝卜 | 冬 | 90 分钟 | 10 | 6 | 4 |

- 四季作物**只能在自己季节种**；`farm-plant` 在错误季节返回 `out-of-season`。
- 当季生长 +10%；因为未熟会枯萎，v1 不再叠加"跨季 -10%"。
- 旧六种在任何季节都能种、都按原速度长、永不枯萎。
- 运行时作物目录（ADR-0019）新增的作物一律视为"中性"，没有季节限制；`cropSeason` 只认内置四种。
- `cropCatalogView` 给条目加可选 `season`，桌面用它显示"当季/下季"。

### 季末枯萎（方案 B）

- 新增阶段 `withered`（枯萎）；`plotStage` 的优先级：`withered` → `empty` → `mature` → `growing`。
- 换季时：**未成熟的四季作物枯萎；已成熟的四季作物保持可收；旧六种永远不枯萎。**
- 枯萎地块：
  - 不能收、不能浇、不能施肥；`harvest/water/fertilize` 返回 `withered`。
  - 可以 `farm-plant` 直接覆盖（旧作物消失，不返还种子）。
  - 不参与批量收获；批量种植可以把它当空地。
- `advanceGrowth` 跳过枯萎地块；`isMature` 对枯萎返回 false；`plotRemainingMs` 返回 0。
- 写一条 `wither` 日志，带枯萎数量和作物；同一次换季合并成一条，不刷屏。
- `farm.json` 不升版本；`withered` 是可选布尔字段，老存档没有 = false。

### 每日节日

| 季 | 节日 | 目标 | 奖励 |
|---|---|---|---|
| 春 | 播种节 | 种下 8 块 | 30 硬币 + 3 露水 |
| 夏 | 夜市 | 卖出 8 个作物 | 40 硬币 + 3 露水 |
| 秋 | 丰收祭 | 收获 15 个作物 | 50 硬币 + 4 露水 |
| 冬 | 围炉节 | 浇水 5 次 | 35 硬币 + 6 露水 |

- 节日全天有效，本地 00:00 结束；未领取就作废。
- 进度计数在**成功动作之后**：种 +1、收 +实际数量、卖 +实际数量、浇 +1。
- 领奖动作 `farm-event-claim`，带 `expectedStart`；不匹配返回 `stale-season`。
- 未完成返回 `event-not-ready`；已领返回 `event-claimed`。
- 奖励走 `farm.addCoins` / `farm.addDew`；不直接改存档字段。

### 季候来客：秋·熊獾

- 只在**秋天那一天**出现，每 4 天一轮一次；不是每天。
- 出现时写入 `season.json` 的 `omen`；主人窗口显示一张卡，访客/看田模式不显示。
- 两个选择：
  1. **守夜**（`guard`）：成功率 = 当前守卫（主人 0.3 + 雇工 0.5，封顶 0.8）。
     成功：+40 硬币 +3 露水；失败：仓库失去最多 3 个作物。
  2. **投喂**（`feed`）：仓库至少 3 个作物；消耗 3 个，+1 稻米种子 +2 露水。
- 不处理：换季结算时仓库失去 1 个作物，并记一条"熊獾来过"。
- 结果只结算一次；`resolved` 后卡片变成结果态，不重复弹。
- 动作 `farm-omen-resolve`，入参 `{ choice: 'guard'|'feed', expectedStart }`；
  季节不对/已解决/来客不对返回明确错误码。
- 掷骰用注入的 `farmRandom`，测试可固定成功/失败。
- v1 不做野火、巨鹿、蛙雨；v2 再扩。

### 持久化

- 新文件 `<dataDir>/season.json`：

```json
{
  "version": 1,
  "event": { "start": 1794240000000, "id": "autumn-harvest",
             "progress": { "plant": 0, "harvest": 7, "sell": 0, "water": 0 },
             "claimed": false },
  "omen": { "start": 1794240000000, "id": "autumn-bearger",
            "resolved": false, "choice": null, "result": null }
}
```

- `event.start` / `omen.start` 都是本地日 00:00；`start` 变了就重置。
- 写入走 tmp + rename；串行化，和 `farm.json` 同一套习惯；节流 30 秒。
- 没有 `season.json` 时懒创建；损坏时丢弃重来，不影响 `farm.json`。
- 不升 `FARM_VERSION`；不改 LAN 协议；季节是本地规则，邻居看不到你的节日/来客。

### 宿主与契约

- `seasonView(now)` 返回：

```json
{
  "id": "autumn", "name": "秋", "emoji": "🍂",
  "start": 1794240000000, "end": 1794326400000, "remainingMs": 29520000,
  "calendar": [
    { "id": "spring", "name": "春", "emoji": "🌱", "today": false, "past": true, "festival": "播种节" },
    { "id": "summer", "name": "夏", "emoji": "☀️", "today": false, "past": true, "festival": "夜市" },
    { "id": "autumn", "name": "秋", "emoji": "🍂", "today": true,  "past": false, "festival": "丰收祭" },
    { "id": "winter", "name": "冬", "emoji": "❄️", "today": false, "past": false, "festival": "围炉节" }
  ],
  "event": {
    "id": "autumn-harvest", "name": "丰收祭",
    "requirement": { "kind": "harvest", "qty": 15 },
    "progress": 7, "ready": false, "claimed": false,
    "reward": { "coins": 50, "dew": 4 }
  },
  "omen": {
    "id": "autumn-bearger", "name": "熊獾",
    "text": "一只熊獾在仓库外翻东西。",
    "resolved": false, "result": null,
    "choices": [
      { "id": "guard", "label": "守夜", "chance": 0.3 },
      { "id": "feed", "label": "投喂", "cost": 3, "disabled": false }
    ]
  }
}
```

- `farmWindowPayload` 顶层加 `season`；`/state` 顶层加 `season`。
- 动作表新增：

| 动作 | 入参 | 说明 |
|---|---|---|
| `farm-event-claim` | `{ expectedStart }` | 领当日节日奖励 |
| `farm-omen-resolve` | `{ choice, expectedStart }` | 结算秋·熊獾 |

- 新错误码：`out-of-season`、`withered`、`event-not-ready`、`event-claimed`、`stale-season`、`omen-resolved`。
- 桌面白名单加 `FARM_EVENT_ACTIONS` / `FARM_OMEN_ACTIONS`；`main.js` 转发 `expectedStart` / `choice`。
- `normalizeSeason` 对宿主数据做严格形状校验；老宿主没有 `season` 时桌面隐藏季节 UI，不崩。

### 界面

- 顶栏下方一条 `#season-bar`：四格 `#season-calendar`（春/夏/秋/冬），今天高亮，节日图标，
  右侧"距入冬 8 小时 12 分"；最后 4 小时变暖色并提示"今晚 24:00 换季，未熟四季作物会枯萎"。
- `#page-farm` 顶部、`#visitor-banner` 上方放 `#omen-card`（有来客时）和 `#event-card`（每天）：
  - 节日卡：目标、进度条、奖励、领取按钮；完成后按钮变"领取"。
  - 来客卡：标题、描述、两个按钮；投喂不足 3 个作物时禁用并写"仓库不够 3 个"；
    守夜显示成功率；结算后显示结果。
- 枯萎地块卡：`data-stage="withered"`，角标"枯萎"，详情"换季了，这株没来得及熟"；
  操作只留"＋ 重种"。
- 季节主题只动强调色/背景渐变，不重做布局；`body[data-season]` 控制。
- 换季 toast："秋天到了 · 丰收祭" / "冬天到了 · 围炉节"；换季时如果窗口开着，立即重渲染。
- 日志文案：`wither` "3 株四季作物枯萎了"、`season` "秋天到了"、`event` "丰收祭完成"、
  `omen` "熊獾被赶走了 / 熊獾翻走了 3 个作物"。

## Testing Decisions

- `test/season-rules.test.js`：锚点、本地 00:00、4 天循环、跨月/跨年、`seasonSegments`、
  四种作物的季节映射、当季 +10%。
- `test/season-store.test.js`：懒创建、`season.json` 形状、进度计数、领奖一次、跨日重置、
  损坏文件回退、来客只结算一次。
- `test/farm-season.test.js`：错误季节拒种、当季生长更快、换季枯萎 B（未熟枯萎/成熟保留/
  旧六种不枯）、枯萎地不能收浇肥、可覆盖重种、离线跨午夜。
- `test/season-window.test.js`：`seasonView` 形状、`farm-window` 带 `season`、日历 today/past、
  节日 ready/claimed、来客卡只给主人、看田/串门不带。
- `test/season-e2e.test.js`：两个真 service；A 种/收/卖/浇 → 计数 → 领奖 → 硬币/露水到账；
  秋·熊獾守夜成功/失败、投喂、跨季未处理；重启后 `season.json` 不重复领/不重复结算。
- `test/farm-window.test.js` / `test/farm-ui-css.test.js`：静态断言 `#season-calendar`、
  `#event-card`、`#omen-card`、`data-stage="withered"`、季节主题选择器。
- `test/shared.test.js`：`FARM_STAGES` 含 withered、`FARM_LOG_KINDS` 含四个新类型、
  `normalizeSeason` 夹取、`normalizeFarmAction` 的新动作。
- 所有时间用例注入 `farmNow`，不 sleep；随机用例注入 `farmRandom`。
- `npm run check` 必须全绿；`smoke:desktop` 手工跑一次。

## Out of Scope

- 春蛙雨、夏野火、冬巨鹿；v1 只有秋·熊獾。
- 邻居协防来客、来客出现在桌面/串门、LAN 同步节日进度。
- 天气（下雨自动浇水、野火）、温室、quality/星级、28 天季节、节日小游戏。
- 来客开关 `seasonOmens`、难度设置、时区旅行/改系统时间的防作弊。
- 新物品类型（稻草人、火把、饲料）；来客只用硬币/露水/种子/仓库作物。
- 旧六种的数值重做、市场深度调整、新的地块解锁曲线。

## Further Notes

- **为什么 1 天 1 季**：星露谷 28 天 / 6 天作物 ≈ 4.7 轮；dsh-zoo 24 小时 / 6 小时 ≈ 4 轮；
  7 天 1 季会变成 28 轮，太密。1 天 1 季是压缩后的正确密度，不是偷懒。
- **为什么枯萎只打四季作物**：旧六种是玩家已经投入的资产，不该因为新系统被惩罚；
  四季作物是"当季赌注"，枯了才有时序感。
- **为什么来客只做熊獾**：它只动仓库，不需要新的地块状态；野火/巨鹿要动地块，
  等 v2 有 `withered` 之外的"烧毁/冻结"再开。
- **为什么不做实时 boss**：dsh-zoo 是 idle + LAN，玩家可能几小时不看；倒计时惩罚会变成
  "离线惩罚"。卡片式选择把压力放在"你看到的那一刻"，而不是"你没看到的时候"。
- **中惩罚的口径**：守夜失败丢 3 个仓库作物，不处理丢 1 个；不毁地块、不删档、不扣硬币。
- **与星露谷/饥荒的关系**：星露谷给日历、作物表、节日；饥荒给"季节来客"的压力。
  我们只借结构，不借 28 天、不借实时战斗、不借死亡惩罚。

## Tickets

- 63 season-rules：季节时钟与纯规则
- 64 seasonal-crops：四种四季作物与种子店
- 65 season-store：`season.json`、节日状态、领奖
- 66 withering：枯萎阶段与农场集成
- 67 autumn-bearger：秋·熊獾来客
- 68 host-season-api：service 的 `seasonView`、payload、动作
- 69 farm-view-season：桌面纯视图模型
- 70 farm-window-season-ui：窗口结构、样式、渲染
- 71 desktop-action-plumbing：shared/main 白名单与归一化
- 72 season-tests：规则/存储/农场/窗口/e2e
- 73 docs-release：ADR、README、CONTEXT、1.5.0
