/**
 * 票 82：两台真 service 走回环 UDP 的盘口周报链路。
 *
 * 覆盖 SPEC「真人榜与协议」里只能端到端验证的部分：
 *   1. 互认之后 A 的榜里出现 B（自报 weekPnl + 当前持仓，且**没有**硬币/保证金/入场价）；
 *   2. B 开仓后 A 的榜跟着更新，digest 到达会把刷新推给开着的盘口窗（不用重开）；
 *   3. 伪造的（坏字段 / 合法但瞎报）周报改不了 A 的硬币、持仓与 trading.json；
 *   4. 同一 peer 一个窗口最多 1 条：超频不产生第二行、也不改分。
 *
 * 用 `network:true, port:0` + 127.0.0.1（与 `test/work-e2e.test.js` 同款）：
 * 内核挑端口避开并发测试的端口竞态，不碰真实局域网。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FARM_FILE } from '../src/farm.js'
import { MAX_WEEK_PNL, MAX_WEEK_PNL_PCT } from '../src/protocol.js'
import { createService } from '../src/service.js'
import { TRADING_FILE } from '../src/trading.js'
import { slotIndexAt, weekStartOf } from '../src/trading-rules.js'

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor (predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(15)
  }
  throw new Error('waitFor timeout')
}

function fakeCtx () {
  const routes = []
  return {
    ctx: {
      webServer: {
        register (options) {
          routes.push(options)
          return () => {}
        }
      },
      logger: { info () {}, warn () {} }
    },
    routes
  }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-trading-e2e-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

/** 盘口要花硬币：先写一份有硬币的农场存档（默认农场只有 30）。 */
async function seedFarm (dir, coins = 500) {
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins }), 'utf8')
}

function makeService (t, options = {}) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    petBridge: false,
    skinServer: false,
    desktop: false,
    ...options
  })
  service.routes = routes
  t.after(() => service.dispose())
  return service
}

async function callAction (service, body) {
  const route = service.routes.find((candidate) => candidate.path === '/dsh-zoo/action')
  assert.ok(route, '应该注册 /dsh-zoo/action')
  const res = {
    statusCode: 0,
    setHeader () {},
    end (payload) { this.payload = payload }
  }
  const req = {
    method: 'POST',
    _listeners: {},
    on (event, fn) {
      this._listeners[event] = fn
      return this
    },
    destroy () {}
  }
  const pending = route.handler(req, res)
  queueMicrotask(() => req._listeners.data?.(Buffer.from(JSON.stringify(body))))
  queueMicrotask(() => req._listeners.end?.())
  await pending
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null }
}

/**
 * 只记录 `boardWindow` 调用的桌面替身（与 `test/board-window.test.js` 同款）：
 * 用来断言「邻居的 digest 到达后会重推一拍」。
 */
function desktopDouble () {
  const calls = { scenes: [], board: [] }
  let onEvent = null
  let boardOpen = false
  return {
    calls,
    factory (options) {
      onEvent = options.onEvent
      return {
        start () { return { ok: true, pid: 4242 } },
        update (scene) { calls.scenes.push(scene); return true },
        resync (scene) { calls.scenes.push(scene); return true },
        status () { return { farmOpen: false, boardOpen } },
        farmWindow () { return true },
        boardWindow (payload) {
          calls.board.push(payload)
          if (payload.close === true) boardOpen = false
          else if (payload.open === true) boardOpen = true
          return true
        },
        actionResult () {},
        dispose () {}
      }
    },
    ready (workArea = { x: 0, y: 30, width: 1000, height: 700 }) {
      onEvent?.({ type: 'ready', pid: 4242, workArea, displays: [{ id: 1, bounds: workArea, workArea, scaleFactor: 1, primary: true }] })
    }
  }
}

function optionsFor (dir, port, targetPort, overrides = {}) {
  return {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    port,
    targetPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 5000,
    heartbeatIntervalMs: 5000,
    tickIntervalMs: 20,
    marketDigestMs: 1000,
    ...overrides
  }
}

/**
 * B 先起（`port:0`），A 再起并主动向 B 的端口广播；双方放行对方并等一次心跳。
 * `b`/`a` 的 overrides 分开传：发送节拍（DigestMs）两边要能不同——接收端限速窗口
 * 用 A 的值，发送节拍用 B 的值，这是下面几个用例的关键开关。
 */
async function connectedPair (t, overrides = {}, { beforeB = null } = {}) {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  await seedFarm(dirB)
  // B 的存档要在起服务之前落好：盘口只在 load 时读一次 trading.json。
  if (beforeB !== null) await beforeB(dirB)
  const b = makeService(t, optionsFor(dirB, 0, 0, overrides.b))
  await b.ready
  const bPort = b.localPort()
  assert.ok(bPort > 0)
  const a = makeService(t, optionsFor(dirA, 0, bPort, overrides.a))
  await a.ready
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)
  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal(a.room.admit(bId).ok, true)
  assert.equal(b.room.admit(aId).ok, true)
  a.sendHeartbeats()
  b.sendHeartbeats()
  await waitFor(() => (a.snapshot().neighbors[0]?.heartbeatAt ?? 0) > 0 &&
    (b.snapshot().neighbors[0]?.heartbeatAt ?? 0) > 0)
  return { a, b, dirA, dirB, aId, bId }
}

function leagueOf (service) {
  return service.snapshot().trading.league
}

function peerRow (service, deviceId) {
  return leagueOf(service).rows.find((row) => row.deviceId === deviceId) ?? null
}

/** 榜里出现这位邻居（第一包 digest 是「一到就发」，不必等节拍）。 */
async function waitForPeerRow (service, deviceId) {
  await waitFor(() => peerRow(service, deviceId) !== null)
  return peerRow(service, deviceId)
}

/** B 手里的原样字节：`sendTo` 会再查一遍放行，正好模拟「邻居主动发来一包」。 */
function rawDigest (deviceId, overrides = {}) {
  return Buffer.from(JSON.stringify({
    v: 1,
    type: 'trading-digest',
    deviceId,
    at: Date.now(),
    weekPnl: 0,
    positions: [],
    ...overrides
  }), 'utf8')
}

async function readTradingOrNull (dir) {
  try {
    return JSON.parse(await readFile(join(dir, TRADING_FILE), 'utf8'))
  } catch {
    return null
  }
}

test('票 82 e2e：榜里出现邻居自报的盈亏与持仓，且没有硬币/保证金/入场价', async (t) => {
  const desktop = desktopDouble()
  const { a, b, bId } = await connectedPair(t, {
    // B 每 60ms 一轮：榜与「digest 到达就重推」都能快速看到。
    b: { tradingDigestMs: 60 },
    a: { tradingDigestMs: 60, desktop: true, desktopFactory: desktop.factory }
  })
  const row = await waitForPeerRow(a, bId)
  // B 只报了分数与持仓：硬币/保证金/入场价/历史一个都不该出现在榜的行里。
  assert.deepEqual(Object.keys(row),
    ['deviceId', 'nickname', 'weekPnl', 'weekPnlPct', 'positions', 'me'])
  assert.equal(row.me, false)
  assert.equal(row.weekPnl, 0)
  assert.deepEqual(row.positions, [])
  assert.equal('coins' in row, false)
  assert.equal('margin' in row, false)
  assert.equal('entry' in row, false)
  // 没有仓位的人算「观望」：两个人、全场空仓。
  assert.deepEqual(leagueOf(a).sentiment, { long: 0, short: 0, flat: 2 })
  // 本机那一行一直在，且 me: true。
  assert.equal(leagueOf(a).rows.filter((entry) => entry.me).length, 1)
  // 本机的收益率由本机的 base 算：这周还没做单，0 / base = 0。
  assert.equal(leagueOf(a).self.weekPnl, 0)
  assert.equal(leagueOf(a).self.weekPnlPct, 0)
  // 旧版本邻居的可见状态由宿主播出：一位放行在线邻居，且已经报过新鲜周报。
  assert.deepEqual(leagueOf(a).watchers, { online: 1, reported: 1 })

  // B 用真的动作开一手 5× 多单：下一包 digest 里应该出现这条持仓。
  const opened = await callAction(b, {
    action: 'trading-open-position', side: 'long', margin: 50, leverage: 5, cropId: 'tomato'
  })
  assert.equal(opened.status, 200, JSON.stringify(opened.body))
  assert.equal(opened.body.ok, true, JSON.stringify(opened.body))
  await waitFor(() => peerRow(a, bId)?.positions.length === 1)
  const withPosition = peerRow(a, bId)
  assert.deepEqual(withPosition.positions, [{ crop: 'tomato', side: 'long', leverage: 5 }])
  // 持仓条目也只有三个公开字段（保证金/入场价留在 B 自己的 trading.json 里）。
  assert.deepEqual(Object.keys(withPosition.positions[0]), ['crop', 'side', 'leverage'])
  assert.deepEqual(leagueOf(a).sentiment, { long: 1, short: 0, flat: 1 })

  // 开着的盘口窗：digest 到达后会收到一包刷新（open:false，不关窗），里面带榜。
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)
  assert.equal((await callAction(a, { action: 'trading-open' })).body.window, 'opened')
  await waitFor(() => {
    const pushed = desktop.calls.board.at(-1)
    return pushed?.open === false &&
      Array.isArray(pushed.state?.league?.rows) &&
      pushed.state.league.rows.some((entry) => entry.deviceId === bId)
  })
  const pushed = desktop.calls.board.at(-1)
  assert.equal('close' in pushed, false, '刷新不能关窗')
  assert.equal(pushed.state.league.rows.length, 2)
  assert.equal(pushed.state.league.sentiment.long, 1)
})

test('票 82 e2e（评审 P0）：浮盈超出线上展示上限仍出现在邻居榜上，发送口不抛', async (t) => {
  const now = Date.now()
  const { a, b, bId } = await connectedPair(t, {
    b: { tradingDigestMs: 60 },
    a: { tradingDigestMs: 60 }
  }, {
    beforeB: async (dir) => {
      // 1,000,000 硬币 × 20× 的一手：入场的现价差让浮盈远大于 MAX_WEEK_PNL；
      // week.base = 1 让收益率也远大于 MAX_WEEK_PNL_PCT。两个字段都必须夹到线上边界，
      // 否则编码层整包拒绝，这位玩家会从每个邻居的榜上彻底消失。
      await seedFarm(dir, MAX_WEEK_PNL)
      await writeFile(join(dir, TRADING_FILE), JSON.stringify({
        version: 1,
        week: { start: weekStartOf(now), pnl: 0, base: 1 },
        positions: [{
          id: '3f0f2a1c-1d2e-4b3a-8c9d-0e1f2a3b4c5d',
          crop: 'tomato',
          side: 'long',
          margin: MAX_WEEK_PNL,
          leverage: 20,
          // 入场价故意远离现价：真实浮盈约 2e9，远超协议上限。
          entry: 0.05,
          openedAt: now,
          slot: slotIndexAt(now),
          stopLoss: 0
        }],
        orders: [],
        history: []
      }), 'utf8')
    }
  })

  const row = await waitForPeerRow(a, bId)
  assert.equal(row.weekPnl, MAX_WEEK_PNL, '线上分数夹到 MAX_WEEK_PNL')
  assert.equal(row.weekPnlPct, MAX_WEEK_PNL_PCT, '收益率夹到 MAX_WEEK_PNL_PCT')
  // 本机账本保留真实数字：夹取只作用于线上展示字段，硬币/持仓/存档一分不动。
  const own = b.snapshot().trading
  assert.ok(own.week.total > MAX_WEEK_PNL, '本机本周盈亏仍是真实值')
  assert.equal(own.week.pnl, 0, '已实现盈亏没被周报改过')
  assert.equal(own.positions.length, 1, '持仓没被周报改过')
  assert.equal(own.coins.available, MAX_WEEK_PNL, '农场硬币没被周报动过')
  // 发送口不抛：编码不再因「赢太多」失败，一轮仍会交给 socket。
  assert.equal(b.sendTradingDigest({ force: true }), 1)
})

test('票 82 e2e：伪造/坏字段的 digest 改不了本机硬币、持仓与 trading.json', async (t) => {
  const { a, b, dirA, aId, bId } = await connectedPair(t, {
    // A 的限速窗口 100ms：等过这个窗口再发伪造包。B 只发第一包（600 秒后才发第二包）。
    a: { tradingDigestMs: 100 },
    b: { tradingDigestMs: 600000 }
  })
  await waitForPeerRow(a, bId)
  await delay(150)
  const coinsBefore = a.snapshot().farm.coins
  const positionsBefore = a.snapshot().trading.positions
  const tradingBefore = await readTradingOrNull(dirA)

  // 1) 坏字段：weekPnl 是字符串 → 协议层整包丢，榜与账本都不动。
  assert.equal(b.sendTo(aId, rawDigest(bId, { weekPnl: 'lots', positions: [{ crop: 'tomato', side: 'long', leverage: 5 }] })), true)
  await delay(100)
  assert.equal(leagueOf(a).rows.length, 2)
  assert.equal(peerRow(a, bId).weekPnl, 0, '坏包整包丢，分数不变')
  assert.deepEqual(peerRow(a, bId).positions, [], '坏包里的持仓也不该混进榜')

  // 2) 合法但瞎报：榜是社交信任，数字会变（SPEC 明确不做强防作弊）……
  await delay(150)
  assert.equal(b.sendTo(aId, rawDigest(bId, {
    weekPnl: 999999,
    weekPnlPct: 9,
    positions: [{ crop: 'pumpkin', side: 'short', leverage: 20 }]
  })), true)
  await waitFor(() => peerRow(a, bId).weekPnl === 999999)
  assert.deepEqual(peerRow(a, bId).positions, [{ crop: 'pumpkin', side: 'short', leverage: 20 }])

  // …但本机的钱、仓位、存档一分不动：伪造只影响榜上的数字。
  assert.equal(a.snapshot().farm.coins, coinsBefore)
  assert.deepEqual(a.snapshot().trading.positions, positionsBefore)
  assert.deepEqual(await readTradingOrNull(dirA), tradingBefore)
  // 榜的排序仍然按分数（邻居 999999 > 本机 0）。
  assert.equal(leagueOf(a).rows[0].deviceId, bId)
  assert.equal(leagueOf(a).rows[0].me, false)
})

test('票 82 e2e：同一 peer 一个窗口最多 1 条，重复包不改分也不加行', async (t) => {
  const { a, b, aId, bId } = await connectedPair(t, {
    // A 的接收窗口 500ms；B 只在第一拍发一包（下一次要 600 秒后）。
    a: { tradingDigestMs: 500 },
    b: { tradingDigestMs: 600000 }
  })
  await waitForPeerRow(a, bId)
  const startedAt = Date.now()

  // 窗口内连发三包：都被第三道门丢掉，行数与分数都不变。
  for (const weekPnl of [111, 222, 333]) {
    assert.equal(b.sendTo(aId, rawDigest(bId, { weekPnl })), true)
  }
  await delay(120)
  assert.equal(leagueOf(a).rows.length, 2, '重复包不产生第二行')
  assert.equal(peerRow(a, bId).weekPnl, 0, '同一窗口里最多接受 1 条')

  // 等过这个窗口再来一包：这次会被接受（证明刚才挡它的是限流，不是解析）。
  await waitFor(() => Date.now() - startedAt > 600)
  assert.equal(b.sendTo(aId, rawDigest(bId, { weekPnl: 444 })), true)
  await waitFor(() => peerRow(a, bId).weekPnl === 444)
  assert.equal(leagueOf(a).rows.length, 2)
})

test('票 82（评审 P2）：3 分钟前的周报被盘口新鲜度门丢掉，随后新鲜包照常收', async (t) => {
  const { a, b, aId, bId } = await connectedPair(t, {
    // A 的限速窗口 100ms；B 只在第一拍发一包（下一次 600 秒后），下面手动投包。
    a: { tradingDigestMs: 100 },
    b: { tradingDigestMs: 600000 }
  })
  await waitForPeerRow(a, bId)
  await delay(150)

  // 3 分钟前的样本：超过 TRADING_DIGEST_FRESH_MS（2 分钟）→ 整包丢，分数不动。
  assert.equal(b.sendTo(aId, rawDigest(bId, {
    weekPnl: 777,
    at: Date.now() - 3 * 60 * 1000
  })), true)
  await delay(120)
  assert.equal(peerRow(a, bId).weekPnl, 0, '过期样本不能改榜')

  // 再等过限速窗口发一条新鲜的：证明刚才挡它的是新鲜度门，不是限速门。
  await delay(150)
  assert.equal(b.sendTo(aId, rawDigest(bId, { weekPnl: 888 })), true)
  await waitFor(() => peerRow(a, bId).weekPnl === 888)
})
