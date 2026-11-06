# 43: 偷菜与帮忙

**What to build:** 访客在邻居农场里能偷成熟作物或帮忙浇水；主人能看到谁偷了；守卫有概率抓住；成熟就能偷，没有开关、没有保护期。这一票不做雇工，守卫只有主人宠物在家 0.3。

**Blocked by:** 39, 40

**Status:** ready-for-agent

决策依据：[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)、[SPEC v5](../SPEC-v5.md)。

- [ ] 只读 HTTP `GET /dsh-zoo-farm/<visitId>`：只在这次串门活跃期间可读，结束/超时/
      失联 404；返回主人的地块（阶段/成熟/守卫/`stolenByMe`/`helpedByMe`）、行情、挂牌；
      **不含任何路径**；访客宿主服务去拉，helper 不联网
- [ ] `src/protocol.js`：`farm-action`（`visitId` / `requestId` / `action: steal|help` /
      `plotId`）与 `farm-action-result`（同 `requestId`、`ok`/`error`/`crop`/`qty`/
      `caught`）；4 KiB、UUID、枚举；重发 2–3 次
- [ ] 主人侧校验：`visitId` 对应活跃访客且 `deviceId` 一致；地块成熟；这块地这一轮
      没被这位访客偷/帮过；每日上限（偷 3/访客/农场、5/农场、10/访客；帮 3/访客/农场、
      5/访客、每地 1 次）；按 `requestId` 缓存最近 200 条结果，重发返回同一结果
- [ ] 偷：一次 1 个；守卫 = 主人宠物在家 0.3（不在家/打工 0），v1 封顶 0.8；
      成功率 `1 − 守卫`；成功 → 访客仓库 +1、地块 `stolenBy` + 访客、收获 −1、主人日志；
      失败 → `caught`，这次白跑，没有罚款
- [ ] 帮：还在生长的地；访客花 1 露水，地块 +10% 生长，访客 +1 硬币；失败/上限退回露水；
      结果幂等
- [ ] 访客农场窗：只读地块 + 「偷」/「帮」按钮；显示上限/已偷/可能被抓；结果 toast；
      主人侧日志与通知；访客走后快照 404
- [ ] 集成：两 service + fake peer：偷成功/被抓/上限/重复 requestId；帮忙；结果丢失重试
      不双花；`npm test` 全绿
- [ ] 不做：雇工守卫（44）、访客在主人交易所成交、保护期/谢绝开关
