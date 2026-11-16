# SPEC v9：自适应局域网行情指数

**Status:** implemented
**Tickets:** 78
**ADR:** [0026](../docs/adr/0026-adaptive-market-index.md)

## Problem

交易所的局域网指数固定占 15%。邻居少时几乎无感，邻居多时也不够“像同一个市场”；
直接拉到 75% 又会被单家邻居和异常报价主导。玩家想要“股市那种波动感”，
但不是互联网行情，也不想让本机供需消失。

## Solution

- 新鲜邻居数分档权重：0/1/2/3+ → 0% / 45% / 65% / 75%。
- 作物 beta：番茄/草莓/豌豆 0.8，白萝卜 0.9，胡萝卜/稻米 1.0，
  玉米 1.1，南瓜 1.3，西瓜/葡萄 1.4；有效权重封顶 85%。
- 指数 = 新鲜 peer 报价中位数；动量 = peer 最近一轮涨跌中位数，夹在 ±12%；
  最终价仍夹在 `[base×0.5, base×2]`。
- 只影响卖价，买种子固定价；`/state` 指数形状不变，窗口视图增加
  `weight/momentum/stale`。
- 没有新鲜邻居时退化为本机行情。

## User stories

- 作为只有一家邻居的玩家，我能感到邻居价格对卖价有明显影响（番茄约 36%）。
- 作为有两三家邻居的玩家，我能看到高价值作物更跟大盘（西瓜封顶 85%）。
- 作为邻居离线很久的玩家，我能看到指数画灰，但卖价退回本机价，不会按旧价成交。

## Implementation decisions

- 中位数、新鲜度、`samples` 语义沿用票 42；动量来自 `sample.previous`。
- 窗口的 `index` 才带权重/动量；`/state` 保持旧形状，避免旧客户端断言失败。
- 自定义作物 beta 按 1.0，避免未知 id 放大权重。
- 旧 `market.json` 无 `momentum` 时按 0 读入；下一次 digest 自然补齐。

## Testing decisions

- `test/market-index.test.js` 覆盖权重分档、beta、动量、夹取、过期、坏样本、
  `market.json` 落盘/重启、`bid` 与 `removeDigest`。
- `test/farm-window.test.js` 覆盖窗口指数形状和 bid；`test/market.test.js` 覆盖原交易。
- 真实农场窗口 smoke 截图确认行情行不溢出。

## Out of scope

- 互联网/跨局域网行情、全球市场。
- 24 小时 sparkline、做空/期货/订单簿。
- 改变买种子价格或作物底价。

## v9.1 追加：带派红包（ticket 79）

**Problem.** 带派只能捎字条/文件，农场里的硬币、作物、种子没有“我送你一点”的动作。

**Solution.** 礼物多一种 `kind:'packet'`，装 `{coins,crops,seeds}` + ≤60 字祝福语；
寄出即扣、进背包，收件人点「拆开」才到账，24 小时没拆自动退回（对方离线就排队补退）。

**Implementation decisions.**
- 额度：硬币 ≤200、每种作物/种子 ≤20、作物和种子各 ≤5 种、每天 3 只；宿主与 helper 各校验一次。
- 拆开是一次性的：先写 `claimedAt` 再发货，失败回滚；重放返回 `packet-claimed`。
- 退回：`receivedAt + 24h` 由宿主定时器标记 `returnedAt`，发 `packet-return`；
  对方回 `packet-returned` 才清重试表；两个新包类型都不进 `VISIT_TYPES`。
- 拆到的内容直接进农场（不占背包格）。

**Out of scope.** 拼手气/随机金额、口令红包、群抢、独立的红包历史页。
