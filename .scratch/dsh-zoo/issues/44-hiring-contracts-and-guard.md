# 44: 雇佣合同与雇工守卫

**What to build:** 主人可以挂牌把宠物租出去看家；雇主预付工资，雇工出现在雇主农场，守卫降低偷菜成功率；合同可召回/结束/按实际时长结算。雇工自家农场因此没人看。

**Blocked by:** 42, 43

**Status:** ready-for-agent

决策依据：[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)、[SPEC v5](../SPEC-v5.md)。

- [ ] 挂牌：`farm.hire = { enabled, wagePerHour, minHours:2, maxHours:8 }`；随
      `market-digest` 广播；农场窗「雇工」页：自己的开关/时薪/时段、邻居挂牌
      （只显示在线/在家/没在打工的；过期灰掉）、雇佣按钮与总价（工资 + 5%）
- [ ] `src/contracts.js`：`contracts.json` v1（`outgoing` / `incoming`）；损坏 → 默认 +
      只告警一次；串行 + tmp/rename；各 ≤20；`working` 状态与访问互斥
- [ ] 协议：`work-request` / `work-ack` / `work-recall(-ack)` / `work-end(-ack)` /
      `work-settle(-ack)`；4 KiB、UUID、枚举、字段白名单；重发按 `contractId` /
      `requestId` 幂等
- [ ] 校验：不能雇自己；双方在线；宠物在家、没在串门/打工；时长 2–8h；时薪 1–100；
      雇主硬币够；一个农场一个雇工、一只宠物一份合同
- [ ] 雇佣：扣 `工资 + 5%`（手续费烧掉）；雇工进 `working`，出现在雇主桌面地块旁
      （带「打工」角标）；主人侧显示「在外打工」，自家守卫 0；合同期内不能串门/被雇
- [ ] 守卫：主人宠物在家 0.3 + 雇工 0.5，相加封顶 0.8；与 43 的成功率/抓住逻辑合流；
      雇工不在线/合同结束 → 守卫消失
- [ ] 结算：`earned = floor(工资 × 服务毫秒 / 合同毫秒)`；主人拿 `earned`，雇主拿回剩余；
      5% 不退；`work-settle` 幂等；召回/提前结束/任一方离线按最后心跳结算，重连补发
- [ ] 集成：两 service + fake peer：挂牌→雇→雇工画面→守卫抓住→结算；召回/提前结束；
      离线结束；重复 settle 不双花；`npm test` 全绿
- [ ] 不做：技能/等级、多个雇工、狗/篱笆、雇工自己偷菜
