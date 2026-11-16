# 「稍微看一下就被送回自己农场」是怎么来的

现场：点邻居的房子（或农场窗顶部那颗邻居圆片）看田，窗口能正常开出「某某的农场」，
但**几秒到半分钟**之后自己跳回自己农场。没点任何东西；再点一次、还是会被送回来。

## 原因：宿主只记得访客视图，不记得"正在看谁家"

`src/service.js` 里，农场窗的模式每次刷新都要重算一遍：

```js
function farmWindowPayload ({ mode = null, ... }) {
  const out = outboundVisitForWindow()          // 我正在出门吗
  const effectiveMode = mode ?? (out === null ? 'owner' : 'visitor')
  ...
  ...(look === null ? {} : { look })            // look 是调用方显式传的
}
```

`refreshFarmWindow()` 只传 `{ open: false }`——于是 `mode` 回落到 `owner`、`look` 整块消失。
窗口的 `onState` 拿到的就是「回我的农场」这一包（`desktop/farm.js` 按 `payload.look` 判模式），
于是它照做。

刷新是**自动的**，这也是为什么"稍微看一下"就会中：

| 触发 | 频率 |
| --- | --- |
| 邻居行情摘要 `handleMarketDigest()` → `refreshFarmWindow()` | 每 30 秒一轮（放行过的邻居） |
| 有访客在我家偷/帮忙 `handleFarmActionFromGuest()` | 事件驱动，随时 |
| 作物目录热加载 `checkCropFiles()` | 文件变了就有 |
| 窗口倒计时到点 `farm-refresh` | 每秒巡检，到 0 就发 |

第四条还叠了一个窗口侧的错：`tickPlots()` 在看田模式下取的还是 `farm.plots`（**自家**地块），
所以**自己家**作物一熟就发 `farm-refresh` → 宿主重算成 owner → 看田窗口被踢回去；
同一个 id（p1…pN）的地块倒计时还被写进了邻居家的卡片。

而 `farm-refresh` 当时被当成「切回我的农场」用（顶部圆片就发它），
所以"到点确认"和"切回我家"是**同一条申请**——语义上就分不开。

## 修法

1. 宿主记一份 `farmWindowLook = { deviceId, view }`（`lookAtNeighborFarm` 写入，
   关窗/菜单开窗/`farm-own` 清掉）。
2. `refreshFarmWindow()` 在看田期间**什么都不发**：这一包里没有一项来自我家的农场，
   发过去只会被窗口当成"回我的农场"。要看新数据走 `refreshLookWindow()`（重拉邻居的公开视图）。
3. 窗口的两条自重画动作分开：
   - `farm-refresh`：倒计时到点，**保持当前视图**；看田期间宿主重拉一份邻居的公开视图。
   - `farm-own`：顶部「我的农场」圆片，显式切回自己农场（新增动作，只走 helper↔宿主这一跳）。
4. 窗口侧 `tickPlots()` 在看田模式下走 `look.plots`，`onState` 给它们也记倒计时基线。
5. 同一类顶替也顺手挡住了：`pushVisitState` / `pushVisitEnded` / `loadVisitFarm` 推访客视图前
   先看一眼 `farmWindowLook`——正在看别人家时，串门状态照记，但不拿访客页把只读视图换掉。

## 回归测试

- `test/farm-look-refresh.test.js`：回环上两只**真**宠物 + 只记录窗口命令的桌面替身。
  看田之后等 3.5 秒（邻居每 1 秒一轮行情摘要），断言**一条非 look 的窗口命令都没有**；
  再断言 `farm-refresh` 仍回 look、`farm-own` 才回 owner。
  这条用例在修之前是红的（`mode: 'owner'` 每 5 秒来一次）。
- `test/farm-look-window.test.js`：`farm-refresh` / `farm-own` 两条白名单，且 `farm-own`
  必须同时在 `FARM_ACTIONS` 与 `DESKTOP_ACTIONS` 里（helper → 宿主那一道也要认）。

## 为什么不是"关掉行情摘要刷新"

`refreshFarmWindow()` 那些调用点对**主人视图**都是对的（成交、种收、合同、挂牌都得立刻可见）。
问题只在"看别人的地"时它没有意义：只读视图里的守卫、额度、地块全是对方那一份快照。
所以按模式吞掉这一包，比在每个调用点加判断更不容易漏。
