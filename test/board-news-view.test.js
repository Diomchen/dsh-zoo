/**
 * 票 105/106：盘口消息面的载荷归一化与纯视图。
 *
 * 只测纯函数：compact bar 的第 8 项、`normalizeBoardView().news`、K 线上的标记、
 * 十字线便签的消息行、快讯条、今日日程、详情卡。不碰 DOM/Electron。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import shared from '../desktop/shared.js'
import view from '../desktop/trading-view.js'

const NEWS = Object.freeze({
  id: 'crop:tomato:20600:1',
  at: 1763288100000,
  off: 5,
  tone: 'up',
  mag: 0.014,
  title: '霜冻蓝色预警：番茄产区今夜最低 −3℃',
  rarity: 2,
  kind: 'headline'
})

const BAR = Object.freeze({
  slot: 1959208,
  start: 1763287200000,
  end: 1763288100000,
  open: 5,
  high: 5.2,
  low: 4.9,
  close: 5.1,
  news: [NEWS]
})

function payloadOf (overrides = {}) {
  return {
    base: 5,
    bars: [BAR],
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
    current: {
      slot: 1959209,
      start: 1763288100000,
      end: 1763289000000,
      open: 5.1,
      high: 5.3,
      low: 5,
      price: 5.2,
      tick: 7,
      news: []
    },
    news: {
      items: [
        {
          ...NEWS,
          crop: 'tomato',
          body: '镇农技站建议抢早收；收购商已经开始加价。',
          source: '天气台'
        }
      ],
      calendar: [
        {
          at: 1763304000000,
          crop: 'tomato',
          cropName: '小番茄',
          title: '产量报告：小番茄比预期高 14%',
          tone: 'down',
          mag: -0.01,
          countdownMs: 300000,
          done: false
        }
      ]
    },
    ...overrides
  }
}

test('票 105：compact bar 第 8 项是 lite 消息；老 7 字段没有 news 键', () => {
  const readBar = (bar) => shared.normalizeBoardView({
    timeframes: { '15m': { tomato: { base: 5, bars: [bar], current: null } } }
  }).timeframes['15m'].tomato.bars[0]

  const compact = [BAR.slot, BAR.start, BAR.end, BAR.open, BAR.high, BAR.low, BAR.close, [NEWS]]
  const normalized = readBar(compact)
  assert.ok(normalized)
  assert.equal(normalized.news.length, 1)
  assert.deepEqual(normalized.news[0], NEWS)

  const old = readBar([BAR.slot, BAR.start, BAR.end, BAR.open, BAR.high, BAR.low, BAR.close])
  assert.ok(old)
  assert.equal('news' in old, false)

  const bad = readBar([BAR.slot, BAR.start, BAR.end, BAR.open, BAR.high, BAR.low, BAR.close, [
    { id: '', at: 1, title: '坏' },
    NEWS,
    { ...NEWS, id: 'second' },
    { ...NEWS, id: 'third' }
  ]])
  assert.equal(bad.news.length, 2, '坏条目丢自己，最多留 2 条')
  assert.equal(bad.news[0].id, NEWS.id)
})

test('票 105：normalizeBoardView 收消息全文与日程；空表不带 news 键', () => {
  const normalized = shared.normalizeBoardView(payloadOf())
  assert.ok(normalized)
  assert.equal(normalized.news.items.length, 1)
  assert.equal(normalized.news.items[0].body.length > 0, true)
  assert.equal(normalized.news.items[0].crop, 'tomato')
  assert.equal(normalized.news.calendar.length, 1)
  assert.equal(normalized.news.calendar[0].cropName, '小番茄')

  const empty = shared.normalizeBoardView({ base: 5, bars: [], current: null })
  assert.ok(empty)
  assert.equal('news' in empty, false)
})

test('票 106：K 线上的消息标记落在绘图区内，最多 3 个', () => {
  const geometry = view.chartGeometry(payloadOf(), {
    width: 720,
    height: view.CHART_HEIGHT,
    padding: view.CHART_AXIS_PADDING
  })
  assert.ok(geometry)
  assert.equal(geometry.newsMarks.length, 1)
  const mark = geometry.newsMarks[0]
  assert.equal(mark.id, NEWS.id)
  assert.ok(mark.x >= geometry.plot.left && mark.x <= geometry.plot.left + geometry.plot.width)
  assert.ok(mark.y >= geometry.plot.top && mark.y <= geometry.plot.top + geometry.plot.height)
  assert.equal(mark.tone, 'up')
  assert.equal(mark.rarity, 2)

  const many = view.chartGeometry({
    ...payloadOf(),
    bars: [{ ...BAR, news: [NEWS, { ...NEWS, id: 'n2' }, { ...NEWS, id: 'n3' }, { ...NEWS, id: 'n4' }] }]
  }, { width: 720, height: view.CHART_HEIGHT, padding: view.CHART_AXIS_PADDING })
  assert.equal(many.newsMarks.length, 3)
})

test('票 106：十字线便签加高并带消息行；没有消息保持 78 高', () => {
  const geometry = view.chartGeometry(payloadOf(), {
    width: 720,
    height: view.CHART_HEIGHT,
    padding: view.CHART_AXIS_PADDING
  })
  const hit = view.crosshairAt(geometry, geometry.bars[0].centerX, 100)
  assert.ok(hit)
  assert.equal(hit.newsRows.length, 1)
  assert.match(hit.newsRows[0].text, /第6分钟/)
  assert.match(hit.newsRows[0].text, /霜冻/)
  assert.match(hit.newsRows[0].text, /\+1\.4%/)
  assert.ok(hit.card.height > 78, '有消息的便签应加高')
  assert.ok(hit.card.newsTop > hit.card.top)
  assert.match(hit.text, /霜冻/)

  const quiet = view.chartGeometry(payloadOf({
    bars: [{ ...BAR, news: [] }],
    news: { items: [], calendar: [] }
  }), { width: 720, height: view.CHART_HEIGHT, padding: view.CHART_AXIS_PADDING })
  const quietHit = view.crosshairAt(quiet, quiet.bars[0].centerX, 100)
  assert.equal(quietHit.newsRows.length, 0)
  assert.equal(quietHit.card.height, 78)
})

test('票 106：快讯条取最近已发生的一条；没有消息给空态', () => {
  const payload = payloadOf()
  const ticker = view.tickerView(payload, NEWS.at + 1000)
  assert.equal(ticker.hasNews, true)
  assert.equal(ticker.id, NEWS.id)
  assert.match(ticker.text, /霜冻/)
  assert.match(ticker.text, /\+1.4%/)

  const empty = view.tickerView({ news: { items: [], calendar: [] } })
  assert.equal(empty.hasNews, false)
  assert.match(empty.text, /暂无消息/)
})

test('票 106：今日日程与消息详情卡', () => {
  const payload = payloadOf()
  const calendar = view.calendarView(payload, 1763304000000)
  assert.equal(calendar.length, 1)
  assert.equal(calendar[0].done, true)
  assert.equal(calendar[0].countdown, '已公布')
  assert.match(calendar[0].text, /产量报告/)

  const detail = view.newsDetailView(payload, NEWS.id)
  assert.ok(detail)
  assert.equal(detail.title, NEWS.title)
  assert.equal(detail.source, '天气台')
  assert.equal(detail.magText, '+1.4%')
  assert.equal(detail.cropName, '小番茄')
  assert.equal(view.newsDetailView(payload, 'no-such-id'), null)
})

test('票 106：chartView 带 ticker/news；图高 212，快讯条 16', () => {
  const chart = view.chartView(payloadOf(), {
    crop: 'tomato',
    width: 720,
    height: view.CHART_HEIGHT,
    now: NEWS.at + 1000
  })
  assert.equal(chart.hasChart, true)
  assert.equal(chart.geometry.height, 212)
  assert.equal(chart.ticker.hasNews, true)
  assert.equal(chart.news.items.length, 1)
  assert.equal(view.LAYOUT.tickerHeight, 16)
  assert.equal(view.CHART_HEIGHT, 212)
})


test('票 105/106：withCropCharts 把按需拉图的 news 并进 payload', () => {
  const payload = {
    timeframes: { '15m': {} },
    hint: {},
    news: { items: [], calendar: [] }
  }
  const charts = {
    crop: 'tomato',
    timeframes: { '15m': { tomato: { base: 5, bars: [], current: null } } },
    hint: { tomato: { direction: 'up', confidence: 0.6 } },
    news: { items: [{ ...NEWS, crop: 'tomato', body: '正文', source: '天气台' }], calendar: [] }
  }
  const next = view.withCropCharts(payload, charts)
  assert.equal(next.timeframes['15m'].tomato.base, 5)
  assert.equal(next.news.items.length, 1)
  assert.equal(next.news.items[0].id, NEWS.id)
})
