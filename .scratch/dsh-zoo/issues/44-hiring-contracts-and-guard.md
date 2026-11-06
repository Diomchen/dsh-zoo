# 44: 雇佣合同与雇工守卫

**What to build:** 主人可以挂牌把宠物租出去看家；雇主预付工资，雇工出现在雇主农场，守卫降低偷菜成功率；合同可召回/结束/按实际时长结算。雇工自家农场因此没人看。

**Blocked by:** 42, 43

**Status:** done

决策依据：[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)、[SPEC v5](../SPEC-v5.md)。
实现细节见 `/Users/gensean/sean_project/test/dsh-zoo-farm-t44-notes.md`（946 行；room 镜像、
8 种报文、资金 WAL、守卫、桌面 `role` 的精确插入点）。

## 开工前已拍板

- **D1**：42 的 `market-digest.hire` 带 `available` / `reason` / `guard`；44 的雇工板直接读，
  不再逐个问邻居。
- **D2**：允许「既是雇主又是雇工」——我的宠物在外打工时，我仍可以雇一只别人家的宠物看家；
  不做互斥。
- **D3**：`contracts.json` 的 `outgoing` = 我是雇主（`workerDeviceId`），
  `incoming` = 我的宠物是雇工（`employerDeviceId`）。
- **D4**：手续费 `ceil(wage × 0.05)`，最低 1；烧掉。

- [x] room：`self.work`（我在外打工）+ 顶层 `worker`（别人在我家打工）两个镜像，与
      `self.out` / `visitors` / `guests` 正交；`self.work` 与 `self.out` 互斥；
      `beginWorking` / `endWorking` / `drainEndedContracts` / 心跳刷 `lastSeen`；
      tick 按 `endsAt` 或 peer lost 结束
- [x] `src/contracts.js` + 纯 `src/contracts-rules.js`：`contracts.json` v1（方向按 D3）；
      状态 pending/active/ended/cancelled + settled；坏条只丢自己、各 ≤20、淘汰不丢未结算；
      串行 + tmp/rename；只告警一次
- [x] 协议 8 种 `work-*`：`PACKET_TYPES` 加 8，各自 `buildPacket` / `parsePacket` 分支
      （**不进 `VISIT_TYPES`**）；request/settle 按 `requestId`，recall/end 按
      `contractId` 幂等；ack 缓存 `deviceId+requestId` 原样重放；4 KiB
- [x] 挂牌：`farm.hire` 随 digest 广播；农场窗「雇工」页：自己的开关/时薪/时段、邻居挂牌
      （available/reason/guard）、雇佣按钮与总价（工资 + ceil 5%）
- [x] 校验：不雇自己（D2 允许同时雇主+雇工）；双方在线；宠物在家、没串门/打工；2–8h；
      1–100/h；硬币够；一个农场一个雇工、一只宠物一份合同
- [x] 雇佣：扣 `wage+fee`（fee 烧）；雇工进 `working`，出现在雇主桌面
      （`role:'worker'` + `badge:'work'`），主人侧「在外打工」；合同期内不能串门/被雇；
      自家守卫 0
- [x] 守卫：唯一 `farmGuard()`：`ownerHome = out===null && work===null`，`worker` 镜像存在；
      0.3/0.5/0.8；替换 43 的 `lookupFarmView` 占位、`guardParts`、`/state.farm.guard` 三处
- [x] 钱：无托管账户；雇佣时 `spendCoins(wage+fee)` + contracts pending/charged 两阶段；
      结算退 `wage−earned`、雇工主人铸 `earned`、fee 烧；`servedMs` 用雇主本地
      ackedAt→endedLocal，雇工主人重算并以自己的 ack 为准；WAL + fail-closed；
      重启 pending→退款取消、settled 不重复入账
- [x] 结算：`earned = floor(wage × servedMs / totalMs)`；召回/提前结束/任一方离线按最后
      心跳；`work-settle` 幂等、重连补发
- [x] 桌面：`role:'worker'` + `badge:'work'` 四层（PET_ROLES/normalizeScene/petScene/
      normalizeItem/renderer）；皮肤复用 `visitorSkins`；`self` 在 out/work 时消失；
      地块条 `controls.farm.owner.presence`（home/visiting/working）修 40 的「看家中」反向文案
- [x] 雇工页数据全由宿主 push：`farm-window` 加 contracts，全量 farm view 加
      hire/guard/worker；动作 `hire` / `recall-worker` / `end-contract` / `hire-listing`
      走六道窄口
- [x] 测试：contracts/rules 单测、room 单测、`protocol-work` 严格测试、两 service
      （挂牌→雇→worker 画面→0.8/0 被抓→结算）、fake peer 幂等、lossyRelay 丢
      request/ack/settle、desktopDouble、smoke；会红的 protocol/room/desktop 断言一起修
- [x] `npm test` + `npm run check` 全绿；不做：技能/等级、多个雇工、狗/篱笆、雇工自己偷菜

> 完成情况：room 的 `self.work` / `worker` 镜像与七个结束点；`contracts.json`（方向按 D3）+
> `contracts-rules`；8 种 `work-*` 报文与 ack 重放；真实 `available/reason/guard` 的挂牌；
> 两阶段资金 + WAL + 重启对账；`farmGuard()` 统一 0.3/0.5/0.8；桌面 `role:'worker'` +
> `badge:'work'`、`owner.presence`、雇工页；两 service/fake peer/lossyRelay/restart/
> desktopDouble 测试。
> 736/736（`npm test` 与 `npm run check`）。
> 偏离 / 留给 45：`docs/protocol.md`、`README.md`、`scripts/fake-peer.mjs` 未更新；
> `npm run smoke:desktop` 未执行（当前环境没有 Electron/display）；测试临时目录清理加了
> `rm maxRetries` 以压掉既有的 ENOTEMPTY flake。
> 提交：`59795e0`。
