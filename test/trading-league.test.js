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
import { buildLeague, watcherCounts } from '../src/trading-league.js'

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

test('票 82（票 102 修订）：按本周收益率降序；没报收益率的排最后；并列先昵称再 deviceId', () => {
  const win = peer({ weekPnl: 40, weekPnlPct: 0.4, nickname: '阿赢' })
  const lose = peer({ weekPnl: -8, weekPnlPct: -0.08, nickname: '阿亏' })
  const tieA = peer({ weekPnl: 10, weekPnlPct: 0.2, nickname: 'B', deviceId: '00000000-0000-4000-8000-0000000000bb' })
  const tieB = peer({ weekPnl: 10, weekPnlPct: 0.2, nickname: 'A', deviceId: '00000000-0000-4000-8000-0000000000aa' })
  // 金币最多的那个人反而排最后：他赚了 90，但周报里没有收益率（旧版本邻居）。
  const noPct = peer({ weekPnl: 90, weekPnlPct: undefined, nickname: '没报' })
  const league = buildLeague({
    self: self({ weekPnl: 25, weekBase: 500, weekPnlPct: 0.05, nickname: 'Z' }),
    peers: [noPct, lose, win, tieA, tieB],
    now: NOW
  })
  // .4 > .2（A 在 B 前）> .05（本机）> −.08 > null
  assert.deepEqual(league.rows.map((row) => row.nickname), ['阿赢', 'A', 'B', 'Z', '阿亏', '没报'])
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
  // 票 102：收益率就是排序键。报了 50% > 本机 5% > 没报（排最后），
  // 所以金币最多的 25 排第二——这正是要的：本金大小不再等于排名。
  assert.deepEqual(league.rows.map((row) => row.nickname), ['报了', '我', '不报收益率'])

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
      { ...peer(), positions: [{ crop: 'dragonfruit', side: 'long', leverage: 1 }] },
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

test('票 82/SPEC 旧邻居：watcherCounts 只数放行在线邻居与新鲜周报', () => {
  const allowedOnline = { deviceId: 'a', status: 'allowed', heartbeatAt: 1 }
  const allowedOffline = { deviceId: 'b', status: 'allowed', heartbeatAt: 0 }
  const pendingOnline = { deviceId: 'c', status: 'pending', heartbeatAt: 1 }
  const digests = [
    { deviceId: 'a', seenAt: NOW - 1000 },
    // 未放行 / 不在线的周报不能算进「有人报了」。
    { deviceId: 'c', seenAt: NOW },
    { deviceId: 'b', seenAt: NOW },
    { deviceId: 'a', seenAt: NOW - TRADING_DIGEST_FRESH_MS - 1 }
  ]
  assert.deepEqual(
    watcherCounts({ neighbors: [allowedOnline, allowedOffline, pendingOnline], digests, now: NOW }),
    { online: 1, reported: 1 }
  )
  // 唯一在线的邻居周报过期：reported 归零 —— 这正是窗口画「旧版本」的那种状态。
  assert.deepEqual(
    watcherCounts({
      neighbors: [allowedOnline],
      digests: [{ deviceId: 'a', seenAt: NOW - TRADING_DIGEST_FRESH_MS - 1 }],
      now: NOW
    }),
    { online: 1, reported: 0 }
  )
  // 坏输入不抛；没有邻居就是 0/0（窗口照旧画「还没有邻居上线」）。
  assert.deepEqual(
    watcherCounts({
      neighbors: [null, 'x', { deviceId: 'z', status: 'allowed', heartbeatAt: 1 }],
      digests: 'x',
      now: NOW
    }),
    { online: 1, reported: 0 }
  )
  assert.deepEqual(watcherCounts({ now: NOW }), { online: 0, reported: 0 })
})

test('票 82：buildLeague 透传 watchers；坏计数归零、reported 不超过 online', () => {
  const fresh = buildLeague({
    self: self(),
    peers: [],
    now: NOW,
    watchers: { online: 3, reported: 1 }
  })
  assert.deepEqual(fresh.watchers, { online: 3, reported: 1 })
  assert.deepEqual(buildLeague({ now: NOW }).watchers, { online: 0, reported: 0 })
  assert.deepEqual(
    buildLeague({ now: NOW, watchers: { online: 2, reported: 5 } }).watchers,
    { online: 2, reported: 2 }
  )
  for (const bad of [null, 'x', 42, [], { online: -1, reported: 'x' }]) {
    assert.deepEqual(buildLeague({ now: NOW, watchers: bad }).watchers, { online: 0, reported: 0 })
  }
})
