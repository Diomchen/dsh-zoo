# 41: 交易所——本机做市商

**What to build:** 农场小窗多一个「交易所」页：买种子、卖作物；卖多了价跌，价格和成交记录重启不丢。这一票只做本机，行情 gossip 在 42。

**Blocked by:** 39, 40

**Status:** ready-for-agent

决策依据：[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)、[SPEC v5](../SPEC-v5.md)。

- [ ] `src/market.js`：`market.json` v1（`prices` / `history` / `index`）；缺文件 → 按作物表
      建初始价；损坏 → 默认 + 只告警一次；写入串行 + tmp/rename；历史 ≤200
- [ ] 价格公式（纯函数、可注入随机）：卖 `q` 个 `price = clamp(price × (1 − 0.12 × q / 20),
      base×0.5, base×2)`；每 10 分钟均值回归 `price += (base − price) × 0.03`；
      `bid = round(effective × 0.9)`，v1 的 `effective = price`；种子按表里的固定价卖
- [ ] 动作 `buy-seed` / `sell-crop`（qty 1–99）：扣/加硬币、种子、作物；错误码
      `bad-crop` / `no-coin` / `no-seed` / `market-busy`；买卖限速 10 次/分钟
- [ ] 交易所页：作物表（本机 `bid`、base、最近成交）、买种子/卖作物的数量与总价；
      结果 toast；`GET /state` 的 `market` 给 `prices` / `history`
- [ ] 单测：价格冲击、夹取、均值回归、买卖后库存守恒、历史裁剪；HTTP 集成：
      买种→种→收→卖→再买，硬币不为负
- [ ] `npm test` 全绿；不做跨机/行情指数（42）
