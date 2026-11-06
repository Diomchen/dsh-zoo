# 42: 行情 gossip——局域网价格指数

**What to build:** 每 30 秒把本机交易所价格和雇工挂牌广播给放行邻居；各家取中位数混成「局域网行情」，交易所页显示指数。没有中心主机。

**Blocked by:** 41

**Status:** done

决策依据：[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)、[SPEC v5](../SPEC-v5.md)。

- [x] `src/protocol.js`：新报文 `market-digest`（`prices` 每作物一个数 + `hire` 挂牌 +
      `at`）；`hire` 带 `enabled / wagePerHour / minHours / maxHours / guard /
      available / reason`（44 的雇工板直接读，不再逐个问邻居）；编解码、4 KiB、UUID/
      枚举/字段白名单；未知字段丢弃；旧 peer 静默丢类型不崩
- [x] 发送：每 30 秒或价格变化时，向放行邻居单播；只在 `mayTalkTo` 之后；失败不重试
      （下一轮自然补）
- [x] 接收：只认已知作物、`at` 在 2 分钟内、价格在 `[base×0.5, base×2]`；按 deviceId
      存最近一条；取新鲜样本的中位数作为指数；坏条目丢掉、不整包丢；1 peer 30 秒最多 1 条
- [x] 混合：`effective = 0.85 × 本机 price + 0.15 × 指数`；指数进 `market.json`，
      `GET /state` 的 `market.index` 给 `{ price, at, samples }`
- [x] 交易所页多一列「局域网指数」和样本数；过期样本灰掉；没有邻居时显示「本机行情」
- [x] 单测：编解码/坏条目/夹取/中位数/新鲜度；两 service + fake peer：价格收敛、
      坏 digest 不崩、旧 peer 忽略
- [x] `npm test` 全绿；不做订单簿/挂单

> 完成情况：`market-digest` 只进 `PACKET_TYPES`（不进 `VISIT_TYPES`）；价格逐条白名单、
> `hire` 严格校验；30 秒/签名变化发送，`mayTalkTo` 单播、不重试；接收只认放行邻居、
> 2 分钟新鲜度、1 peer/30 秒；`market.index` 取本机 + 新鲜 peer 的中位数，`effective`
> 按 85/15 混合；交易所页显示指数/样本/灰态/本机行情。
> `peerDigests` 缓存留给 44 的雇工板；拒绝邻居时立刻移除其指数贡献。
> 637/637（`npm test` 与 `npm run check`；合并后第一次 check 遇到一次既有 visit-e2e 时序
> flake，重跑即绿）。
> 偏离：`samples` 含自己（一个 peer 时是 2）；`reason` 先 null、`available=hire.enabled`、
> `guard=0.5`，44 填真实可用性；新鲜度用 `|now−at| ≤ 2min`。
> 提交：`56f2f95`。
