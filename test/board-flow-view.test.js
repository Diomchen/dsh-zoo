/**
 * 票 107：资金流的载荷归一化 + 纯视图（胶囊/标记/便签行/情绪面板）+ 窗口接线。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import shared from '../desktop/shared.js'
import view from '../desktop/trading-view.js'

const AT = 1763288100000
const BAR = Object.freeze({
  slot: 1959208,
  start: 1763287200000,
  end: 1763288100000,
  open: 5,
  high: 5.2,
  low: 4.9,
  close: 5.1
})
const FLOW = Object.freeze({
  level: 0.0042,
  net: -0.0031,
  events: [{
    id: 'flow:1',
    at: AT - 60 * 1000,
    deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    name: '阿黄',
    action: 'open',
    side: 'long',
    reason: 'manual',
    notional: 500,
    impact: 0.003,
    source: 'board'
  }]
})

function payloadOf (overrides = {}) {
  return {
    base: 5,
    charts: {
      tomato: {
        base: 5,
        bars: [BAR],
        current: {
          slot: 1959209,
          start: 1763288100000,
          end: 1763289000000,
          open: 5.1,
          high: 5.3,
          low: 5,
          price: 5.2,
          tick: 7
        }
      }
    },
    flow: FLOW,
    league: {
      rows: [],
      sentiment: { long: 1, short: 0, flat: 0 },
      watchers: { online: 1, reported: 1 }
    },
    ...overrides
  }
}

test('票 107：normalizeBoardView 收资金流块；老包没有 flow 键', () => {
  const normalized = shared.normalizeBoardView(payloadOf())
  assert.ok(normalized)
  assert.equal(normalized.flow.level, 0.0042)
  assert.equal(normalized.flow.events.length, 1)
  assert.equal(normalized.flow.events[0].name, '阿黄')
  assert.equal(normalized.flow.events[0].impact, 0.003)
  const old = shared.normalizeBoardView({ base: 5, bars: [], current: null })
  assert.equal('flow' in old, false)
})

test('票 107：资金流胶囊/净流/鲸鱼计数', () => {
  const flow = view.flowView(payloadOf())
  assert.equal(flow.hasFlow, true)
  assert.match(flow.chipText, /资金流 \+0\.42%/)
  assert.match(flow.netText, /−0\.31%/)
  assert.equal(flow.whaleCount, 1)
  assert.equal(flow.tone, 'up')

  const empty = view.flowView({})
  assert.equal(empty.hasFlow, false)
  assert.equal(empty.chipText, '资金流 —')
  assert.equal(empty.whaleCount, 0)
})

test('票 107：K 线下方画资金流点；鲸鱼单多一圈', () => {
  const geometry = view.chartGeometry(payloadOf().charts.tomato, {
    width: 720,
    height: view.CHART_HEIGHT,
    padding: view.CHART_AXIS_PADDING,
    flowEvents: FLOW.events
  })
  assert.ok(geometry)
  assert.equal(geometry.flowMarks.length, 1)
  const mark = geometry.flowMarks[0]
  assert.equal(mark.tone, 'up')
  assert.equal(mark.whale, true)
  assert.ok(mark.x >= geometry.plot.left && mark.x <= geometry.plot.left + geometry.plot.width)
  assert.ok(mark.y >= geometry.plot.top && mark.y <= geometry.plot.top + geometry.plot.height)

  const quiet = view.chartGeometry(payloadOf().charts.tomato, {
    width: 720,
    height: view.CHART_HEIGHT,
    padding: view.CHART_AXIS_PADDING,
    flowEvents: [{ ...FLOW.events[0], impact: 0.001 }]
  })
  assert.equal(quiet.flowMarks[0].whale, false)
})

test('票 107：十字线便签加资金流行；没有流水保持 78 高', () => {
  const geometry = view.chartGeometry(payloadOf().charts.tomato, {
    width: 720,
    height: view.CHART_HEIGHT,
    padding: view.CHART_AXIS_PADDING,
    flowEvents: FLOW.events
  })
  const hit = view.crosshairAt(geometry, geometry.bars[0].centerX, 100)
  assert.ok(hit)
  assert.equal(hit.flowRows.length, 1)
  assert.match(hit.flowRows[0].text, /阿黄/)
  assert.match(hit.flowRows[0].text, /开多/)
  assert.match(hit.flowRows[0].text, /\+0\.30%/)
  assert.ok(hit.card.height > 78)
  assert.equal(hit.card.flowTop, hit.card.newsTop, '没有消息时资金流行从便签下半区第一行开始')

  const empty = view.chartGeometry(payloadOf().charts.tomato, {
    width: 720,
    height: view.CHART_HEIGHT,
    padding: view.CHART_AXIS_PADDING,
    flowEvents: []
  })
  const emptyHit = view.crosshairAt(empty, empty.bars[0].centerX, 100)
  assert.equal(emptyHit.flowRows.length, 0)
  assert.equal(emptyHit.card.height, 78)
})

test('票 107：快讯条与情绪面板带资金流', () => {
  const ticker = view.tickerView(payloadOf(), AT)
  assert.equal(ticker.flowText, '资金流 +0.42%')
  assert.equal(ticker.whaleCount, 1)

  const league = view.leagueView(payloadOf())
  assert.match(league.sentiment.flowText, /净流入 −0\.31%/)
  assert.equal(league.sentiment.flowTone, 'up')
})

test('票 107：chartView / withCropCharts 带 flow', () => {
  const chart = view.chartView(payloadOf(), {
    crop: 'tomato',
    width: 720,
    height: view.CHART_HEIGHT,
    now: AT
  })
  assert.equal(chart.hasChart, true)
  assert.equal(chart.flow.events.length, 1)
  assert.equal(chart.geometry.flowMarks.length, 1)

  const next = view.withCropCharts(
    { timeframes: { '15m': {} }, hint: {}, flow: { level: 0, net: 0, events: [] } },
    {
      crop: 'tomato',
      timeframes: { '15m': { tomato: { base: 5, bars: [BAR], current: null } } },
      hint: {},
      flow: FLOW
    }
  )
  assert.equal(next.flow.level, 0.0042)
})

test('票 107：盘口窗有资金流胶囊、标记层与便签行 DOM', async () => {
  const html = await readFile(new URL('../desktop/board.html', import.meta.url), 'utf8')
  assert.match(html, /id="ticker-flow"/)
  assert.match(html, /\.chart-svg \.flow-dot/)
  assert.match(html, /\.chart-svg \.flow-ring/)
  assert.match(html, /\.chart-svg \.crosshair-flow-text/)
  const script = await readFile(new URL('../desktop/board.js', import.meta.url), 'utf8')
  assert.match(script, /geometry\.flowMarks/)
  assert.match(script, /card\.flowRows/)
  assert.match(script, /tickerFlowEl/)
})
