# 82: 真邻居 trading-digest + 周榜/情绪

**What to build:** 让榜单上出现真邻居：每个 peer 每 30 秒上报 `trading-digest`（本周盈亏 + 当前持仓），本机合并成本周真人榜 + LAN 情绪；没有 NPC；邻居不报硬币余额；旧邻居静默忽略；坏包/过期包/超频包丢弃。

**Blocked by:** 81

**Status:** ready-for-agent

**Spec:** [SPEC v10](../SPEC-v10.md)

## 关键决定

- `trading-digest`：`{ v: 1, type, deviceId, at, weekPnl, weekPnlPct?, positions: [{ crop, side, leverage }] }`；只发已放行邻居；不包含硬币/保证金/入场/历史。
- 接收：已放行、`at` ≤2 分钟、同 peer 30 秒 ≤1 条、`positions` ≤8；坏字段整包丢；旧版本静默忽略。
- 榜按 `weekPnl` 降序；收益率只展示（邻居自报 `weekPnlPct` 或本机 `weekPnl / weekBase`）；无邻居就自己。
- 情绪 = 本机 + 邻居当前 positions 的多空计数。
- 不做强防作弊；伪造 digest 不改本机硬币。

## 验收

- [ ] 30 秒/peer 发送；只发已放行；白名单/新鲜度/限流/坏包丢弃；旧邻居忽略。
- [ ] 榜显示本机 + 邻居，按 `weekPnl`；收益率列；LAN 情绪；没邻居只自己。
- [ ] 邻居只报盈亏 + 持仓，不报硬币；伪造 digest 不改本机硬币。
- [ ] 两台假 peer e2e；`npm run check`。
