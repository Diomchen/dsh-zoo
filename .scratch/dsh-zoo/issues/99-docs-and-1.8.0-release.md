# 99: 文档、截图与 1.8.0 发版

**What to build:** 别人拿到这个仓库，只看文档就知道期货怎么玩、协议怎么接、出事怎么退；发版说明里有一条能复现的验收记录，而不是一句「已实现」。

**Blocked by:** 98 (灰度开关与敞口限额)

**Status:** done（2026-11-17）

- [x] README 增一节「期货」：怎么充钱、怎么下单、合约什么时候到期、强平线怎么算、费用去哪了。
- [x] `docs/protocol.md` 写清 5 种期货报文的字段、幂等键、4 KiB 上限与降级行为。
- [x] `docs/releases/1.8.0.md`：新增了什么、灰度三阶段怎么切、回滚步骤、已知限制（房主掉线、deviceId 可伪造）。
- [x] 截图：期货窗（空仓 / 持仓 / 强平预警 / 到期交割）四张，尺寸与盘口窗一致。
- [x] 一份对账记录：影子模式跑出来的「记账流水 vs 农场硬币」差额为 0 的证据。
- [x] `npm run check` 全绿；`CONTEXT.md` 词条与实现一致（有偏差就改词条，不是改实现）。
- [x] SPEC v11 的 Status 从 draft 改成 implemented，并补「实现」一节（照 ADR-0028 的写法）。

## 证据（2026-11-17）

- **README**：`README.md:527` 起「## 期货」，含 12 行规则表、三档灰度表、敞口限额表、已知限制段。
- **协议**：`docs/protocol.md:79` 与 `:907` 两处，五个包的字段白名单、`(epoch, seq)` 幂等键、
  4 KiB 上限与「旧邻居直接忽略」的降级都写了。
- **发版说明**：`docs/releases/1.8.0.md`（11 节），`package.json` 版本 `1.8.0`。
- **截图**：`docs/images/futures-window-{empty,positions,liquidation-warning,delivery}.png`，
  760×700，Electron 离屏渲染（`useContentSize: true`）出图，再用视觉核对「无横向滚动条 / 无裁切」。
  出图过程中发现并修掉一个真 bug：`desktop/futures.js` 顶部的 `'use strict'` 换行接 IIFE 被解析成
  函数调用，一加载就 `TypeError`——期货窗从票 92 起其实一直没画出来过。
- **对账**：`scripts/futures-reconcile-probe.mjs`（真 service + 真 `farm.json` + 假时钟，
  `node scripts/futures-reconcile-probe.mjs` 可复跑）：
  - 影子档：充值 600 只记账，农场硬币 5000 → 5000（差 0）；开仓被 `daily-cap` 拦住（影子日额 0）；
    `{"mode":"shadow","farmCoins":5000,"custodyTotal":600,"diff":0}`。
  - 切 `live`：开多 100×20 → 一根结算 → 平仓 → 提现 200；农场 5200、托管 391.04、
    `{"mode":"live","farmCoins":5200,"custodyTotal":391.04,"diff":0}`；
    守恒 5000 + 600 影子充值 + 盈亏 − 手续费 = 5591.04。
- **检查**：`npm run check` 全绿（用例数见发版说明）；`scripts/check-desktop.mjs` 覆盖 `desktop/`
  下 21 个脚本；`test/futures-script-load.test.js` 2 条（假 DOM 真跑脚本 + 限价挂单过桥）。
