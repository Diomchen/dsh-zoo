/**
 * 票 79：盘口纯规则的确定性。
 *
 * 只测外部行为——同一 seed 同一根的价格、slot/tick 边界、夹取范围、盈亏与结算取整、
 * 本周起点。票 81 追加 K 线与风向。不碰磁盘、不碰时钟、不联网。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOARD_BAR_COUNT,
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
  barsFor,
  hash32,
  hintOf,
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

test('票 79：下单白名单只有 1× / 50 / 100 / 三个作物 / 多空', () => {
  // 票 81 起盘口有三个作物：顺序就是窗口页签的顺序，tomato 是 payload.bar 的来源。
  assert.deepEqual(BOARD_CROPS, ['tomato', 'carrot', 'pumpkin'])
  assert.deepEqual(TRADING_MARGINS, [50, 100])
  assert.deepEqual(TRADING_LEVERAGES, [1])
  assert.deepEqual(BOARD_SIDES, ['long', 'short'])
  assert.equal(isBoardCrop('tomato'), true)
  assert.equal(isBoardCrop('carrot'), true)
  assert.equal(isBoardCrop('pumpkin'), true)
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

test('票 81：风向是确定性的 55–68% 弱信号，同一根内不变', () => {
  const now = SLOT_EDGE + 3 * TICK_MS
  const hint = hintOf({ crop: 'tomato', now })
  assert.deepEqual(hintOf({ crop: 'tomato', now }), hint)
  assert.ok(hint.confidence >= 0.55 && hint.confidence <= 0.68, '置信度落在 55–68%：' + hint.confidence)
  assert.ok(['up', 'down', 'flat'].includes(hint.direction))
  // 同一根内（开根/中间/差 1 毫秒收盘）风向不闪：斜率取的是本根起点。
  for (const offset of [0, 7 * TICK_MS, SLOT_MS - 1]) {
    assert.deepEqual(hintOf({ crop: 'tomato', now: SLOT_EDGE + offset }), hint)
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
