/**
 * 票 79：盘口窗的纯视图输出（价格/倒计时/下单区/持仓卡/历史/空态）。
 *
 * 渲染页和 Node 测试 require 的是同一份 `desktop/trading-view.js`；这里只测数字与
 * 文案，不测 DOM。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const view = require('../desktop/trading-view.js')

const LIMITS = {
  margins: [50, 100],
  leverages: [1],
  crops: [{ id: 'tomato', name: '小番茄' }],
  historyLimit: 50
}

function payload (overrides = {}) {
  return {
    coins: { available: 120, locked: 50, total: 172 },
    limits: LIMITS,
    bar: {
      crop: 'tomato',
      slot: 1959232,
      start: 1763308800000,
      end: 1763309700000,
      remainingMs: 600000,
      open: 5,
      price: 5.06
    },
    positions: [],
    history: [],
    orders: [],
    ...overrides
  }
}

test('票 79：顶部显示当前价、本根涨跌、mm:ss 倒计时与两种硬币', () => {
  const header = view.headerView(payload(), 1763309100000)
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
  const down = view.headerView(payload({ bar: { ...payload().bar, price: 4.9 } }), 1763309100000)
  assert.equal(down.changeText, '-2.00%')
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
})

test('票 79：下单区显示「涨 1% = ±X 币」，1× 的强平是「—」', () => {
  const order = view.orderView(payload(), { side: 'short', margin: 100 })
  assert.equal(order.side, 'short')
  assert.equal(order.margin, 100)
  assert.equal(order.canSubmit, true)
  assert.equal(order.hint, '')
  assert.equal(order.submitLabel, '做空 100')
  assert.equal(order.preview, '涨 1% = +1.0 币；跌 1% = -1.0 币；强平 —')
  assert.deepEqual(order.sides.map((side) => side.label), ['做多', '做空'])
  assert.deepEqual(order.margins.map((choice) => choice.margin), [50, 100])
  assert.equal(order.margins[1].active, true)
  // 白名单之外的方向/保证金回到默认值。
  assert.equal(view.orderView(payload(), { side: 'up', margin: 7 }).side, 'long')
  assert.equal(view.orderView(payload(), { side: 'long', margin: 7 }).margin, 50)
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

test('票 79：持仓卡有入场/现价/盈亏/保证金/方向，并按现价染正负', () => {
  const cards = view.positionCards(payload({
    positions: [{
      id: 'p1',
      crop: 'tomato',
      side: 'long',
      margin: 50,
      leverage: 1,
      entry: 5.1,
      mark: 5.06,
      pnl: -0.39
    }, {
      id: 'p2',
      crop: 'tomato',
      side: 'short',
      margin: 100,
      leverage: 1,
      entry: 5,
      mark: 4.8,
      pnl: 4
    }]
  }))
  assert.equal(cards.length, 2)
  assert.equal(cards[0].title, '做多 · 小番茄 · 1×')
  assert.equal(cards[0].entryText, '5.10')
  assert.equal(cards[0].markText, '5.06')
  assert.equal(cards[0].pnlText, '-0.4')
  assert.equal(cards[0].pnlTone, 'down')
  assert.equal(cards[0].marginText, '50')
  assert.equal(cards[0].canClose, true)
  assert.equal(cards[0].closeLabel, '平仓')
  assert.equal(cards[1].side, 'short')
  assert.equal(cards[1].pnlText, '+4.0')
  assert.equal(cards[1].pnlTone, 'up')
  // 正在结算的仓位不能点平仓（钱已经走了一半）。
  const settling = view.positionCards(payload({
    positions: [{ id: 'p3', crop: 'tomato', side: 'long', margin: 50, leverage: 1, entry: 5, mark: 5, pnl: 0, settling: true }]
  }))
  assert.equal(settling[0].canClose, false)
  assert.equal(settling[0].statusText, '结算中…')
})

test('票 79：历史行写明方向/作物/盈亏/原因，时间用「多久以前」不依赖时区', () => {
  const now = 1763309700000
  const rows = view.historyRows(payload({
    history: [
      { id: 'h1', crop: 'tomato', side: 'long', margin: 50, leverage: 1, entry: 5, exit: 5.5, pnl: 5, reason: 'settle', at: now - 3 * 60 * 1000 },
      { id: 'h2', crop: 'tomato', side: 'short', margin: 100, leverage: 1, entry: 5, exit: 5.1, pnl: -2, reason: 'close', at: now - 2 * 60 * 60 * 1000 }
    ]
  }), now)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].title, '做多 · 小番茄 · 1×')
  assert.equal(rows[0].pnlText, '+5.0')
  assert.equal(rows[0].reasonText, '收盘结算')
  assert.equal(rows[0].atText, '3 分钟前')
  assert.equal(rows[1].reasonText, '手动平仓')
  assert.equal(rows[1].atText, '2 小时前')
  assert.equal(rows[1].exitText, '5.10')
})

test('票 79：空态与坏输入都不抛——没有盘口数据时也能画出一扇空窗', () => {
  for (const bad of [null, undefined, 42, 'x', [], {}]) {
    const board = view.boardView(bad, { now: 1763309700000 })
    assert.equal(board.positions.length, 0)
    assert.equal(board.history.length, 0)
    assert.equal(board.header.priceText, '—')
    assert.match(board.hints.history, /还没有结算记录/)
  }
  // 认不出的作物先按 id 显示，别画空白。
  assert.equal(view.cropNameOf(payload(), 'corn'), 'corn')
  assert.equal(view.reasonText('liquidate'), '强平')
  assert.equal(view.reasonText('weird'), '结算')
  assert.equal(view.formatCoins(1234567), '1,234,567')
})
