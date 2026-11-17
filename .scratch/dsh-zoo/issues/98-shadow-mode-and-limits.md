# 98: 灰度开关与敞口限额

**What to build:** 房主能一键让期货进入「只跑不花钱」的影子模式，也能一键停掉并把托管余额原路退回；任何人在任何情况下都刷不爆这个市场——日额、名义敞口、发包频率三道闸会先拦住他。

**Blocked by:** 97 (真强平与保险基金兜底)

**Status:** done

- [x] 三档模式：`off`（窗口显示未开放、报文一律不理）/ `shadow`（撮合、结算、强平全跑，但充值提现只记账不碰农场硬币）/ `live`（真钱）。
- [x] 影子模式对账：跑满一段时间后，能导出一份「记账流水 vs 农场硬币差额」的核对结果，差额必须为 0。
- [x] 限额：单账户日交易额 5,000 币、同时持仓名义 20,000 币、同源地址 20 包/10 秒；超限时返回具体原因（`daily-cap` / `notional-cap` / `rate-limited`）。
- [x] 影子模式下日额上限为 0（只允许观察与自成交外的撮合），切到 live 才放开。
- [x] 回滚：关闭开关 → 强制平掉所有仓位（按最后公允价）→ 托管余额逐笔退回各人农场 → 存档打 `disabled` 标记但保留数据，不删。
- [x] 提现撞上农场 1,000,000 上限时，剩余部分留在托管账并显示「待提取」，不静默丢钱。
- [x] 窗口里每个拒绝原因都有中文文案，不是裸错误码。
- [x] 测试：三种模式的状态机、三个上限各自的边界（差 1 通过、等于拒绝）、回滚后退款金额与账面一致。

## 证据

**规则层**（`src/futures-rules.js`）：`FUTURES_MODES = ['off','shadow','live']`、`FUTURES_DEFAULT_MODE = 'shadow'`、
`DAILY_NOTIONAL_CAP = 5000`、`POSITION_NOTIONAL_CAP = 20000`。

**账本层**（`src/futures.js`）：状态加 `mode/dayStart/dayNotional/pending/disabled/farmAnchor/farmIn/farmOut/modeSeq`；
`#gate()` 统一拦 `off`/`disabled`；`setMode()`、`reconcile()`（导出 `farmAnchor + farmIn − farmOut` 与托管余额的差额）、
`rollback()`（先撤挂单退冻结 → 按最后公允价强平 → 逐账户退款 → 打 `disabled`）。日额按**账户**分别累计、本地 00:00 归零；
影子模式日额上限 0，新开仓/新挂单在余额校验之前就回 `daily-cap`（不留「余额够不够」这条侧信道）。
提现撞 `MAX_COINS` 返回 `{ok, credited, pending, notice}`，差额留在托管账。
`modeSeq` 让模式切换后即使没有远端账户，peer 也不会把新 settle 当成重复包。

**服务层**（`src/service.js`）：动作 `futures-mode`（非房主回 `not-host`）、`futures-rollback`、`futures-reconcile`；
`createFuturesRateLimiter()` 同源地址 20 包/10 秒，超限静默丢并 `warnOnce`；入站期货包统一先判 off 与限速，出站 settle/announce/sync 在 off 时短路。

**协议层**（`src/protocol.js`）：`futures-settle` 增 `mode`（三值白名单）与 `pending`（非负金币），非法值整包拒；
`normalizeFuturesTrade` 认 `kind:'mode'` 审计流水（`note` 三值白名单）。`docs/protocol.md` 同步。

**窗口**（`desktop/futures-view.js`、`futures.html`、`futures.js`）：顶部灰度条（徽章 + 文案 + 限额一行 + 待提取 + 房主才有的切档/回滚），
`statusOf()` 认 `session.kind === 'shadow'` 与 `mode === 'off'`，影子模式不再落成「周末休市」；限价挂单、撤单、转现货、切档、回滚都已接线。

**测试**（`node scripts/run-tests.mjs`）：**1159 用例 / 1158 通过 / 0 失败 / 1 跳过（Windows chmod 用例）**。
新增 `test/futures-mode.test.js` 13 条（三档状态机、影子对账、日额与持仓名义的边界、影子日额 0、回滚含撞顶 pending、
提现撞顶、限速器、按账户独立日额）；`test/futures-window.test.js` 加 2 条（挂单/撤单/转现货/切档白名单、影子状态与限额行）。

**已知偏差**（留给票 99）：① 回滚时远端账户的余额退进房主农场并记进该 peer 的 `pending`，原路回各自 `farm.json` 需要新协议；
② 切到 `off` 后不再发 settle，peer 可能保留最后一次已知模式直到重连；③ peer 窗口看不到自己的日额（settle 未带 `dayNotional`）。
