# 65: season.json 与每日节日

**What to build:** 新建 `src/season-store.js`，把"今天的节日进度、有没有领奖"落在
`<dataDir>/season.json`；换日自动重置；领奖只成功一次。

**Blocked by:** 63

**Status:** ready-for-agent

## 文件形状

```json
{
  "version": 1,
  "event": {
    "start": 1794240000000,
    "id": "autumn-harvest",
    "progress": { "plant": 0, "harvest": 7, "sell": 0, "water": 0 },
    "claimed": false
  },
  "omen": null
}
```

- `SEASON_VERSION = 1`、`SEASON_FILE = 'season.json'`
- 写盘：tmp + rename；串行化；30 秒节流；损坏/缺字段就重建，不影响 `farm.json`
- `start` 是本地日 00:00；`start` 变了就重置 `event`

## API

- `createSeasonStore(dir, { now, log })`
- `view(now)`：返回 `{ id, name, emoji, start, end, remainingMs, calendar, event, omen }`
  - `event`：`{ id,name,requirement,progress,ready,claimed,reward }`
  - `omen`：v1 由票 67 填；本票先返回 `null`
- `note(kind, qty, now)`：`kind` 只认 `plant|harvest|sell|water`；先按 `now` 重置，
  再累加；数量夹到 `0..999`；返回最新 `event`
- `claim(now)`：未完成 → `{ ok:false, code:'event-not-ready' }`；
  已领 → `{ ok:false, code:'event-claimed' }`；成功 → `{ ok:true, event, reward }`，
  标记 `claimed` 并落盘（奖励由 service 发放，store 不碰农场）
- `settle(now)`：换日时重置 `event`；返回 `{ changed, eventReset }`，供 service 写日志
- `snapshot()`：只读当前内存状态，测试用

## 节日表

| 季 | id | 名字 | 目标 | 奖励 |
|---|---|---|---|---|
| 春 | `spring-sow` | 播种节 | plant 8 | 30 硬币 + 3 露水 |
| 夏 | `summer-market` | 夜市 | sell 8 | 40 硬币 + 3 露水 |
| 秋 | `autumn-harvest` | 丰收祭 | harvest 15 | 50 硬币 + 4 露水 |
| 冬 | `winter-hearth` | 围炉节 | water 5 | 35 硬币 + 6 露水 |

## 验收

- [ ] 没有 `season.json` 时首次 `view` 懒创建，不抛
- [ ] 同一天 `note('harvest', 3)` 三次 → 进度 9；`ready` 在 15 时变 true
- [ ] `claim` 成功后硬币/露水由 service 加一次；再 `claim` 返回 `event-claimed`
- [ ] 跨本地 00:00 后 `view` 自动换节日、进度归零、`claimed` 归 false
- [ ] 损坏 JSON 被丢弃重建；`farm.json` 不受影响
- [ ] `test/season-store.test.js` 全绿
