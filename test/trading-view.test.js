/**
 * 票 79 / 票 81 / 票 83：盘口窗的纯视图输出（K 线几何/下单区/到价挂单/持仓卡/历史/周盈亏/空态）。
 *
 * 渲染页和 Node 测试 require 的是同一份 `desktop/trading-view.js`；这里只测数字、坐标与
 * 文案，不测 DOM。几何用例用能整除的价格，断言精确的 viewBox 坐标，不留浮点尾巴。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

import { liquidationPriceOf, pnlOf } from '../src/trading-rules.js'

const require = createRequire(import.meta.url)
const view = require('../desktop/trading-view.js')

const SLOT_MS = 15 * 60 * 1000
const SLOT = 1959232
const SLOT_EDGE = SLOT * SLOT_MS
const LIMITS = {
  margins: [50, 100, 250],
  leverages: [1, 5, 20],
  crops: [
    { id: 'tomato', name: '小番茄' },
    { id: 'carrot', name: '胡萝卜' },
    { id: 'pumpkin', name: '南瓜' }
  ],
  historyLimit: 50,
  allIn: true,
  targetRatio: { floor: 0.55, ceil: 1.75 }
}
const ORDER_ID = '3f0f2a1c-1d2e-4b3a-8c9d-0e1f2a3b4c5d'

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
  // SPEC v10 US7：下单前就能看到强平价；做空的强平线在现价上方。
  assert.equal(order.liquidationPrice, 5.06 * 1.2)
  assert.equal(order.liquidationText, '强平价 6.07 · 涨到就平')
  assert.deepEqual(order.sides.map((choice) => choice.label), ['做多', '做空'])
  // 票 83：三档预设 + 一颗「全下」（金额 = 此刻可用硬币 120）。
  assert.deepEqual(order.margins.map((choice) => choice.margin), [50, 100, 250, 120])
  assert.deepEqual(order.margins.map((choice) => choice.label), ['50', '100', '250', '全下'])
  assert.equal(order.margins[1].active, true)
  assert.equal(order.margins[3].allIn, true)
  assert.equal(order.margins[3].disabled, false)
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

test('术语 US7/票 81：强平价与宿主 liquidationPriceOf 同一条公式（drift）', () => {
  const at = payload()
  at.charts.tomato = chart({
    base: 100,
    current: { slot: SLOT, open: 100, high: 100, low: 100, price: 100, tick: 0, remainingMs: 1 }
  })
  for (const side of ['long', 'short']) {
    for (const leverage of [5, 20]) {
      const order = view.orderView(at, { side, leverage, margin: 50 })
      assert.equal(
        order.liquidationPrice,
        liquidationPriceOf({ side, entry: 100, leverage }),
        side + ' ' + leverage + '× 的强平价必须和宿主一致'
      )
      assert.equal(order.liquidationText,
        '强平价 ' + order.liquidationPrice.toFixed(2) + ' · ' +
        (side === 'long' ? '跌到就平' : '涨到就平'))
    }
  }
  // 1× 没有强平线：数字是 null，文案是「强平价 —」（SPEC v10 US7）。
  const oneX = view.orderView(at, { leverage: 1, margin: 50 })
  assert.equal(oneX.liquidationPrice, null)
  assert.equal(oneX.liquidationText, '强平价 —')
  // 没有现价（老宿主/坏包）：不凭空造一条线。
  assert.equal(view.orderView({ coins: { available: 100 } }).liquidationPrice, null)
  assert.equal(view.orderView({ coins: { available: 100 } }).liquidationText, '强平价 —')
  // 预览句仍是 SPEC v10 的原文，不被强平价那行改写。
  assert.equal(view.orderView(at, { side: 'short', leverage: 5, margin: 100 }).preview,
    '5× · 100 保证金：涨 1% = +5；跌 1% = −5；强平 −100')
})

test('票 79：硬币不够时按钮禁用并写明原因；0 硬币写「去种地」', () => {
  const small = view.orderView(payload({ coins: { available: 49, locked: 0, total: 49 } }), { margin: 50 })
  assert.equal(small.canSubmit, false)
  assert.match(small.hint, /硬币不够/)
  assert.equal(small.margins[0].disabled, true)
  assert.equal(small.margins[1].disabled, true)
  assert.equal(small.margins[2].disabled, true)
  // 全下 49 是合法金额（够不着 50 的预设，但押上全部 49 是可以的）。
  assert.equal(small.margins[3].margin, 49)
  assert.equal(small.margins[3].disabled, false)

  const broke = view.orderView(payload({ coins: { available: 0, locked: 100, total: 100 } }), { margin: 50 })
  assert.equal(broke.canSubmit, false)
  assert.match(broke.hint, /先去种地/)
  assert.equal(broke.submitLabel, '去种地')
  assert.equal(broke.margins[3].label, '全下')
  assert.equal(broke.margins[3].margin, 0)
  assert.equal(broke.margins[3].disabled, true, '0 硬币时全下也禁用')
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
    // 票 82：没有 league 就画空榜，空态文案照旧。
    assert.deepEqual(board.league.rows, [])
    assert.equal(board.league.hasPeers, false)
    assert.match(board.hints.neighbors, /还没有邻居上线/)
  }
  // 老 payload 没有 limits.leverages：杠杆退回 1×（票 80 之后宿主会下发 [1,5,20]）。
  const legacy = view.orderView({ coins: { available: 120 } })
  assert.deepEqual(legacy.leverages.map((choice) => choice.leverage), [1])
  assert.equal(legacy.leverage, 1)
  assert.equal(view.boardView({ bar: { crop: 'tomato', open: 5, price: 5.1 } }).order.leverage, 1)
  // 认不出的作物先按 id 显示，别画空白。
  assert.equal(view.cropNameOf(payload(), 'corn'), 'corn')
  assert.equal(view.formatCoins(1234567), '1,234,567')
  assert.equal(view.formatTrim(5), '5')
  assert.equal(view.formatTrim(0.5), '0.5')
  assert.equal(view.formatTrim(0), '0')
})

/** 票 82：榜的数据形状（宿主 `buildLeague` 的输出）。 */
function league (overrides = {}) {
  return {
    rows: [
      {
        deviceId: '00000000-0000-4000-8000-0000000000bb',
        nickname: '阿赢',
        weekPnl: 12,
        weekPnlPct: 0.035,
        positions: [{ crop: 'tomato', side: 'long', leverage: 5 }, { crop: 'carrot', side: 'long', leverage: 1 }],
        me: false
      },
      {
        deviceId: '00000000-0000-4000-8000-0000000000aa',
        nickname: '小米',
        weekPnl: -8,
        weekPnlPct: null,
        positions: [{ crop: 'pumpkin', side: 'short', leverage: 20 }],
        me: true
      }
    ],
    sentiment: { long: 2, short: 1, flat: 0 },
    self: { weekPnl: -8, weekPnlPct: null },
    ...overrides
  }
}

test('票 82：真人周榜画分数/收益率/持仓摘要；收益率是比率、没报就是「—」', () => {
  const board = view.boardView(payload({ league: league() }), { now: SLOT_EDGE })
  assert.equal(board.league.rows.length, 2)
  assert.equal(board.league.countText, '2 人')
  assert.equal(board.league.hasPeers, true)
  const [win, own] = board.league.rows
  assert.equal(win.nickname, '阿赢')
  assert.equal(win.me, false)
  // 12 就是「+12」：榜上的分数按整数金币画（不是 +12.0）。
  assert.equal(win.pnlText, '+12')
  assert.equal(win.pnlTone, 'up')
  // 0.035 是比率 → +3.50%；邻居没报就是「—」，不拿 0% 冒充。
  assert.equal(win.pctText, '+3.50%')
  assert.equal(win.positionsText, '多 2 · 空 0')
  // US19：邻居的持仓也画成 chip（作物名来自 payload.limits.crops）。
  assert.deepEqual(win.chips.map((chip) => chip.text), ['小番茄多 5×', '胡萝卜多 1×'])
  assert.deepEqual(win.chips.map((chip) => chip.tone), ['long', 'long'])
  assert.equal(win.chipOverflowText, '')
  assert.equal(own.me, true)
  assert.equal(own.pnlText, '-8')
  assert.equal(own.pnlTone, 'down')
  assert.equal(own.pctText, '—')
  assert.equal(own.pctTone, 'flat')
  assert.equal(own.positionsText, '多 0 · 空 1')
  // LAN 情绪数的是仓位：2 多 + 1 空。
  assert.deepEqual(board.league.sentiment, { long: 2, short: 1, text: '多 2 · 空 1', tone: 'long' })
})

test('术语 US19：邻居持仓 chips——最多 3 条 + 「+N」，空仓仍是观望', () => {
  const crowded = view.leagueView(payload({
    league: league({
      rows: [{
        deviceId: '00000000-0000-4000-8000-0000000000bb',
        nickname: '满仓',
        weekPnl: 9,
        weekPnlPct: 0.02,
        positions: [
          { crop: 'tomato', side: 'long', leverage: 20 },
          { crop: 'carrot', side: 'short', leverage: 5 },
          { crop: 'pumpkin', side: 'long', leverage: 1 },
          { crop: 'tomato', side: 'short', leverage: 5 },
          { crop: 'carrot', side: 'long', leverage: 20 }
        ],
        me: false
      }],
      sentiment: { long: 3, short: 2, flat: 0 }
    })
  }))
  const row = crowded.rows[0]
  assert.deepEqual(row.chips.map((chip) => chip.text), ['小番茄多 20×', '胡萝卜空 5×', '南瓜多 1×'])
  assert.deepEqual(row.chips.map((chip) => chip.tone), ['long', 'short', 'long'])
  assert.equal(row.chipOverflowText, '+2')
  assert.equal(row.positionsText, '多 3 · 空 2', '摘要仍保留完整计数')

  // 空仓 = 观望：没有 chip，也没有「+0」。
  const flat = view.leagueView(payload({
    league: league({
      rows: [{ deviceId: '00000000-0000-4000-8000-0000000000cc', nickname: '观望', weekPnl: 0, positions: [], me: false }],
      sentiment: { long: 0, short: 0, flat: 1 }
    })
  }))
  assert.deepEqual(flat.rows[0].chips, [])
  assert.equal(flat.rows[0].chipOverflowText, '')
  assert.equal(flat.rows[0].positionsText, '观望')
  // 坏持仓条目只丢自己：不能把整行 chips 画成 NaN。
  const mixed = view.leagueView(payload({
    league: league({
      rows: [{
        deviceId: '00000000-0000-4000-8000-0000000000dd',
        nickname: '坏行',
        weekPnl: 1,
        positions: [null, { side: 'up' }, { crop: 'tomato', side: 'long', leverage: 'x' }],
        me: false
      }],
      sentiment: { long: 0, short: 0, flat: 1 }
    })
  }))
  assert.deepEqual(mixed.rows[0].chips.map((chip) => chip.text), ['小番茄多 1×'])
})

test('票 82：只有自己时写「观望」，并保留「还没有邻居上线…行情照走」', () => {
  const alone = view.boardView(payload({
    league: league({
      rows: [{
        deviceId: '00000000-0000-4000-8000-0000000000aa',
        nickname: '小米',
        weekPnl: 0,
        weekPnlPct: 0,
        positions: [],
        me: true
      }],
      sentiment: { long: 0, short: 0, flat: 1 },
      self: { weekPnl: 0, weekPnlPct: 0 }
    })
  }), { now: SLOT_EDGE })
  assert.equal(alone.league.rows.length, 1)
  assert.equal(alone.league.rows[0].me, true)
  assert.equal(alone.league.rows[0].positionsText, '观望')
  assert.equal(alone.league.hasPeers, false)
  assert.equal(alone.league.sentiment.text, '观望')
  assert.equal(alone.league.sentiment.tone, 'flat')
  assert.match(alone.league.empty, /还没有邻居上线/)
  assert.match(alone.league.empty, /行情照走/)

  // 有仓位的人写「多 2 · 空 1」；全场空仓的判定只看 long + short。
  const both = view.leagueView({
    league: league({ sentiment: { long: 0, short: 0, flat: 3 } })
  })
  assert.deepEqual(both.rows.map((row) => row.positionsText), ['多 2 · 空 0', '多 0 · 空 1'])
  assert.equal(both.sentiment.text, '观望')
})

test('术语 SPEC 旧邻居：有人在线但没周报时，空态写「旧版本」；其余不变', () => {
  const own = {
    deviceId: '00000000-0000-4000-8000-0000000000aa',
    nickname: '小米',
    weekPnl: 0,
    weekPnlPct: 0,
    positions: [],
    me: true
  }
  const alone = (watchers) => view.boardView(payload({
    league: league({
      rows: [own],
      sentiment: { long: 0, short: 0, flat: 1 },
      watchers
    })
  }), { now: SLOT_EDGE })
  // 邻居在线、但一条周报都没发 → 旧版本。
  const old = alone({ online: 2, reported: 0 })
  assert.deepEqual(old.league.watchers, { online: 2, reported: 0 })
  assert.equal(old.league.empty, '邻居是旧版本，还没有周报')
  assert.doesNotMatch(old.league.empty, /还没有邻居上线/)
  // 没有在线邻居 → 原来的「还没有邻居上线…行情照走」。
  assert.match(alone({ online: 0, reported: 0 }).league.empty, /还没有邻居上线/)
  assert.match(alone({ online: 0, reported: 0 }).league.empty, /行情照走/)
  // 有人在线、也确实发过周报（只是行还没到/被过滤）→ 不冒充旧版本。
  assert.match(alone({ online: 2, reported: 1 }).league.empty, /还没有邻居上线/)
  // 坏 watchers 不抛，按 0/0 处理。
  for (const bad of [null, 'x', 42, [], { online: 'x', reported: -1 }]) {
    const board = alone(bad)
    assert.deepEqual(board.league.watchers, { online: 0, reported: 0 }, JSON.stringify(bad))
    assert.match(board.league.empty, /还没有邻居上线/)
  }
})

test('票 82：榜的坏输入不抛——缺行/坏行/缺情绪都退回空榜', () => {
  for (const bad of [null, 42, 'x', [], { rows: 'x' }, { rows: [null, 42, { weekPnl: 'x' }] }]) {
    const board = view.boardView(payload({ league: bad }), { now: SLOT_EDGE })
    assert.deepEqual(board.league.rows, [])
    assert.equal(board.league.sentiment.text, '观望')
    assert.equal(board.league.hasPeers, false)
  }
  // 缺 sentiment 时按「没有仓位」画观望；昵称缺失用「邻居」兜底。
  const nameless = view.leagueView({
    league: { rows: [{ deviceId: 'x', weekPnl: 3, positions: [{ crop: 'tomato', side: 'long' }] }] }
  })
  assert.equal(nameless.rows[0].nickname, '邻居')
  assert.equal(nameless.rows[0].positionsText, '多 1 · 空 0')
  assert.equal(nameless.sentiment.text, '观望')
})

test('票 83：到价面板——没点开时只有开关；点开后目标价默认现价、带内可挂、带外写明原因', () => {
  const closed = view.orderView(payload())
  assert.equal(closed.limit.enabled, false)
  assert.equal(closed.limit.toggleLabel, '到价')
  assert.equal(closed.limit.canPlace, false, '没点开「到价」时挂单按钮不可用')
  assert.equal(closed.limit.targetText, '5.06', '默认目标价 = 现价（两位小数）')
  assert.equal(closed.limit.bandText, '2.75–8.75', '0.55–1.75 × 底价 5')
  assert.equal(closed.limit.placeLabel, '挂单')
  assert.equal(closed.limit.hint, '')

  const opened = view.orderView(payload(), { limitOpen: true })
  assert.equal(opened.limit.enabled, true)
  assert.equal(opened.limit.canPlace, true)
  assert.equal(opened.limit.target, 5.06)
  assert.equal(opened.limit.hint, '')
  assert.match(opened.limit.note, /跌到目标价/)
  assert.match(opened.limit.note, /收盘没成交自动撤单/)

  // 玩家输到一半的原文原样带回；带外目标价不装成可用。
  const outside = view.orderView(payload(), { limitOpen: true, targetText: '99' })
  assert.equal(outside.limit.targetText, '99')
  assert.equal(outside.limit.canPlace, false)
  assert.match(outside.limit.hint, /目标价要在 2\.75–8\.75 之间/)
  const half = view.orderView(payload(), { limitOpen: true, targetText: '5.' })
  assert.equal(half.limit.targetText, '5.')
  // 做空等的是「涨到目标价」。
  const short = view.orderView(payload(), { side: 'short', limitOpen: true, targetText: '5.5' })
  assert.match(short.limit.note, /涨到目标价/)
  assert.equal(short.limit.target, 5.5)
  assert.equal(short.limit.canPlace, true)

  // 硬币不够时：输入框还能填，但挂单按钮禁用并写清原因。
  const poor = view.orderView(payload({ coins: { available: 40, locked: 0, total: 40 } }), {
    limitOpen: true,
    targetText: '5.5'
  })
  assert.equal(poor.limit.canPlace, false)
  assert.match(poor.limit.hint, /硬币不够/)
})

test('票 83：全下——按钮金额 = 可用硬币，选中后预览/强平按这个金额算', () => {
  const rich = view.orderView(payload({ coins: { available: 251, locked: 0, total: 251 } }), {
    leverage: 5,
    allIn: true
  })
  assert.equal(rich.allIn, true)
  assert.equal(rich.margin, 251)
  assert.equal(rich.margins[3].margin, 251)
  assert.equal(rich.margins[3].active, true)
  assert.equal(rich.margins[0].active, false)
  assert.equal(rich.preview, '5× · 251 保证金：涨 1% = +12.55；跌 1% = −12.55；强平 −251')
  // 全下金额不是 50 的整数倍也照算（保证金规则接受任意整数）。
  assert.equal(rich.previewParts.perPercent, 12.55)
  assert.equal(rich.canSubmit, true)

  // 硬币花光后「全下」落回预设，不会卡在一个 0 金额上。
  const broke = view.orderView(payload({ coins: { available: 0, locked: 0, total: 0 } }), { allIn: true })
  assert.equal(broke.allIn, false)
  assert.equal(broke.margin, 50)
  assert.equal(broke.submitLabel, '去种地')
})

test('票 83：挂单列表——方向/作物/目标价/保证金/距收盘的剩余时间 + 撤单', () => {
  const order = {
    id: ORDER_ID,
    crop: 'carrot',
    side: 'short',
    target: 6.5,
    margin: 100,
    leverage: 20,
    placedAt: SLOT_EDGE,
    slot: SLOT,
    remainingMs: 600000
  }
  const rows = view.orderRows(payload({ orders: [order] }), SLOT_EDGE + 5 * 60 * 1000)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, ORDER_ID)
  assert.equal(rows[0].title, '做空 · 胡萝卜 · 20×')
  assert.equal(rows[0].targetText, '6.50')
  assert.equal(rows[0].marginText, '100')
  assert.equal(rows[0].remainingMs, 600000)
  assert.equal(rows[0].remainingText, '剩 10:00')
  assert.equal(rows[0].canCancel, true)
  assert.equal(rows[0].cancelLabel, '撤单')
  // 没有 now 时退回宿主给的 remainingMs（窗口第一帧）。
  assert.equal(view.orderRows(payload({ orders: [order] })).length, 1)
  // 坏行只丢自己；缺省是空列表。
  assert.deepEqual(view.orderRows(payload({ orders: [null, { id: '' }, order] }), SLOT_EDGE).length, 1)
  assert.deepEqual(view.orderRows(payload({ orders: [] })), [])
  const board = view.boardView(payload({ orders: [order] }), { now: SLOT_EDGE + 5 * 60 * 1000 })
  assert.equal(board.orders.length, 1)
  assert.match(view.emptyHints(payload()).orders, /点开「到价」/)
  assert.match(view.emptyHints(payload({ coins: { available: 0, locked: 0, total: 0 } })).orders, /先去种地/)
})

test('评审 P1：持仓/挂单表头用真实总数说明截断（显示最近 200）', () => {
  const position = (index) => ({
    id: 'p' + index,
    crop: 'tomato',
    side: 'long',
    margin: 50,
    leverage: 1,
    entry: 5,
    mark: 5,
    pnl: 0,
    liquidation: null,
    stopLoss: 0
  })
  const many = Array.from({ length: 200 }, (_, index) => position(index))
  const truncated = view.boardView(payload({ positions: many, positionsTotal: 240 }), { now: SLOT_EDGE })
  assert.equal(truncated.positions.length, 200)
  assert.equal(truncated.positionsMetaText, '持仓 240 · 显示最近 200')
  const exact = view.boardView(payload({ positions: many.slice(0, 40), positionsTotal: 40 }), { now: SLOT_EDGE })
  assert.equal(exact.positionsMetaText, '持仓 40')
  // 老宿主没有 totals：表头退回真实收到的条数，不编一个不存在的合计。
  const legacy = view.boardView(payload({ positions: many.slice(0, 3) }), { now: SLOT_EDGE })
  assert.equal(legacy.positionsMetaText, '持仓 3')

  const order = (index) => ({
    id: 'o' + index,
    crop: 'tomato',
    side: 'long',
    target: 2.75,
    margin: 50,
    leverage: 1,
    placedAt: SLOT_EDGE,
    slot: SLOT,
    remainingMs: 1
  })
  const oneOfMany = view.boardView(payload({ orders: [order(0)], ordersTotal: 3 }), { now: SLOT_EDGE })
  assert.equal(oneOfMany.ordersMetaText, '挂单 3 · 显示最近 1')
  assert.equal(view.boardView(payload({ orders: [order(0)] }), { now: SLOT_EDGE }).ordersMetaText, '挂单 1')
})

test('User Story 30：盘口窗上写明「没有手续费、没有资金费、没有风险控制」', async () => {
  const html = await readFile(new URL('../desktop/board.html', import.meta.url), 'utf8')
  assert.match(html, /没有手续费、没有资金费、没有风险控制/)
  assert.match(html, /硬币赔光就去种地/)
  // SPEC v10 US7：下单区真的有一行强平价，并且渲染端把它填进去。
  assert.match(html, /id="order-liquidation"/)
  const script = await readFile(new URL('../desktop/board.js', import.meta.url), 'utf8')
  assert.match(script, /order-liquidation/)
  assert.match(script, /order\.liquidationText/)
  // US19：榜行把 view 给的 chips 画出来（不是只画「多 N · 空 M」计数）。
  assert.match(script, /league-chips/)
  assert.match(script, /chipOverflowText/)
})
