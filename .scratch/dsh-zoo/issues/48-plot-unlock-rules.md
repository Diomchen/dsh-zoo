# 48: 地块解锁——规则、状态、市场深度与限额

**What to build:** 农场从固定 4 块变成「4 块起步、最多 50 块、按顺序用硬币解锁」。
地价 `round5(60 × 1.10^(n−5))`，总计 47,500，末块 4,375；解锁即时、烧币、不退不卖，
余额至少留 6 硬币。交易所的卖价冲击分母随已解锁数放大（`5 × 已解锁`），让一次收完
永远约跌 7.2%；偷菜/帮忙/日志上限随规模温和放大。旧存档保持 4 块。

**Blocked by:** None

**Status:** done

决策依据：[ADR-0017](../../../docs/adr/0017-plot-unlock-economics.md)。

- [x] `src/farm-rules.js`：`MAX_PLOTS = 50`、`START_PLOTS = 4`、`plotUnlockCost(unlocked)`
      （`round5(60 × 1.1^(k))`，越界返回 null）、`plotUnlockReserve()` = 最便宜种子价 6；
      纯函数，时间/随机不进来
- [x] `src/farm.js`：`PLOT_IDS` 扩到 p1–p50；`initialFarmState` 带 `unlocked: 4`；
      `normalizeFarmFile` 读 `unlocked`（缺省 4、夹在 4–50、坏值修补）；`toFileState` 写回；
      `farmView` 只回已解锁地块 + `unlocked` / `maxPlots` / `nextCost`
- [x] 锁着的地块不能被种/收/浇/施肥/偷/帮：`#plant`/`#harvest`/`#water`/`#fertilize`/
      `#markStolen`/`#markHelped` 统一按 `index < unlocked` 拒绝（`bad-plot`，不新增协议枚举）
- [x] `unlockPlot(expectedUnlocked)`：`max-plots` / `no-coin` / `reserve` / `stale` 四种失败；
      成功扣币、`unlocked+1`、写 `unlock` 日志（带 `cost`）、`#resetIdle`、落盘；
      返回新 `unlocked`/`cost`/`coins`/`plot`
- [x] `src/market.js`：`sellImpactPrice(price, base, qty, depth = SELL_IMPACT_QTY)`；
      `applyTrade` 接受 `depth`；农场卖作物时传 `5 × unlocked`（4 块时仍是 20，行为不变）
- [x] 限额改成随 `unlocked` 的函数：偷 `5+floor((n−4)/5)`/农场/天、`3+floor((n−4)/10)`/
      访客/农场、`10+floor((n−4)/10)`/访客/天（按访客自己农场）；帮忙同比例；
      `#markStolen`/`#markHelped`/`#visitLimits`/service 的访客预检与 `noteVisitAction`
      全部走同一组函数；日志 `MAX_FARM_LOG=200`、窗口 100、`/state` 仍 20
- [x] `src/service.js`：`farm-unlock`（HTTP 与 `farm-*` 桌面别名）接 `expectedUnlocked`；
      `/state.farm` 多 `unlocked`/`maxPlots`/`nextCost`；访客快照只发已解锁地块，
      `limits` 用主人当前规模；窗口 payload 同字段
- [x] 文档：`docs/protocol.md` 动作/错误码/限额/状态字段；README 农场段落与限额表
- [x] 测试：地价单调与锚点、旧存档 4 块、解锁四种失败、连点只成功一次、
      锁着的地块被拒、市场深度（4 块不变 / 50 块保持 7.2%）、限额随 n、日志 200、
      `/state` 与访客快照形状；`npm test` + `npm run check` 全绿

> 不做：卖地/退地、土地升级、按地块的作物解锁、协议新增错误枚举。

> 完成情况：`PLOT_IDS` 扩到 p1–p50；`unlocked` 进入 `farm.json`（缺失/坏值按 4）；
> 地价 `round5(60×1.10^(n−4))` 在 `farm-rules.js`（4→60，49→4,375，总计 47,500）；
> `farm-unlock` 四种失败（`max-plots`/`no-coin`/`reserve`/`stale`）+ `expectedUnlocked` 乐观锁；
> 锁着的地块在种/收/浇/施肥/偷/帮统一回 `bad-plot`；卖价深度 `5×unlocked`（4 块仍 20）；
> 偷/帮上限改 `visitLimitsFor(n)`，日志 200/100/20；协议 `PLOT_ID_RE` 放到 p1–p50。
> 测试：`farm-unlock.test.js` 11 条（含锁地收/偷/帮、坏 `unlocked`、待机重置、整茬深度）
> + `farm-window`/`farm-visit-e2e`/`state` 更新；
> `npm test` 768/768、`npm run check` 768/768（review 修复后）。旧存档不迁移、保持 4 块。
