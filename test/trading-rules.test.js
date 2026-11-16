/**
 * 票 79/80：盘口纯规则的确定性。
 *
 * 只测外部行为——同一 seed 同一根的价格、slot/tick 边界、夹取范围、盈亏与结算取整、
 * 强平价与触线边界、止损档、逐 tick 路径检查（插针/跳 slot/离线补算的上限）、本周起点。
 * 不碰磁盘、不碰时钟、不联网。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOARD_CROPS,
  BOARD_SIDES,
  MAX_LEVERAGE,
  MAX_PATH_SCAN_MS,
  MAX_PATH_SCAN_SLOTS,
  PRICE_CEIL_RATIO,
  PRICE_FLOOR_RATIO,
  SLOT_MS,
  SLOT_TICKS,
  TICK_MS,
  TRADING_CLOSE_REASONS,
  TRADING_LEVERAGES,
  TRADING_MARGINS,
  TRADING_STOP_LEVELS,
  boardPrice,
  hash32,
  isBoardCrop,
  isBoardSide,
  isLiquidated,
  isStopLossHit,
  isStopLossLevel,
  isStoredLeverage,
  isTradingLeverage,
  isTradingMargin,
  liquidationPriceOf,
  markPrice,
  pathScan,
  pnlOf,
  settlementOf,
  slotBounds,
  slotClosePrice,
  slotIndexAt,
  weekStartOf
} from '../src/trading-rules.js'
import { CROPS } from '../src/farm-rules.js'

/** 正好落在 slot 边界上的一刻（1763308800000 / 900000 是整数）。 */
const SLOT_EDGE = 1763308800000
const SLOT = SLOT_EDGE / SLOT_MS
const BASE = 5

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
  // 散列本身是固定的：种子/盐一改就会在这里报警。
  assert.equal(hash32('board-v1:tomato:fast:0'), 3290775997)
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

test('票 79：此刻的价格只由时间决定（开盘 = 边界那一刻的现价）', () => {
  const slot = SLOT
  assert.equal(markPrice({ crop: 'tomato', now: slot * SLOT_MS }), boardPrice({ crop: 'tomato', slot, tick: 0 }))
  assert.equal(
    markPrice({ crop: 'tomato', now: slot * SLOT_MS + 7.5 * TICK_MS }),
    boardPrice({ crop: 'tomato', slot, tick: 7.5 })
  )
  assert.equal(markPrice({ crop: 'tomato', now: 'nope' }), null)
  // 相邻两毫秒的价格只差一点点：路径是连续的，回放不会看到阶跃。
  const before = markPrice({ crop: 'tomato', now: slot * SLOT_MS - 1 })
  const after = markPrice({ crop: 'tomato', now: slot * SLOT_MS + 1 })
  assert.ok(Math.abs(after - before) < CROPS.tomato.base * 0.001)
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
    { pnl: 4, credit: 104 }
  )
  // −3.6 → −4。
  assert.deepEqual(
    settlementOf({ side: 'long', margin: 100, leverage: 1, entry: 5, mark: 4.82 }),
    { pnl: -4, credit: 96 }
  )
  // 价格归零也只亏掉保证金：pnl = −margin，退回 0（调用方跳过 addCoins）。
  assert.deepEqual(
    settlementOf({ side: 'long', margin: 50, leverage: 1, entry: 5, mark: 0 }),
    { pnl: -50, credit: 0 }
  )
  // 做空方向反过来，封顶同样只看 margin。
  assert.deepEqual(
    settlementOf({ side: 'short', margin: 100, leverage: 1, entry: 5, mark: 50 }),
    { pnl: -100, credit: 0 }
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

test('票 80：下单白名单是 1×/5×/20×、50/100、小番茄、多空；止损四档含 0=关', () => {
  assert.deepEqual(BOARD_CROPS, ['tomato'])
  assert.deepEqual(TRADING_MARGINS, [50, 100])
  assert.deepEqual(TRADING_LEVERAGES, [1, 5, 20])
  assert.deepEqual(BOARD_SIDES, ['long', 'short'])
  // 结算原因固定四种：手动 / 收盘 / 强平 / 止损（历史行就按这个写）。
  assert.deepEqual(TRADING_CLOSE_REASONS, ['close', 'settle', 'liquidate', 'stop'])
  // 0 是「关」，不是「−0%」：默认不设止损也能玩。
  assert.deepEqual(TRADING_STOP_LEVELS, [0, 0.25, 0.5, 1])
  assert.equal(isBoardCrop('tomato'), true)
  assert.equal(isBoardCrop('corn'), false)
  assert.equal(isBoardSide('long'), true)
  assert.equal(isBoardSide('up'), false)
  assert.equal(isTradingMargin(50), true)
  assert.equal(isTradingMargin(51), false)
  assert.equal(isTradingMargin('50'), false)
  assert.equal(isTradingLeverage(1), true)
  assert.equal(isTradingLeverage(5), true)
  assert.equal(isTradingLeverage(20), true)
  assert.equal(isTradingLeverage(2), false)
  assert.equal(isTradingLeverage('5'), false)
  assert.equal(isStopLossLevel(0), true)
  assert.equal(isStopLossLevel(0.25), true)
  assert.equal(isStopLossLevel(1), true)
  assert.equal(isStopLossLevel(0.3), false)
  assert.equal(isStopLossLevel('0.5'), false)
  // 读盘只按形状（5×/20× 写进文件后仍要能读回来）。
  assert.equal(isStoredLeverage(20), true)
  assert.equal(isStoredLeverage(MAX_LEVERAGE + 1), false)
  assert.equal(isStoredLeverage(0), false)
})

test('票 80：强平价 = 1/杠杆；做多往下、做空往上；1× 没有强平线', () => {
  // 用二进制里能整除的价格（8）断言精确值，不留浮点尾巴。
  assert.equal(liquidationPriceOf({ side: 'long', entry: 8, leverage: 5 }), 8 * 0.8)
  assert.equal(liquidationPriceOf({ side: 'short', entry: 8, leverage: 5 }), 8 * 1.2)
  assert.equal(liquidationPriceOf({ side: 'long', entry: 8, leverage: 20 }), 8 * 0.95)
  assert.equal(liquidationPriceOf({ side: 'short', entry: 8, leverage: 20 }), 8 * 1.05)
  // 1× 要跌到 0 才亏光，而价格有底价：没有强平线，窗口画「—」。
  assert.equal(liquidationPriceOf({ side: 'long', entry: 8, leverage: 1 }), null)
  assert.equal(liquidationPriceOf({ side: 'short', entry: 8, leverage: 1 }), null)
  // 坏输入不凭空造一条线。
  assert.equal(liquidationPriceOf({ side: 'up', entry: 8, leverage: 5 }), null)
  assert.equal(liquidationPriceOf({ side: 'long', entry: 0, leverage: 5 }), null)
  assert.equal(liquidationPriceOf({ side: 'long', entry: 'x', leverage: 5 }), null)
  // 强平价正好是「保证金亏光」的那一点：pnl = −margin（证明两条公式同源）。
  for (const leverage of [5, 20]) {
    for (const side of ['long', 'short']) {
      const line = liquidationPriceOf({ side, entry: 8, leverage })
      const pnl = pnlOf({ side, margin: 50, leverage, entry: 8, mark: line })
      assert.ok(Math.abs(pnl + 50) < 1e-9, side + ' ' + leverage + '× 在强平价正好亏光保证金（' + pnl + '）')
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
 */
function beyondCap (seed) {
  for (let start = seed; start < seed + 60; start += 1) {
    let floor = Infinity
    for (let slot = start; slot < start + MAX_PATH_SCAN_SLOTS; slot += 1) {
      floor = Math.min(floor, extremesOf(slot).low.price)
    }
    // 强平线放在窗口最低价再低 0.1%：窗口里一秒都不该触发。
    const entry = (floor / 0.95) * 0.999
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
