/**
 * 票 82：真人周榜的合并（排序/收益率/新鲜度/LAN 情绪）。
 *
 * 这一层是纯函数：固定 `now`、固定输入，断言精确的行与计数。
 * 榜上的数字是邻居**自报**的（SPEC「不做强防作弊」），所以这里的重点是
 * 「坏输入不能把榜搞崩」与「过期的人不能一直挂着」，而不是防作弊。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { TRADING_DIGEST_FRESH_MS } from '../src/protocol.js'
import { buildLeague } from '../src/trading-league.js'

const NOW = 1700000000000

function self (overrides = {}) {
  return {
    deviceId: '00000000-0000-4000-8000-000000000001',
    nickname: '我',
    weekPnl: 10,
    weekBase: 100,
    positions: [],
    ...overrides
  }
}

function peer (overrides = {}) {
  return {
    deviceId: randomUUID(),
    nickname: '邻居',
    weekPnl: 20,
    weekPnlPct: 0.2,
    positions: [],
    seenAt: NOW,
    ...overrides
  }
}

function position (crop, side, leverage = 1) {
  return { crop, side, leverage }
}

test('票 82：按本周盈亏降序（含负数）；并列先昵称再 deviceId', () => {
  const win = peer({ weekPnl: 40, nickname: '阿赢' })
  const lose = peer({ weekPnl: -8, nickname: '阿亏' })
  const tieA = peer({ weekPnl: 10, nickname: 'B', deviceId: '00000000-0000-4000-8000-0000000000bb' })
  const tieB = peer({ weekPnl: 10, nickname: 'A', deviceId: '00000000-0000-4000-8000-0000000000aa' })
  const league = buildLeague({
    self: self({ weekPnl: 10, nickname: 'Z' }),
    peers: [lose, win, tieA, tieB],
    now: NOW
  })
  assert.deepEqual(league.rows.map((row) => row.weekPnl), [40, 10, 10, 10, -8])
  // 同为 10 时：昵称升序（A < B < Z），同昵称才看 deviceId。
  assert.deepEqual(league.rows.map((row) => row.nickname), ['阿赢', 'A', 'B', 'Z', '阿亏'])
  assert.equal(league.rows[3].me, true)
  // 行形状是窗口直接画的：六个键，多一个都不给。
  assert.deepEqual(Object.keys(league.rows[0]),
    ['deviceId', 'nickname', 'weekPnl', 'weekPnlPct', 'positions', 'me'])
})

test('票 82：收益率——本机从 base 算，邻居报什么算什么，没报就是 null', () => {
  const noPct = peer({ weekPnl: 20, weekPnlPct: undefined, nickname: '不报收益率' })
  const league = buildLeague({
    self: self({ weekPnl: 25, weekBase: 500 }),
    peers: [noPct, peer({ weekPnl: 5, weekPnlPct: 0.5, nickname: '报了' })],
    now: NOW
  })
  assert.equal(league.self.weekPnl, 25)
  assert.equal(league.self.weekPnlPct, 0.05, '本机收益率 = 25 / 500')
  assert.equal(league.rows.find((row) => row.nickname === '不报收益率').weekPnlPct, null)
  assert.equal(league.rows.find((row) => row.nickname === '报了').weekPnlPct, 0.5)
  // 收益率只展示，不改排序：20 > 5 > 25? 不，25 最大。
  assert.deepEqual(league.rows.map((row) => row.weekPnl), [25, 20, 5])

  // 调用方给了「未取整口径」的收益率时优先用它（service 从 total / base 算），
  // 显式 0 也是有效值（本周刚好打平），不会被当成「没给」。
  const explicit = buildLeague({
    self: self({ weekPnl: 25, weekBase: 500, weekPnlPct: 0.0501 }),
    peers: [],
    now: NOW
  })
  assert.equal(explicit.rows[0].weekPnlPct, 0.0501)
  assert.equal(explicit.self.weekPnlPct, 0.0501)
  const flatPct = buildLeague({
    self: self({ weekPnl: 0, weekBase: 500, weekPnlPct: 0 }),
    peers: [],
    now: NOW
  })
  assert.equal(flatPct.rows[0].weekPnlPct, 0)

  // base 0/坏值（新账本、坏 trading.json）：本机也不编一个 0%，就是 null。
  for (const weekBase of [0, -100, undefined, 'x']) {
    const broken = buildLeague({ self: self({ weekBase }), peers: [], now: NOW })
    assert.equal(broken.rows[0].weekPnlPct, null, String(weekBase))
    assert.equal(broken.self.weekPnlPct, null, String(weekBase))
  }
})

test('票 82：超过 2 分钟没再听到的邻居整行不出现（边界闭区间）', () => {
  const fresh = peer({ weekPnl: 1, nickname: '新鲜' })
  const edge = peer({ weekPnl: 2, nickname: '正好两分钟', seenAt: NOW - TRADING_DIGEST_FRESH_MS })
  const stale = peer({ weekPnl: 3, nickname: '过期', seenAt: NOW - TRADING_DIGEST_FRESH_MS - 1 })
  const noSeenAt = peer({ weekPnl: 4, nickname: '没时间' })
  delete noSeenAt.seenAt
  const league = buildLeague({ self: self({ weekPnl: 0 }), peers: [fresh, edge, stale, noSeenAt], now: NOW })
  assert.deepEqual(league.rows.map((row) => row.nickname), ['正好两分钟', '新鲜', '我'])
  assert.equal(league.rows.some((row) => row.nickname === '过期'), false)
  assert.equal(league.rows.some((row) => row.nickname === '没时间'), false)
})

test('票 82：LAN 情绪数的是仓位；flat 数的是「一条仓位都没有的人」', () => {
  const league = buildLeague({
    self: self({
      weekPnl: 5,
      positions: [position('tomato', 'long'), position('carrot', 'long')]
    }),
    peers: [
      peer({ weekPnl: 3, nickname: '空头', positions: [position('pumpkin', 'short', 20)] }),
      peer({ weekPnl: 2, nickname: '观望甲', positions: [] }),
      peer({ weekPnl: 1, nickname: '观望乙', positions: [] })
    ],
    now: NOW
  })
  // 本机 2 多 + 邻居 1 空；两个空仓的人计入 flat（本机有仓，不计）。
  assert.deepEqual(league.sentiment, { long: 2, short: 1, flat: 2 })
})

test('票 82：没有邻居时只有自己一行，情绪是观望（flat）', () => {
  const league = buildLeague({ self: self({ weekPnl: -3, nickname: '一个人' }), peers: [], now: NOW })
  assert.equal(league.rows.length, 1)
  assert.equal(league.rows[0].me, true)
  assert.equal(league.rows[0].nickname, '一个人')
  assert.equal(league.rows[0].weekPnl, -3)
  assert.deepEqual(league.sentiment, { long: 0, short: 0, flat: 1 })
  // 空输入也不抛：窗口画一扇空榜。
  assert.deepEqual(buildLeague({ now: NOW }).rows, [])
  assert.deepEqual(buildLeague({ now: NOW }).sentiment, { long: 0, short: 0, flat: 0 })
  assert.deepEqual(buildLeague({ now: NOW }).self, { weekPnl: 0, weekPnlPct: null })
})

test('票 82：坏邻居行整行丢掉，不抛；重复 deviceId 只留一行', () => {
  const good = peer({ weekPnl: 7, nickname: '好的' })
  const sameDevice = peer({
    deviceId: good.deviceId,
    weekPnl: 99,
    nickname: '重影'
  })
  const league = buildLeague({
    self: self({ weekPnl: 0 }),
    peers: [
      good,
      sameDevice,
      null,
      'x',
      42,
      [],
      { ...peer(), weekPnl: 'lots' },
      { ...peer(), weekPnl: Number.NEGATIVE_INFINITY },
      { ...peer(), positions: [{ crop: 'strawberry', side: 'long', leverage: 1 }] },
      { ...peer(), positions: 'none' },
      { ...peer(), positions: [{ crop: 'tomato', side: 'up', leverage: 1 }] },
      { ...peer(), deviceId: '' }
    ],
    now: NOW
  })
  assert.deepEqual(league.rows.map((row) => row.nickname), ['好的', '我'])
  assert.equal(league.rows[0].weekPnl, 7, '同 deviceId 的重复行不覆盖第一行')
})

test('票 82：本机行坏了不挡邻居；昵称缺失有兜底，不是空字符串', () => {
  const league = buildLeague({
    self: self({ deviceId: '', weekPnl: 'x' }),
    peers: [peer({ weekPnl: 4, nickname: '  ' }), peer({ weekPnl: 6, nickname: null })],
    now: NOW
  })
  assert.equal(league.rows.length, 2)
  assert.deepEqual(league.rows.map((row) => row.nickname), ['邻居', '邻居'])
  assert.deepEqual(league.self, { weekPnl: 0, weekPnlPct: null })
  // 本机行正常时昵称兜底是「我」。
  const own = buildLeague({ self: self({ nickname: null }), peers: [], now: NOW })
  assert.equal(own.rows[0].nickname, '我')
})
