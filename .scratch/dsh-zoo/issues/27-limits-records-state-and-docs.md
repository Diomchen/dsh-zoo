# 27: 限额、记录、状态出口与文档

**What to build:** 给礼物上边界并把它写进这本账：磁盘与频率限额、`visits.json` 多一个可选
`gift` 字段、`/dsh-zoo/state` 列背包与收到的礼物，以及协议文档、README、版本号。

**Blocked by:** 25, 26

**Status:** done

决策依据：[ADR-0011](../../../docs/adr/0011-bring-gift-on-visit.md)、[SPEC v4](../SPEC-v4.md)。

- [x] 限额：单件 ≤16 MiB；`gifts/` 总量 ≤500 MiB 且 ≤200 件，超了按 `receivedAt` 删最旧（整目录删）；
      同一邻居 ≤10 件/小时、≤50 件/天（超了 `refused`，原因 `rate`，不落盘、不回执）
- [x] `src/visit-record.js`：记录多一个可选 `gift: { kind:'text'|'file', name? }`——
      **不记字条正文**；字段非法只丢这一个字段，不丢整条记录；旧文件（没有该字段）照常读
- [x] `src/visits.js` 与 `src/room.js` 在完成串门时把 `gift` 一起写进去（in / out 都写）
- [x] `GET /dsh-zoo/state` 多 `backpack` 与 `gifts`（最近 20 条，最新在前，带 `path` 与 `status`）；
      两个字段在任何时候都是数组，不出现 `undefined`
- [x] `docs/protocol.md`：`gift` 字段、`gift-received`、礼物路由、敌意输入边界各加一节；
      说清「礼物坏了不丢串门」与「只在 armed 期间可读」
- [x] `README.md`：新功能段（带派 / 背包 / 礼物卡）、`backpack.json` 与 `gifts/` 的位置、
      限额与清理、`/dsh-zoo/action` 新动作表、已知限制（16 MB、旧端收不到、端口被防火墙挡时的表现）
- [x] 文档互指：`CONTEXT.md` ↔ ADR-0011 ↔ SPEC v4 ↔ 票 23–27；`.scratch/dsh-zoo/SPEC-v4.md`
      的头部承接 ADR-0011
- [x] `package.json` 升到 `0.4.0`；`npm pack` 出来的包里不含测试与 `.scratch/`
- [x] `normalizeVisitRecord` 会**洗键**（只保留 4 个键，`visits.append` 前还再洗一次）：不改它，`gift` 永远落不了盘，而且「写进去」与「读回来」会漂移
- [x] `recordVisit` 现在是 4 个位置参数，改签名要同步 5 个调用点（in / out 都写）
- [x] `snapshot.visits` 只给 4 个字段、最近 5 条：想在后端看见 `gift` 也要同步加
- [x] `/dsh-zoo/state` 直接 `sendJson(room.snapshot())`：`backpack` / `gifts` 要并进快照（磁盘在 service，room 只持内存视图）
- [x] 真机冒烟：字条 / 文件 / 图片三种卡片、缩略图、扔掉、送达与没送达两种气泡；
      截图落到 `.scratch/dsh-zoo/notes/27-*.png`；`npm test` 全绿
      （父 agent 复跑：全量冒烟 **398 项断言、全部段落通过**；截图 `27-gift-card.png` /
      `27-gift-image.png` / `27-gift-file.png` / `27-bring-window.png`）


> 完成情况：限额、记录、状态出口与文档已经收口（ticket 27）。
> **限额**：频率闸在 `src/gift-limits.js` 的 `createGiftRateLimiter`，按 deviceId 记一小时/一天
> 两个滑动窗口，同一 `giftId` 的 3 次重发不重复计数。service 在 `receiveGift` 入口调用它
> （字条与文件共用），超了把卡片标 `refused`（原因 `rate`），不落盘、不回执。磁盘限额在
> `src/gifts.js` 的 `GiftStore.#pruneDisk`：`gifts/` ≤500 MiB 且 ≤200 件，按 `receivedAt`
> 删最旧、整目录删；**先写后剪**，刚写的这一件与正在下载的目录绝不删。单件 16 MiB 已在协议层
> 与接收端各挡一次（ticket 25）。
> **记录**：`src/visit-record.js` 新增 `normalizeVisitGift`（只留 `kind` 与文件名，**不记字条正文**），
> `normalizeVisitRecord` 的 gift 非法只丢字段、旧文件缺字段照常读。`room.recordVisit` 加第 5 个
> 参数，5 个调用点（in / out 都写）；`snapshot.visits` 同步带 gift。service 在 `sendVisitRequest`
> 成功之后 `markOutboundGift`，以“真正带上路”的那一件为准（编码层丢 gift 时不误记）。
> **状态**：`/dsh-zoo/state` 由 `stateView()` 合并 `backpack.items()` 与最近 20 件 `gifts.list()`
> （最新在前、带 `path` 与 `status`）；两个字段在任何时候都是数组。
> **文档**：`docs/protocol.md` 补「礼物字段」「gift-received」「礼物路由」「敌意输入边界」四节，
> 并同步报文表/字段表/动作表/记录形状；`README.md` 加「带派」段（落盘位置、限额与清理、
> 新动作表、已知限制）；`desktop/README.md` 补 `--dsh-zoo-gifts`、`dshzoo://gifts/...` 与
> 场景 v3 的 `controls.gifts`；`CONTEXT.md` 补 ADR-0011 / SPEC v4 / 票 23–27 互指；
> `package.json` 升 `0.4.0`（`npm pack --dry-run` 51 个文件，不含 `test/`、`.scratch/`）。
> **测试**：`npm test` 全绿 **448** 条（起点 433；新增 15：`test/gift-limits.test.js` 6、
> `test/state.test.js` 2、`test/visit-record.test.js` 4、`test/gift-e2e.test.js` 3）。
> 单测覆盖两个限速窗口与重试去重、磁盘裁剪顺序（件数/总量）、记录字段向后兼容、`/state` 形状；
> 集成覆盖超限 → `refused/rate`（字条 + 文件两条路径）、目录超限删最旧、双方记录带 `gift`。
> **冒烟**：按分工只跑 gift 段：
> `DSH_ZOO_SMOKE_ONLY=gift DSH_ZOO_SMOKE_NO_SANDBOX=1 DSH_ZOO_HELPER_NO_SANDBOX=1 npm run smoke:desktop`
> ——72 项断言通过（字条 / 图片 / 文件三种卡片、缩略图、扔掉）。**全量留给父 agent**；
> 没往 `.scratch/dsh-zoo/notes/` 写 27-* 截图（gift 段的截图在临时目录）。
> **没动的**：票 26 的文件；`feat/dai-pai` 与 `main`。打包产物未提交（`.gitignore` 已含 `*.tgz`）。
