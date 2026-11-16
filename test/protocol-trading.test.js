/**
 * 票 82：`trading-digest` 的线上形状（编码/解析/白名单）。
 *
 * 这个报文是**唯一**把本机盘口数字发出去的地方，所以两件事必须钉死：
 *   1. 白名单：只写 `v/type/deviceId/at/weekPnl[, weekPnlPct]/positions`，硬币、保证金、
 *      入场价、历史一个都不能出现（SPEC v10「真人榜与协议」）；
 *   2. 坏字段整包丢：邻居的分数直接进榜排序，半截/坏数字比没有更糟。
 * 解析端是网络输入，非法一律 `{ ok:false, reason }`；编码端是本机程序错误，非法即抛
 * （与 `market-digest` 完全同一条规矩）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  MAX_PACKET_BYTES,
  MAX_TRADING_POSITIONS,
  MAX_WEEK_PNL,
  MAX_WEEK_PNL_PCT,
  PROTOCOL_VERSION,
  TRADING_DIGEST_FRESH_MS,
  TRADING_DIGEST_INTERVAL_MS,
  encodePacket,
  encodeTradingDigest,
  normalizeTradingPositions,
  parsePacket
} from '../src/protocol.js'

function encodeJson (value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

function validPositions () {
  return [
    { crop: 'tomato', side: 'long', leverage: 5 },
    { crop: 'pumpkin', side: 'short', leverage: 20 }
  ]
}

function validDigest (overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    type: 'trading-digest',
    deviceId: randomUUID(),
    at: 1700000000000,
    weekPnl: 42,
    positions: validPositions(),
    ...overrides
  }
}

test('票 82：编码只写 v/type/deviceId/at/weekPnl/positions，解析后形状一致', () => {
  const deviceId = randomUUID()
  const data = encodeTradingDigest({
    deviceId: deviceId.toUpperCase(),
    at: 1700000000123,
    weekPnl: 42,
    positions: validPositions()
  })
  const raw = JSON.parse(data.toString('utf8'))
  assert.deepEqual(Object.keys(raw), ['v', 'type', 'deviceId', 'at', 'weekPnl', 'positions'])
  // 持仓只重建三个公开字段。
  for (const position of raw.positions) {
    assert.deepEqual(Object.keys(position), ['crop', 'side', 'leverage'])
  }
  assert.equal(raw.deviceId, deviceId.toLowerCase())
  assert.equal(raw.type, 'trading-digest')
  assert.deepEqual(parsePacket(data), {
    ok: true,
    packet: {
      v: PROTOCOL_VERSION,
      type: 'trading-digest',
      deviceId: deviceId.toLowerCase(),
      at: 1700000000123,
      weekPnl: 42,
      positions: validPositions()
    }
  })

  // 缺省 at 用本机时钟；weekPnlPct 可选，不给就不出现在报文里（不是发一个 0）。
  const idle = encodeTradingDigest({ deviceId, weekPnl: 0, positions: [] })
  const idleRaw = JSON.parse(idle.toString('utf8'))
  assert.deepEqual(Object.keys(idleRaw), ['v', 'type', 'deviceId', 'at', 'weekPnl', 'positions'])
  assert.ok(Number.isSafeInteger(idleRaw.at) && idleRaw.at > 0)
  assert.equal(idleRaw.weekPnlPct, undefined)
  // 空持仓是合法的：一个人刚开窗、还没下单。
  assert.deepEqual(idleRaw.positions, [])

  // 给了收益率就带上，且是比率（0.035 = +3.5%），不是百分数。
  const withPct = encodeTradingDigest({ deviceId, weekPnl: 35, weekPnlPct: 0.035, positions: [] })
  const pctRaw = JSON.parse(withPct.toString('utf8'))
  assert.deepEqual(Object.keys(pctRaw),
    ['v', 'type', 'deviceId', 'at', 'weekPnl', 'weekPnlPct', 'positions'])
  assert.equal(pctRaw.weekPnlPct, 0.035)
  assert.equal(parsePacket(withPct).packet.weekPnlPct, 0.035)
})

test('票 82：报文的精确字段集里没有硬币/保证金/入场价/历史', () => {
  const deviceId = randomUUID()
  // 模拟「本机自己那条 digest」：带两条持仓，编码后逐键检查。
  const data = encodeTradingDigest({
    deviceId,
    weekPnl: 12,
    weekPnlPct: 0.24,
    positions: validPositions()
  })
  const raw = JSON.parse(data.toString('utf8'))
  assert.deepEqual(Object.keys(raw),
    ['v', 'type', 'deviceId', 'at', 'weekPnl', 'weekPnlPct', 'positions'])
  assert.deepEqual(Object.keys(raw.positions[0]), ['crop', 'side', 'leverage'])
  // 连字段名都不该出现在线上报文里——发出去就再也收不回来。
  assert.doesNotMatch(data.toString('utf8'),
    /"(coins|available|locked|margin|entry|liq|liquidation|stopLoss|history|week|base|pnl)"\s*:/)

  // 解析端同样只重建白名单：伪造的硬币/保证金/入场价全部消失。
  const parsed = parsePacket(encodeJson(validDigest({
    coins: 9999,
    margin: 50,
    entry: 5,
    history: [{ pnl: 100 }],
    nickname: '伪造',
    port: 45871
  })))
  assert.equal(parsed.ok, true)
  assert.deepEqual(Object.keys(parsed.packet),
    ['v', 'type', 'deviceId', 'at', 'weekPnl', 'positions'])
  assert.deepEqual(Object.keys(parsed.packet.positions[0]), ['crop', 'side', 'leverage'])
  assert.equal(parsed.packet.coins, undefined)
  assert.equal(parsed.packet.margin, undefined)
  assert.equal(parsed.packet.entry, undefined)
  assert.equal(parsed.packet.history, undefined)
  assert.equal(parsed.packet.nickname, undefined)
})

test('票 82：持仓最多 8 条；坏一条就整包丢（不是丢那一条）', () => {
  const deviceId = randomUUID()
  const tooMany = []
  for (let index = 0; index < MAX_TRADING_POSITIONS + 1; index += 1) {
    tooMany.push({ crop: 'tomato', side: 'long', leverage: 1 })
  }
  assert.equal(MAX_TRADING_POSITIONS, 8)
  // 编码端：本机程序错误 → 抛。
  assert.throws(
    () => encodeTradingDigest({ deviceId, weekPnl: 0, positions: tooMany }),
    /trading positions/
  )
  // 解析端：网络输入 → 整包丢。
  assert.equal(parsePacket(encodeJson(validDigest({ positions: tooMany }))).reason, 'positions')
  // 正好 8 条是合法的闭区间上界。
  const eight = tooMany.slice(0, MAX_TRADING_POSITIONS)
  assert.equal(parsePacket(encodeJson(validDigest({ positions: eight }))).ok, true)

  // 一条坏持仓 → 整包丢：榜上不能出现「少了做空那几条」的半截列表。
  for (const bad of [
    { crop: 'strawberry', side: 'long', leverage: 1 }, // 不是盘口作物
    { crop: 'tomato', side: 'up', leverage: 1 }, // 方向只有 long/short
    { crop: 'tomato', side: 'long', leverage: 2 }, // 杠杆只有 1/5/20
    { crop: 'tomato', side: 'long' }, // 缺杠杆
    { crop: 'tomato', side: 'long', leverage: '5' }, // 字符串不是数字
    { crop: 'tomato', side: 'long', leverage: 5, margin: 50 }, // 多余字段本身不坏…
    null,
    'tomato',
    []
  ]) {
    const parsed = parsePacket(encodeJson(validDigest({
      positions: [validPositions()[0], bad]
    })))
    if (bad !== null && typeof bad === 'object' && !Array.isArray(bad) && bad.margin === 50) {
      // …多余字段被忽略，条目本身仍然合法（只留三个公开字段）。
      assert.equal(parsed.ok, true)
      assert.deepEqual(parsed.packet.positions[1], { crop: 'tomato', side: 'long', leverage: 5 })
    } else {
      assert.equal(parsed.reason, 'positions', JSON.stringify(bad))
    }
  }
  // `positions` 不是数组、或整个缺省，都整包丢。
  for (const positions of [undefined, null, 42, 'x', {}]) {
    assert.equal(parsePacket(encodeJson(validDigest({ positions }))).reason, 'positions',
      String(positions))
  }
  assert.equal(normalizeTradingPositions([]).length, 0)
})

test('票 82：weekPnl 是 ±1,000,000 内的有限数，坏了整包丢', () => {
  const deviceId = randomUUID()
  const boundary = parsePacket(encodeJson(validDigest({ weekPnl: MAX_WEEK_PNL })))
  assert.equal(boundary.ok, true)
  assert.equal(boundary.packet.weekPnl, MAX_WEEK_PNL)
  assert.equal(parsePacket(encodeJson(validDigest({ weekPnl: -MAX_WEEK_PNL }))).ok, true)
  // 负分是合法的：输钱也是榜上的一员。
  assert.equal(parsePacket(encodeJson(validDigest({ weekPnl: -8 }))).packet.weekPnl, -8)

  for (const weekPnl of [
    undefined,
    null,
    '42',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_WEEK_PNL + 1,
    -MAX_WEEK_PNL - 1,
    true
  ]) {
    assert.equal(parsePacket(encodeJson(validDigest({ weekPnl }))).reason, 'week-pnl',
      String(weekPnl))
  }
  assert.throws(
    () => encodeTradingDigest({ deviceId, weekPnl: MAX_WEEK_PNL + 1, positions: [] }),
    /week pnl/
  )
})

test('票 82：weekPnlPct 可选；出现就必须是 ±1000 内的有限数', () => {
  const deviceId = randomUUID()
  const parsed = parsePacket(encodeJson(validDigest({ weekPnlPct: -0.5 })))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.packet.weekPnlPct, -0.5)
  assert.equal(parsePacket(encodeJson(validDigest({ weekPnlPct: MAX_WEEK_PNL_PCT }))).ok, true)
  assert.equal(parsePacket(encodeJson(validDigest({ weekPnlPct: -MAX_WEEK_PNL_PCT }))).ok, true)
  // 缺省 = 没有这个键（不是 0）：窗口画「—」。
  assert.equal('weekPnlPct' in parsePacket(encodeJson(validDigest())).packet, false)
  // 显式 `null` 也是「没有」：JSON 里没有 undefined，对端只能这么表示不报收益率。
  const explicitNull = parsePacket(encodeJson(validDigest({ weekPnlPct: null })))
  assert.equal(explicitNull.ok, true)
  assert.equal('weekPnlPct' in explicitNull.packet, false)

  for (const weekPnlPct of [
    '0.1',
    MAX_WEEK_PNL_PCT + 0.5,
    -MAX_WEEK_PNL_PCT - 0.5,
    true,
    {}
  ]) {
    assert.equal(parsePacket(encodeJson(validDigest({ weekPnlPct }))).reason, 'week-pnl-pct',
      String(weekPnlPct))
  }
  assert.throws(
    () => encodeTradingDigest({ deviceId, weekPnl: 0, weekPnlPct: 'x', positions: [] }),
    /week pnl pct/
  )
})

test('票 82：at / deviceId 与别的报文同一套处理；未知类型静默丢', () => {
  const deviceId = randomUUID()
  for (const at of [undefined, null, 0, -1, 1.5, '1700000000000', Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(parsePacket(encodeJson(validDigest({ at }))).reason, 'at', String(at))
  }
  assert.equal(parsePacket(encodeJson(validDigest({ deviceId: 'nope' }))).reason, 'device-id')
  assert.equal(parsePacket(encodeJson(validDigest({ deviceId: 42 }))).reason, 'device-id')
  // 大写 deviceId 解析后小写：榜按它做键，大小写不能分成两行。
  const upper = validDigest({ deviceId: deviceId.toUpperCase() })
  assert.equal(parsePacket(encodeJson(upper)).packet.deviceId, deviceId.toLowerCase())

  // 旧版本邻居的 TYPE_SET 里没有这个类型：parsePacket 返回 type，发现层静默丢包
  // （`src/discovery.js` 只对 version 打一行日志），不刷日志、不改邻居灯。
  assert.equal(parsePacket(encodeJson(validDigest({ type: 'trading-digest-v2' }))).reason, 'type')
  assert.throws(() => encodePacket({ type: 'trading-digest-v2', deviceId }), /packet type/)
  // 4 KiB 上限照旧。
  assert.equal(parsePacket(Buffer.alloc(MAX_PACKET_BYTES + 1, 0x61)).reason, 'too-large')
})

test('票 82：周报常量与 SPEC 的 30 秒/2 分钟/8 条一致', () => {
  assert.equal(TRADING_DIGEST_INTERVAL_MS, 30 * 1000)
  assert.equal(TRADING_DIGEST_FRESH_MS, 2 * 60 * 1000)
  assert.equal(MAX_TRADING_POSITIONS, 8)
  assert.equal(MAX_WEEK_PNL, 1_000_000)
  assert.equal(MAX_WEEK_PNL_PCT, 1000)
})
