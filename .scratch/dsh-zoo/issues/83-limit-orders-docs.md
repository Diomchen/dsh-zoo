# 83: 到价开仓（v1.5）+ 文档/降级/验收

**What to build:** 加可选的本地限价单：玩家设目标价 + 方向/保证金/杠杆，tick 越过目标价即成交，收盘未成交即撤，可手动撤，不做部分成交；补齐 CONTEXT/README/ADR-0027 accepted、窗口/限额/协议/降级表；跑最终 e2e。

**Blocked by:** 80、82

**Status:** done

**Spec:** [SPEC v10](../SPEC-v10.md)

## 关键决定

- 限价单是本地挂单，不跨机；到期 = 这根收盘；成交价 = 目标价；不部分成交；下单区只在玩家点开「到价」时出现。
- 文档：CONTEXT 新词、README 窗口/限额/协议/降级、ADR-0027 accepted；0 硬币/断网/坏文件/旧邻居。
- 没有 NPC/赛季筹码/手续费/保险/上限；硬币是唯一约束。

## 实现记录

- 限价单 = `trading.json.orders[]`：挂单当场 `spendCoins(margin)`，成交价 = 目标价，
  一笔写盘里删单 + 推仓位；到期/撤单走 `refunding` 意图（先写意图、再退钱、再删单），
  重启只补删单不重复退钱；撤单/到期不进历史。
- 保证金：`TRADING_MARGINS = [50, 100, 250]` + 窗口「全下」；规则层 `isMarginAmount`
  接受 1..`MAX_MARGIN`（= `MAX_COINS`）的任意整数。
- 新动作 `trading-place-order` / `trading-cancel-order`，四跳白名单（preload → main IPC
  → `shared.normalizeBoardAction` → 宿主）都补齐；顺手修了 helper 事件层以前会把盘口
  动作整条丢掉的窄口（`shared.normalizeHelperEvent` 的 action 分支）。
- 最终验收：`test/trading-orders.test.js`、`test/trading-final-e2e.test.js`；`npm run check` 全绿。

## 验收

- [x] 到价开仓：目标价/方向/保证金/杠杆；到价成交；收盘未成交撤；手动撤；不部分成交。✅ 2026-11-16
- [x] 文档：CONTEXT/README/ADR-0027 accepted；窗口/限额/协议/降级表。✅ 2026-11-16
- [x] 最终 e2e：开窗 → 开仓 → 止损/到价/收盘 → 硬币/榜/邻居；`npm run check` 全绿。✅ 2026-11-16
- [x] 旧邻居/断网/0 硬币/坏文件降级；没有 NPC/赛季筹码/手续费。✅ 2026-11-16
