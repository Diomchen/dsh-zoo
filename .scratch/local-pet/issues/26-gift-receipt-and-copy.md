# 26: 送达回执与失败话术

**What to build:** 送达以对方回执为准：接收方真写进 `gifts/` 之后回一条 `gift-received`，
发起方收到才把礼物从背包删掉；串门结束还没收到就退回背包，并说一句人话。

**Blocked by:** 24

**Status:** todo

决策依据：[ADR-0011](../../../docs/adr/0011-bring-gift-on-visit.md)、[SPEC v4](../SPEC-v4.md)。

- [ ] `src/protocol.js`：新增报文类型 `gift-received`（`{ v, type, deviceId, visitId, giftId }`），
      编解码 + 解析 + 长度/形状校验；`PACKET_TYPES` 与 `VISIT_TYPES` 跟着加
- [ ] 接收方：字条或文件**写盘成功后**发 3 次（间隔 400ms）；重复收到回执幂等（不重复删、不重复提示）
- [ ] 背包 `out` 状态：带 `visitId`；收到回执 → 删除该件 + notice「「楼下的柯基」收下了。」
- [ ] 串门结束（回家 / 送客 / 超时 / 失联）仍未收到回执 → 退回 `idle` +
      notice「没送到：对方没取到（可能没开端口、或对方版本较旧）。」
- [ ] 失败话术统一进 `src/visit-copy.js`（同一张表，别在渲染端分叉）：
      `timeout` / `no-port` / `checksum` / `too-large` / `rate` / `write` 各一句人话；
      接收方卡片上的 `failed` / `refused` 也走这张表
- [ ] 送客提醒：这张卡一次都没打开过（`meta.opened === false`）→ notice
      「「楼下的柯基」捎来的东西还在 gifts 里。」
- [ ] 单元：回执编解码、重复回执幂等、退包、`opened` 落盘
- [ ] 集成：回执正常到达；回执丢包（退包并提示）；旧端永不回执（超时退包）；串门被拒（根本不 arm）
- [ ] `gift-received` 走**单独分支**，别塞 `VISIT_TYPES`（`:396` 那条只重建 4 个字段，会吃掉 `giftId`）
- [ ] `onPeer` 的 else 兜底是 `observeBeacon`：忘了加分支不会报错，只会被当 beacon 静默吞
- [ ] 退包/收回执要覆盖**所有**结束点，特别注意 `observeVisitRecall` 里「请求中被对方 recall」直接 `state.out=null`（绕过 `finishOutbound`），以及 `dispose`
- [ ] 重发照抄 `recalls` 那套：`recalls` Map + `queueRecall:1291` + `runRecallRetries:1309`，`dispose:1344` 里记得清
- [ ] 冒烟：送达后的「收下了」气泡与没送达的「没送到」气泡各一张截图
