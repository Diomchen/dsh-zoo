# SPEC v7 · 公开的农场：在家看田、派宠物去偷

> 承接 [ADR-0018](../../docs/adr/0018-farm-open-to-lan.md)。
> SPEC v5 / v6 的农场、帮忙、雇工、交易所、地块解锁全部保留；本文只改**看**与**偷**的关系。

**Status:** ready-for-agent

## Problem Statement

偷菜现在要走四步：放行 → 出门串门 → 到了 → 在小窗里找地。看田更是只有串门期间才能看。
于是"去邻居家偷一次"是一件需要先被允许、还要占用一次串门额度的事，结果大多数时候玩家
宁可在自己家刷一轮，也不去偷。

玩家要的是：**在家就能看见邻居的地，点一下，宠物自己去拿，拿完自己回来。**

## Solution

**看**和**偷**都不再需要放行；串门仍然是"被允许的来访"，偷是"不被允许但会发生的行为"。

1. **在家看田**：任何被发现的 v1.3 邻居，都能打开它的农场（只读）。视图只有地块、守卫和
   **你自己**的次数；没有对方的仓库、硬币和别人的 deviceId。
2. **派宠物去偷**：在查看窗里点一次「派它去偷」，宠物真的出门（自家守卫变 0），**出现在
   对方桌面上**（带「偷菜」角标），自动把这一趟能偷的都偷了，然后回家。
3. **一趟 = 一个邻居**：额度沿用旧的 `perVisit`（4 块时 3 个），回家时驮包清空、作物已在仓库。
4. **对面拦不住，但看得见**：守卫概率照旧掷；每块地每轮 1 次；日上限照旧；主人日志和
   toast 记着是谁。

## User Stories

1. 作为邻居，我想不串门就看到对方的地现在有什么熟的，以便决定值不值得跑一趟。
2. 作为偷菜的人，我想点一下就派宠物去偷，以便不用先放行、先出门、再找地。
3. 作为农场主，我想看见一只带「偷菜」角标的宠物在我地里干活，以便知道刚才发生了什么。
4. 作为农场主，我想在日志里看到谁偷了我几个什么，以便下次偷回去。
5. 作为出门偷菜的人，我想回家时驮包自动入账，以便不用担心路上关掉 DSH 就丢了。
6. 作为用老版本的邻居，我不该被新版本弄坏：我仍然能串门，也仍然能通过串门来偷。

## Implementation Decisions

### 领域与规则

- **放行**（admit）只控制入站串门（来玩）。`/dsh-zoo-farm/open` 与 `purpose:'steal'` 都不查它。
- **查看**（look）：在家读一次邻居农场的只读动作。不需要出门，也不改变任何状态。
- **行程**（trip）：一次「派它去偷」。一个邻居、一趟、一条记录。宠物真的出门（`self.out`
  非 null，自家守卫 0），但目的不是玩，是拿。
- **额度**：`perTrip = 3 + floor((n−4)/10)`（n = 主人已解锁数，与旧 `perVisit` 同值）。
  每块地每轮 1 次、`perFarm`/`perDay` 日上限公式全部不变。
- **守卫**：不变。每一次偷都单独掷一次；被抓 = 这块没拿到、**仍然计入额度**（沿用 v1.1）。
- **驮包与账**：偷到的那一刻就写进 `farm.json`（崩溃不吞）；驮包是"还没到家"的显示，
  行程结束时清空。重启后发现驮包有货而行程已不在 → 直接清空（作物已经在仓库里）。

### 协议

- `beacon` / `heartbeat` 加 `caps: ['raid','look']`（可选数组，老版本忽略）。缺省 = 只支持串门。
- `visit-request` 加两个可选字段：
  - `purpose: 'steal'`（缺省 = 普通串门）；
  - `plots: ['p2','p4']`（≤ 50 个 `pN`，去重；只对 `purpose:'steal'` 有意义）。
- `visit-ack` 加可选 `raid: { stolen:[{plot,crop}], caught, skipped:[pN] }`。
- 主机侧 `handleVisitRequest`：`purpose === 'steal'` **跳过放行检查**；其余（含未知 purpose）
  照旧。逐块校验成熟 / 没被这位偷过 / 日上限 / 这趟额度，成功就落账、写日志，
  失败分 `skip`（地块不合格）与 `caught`（守卫）。
- 幂等：同一个 `visitId` 重发 → `visit-ack` 原样重放（沿用 v1.1）。主机不进第二遍 store。
- 行程结束：收齐结果后**立刻**发 `visit-recall`；主机回 `visit-recall-ack` 并清掉 `kind:'raid'`
  的访客。硬上限 `RAID_MAX_MS = 60_000`，到点自己回家（不写串门记录，写一条 `kind:'raid'`）。

### 只读视图

`GET /dsh-zoo-farm/open/<viewerDeviceId>`（同一台 LAN 服务器，与 `/dsh-zoo-farm/<visitId>` 并列）：

```json
{ "v": 1, "deviceId": "主人的 id", "host": { "nickname": "小黄" },
  "guard": 0.3, "guardParts": { "ownerHome": true, "worker": false },
  "plots": [{ "id": "p1", "crop": "tomato", "stage": "mature", "mature": true,
              "remainingMs": 0, "stolenByMe": false, "helpedByMe": false }],
  "quotas": { "perTrip": 3, "perTripLeft": 3, "perFarmLeft": 5, "perDayLeft": 10 },
  "caps": ["raid", "look"], "at": 1794295962462 }
```

- `viewerDeviceId` 只用来算 `stolenByMe` / `helpedByMe` / `perTripLeft`，**不参与授权**。
- 404：形状不对、主人农场没起来。GET/HEAD、`no-store`、无路径、无别人的 deviceId。
- 拉取沿用 `src/farm-fetch.js` 的口径：2 秒超时、64 KiB 上限、只私网/回环、同一地址 60 秒冷却。

### 动作与契约

| 动作 | 入参 | 谁调用 |
|---|---|---|
| `farm-look` | `{ deviceId }` | 桌面/HTTP：拉一份公开视图，开只读窗 |
| `farm-raid` | `{ deviceId, plots? }` | 桌面/HTTP：派宠物去偷；省略 `plots` 就按"成熟且没被自己偷过"挑到额度 |
| `farm-steal` / `farm-help` | 沿用 | **仅**在串门期间有效（老流程保留） |

`farm-raid` 的本机校验：邻居有地址、`caps` 含 `raid`、自己没有正在进行的出门/打工、
这趟额度 > 0、标的不为空。任何一条不满足就回明确错误码（不是静默）。

### 界面

- 邻居小街点一户 / 右键邻居宠物 → 菜单两项：**「看看农场」**、**「派它去偷」**。
- 查看窗：复用农场小窗，新增 `mode: 'look'`——只画地块（作物、阶段、倒计时），顶部一句
  「「小黄」的农场 · 守卫 30% · 这趟最多 3 块」，底部一个按钮「派它去偷」。
  没有种/收/浇/买卖/解锁/雇工任何入口。
- 偷客：`role: 'visitor'` + `kind: 'raid'` + `badge: 'steal'`（新角标，和「打工」同一套）。
  能送客（送了就提前结束这一趟），不进 `visitors` 之外的任何新表。
- 老邻居：`caps` 少 `look`/`raid` 时两个菜单项禁用，文案「对方版本太老」。

## Testing Decisions

- `test/protocol-raid.test.js`：`purpose`/`plots`/`raid`/`caps` 的严格形状、`plots` 去重与 50 个上限、4 KiB。
- `test/lan-server.test.js`：`/open/` 的 GET/HEAD/404/`no-store`，以及**脱敏**——响应里不出现
  别人的 deviceId、`coins`、`crops`、路径。
- `test/raid-e2e.test.js`（两个真 service，**互相不放行**）：A `farm-raid` B →
  A 仓库 +1、A 的 `self.out` 期间自家 `guard` 为 0 → B 的 `farm.log` 有 `steal` 条目、
  B 的 `visitors` 里出现 `kind:'raid'` → A 回家后驮包清空、作物还在。
- `test/raid-guard.test.js`：守卫掷骰（`farmRandom` 注入）、被抓仍计额度、额度用完即停、
  每块地每轮 1 次、`perFarm`/`perDay` 封顶。
- `test/raid-restart.test.js`：偷到一半重启——作物不丢（已落盘）、驮包清空、不重复入账。
- `scripts/two-pets.mjs` 加 `look` 与 `raid` 两条命令，当人工验收；README「单机」那一节补三行。

## Out of Scope

- 「谢绝偷菜」/「谢绝被看」开关，成熟保护期，新手保护。
- 复仇、通缉、名声、偷菜排行榜。
- 多个邻居同时被派出去偷（一次只派一只）。
- 跨机账本、托管、反作弊（协议里没有身份验证，见 ADR-0018）。
- 偷客的专属动画/像素素材（沿用通用小人 + 角标）。

## Further Notes

- **它其实是"回到 ADR-0016 之前"**：那会儿串门只交换"我是谁/我在干嘛"，农场还不存在。
  这一版让农场回到"公开的世界状态"，而串门回到"被允许的来访"——两件事分开。
- **掉包的处理**：`visit-ack` 丢了 → 发起方 60 秒后按 `RAID_MAX_MS` 收尾，主机那侧访客到期
  自然清掉；`stolen` 的账已经在主机侧落好，不会双花。
- **为什么把结果塞进 `visit-ack` 而不是新报文**：ack 已经是幂等重放的载体，复用它在
  协议面只多一个字段、在实现上少一套 `requestId` 缓存。
