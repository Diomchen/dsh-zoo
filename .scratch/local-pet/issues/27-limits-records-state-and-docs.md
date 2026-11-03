# 27: 限额、记录、状态出口与文档

**What to build:** 给礼物上边界并把它写进这本账：磁盘与频率限额、`visits.json` 多一个可选
`gift` 字段、`/local-pet/state` 列背包与收到的礼物，以及协议文档、README、版本号。

**Blocked by:** 25, 26

**Status:** todo

决策依据：[ADR-0011](../../../docs/adr/0011-bring-gift-on-visit.md)、[SPEC v4](../SPEC-v4.md)。

- [ ] 限额：单件 ≤16 MiB；`gifts/` 总量 ≤500 MiB 且 ≤200 件，超了按 `receivedAt` 删最旧（整目录删）；
      同一邻居 ≤10 件/小时、≤50 件/天（超了 `refused`，原因 `rate`，不落盘、不回执）
- [ ] `src/visit-record.js`：记录多一个可选 `gift: { kind:'text'|'file', name? }`——
      **不记字条正文**；字段非法只丢这一个字段，不丢整条记录；旧文件（没有该字段）照常读
- [ ] `src/visits.js` 与 `src/room.js` 在完成串门时把 `gift` 一起写进去（in / out 都写）
- [ ] `GET /local-pet/state` 多 `backpack` 与 `gifts`（最近 20 条，最新在前，带 `path` 与 `status`）；
      两个字段在任何时候都是数组，不出现 `undefined`
- [ ] `docs/protocol.md`：`gift` 字段、`gift-received`、礼物路由、敌意输入边界各加一节；
      说清「礼物坏了不丢串门」与「只在 armed 期间可读」
- [ ] `README.md`：新功能段（带派 / 背包 / 礼物卡）、`backpack.json` 与 `gifts/` 的位置、
      限额与清理、`/local-pet/action` 新动作表、已知限制（16 MB、旧端收不到、端口被防火墙挡时的表现）
- [ ] 文档互指：`CONTEXT.md` ↔ ADR-0011 ↔ SPEC v4 ↔ 票 23–27；`.scratch/local-pet/SPEC-v4.md`
      的头部承接 ADR-0011
- [ ] `package.json` 升到 `0.4.0`；`npm pack` 出来的包里不含测试与 `.scratch/`
- [ ] 真机冒烟：字条 / 文件 / 图片三种卡片、缩略图、扔掉、送达与没送达两种气泡；
      截图落到 `.scratch/local-pet/notes/27-*.png`；`npm test` 全绿
