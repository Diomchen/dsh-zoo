/**
 * 票 79：盘口纯规则的确定性。
 *
 * 只测外部行为——同一 seed 同一根的价格、slot/tick 边界、夹取范围、盈亏与结算取整、
 * 本周起点。不碰磁盘、不碰时钟、不联网。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOARD_CROPS,
  BOARD_SIDES,
  MAX_LEVERAGE,
  PRICE_CEIL_RATIO,
  PRICE_FLOOR_RATIO,
  SLOT_MS,
  SLOT_TICKS,
  TICK_MS,
  TRADING_LEVERAGES,
  TRADING_MARGINS,
  boardPrice,
  hash32,
  isBoardCrop,
  isBoardSide,
  isStoredLeverage,
  isTradingLeverage,
  isTradingMargin,
  markPrice,
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

test('票 79：下单白名单只有 1× / 50 / 100 / 小番茄 / 多空', () => {
  assert.deepEqual(BOARD_CROPS, ['tomato'])
  assert.deepEqual(TRADING_MARGINS, [50, 100])
  assert.deepEqual(TRADING_LEVERAGES, [1])
  assert.deepEqual(BOARD_SIDES, ['long', 'short'])
  assert.equal(isBoardCrop('tomato'), true)
  assert.equal(isBoardCrop('corn'), false)
  assert.equal(isBoardSide('long'), true)
  assert.equal(isBoardSide('up'), false)
  assert.equal(isTradingMargin(50), true)
  assert.equal(isTradingMargin(51), false)
  assert.equal(isTradingMargin('50'), false)
  assert.equal(isTradingLeverage(1), true)
  assert.equal(isTradingLeverage(5), false)
  // 读盘只按形状（票 80 的 5×/20× 写进文件后仍要能读回来）。
  assert.equal(isStoredLeverage(20), true)
  assert.equal(isStoredLeverage(MAX_LEVERAGE + 1), false)
  assert.equal(isStoredLeverage(0), false)
})
