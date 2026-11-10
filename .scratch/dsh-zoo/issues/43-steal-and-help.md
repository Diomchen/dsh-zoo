# 43: 偷菜与帮忙

**What to build:** 访客在邻居农场里能偷成熟作物或帮忙浇水；主人能看到谁偷了；守卫有概率抓住；成熟就能偷，没有开关、没有保护期。这一票不做雇工，守卫只有主人宠物在家 0.3。

**Blocked by:** 39, 40

**Status:** done

决策依据：[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)、[SPEC v5](../SPEC-v5.md)。
协议/路由/幂等的细节见 `/Users/gensean/sean_project/test/dsh-zoo-farm-t43-notes.md`（本地勘察笔记，含 file:line）。

- [x] 先对齐 39 的 store 接口：补 `addCrop` / `addCoins` / `spendDew` / `refundDew` /
      `markStolen` / `markHelped` / 每日访客计数（`farm.json` 或 `farm-limits`），
      日志条目带 `who` 昵称；`guard` 不再硬编码 0，按 `self.out === null`（主人在家）算
- [x] 只读 HTTP `GET /dsh-zoo-farm/<visitId>`：`src/lan-routes.js` 加路由、`lan-server.js`
      加 `lookupFarm` 与 `handleFarm`（复用 HEAD-aware `sendJson`）；GET/HEAD only、
      404 坏/未知/过期、`no-store`、不含任何路径；访客宿主服务拉，helper 不联网
- [x] 授权从 room 的 `visitors` 派生：新纯函数 `room.visitorByVisitId()`；串门结束、
      召回、失联、`setTrust` 丢弃、dispose 五处自然 404，不另建 armed 表
- [x] 快照只给访客视图：`plots p1..p4`、阶段/成熟/`remainingMs`、
      **`stolenByMe` / `helpedByMe` 布尔值**（绝不回传 `stolenBy`/`helpedBy` 原数组，
      会泄露别的访客 deviceId）、`guard`、当日已用/上限、`hire`、`market`（41 前为 null）
- [x] 访客拉快照要主机的 LAN 端口：`onPeer` 缓存 `peerLanPorts`（30s TTL）；
      新 `src/farm-fetch.js`：2s 超时、64 KiB 上限、只私网/回环、60s 冷却、404 ⇒ 串门结束
- [x] `src/protocol.js`：`farm-action`（`visitId` / `requestId` / `action: steal|help` /
      `plotId`）与 `farm-action-result`（同 `requestId`、`ok`/`error`/`crop`/`qty`）；
      加进 `PACKET_TYPES` 但**不进 `VISIT_TYPES`**；各自 `buildPacket` / `parsePacket`
      分支与 `encode*`；4 KiB、UUID、固定错误枚举；`caught` 用 `error:'guard'`；
      同步修 `test/protocol.test.js` 的严格类型断言
- [x] 主人侧校验：`visitId` 对应活跃访客且 `deviceId` 一致；地块成熟；这块地这一轮
      没被这位访客偷/帮过；每日上限（偷 3/访客/农场、5/农场、10/访客；帮 3/访客/农场、
      5/访客、每地 1 次）；按 `${deviceId}:${requestId}` 缓存最近 200 条结果 + 10 分钟 TTL，
      **应用后才缓存（失败也缓存）**，重放前再验活跃串门
- [x] 偷：一次 1 个；守卫 = 主人宠物在家 0.3（不在家/打工 0），v1 封顶 0.8；
      成功率 `1 − 守卫`；成功 → 访客仓库 +1、地块 `stolenBy` + 访客、收获 −1、主人日志；
      失败 → `caught`/`guard`，这次白跑，没有罚款
- [x] 帮：还在生长的地；访客先扣 1 露水，地块 +10% 生长，访客 +1 硬币；失败/上限退回露水；
      结果幂等；成熟地帮 = `bad-plot`
- [x] 访客农场窗：`farm-window` payload 加 `mode:'owner'|'visitor'` 与
      `visit:{state,guard,plots,limits}`；「偷」/「帮」经六道窄口
      （`farm.js` / preload / main IPC / `shared` FARM_ACTIONS / `handleDesktopAction` /
      `handleActionInner`）；宿主**等** UDP 结果（~1.8s，3×500ms）只回一次
      `action-result`；`main.js` 加 `farmPending` 分支，成功不关窗、只 toast；
      串门结束推 `ended`，别让窗停在旧快照
- [x] 主人侧日志与通知；结果 toast；访客走后快照 404；主人自己的 `/state.farm.guard` 同步算对
- [x] 测试：`lan-server.test.js` 路由 cases；两 service + fake peer（保持 2s 心跳，
      让端口缓存有值）；`lossyRelay` 丢结果重试不双花；`protocol-gift.test.js` 模板；
      循环回环的 20 包/10s 限流要避开（别让测试被自己的限流挡住）
- [x] `npm test` 全绿；不做：雇工守卫（44）、访客在主人交易所成交、保护期/谢绝开关

> 完成情况：`GET /dsh-zoo-farm/<visitId>`（GET/HEAD、404、no-store、无路径）+
> `room.visitorByVisitId` 授权 + 访客视图（只给 `stolenByMe`/`helpedByMe` 布尔值）+
> `farm-action(-result)` 报文 + `${deviceId}:${requestId}` 幂等缓存 + 偷/帮上限与守卫 +
> `farm-fetch`（2s/64KiB/私网/60s 冷却）+ 访客窗口（await UDP、farmPending、ended）。
> 守卫收敛到单个 `farmGuard()`/`workerOf()`，`/state.farm.guard` 主人在家时是 0.3；
> 44 只需把 `worker` 接进同一个函数。
> 675/675（`npm test` 与 `npm run check`）。
> 偏离：`package.json` 的 test/check 加了 `--test-concurrency=4`（63 个真实 UDP 测试文件
> 默认并发会偶发挂住）；加固了触碰到的 `t.after` 临时目录清理；帮忙的「全局 5/访客」
> 只能访客侧算，主人只回自己农场的计数；同步更新了 `docs/protocol.md`。
> 提交：`e17d8e0`。
