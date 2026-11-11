# 51: 协议与免放入站——`purpose:'steal'`、`plots`、`raid` 回执、`caps`

**What to build:** 让「来偷」在协议上成为一件事：串门请求带目的和地块，回执带结果，广播带能力声明；
主机侧对 `purpose:'steal'` 不查放行。这一票只做协议与主机侧的入站处理，不做界面、不做发起方。

**Blocked by:** 无（承接 43/44 的协议）

**Status:** done

决策依据：[ADR-0018](../../../docs/adr/0018-farm-open-to-lan.md) 决定 1/2/4、
[SPEC v7](../SPEC-v7.md)「协议」。

- [x] `src/protocol.js`：`caps`（`beacon` / `heartbeat`，可选数组，只认 `raid`/`look`，
      去重、≤4 项）；`visit-request` 的 `purpose`（只认 `'steal'`，其余丢弃 = 普通串门）与
      `plots`（`pN`，去重，≤50，非法项丢自己不整包失败）；`visit-ack` 的
      `raid: { stolen:[{plot,crop}], caught, skipped:[pN] }`（crop 只认三种 id，
      caught ≤ 50，stolen+skipped ≤ perTrip）
- [x] `parsePacket` 同步；`PACKET_TYPES` 不变（没有新类型）；4 KiB 兜底：`plots` 超限就整包不带
      `plots`（降级成"主机自己挑"），不是丢包
- [x] `src/room.js`：`handleVisitRequest` 对 `purpose === 'steal'` 跳过 `not-admitted`；
      访客表条目录 `kind: 'raid'`、`endsAt = now + RAID_MAX_MS`；`copyVisitor` 透传 `kind`
- [x] `src/service.js`：`purpose === 'steal'` 时逐块应用（成熟 / 这位没偷过 / `perFarm` / `perDay` /
      这趟额度），成功 `markStolen` + 访客仓库 +1 + `farm.log` 写 `steal`；失败分 `skip` 与 `caught`；
      结果塞进 `visit-ack`；同一 `visitId` 重发原样重放，**不进第二遍 store、不重掷守卫**
- [x] 守卫照旧：每块独立掷一次；被抓仍计额度
- [x] 测试 `test/protocol-raid.test.js`：字段严格性、`plots` 去重/上限、降级、4 KiB、`raid` 结果形状；
      `test/room.test.js` 补 `kind:'raid'` 与 `endsAt`；主机侧单测：不放行也能进、放行与不放行走同一条
- [x] `npm test` + `npm run check` 全绿

> 不做：`/open` 只读视图（52）、发起方与行程（53）、桌面角标（54）。

---

> 完成情况：`caps`（beacon/heartbeat）、`visit-request.purpose:'steal'` + `plots`、`visit-ack.raid`
> 全部落地；`room.observeVisitRequest` 对 `purpose:'steal'` 同时跳过 `acceptVisits` 与
> `canTalkTo`（ADR-0018 的后果：它拦不住），访客带 `kind:'raid'` + `endsAt`，到点由
> `room.tick` 清场（不写串门记录）；`service.applyRaid` 逐块过 `applyFarmAction`，
> 额度撞上 `cap` 就不再往下试，`plots` 缺省时由主人按"成熟且没被这位偷过"挑。
> `sendVisitAck` 带结果时走 `sendReply`（对方多半没放行，`sendTo` 过不去）。
> 782/782（`npm test` 与 `npm run check`）。
>
> 两个发现：
> 1. **`sendReply` 的 2 次 / 5 秒限速会咬到连续行程**——同一地址 5 秒内派第三趟，
>    ack 会被丢掉。真机上"一趟一趟连着偷"就会撞上，票 53 的发起方必须按超时收尾
>    （现有 `RAID_MAX_MS` 兜着），别指望 ack 一定回来。
> 2. **回环上 20 包 / 10 秒的额度是按 UDP 源地址算的**：同一个进程里所有测试的 127.0.0.1
>    共用一份。测试里别连发 beacon 握手（一开始那版发了 15 个，把后面的额度吃光了，
>    表现为"服务端不回 ack"）。任何合法报文都会记地址，`visit-request` 单发就够。
>
> 偏离：SPEC v7 写"`plots` 超 4 KiB 就整包不带"，实际 50 个 `pN` 离 4 KiB 很远，
> 因此只做了"至多 50 块"的截断，没有做那条降级分支。
