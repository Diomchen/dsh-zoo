# 61: 雇佣时间——倒计时按真实时间走，且不倒流

**What to build:** 雇工页的合同「还剩 …」要跟真实时间一致，并且不能往回跳。用户原话：
「目前雇佣时间有问题，和之前菜地问题一样，时间不准，还会倒流」。

**Blocked by:** 无（ticket 47.1 修过地块的同一条毛病，合同这边漏了）

**Status:** done（2026-11-12）

## 症状与证据

两条独立的反馈回路，都在改之前是红的：

1. **真窗口**（`.scratch/dsh-zoo/debug-contract-clock/`，真 Electron + 真 `desktop/farm.html`
   + 真 `farm-preload.js`）推一份 `remainingMs = 90s` 的 active 合同：

   | 步骤 | 改之前 | 改之后 |
   | --- | --- | --- |
   | 空闲 3 秒 | 90 → 87（正常） | 90 → 88 |
   | 阻塞渲染进程 5 秒 | 87 → **86**（只走 1 秒） | 87 → **82** |
   | 切到农场页 3 秒再回来 | 86 → **89**（倒流） | 82 → **78** |

2. **两台机器的时钟差**（两个真 service，雇工那台 `contractNow` 快 30 分钟）：2 小时的
   合同，雇主窗口显示「还剩 150 分钟」，雇工自己显示 120 分钟；雇工慢 30 分钟时雇主显示
   90 分钟——差得更多会一成交就判过期。

## 根因（两条，都在「时间只存在于某一刻」上）

1. `desktop/farm.js` 的 `tickContracts()` 每拍 `entry.remaining -= 1000`：`setInterval`
   被后台节流/长任务延迟时秒数就不够了（时间不准）；而 `contractRow()` 每次都用**快照那
   一刻**的 `remainingMs` 重建，`renderHire()` 又会因为切页签/任何一次重画再跑一遍，于是
   倒计时被拽回旧值（时间倒流）。`ticket 47.1` 给地块换成「基线 + `Date.now()`」，合同漏了。
2. `src/service.js` 的 `handleWorkAck` 直接把 `work-ack` 里的 `startedAt` / `endsAt`
   （**雇工那台机器的绝对时间**）当成自己的合同锚点。两台机器的时钟差于是漏进
   `remainingMs` 和到期时刻：`windowView()` 的 `remainingMs = endsAt − 本机 now`。

## 改法

- `desktop/farm-view.js`：新增纯函数 `remainingAt(base, baseAt, now, fallback)`——基线减
  真实经过时间，时钟被调到过去也只停在原值。
- `desktop/farm.js`：
  - `onState` 里 `primeContractCountdowns()` 把基线记在**合同对象**上
    （`baseRemainingMs` / `baseAt`），与地块的 `primeCountdowns()` 同一条纪律；
  - `contractRemaining()` / `contractRemainingText()` 按基线算，`renderHire()` 重画不再
    从快照重建剩余时间；
  - `tickContracts()` 不再逐拍递减；到 0 只把行停在「马上结束」并
    `requestFarmRefresh()` 请宿主重推 `farm-refresh`——合同结没结束只认宿主的 `status`。
- `src/service.js`：雇主收到 ack 时用**本机**时钟当锚点（`startedAt = now`，
  `endsAt = now + hours × 1h`，`hours` 取自己那份 pending 记录），ack 里的时间只用于核对
  时长。两边各有一份锚点，但 `contractMs` 都是 `hours`，结算口径不变。

## 测试

- [x] `test/contract-countdown.test.js`（新）：把**真的** `desktop/farm.js` 跑进替身 DOM +
      可控时钟，三条用例分别抓「阻塞 5 秒」「切走再回来」「到 0 请宿主确认」；
      改之前三条全红（`剩 89 秒` / `89s → 90s` / 没发 `farm-refresh`）。
- [x] `test/work-e2e.test.js`：新增「雇工那台机器时钟快 30 分钟，雇主看到的合同时长仍是
      2 小时」；改之前 `startedAt` 差 1801817ms，改之后 ≈0 且 `remainingMs ≈ 120 分钟`。
- [x] 顺带修 `test/raid-inbound.test.js` 的过期断言：ticket 59 给 beacon 加了 `crops`
      能力，这条断言漏改（核心档不跑网络用例，一直没人发现）。HEAD 上就是红的。
      **注**：这个文件随后被[票 62](62-drop-lan-test-tier.md)整档删掉了，修好也只剩历史价值。
- [x] `npm test` 全绿（删网络档之前是 711，见票 62 之后是 708）；真窗口回路绿。

## 不做

- 不改协议字段（`work-ack` 仍带 `startedAt` / `endsAt`，只当「时长」的旁证）。
- 不给雇工页加每秒 push（宿主仍然只在事件上推快照，省电省带宽）。
- 不动结算/退款口径，不动 `servedMs` 的来源（仍只用雇主本地时钟）。
