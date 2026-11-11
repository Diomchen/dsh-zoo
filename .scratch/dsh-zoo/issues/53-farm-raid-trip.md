# 53: 派它去偷——行程、额度、驮包、回家

**What to build:** `farm-raid`：在家点一下，宠物出门去某位邻居家把这一趟能偷的都偷了，
带着驮包回家。自家守卫在它出门期间是 0。额度沿用旧的 `perVisit`（改名 `perTrip`），
作物偷到即落盘，驮包只是"还没到家"的显示。

**Blocked by:** 51

**Status:** done

决策依据：[ADR-0018](../../../docs/adr/0018-farm-open-to-lan.md) 决定 2/3/4、
[SPEC v7](../SPEC-v7.md)「领域与规则」「动作与契约」。

- [x] `farm-raid` 动作 `{ deviceId, plots? }`：本机校验（有地址、邻居 `caps` 含 `raid`、
      自己没在出门/打工、这趟额度 > 0、有标的地）；省略 `plots` 就按公开视图挑
      "成熟且没被自己偷过"的地，最多 `perTripLeft` 块
- [x] `self.out` 复用：`purpose:'steal'` + 行程状态（`plots`/`tripId`/`endsAt = now + 60s`）；
      `self.out` 非空期间 `farmGuard()` 照旧算 0（这条本来就是"出门 = 没人看"）
- [x] 收到 `visit-ack.raid`：`stolen` 进驮包（`carriedCrops` 带 `tripId`），**同一时刻写
      `farm.json` 的 `crops`**（崩溃不吞）；立刻发 `visit-recall` 收尾
- [x] 行程结束（结果收齐 / 60 秒到 / 对方失联）：清空驮包、写一条 `kind:'raid'` 记录
      （双方各一条：偷到几件、被抓几次、时长）；`self.out` 归位
- [x] 重启：扫 `carriedCrops`，行程不在就清空（作物已在仓库），**不重复入账**；
      `farm.json` 的写与 `contracts.json` 一样走"串行 + tmp/rename"
- [x] `perVisit` → `perTrip` 的语义改名（值不变、公式不变）；文案与注释同步；
      `/state.farm` 暴露 `trip:{perTrip,perTripLeft}` 或按现有形状补，不破坏别人
- [x] 测试 `test/raid-e2e.test.js`（两个真 service、**不放行**）：A `farm-raid` B → A `crops` +1、
      期间 A `guard` 0、B `farm.log` 有 `steal`、B `visitors` 有 `kind:'raid'`；回家后驮包清空；
      `test/raid-guard.test.js`：守卫掷骰、被抓计额度、额度用完即停、每块地每轮 1 次；
      `test/raid-restart.test.js`：偷到一半重启不丢不重
- [x] `npm test` + `npm run check` 全绿

> 不做：界面（54）、多邻居同时派、复仇与保护期。

---

> 完成情况：`farm-raid` 动作 + 一次行程（`self.out.purpose:'steal'`、`raidUntil`、60 秒硬上限）；
> 收到 `visit-ack.raid` 就把作物记进自家仓库（`farm.addCrop`，重启不丢）、驮包只负责"还没到家"的显示；
> 到点由 tick 里的 `sweepRaidTrips` 自己回家；双方各留一条 `kind:'raid'` 记录
> （`record.kind` 也加进了 `visit-record.js` 与 `copyRecord`，否则 `/state` 里看不见）。
> 免放行的出站走新的 `discovery.sendDirect`（每来源 4 次 / 5 秒），只给这一条链用。
> `test/raid-e2e.test.js` 三条：不放行也能偷（含"主人日志/偷客/记录"）、被抓住照样回家、指定地块只碰那几块。
>
> 两个坑：
> 1. **`pushNotice` 是 room 的内部函数，service 里根本不存在**——被抓的那条分支一抛异常，
>    整趟就再也不回家（表现是"15 秒还没回来"）。测试只断言了"被抓没拿到作物"，没断言
>    "被抓也照样回家"，所以一开始没抓到。现在测试里补了这条。
> 2. **一次性 `setTimeout` 收尾太脆**：先是被 `unref()` 掉、又被我改到副本上（`copyOutbound`
>    返回的是拷贝，改它不生效）。最后改成"到点由 tick 扫"，并加了 `room.markRaidUntil` 去改真身。
>
> 另外把 `npm test` / `npm run check` 加上了 `--test-force-exit`：这套真实 UDP 测试偶尔会在
> 全部跑完之后挂着不退出（这次连续两次），`--test-force-exit` 让 runner 收完就退，不影响断言。
>
> 偏离：`perVisit → perTrip` 只改了语义与注释，字段名与公式没动；窗口文案留给票 54。

> 补（票 54 收尾时发现）：**recall 也走了 `sendTo`**——对方没放行我，那包发不出去，
> 于是偷客要在人家桌面上待满 60 秒才自己走。`room.finishOutbound` 现在把 `purpose` 带进
> `pendingRecalls`，`sendVisitRecall(..., raiding)` 走上 `sendDirect`；三条入站收尾路径
> （召回 / 送客 / 到期）也都把记录标成 `kind:'raid'`。这条补了 e2e 断言。
