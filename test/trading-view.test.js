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

import { TRADING_ERROR_CODES, tradingErrorText } from '../src/trading-text.js'
import {
  PRICE_CEIL_RATIO,
  PRICE_FLOOR_RATIO,
  liquidationPriceOf,
  pnlOf,
  targetBandOf
} from '../src/trading-rules.js'

const require = createRequire(import.meta.url)
const view = require('../desktop/trading-view.js')

const SLOT_MS = 15 * 60 * 1000
const SLOT = 1959232
const SLOT_EDGE = SLOT * SLOT_MS
const HOUR_MS = 60 * 60 * 1000
/** 票 84：窗口吃的是宿主下发的周期清单（唯一来源在 src/trading-rules.js）。 */
const TIMEFRAMES = [
  { id: '15m', label: '15分' },
  { id: '1h', label: '1时' },
  { id: '1d', label: '1日' },
  { id: '1w', label: '1周' }
]
/** 三个粗周期的桶起点：挑的是工单里的示例日期（本地时区）。 */
const TF_START = {
  '1h': new Date(2026, 10, 18, 14, 0, 0, 0).getTime(),
  '1d': new Date(2026, 10, 16, 0, 0, 0, 0).getTime(),
  '1w': new Date(2026, 10, 10, 0, 0, 0, 0).getTime()
}
const TF_SPAN = { '1h': HOUR_MS, '1d': 24 * HOUR_MS, '1w': 7 * 24 * HOUR_MS }

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
  return {
    slot,
    start: slot * SLOT_MS,
    end: (slot + 1) * SLOT_MS,
    open: 5,
    high: 5.2,
    low: 4.9,
    close: 5.1,
    ...overrides
  }
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
    current: {
      slot: SLOT,
      start: SLOT_EDGE,
      end: SLOT_EDGE + SLOT_MS,
      open: 5,
      high: 5.2,
      low: 4.9,
      price: 5.06,
      tick: 5,
      remainingMs: 600000
    },
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

/** 本地 `HH:MM` / `M月D日`：期望值和窗口用同一套 Date 本地格式化现算。 */
function hhmm (ms) {
  const date = new Date(ms)
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
}

function monthDay (ms) {
  const date = new Date(ms)
  return (date.getMonth() + 1) + '月' + date.getDate() + '日'
}

function timeframeChart (timeframe, overrides = {}) {
  const start = TF_START[timeframe]
  const end = start + TF_SPAN[timeframe]
  return chart({
    current: {
      slot: Math.floor(start / SLOT_MS),
      start,
      end,
      open: 5,
      high: 5.2,
      low: 4.9,
      price: 5.06,
      // 粗周期没有「本根第几分钟」：宿主发 null，窗口不许把它写成 0。
      tick: null,
      remainingMs: end - start
    },
    ...overrides
  })
}

/** 票 84 的完整 payload：`charts`（15 分，旧字段）+ `timeframes`（四周期）+ 周期白名单。 */
function tfPayload (overrides = {}) {
  const base = payload(overrides)
  // 三个作物底价不同（5 / 6 / 30）：粗周期的图也要带对底价，图例才和 15 分一致。
  const baseOf = { tomato: 5, carrot: 6, pumpkin: 30 }
  const period = (timeframe) => {
    const block = {}
    for (const crop of ['tomato', 'carrot', 'pumpkin']) {
      block[crop] = timeframeChart(timeframe, { base: baseOf[crop] })
    }
    return block
  }
  return {
    ...base,
    timeframes: {
      '15m': base.charts,
      '1h': period('1h'),
      '1d': period('1d'),
      '1w': period('1w')
    },
    limits: { ...base.limits, timeframes: TIMEFRAMES }
  }
}

/** 票 88/89：运行时目录已有 10 种作物；盘口不能比农场少，作物条要能横滚。 */
const TEN_CROPS = [
  ['pea', '豌豆', 6],
  ['tomato', '小番茄', 5],
  ['strawberry', '草莓', 7],
  ['radish', '白萝卜', 8],
  ['carrot', '胡萝卜', 6],
  ['rice', '稻米', 10],
  ['corn', '玉米', 9],
  ['watermelon', '西瓜', 24],
  ['pumpkin', '南瓜', 30],
  ['grape', '葡萄', 24]
]

function tenCropPayload (overrides = {}) {
  const charts = {}
  const hint = {}
  for (const [id, , price] of TEN_CROPS) {
    charts[id] = chart({ base: price })
    hint[id] = { direction: 'up', confidence: 0.6 }
  }
  return payload({
    limits: {
      ...LIMITS,
      crops: TEN_CROPS.map(([id, name]) => ({ id, name })),
      timeframes: TIMEFRAMES
    },
    charts,
    hint,
    timeframes: { '15m': charts },
    ...overrides
  })
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

test('票 79 / 票 89：硬币不够时按钮禁用并写明「差 N 硬币」；0 硬币写「去种地」', () => {
  const small = view.orderView(payload({ coins: { available: 49, locked: 0, total: 49 } }), { margin: 50 })
  assert.equal(small.canSubmit, false)
  assert.equal(small.hint, '差 1 硬币')
  assert.equal(small.margins[0].disabled, true)
  assert.equal(small.margins[0].disabledReason, '差 1 硬币')
  assert.equal(small.margins[1].disabled, true)
  assert.equal(small.margins[2].disabled, true)
  // 全下 49 是合法金额（够不着 50 的预设，但押上全部 49 是可以的）。
  assert.equal(small.margins[3].margin, 49)
  assert.equal(small.margins[3].disabled, false)
  assert.equal(small.margins[3].disabledReason, '')

  const broke = view.orderView(payload({ coins: { available: 0, locked: 100, total: 100 } }), { margin: 50 })
  assert.equal(broke.canSubmit, false)
  assert.equal(broke.hint, '去种地')
  assert.equal(broke.submitLabel, '去种地')
  assert.equal(broke.margins[0].disabledReason, '差 50 硬币')
  assert.equal(broke.margins[3].label, '全下')
  assert.equal(broke.margins[3].margin, 0)
  assert.equal(broke.margins[3].disabled, true, '0 硬币时全下也禁用')
  assert.equal(broke.margins[3].disabledReason, '去种地')
  assert.equal(view.emptyHints(payload({ coins: { available: 0, locked: 100, total: 100 } })).positions,
    '还没有持仓')
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
  assert.equal(geometry.height, 200, 'chartGeometry 的显式 height 仍由调用方给')
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
  // 票 84：不再打印绝对根号，改成这一根的真实时间范围（本地时区现算）。
  assert.equal(chart.slotText, hhmm(SLOT_EDGE) + '–' + hhmm(SLOT_EDGE + SLOT_MS) + ' · 第 6/15 分钟')
  assert.doesNotMatch(chart.slotText, /第 \d+ 根/)
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

test('票 84：四个周期可切，时间标签按本地时区写（不再出现绝对根号）', () => {
  const full = tfPayload()
  const tabs = view.chartView(full, { crop: 'tomato' }).timeframes
  assert.deepEqual(tabs.map((entry) => [entry.id, entry.label]), [
    ['15m', '15分'], ['1h', '1时'], ['1d', '1日'], ['1w', '1周']
  ])
  assert.deepEqual(tabs.map((entry) => entry.active), [true, false, false, false])
  assert.deepEqual(tabs.map((entry) => entry.disabled), [false, false, false, false])

  const expected = {
    '15m': hhmm(SLOT_EDGE) + '–' + hhmm(SLOT_EDGE + SLOT_MS) + ' · 第 6/15 分钟',
    '1h': hhmm(TF_START['1h']) + '–' + hhmm(TF_START['1h'] + HOUR_MS),
    '1d': monthDay(TF_START['1d']),
    '1w': monthDay(TF_START['1w']) + '–' + monthDay(TF_START['1w'] + TF_SPAN['1w'] - 1)
  }
  for (const [timeframe, label] of Object.entries(expected)) {
    const chart = view.chartView(full, { crop: 'tomato', timeframe })
    assert.equal(chart.timeframe, timeframe)
    assert.equal(chart.timeframeLabel, TIMEFRAMES.find((entry) => entry.id === timeframe).label)
    assert.equal(chart.slotText, label, timeframe + ' 的时间标签')
    // 绝对根号（自 1970 起的 slot 序号）不许再出现在任何周期上。
    assert.doesNotMatch(chart.slotText, /第 \d+ 根/)
    assert.doesNotMatch(chart.ariaLabel, /第 \d+ 根/)
    // 选中态跟着当前周期走。
    assert.deepEqual(chart.timeframes.map((entry) => entry.active),
      TIMEFRAMES.map((entry) => entry.id === timeframe))
  }
  // 工单里的示例文案（固定日期，本地时区）：14:00–15:00 / 11月16日 / 11月10日–11月16日。
  assert.equal(view.chartView(full, { timeframe: '1h' }).slotText, '14:00–15:00')
  assert.equal(view.chartView(full, { timeframe: '1d' }).slotText, '11月16日')
  assert.equal(view.chartView(full, { timeframe: '1w' }).slotText, '11月10日–11月16日')
  // 15 分之外的周期没有「第 m/15 分钟」：tick 是 null。
  for (const timeframe of ['1h', '1d', '1w']) {
    assert.doesNotMatch(view.chartView(full, { timeframe }).slotText, /分钟/)
  }
})

test('票 84：入场/强平线只在 15 分画；其它周期只画底价线并提示「仍按 15 分结算」', () => {
  const position = {
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
  }
  const full = tfPayload({ positions: [position] })
  const contract = view.chartView(full, { crop: 'tomato', timeframe: '15m' })
  assert.equal(contract.entry, 5.12)
  assert.equal(contract.liquidation, 4.1)
  assert.deepEqual(contract.legend.map((entry) => entry.text), ['5.00', '5.12', '4.10'])
  assert.equal(contract.geometry.lines.find((line) => line.key === 'base').visible, true)
  assert.equal(contract.geometry.lines.find((line) => line.key === 'entry').visible, true)
  // 15 分是合约本身：不显示那句「其它周期只看趋势」的提示。
  assert.equal(contract.settleNote.visible, false)

  for (const timeframe of ['1h', '1d', '1w']) {
    const chart = view.chartView(full, { crop: 'tomato', timeframe })
    assert.equal(chart.timeframe, timeframe)
    // 入场/强平一律不给数、不画线；图例对应位置写「—」。
    assert.equal(chart.entry, null)
    assert.equal(chart.liquidation, null)
    assert.equal(chart.reference, null)
    assert.deepEqual(chart.legend.map((entry) => entry.text), ['5.00', '—', '—'])
    assert.equal(chart.geometry.lines.find((line) => line.key === 'base').visible, true)
    assert.equal(chart.geometry.lines.find((line) => line.key === 'entry').visible, false)
    assert.equal(chart.geometry.lines.find((line) => line.key === 'liquidation').visible, false)
    // 产品文案：看趋势可以，结算仍只认 15 分钟收盘。
    assert.equal(chart.settleNote.visible, true)
    assert.equal(chart.settleNote.text, '15 分钟结算')
  }
})

test('票 84：老 payload（只有 charts）退回 15 分；切周期不改顶部价格与下单预览', () => {
  const legacy = payload()
  const chart = view.chartView(legacy, { crop: 'tomato', timeframe: '1w' })
  assert.equal(chart.timeframe, '15m')
  assert.deepEqual(chart.timeframes, [{ id: '15m', label: '15分', active: true, disabled: false }])
  assert.match(chart.slotText, /第 6\/15 分钟$/)
  assert.equal(chart.settleNote.visible, false)

  // 有 timeframes 的新包：1 周的图可以画，但顶部价格/订单区仍吃 15 分的合约数据。
  const full = tfPayload()
  const weekly = view.boardView(full, { now: SLOT_EDGE + 5 * 60 * 1000, timeframe: '1w' })
  const contract = view.boardView(full, { now: SLOT_EDGE + 5 * 60 * 1000 })
  assert.equal(weekly.chart.timeframe, '1w')
  assert.equal(weekly.chart.timeframes.length, 4)
  assert.deepEqual(weekly.header, contract.header)
  assert.deepEqual(weekly.order, contract.order)
  assert.deepEqual(weekly.week, contract.week)
  // 认不出的周期退回 15 分，不白屏。
  assert.equal(view.chartView(full, { timeframe: '5m' }).timeframe, '15m')

  // 更老的宿主连 start/end 都没有：只写分钟进度，不拼出「— · 第 6/15 分钟」，
  // 也绝不退回原来的绝对根号。
  const noTimes = payload()
  noTimes.charts.tomato.current = {
    slot: SLOT, open: 5, high: 5.2, low: 4.9, price: 5.06, tick: 5, remainingMs: 600000
  }
  const bareChart = view.chartView(noTimes, { crop: 'tomato' })
  assert.equal(bareChart.slotText, '第 6/15 分钟')
  assert.doesNotMatch(bareChart.slotText, /第 1959232 根/)
})

test('票 84：周期页签的 DOM 接线（容器/键盘顺序/提示行）在页面和渲染端里', async () => {
  const html = await readFile(new URL('../desktop/board.html', import.meta.url), 'utf8')
  assert.match(html, /id="timeframe-tabs"/)
  assert.match(html, /id="chart-settle-hint"/)
  assert.match(html, /aria-label="K 线周期"/)
  const script = await readFile(new URL('../desktop/board.js', import.meta.url), 'utf8')
  assert.match(script, /timeframeTabsEl/)
  assert.match(script, /data-timeframe/)
  assert.match(script, /chartSettleHintEl/)
  // 周期切换是本地重画，不发 IPC：渲染端不该出现「切周期 -> submit」这种接线。
  assert.match(script, /timeframe = button\.dataset\.timeframe/)
  assert.doesNotMatch(script, /api\.submit\(\{[^}]*timeframe/)
})

test('票 87：价格轴 4–5 档、时间轴 3–5 个刻度，格式按周期走（15 分/1 时/1 日/1 周）', () => {
  const full = tfPayload()
  const expectedTimeShape = {
    // 15 分写一根的起–止（工单示例 11:30–11:45），1 时只写起点，1 日/1 周写日期。
    '15m': /^\d{2}:\d{2}–\d{2}:\d{2}$/,
    '1h': /^\d{2}:\d{2}$/,
    '1d': /^\d{1,2}月\d{1,2}日$/,
    '1w': /^\d{1,2}月\d{1,2}日$/
  }
  for (const timeframe of ['15m', '1h', '1d', '1w']) {
    const chart = view.chartView(full, { crop: 'tomato', timeframe })
    const geometry = chart.geometry
    assert.equal(geometry.width, view.CHART_WIDTH, timeframe + ' 图宽')
    assert.equal(geometry.height, view.CHART_HEIGHT, timeframe + ' 图高')
    // 价格轴：4–5 档，落在定义域里，文案与 formatPrice 同一口径。
    assert.ok(geometry.priceTicks.length >= 4 && geometry.priceTicks.length <= 5, timeframe)
    for (const tick of geometry.priceTicks) {
      assert.equal(tick.text, view.formatPrice(tick.value))
      assert.ok(tick.value >= geometry.domain.min && tick.value <= geometry.domain.max)
      assert.ok(tick.y >= geometry.plot.top && tick.y <= geometry.plot.top + geometry.plot.height)
    }
    // 时间轴：3–5 个，x 在绘图区里，首尾贴边不越界。
    assert.ok(geometry.timeTicks.length >= 3 && geometry.timeTicks.length <= 5, timeframe)
    for (const tick of geometry.timeTicks) {
      assert.match(tick.text, expectedTimeShape[timeframe], timeframe + ' 的刻度文案')
      assert.ok(tick.x >= geometry.plot.left && tick.x <= geometry.plot.left + geometry.plot.width)
    }
    assert.equal(geometry.timeTicks[0].anchor, 'start')
    assert.equal(geometry.timeTicks.at(-1).anchor, 'end')
    // chartAxes 是公开入口：DOM 只读，不在窗口里重算一遍。
    assert.deepEqual(view.chartAxes(geometry, timeframe).price, geometry.priceTicks)
  }
  // 固定日期（本地时区）的标签与工单示例一致。
  assert.equal(view.timeTickLabelOf('1h', TF_START['1h'], TF_START['1h'] + HOUR_MS), '14:00')
  assert.equal(view.timeTickLabelOf('1d', TF_START['1d'], TF_START['1d'] + TF_SPAN['1d']), '11月16日')
  assert.equal(view.timeTickLabelOf('1w', TF_START['1w'], TF_START['1w'] + TF_SPAN['1w']), '11月10日')
  assert.equal(view.timeTickLabelOf('15m', TF_START['1h'], TF_START['1h'] + SLOT_MS), '14:00–14:15')
})

test('票 87：蜡烛几何有圆角实体/圆头影线/确定性笔触，实体不重叠且都在绘图区里', () => {
  const geometry = view.chartView(tfPayload(), { crop: 'tomato' }).geometry
  const candles = geometry.forming === null ? geometry.bars : geometry.bars.concat([geometry.forming])
  assert.equal(candles.length, 25)
  const wickWidths = new Set()
  const radii = new Set()
  const tilts = new Set()
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    assert.ok(candle.x >= geometry.plot.left, index + ' 左边界')
    assert.ok(candle.x + candle.width <= geometry.plot.left + geometry.plot.width, index + ' 右边界')
    // 圆角实体 + 圆头影线：DOM 直接吃这些字段，不再自己夹范围。
    assert.ok(candle.sketch.bodyRadius >= 2 && candle.sketch.bodyRadius <= 3)
    assert.ok(candle.sketch.wickWidth >= 1.2 && candle.sketch.wickWidth <= 2)
    assert.ok(candle.sketch.bodyStrokeWidth >= 0.6 && candle.sketch.bodyStrokeWidth <= 1.2)
    assert.ok(candle.sketch.tilt >= -1 && candle.sketch.tilt <= 1)
    assert.equal(geometry.sketch.lineCap, 'round')
    assert.ok(candle.bodyHeight >= 1)
    wickWidths.add(candle.sketch.wickWidth)
    radii.add(candle.sketch.bodyRadius)
    tilts.add(candle.sketch.tilt)
    if (index > 0) {
      const previous = candles[index - 1]
      assert.ok(candle.x > previous.x + previous.width, '相邻实体不能重叠')
    }
    // 同一根重算两次必须完全一致（截图/测试才可复现）。
    assert.deepEqual(
      view.candleSketchOf(candle.index, candle.slot),
      candle.sketch
    )
  }
  // 有粗有细、有正有歪，才像一支笔画出来的；但范围固定。
  assert.ok(wickWidths.size > 1, '影线粗细要有变化')
  assert.ok(radii.size > 1, '圆角要有变化')
  assert.ok(tilts.size > 1, '倾斜要有变化')
  // 滤镜参数固定、只引用一次 `url(#sketch-ink)`（DOM 层断言在下面）。
  assert.equal(geometry.sketch.filterId, 'sketch-ink')
  assert.ok(geometry.sketch.scale >= 1.2 && geometry.sketch.scale <= 1.8)
  assert.ok(Number.isInteger(geometry.sketch.seed))
  assert.equal(geometry.sketch.filter, 'url(#sketch-ink)')
  assert.equal(geometry.priceTicks.length, 5)
})

test('票 87：现价胶囊跟随最后一根，引线从蜡烛指到轴槽里的贴纸', () => {
  const withForming = view.chartView(tfPayload(), { crop: 'tomato' }).geometry
  const tag = withForming.priceTag
  assert.equal(tag.text, view.formatPrice(withForming.forming.price))
  assert.equal(tag.value, withForming.forming.price)
  assert.equal(tag.tone, withForming.forming.up ? 'up' : 'down')
  // 贴纸留在画布内、贴着右侧价格轴；引线从最后一根出发。
  assert.ok(tag.x >= withForming.plot.left + withForming.plot.width)
  assert.ok(tag.x + tag.width <= withForming.width)
  assert.ok(tag.y >= withForming.plot.top)
  assert.ok(tag.y + tag.height <= withForming.plot.top + withForming.plot.height)
  assert.equal(tag.leader.x1, withForming.forming.centerX)
  assert.ok(tag.leader.y1 >= withForming.forming.wickTop)
  assert.ok(tag.leader.y1 <= withForming.forming.wickBottom)
  assert.equal(tag.leader.x2, tag.x)
  // 没有 forming（契约收盘后那一瞬）仍跟最后一根的收盘价。
  const closed = view.chartGeometry({
    base: 5,
    bars: [
      { slot: 1, start: 0, end: SLOT_MS, open: 5, high: 5.2, low: 4.9, close: 5.1 },
      { slot: 2, start: SLOT_MS, end: 2 * SLOT_MS, open: 5.1, high: 5.3, low: 5, close: 5.25 }
    ]
  }, { padding: view.CHART_AXIS_PADDING })
  assert.equal(closed.priceTag.value, 5.25)
  assert.equal(closed.priceTag.text, '5.25')
  assert.equal(view.priceTagOf(view.chartGeometry({ base: 5, bars: [] })), null)
})

test('票 87：十字线吸附最近一根、便签写时间与开高低收，坐标夹在绘图区里', () => {
  const geometry = view.chartView(tfPayload(), { crop: 'tomato' }).geometry
  const target = geometry.bars[5]
  const hit = view.crosshairAt(geometry, target.centerX + 2, geometry.plot.top + 40)
  assert.ok(hit)
  assert.equal(hit.index, 5)
  assert.equal(hit.x, target.centerX)
  assert.equal(hit.y, geometry.plot.top + 40)
  assert.equal(hit.timeText, view.timeLabelOf('15m', target.start, target.end))
  assert.match(hit.text, /开 5\.00/)
  assert.match(hit.text, /高 5\.20/)
  assert.match(hit.text, /低 4\.90/)
  assert.match(hit.text, /收 5\.10/)
  assert.ok(hit.text.includes(hit.timeText), '便签文案必须带这一根的时间')
  assert.deepEqual(hit.rows.map((row) => row.label), ['开', '高', '低', '收'])
  assert.deepEqual(hit.rows.map((row) => row.text), ['5.00', '5.20', '4.90', '5.10'])
  // 便签整体夹在绘图区里：靠右翻到左边，靠上翻到下面，最后再夹一次。
  for (const x of [geometry.plot.left, target.centerX, geometry.plot.left + geometry.plot.width - 1]) {
    for (const y of [geometry.plot.top, geometry.plot.top + geometry.plot.height / 2,
      geometry.plot.top + geometry.plot.height - 1]) {
      const at = view.crosshairAt(geometry, x, y)
      assert.ok(at.card.left >= geometry.plot.left)
      assert.ok(at.card.left + at.card.width <= geometry.plot.left + geometry.plot.width)
      assert.ok(at.card.top >= geometry.plot.top)
      assert.ok(at.card.top + at.card.height <= geometry.plot.top + geometry.plot.height)
    }
  }
  // 绘图区外（价格轴/时间轴/画布外）不画十字线。
  assert.equal(view.crosshairAt(geometry, geometry.plot.left - 1, 100), null)
  assert.equal(view.crosshairAt(geometry, geometry.plot.left + geometry.plot.width + 1, 100), null)
  assert.equal(view.crosshairAt(geometry, NaN, 100), null)
  assert.equal(view.crosshairAt(null, 100), null)
  // 最后一根是形成中：便签收价用现价，标题标「进行中」。
  const forming = view.crosshairAt(geometry, geometry.plot.left + geometry.plot.width - 2, 100)
  assert.equal(forming.forming, true)
  assert.equal(forming.rows[3].text, view.formatPrice(geometry.forming.price))
  assert.match(forming.title, /进行中/)
  assert.ok(forming.highlight.width >= target.width)
})

test('票 91：版面常量是「作物条 40 / 图 268 / 下单横条 104 / 底部 196」，老 payload 也能画', async () => {
  assert.equal(view.BOARD_WIDTH, 760)
  assert.equal(view.BOARD_HEIGHT, 700)
  assert.equal(view.CHART_WIDTH, 720)
  assert.equal(view.CHART_HEIGHT, 228)
  assert.deepEqual(view.LAYOUT.columns.left, ['positions', 'history'])
  // 票 91：下单搬去图下横条，右列只剩真人周榜。
  assert.deepEqual(view.LAYOUT.columns.right, ['league'])
  assert.equal(view.LAYOUT.chart.fullWidth, true)
  // 票 91 的固定版面数字：窗口 CSS 与测试吃同一份。
  assert.equal(view.LAYOUT.headerHeight, 50)
  assert.equal(view.LAYOUT.cropStripHeight, 40)
  assert.equal(view.LAYOUT.chartCardHeight, 268)
  assert.equal(view.LAYOUT.orderBarHeight, 104)
  assert.equal(view.LAYOUT.orderBar.height, 104)
  assert.equal(view.LAYOUT.orderBar.rows, 2)
  assert.equal(view.LAYOUT.orderBar.controlHeight, 32)
  assert.equal(view.LAYOUT.orderBar.submitWidth, 132)
  assert.equal(view.LAYOUT.orderBar.submitHeight, 36)
  assert.equal(view.LAYOUT.orderBar.gap, 10)
  assert.equal(view.LAYOUT.orderBar.marginColumns, 4)
  assert.equal(view.LAYOUT.orderBar.leverageColumns, 3)
  assert.equal(view.LAYOUT.bottom.rightWidth, 300)
  assert.equal(view.LAYOUT.bottom.historyHeight, 88)
  // 760×700 的高度预算必须刚好用完：app 边框 4 + 顶栏 50 + body 上下 padding 14 +
  // 三处 8px 行距 + 作物 40 + 图 268 + 下单 104 + 底部 196 = 700。
  const heightBudget = 4 + view.LAYOUT.headerHeight + 14 + 3 * 8 +
    view.LAYOUT.cropStripHeight + view.LAYOUT.chartCardHeight +
    view.LAYOUT.orderBarHeight + 196
  assert.equal(heightBudget, view.LAYOUT.board.height)

  const board = view.boardView(tfPayload(), { crop: 'tomato', now: SLOT_EDGE })
  assert.equal(board.chart.geometry.width, 720)
  assert.equal(board.chart.geometry.height, 228)
  assert.ok(board.chart.geometry.timeTicks.length >= 3)
  // 老 payload（只有 charts，没有 timeframes/start/end）不抛：图照画，时间轴没数据就留空。
  const legacy = view.boardView(payload(), { crop: 'tomato', now: SLOT_EDGE })
  assert.equal(legacy.chart.hasChart, true)
  assert.equal(legacy.chart.timeframe, '15m')
  assert.doesNotMatch(legacy.chart.slotText, /第 \d+ 根/)
  const legacyGeometry = legacy.chart.geometry
  assert.ok(legacyGeometry.priceTicks.length >= 3)
  // 坏包：没有图就是空态，几何为 null，不造 NaN 坐标。
  assert.equal(view.boardView(payload({ charts: undefined }), { now: SLOT_EDGE }).chart.geometry, null)

  const html = await readFile(new URL('../desktop/board.html', import.meta.url), 'utf8')
  // 票 91：作物条 / 图卡 / 下单横条 / 底部四行，顺序和高度都写死在 .body 的 grid 里。
  assert.match(html, /grid-template-rows: 40px 268px 104px minmax\(0, 1fr\)/)
  assert.match(html, /class="card chart-card"/)
  assert.match(html, /class="card order-bar"/)
  assert.match(html, /viewBox="0 0 720 228"/)
  assert.match(html, /\.chart-svg \{[\s\S]*?height: 228px/)
  assert.doesNotMatch(html, /grid-template-areas:[\s\S]{0,80}'chart order'/)
  // 页面本身不滚（内层列表可以滚），窗口内容 760×700 内收住。
  assert.match(html, /html,\s*\n\s*body \{[\s\S]*?overflow: hidden/)
  // 下单横条不套内部滚动容器；主按钮就在横条里（不再是卡片底部）。
  assert.doesNotMatch(html, /order-scroll/)
  assert.match(html, /class="order-row order-row-primary"/)
  assert.match(html, /id="submit"/)
  // 手绘滤镜只引用一次；文字在独立清晰层，不套滤镜。
  const script = await readFile(new URL('../desktop/board.js', import.meta.url), 'utf8')
  assert.match(script, /feTurbulence/)
  assert.match(script, /feDisplacementMap/)
  assert.equal((script.match(/filter: geometry\.sketch\.filter/g) ?? []).length, 1)
  assert.match(script, /class: 'chart-crisp'/)
  assert.match(script, /class: 'chart-ink'/)
  // 轴、价格胶囊、参考线标签和十字线都有接线。
  assert.match(script, /geometry\.priceTicks/)
  assert.match(script, /geometry\.timeTicks/)
  assert.match(script, /price-tag/)
  assert.match(script, /ref-label/)
  assert.match(script, /view\.crosshairAt/)
  assert.match(script, /addEventListener\('pointermove'/)
  assert.match(script, /addEventListener\('pointerleave'/)
  // 票 89：跌蜡烛空心属性接到 DOM 上。
  assert.match(script, /data-hollow/)
  assert.doesNotMatch(script, /console\.log/)
})


test('票 89：作物条支持任意数量（10 种），选中索引与箭头禁用态来自纯视图', () => {
  const ten = tenCropPayload()
  const first = view.cropStripView(ten, null)
  assert.equal(first.items.length, 10)
  assert.equal(first.selectedIndex, 0)
  assert.equal(first.overflow, true)
  assert.equal(first.arrows.prev.enabled, false)
  assert.equal(first.arrows.next.enabled, true)
  assert.equal(first.arrows.prev.disabledReason, '已经是第一组')

  const last = view.cropStripView(ten, 'grape')
  assert.equal(last.selectedIndex, 9)
  assert.equal(last.windowStart, 4)
  assert.equal(last.arrows.prev.enabled, true)
  assert.equal(last.arrows.next.enabled, false)
  assert.equal(last.arrows.next.disabledReason, '已经是最后一组')
  assert.equal(last.items.filter((item) => item.active).length, 1)
  // 选中第 6 种时窗口居中，两边都还能滚。
  const middle = view.cropStripView(ten, 'rice')
  assert.equal(middle.selectedIndex, 5)
  assert.equal(middle.windowStart, 2)
  assert.equal(middle.arrows.prev.enabled, true)
  assert.equal(middle.arrows.next.enabled, true)

  // 3 种作物不溢出：两颗箭头都禁用，作物条不出现渐隐。
  const three = view.cropStripView(payload(), null)
  assert.equal(three.overflow, false)
  assert.equal(three.windowStart, 0)
  assert.equal(three.arrows.prev.enabled, false)
  assert.equal(three.arrows.next.enabled, false)

  // boardView 带同一份 cropStrip；Tab 顺序含 10 个 chip + 两颗箭头且不重复。
  const board = view.boardView(ten, { now: SLOT_EDGE })
  assert.equal(board.cropStrip.items.length, 10)
  assert.equal(board.crops.length, 10)
  assert.equal(board.cropStrip.selectedIndex, 0)
  const keys = view.focusOrder(ten)
  assert.deepEqual(keys.slice(0, 3), ['display-toggle', 'chart-type:candle', 'chart-type:line'])
  assert.equal(keys[5], 'close-button')
  assert.equal(keys[6], 'crop-prev')
  assert.deepEqual(keys.slice(16, 19), ['crop:grape', 'crop-next', 'timeframe:15m'])
  assert.equal(new Set(keys).size, keys.length)
})

test('票 89：文案瘦身——周胶囊一位小数、空态一行、结算提示最短', async () => {
  const week = view.weekView(payload({ week: { pnl: -3, base: 65, unrealized: 0, total: -3 } }))
  assert.equal(week.pnlMinusText, '−3.0')
  assert.equal(week.pctParenText, '(−4.6%)')
  assert.equal(week.pillText, '本周 −3.0 (−4.6%)')
  assert.equal(week.pnlText, '-3.0', '裸数字仍走 ASCII，表格里正负号宽度一致')
  assert.equal(view.weekView(payload({ week: { pnl: 0, base: 0 } })).pillText, '本周 0.0 (—)')

  assert.deepEqual(view.emptyHints(payload()), {
    positions: '还没有持仓',
    history: '还没有结算',
    orders: '没有挂单',
    neighbors: '等邻居上线'
  })

  const weekly = view.chartView(tfPayload(), { crop: 'tomato', timeframe: '1w' })
  assert.equal(weekly.settleNote.text, '15 分钟结算')
  assert.equal(weekly.settleNote.visible, true)
  assert.equal(view.chartView(tfPayload(), { timeframe: '15m' }).settleNote.visible, false)
  assert.equal(view.chartView(payload({ charts: undefined })).emptyText, '行情还在算')

  const html = await readFile(new URL('../desktop/board.html', import.meta.url), 'utf8')
  const gone = [
    '15 分钟合约 · 收盘自动结算',
    '关：直接按现价开仓',
    '硬币不够，选小一点的保证金或先去卖点作物',
    '还没有持仓。选好方向和保证金',
    '还没有结算记录。收盘或手动平仓后',
    '等邻居打开 DSH 就会出现在这里',
    'LAN 情绪',
    '合约仍按 15 分钟收盘结算',
    '没有手续费、没有资金费、没有风险控制',
    '硬币赔光就去种地'
  ]
  for (const text of gone) assert.ok(!html.includes(text), 'board.html 还留着旧长句：' + text)
  const script = await readFile(new URL('../desktop/board.js', import.meta.url), 'utf8')
  for (const text of gone) assert.ok(!script.includes(text), 'board.js 还留着旧长句：' + text)
})

test('票 89：跌蜡烛空心——视图给 hollow、DOM 写 data-hollow、CSS 用纸色填充', async () => {
  const geometry = view.chartGeometry({
    base: 5,
    bars: [
      { slot: 1, open: 5, high: 5.2, low: 4.8, close: 4.9 },
      { slot: 2, open: 4.9, high: 5.1, low: 4.8, close: 5 }
    ]
  })
  assert.equal(geometry.bars[0].up, false)
  assert.equal(geometry.bars[0].hollow, true)
  assert.equal(geometry.bars[1].up, true)
  assert.equal(geometry.bars[1].hollow, false)
  // 形成中的那一根也带同一个字段。
  const forming = view.chartView(tfPayload(), { crop: 'tomato' }).geometry.forming
  assert.equal(typeof forming.hollow, 'boolean')
  // 票 89：底价/入场挨得很近时，参考线标签要错开而不是叠字。
  const close = view.chartGeometry({
    base: 5,
    bars: [{ slot: 1, open: 4.9, high: 5.1, low: 4.8, close: 5 }],
    current: { slot: 2, open: 5, high: 5.1, low: 4.9, price: 5, tick: 1, remainingMs: 1 }
  }, { entry: 4.99, liquidation: 4.98 })
  const labels = close.lines.filter((line) => line.visible).map((line) => line.labelY)
  assert.equal(labels.length, 3)
  for (let index = 1; index < labels.length; index += 1) {
    assert.ok(labels[index] - labels[index - 1] >= 13, '参考线标签至少错开 13px')
  }
  const script = await readFile(new URL('../desktop/board.js', import.meta.url), 'utf8')
  assert.match(script, /'data-hollow': candle\.hollow/)
  const html = await readFile(new URL('../desktop/board.html', import.meta.url), 'utf8')
  assert.match(html, /\.chart-svg \.body\.down,[\s\S]*?fill: var\(--paper\)/)
  assert.match(html, /stroke: var\(--rose\)/)
})

test('票 91：下单横条两排、4/3 档、没有滚动容器；11px 只留给图轴', async () => {
  const html = await readFile(new URL('../desktop/board.html', import.meta.url), 'utf8')
  // 票 91：整宽横条里的两排，不再是 300px 窄列里的三行 label+控件。
  assert.match(html, /class="order-row order-row-primary"/)
  assert.match(html, /class="order-row order-row-secondary"/)
  assert.doesNotMatch(html, /\.field-row \{/)
  assert.match(html, /\.order-row \.chip-row\.margins \{[\s\S]*?repeat\(4, 42px\)/)
  assert.match(html, /\.order-row \.chip-row\.leverages \{[\s\S]*?repeat\(3, 42px\)/)
  // 同一组内相邻点击目标 ≥8px；组与组之间 ≥10px。
  assert.match(html, /\.order-row \.chip-row \{[\s\S]*?gap: 8px/)
  assert.match(html, /\.order-row \{[\s\S]*?gap: 10px/)
  const orderBar = /\.order-bar \{([\s\S]*?)\}/.exec(html)
  assert.ok(orderBar)
  assert.match(orderBar[1], /overflow: visible/)
  assert.doesNotMatch(orderBar[1], /overflow-y: auto|overflow: auto/)
  // 横条高度/主按钮尺寸/控件高度/间距都来自纯视图的契约，CSS 得跟它一致。
  assert.match(html, /\.order-bar \{[\s\S]*?gap: 12px/)
  assert.match(html, /\.order-row \{[\s\S]*?gap: 10px/)
  assert.match(html, /\.order-row-primary \{[\s\S]*?height: 36px/)
  assert.match(html, /\.order-row-secondary \{[\s\S]*?height: 32px/)
  assert.match(html, /\.chip \{[\s\S]*?height: 32px/)
  assert.match(html, /\.submit \{[\s\S]*?width: 132px;\s*height: 36px/)
  // 到价面板是横条下方的浮层：不推页面、不撑高，也不会被卡片裁掉。
  assert.match(html, /\.limit-box \{[\s\S]*?position: absolute;/)
  assert.match(html, /\.limit-box \{[\s\S]*?top: calc\(100% \+ 6px\)/)
  const preview = /\.preview \{([\s\S]*?)\}/.exec(html)
  assert.match(preview[1], /white-space: nowrap/)
  assert.match(preview[1], /text-overflow: ellipsis/)
  assert.match(html, /id="crop-scroll"/)
  assert.match(html, /id="crop-prev"/)
  assert.match(html, /id="crop-next"/)
  const cropScroll = /\.crop-scroll \{([\s\S]*?)\}/.exec(html)
  assert.ok(cropScroll)
  assert.match(cropScroll[1], /overflow-x: auto/)
  assert.match(cropScroll[1], /overflow-y: hidden/)

  // 字号：除图轴/便签的 11px 外，正文/标签都 ≥12px；11px 只出现在 `.chart-svg` 规则里。
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
  let checked = 0
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    for (const match of body.matchAll(/font-size:\s*([\d.]+)px/g)) {
      checked += 1
      const size = Number(match[1])
      assert.ok(size >= 11, selector.trim() + ' 的字号 ' + size + 'px 太小')
      if (size === 11) assert.match(selector, /\.chart-svg/, selector.trim() + ' 的 11px 只允许图轴/便签')
    }
  }
  assert.ok(checked > 20, '字号检查至少覆盖 20 条规则（实际 ' + checked + '）')

  const script = await readFile(new URL('../desktop/board.js', import.meta.url), 'utf8')
  assert.match(script, /updateCropArrows/)
  assert.match(script, /ensureCropVisible/)
  assert.match(script, /scrollCropsBy/)
  assert.match(script, /addEventListener\('wheel'/)
  assert.match(script, /addEventListener\('keydown'/)
  // 下单卡不滚：渲染端不再把目标价往某个滚动区里推。
  assert.doesNotMatch(script, /scrollIntoView/)
})

test('票 81：作物页签有三个、切换后价格/风向/图例都跟着换', () => {  const board = view.boardView(payload(), { now: SLOT_EDGE + 5 * 60 * 1000 })
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
    assert.equal(board.hints.history, '还没有结算')
    // 票 82：没有 league 就画空榜，空态文案照旧。
    assert.deepEqual(board.league.rows, [])
    assert.equal(board.league.hasPeers, false)
    assert.equal(board.hints.neighbors, '等邻居上线')
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

test('票 81/评审 P2：Tab 顺序是纯函数——× → 页签 → 下单区 → 撤单 → 持仓卡', () => {
  const order = {
    id: ORDER_ID,
    crop: 'tomato',
    side: 'long',
    target: 5.5,
    margin: 50,
    leverage: 5,
    placedAt: SLOT_EDGE,
    slot: SLOT,
    remainingMs: 1
  }
  const position = {
    id: 'p1',
    crop: 'tomato',
    side: 'long',
    margin: 50,
    leverage: 5,
    entry: 5,
    mark: 5,
    pnl: 0,
    liquidation: 4,
    stopLoss: 0
  }
  const keys = view.focusOrder(payload({ orders: [order], positions: [position] }))
  assert.deepEqual(keys, [
    // 票 91：顶栏「显示」弹层在 × 左边；两组分段的选项紧跟开关（收起时不可聚焦）。
    'display-toggle',
    'chart-type:candle', 'chart-type:line',
    'theme:color', 'theme:mono',
    'close-button',
    // 票 89：作物条的左右滚动箭头排在作物 chip 两边。
    'crop-prev',
    'crop:tomato', 'crop:carrot', 'crop:pumpkin',
    'crop-next',
    // 老 payload 只有 15 分一档，周期页签照样进 Tab 顺序（票 84）。
    'timeframe:15m',
    'side:long', 'side:short',
    'margin:50', 'margin:100', 'margin:250', 'margin:all-in',
    'leverage:1', 'leverage:5', 'leverage:20',
    'limit-toggle', 'limit-input', 'limit-place', 'submit',
    'cancel:' + ORDER_ID,
    'stop:p1', 'close:p1'
  ])
  // tabindex 只能给一个元素：顺序表里每个键唯一。
  assert.equal(new Set(keys).size, keys.length)
  // 老/坏 payload 退回兜底白名单，不抛；每一步都是窗口认得的键。
  for (const bad of [null, undefined, 42, 'x', []]) {
    const fallback = view.focusOrder(bad)
    assert.equal(fallback[0], 'display-toggle')
    assert.equal(fallback[5], 'close-button')
    assert.deepEqual(fallback.slice(-4), ['limit-toggle', 'limit-input', 'limit-place', 'submit'])
    assert.equal(new Set(fallback).size, fallback.length)
  }
  // 票 84：四档周期都进 Tab 顺序，紧跟在作物页签后面，且不重复。
  const four = view.focusOrder(tfPayload())
  assert.deepEqual(four.slice(11, 15), ['timeframe:15m', 'timeframe:1h', 'timeframe:1d', 'timeframe:1w'])
  assert.equal(new Set(four).size, four.length)
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

test('票 82 / 票 89：只有自己时写「观望」，空态只留一行「等邻居上线」', () => {
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
  assert.equal(alone.league.empty, '等邻居上线')

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
  assert.doesNotMatch(old.league.empty, /等邻居上线/)
  // 没有在线邻居 → 一行「等邻居上线」。
  assert.equal(alone({ online: 0, reported: 0 }).league.empty, '等邻居上线')
  // 有人在线、也确实发过周报（只是行还没到/被过滤）→ 不冒充旧版本。
  assert.equal(alone({ online: 2, reported: 1 }).league.empty, '等邻居上线')
  // 坏 watchers 不抛，按 0/0 处理。
  for (const bad of [null, 'x', 42, [], { online: 'x', reported: -1 }]) {
    const board = alone(bad)
    assert.deepEqual(board.league.watchers, { online: 0, reported: 0 }, JSON.stringify(bad))
    assert.equal(board.league.empty, '等邻居上线')
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
  // 票 89：关着时不写「关：直接按现价开仓」，开着只写可挂价格带。
  assert.equal(closed.limit.noteText, '')

  const opened = view.orderView(payload(), { limitOpen: true })
  assert.equal(opened.limit.enabled, true)
  assert.equal(opened.limit.canPlace, true)
  assert.equal(opened.limit.target, 5.06)
  assert.equal(opened.limit.hint, '')
  assert.equal(opened.limit.noteText, '可挂 2.75–8.75')
  assert.match(opened.limit.noteTitle, /跌到目标价/)
  assert.match(opened.limit.noteTitle, /收盘没成交自动撤单/)

  // 玩家输到一半的原文原样带回；带外目标价不装成可用。
  const outside = view.orderView(payload(), { limitOpen: true, targetText: '99' })
  assert.equal(outside.limit.targetText, '99')
  assert.equal(outside.limit.canPlace, false)
  assert.match(outside.limit.hint, /目标价要在 2\.75–8\.75 之间/)
  const half = view.orderView(payload(), { limitOpen: true, targetText: '5.' })
  assert.equal(half.limit.targetText, '5.')
  // 做空等的是「涨到目标价」。
  const short = view.orderView(payload(), { side: 'short', limitOpen: true, targetText: '5.5' })
  assert.match(short.limit.noteTitle, /涨到目标价/)
  assert.equal(short.limit.target, 5.5)
  assert.equal(short.limit.canPlace, true)

  // 硬币不够时：输入框还能填，但挂单按钮禁用并写清原因。
  const poor = view.orderView(payload({ coins: { available: 40, locked: 0, total: 40 } }), {
    limitOpen: true,
    targetText: '5.5'
  })
  assert.equal(poor.limit.canPlace, false)
  assert.equal(poor.limit.hint, '差 10 硬币')
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
  assert.equal(view.emptyHints(payload()).orders, '没有挂单')
  assert.equal(view.emptyHints(payload({ coins: { available: 0, locked: 0, total: 0 } })).orders, '没有挂单')
})

test('评审 P2：到价目标带只从 payload 比例算，与宿主常量同源（drift）', () => {
  const band = targetBandOf({ crop: 'tomato' })
  const base = payload().charts.tomato.base
  assert.deepEqual(band, {
    min: base * PRICE_FLOOR_RATIO,
    max: base * PRICE_CEIL_RATIO
  })
  const viewPayload = payload()
  viewPayload.limits = {
    ...LIMITS,
    targetRatio: { floor: PRICE_FLOOR_RATIO, ceil: PRICE_CEIL_RATIO }
  }
  const order = view.orderView(viewPayload)
  assert.equal(order.limit.bandText, view.formatPrice(band.min) + '–' + view.formatPrice(band.max))
  assert.equal(order.limit.bandText, '2.75–8.75')
  // 窗口没有把 0.55/1.75 写死：换一组比例，带子跟着 payload 走（老宿主可只发比例）。
  const shifted = view.orderView(payload({
    limits: { ...LIMITS, targetRatio: { floor: 0.5, ceil: 2 } }
  }))
  assert.equal(shifted.limit.bandText, '2.50–10.00')
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

test('User Story 30：盘口窗上写明「无手续费 · 无资金费 · 无风控」', async () => {
  const html = await readFile(new URL('../desktop/board.html', import.meta.url), 'utf8')
  // 票 89：一整段 fine print 压成一行，放在下单卡底部。
  assert.match(html, /无手续费 · 无资金费 · 无风控/)
  // SPEC v10 US7：下单区真的有一行强平价，并且渲染端把它填进去。
  assert.match(html, /id="order-liquidation"/)
  const script = await readFile(new URL('../desktop/board.js', import.meta.url), 'utf8')
  assert.match(script, /order-liquidation/)
  assert.match(script, /order\.liquidationText/)
  // US19：榜行把 view 给的 chips 画出来（不是只画「多 N · 空 M」计数）。
  assert.match(script, /league-chips/)
  assert.match(script, /chipOverflowText/)
  // 票 81 的键盘验收：Tab 顺序由纯函数给，窗口把它落到真实 tabindex。
  assert.match(script, /view\.focusOrder\(payload\)/)
  assert.match(script, /tabIndex = index/)
})

test('评审 P2：窗口兜底错误文案与 trading-text.js 同码同文（drift）', async () => {
  // 渲染端不是 ESM，抄一份可以；两边的同一错误码必须一个字都不差。
  const source = await readFile(new URL('../desktop/board.js', import.meta.url), 'utf8')
  const block = /const RESULT_CODE_TEXT = \{([\s\S]*?)\n\}/.exec(source)
  assert.ok(block, 'board.js 应该有 RESULT_CODE_TEXT')
  const table = {}
  for (const match of block[1].matchAll(/(?:'([^']+)'|([A-Za-z-]+)):\s*'([^']+)'/g)) {
    table[match[1] ?? match[2]] = match[3]
  }
  let shared = 0
  for (const code of TRADING_ERROR_CODES) {
    if (!(code in table)) continue
    shared += 1
    assert.equal(table[code], tradingErrorText(code), code + ' 的兜底文案漂了')
  }
  assert.ok(shared >= 11, '窗口的兜底表至少要覆盖 11 个宿主错误码（实际 ' + shared + '）')
  // 这两条在评审里明确漂过：钉住它们，避免「两边一起改错」也能过。
  assert.match(table['no-order'], /刷新一下就好/)
  assert.match(table['no-position'], /刷新一下就好/)
})

// ---------------------------------------------------------------------------
// 票 90：盘口图按需拉取——视图侧的合并、缓存与加载态
// ---------------------------------------------------------------------------

/** 新宿主的按需包：只有一种作物的四个周期 + 这一种的风向（老包的 charts 不再复制）。 */
function lazyPayload (crop = 'tomato') {
  return payload({
    charts: {},
    timeframes: {
      '15m': { [crop]: chart() },
      '1h': { [crop]: chart({ base: 6 }) },
      '1d': { [crop]: chart({ base: 6 }) },
      '1w': { [crop]: chart({ base: 6 }) }
    },
    hint: { [crop]: { direction: 'up', confidence: 0.62 } }
  })
}

/** `trading-charts` 的回执：请求哪一位就只给哪一位的四个周期 + 风向。 */
function chartsReply (crop) {
  return {
    crop,
    timeframes: {
      '15m': { [crop]: chart({ base: 6 }) },
      '1h': { [crop]: chart({ base: 6 }) },
      '1d': { [crop]: chart({ base: 6 }) },
      '1w': { [crop]: chart({ base: 6 }) }
    },
    hint: { [crop]: { direction: 'down', confidence: 0.58 } }
  }
}

test('票 90：withCropCharts 只把请求的作物并进 payload，别的字段与作物一律不动', () => {
  const lazy = lazyPayload('tomato')
  const merged = view.withCropCharts(lazy, chartsReply('carrot'))

  // 入参不被改：窗口只是拼一份新的给视图画。
  assert.deepEqual(Object.keys(lazy.timeframes['15m']), ['tomato'])
  assert.equal('carrot' in lazy.hint, false)

  assert.notEqual(merged, lazy)
  assert.deepEqual(Object.keys(merged.timeframes['15m']), ['tomato', 'carrot'])
  assert.equal(merged.timeframes['15m'].carrot.base, 6)
  // 别的周期也跟着并进来（四个周期一起画，切周期不用再问宿主）。
  for (const id of ['15m', '1h', '1d', '1w']) assert.ok(merged.timeframes[id].carrot, id)
  assert.deepEqual(merged.hint.carrot, { direction: 'down', confidence: 0.58 })
  assert.deepEqual(merged.hint.tomato, lazy.hint.tomato)
  // 钱/持仓/榜这些跟图无关的字段原样保留。
  assert.equal(merged.coins.available, lazy.coins.available)
  assert.equal(merged.positions, lazy.positions)
  assert.equal(merged.league, lazy.league)

  // 合并后的包能直接画出请求的作物：价格/风向都是它自己的。
  const board = view.boardView(merged, { now: SLOT_EDGE + 5 * 60 * 1000, crop: 'carrot' })
  assert.equal(board.chart.hasChart, true)
  assert.equal(board.chart.priceText, '5.06')
  assert.equal(board.header.cropName, '胡萝卜')
  assert.equal(board.hint.confidenceText, '58%')

  // 坏回执不炸、也不把 payload 改坏（宿主超时/老版本没有这个动作）。
  for (const bad of [null, undefined, 42, 'x', {}, { crop: 42 }, { crop: '' }]) {
    assert.doesNotThrow(() => view.withCropCharts(lazy, bad))
  }
  assert.deepEqual(Object.keys(view.withCropCharts(lazy, {}).timeframes['15m']), ['tomato'])
  assert.equal(view.withCropCharts(null, chartsReply('carrot')), null)
})

test('票 90：缺图时是「正在加载」而不是「行情还在算」；不拿别的作物的 bar 冒充价格', () => {
  const lazy = lazyPayload('tomato')
  const now = SLOT_EDGE + 5 * 60 * 1000
  const loading = view.boardView(lazy, { now, crop: 'carrot', chartsLoading: true })
  const idle = view.boardView(lazy, { now, crop: 'carrot' })

  assert.equal(loading.chart.hasChart, false)
  assert.equal(loading.chart.loading, true)
  assert.match(loading.chart.emptyText, /正在加载/)
  // 没有在等宿主时还是原来那句空态。
  assert.equal(idle.chart.loading, false)
  assert.equal(idle.chart.emptyText, '行情还在算')

  // 顶部：作物名跟着选择走，但价格不能拿推包里另一种作物的 bar 顶上。
  assert.equal(loading.header.cropName, '胡萝卜')
  assert.equal(loading.header.priceText, '—')
  // 倒计时是同一根（bar 是全局的），不会因为缺图 reset。
  assert.equal(loading.header.countdownText, idle.header.countdownText)
  assert.equal(loading.header.countdownText, '10:00')

  // 画出来的图加载完就恢复（同一条选择，只是把回执并进去）。
  const board = view.boardView(view.withCropCharts(lazy, chartsReply('carrot')), { now, crop: 'carrot' })
  assert.equal(board.chart.hasChart, true)
  assert.equal(board.chart.loading, false)
})

test('票 90：图缓存最多 4 种作物，命中就不再请求；推包里已有图先收进缓存', () => {
  assert.equal(view.CHART_CACHE_LIMIT, 4)
  const cache = view.createChartCache()
  assert.equal(cache.size(), 0)
  for (const crop of ['tomato', 'carrot', 'pumpkin', 'pea']) cache.set(crop, chartsReply(crop))
  assert.equal(cache.size(), 4)
  // 命中会刷新「最近用过」：tomato 最旧时碰一下它，再加第五种就该淘汰 carrot。
  assert.equal(cache.get('tomato').timeframes['15m'].tomato.base, 6)
  cache.set('corn', chartsReply('corn'))
  assert.equal(cache.size(), 4)
  assert.equal(cache.has('carrot'), false, '淘汰最久没看过的一种')
  assert.equal(cache.has('tomato'), true)
  assert.equal(cache.has('corn'), true)
  assert.equal(cache.get('nope'), null)

  // 推包里有图：第一次从推包取（并顺手进缓存），第二次命中缓存 —— 窗口据此不发第二次请求。
  const lazy = lazyPayload('tomato')
  const fresh = view.createChartCache()
  const first = view.chartsFor(lazy, fresh, 'tomato')
  assert.equal(first.from, 'payload')
  assert.equal(first.timeframes['15m'].tomato.base, 5)
  const again = view.chartsFor(lazy, fresh, 'tomato')
  assert.equal(again.from, 'cache')
  // 推包里没有、缓存里也没有 → from null（窗口显示加载中并提交 trading-charts）。
  const missing = view.chartsFor(lazy, fresh, 'carrot')
  assert.equal(missing.from, null)
  assert.equal(missing.timeframes, null)

  // 新宿主的按需包只带一种；老宿主全量包不猜（报 null 也不影响视图回退 charts）。
  assert.equal(view.chartsCropOf(lazy), 'tomato')
  assert.equal(view.chartsCropOf(payload()), null)
  assert.equal(view.chartsCropOf(null), null)
  assert.equal(view.hasCropCharts(lazy, 'tomato'), true)
  assert.equal(view.hasCropCharts(lazy, 'carrot'), false)

  // 没有显式选择时（窗口刚收到第一包）跟着推包走：按需包只有番茄，
  // 视图不能默认白名单第一种（那样会为一张宿主根本没发的图去拉数据）。
  const followed = view.boardView(lazy, { now: SLOT_EDGE + 5 * 60 * 1000 })
  assert.equal(followed.chart.crop, 'tomato')
  assert.equal(followed.chart.hasChart, true)
  assert.equal(followed.header.priceText, '5.06')
})

// ---------------------------------------------------------------------------
// 票 91：下单横条 / 折线 / 黑白模式 / 本机显示偏好
// ---------------------------------------------------------------------------

test('票 91：显示偏好规范化、L/M 切换与 localStorage 往返（坏存储静默退默认）', () => {
  assert.deepEqual(view.displayPrefs(null), { chartType: 'candle', theme: 'color' })
  assert.deepEqual(view.displayPrefs(undefined), { chartType: 'candle', theme: 'color' })
  assert.deepEqual(view.displayPrefs('line'), { chartType: 'candle', theme: 'color' })
  assert.deepEqual(view.displayPrefs({ chartType: 'line', theme: 'mono' }),
    { chartType: 'line', theme: 'mono' })
  // 认不出的值逐字段退回默认，不把整份偏好丢掉。
  assert.deepEqual(view.displayPrefs({ chartType: 'area', theme: 'mono' }),
    { chartType: 'candle', theme: 'mono' })
  assert.deepEqual(view.displayPrefs({ chartType: 'line', theme: 'neon' }),
    { chartType: 'line', theme: 'color' })

  // L/M 的开关函数：返回新对象，不改入参。
  const input = { chartType: 'line', theme: 'color' }
  assert.deepEqual(view.toggleChartType(input), { chartType: 'candle', theme: 'color' })
  assert.deepEqual(view.toggleTheme(input), { chartType: 'line', theme: 'mono' })
  assert.deepEqual(input, { chartType: 'line', theme: 'color' })
  assert.equal(view.DISPLAY_SHORTCUTS.chartType, 'l')
  assert.equal(view.DISPLAY_SHORTCUTS.theme, 'm')
  assert.equal(view.DISPLAY_STORAGE_KEY, 'dsh-zoo-board-prefs')

  // 注入假 storage：只写固定键，值是两个白名单字段（顺序稳定）。
  const store = new Map()
  const storage = {
    getItem (key) { return store.has(key) ? store.get(key) : null },
    setItem (key, value) { store.set(key, value) }
  }
  assert.deepEqual(view.readDisplayPrefs(storage), { chartType: 'candle', theme: 'color' })
  assert.equal(view.writeDisplayPrefs(storage, { chartType: 'line', theme: 'mono' }), true)
  assert.equal(store.has('dsh-zoo-board-prefs'), true)
  assert.equal(store.get('dsh-zoo-board-prefs'), '{"chartType":"line","theme":"mono"}')
  assert.deepEqual(view.readDisplayPrefs(storage), { chartType: 'line', theme: 'mono' })
  // 坏 JSON / 半截值 / 空串都退默认，不抛。
  store.set('dsh-zoo-board-prefs', '{oops')
  assert.deepEqual(view.readDisplayPrefs(storage), { chartType: 'candle', theme: 'color' })
  store.set('dsh-zoo-board-prefs', '')
  assert.deepEqual(view.readDisplayPrefs(storage), { chartType: 'candle', theme: 'color' })
  // getItem/setItem 抛错（隐私模式/坏 storage）也静默：存不了偏好不该让盘口打不开。
  const broken = {
    getItem () { throw new Error('blocked') },
    setItem () { throw new Error('blocked') }
  }
  assert.deepEqual(view.readDisplayPrefs(broken), { chartType: 'candle', theme: 'color' })
  assert.equal(view.writeDisplayPrefs(broken, { chartType: 'line' }), false)
  assert.deepEqual(view.readDisplayPrefs(null), { chartType: 'candle', theme: 'color' })
  assert.equal(view.writeDisplayPrefs(null, { chartType: 'line' }), false)
})

test('票 91：黑白标记落在 body 属性上，弹层两组分段的文案/选中态来自纯视图', () => {
  const color = view.displayView({ chartType: 'candle', theme: 'color' })
  assert.equal(color.mono, false)
  assert.equal(color.line, false)
  assert.deepEqual(color.body, {})
  assert.equal(color.labels.chartType, '蜡烛')
  assert.equal(color.labels.theme, '彩色')
  assert.equal(color.labels.chartGroup, '图表')
  assert.equal(color.labels.themeGroup, '配色')
  assert.deepEqual(color.chartOptions, [
    { id: 'candle', label: '蜡烛', active: true },
    { id: 'line', label: '折线', active: false }
  ])
  assert.deepEqual(color.themeOptions, [
    { id: 'color', label: '彩色', active: true },
    { id: 'mono', label: '黑白', active: false }
  ])

  const mono = view.displayView({ chartType: 'line', theme: 'mono' })
  assert.equal(mono.mono, true)
  assert.equal(mono.line, true)
  assert.deepEqual(mono.body, { 'data-mono': '1' })
  assert.equal(mono.labels.chartType, '折线')
  assert.equal(mono.labels.theme, '黑白')
  assert.equal(mono.chartOptions[1].active, true)
  assert.equal(mono.themeOptions[1].active, true)

  // 黑白下盈亏数字补 ▲/▼；彩色模式原样（只作为 mono 专属字段存在）。
  assert.equal(view.monoNumber('+0.5', 'up'), '▲ +0.5')
  assert.equal(view.monoNumber('-0.5', 'down'), '▼ -0.5')
  assert.equal(view.monoNumber('0.0', 'flat'), '0.0')
  assert.equal(view.monoNumber('—', 'flat'), '—')

  const positions = [{
    id: 'p1', crop: 'tomato', side: 'long', margin: 50, leverage: 5,
    entry: 5, mark: 5.2, pnl: 12.3, liquidation: 4, stopLoss: 0
  }, {
    id: 'p2', crop: 'carrot', side: 'short', margin: 50, leverage: 1,
    entry: 6, mark: 6.1, pnl: -4.5, liquidation: null, stopLoss: 0
  }, {
    id: 'p3', crop: 'pumpkin', side: 'long', margin: 50, leverage: 1,
    entry: 30, mark: 30, pnl: 0, liquidation: null, stopLoss: 0
  }]
  const history = [
    { id: 'h1', crop: 'tomato', side: 'long', leverage: 5, entry: 5, exit: 5.1, pnl: 3.2, reason: 'close', at: SLOT_EDGE },
    { id: 'h2', crop: 'rice', side: 'short', leverage: 20, entry: 10, exit: 10.2, pnl: -2, reason: 'liquidate', at: SLOT_EDGE }
  ]
  const board = view.boardView(payload({ positions, history, league: league() }), {
    now: SLOT_EDGE,
    theme: 'mono'
  })
  assert.equal(board.display.mono, true)
  assert.deepEqual(board.positions.map((card) => card.pnlText), ['+12.3', '-4.5', '0.0'])
  assert.deepEqual(board.positions.map((card) => card.pnlMonoText), ['▲ +12.3', '▼ -4.5', '0.0'])
  assert.deepEqual(board.history.map((row) => row.pnlMonoText), ['▲ +3.2', '▼ -2.0'])
  // 顶栏本周胶囊：彩色时 U+2212 口径不变，黑白时前面加方向记号。
  assert.equal(board.week.pnlMinusText, '+10.5')
  assert.equal(board.week.pnlMonoText, '▲ +10.5')
  // 真人周榜：盈亏与收益率都带记号；没报收益率仍是「—」。
  assert.deepEqual(board.league.rows.map((row) => row.pnlMonoText), ['▲ +12', '▼ -8'])
  assert.deepEqual(board.league.rows.map((row) => row.pctMonoText), ['▲ +3.50%', '—'])
  assert.equal(board.league.rows[0].pctText, '+3.50%', '老字段口径不变')
})

test('票 91：折线几何——收盘价折线、12% 面积、现价圆点都在绘图区里', () => {
  const geometry = view.chartGeometry({
    base: 5,
    bars: [
      { slot: 1, start: 1, end: 2, open: 5, high: 5.2, low: 4.8, close: 4.9 },
      { slot: 2, start: 2, end: 3, open: 4.9, high: 5.1, low: 4.8, close: 5 }
    ],
    current: { slot: 3, start: 3, end: 4, open: 5, high: 5.1, low: 4.9, price: 5.06, tick: 1 }
  })
  const line = view.lineSeries(geometry)
  assert.equal(line.points.length, 3)
  // 收盘价：历史两根取 close，形成中的那根取现价（和十字线便签同一口径）。
  assert.deepEqual(line.points.map((point) => point.close), [4.9, 5, 5.06])
  assert.equal(line.points[2].forming, true)
  assert.equal(line.areaOpacity, 0.12)
  assert.equal(view.LINE_AREA_OPACITY, 0.12)
  const bottom = geometry.plot.top + geometry.plot.height
  assert.equal(line.bottom, bottom)
  for (const point of line.points) {
    assert.ok(point.x >= geometry.plot.left && point.x <= geometry.plot.left + geometry.plot.width)
    assert.ok(point.y >= geometry.plot.top && point.y <= bottom)
  }
  // 点的 y 就是几何里算好的 closeY（不在窗口里重算价格映射）。
  assert.equal(line.points[0].y, geometry.bars[0].closeY)
  assert.equal(line.points[2].y, geometry.forming.closeY)
  assert.match(line.path, /^M /)
  assert.equal((line.path.match(/L /g) ?? []).length, 2)
  // 面积是闭合路径：首点垂到绘图区底、末点再垂下去收口。
  assert.match(line.area, /^M /)
  assert.match(line.area, / Z$/)
  assert.ok(line.area.includes(' ' + bottom))
  // 现价圆点 = 最后一个点；半径 > 0，坐标在绘图区里。
  assert.equal(line.dot.x, line.points[2].x)
  assert.equal(line.dot.y, line.points[2].y)
  assert.equal(line.dot.value, 5.06)
  assert.ok(line.dot.radius >= 3)
  assert.equal(view.lineSeries(null), null)
  assert.equal(view.lineSeries({}), null)

  // chartView：蜡烛是默认；折线只多出 line（轴/参考线/蜡烛几何一个都没变）。
  const candle = view.chartView(payload(), { crop: 'tomato' })
  assert.equal(candle.chartType, 'candle')
  assert.equal(candle.line, null)
  assert.match(candle.ariaLabel, /K 线/)
  const lineView = view.chartView(payload(), { crop: 'tomato', chartType: 'line' })
  assert.equal(lineView.chartType, 'line')
  assert.equal(lineView.chartTypeLabel, '折线')
  assert.equal(lineView.line.points.length, 25, '24 根历史 + 形成中的一根')
  assert.deepEqual(lineView.geometry.priceTicks, candle.geometry.priceTicks)
  assert.deepEqual(lineView.geometry.timeTicks, candle.geometry.timeTicks)
  assert.equal(lineView.geometry.bars.length, candle.geometry.bars.length)
  assert.match(lineView.ariaLabel, /折线/)
  // 坏包/空图：折线也是 null，不造空路径。
  assert.equal(view.chartView(payload({ charts: undefined }), { chartType: 'line' }).line, null)

  // boardView 把本机偏好透给 chart.display，并保持 order/positions/history 一个字段不变。
  const before = view.boardView(payload(), { now: SLOT_EDGE })
  const after = view.boardView(payload(), { now: SLOT_EDGE, chartType: 'line', theme: 'mono' })
  assert.equal(after.chart.chartType, 'line')
  assert.ok(after.chart.line !== null)
  assert.equal(after.display.mono, true)
  assert.deepEqual(after.order.preview, before.order.preview)
  assert.deepEqual(after.positions, before.positions)
  assert.deepEqual(after.history, before.history)
  assert.equal(after.header.priceText, before.header.priceText)
})

test('票 91：下单横条第二行的预览句只留「涨 1% / 跌 1%」；强平价字段不变', () => {
  const order = view.orderView(payload({ coins: { available: 500 } }), { margin: 100, leverage: 5 })
  assert.equal(order.preview, '5× · 100 保证金：涨 1% = +5；跌 1% = −5；强平 −100')
  assert.equal(order.previewShort, '涨 1% +5 · 跌 1% −5')
  // 做多 + 5×：5.06 × (1 − 1/5) = 4.048 → 4.05，且方向文案是「跌到就平」。
  assert.equal(order.liquidationText, '强平价 4.05 · 跌到就平')
  // 1× 没有强平：横条第二行显示「强平价 —」（与旧字段同一口径）。
  const oneX = view.orderView(payload({ coins: { available: 500 } }), { margin: 100, leverage: 1 })
  assert.equal(oneX.previewShort, '涨 1% +1 · 跌 1% −1')
  assert.equal(oneX.liquidationText, '强平价 —')
  // 全下：金额按可用硬币现算，预览句跟着变。
  const allIn = view.orderView(payload({ coins: { available: 250 } }), { allIn: true, leverage: 5 })
  assert.equal(allIn.margin, 250)
  assert.equal(allIn.previewShort, '涨 1% +12.5 · 跌 1% −12.5')
})

test('票 91：显示弹层的 aria/键盘/外点关闭接线在页面与渲染端里（CSP 安全）', async () => {
  const html = await readFile(new URL('../desktop/board.html', import.meta.url), 'utf8')
  const script = await readFile(new URL('../desktop/board.js', import.meta.url), 'utf8')
  // 顶栏「显示」：aria-haspopup/controls/expanded；弹层是 dialog + 两组 segmented。
  assert.match(html, /id="display-toggle"/)
  assert.match(html, /aria-haspopup="dialog"/)
  assert.match(html, /aria-controls="display-pop"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /id="display-pop" role="dialog" aria-label="显示选项" hidden/)
  assert.match(html, /id="chart-type-options"[\s\S]{0,120}role="group"/)
  assert.match(html, /id="theme-options"[\s\S]{0,120}role="group"/)
  assert.match(html, /aria-labelledby="chart-type-label"/)
  assert.match(html, /aria-labelledby="theme-label"/)
  // 外点/Esc 关闭 + 键盘可达：渲染端监听 click（不是 inline onclick），并维护 aria-expanded。
  assert.match(script, /document\.addEventListener\('click'/)
  assert.match(script, /displayPopEl\.contains\(target\)/)
  assert.match(script, /setAttribute\('aria-expanded'/)
  assert.match(script, /displayToggleEl\.focus/)
  // L/M 只在「不是输入框、不是输入法合成、没有组合键」时才切；守卫必须出现在快捷键之前。
  const guard = script.indexOf('isTextEntry(event.target)')
  const shortcut = script.indexOf('DISPLAY_SHORTCUTS.chartType')
  assert.ok(guard > 0 && shortcut > guard, '输入框守卫必须在 L/M 判断之前')
  assert.match(script, /event\.isComposing === true/)
  assert.match(script, /event\.metaKey/)
  assert.match(script, /event\.ctrlKey/)
  assert.match(script, /event\.altKey/)
  assert.match(script, /stopPropagation\(\)/)
  // 偏好读写走注入的 storage，没有硬编码 window.localStorage（读不到也不抛）。
  assert.match(script, /view\.readDisplayPrefs\(readPrefsStorage\(\)\)/)
  assert.match(script, /view\.writeDisplayPrefs/)
  assert.match(script, /window\.localStorage/)
  // CSP：没有内联事件处理器。
  assert.doesNotMatch(html, /\son(?:click|change|input|keydown|load)=/)
})
