# 67: 秋·熊獾来客

**What to build:** 秋天那天来一只熊獾，主人可以选择"守夜"或"投喂"，立即结算。不做实时 boss、
不做 HP、不做倒计时；复用守卫、雇工、仓库和日志。

**Blocked by:** 65、66

**Status:** ready-for-agent

## 定义

- `src/season-omens.js`：
  - `OMENS = { 'autumn-bearger': {...} }`
  - `AUTUMN_BEARGER = { id:'autumn-bearger', season:'autumn', name:'熊獾',
      text:'一只熊獾在仓库外翻东西。',
      guard:{ successCoins:40, successDew:3, failCrops:3 },
      feed:{ cost:3, seed:'rice', seedQty:1, dew:2 },
      ignoreCrops:1 }`
  - `omenFor(seasonId)`：秋天返回定义，其他季返回 `null`
  - `resolveBearger({ choice, guardChance, random, crops })` 纯函数：
    - `guard`：`random() < clamp(guardChance,0,0.8)` 成功；成功返回
      `{ result:'driven', coins:40, dew:3, lossQty:0 }`；失败返回
      `{ result:'raided', lossQty: min(3, totalCrops) }`
    - `feed`：`totalCrops < 3` 返回 `{ error:'not-enough-crops' }`；否则
      `{ result:'fed', costQty:3, seed:'rice', seedQty:1, dew:2 }`
- `season.json` 的 `omen`：

```json
{ "start": 1794240000000, "id": "autumn-bearger",
  "resolved": false, "choice": null, "result": null }
```

- 秋天第一次 `view` 时懒创建；`start` 是当天 00:00；非秋天为 `null`。
- `resolveOmen({ choice, guardChance, random, crops }, now)`：
  - 季节不对 → `stale-season`
  - 已解决 → `omen-resolved`
  - 未知 choice → `bad-choice`
  - 成功 → 写 `resolved:true, choice, result`，落盘，返回结果
- `settle(now)`：如果旧 `omen.start` 存在、未解决、且已换季 → 返回
  `{ unresolvedOmen: { id, lossQty:1 } }`，并由 service 扣 1 个仓库作物、写日志、标记 resolved。

## 农场方法

- [ ] `farm.takeCrops(qty)`：从仓库按"数量最多的先拿"扣，返回 `{ removed:{crop:qty}, total }`；
      不足就全拿；不碰地块
- [ ] `farm.addDew(qty)`：加露水，封顶 `MAX_DEW`
- [ ] `farm.addSeed(cropId, qty)`：加种子，封顶 `MAX_STACK`
- [ ] `farm.noteSeason(kind, entry)`：写 `season` / `event` / `omen` 日志，走现有 log 上限

## 验收

- [ ] 秋天 `view` 出现熊獾；春天/夏天/冬天没有
- [ ] 守夜成功：+40 硬币 +3 露水，仓库不变；失败：最多丢 3 个仓库作物
- [ ] 投喂：仓库 ≥3 时扣 3 个，+1 稻米种子 +2 露水；不足时 `not-enough-crops`，不扣
- [ ] 同一天重复 resolve 返回 `omen-resolved`；换季后旧来客不再出现
- [ ] 跨季未处理：扣 1 个仓库作物，日志一条；不重复扣
- [ ] `test/season-omens.test.js` 和 `test/season-store.test.js` 覆盖纯函数与持久化
