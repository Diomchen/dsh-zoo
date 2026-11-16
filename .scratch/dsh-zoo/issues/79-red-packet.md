# 79 · 带派红包

**Status:** ready-for-agent
**Spec:** [SPEC-v9](../SPEC-v9.md)（带派 → 红包）
**ADR:** [ADR-0027](../../../docs/adr/0027-red-packet.md)

## 目标

在带派里加一种新礼物：红包。红包装农场里的硬币、作物、种子，收件人点「拆开」后
内容进他的农场；24 小时没拆就退回发送方。

## 范围

- 协议：`normalizeGift` 接受 `kind:'packet'`；`PACKET_LIMITS`；`packet-return` /
  `packet-returned` 两个包类型与编解码。
- 背包：`packet` 条目（内容 + 祝福语），`prepareGift` 产出线上礼物。
- 农场：`takeCropOf` / `takeSeedOf`（按作物扣，失败不留半截）。
- 礼物账本：`receivePacket` / `claimPacket` / `markReturned`，`meta.json` 记
  `claimedAt` / `returnedAt`。
- 宿主：`bring` 走 packet 分支（先扣后进背包，每日 3 只），`gift-claim` 拆开，
  定时器扫过期并尽力退包，收到 `packet-return` 后入账并回 `packet-returned`。
- 桌面：带派小窗两个页签（字条 / 红包）、硬币与作物/种子步进器、祝福语、实时摘要；
  访客红包卡加「拆开」，隐藏打开/文件夹/复制。

## 明确不做

- 不做拼手气/随机金额，不做口令红包，不做群里抢。
- 不做跨天保留的“待拆红包”提醒列表（只在礼物卡上显示）。
- 不做退包失败的人工重发 UI（重试表在宿主侧，满了丢最旧）。

## 验收

- `test/packet.test.js`：协议限额、背包往返、按作物扣、拆开/退回账本、TTL、4 KiB 内。
- `test/packet-ui.test.js`：helper 侧夹紧与截断、红包卡、动作白名单、模板契约。
- `npm run check` 全绿；`node --check` 覆盖所有改动文件。
