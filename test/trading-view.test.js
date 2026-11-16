/**
 * 票 79 / 票 81：盘口窗的纯视图输出（K 线几何/下单区/持仓卡/历史/周盈亏/空态）。
 *
 * 渲染页和 Node 测试 require 的是同一份 `desktop/trading-view.js`；这里只测数字、坐标与
 * 文案，不测 DOM。几何用例用能整除的价格，断言精确的 viewBox 坐标，不留浮点尾巴。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { pnlOf } from '../src/trading-rules.js'

const require = createRequire(import.meta.url)
const view = require('../desktop/trading-view.js')

const SLOT_MS = 15 * 60 * 1000
const SLOT = 1959232
const SLOT_EDGE = SLOT * SLOT_MS
const LIMITS = {
  margins: [50, 100],
  leverages: [1, 5, 20],
  crops: [
    { id: 'tomato', name: '小番茄' },
    { id: 'carrot', name: '胡萝卜' },
    { id: 'pumpkin', name: '南瓜' }
  ],
  historyLimit: 50
}

function bar (slot, overrides = {}) {
  return { slot, open: 5, high: 5.2, low: 4.9, close: 5.1, ...overrides }
}

function bars (count = 24, start = SLOT - 24) {
  const list = []
  for (let index = 0; index < count; index += 1) list.push(bar(start + index))
  return list
}

function chart (overrides = {}) {
  return {
    base: 5,
    bars: bars(),
    current: { slot: SLOT, open: 5, high: 5.2, low: 4.9, price: 5.06, tick: 5, remainingMs: 600000 },
    ...overrides
  }
}

function payload (overrides = {}) {
  return {
    coins: { available: 120, locked: 50, total: 172 },
    week: { start: SLOT_EDGE, pnl: 8, base: 500, unrealized: 2.5, total: 10.5 },
    limits: LIMITS,
    bar: {
      crop: 'tomato',
      slot: SLOT,
      start: SLOT_EDGE,
      end: SLOT_EDGE + SLOT_MS,
      remainingMs: 600000,
      open: 5,
      price: 5.06
    },
    charts: { tomato: chart(), carrot: chart({ base: 6 }), pumpkin: chart({ base: 30 }) },
    hint: {
      tomato: { direction: 'up', confidence: 0.62 },
      carrot: { direction: 'down', confidence: 0.58 },
      pumpkin: { direction: 'flat', confidence: 0.55 }
    },
    positions: [],
    history: [],
    orders: [],
    ...overrides
  }
}

test('票 79：顶部显示当前价、本根涨跌、mm:ss 倒计时与两种硬币', () => {
  // 开盘 5 分钟后：还剩 10 分钟。
  const header = view.headerView(payload(), SLOT_EDGE + 5 * 60 * 1000)
  assert.equal(header.crop, 'tomato')
  assert.equal(header.cropName, '小番茄')
  assert.equal(header.priceText, '5.06')
  assert.equal(header.openText, '5.00')
  assert.equal(header.changeText, '+1.20%')
  assert.equal(header.tone, 'up')
  // 收盘还有 10 分钟；每秒重画时按 now 现算。
  assert.equal(header.countdownText, '10:00')
  assert.equal(header.countdownMs, 600000)
  assert.equal(header.coinsAvailableText, '120')
  assert.equal(header.coinsTotalText, '172')
  assert.equal(header.coinsLockedText, '50')
  // 跌的时候符号与颜色反过来。
  const falling = payload()
  falling.charts.tomato = chart({
    current: { slot: SLOT, open: 5.1, high: 5.1, low: 4.9, price: 4.9, tick: 5, remainingMs: 600000 }
  })
  const down = view.headerView(falling, SLOT_EDGE + 5 * 60 * 1000)
  assert.equal(down.changeText, '-3.92%')
  assert.equal(down.tone, 'down')
})

test('票 79：倒计时在收盘那一刻停在 00:00，不出现负数', () => {
  const bar = payload().bar
  assert.equal(view.formatCountdown(bar.end - bar.start), '15:00')
  assert.equal(view.formatCountdown(1000), '00:01')
  assert.equal(view.formatCountdown(1), '00:01')
  assert.equal(view.formatCountdown(0), '00:00')
  assert.equal(view.formatCountdown(-500), '00:00')
  assert.equal(view.formatCountdown('nope'), '00:00')
  // 没有 now 时退回宿主给的 remainingMs（第一帧）。
  assert.equal(view.headerView(payload()).countdownText, '10:00')
  // 切作物不会让倒计时跳：三个作物共用同一根（用 bar.end 算）。
  const carrot = view.headerView(payload(), SLOT_EDGE + 5 * 60 * 1000, 'carrot')
  assert.equal(carrot.countdownText, '10:00')
  assert.equal(carrot.cropName, '胡萝卜')
})

test('票 81：本周盈亏 = 已实现 + 未实现，收益率 = 合计 / 周起点硬币', () => {
  const week = view.weekView(payload())
  assert.equal(week.pnl, 10.5)
  assert.equal(week.pnlText, '+10.5')
  assert.equal(week.pnlTone, 'up')
  assert.equal(week.pctText, '+2.10%')
  assert.equal(week.baseText, '500')
  assert.equal(week.hasBase, true)

  // base 0（新账本/坏文件）→ 收益率是「—」，不编一个 0%。
  const blank = view.weekView(payload({ week: { start: 0, pnl: 0, base: 0 } }))
  assert.equal(blank.baseText, '0')
  assert.equal(blank.hasBase, false)
  assert.equal(blank.pctText, '—')
  assert.equal(blank.pnlText, '0.0')

  // 老 payload 没有 unrealized/total 时按已实现算。
  const old = view.weekView(payload({ week: { start: 1, pnl: -4, base: 500 } }))
  assert.equal(old.pnlText, '-4.0')
  assert.equal(old.pctText, '-0.80%')
  assert.equal(old.pnlTone, 'down')

  // 亏损也是同一套符号。
  const loss = view.weekView(payload({ week: { start: 1, pnl: -10, base: 500, unrealized: -10, total: -20 } }))
  assert.equal(loss.pnlText, '-20.0')
  assert.equal(loss.pctText, '-4.00%')
})

test('票 81：风向显示置信度并写明「不是保证」；没有数据就是「—」', () => {
  const up = view.hintView(payload(), 'tomato')
  assert.equal(up.direction, 'up')
  assert.equal(up.label, '偏多')
  assert.equal(up.confidenceText, '62%')
  assert.equal(up.note, '不是保证')
  assert.equal(up.tone, 'up')
  assert.equal(view.hintView(payload(), 'carrot').label, '偏空')
  assert.equal(view.hintView(payload(), 'pumpkin').label, '横盘')
  const missing = view.hintView(payload({ hint: {} }), 'tomato')
  assert.equal(missing.label, '—')
  assert.equal(missing.note, '不是保证')
  assert.equal(missing.tone, 'flat')
})

test('票 81：下单区有三档杠杆（来自 payload）、预览句与作物跟着页签走', () => {
  const order = view.orderView(payload(), { side: 'short', margin: 100, leverage: 5, crop: 'carrot' })
  assert.equal(order.side, 'short')
  assert.equal(order.margin, 100)
  assert.equal(order.leverage, 5)
  assert.equal(order.crop, 'carrot')
  assert.equal(order.cropName, '胡萝卜')
  assert.equal(order.canSubmit, true)
  assert.equal(order.hint, '')
  assert.equal(order.submitLabel, '开一手')
  assert.equal(order.preview, '5× · 100 保证金：涨 1% = +5；跌 1% = −5；强平 −100')
  assert.deepEqual(order.sides.map((choice) => choice.label), ['做多', '做空'])
  assert.deepEqual(order.margins.map((choice) => choice.margin), [50, 100])
  assert.equal(order.margins[1].active, true)
  assert.deepEqual(order.leverages.map((choice) => choice.leverage), [1, 5, 20])
  assert.equal(order.leverages[1].active, true)
  // 白名单之外的方向/保证金/杠杆回到默认值。
  assert.equal(view.orderView(payload(), { side: 'up', margin: 7, leverage: 3 }).side, 'long')
  assert.equal(view.orderView(payload(), { side: 'long', margin: 7 }).margin, 50)
  assert.equal(view.orderView(payload(), { side: 'long', leverage: 3 }).leverage, 1)
})

test('票 81：预览句 1× 的强平是「—」；涨跌 1% 的数与 pnlOf 在 ±1% 上一致', () => {
  assert.equal(view.previewView({ margin: 100, leverage: 1 }).text,
    '1× · 100 保证金：涨 1% = +1；跌 1% = −1；强平 —')
  assert.equal(view.previewView({ margin: 50, leverage: 1 }).text,
    '1× · 50 保证金：涨 1% = +0.5；跌 1% = −0.5；强平 —')
  assert.equal(view.previewView({ margin: 100, leverage: 20 }).text,
    '20× · 100 保证金：涨 1% = +20；跌 1% = −20；强平 −100')
  assert.equal(view.previewView({ margin: 100, leverage: 5 }).liquidationLoss, 100)
  assert.equal(view.previewView({ margin: 50, leverage: 1 }).liquidationLoss, null)

  // 漂移：预览里的「涨 1%」必须等于纯规则 pnlOf 在 +1% 上的结果（反过来也是）。
  for (const margin of [50, 100]) {
    for (const leverage of [1, 5, 20]) {
      const predicted = view.previewView({ margin, leverage }).perPercent
      const plusOne = pnlOf({ side: 'long', margin, leverage, entry: 100, mark: 101 })
      const minusOne = pnlOf({ side: 'long', margin, leverage, entry: 100, mark: 99 })
      assert.equal(Math.round(predicted * 100), Math.round(plusOne * 100), margin + '×' + leverage)
      assert.equal(Math.round(-predicted * 100), Math.round(minusOne * 100), margin + '×' + leverage)
    }
  }
})

test('票 79：硬币不够时按钮禁用并写明原因；0 硬币写「去种地」', () => {
  const small = view.orderView(payload({ coins: { available: 49, locked: 0, total: 49 } }), { margin: 50 })
  assert.equal(small.canSubmit, false)
  assert.match(small.hint, /硬币不够/)
  assert.equal(small.margins[0].disabled, true)
  assert.equal(small.margins[1].disabled, true)

  const broke = view.orderView(payload({ coins: { available: 0, locked: 100, total: 100 } }), { margin: 50 })
  assert.equal(broke.canSubmit, false)
  assert.match(broke.hint, /先去种地/)
  assert.equal(broke.submitLabel, '去种地')
  assert.equal(view.emptyHints(payload({ coins: { available: 0, locked: 100, total: 100 } })).positions,
    '还没有持仓。硬币不够开仓时，先去种地。')
})

test('票 81：K 线几何——24 根 + 当前一根，高低点映射到 viewBox，底价/入场/强平线', () => {
  const geometry = view.chartGeometry({
    base: 5,
    bars: [
      { slot: 1, open: 4, high: 6, low: 4, close: 5 },
      { slot: 2, open: 5, high: 5.5, low: 4.5, close: 4.5 }
    ],
    current: null
  }, { width: 384, height: 200, entry: 5.2, liquidation: 4.5 })
  assert.equal(geometry.width, 384)
  assert.equal(geometry.height, 200)
  // 定义域 = [4, 6]（两根的高点/低点），底价 5 与入场/强平都在里面。
  assert.deepEqual(geometry.domain, { min: 4, max: 6 })
  assert.deepEqual(geometry.grid, [8, 101, 194])
  // y = 8 + (6 − 价格) / 2 × 186（plot: top 8、高 186）。
  assert.equal(geometry.bars[0].wickTop, 8)
  assert.equal(geometry.bars[0].wickBottom, 194)
  assert.equal(geometry.bars[0].bodyTop, 101)
  assert.equal(geometry.bars[0].bodyHeight, 93)
  assert.equal(geometry.bars[0].up, true)
  assert.equal(geometry.bars[1].up, false)
  assert.equal(geometry.bars[1].wickTop, 8 + (6 - 5.5) / 2 * 186)
  assert.equal(geometry.bars[1].wickBottom, 8 + (6 - 4.5) / 2 * 186)
  // 横轴：两根从左到右，蜡烛体不重叠且落在绘图区里。
  assert.ok(geometry.bars[0].centerX < geometry.bars[1].centerX)
  assert.ok(geometry.bars[0].x >= geometry.plot.left)
  assert.ok(geometry.bars[1].x + geometry.bars[1].width <= geometry.plot.left + geometry.plot.width)
  // 参考线：底价 / 入场 / 强平各一条，价与 y 一一对应。
  const lines = Object.fromEntries(geometry.lines.map((line) => [line.key, line]))
  assert.equal(lines.base.value, 5)
  assert.equal(lines.base.y, 101)
  assert.equal(lines.base.visible, true)
  assert.equal(lines.entry.value, 5.2)
  assert.equal(lines.entry.y, 8 + (6 - 5.2) / 2 * 186)
  assert.equal(lines.liquidation.value, 4.5)
  assert.equal(lines.liquidation.y, 8 + (6 - 4.5) / 2 * 186)
  assert.equal(geometry.priceLine, null)
})

test('票 81：当前一根有影线/实体/现价横线；离得太远的强平线不画但保留价格', () => {
  const geometry = view.chartGeometry({
    base: 5,
    bars: [{ slot: 1, open: 4.9, high: 5.1, low: 4.8, close: 5 }],
    current: { slot: 2, open: 5, high: 5.3, low: 4.95, price: 5.06, tick: 5, remainingMs: 600000 }
  }, { liquidation: -1000 })
  assert.equal(geometry.bars.length, 1)
  assert.equal(geometry.forming.slot, 2)
  assert.equal(geometry.forming.price, 5.06)
  assert.equal(geometry.forming.tick, 5)
  assert.ok(geometry.forming.wickTop <= geometry.forming.bodyTop)
  assert.ok(geometry.forming.wickBottom >= geometry.forming.bodyTop + geometry.forming.bodyHeight)
  assert.equal(geometry.priceLine.value, 5.06)
  assert.ok(geometry.priceLine.y >= geometry.forming.wickTop)
  assert.ok(geometry.priceLine.y <= geometry.forming.wickBottom)
  // 强平价 −1000 离 K 线太远：进不了定义域，图上不画（图例仍能显示它）。
  const liquidation = geometry.lines.find((line) => line.key === 'liquidation')
  assert.equal(liquidation.value, -1000)
  assert.equal(liquidation.visible, false)
  assert.equal(liquidation.y, null)
  // 空图 / 坏图是 null，不是 NaN 坐标。
  assert.equal(view.chartGeometry({ base: 5, bars: [] }), null)
  assert.equal(view.chartGeometry(null), null)
  // 全平的一根也不会除零：给一个最小高度。
  const flat = view.chartGeometry({ base: 5, bars: [{ slot: 1, open: 5, high: 5, low: 5, close: 5 }] })
  assert.equal(Number.isFinite(flat.bars[0].bodyTop), true)
  assert.equal(flat.bars[0].bodyHeight, 1)
})

test('票 81：图表卡片给出图例（底价/入场/强平）、第几根、空态', () => {
  const positions = [{
    id: 'p1',
    crop: 'tomato',
    side: 'long',
    margin: 100,
    leverage: 5,
    entry: 5.12,
    mark: 5.06,
    pnl: -5.8,
    liquidation: 4.1,
    stopLoss: 0.5
  }]
  const chart = view.chartView(payload({ positions }), { crop: 'tomato' })
  assert.equal(chart.crop, 'tomato')
  assert.equal(chart.hasChart, true)
  assert.equal(chart.priceText, '5.06')
  assert.equal(chart.slotText, '第 1959232 根 · 第 6/15 分钟')
  assert.equal(chart.baseText, '5.00')
  assert.deepEqual(chart.legend, [
    { key: 'base', label: '底价', text: '5.00', tone: 'base' },
    { key: 'entry', label: '入场', text: '5.12', tone: 'entry' },
    { key: 'liquidation', label: '强平', text: '4.10', tone: 'liquidation' }
  ])
  assert.equal(chart.entry, 5.12)
  assert.equal(chart.geometry.bars.length, 24)
  assert.equal(chart.geometry.forming.slot, SLOT)
  assert.equal(chart.geometry.priceLine.value, 5.06)

  // 没有该作物的持仓：入场/强平都是「—」，但底价线还在。
  const bare = view.chartView(payload(), { crop: 'carrot' })
  assert.equal(bare.legend[1].text, '—')
  assert.equal(bare.legend[2].text, '—')
  assert.equal(bare.baseText, '6.00')
  // 1× 的持仓没有强平价（null）→「—」，图上也没有那条线。
  const oneX = view.chartView(payload({
    positions: [{ ...positions[0], leverage: 1, liquidation: null }]
  }), { crop: 'tomato' })
  assert.equal(oneX.legend[2].text, '—')
  assert.equal(oneX.geometry.lines.find((line) => line.key === 'liquidation').visible, false)

  // 老 payload / 坏包没有 charts：画空态，不抛。
  const missing = view.chartView(payload({ charts: undefined }), { crop: 'tomato' })
  assert.equal(missing.hasChart, false)
  assert.equal(missing.geometry, null)
  assert.match(missing.emptyText, /行情还在算/)
  assert.equal(missing.priceText, '—')
})

test('票 81：作物页签有三个、切换后价格/风向/图例都跟着换', () => {
  const board = view.boardView(payload(), { now: SLOT_EDGE + 5 * 60 * 1000 })
  assert.deepEqual(board.crops.map((crop) => crop.id), ['tomato', 'carrot', 'pumpkin'])
  assert.deepEqual(board.crops.map((crop) => crop.label), ['小番茄', '胡萝卜', '南瓜'])
  assert.equal(board.crops[0].active, true)
  assert.equal(board.crops.every((crop) => crop.hasChart), true)
  assert.equal(board.order.crop, 'tomato')
  const carrot = view.boardView(payload(), { crop: 'carrot', now: SLOT_EDGE })
  assert.equal(carrot.crops[1].active, true)
  assert.equal(carrot.chart.crop, 'carrot')
  assert.equal(carrot.chart.baseText, '6.00')
  assert.equal(carrot.hint.label, '偏空')
  // 认不出的作物回到第一张图，不画空白。
  assert.equal(view.boardView(payload(), { crop: 'corn' }).chart.crop, 'tomato')
})

test('票 79：持仓卡有方向/杠杆、作物、盈亏、保证金、入场、现价、强平、止损', () => {
  const cards = view.positionCards(payload({
    positions: [{
      id: 'p1',
      crop: 'tomato',
      side: 'long',
      margin: 50,
      leverage: 5,
      entry: 5.1,
      mark: 5.06,
      pnl: -1.96,
      liquidation: 4.08,
      stopLoss: 0.25
    }, {
      id: 'p2',
      crop: 'carrot',
      side: 'short',
      margin: 100,
      leverage: 1,
      entry: 5,
      mark: 4.8,
      pnl: 4,
      liquidation: null,
      stopLoss: 0
    }]
  }))
  assert.equal(cards.length, 2)
  assert.equal(cards[0].title, '做多 · 小番茄 · 5×')
  assert.equal(cards[0].entryText, '5.10')
  assert.equal(cards[0].markText, '5.06')
  assert.equal(cards[0].liqText, '4.08')
  assert.equal(cards[0].pnlText, '-2.0')
  assert.equal(cards[0].pnlTone, 'down')
  assert.equal(cards[0].marginText, '50')
  assert.equal(cards[0].stopLevel, 0.25)
  assert.equal(cards[0].stopLabel, '−25%')
  assert.equal(cards[0].stopTitle, '止损 −25%')
  assert.equal(cards[0].nextStopLevel, 0.5, '点一下到下一档')
  assert.equal(cards[0].canStop, true)
  assert.equal(cards[0].canClose, true)
  assert.equal(cards[0].closeLabel, '平仓')
  // 1× 没有强平：显示「—」。
  assert.equal(cards[1].liqText, '—')
  assert.equal(cards[1].title, '做空 · 胡萝卜 · 1×')
  assert.equal(cards[1].stopLabel, '关')
  assert.equal(cards[1].pnlText, '+4.0')
  assert.equal(cards[1].pnlTone, 'up')
  // 正在结算的仓位不能点平仓/止损（钱已经走了一半）。
  const settling = view.positionCards(payload({
    positions: [{ id: 'p3', crop: 'tomato', side: 'long', margin: 50, leverage: 1, entry: 5, mark: 5, pnl: 0, settling: true }]
  }))
  assert.equal(settling[0].canClose, false)
  assert.equal(settling[0].canStop, false)
  assert.equal(settling[0].statusText, '结算中…')
})

test('票 81：止损按钮循环「关 → −25% → −50% → −100% → 关」，认不出的档位当关', () => {
  assert.deepEqual(view.stopLevels(), [0, 0.25, 0.5, 1])
  assert.equal(view.stopLabel(0), '关')
  assert.equal(view.stopLabel(0.25), '−25%')
  assert.equal(view.stopLabel(1), '−100%')
  assert.equal(view.nextStopLevel(0), 0.25)
  assert.equal(view.nextStopLevel(0.25), 0.5)
  assert.equal(view.nextStopLevel(0.5), 1)
  assert.equal(view.nextStopLevel(1), 0)
  assert.equal(view.stopLabel(0.3), '关')
  assert.equal(view.nextStopLevel(undefined), 0.25)
})

test('票 79：历史行写明方向/作物/盈亏/原因，时间用「多久以前」不依赖时区', () => {
  const now = SLOT_EDGE + 5 * SLOT_MS
  const rows = view.historyRows(payload({
    history: [
      { id: 'h1', crop: 'tomato', side: 'long', margin: 50, leverage: 5, entry: 5, exit: 5.5, pnl: 5, reason: 'settle', at: now - 3 * 60 * 1000 },
      { id: 'h2', crop: 'tomato', side: 'short', margin: 100, leverage: 1, entry: 5, exit: 5.1, pnl: -2, reason: 'close', at: now - 2 * 60 * 60 * 1000 },
      { id: 'h3', crop: 'carrot', side: 'long', margin: 100, leverage: 20, entry: 5, exit: 4.9, pnl: -100, reason: 'liquidate', at: now - 26 * 60 * 60 * 1000 },
      { id: 'h4', crop: 'pumpkin', side: 'long', margin: 50, leverage: 5, entry: 30, exit: 29.9, pnl: -2, reason: 'stop', at: now - 1000 }
    ]
  }), now)
  assert.equal(rows.length, 4)
  assert.equal(rows[0].title, '做多 · 小番茄 · 5×')
  assert.equal(rows[0].pnlText, '+5.0')
  assert.equal(rows[0].reasonText, '收盘结算')
  assert.equal(rows[0].atText, '3 分钟前')
  assert.equal(rows[1].reasonText, '手动平仓')
  assert.equal(rows[1].atText, '2 小时前')
  assert.equal(rows[1].exitText, '5.10')
  assert.equal(rows[2].reasonText, '强平')
  assert.equal(rows[2].atText, '1 天前')
  assert.equal(rows[3].reasonText, '止损')
  assert.equal(rows[3].atText, '刚刚')
  assert.equal(view.reasonText('weird'), '结算')
})

test('票 79：空态与坏输入都不抛——没有盘口数据时也能画出一扇空窗', () => {
  for (const bad of [null, undefined, 42, 'x', [], {}]) {
    const board = view.boardView(bad, { now: SLOT_EDGE })
    assert.equal(board.positions.length, 0)
    assert.equal(board.history.length, 0)
    assert.equal(board.header.priceText, '—')
    assert.equal(board.chart.hasChart, false)
    assert.equal(board.week.pctText, '—')
    assert.match(board.hints.history, /还没有结算记录/)
    // 邻居位先占住，票 82 才填数据。
    assert.match(board.hints.neighbors, /还没有邻居上线/)
  }
  // 认不出的作物先按 id 显示，别画空白。
  assert.equal(view.cropNameOf(payload(), 'corn'), 'corn')
  assert.equal(view.formatCoins(1234567), '1,234,567')
  assert.equal(view.formatTrim(5), '5')
  assert.equal(view.formatTrim(0.5), '0.5')
  assert.equal(view.formatTrim(0), '0')
})
