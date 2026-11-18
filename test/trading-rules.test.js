/**
 * 票 79/80/83：盘口纯规则的确定性。
 *
 * 只测外部行为——同一 seed 同一根的价格、slot/tick 边界、夹取范围、盈亏与结算取整、
 * 强平价与触线边界、止损档、逐 tick 路径检查（插针/跳 slot/离线补算的上限）、本周起点、
 * 到价挂单的目标价带与成交扫描。票 81 追加 K 线与风向，票 84 追加周期分桶与采样。
 * 票 86 追加**读得出来**的验收：日/周线收盘成段、总振幅远超单根振幅、周线实体不是针；
 * 以及「采样细化只改显示」的回归（结算/路径扫描仍只认 15 分钟与逐分钟格点）。
 * 不碰磁盘、不碰时钟、不联网；所有「现在」都是写死的本地时刻，行情是纯散列。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOARD_BAR_COUNT,
  BOARD_SIDES,
  BOARD_TIMEFRAMES,
  LEGACY_MAX_LEVERAGE,
  MAX_LEVERAGE,
  MAX_MARGIN,
  MAX_PATH_SCAN_MS,
  MAX_PATH_SCAN_SLOTS,
  PRICE_CEIL_RATIO,
  PRICE_FLOOR_RATIO,
  PRICE_SALT,
  SLOT_MS,
  SLOT_TICKS,
  TICK_MS,
  TRADING_CLOSE_REASONS,
  TRADING_LEVERAGES,
  TRADING_MARGINS,
  TRADING_STOP_LEVELS,
  boardCrops,
  boardPrice,
  barsFor,
  barsForTimeframe,
  hash32,
  hintOf,
  isBoardCrop,
  isBoardSide,
  isLiquidated,
  isStopLossHit,
  isStopLossLevel,
  isMarginAmount,
  isOrderTarget,
  isStoredLeverage,
  isTradingLeverage,
  liquidationPriceOf,
  limitFillScan,
  markPrice,
  pathScan,
  pnlOf,
  settlementOf,
  slotBounds,
  slotClosePrice,
  slotIndexAt,
  targetBandOf,
  weekStartOf
} from '../src/trading-rules.js'
import { CROP_IDS, CROPS, applyCropCatalog, resetCropCatalog } from '../src/farm-rules.js'

/** 正好落在 slot 边界上的一刻（1763308800000 / 900000 是整数）。 */
const SLOT_EDGE = 1763308800000
const SLOT = SLOT_EDGE / SLOT_MS
const BASE = 5
const HOUR_MS = 60 * 60 * 1000
/** 票 84 的固定「现在」：本地 2026-11-18（周三）13:37:25，离任何桶边界都很远。 */
// 绝对时刻（不是本地日历构造）：同一瞬间在任何 TZ 下都落在同一个 slot，
// 结算定值才不会随 CI（UTC）和本机（+08）漂移；本地日历相关的期望由下面的
// localDayStart/weekStartOf 自己算。
const TF_NOW = Date.UTC(2026, 10, 18, 5, 37, 25, 0)

/** 本地日历 +days 天的 00:00（测试自己算期望值，不调被测函数）。 */
function localDayStart (ms, days = 0) {
  const date = new Date(ms)
  date.setDate(date.getDate() + days)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 与 `barsForTimeframe()` 同一条采样口径的期望路径（只用来核对 OHLC）。 */
function sampledPath (crop, start, limit, stepMs) {
  const prices = []
  for (let at = start; at < limit; at += stepMs) prices.push(markPrice({ crop, now: at }))
  prices.push(markPrice({ crop, now: limit }))
  return prices
}

test('票 79：一根 15 分钟、15 个 1 分钟 tick；slot 落在纪元边界上', () => {
  assert.equal(SLOT_MS, 15 * 60 * 1000)
  assert.equal(SLOT_TICKS, 15)
  assert.equal(TICK_MS, 60 * 1000)
  assert.equal(slotIndexAt(SLOT_EDGE), SLOT)
  // 边界前后一格：同一毫秒属于新的一根。
  assert.equal(slotIndexAt(SLOT_EDGE - 1), SLOT - 1)
  assert.deepEqual(slotBounds(SLOT_EDGE + 7 * TICK_MS), {
    slot: SLOT,
    start: SLOT_EDGE,
    end: SLOT_EDGE + SLOT_MS
  })
  assert.equal(slotBounds('nope'), null)
})

test('票 79：同一作物 + slot + tick 在任何机器上是同一个价（纯散列，无 Math.random）', () => {
  const first = boardPrice({ crop: 'tomato', slot: SLOT, tick: 0 })
  const second = boardPrice({ crop: 'tomato', slot: SLOT, tick: 0 })
  assert.equal(first, second)
  // 中间插入别的计算不影响结果（没有隐藏的可变状态）。
  boardPrice({ crop: 'corn', slot: SLOT + 999, tick: 3 })
  assert.equal(boardPrice({ crop: 'tomato', slot: SLOT, tick: 0 }), first)
  // 散列本身是固定的：种子/盐一改就会在这里报警（票 102 把模型换成 v4 随机游走，老图作废）。
  assert.equal(PRICE_SALT, 'board-v5')
  assert.equal(hash32('board-v5:tomato'), 2831594673)
})

test('票 79：收盘价 = 下一根的开盘价，bar 之间连续', () => {
  for (const slot of [SLOT, SLOT + 1, SLOT + 77]) {
    assert.equal(
      slotClosePrice('tomato', slot),
      boardPrice({ crop: 'tomato', slot: slot + 1, tick: 0 })
    )
    assert.equal(
      boardPrice({ crop: 'tomato', slot, tick: SLOT_TICKS }),
      boardPrice({ crop: 'tomato', slot: slot + 1, tick: 0 })
    )
  }
})

test('票 79：价格夹在 0.55–1.75 倍底价，tick 之间不跳空', () => {
  let previous = null
  for (let slot = SLOT - 40; slot <= SLOT + 40; slot += 1) {
    const open = boardPrice({ crop: 'tomato', slot, tick: 0 })
    assert.ok(open >= BASE * PRICE_FLOOR_RATIO && open <= BASE * PRICE_CEIL_RATIO, '开盘价越界：' + open)
    for (let tick = 0; tick <= SLOT_TICKS; tick += 0.25) {
      const price = boardPrice({ crop: 'tomato', slot, tick })
      assert.ok(price >= BASE * PRICE_FLOOR_RATIO && price <= BASE * PRICE_CEIL_RATIO, '价格越界：' + price)
      // 1/4 个 tick（15 秒）内的变化不该超过底价的 2%：快噪声是连续插值的。
      if (previous !== null) assert.ok(Math.abs(price - previous) <= BASE * 0.02, '相邻 tick 跳空：' + price)
      previous = price
    }
  }
})

test('票 79：作物不同、slot 不同就是不同的图；参数坏掉返回 null', () => {
  const tomato = boardPrice({ crop: 'tomato', slot: SLOT, tick: 0 })
  const corn = boardPrice({ crop: 'corn', slot: SLOT, tick: 0 })
  assert.notEqual(tomato, corn)
  assert.notEqual(boardPrice({ crop: 'tomato', slot: SLOT + 1, tick: 0 }), tomato)
  assert.equal(boardPrice({ crop: 'nope', slot: SLOT, tick: 0 }), null)
  assert.equal(boardPrice({ crop: 'tomato', slot: 'x', tick: 0 }), null)
  assert.equal(boardPrice({ crop: 'tomato', slot: SLOT, tick: 'x' }), null)
  // tick 超出 [0, 15] 夹回边界，而不是算出另一张图。
  assert.equal(boardPrice({ crop: 'tomato', slot: SLOT, tick: 99 }), slotClosePrice('tomato', SLOT))
})

test('票 79：此刻的价格只由时间决定（1 分钟内恒定，跨分钟才走一步）', () => {
  const slot = SLOT
  assert.equal(markPrice({ crop: 'tomato', now: slot * SLOT_MS }), boardPrice({ crop: 'tomato', slot, tick: 0 }))
  assert.equal(
    markPrice({ crop: 'tomato', now: slot * SLOT_MS + 7.5 * TICK_MS }),
    boardPrice({ crop: 'tomato', slot, tick: 7.5 })
  )
  assert.equal(markPrice({ crop: 'tomato', now: 'nope' }), null)
  // v4 是分钟级随机游走：同一分钟之内价格恒定（不插值——插值等于把下一分钟的方向提前印出来），
  // 跨过整分钟才走一步，而不是毫秒连续。
  const start = slot * SLOT_MS + 3 * TICK_MS
  const within = markPrice({ crop: 'tomato', now: start })
  assert.equal(markPrice({ crop: 'tomato', now: start + TICK_MS - 1 }), within)
  const next = markPrice({ crop: 'tomato', now: start + TICK_MS })
  assert.notEqual(next, within)
  // 一步的幅度有上限：均匀增量 ±√3σ ≈ ±0.9%，远小于底价的 2%。
  assert.ok(Math.abs(next - within) <= CROPS.tomato.base * 0.02, '一分钟的步子太大：' + (next - within))
})

test('票 79：盈亏 = 保证金 × 杠杆 × 价格变化；做空反过来', () => {
  // 用二进制里能整除的价格（8 → 10 = +25%），断言精确值，不留浮点尾巴。
  assert.equal(pnlOf({ side: 'long', margin: 50, leverage: 1, entry: 8, mark: 10 }), 12.5)
  assert.equal(pnlOf({ side: 'short', margin: 50, leverage: 1, entry: 8, mark: 6 }), 12.5)
  assert.equal(pnlOf({ side: 'long', margin: 50, leverage: 1, entry: 8, mark: 6 }), -12.5)
  assert.equal(pnlOf({ side: 'short', margin: 50, leverage: 1, entry: 8, mark: 10 }), -12.5)
  // 杠杆只是乘数（票 80 才会开放 5×/20× 的下单）。
  assert.equal(pnlOf({ side: 'long', margin: 50, leverage: 5, entry: 8, mark: 10 }), 62.5)
  assert.equal(pnlOf({ side: 'long', margin: 50, leverage: 1, entry: 0, mark: 6 }), null)
  assert.equal(pnlOf({ side: 'sideways', margin: 50, leverage: 1, entry: 8, mark: 10 }), null)
})

test('票 79：结算按整数硬币四舍五入；亏损封顶保证金，硬币不会变负', () => {
  // +3.6 → +4，退回 104。
  assert.deepEqual(
    settlementOf({ side: 'long', margin: 100, leverage: 1, entry: 5, mark: 5.18 }),
    { pnl: 4, fee: 0, credit: 104 }
  )
  // −3.6 → −4。
  assert.deepEqual(
    settlementOf({ side: 'long', margin: 100, leverage: 1, entry: 5, mark: 4.82 }),
    { pnl: -4, fee: 0, credit: 96 }
  )
  // 价格归零也只亏掉保证金：pnl = −margin，退回 0（调用方跳过 addCoins）。
  assert.deepEqual(
    settlementOf({ side: 'long', margin: 50, leverage: 1, entry: 5, mark: 0 }),
    { pnl: -50, fee: 0, credit: 0 }
  )
  // 做空方向反过来，封顶同样只看 margin。
  assert.deepEqual(
    settlementOf({ side: 'short', margin: 100, leverage: 1, entry: 5, mark: 50 }),
    { pnl: -100, fee: 0, credit: 0 }
  )
  assert.equal(settlementOf({ side: 'long', margin: 0, leverage: 1, entry: 5, mark: 6 }), null)
})

test('票 79：本周起点是本地周一 00:00（周一自己、周日深夜、周二都算对）', () => {
  const monday = new Date(2026, 10, 16, 0, 0, 0, 0).getTime()
  assert.equal(weekStartOf(monday), monday)
  assert.equal(weekStartOf(new Date(2026, 10, 18, 15, 30).getTime()), monday)
  assert.equal(weekStartOf(new Date(2026, 10, 17, 9, 0).getTime()), monday)
  assert.equal(weekStartOf(new Date(2026, 10, 22, 23, 59, 59).getTime()), monday)
  // 下周一就是新的一周。
  assert.equal(weekStartOf(new Date(2026, 10, 23, 0, 0, 0, 0).getTime()), new Date(2026, 10, 23).getTime())
  assert.equal(weekStartOf('nope'), null)
})

test('票 80/81/83：下单白名单是 1×/5×/20×、50/100/250、目录作物、多空；止损四档含 0=关', () => {
  // 票 88 起盘口的作物清单跟随运行时目录：顺序就是窗口页签的顺序，
  // 目录里第一个（tomato 仍在首位）是 payload.bar 的来源。
  assert.deepEqual(boardCrops(), CROP_IDS)
  // 票 83：三档预设 + 窗口的「全下」；保证金规则本身接受任意整数（见下一条）。
  assert.deepEqual(TRADING_MARGINS, [50, 100, 250])
  assert.deepEqual(TRADING_LEVERAGES, [1, 5])
  assert.deepEqual(BOARD_SIDES, ['long', 'short'])
  // 结算原因固定四种：手动 / 收盘 / 强平 / 止损（历史行就按这个写）。
  assert.deepEqual(TRADING_CLOSE_REASONS, ['close', 'settle', 'liquidate', 'stop'])
  // 0 是「关」，不是「−0%」：默认不设止损也能玩。
  assert.deepEqual(TRADING_STOP_LEVELS, [0, 0.25, 0.5, 1])
  assert.equal(isBoardCrop('tomato'), true)
  assert.equal(isBoardCrop('carrot'), true)
  assert.equal(isBoardCrop('pumpkin'), true)
  // 票 88：目录里的十种都上盘口（corn 不再被写死的三作物名单挡掉）。
  assert.equal(isBoardCrop('corn'), true)
  assert.equal(isBoardCrop('dragonfruit'), false)
  assert.equal(isBoardSide('long'), true)
  assert.equal(isBoardSide('up'), false)
  assert.equal(isMarginAmount(50), true)
  // 票 83：不限于预设——「全下」/自定义整数金额都是合法形状。
  assert.equal(isMarginAmount(51), true)
  assert.equal(isMarginAmount(MAX_MARGIN), true)
  assert.equal(isMarginAmount(MAX_MARGIN + 1), false)
  assert.equal(isMarginAmount(0), false)
  assert.equal(isMarginAmount(-50), false)
  assert.equal(isMarginAmount(50.5), false)
  assert.equal(isMarginAmount('50'), false)
  assert.equal(isTradingLeverage(1), true)
  assert.equal(isTradingLeverage(5), true)
  // 票 101：20× 从下单白名单拿掉了，老仓位仍要能读回来（见下一条）。
  assert.equal(isTradingLeverage(20), false)
  assert.equal(isTradingLeverage(2), false)
  assert.equal(isTradingLeverage('5'), false)
  assert.equal(isStopLossLevel(0), true)
  assert.equal(isStopLossLevel(0.25), true)
  assert.equal(isStopLossLevel(1), true)
  assert.equal(isStopLossLevel(0.3), false)
  assert.equal(isStopLossLevel('0.5'), false)
  // 读盘只按形状（5×/20× 写进文件后仍要能读回来）。
  assert.equal(isStoredLeverage(20), true)
  assert.equal(isStoredLeverage(LEGACY_MAX_LEVERAGE), true)
  assert.equal(isStoredLeverage(LEGACY_MAX_LEVERAGE + 1), false)
  assert.equal(isStoredLeverage(0), false)
})

/**
 * 票 88 / ADR-0031：盘口作物清单跟随运行时目录，不再写死三个。
 * 这里用**真实的十种内置作物**断言顺序与数量：新增作物只要目录里有，盘口自动跟上。
 */
test('票 88：盘口作物 = 目录里有底价的全部作物，十种全上榜、顺序同目录', () => {
  assert.deepEqual(boardCrops(), CROP_IDS)
  assert.deepEqual(boardCrops(), [
    'pea', 'tomato', 'strawberry', 'radish', 'carrot',
    'rice', 'corn', 'watermelon', 'pumpkin', 'grape'
  ])
  for (const crop of boardCrops()) {
    assert.ok(CROPS[crop].base > 0, crop + ' 应该有正底价')
    assert.equal(isBoardCrop(crop), true, crop + ' 应该可以下单')
  }
  // 目录里没有的 id 仍然不是盘口作物（协议整包丢就靠它）。
  assert.equal(isBoardCrop('dragonfruit'), false)
  assert.equal(isBoardCrop('tomato '), false)
  assert.equal(isBoardCrop(5), false)
})

/**
 * 票 88：运行时新增一种作物（`applyCropCatalog()`，也就是本机 crops.json 或 LAN 同步
 * 走的那条路）后，不用改代码就能出现在盘口、出图、算风向；坏底价/缺底价的作物
 * 在**所有**入口都被忽略。测完 `resetCropCatalog()` 还原，绝不把目录留给下一个用例。
 */
test('票 88：运行时新增作物立刻上盘口；坏底价/缺底价被忽略（测完还原）', (t) => {
  t.after(() => resetCropCatalog())
  const added = applyCropCatalog([
    // 5 小时：正好落在 corn（4 小时）与 watermelon（6 小时）之间，用来核对顺序。
    { id: 'blueberry', name: '蓝莓', growMs: 5 * HOUR_MS, seedPrice: 40, yield: 4, base: 12 },
    { id: 'no-base', name: '没底价', growMs: 6 * HOUR_MS, seedPrice: 10, yield: 1 },
    { id: 'bad-base', name: '坏底价', growMs: 6 * HOUR_MS, seedPrice: 10, yield: 1, base: 0 }
  ])
  assert.deepEqual(added, ['blueberry', 'no-base', 'bad-base'])
  const crops = boardCrops()
  // 盘口清单 = 目录顺序，但坏底价的两种被跳过（不是排在末尾、也不是画空图）。
  assert.deepEqual(crops, CROP_IDS.filter((id) => id !== 'no-base' && id !== 'bad-base'))
  assert.deepEqual(crops.slice(0, 8),
    ['pea', 'tomato', 'strawberry', 'radish', 'carrot', 'rice', 'corn', 'blueberry'])
  assert.equal(isBoardCrop('blueberry'), true)
  assert.equal(isBoardCrop('no-base'), false)
  assert.equal(isBoardCrop('bad-base'), false)

  // 新作物的行情入口全部可用（盘口图、粗周期、风向、到价带）。
  const chart = barsFor({ crop: 'blueberry', now: TF_NOW })
  assert.equal(chart.base, 12)
  assert.equal(chart.bars.length, BOARD_BAR_COUNT)
  assert.equal(barsForTimeframe({ crop: 'blueberry', now: TF_NOW, timeframe: '1w' }).bars.length, BOARD_BAR_COUNT)
  assert.ok(markPrice({ crop: 'blueberry', now: TF_NOW }) > 0)
  assert.ok(hintOf({ crop: 'blueberry', now: TF_NOW }) !== null)
  assert.deepEqual(targetBandOf({ crop: 'blueberry' }),
    { min: 12 * PRICE_FLOOR_RATIO, max: 12 * PRICE_CEIL_RATIO })

  // 坏底价/缺底价：同一个入口全部返回 null，盘口不会为它画一张假图。
  assert.equal(markPrice({ crop: 'no-base', now: TF_NOW }), null)
  assert.equal(barsFor({ crop: 'bad-base', now: TF_NOW }), null)
  assert.equal(barsForTimeframe({ crop: 'no-base', now: TF_NOW, timeframe: '1h' }), null)
  assert.equal(hintOf({ crop: 'bad-base', now: TF_NOW }), null)
  assert.equal(targetBandOf({ crop: 'no-base' }), null)
})

test('票 101：强平价 = 维持保证金 5%（0.95/杠杆）；做多往下、做空往上；1× 没有强平线', () => {
  // 用二进制里能整除的价格（8）断言精确值，不留浮点尾巴。
  // 5× 的强平线从「亏光」的 −20% 收到 −19%（权益只剩 5%）；8 × 0.81 = 6.48。
  assert.equal(liquidationPriceOf({ side: 'long', entry: 8, leverage: 5 }), 8 * 0.81)
  assert.equal(liquidationPriceOf({ side: 'short', entry: 8, leverage: 5 }), 8 * 1.19)
  // 老仓位的 20× 仍按同一条公式算：8 × 0.9525。
  assert.equal(liquidationPriceOf({ side: 'long', entry: 8, leverage: 20 }), 8 * 0.9525)
  assert.equal(liquidationPriceOf({ side: 'short', entry: 8, leverage: 20 }), 8 * 1.0475)
  // 1× 要跌到 0 才亏光，而价格有底价：没有强平线，窗口画「—」。
  assert.equal(liquidationPriceOf({ side: 'long', entry: 8, leverage: 1 }), null)
  assert.equal(liquidationPriceOf({ side: 'short', entry: 8, leverage: 1 }), null)
  // 坏输入不凭空造一条线。
  assert.equal(liquidationPriceOf({ side: 'up', entry: 8, leverage: 5 }), null)
  assert.equal(liquidationPriceOf({ side: 'long', entry: 0, leverage: 5 }), null)
  assert.equal(liquidationPriceOf({ side: 'long', entry: 'x', leverage: 5 }), null)
  // 强平价正好是「权益只剩保证金的 5%」那一点：pnl = −0.95 × margin（两条公式同源）。
  for (const leverage of [5, 20]) {
    for (const side of ['long', 'short']) {
      const line = liquidationPriceOf({ side, entry: 8, leverage })
      const pnl = pnlOf({ side, margin: 50, leverage, entry: 8, mark: line })
      assert.ok(
        Math.abs(pnl + 0.95 * 50) < 1e-9,
        side + ' ' + leverage + '× 在强平价只剩 5% 权益（' + pnl + '）'
      )
    }
  }
})

test('票 80：强平触线——mark 等于线也算（做多 ≤ / 做空 ≥），过线一点点就触发', () => {
  const liqLong = liquidationPriceOf({ side: 'long', entry: 8, leverage: 5 })
  assert.equal(isLiquidated({ side: 'long', mark: liqLong, liquidation: liqLong }), true, '相等也算')
  assert.equal(isLiquidated({ side: 'long', mark: liqLong - 0.01, liquidation: liqLong }), true)
  assert.equal(isLiquidated({ side: 'long', mark: liqLong + 0.01, liquidation: liqLong }), false)
  const liqShort = liquidationPriceOf({ side: 'short', entry: 8, leverage: 5 })
  assert.equal(isLiquidated({ side: 'short', mark: liqShort, liquidation: liqShort }), true, '相等也算')
  assert.equal(isLiquidated({ side: 'short', mark: liqShort + 0.01, liquidation: liqShort }), true)
  assert.equal(isLiquidated({ side: 'short', mark: liqShort - 0.01, liquidation: liqShort }), false)
  // 没有强平线（1×）永远不触发；坏输入也不触发。
  assert.equal(isLiquidated({ side: 'long', mark: 0.01, liquidation: null }), false)
  assert.equal(isLiquidated({ side: 'long', mark: 'x', liquidation: 6 }), false)
  assert.equal(isLiquidated({ side: 'up', mark: 1, liquidation: 6 }), false)
})

test('票 80：止损档按「亏掉多少保证金」算；默认关；相等也算触发', () => {
  // 精确值：margin 64、entry 8、1× —— mark 4/6/0 正好是 −50%/−25%/−100% 保证金。
  const at = (mark, stopLoss) => isStopLossHit({ side: 'long', margin: 64, leverage: 1, entry: 8, mark, stopLoss })
  assert.equal(at(8, 0.25), false)
  assert.equal(at(6, 0.25), true, '−25% 保证金：相等也算')
  assert.equal(at(6.4, 0.25), false)
  assert.equal(at(4, 0.5), true, '−50% 保证金')
  assert.equal(at(4.1, 0.5), false)
  assert.equal(at(0, 1), true, '−100% 保证金是真档位，能关在亏光那一刻')
  assert.equal(at(0.1, 1), false)
  // 默认关：再深的浮亏也不触发（玩家不设，系统就不强加风控）。
  assert.equal(at(0, 0), false)
  assert.equal(at(0.1, 0), false)
  // 杠杆只是把亏损放大：5× 的 −2.5% 价格就是 −50% 保证金附近。
  assert.equal(isStopLossHit({ side: 'short', margin: 100, leverage: 5, entry: 8, mark: 8.5, stopLoss: 0.25 }), true)
  assert.equal(isStopLossHit({ side: 'short', margin: 100, leverage: 5, entry: 8, mark: 8.1, stopLoss: 0.25 }), false)
  // 坏档位/坏输入一律不触发。
  assert.equal(isStopLossHit({ side: 'long', margin: 64, leverage: 1, entry: 8, mark: 0, stopLoss: 0.3 }), false)
  assert.equal(isStopLossHit({ side: 'up', margin: 64, leverage: 1, entry: 8, mark: 0, stopLoss: 1 }), false)
})

/**
 * 在某一根里按**绝对分钟格点**（与 `pathScan` 同一条网格）取最低/最高价。
 * 只用来给测试挑一根「插针根」，不参与任何结算。
 */
function extremesOf (slot) {
  let low = null
  let high = null
  for (let tick = 0; tick <= SLOT_TICKS; tick += 1) {
    const price = boardPrice({ crop: 'tomato', slot, tick })
    if (low === null || price < low.price) low = { tick, price }
    if (high === null || price > high.price) high = { tick, price }
  }
  return { low, high, open: boardPrice({ crop: 'tomato', slot, tick: 0 }), close: slotClosePrice('tomato', slot) }
}

/**
 * 找一根「中间插针、收盘回去」的行情，并给一支做多仓位挑好入场价：
 * 插针那一下 20× 亏光（−6%），收盘时只亏 4%（不触发 −5% 强平线）。
 * 行情是确定性的，所以这里只是遍历几根，不用随机也不用 sleep。
 */
function spikeLong (startSlot) {
  for (let slot = startSlot; slot < startSlot + 200; slot += 1) {
    const { low, close } = extremesOf(slot)
    const entry = low.price / 0.94
    if (close > entry * 0.95) return { slot, entry, close, low }
  }
  throw new Error('找不到合适的插针根（行情规则改了？）')
}

test('票 80：路径检查逐分钟走——插针在收盘价上看不见，也必须强平', () => {
  // 入场价选在「插针会亏光、收盘不会」之间：20× 的强平线是 −5%。
  const { slot, entry, close } = spikeLong(SLOT + 3)
  const from = slot * SLOT_MS
  const to = (slot + 1) * SLOT_MS

  const hit = pathScan({
    crop: 'tomato',
    side: 'long',
    margin: 50,
    leverage: 20,
    entry,
    from,
    to
  })
  assert.notEqual(hit, null, '插针那一下必须被扫到')
  assert.equal(hit.reason, 'liquidate')
  assert.ok(hit.exit <= liquidationPriceOf({ side: 'long', entry, leverage: 20 }))
  assert.ok(hit.at >= from && hit.at <= to)
  // 只看端点会得出「没事」——这正是票 80 要防的那个 bug。
  assert.equal(
    isLiquidated({ side: 'long', mark: close, liquidation: liquidationPriceOf({ side: 'long', entry, leverage: 20 }) }),
    false
  )
  // 做空相反方向：入场贴近这一根的最高价，涨 4% 都不到强平线（+5%）。
  const { high } = extremesOf(slot)
  assert.equal(
    pathScan({
      crop: 'tomato',
      side: 'short',
      margin: 50,
      leverage: 20,
      entry: high.price / 1.04,
      from,
      to
    }),
    null
  )
})

test('票 80：跳过多根也逐根扫；先撞到的那一处算（不是收盘那一点）', () => {
  const { slot, entry } = spikeLong(SLOT + 5)
  const from = slot * SLOT_MS
  // 时钟从开仓直接跳过 3 根：路径上第一处触发仍然在第 1 根里。
  const hit = pathScan({
    crop: 'tomato',
    side: 'long',
    margin: 50,
    leverage: 20,
    entry,
    from,
    to: (slot + 3) * SLOT_MS
  })
  assert.notEqual(hit, null)
  assert.equal(hit.reason, 'liquidate')
  assert.ok(hit.at < (slot + 1) * SLOT_MS, '第一处触发就在开仓那一根里')
  // 止损同理：−25% 保证金在 5× 是 −5% 价格，先于 −20% 的强平线撞到。
  const stopHit = pathScan({
    crop: 'tomato',
    side: 'long',
    margin: 50,
    leverage: 5,
    entry,
    stopLoss: 0.25,
    from,
    to: (slot + 3) * SLOT_MS
  })
  assert.notEqual(stopHit, null)
  assert.equal(stopHit.reason, 'stop')
  // 没设档位、也没有强平线的 1×：整条路径都不触发（默认关）。
  assert.equal(
    pathScan({
      crop: 'tomato',
      side: 'long',
      margin: 50,
      leverage: 1,
      entry: 1,
      from,
      to: (slot + 3) * SLOT_MS
    }),
    null
  )
})

/**
 * 给「补算上限」造一组参数：前 3 天（窗口内）怎么走都碰不到强平线，
 * 第 4 天起才跌穿它。返回 `{ start, entry, from, to }`；找不到就抛——
 * 抛出来说明行情规则变了，用例该重新挑点，而不是悄悄放过。
 *
 * 起点按**一天**（96 根）跳着找，不是逐根：票 86 的慢波最长到 12 周，
 * 连着 60 根只有 15 小时，几乎停在同一个相位上，找不到「窗口内安全、之后才跌」的一段。
 */
function beyondCap (seed) {
  for (let start = seed; start < seed + 60 * 96; start += 96) {
    let floor = Infinity
    for (let slot = start; slot < start + MAX_PATH_SCAN_SLOTS; slot += 1) {
      floor = Math.min(floor, extremesOf(slot).low.price)
    }
    // 强平线放在窗口最低价再低 0.1%：窗口里一秒都不该触发。
    // 票 101：20× 的强平线是 0.9525 × entry（维持保证金 5%），不是老口径的 0.95。
    const entry = (floor / (1 - 0.95 / 20)) * 0.999
    const capEnd = start + MAX_PATH_SCAN_SLOTS
    for (let slot = capEnd; slot < capEnd + 480; slot += 1) {
      if (extremesOf(slot).low.price < floor * 0.998) {
        return { start, entry, from: start * SLOT_MS, to: (capEnd + 480) * SLOT_MS }
      }
    }
  }
  throw new Error('找不到「窗口内安全、窗口外才插针」的行情（行情规则改了？）')
}

test('票 80：离线补算的循环有界——超过 3 天的部分不逐 tick 扫', () => {
  assert.equal(MAX_PATH_SCAN_SLOTS, 288)
  assert.equal(MAX_PATH_SCAN_MS, 3 * 24 * 60 * 60 * 1000)
  const { slot, entry } = spikeLong(SLOT + 7)
  const from = slot * SLOT_MS
  // 触发点在窗口之内：照常找到。
  assert.notEqual(
    pathScan({
      crop: 'tomato',
      side: 'long',
      margin: 50,
      leverage: 20,
      entry,
      from,
      to: from + MAX_PATH_SCAN_MS
    }),
    null
  )
  // 触发点远在窗口之外（第 4 天起才插针）：不再逐分钟扫，返回 null，
  // 剩下的由调用方按「那一根的收盘价」结——这就是上限的降级口径。
  const far = beyondCap(SLOT + 7)
  assert.equal(
    pathScan({
      crop: 'tomato',
      side: 'long',
      margin: 50,
      leverage: 20,
      entry: far.entry,
      from: far.from,
      to: far.to
    }),
    null
  )
  // 参数坏掉/时间为倒序：没有路径可扫。
  assert.equal(pathScan({ crop: 'tomato', side: 'long', entry, margin: 50, from, to: from }), null)
  assert.equal(pathScan({ crop: 'nope', side: 'long', entry, margin: 50, leverage: 20, from, to: from + SLOT_MS }), null)
  assert.equal(pathScan({ crop: 'tomato', side: 'up', entry, margin: 50, from, to: from + SLOT_MS }), null)
})

test('票 81：K 线是最近 24 根整根 + 当前一根；开=上一根收，高低夹住开收', () => {
  const now = SLOT_EDGE + 5 * TICK_MS + 20 * 1000
  const chart = barsFor({ crop: 'tomato', now })
  assert.equal(chart.base, BASE)
  assert.equal(chart.bars.length, BOARD_BAR_COUNT)
  assert.equal(chart.bars.length, 24)
  // 同一时刻算两次是同一张图（纯散列，没有隐藏状态）。
  assert.deepEqual(barsFor({ crop: 'tomato', now }), chart)
  for (let index = 0; index < chart.bars.length; index += 1) {
    const bar = chart.bars[index]
    assert.equal(bar.open, boardPrice({ crop: 'tomato', slot: bar.slot, tick: 0 }))
    assert.equal(bar.close, boardPrice({ crop: 'tomato', slot: bar.slot, tick: SLOT_TICKS }))
    assert.ok(bar.high >= Math.max(bar.open, bar.close), '最高价要盖住开盘和收盘：' + bar.slot)
    assert.ok(bar.low <= Math.min(bar.open, bar.close), '最低价要盖住开盘和收盘：' + bar.slot)
    assert.ok(bar.low <= bar.high, '最低不高于最高：' + bar.slot)
    if (index > 0) {
      // slot 连续 + 收盘 = 下一根开盘：图上的两根之间没有缝。
      assert.equal(bar.slot, chart.bars[index - 1].slot + 1)
      assert.equal(bar.open, chart.bars[index - 1].close)
    }
  }
  // 最后一根是「刚刚收掉」的那根，它的收盘就是当前根的开盘。
  assert.equal(chart.bars.at(-1).slot, chart.current.slot - 1)
  assert.equal(chart.bars.at(-1).close, chart.current.open)
  // 当前一根的 slot / tick / 倒计时。
  assert.equal(chart.current.slot, slotIndexAt(now))
  // tick 保留两位小数：窗口只用它画「本根第几分钟」，不需要毫秒级。
  assert.equal(chart.current.tick, 5.33)
  assert.equal(chart.current.remainingMs, SLOT_MS - 5 * TICK_MS - 20 * 1000)
  assert.equal(chart.current.price, markPrice({ crop: 'tomato', now }))
  assert.ok(chart.current.high <= BASE * PRICE_CEIL_RATIO, '现价也要被夹在底价的 1.75 倍里')
  assert.ok(chart.current.low >= BASE * PRICE_FLOOR_RATIO)
  // 根数可选，但坏输入不抛：窗口按 payload 画，坏包只是空态。
  assert.equal(barsFor({ crop: 'tomato', now, count: 3 }).bars.length, 3)
  assert.equal(barsFor({ crop: 'tomato', now, count: 0 }).bars.length, 1)
  assert.equal(barsFor({ crop: 'tomato', now, count: 999 }).bars.length < 999, true)
  assert.equal(barsFor({ crop: 'tomato', now, count: 'x' }).bars.length, 24)
  assert.equal(barsFor({ crop: 'nope', now }), null)
  assert.equal(barsFor({ crop: 'tomato', now: 'x' }), null)
  assert.equal(barsFor(), null)
})

test('票 81：当前一根按 1 分钟 tick 前进，收盘那一毫秒换成下一根', () => {
  const atOpen = SLOT_EDGE
  const open = barsFor({ crop: 'tomato', now: atOpen })
  assert.equal(open.current.tick, 0)
  assert.equal(open.current.price, open.current.open)
  assert.equal(open.current.remainingMs, SLOT_MS)
  // 过一分钟：tick +1，价格与倒计时都跟着走，但 slot 不变。
  const afterMinute = barsFor({ crop: 'tomato', now: atOpen + TICK_MS })
  assert.equal(afterMinute.current.slot, open.current.slot)
  assert.equal(afterMinute.current.tick, 1)
  assert.equal(afterMinute.current.price, boardPrice({ crop: 'tomato', slot: open.current.slot, tick: 1 }))
  assert.equal(afterMinute.current.remainingMs, SLOT_MS - TICK_MS)
  // 半分钟也算得出小数 tick（窗口每秒重画，价格不会一分钟一跳）。
  const half = barsFor({ crop: 'tomato', now: atOpen + 7.5 * TICK_MS })
  assert.equal(half.current.tick, 7.5)
  assert.ok(half.current.high >= half.current.price && half.current.low <= half.current.price)
  // 收盘那一毫秒属于下一根：旧根的收盘价就是新根的开盘价。
  const next = barsFor({ crop: 'tomato', now: SLOT_EDGE + SLOT_MS })
  assert.equal(next.current.slot, open.current.slot + 1)
  assert.equal(next.current.tick, 0)
  assert.equal(next.current.open, slotClosePrice('tomato', open.current.slot))
})

/**
 * 票 84 的每条断言都从同一个固定 `now` 出发：粗周期只改「怎么分桶/怎么采样」，
 * 不该改价格公式。15 分那一条直接对着 `barsFor()` 比，语义一个字都不许动。
 */
test('票 84：周期清单只有一份（15分/1时/1日/1周）；15 分仍走 barsFor，坏输入是 null', () => {
  assert.deepEqual(
    BOARD_TIMEFRAMES.map(({ id, label }) => [id, label]),
    [['15m', '15分'], ['1h', '1时'], ['1d', '1日'], ['1w', '1周']]
  )
  assert.equal(Object.isFrozen(BOARD_TIMEFRAMES), true)
  // 15 分不是「另算一遍」：同一份数据、同一个形状（多出来的 start/end 在 barsFor 里）。
  assert.deepEqual(
    barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe: '15m' }),
    barsFor({ crop: 'tomato', now: TF_NOW })
  )
  assert.equal(barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe: '5m' }), null)
  assert.equal(barsForTimeframe({ crop: 'nope', now: TF_NOW, timeframe: '1h' }), null)
  assert.equal(barsForTimeframe({ crop: 'tomato', now: 'x', timeframe: '1h' }), null)
  assert.equal(barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe: '1h', count: 'x' }).bars.length, 24)
  assert.equal(barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe: '1h', count: 3 }).bars.length, 3)
  assert.equal(barsForTimeframe(), null)
})

test('票 84：1时/1日/1周各 24 根 + 当前一根，桶首尾相接、各周期起点对齐', () => {
  const boundsOf = {
    // 1 时：纪元整点（全世界同一条线，和 slot 一样）。
    '1h': Math.floor(TF_NOW / HOUR_MS) * HOUR_MS,
    // 1 日：本地自然日 00:00。
    '1d': new Date(2026, 10, 18).getTime(),
    // 1 周：本地周一 00:00。
    '1w': weekStartOf(TF_NOW)
  }
  for (const { id } of BOARD_TIMEFRAMES) {
    if (id === '15m') continue
    const chart = barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe: id })
    assert.notEqual(chart, null, id + ' 应该有图')
    assert.equal(chart.base, BASE)
    assert.equal(chart.bars.length, 24, id + ' 是 24 根整根')
    assert.equal(chart.current.start, boundsOf[id], id + ' 桶起点')
    assert.ok(chart.current.start <= TF_NOW && TF_NOW < chart.current.end, id + ' 现在落在当前桶里')
    assert.equal(chart.current.remainingMs, chart.current.end - TF_NOW)
    assert.equal(chart.current.price, markPrice({ crop: 'tomato', now: TF_NOW }))
    // 粗周期没有「本根第几分钟」：窗口据此不画 `第 m/15 分钟`。
    assert.equal(chart.current.tick, null)
    for (let index = 0; index < chart.bars.length; index += 1) {
      const bar = chart.bars[index]
      assert.ok(Number.isInteger(bar.start) && Number.isInteger(bar.end), id + ' 的 start/end 是整数毫秒')
      assert.ok(bar.end > bar.start, id + ' 的 end 在 start 之后')
      assert.ok(bar.high >= Math.max(bar.open, bar.close), id + ' 高点盖住开收：' + bar.start)
      assert.ok(bar.low <= Math.min(bar.open, bar.close), id + ' 低点盖住开收：' + bar.start)
      if (index > 0) {
        // 桶首尾相接：上一根的收盘时刻就是下一根的开盘时刻（采样同一点，价格相同）。
        assert.equal(bar.start, chart.bars[index - 1].end, id + ' 桶之间没有缝')
        assert.equal(bar.open, chart.bars[index - 1].close, id + ' 收盘 = 下一根开盘')
      }
    }
    assert.equal(chart.bars.at(-1).end, chart.current.start)
    assert.equal(chart.bars.at(-1).close, chart.current.open)
  }
})

test('票 84：1 日按本地自然日、1 周按本地周一 00:00 分桶', () => {
  const day = barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe: '1d' })
  // 当前桶 = 本地 2026-11-18 00:00；24 天前同样落在本地 00:00（不是「减 24×N 小时」）。
  assert.equal(day.current.start, new Date(2026, 10, 18).getTime())
  assert.equal(day.current.end, new Date(2026, 10, 19).getTime())
  assert.equal(day.bars[0].start, localDayStart(new Date(2026, 10, 18).getTime(), -24))
  assert.equal(day.bars.at(-1).start, localDayStart(new Date(2026, 10, 18).getTime(), -1))

  const week = barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe: '1w' })
  // 2026-11-16 是周一：周桶 = 本地 11-16 00:00 → 11-23 00:00。
  assert.equal(week.current.start, weekStartOf(TF_NOW))
  assert.equal(week.current.start, new Date(2026, 10, 16).getTime())
  assert.equal(week.current.end, new Date(2026, 10, 23).getTime())
  assert.equal(week.bars[0].start, localDayStart(new Date(2026, 10, 16).getTime(), -7 * 24))
  // 周中任意时刻都归到同一个周桶：周三 13:37 与周日 23:59 是同一周。
  assert.equal(
    barsForTimeframe({ crop: 'tomato', now: new Date(2026, 10, 22, 23, 59).getTime(), timeframe: '1w' }).current.start,
    week.current.start
  )
  // 下周一 00:00 就是新的一周。
  assert.equal(
    barsForTimeframe({ crop: 'tomato', now: new Date(2026, 10, 23).getTime(), timeframe: '1w' }).current.start,
    new Date(2026, 10, 23).getTime()
  )
})

test('票 84/86：OHLC 由 boardPrice()/markPrice() 采样聚合——1 时每 5 分、1 日每小时、1 周每 3 小时', () => {
  // 票 86 把 1 周从 6 小时加密到 3 小时：一根 57 针，周线的影线不再被粗抽样糊掉。
  const stepOf = { '1h': 5 * TICK_MS, '1d': HOUR_MS, '1w': 3 * HOUR_MS }
  const countOf = { '1h': 13, '1d': 25, '1w': 57 }
  for (const [timeframe, stepMs] of Object.entries(stepOf)) {
    const chart = barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe })
    // 已收的一根：两端都算 → 1 时 13 针、1 日 25 针、1 周 57 针。
    const closed = chart.bars[5]
    const closedPath = sampledPath('tomato', closed.start, closed.end, stepMs)
    assert.equal(closedPath.length, countOf[timeframe], timeframe + ' 的采样点数')
    assert.equal(closed.open, closedPath[0])
    assert.equal(closed.close, closedPath.at(-1))
    assert.equal(closed.high, Math.max(...closedPath))
    assert.equal(closed.low, Math.min(...closedPath))
    // 票 86 验收：首尾两针**正好落在桶边界上**——开 = 桶起点的现价、收 = 桶终点的现价，
    // 与采样步长无关（步长只决定中间取几针，不决定开收盘价）。
    assert.equal(closed.open, markPrice({ crop: 'tomato', now: closed.start }), timeframe + ' 开 = 桶起点价')
    assert.equal(closed.close, markPrice({ crop: 'tomato', now: closed.end }), timeframe + ' 收 = 桶终点价')
    // 桶起点/终点都落在 15 分钟格点上：那一针就是该 slot 的开盘（tick 0），不是收盘。
    assert.equal(slotIndexAt(closed.start) * SLOT_MS, closed.start, timeframe + ' 桶起点对齐 slot')
    assert.equal(slotIndexAt(closed.end) * SLOT_MS, closed.end, timeframe + ' 桶终点对齐 slot')
    // 形成中的一根只采到「现在」，高低点也只算已走完的路径。
    const formingPath = sampledPath('tomato', chart.current.start, TF_NOW, stepMs)
    assert.equal(chart.current.open, formingPath[0])
    assert.equal(chart.current.price, formingPath.at(-1))
    assert.equal(chart.current.high, Math.max(...formingPath))
    assert.equal(chart.current.low, Math.min(...formingPath))
  }
  // 同一时刻算两次是同一张图（纯散列，无隐藏状态）。
  for (const { id } of BOARD_TIMEFRAMES) {
    assert.deepEqual(
      barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe: id }),
      barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe: id }),
      id + ' 可复现'
    )
  }
})

test('票 84：切周期只换图——结算仍只认 15 分钟收盘，路径扫描也不受影响', () => {
  const slot = slotIndexAt(TF_NOW)
  const close = slotClosePrice('tomato', slot)
  assert.equal(close, boardPrice({ crop: 'tomato', slot, tick: SLOT_TICKS }))
  // 15 分那根才是合约：闭市价 = slotClosePrice（结算口径），粗周期一根都不参与。
  const contract = barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe: '15m' })
  assert.equal(contract.current.slot, slot)
  assert.equal(contract.bars.at(-1).close, slotClosePrice('tomato', slot - 1))
  assert.equal(contract.current.open, slotClosePrice('tomato', slot - 1))

  // 同一笔仓位，不管窗口正在看哪个周期，结算公式输入输出都一样。
  const settled = settlementOf({ side: 'long', margin: 100, leverage: 5, entry: 5, mark: close })
  for (const { id } of BOARD_TIMEFRAMES) {
    const chart = barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe: id })
    assert.notEqual(chart, null)
    assert.deepEqual(
      settlementOf({ side: 'long', margin: 100, leverage: 5, entry: 5, mark: slotClosePrice('tomato', slot) }),
      settled,
      id + ' 看什么图都不改变结算'
    )
  }
  // 强平/止损走的还是 1 分钟格点：周期参数根本不在 pathScan 的入口上。
  // 把粗周期都算一遍再扫，结果必须一模一样（纯函数、没有隐藏状态）。
  const scanArgs = {
    crop: 'tomato',
    side: 'long',
    margin: 50,
    leverage: 20,
    entry: 4,
    from: TF_NOW,
    to: TF_NOW + SLOT_MS
  }
  const scanBefore = pathScan(scanArgs)
  for (const { id } of BOARD_TIMEFRAMES) {
    barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe: id })
  }
  assert.deepEqual(pathScan(scanArgs), scanBefore)
})

/**
 * 票 86 的验收要用到的读数（只服务用例，不进产品代码）。
 * 三个固定「现在」跨过不同年份/季节，落在 4 周波与 12 周波的不同相位上：
 * 行情是确定性的，所以这几个时刻的读数也是定值；多挑几个是为了证明不是碰巧好看。
 */
const READABILITY_NOWS = Object.freeze([
  TF_NOW,
  new Date(2027, 1, 10, 9, 12, 0, 0).getTime(),
  new Date(2027, 5, 1, 21, 47, 0, 0).getTime()
])

/** 连续同向收盘最长的一段（根数：1 = 一根都没连着同向，24 = 一路单边）。 */
function longestTrendRun (closes) {
  let best = 1
  let current = 1
  let direction = 0
  for (let index = 1; index < closes.length; index += 1) {
    const step = Math.sign(closes[index] - closes[index - 1])
    if (step === 0) continue
    if (step === direction) current += 1
    else {
      direction = step
      current = 2
    }
    if (current > best) best = current
  }
  return best
}

function medianOf (values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * 一张粗周期图的读数：
 * `run` 趋势段（同向收盘最长一段）、`rangeRatio` 总振幅 / 单根振幅中位数
 * （≈1 就是「每根各走各的」，越大越像一段行情）、`bodyRatio` 实体占单根振幅的均值。
 */
function readabilityOf (chart) {
  const bars = chart.bars
  const totalRange = Math.max(...bars.map((bar) => bar.high)) - Math.min(...bars.map((bar) => bar.low))
  const medianRange = medianOf(bars.map((bar) => bar.high - bar.low))
  const bodyRatio = bars.reduce(
    (sum, bar) => sum + (bar.high === bar.low ? 0 : Math.abs(bar.close - bar.open) / (bar.high - bar.low)),
    0
  ) / bars.length
  return {
    run: longestTrendRun(bars.map((bar) => bar.close)),
    rangeRatio: totalRange / medianRange,
    bodyRatio
  }
}

/**
 * 票 86 的核心验收（ADR-0030）：日线/周线要能读出趋势，不能是「开收盘贴均值、影线满幅」。
 *
 * 阈值是照着模型量出来的，不是编的（旧模型同一时刻的读数写在下面做对照）：
 *   1 日：趋势段 4–6 根（旧 3）、总振幅 3.5–4.9× 单根（旧 1.1×）；
 *   1 周：趋势段 4 根（旧 3）、总振幅 2.15–2.29× 单根（旧 1.1×）、实体占比 0.41–0.48（旧 0.38–0.42
 *         但那是「影线满幅」下的假实体：单根振幅本身就接近整张图）。
 * 三个作物 × 三个时刻一起断言，谁把长波幅度调小了都会在这里露出来。
 */
test('票 103（v5）：行情有波动率聚集与厚尾，但收益仍无方向性', () => {
  const start = slotIndexAt(Date.UTC(2026, 0, 1))
  const closes = []
  for (let offset = 0; offset < 90 * 96; offset += 1) {
    closes.push(slotClosePrice('tomato', start + offset))
  }
  const rets = []
  for (let index = 1; index < closes.length; index += 1) rets.push(Math.log(closes[index] / closes[index - 1]))
  const mean = rets.reduce((sum, value) => sum + value, 0) / rets.length
  const m2 = rets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / rets.length
  const m4 = rets.reduce((sum, value) => sum + (value - mean) ** 4, 0) / rets.length
  const abs = rets.map((value) => Math.abs(value))
  const absMean = abs.reduce((sum, value) => sum + value, 0) / abs.length
  let volCov = 0
  let volVar = 0
  for (let index = 1; index < abs.length; index += 1) {
    volCov += (abs[index] - absMean) * (abs[index - 1] - absMean)
    volVar += (abs[index] - absMean) ** 2
  }
  let retCov = 0
  for (let index = 1; index < rets.length; index += 1) retCov += (rets[index] - mean) * (rets[index - 1] - mean)
  const retVar = rets.reduce((sum, value) => sum + (value - mean) ** 2, 0)
  const sigma = Math.sqrt(m2)
  const kurtosis = m4 / (m2 * m2)
  const volAc = volCov / volVar
  const retAc = retCov / retVar

  // v4 是 σ 2.0% / 峰度 2.9 / volAc 0；v5 要明显更有形状，但不能变成可读的趋势。
  assert.ok(sigma > 0.018 && sigma < 0.036, '15m σ 应在 1.8%–3.6%：' + (sigma * 100).toFixed(2) + '%')
  assert.ok(kurtosis > 3.0, '峰度应明显高于正态：' + kurtosis.toFixed(2))
  assert.ok(volAc > 0.08, '波动率应有聚集：' + volAc.toFixed(3))
  assert.ok(Math.abs(retAc) < 0.06, '收益自相关应接近 0：' + retAc.toFixed(3))
  assert.ok(closes.every((price) => price >= 5 * PRICE_FLOOR_RATIO && price <= 5 * PRICE_CEIL_RATIO))
})

test('票 103/107：boardPrice 的 flowLevel 是可选叠加项，会推价但受总偏离帽约束', () => {
  const slot = SLOT
  const base = boardPrice({ crop: 'tomato', slot, tick: 0 })
  const up = boardPrice({ crop: 'tomato', slot, tick: 0, flowLevel: 0.02 })
  const down = boardPrice({ crop: 'tomato', slot, tick: 0, flowLevel: -0.02 })
  assert.ok(up > base, '正资金流应推高价格')
  assert.ok(down < base, '负资金流应压低价格')
  // 总偏离帽 6%：0.5 的资金流不会把价格推到 exp(0.5) 倍。
  const capped = boardPrice({ crop: 'tomato', slot, tick: 0, flowLevel: 0.5 })
  assert.ok(capped < base * Math.exp(0.07), '资金流应被总偏离帽夹住')
  assert.equal(boardPrice({ crop: 'tomato', slot, tick: 0, flowLevel: 0 }), base)
})

test('票 86（v4 修订）：随机游走的尺度性质——窗口越长振幅越大，实体不是针', () => {
  // 票 102 把价格换成随机游走之后，「读得出趋势」不再成立（鞅没有趋势，这正是要的）：
  // 这里改成钉住鞅的形状——振幅仍随窗口变长按 √N 放大，K 线不是一条被压平的直线。
  for (const crop of boardCrops()) {
    for (const now of READABILITY_NOWS) {
      const day = readabilityOf(barsForTimeframe({ crop, now, timeframe: '1d' }))
      const dayTag = crop + ' ' + new Date(now).toISOString().slice(0, 10) + ' 的 1 日'
      // 实测 2.2–11.9×（√96 ≈ 9.8 的量级），低于 2 说明被压平了。
      assert.ok(day.rangeRatio >= 1.8, dayTag + '总振幅只有单根的 ' + day.rangeRatio.toFixed(2) + ' 倍')
      assert.ok(day.bodyRatio >= 0.25, dayTag + '实体占比只有 ' + day.bodyRatio.toFixed(3))

      const week = readabilityOf(barsForTimeframe({ crop, now, timeframe: '1w' }))
      const weekTag = crop + ' ' + new Date(now).toISOString().slice(0, 10) + ' 的 1 周'
      // v5 的波动率聚集会让单根中位数变大，周线振幅比可以低到 1.3；下限放到 1.2，只拦「整周不动」。
      assert.ok(week.rangeRatio >= 1.2, weekTag + '总振幅只有单根的 ' + week.rangeRatio.toFixed(2) + ' 倍')
    }
  }
})

/**
 * 票 86：短波只是从「风」收成「呼吸」，没有把 15 分钟图做平，价格也不去撞夹子。
 * - 6 小时（24 根整根 + 当前一根）的最高最低差 ≥ 底价的 10%：实测 13–22%（旧模型 ≈38%）；
 * - 夹取 [0.55, 1.75] × 底价 是兜底，不是日常：一年 × 全部盘口作物（票 88 起十种）
 *   × 每根 3 个 tick 扫下来，价格仍在 [0.58, 1.71] × 底价 之内（实测 0.59–1.704），
 *   没有一根是被夹出来的。
 */
test('票 86（v4 修订）：15 分钟仍有日内波动，一年也基本不贴夹子', () => {
  for (const crop of boardCrops()) {
    const base = CROPS[crop].base
    const chart = barsFor({ crop, now: TF_NOW })
    const highs = chart.bars.map((bar) => bar.high).concat(chart.current.high)
    const lows = chart.bars.map((bar) => bar.low).concat(chart.current.low)
    const range = Math.max(...highs) - Math.min(...lows)
    // 实测 9.7–22%（σ_bar ≈ 2%，24 根按 √N 放大）。
    assert.ok(
      range >= base * 0.07,
      crop + ' 6 小时振幅只有底价的 ' + ((range / base) * 100).toFixed(1) + '%'
    )
  }
  // 逐 slot 扫一年：v5 有肥尾和消息，夹子偶尔会被摸到；要求是「夹子是兜底，不是日常」，
  // 且不能长时间粘在夹子上（那是限价板，不是随机游走）。
  for (const crop of boardCrops()) {
    const base = CROPS[crop].base
    const firstSlot = slotIndexAt(TF_NOW)
    let lowest = Infinity
    let highest = -Infinity
    let samples = 0
    let clamped = 0
    let run = 0
    let maxRun = 0
    for (let offset = 0; offset < 365 * 96; offset += 1) {
      for (const tick of [0, SLOT_TICKS / 2, SLOT_TICKS]) {
        const ratio = boardPrice({ crop, slot: firstSlot + offset, tick }) / base
        samples += 1
        if (ratio < lowest) lowest = ratio
        if (ratio > highest) highest = ratio
        if (ratio <= PRICE_FLOOR_RATIO + 1e-9 || ratio >= PRICE_CEIL_RATIO - 1e-9) {
          clamped += 1
          run += 1
          if (run > maxRun) maxRun = run
        } else {
          run = 0
        }
      }
    }
    assert.ok(lowest >= PRICE_FLOOR_RATIO, crop + ' 价格跌破夹取下沿：' + lowest.toFixed(3))
    assert.ok(highest <= PRICE_CEIL_RATIO, crop + ' 价格越过夹取上沿：' + highest.toFixed(3))
    assert.ok(clamped / samples < 0.0005, crop + ' 贴夹率太高：' + (clamped / samples * 100).toFixed(3) + '%')
    assert.ok(maxRun <= 6, crop + ' 在夹子上粘了 ' + maxRun + ' 个采样点')
  }
})

/**
 * 票 86 的回归：采样细化只改「看哪几针」，不动结算/路径/止损。
 *
 * 合约结算只认 15 分钟收盘（`slotClosePrice` = 下一根开盘）；粗周期的收/开是**桶边界**
 * 那一刻的现价——那是某个 15 分钟的**开盘**，不是收盘，所以它进不了结算。
 * 这里同时钉住两件事：
 * 1) 结算的输入仍然只有两个价格（票 86 曲线下的结果是定值，改采样不该动它）；
 * 2) 路径扫描仍逐分钟走**绝对分钟格点**：测试自己重扫一遍，结果逐字相同。
 */
test('票 86：采样细化只改显示——结算/路径/止损仍只认 15 分钟与逐分钟格点', () => {
  const slot = slotIndexAt(TF_NOW)
  const close = slotClosePrice('tomato', slot)
  // 结算价 = 本根收盘 = 下一根开盘（票 79 的口径），窗口在看哪个周期都一样。
  assert.equal(close, boardPrice({ crop: 'tomato', slot, tick: SLOT_TICKS }))
  assert.equal(close, boardPrice({ crop: 'tomato', slot: slot + 1, tick: 0 }))
  // 1 周/1 日的收盘落在桶边界（本地零点/整点）上，是 15 分钟的开盘价，不是收盘价。
  const week = barsForTimeframe({ crop: 'tomato', now: TF_NOW, timeframe: '1w' })
  const lastWeek = week.bars.at(-1)
  assert.equal(lastWeek.close, boardPrice({ crop: 'tomato', slot: slotIndexAt(lastWeek.end), tick: 0 }))
  // 结算 = 保证金 × 杠杆 × (现价/入场 − 1)，只在最后取整；亏损封顶保证金。
  // 价格是随机的，所以期望值按当天收盘现算（票 102 之前这里是写死的 121/221）。
  const longPnl = Math.round(pnlOf({ side: 'long', margin: 100, leverage: 5, entry: 5, mark: close }))
  assert.deepEqual(
    settlementOf({ side: 'long', margin: 100, leverage: 5, entry: 5, mark: close }),
    { pnl: longPnl, fee: 0, credit: 100 + longPnl }
  )
  // 亏损封顶：做空遇到 10 倍价，只亏掉保证金。
  assert.deepEqual(
    settlementOf({ side: 'short', margin: 100, leverage: 5, entry: 5, mark: 50 }),
    { pnl: -100, fee: 0, credit: 0 }
  )

  // 路径扫描的参考实现：从下一个整数分钟走到终点，端点也算（和 pathScan 同一条网格）。
  const referenceScan = (from, to, triggered, reason) => {
    let cursor = Math.ceil(from / TICK_MS) * TICK_MS
    if (cursor <= from) cursor += TICK_MS
    while (cursor < to) {
      const mark = markPrice({ crop: 'tomato', now: cursor })
      if (triggered(mark)) return { at: cursor, exit: mark, reason }
      cursor += TICK_MS
    }
    const mark = markPrice({ crop: 'tomato', now: to })
    return triggered(mark) ? { at: to, exit: mark, reason } : null
  }

  // 强平：20× 做多，插针那一分钟就穿线——逐分钟重扫，第一处触发必须完全对上。
  const { slot: spikeSlot, entry } = spikeLong(SLOT + 3)
  const from = spikeSlot * SLOT_MS
  const to = (spikeSlot + 1) * SLOT_MS
  const liquidation = liquidationPriceOf({ side: 'long', entry, leverage: 20 })
  const liquidated = pathScan({ crop: 'tomato', side: 'long', margin: 50, leverage: 20, entry, from, to })
  const referenceLiquidation = referenceScan(
    from,
    to,
    (mark) => isLiquidated({ side: 'long', mark, liquidation }),
    'liquidate'
  )
  // 触发时刻与逐分钟重扫一致；但成交价按**强平线**算，不用那一分钟的插针价
  // （票 102：否则 20× 一格跳空能穿透好几个点，5% 维持保证金就名存实亡）。
  assert.equal(liquidated.at, referenceLiquidation.at)
  assert.equal(liquidated.reason, 'liquidate')
  assert.equal(liquidated.exit, liquidation)
  // 止损：5× 的 −25% 保证金 = 价格 −5%，同一根里先撞到它（强平线在 −20%，这一根摸不到）。
  assert.deepEqual(
    pathScan({ crop: 'tomato', side: 'long', margin: 50, leverage: 5, entry, stopLoss: 0.25, from, to }),
    referenceScan(
      from,
      to,
      (mark) => isStopLossHit({ side: 'long', margin: 50, leverage: 5, entry, mark, stopLoss: 0.25 }),
      'stop'
    )
  )
})

test('票 81（v4 修订）：风向是最近三根动量的 55–68% 弱信号，同一根内不变', () => {
  // 票 102：风向改成「最近三根已实现动量」，必须挑一根已经有历史的 slot。
  const base = SLOT_EDGE + 500 * SLOT_MS
  const now = base + 3 * TICK_MS
  const hint = hintOf({ crop: 'tomato', now })
  assert.deepEqual(hintOf({ crop: 'tomato', now }), hint)
  assert.ok(hint.confidence >= 0.55 && hint.confidence <= 0.68, '置信度落在 55–68%：' + hint.confidence)
  assert.ok(['up', 'down', 'flat'].includes(hint.direction))
  // 同一根内（开根/中间/差 1 毫秒收盘）风向不闪：三根历史都在本根之前。
  for (const offset of [0, 7 * TICK_MS, SLOT_MS - 1]) {
    assert.deepEqual(hintOf({ crop: 'tomato', now: base + offset }), hint)
  }
  // 一整天扫过去：方向有涨有跌，置信度是 0.01 一格的离散值，都夹在区间里。
  const directions = new Set()
  const confidences = new Set()
  for (let index = 0; index < 96; index += 1) {
    const sample = hintOf({ crop: 'tomato', now: now + index * SLOT_MS })
    directions.add(sample.direction)
    confidences.add(sample.confidence)
    assert.ok(sample.confidence >= 0.55 && sample.confidence <= 0.68, '置信度越界：' + sample.confidence)
  }
  assert.equal(directions.has('up'), true, '一天里应该出现过偏多')
  assert.equal(directions.has('down'), true, '一天里应该出现过偏空')
  assert.ok(confidences.size > 3, '置信度不该是同一个数')
  // 三个作物各算一份（相位不同），坏输入是 null。
  assert.notDeepEqual(
    [hintOf({ crop: 'carrot', now }), hintOf({ crop: 'pumpkin', now })],
    [hint, hint]
  )
  assert.equal(hintOf({ crop: 'nope', now }), null)
  assert.equal(hintOf({ crop: 'tomato', now: 'x' }), null)
  assert.equal(hintOf(), null)
})

test('票 83：到价目标价带 = 0.55–1.75× 底价，带外/坏数字一律拒绝', () => {
  const band = targetBandOf({ crop: 'tomato' })
  assert.equal(band.min, CROPS.tomato.base * PRICE_FLOOR_RATIO)
  assert.equal(band.max, CROPS.tomato.base * PRICE_CEIL_RATIO)
  // 边界算带内（图上摸到就能成交），带外一毫都不行。
  assert.equal(isOrderTarget({ crop: 'tomato', target: band.min }), true)
  assert.equal(isOrderTarget({ crop: 'tomato', target: band.max }), true)
  assert.equal(isOrderTarget({ crop: 'tomato', target: band.min - 0.0001 }), false)
  assert.equal(isOrderTarget({ crop: 'tomato', target: band.max + 0.0001 }), false)
  assert.equal(isOrderTarget({ crop: 'tomato', target: 'not-a-price' }), false)
  assert.equal(isOrderTarget({ crop: 'nope', target: 5 }), false)
  assert.equal(isOrderTarget({ crop: 'tomato', target: Number.NaN }), false)
  assert.equal(targetBandOf({ crop: 'nope' }), null)
})

test('票 83：到价成交扫描——做多跌到目标、做空涨到目标，成交价永远是目标价', () => {
  const start = SLOT_EDGE
  // 票 102 起价格是随机的，不能再写死「这一根一路下跌」：先把这一根的 16 个分钟价读出来，
  // 再按「第一个满足条件的那一分钟」算期望值。
  const prices = []
  for (let tick = 0; tick <= SLOT_TICKS; tick += 1) {
    prices.push(markPrice({ crop: 'tomato', now: start + tick * TICK_MS }))
  }
  const firstIndex = (hit) => prices.findIndex(hit)

  // 做多：价格跌到这一根的最低点就成交，成交价永远是目标价本身。
  const longTarget = Math.min(...prices)
  const longIndex = firstIndex((price) => price <= longTarget)
  // 目标可能正好是收盘那一针：那一毫秒已经属于下一根，slot 由 slotIndexAt 决定。
  const longAt = start + longIndex * TICK_MS
  assert.deepEqual(
    limitFillScan({ crop: 'tomato', side: 'long', target: longTarget, from: start, to: start + SLOT_MS }),
    { at: longAt, slot: slotIndexAt(longAt) }
  )

  // 做空：涨到这一根的最高点成交。
  const shortTarget = Math.max(...prices)
  const shortIndex = firstIndex((price) => price >= shortTarget)
  const shortAt = start + shortIndex * TICK_MS
  assert.deepEqual(
    limitFillScan({ crop: 'tomato', side: 'short', target: shortTarget, from: start, to: start + SLOT_MS }),
    { at: shortAt, slot: slotIndexAt(shortAt) }
  )

  // 终点在收盘那一刻：收盘价也参与扫描，且「先摸到就按摸到的那一分钟成交」。
  const closeTarget = slotClosePrice('tomato', SLOT)
  const closeIndex = firstIndex((price) => price <= closeTarget)
  const closeAt = start + (closeIndex === -1 ? SLOT_TICKS : closeIndex) * TICK_MS
  assert.deepEqual(
    limitFillScan({ crop: 'tomato', side: 'long', target: closeTarget, from: start, to: start + SLOT_MS }),
    { at: closeAt, slot: slotIndexAt(closeAt) }
  )
  // 扫描区间为空、目标价/作物坏掉：不成交，也不凭空造一个时刻。
  assert.equal(limitFillScan({ crop: 'tomato', side: 'long', target: 1, from: start, to: start }), null)
  assert.equal(limitFillScan({ crop: 'tomato', side: 'long', target: 'x', from: start, to: start + SLOT_MS }), null)
  assert.equal(limitFillScan({ crop: 'tomato', side: 'up', target: longTarget, from: start, to: start + SLOT_MS }), null)
  assert.equal(limitFillScan({ crop: 'nope', side: 'long', target: longTarget, from: start, to: start + SLOT_MS }), null)
})
