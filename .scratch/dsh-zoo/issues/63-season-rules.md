# 63: 季节时钟与纯规则

**What to build:** 新建 `src/season-rules.js`，把"今天是什么季节"做成纯函数：1 个本地自然日
= 1 季，4 天一轮，锚点 `2026-10-26` 春。这个文件不读盘、不碰 `farm.json`，只算时间。

**Blocked by:** 无

**Status:** ready-for-agent

## 范围

- [ ] `SEASON_ORDER = ['spring','summer','autumn','winter']`
- [ ] `SEASONS`：`{ id, name, emoji }`，春 🌱 / 夏 ☀️ / 秋 🍂 / 冬 ❄️
- [ ] `SEASON_ANCHOR = '2026-10-26'`（本地日）
- [ ] `seasonAt(now)`：返回 `{ id, name, emoji, start, end, remainingMs }`；
      `start` 是本地 00:00，`end` 是次日 00:00；不返回 `day` / `daysLeft`
- [ ] `seasonDayKey(at)`：本地日 key，用于 `season.json` 的 `start`
- [ ] `seasonSegments(from, to)`：把区间切成 `[{ season, start, end, ms }]`，跨午夜按段算；
      超过 64 段就夹到 64 段（离线很久时只保留最后 64 段）
- [ ] `SEASONAL_CROPS = { pea:'spring', watermelon:'summer', rice:'autumn', radish:'winter' }`
- [ ] `cropSeason(cropId)`：四季作物返回季节 id，其余返回 `null`
- [ ] `isSeasonalCrop(cropId)` / `seasonGrowthFactor(cropId, seasonId)`（当季 `1.1`，其余 `1`）
- [ ] `calendarFor(seasonId)`：四格 `{ id, name, emoji, today, past, festival }`
- [ ] `eventFor(seasonId)`：返回 `{ id, name, requirement:{kind,qty}, reward:{coins,dew} }`

## 时间口径

- 用本地日期分量算"第几天"，不要用 `(now - anchor)/86400000` 直接除，避免夏令时/时区偏移。
- 例：2026-10-26 春、10-27 夏、10-28 秋、10-29 冬、10-30 春。
- 2026-11-13 是秋；11-13 23:59 的 `remainingMs` 约 1 分钟；11-14 00:00 变冬。

## 不做

- 不做天气、不做 28 天季节、不做季节长短配置。
- 不读写 `season.json`（票 65 才做）。

## 验收

- [ ] `node --check src/season-rules.js` 通过
- [ ] `test/season-rules.test.js` 覆盖锚点、4 天循环、跨月/跨年、本地午夜、`seasonSegments`
- [ ] 旧六种 `cropSeason` 全是 `null`，生长系数 1
- [ ] 四种四季作物的季节映射和 `+10%` 正确
