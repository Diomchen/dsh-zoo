# 26: 送达回执与失败话术

**What to build:** 送达以对方回执为准：接收方真写进 `gifts/` 之后回一条 `gift-received`，
发起方收到才把礼物从背包删掉；串门结束还没收到就退回背包，并说一句人话。

**Blocked by:** 24

**Status:** done

决策依据：[ADR-0011](../../../docs/adr/0011-bring-gift-on-visit.md)、[SPEC v4](../SPEC-v4.md)。

- [x] `src/protocol.js`：新增报文类型 `gift-received`（`{ v, type, deviceId, visitId, giftId }`），
      编解码 + 解析 + 长度/形状校验；`PACKET_TYPES` 加，`VISIT_TYPES` **故意不加**
      （见下方「单独分支」那条：它只重建四个字段，会吃掉 `giftId`）
- [x] 接收方：字条或文件**写盘成功后**发 3 次（间隔 400ms）；重复收到回执幂等（不重复删、不重复提示）
      （字条已通；文件在 25 合并后调同一个 `sendGiftReceipt`）
- [x] 背包 `out` 状态：带 `visitId`；收到回执 → 删除该件 + notice「「楼下的柯基」收下了。」
- [x] 串门结束（回家 / 送客 / 超时 / 失联）仍未收到回执 → 退回 `idle` +
      notice「没送到：对方没取到（可能没开端口、或对方版本较旧）。」
- [x] 失败话术统一进 `src/gift-text.js`（礼物与背包的同一张表，别在渲染端分叉）：
      `timeout` / `no-port` / `checksum` / `too-large` / `rate` / `write` 各一句人话；
      接收方卡片上的 `failed` / `refused` 也走这张表
      （实现落在 `gift-text.js` 的 `giftStatusText` / `backpackErrorText`；`visit-copy.js` 只管串门失败）
- [x] 入站串门结束时（送客 / 对方召回 / 失联 / 清场）这张卡一次都没打开过
      （`meta.opened === false`）→ notice「「楼下的柯基」捎来的东西还在 gifts 里。」
- [x] 单元：回执编解码、重复回执幂等、退包、`opened` 落盘
- [x] 集成：回执正常到达；回执丢包（退包并提示）；旧端永不回执（超时退包）；串门被拒（根本没有 out 件）
- [x] `gift-received` 走**单独分支**，别塞 `VISIT_TYPES`（`:396` 那条只重建 4 个字段，会吃掉 `giftId`）
- [x] `onPeer` 的 else 兜底是 `observeBeacon`：忘了加分支不会报错，只会被当 beacon 静默吞
- [x] 退包/收回执要覆盖**所有**结束点，特别注意 `observeVisitRecall` 里「请求中被对方 recall」直接 `state.out=null`（绕过 `finishOutbound`），以及 `dispose`
- [x] 重发照抄 `recalls` 那套：`receipts` Map + `sendGiftReceipt` + `runReceiptRetries`，`dispose` 里记得清
- [x] 冒烟：送达后的「收下了」气泡与没送达的「没送到」气泡各一张截图
      （gift 段新增两例，文案直接取 `src/gift-text.js` 的真身：
       `.scratch/local-pet/notes/26-gift-notice-received.png` /
       `26-gift-notice-not-received.png`；gift 段 96 项断言）

> 完成情况：送达以对方回执为准，这条链路已经通了（ticket 26）。
> **协议**：`PACKET_TYPES` 加 `gift-received`；`encodeGiftReceived` 与 `parsePacket` 各有一条
> **自己的分支**（`VISIT_TYPES` 故意没加——那条只重建 v/type/deviceId/visitId，会吃掉 `giftId`）。
> 解析只认 `{v,type,deviceId,visitId,giftId}`：缺/坏 id 整包 `fail('gift-id')` / `fail('visit-id')`，
> 多余的 nickname/port/坐标一律不进结果；编码与解析都归一成小写。
> **接收方**：`receiveGift` 在 `gifts.receiveText` 真的写成功之后调通用出口
> `sendGiftReceipt(deviceId, visitId, giftId)`（不绑死字条路径；ticket 25 的文件拉取在 rename
> 成功后调同一个函数，落点已留 `// ticket 26: 回执`）。重发照抄 recall：`receipts` Map、
> 3 次 / 约 400ms（`RECEIPT_ATTEMPTS` / `RECEIPT_RETRY_MS` / `RECEIPT_TIMEOUT_MS`，测试可注入），
> 同一 giftId 重复写盘不会重启一轮；`runReceiptRetries` 由 `flushRoomEffects` 驱动，`dispose` 清空。
> **发起方**：`onPeer` 里加了自己的 `gift-received` 分支（落到 else 会被 `observeBeacon` 静默吞掉）；
> `startOutboundVisit` 把真的发上路的礼物登记进 `outboundGifts`（giftId → {deviceId,visitId,nickname}）。
> `handleGiftReceived` 先同步摘表再 await 背包：重复回执直接 no-op（不重复删、不重复提示）；
> deviceId/visitId 对得上才 `backpack.confirmOut(giftId, visitId)` 删件 +
> `room.noteGiftReceived` 说「「XX」收下了。」。
> **退包**：`backpack` 新增 `confirmOut`（只删 out 件，idle 不会被一条回执悄悄吃掉）与
> `releaseOutByVisit`（按 visitId 把 out 件退回 idle）。service 侧只有**一个**退包入口
> `reconcileOutboundGifts`（在 `flushRoomEffects` 里）：只要 room 的 `out` 已经不在、或换成了
> 另一次 visitId，还没回执的就退包 + 说「没送到：…」。因此 `finishOutbound` /
> `failOutbound`（含 deny）/ `tick` 的到期与失联 / `observeVisitRecall` 里「请求中被对方 recall
> 直接 `state.out=null`」/ 本地召回全被同一条覆盖；`dispose` 另走
> `releaseOutboundGiftsOnDispose`（先写回 idle，再放掉 store 引用）。真退了一件才冒泡，
> 不会假报“退回背包”。
> **送客提醒**：room 在四个入站结束出口（`endInboundVisit` / `observeVisitRecall` 的 in 侧 /
> `tick` 失联 / `dropInboundVisitor`）把「谁捎来的、哪一件」排进 `endedInboundGifts`；
> service 的 `noteEndedInboundGifts` 查 `gifts.lookup(...).opened === false` 才说
> 「「XX」捎来的东西还在 gifts 里。」（`opened` 只在磁盘的 meta.json 上，所以判断留在 service）。
> 三句新文案都**追加**在 `src/gift-text.js` 末尾（没有重排旧表，冲突留给 merger）。
> **测试**：`npm test` 全绿 **406** 条（原 391 + 新 15）。新增 `test/receipt.test.js`（7）：
> 回执编解码/白名单/小写归一、三句文案、`confirmOut`、`releaseOutByVisit`、入站三个结束出口的
> 排队与“只交一次”、没礼物的访客不排队；`test/receipt-e2e.test.js`（8）：两实例回执到达 +
> 重复回执幂等、回执丢失退包、旧端超时退包、被拒后背包没有 out 件、接收方真的发三次、
> `gift-received` 不被当 beacon、送客提醒（未打开 / 已打开 / 对方召回 / 失联）、`dispose` 退包。
> `test/protocol.test.js` 跟着 `PACKET_TYPES` 与坐标白名单各补了一行。
> **冒烟**：按分工没跑（父 agent 最后统一跑）。
> **没动的**：`src/visit-copy.js`（失败原因 `timeout/no-port/checksum/too-large/rate/write` 是
> ticket 25 文件拉取的产物，等 25 合并后一起进那张表）；`VISIT_TYPES`；目录限额 / 记录 /
> `/state` / README（27）。
> **留给 25 的接缝**：文件分支写盘（临时文件 rename）成功后调
> `sendGiftReceipt(packet.deviceId, packet.visitId, gift.id)`——字条与回执重发是同一套；
> 失败（`failed` / `refused`）不要调它。
