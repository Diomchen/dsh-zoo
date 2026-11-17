/**
 * 票 94：两台真 service 走回环 UDP 的「双机开户与净额结算」链路。
 *
 * 只覆盖端到端才能验的部分（协议形状在 `test/protocol.test.js`，账本规则在
 * `test/futures-store.test.js`）：
 *   1. peer 报到（hello）后房主回一份 settle，窗口拿到 epoch/seq 并认出自己是 peer；
 *   2. 房主替 peer 记账：充值 + 开仓之后，peer 窗口上的余额/持仓与房主账本一致；
 *   3. `(epoch, seq)` 幂等：同一条重发只算一次，倒退的 seq 丢掉，新 epoch 直接采纳；
 *   4. 换了 UDP 源（端口不同）冒充同一个 deviceId 的包不落账；
 *   5. 没放行的 deviceId 的包也不落账。
 *
 * 用 `network:true, port:0` + 127.0.0.1（与 `test/trading-e2e.test.js` 同款）：
 * 内核挑端口避开并发测试的端口竞态，不碰真实局域网。角色用 `futuresHost` 钉死，
 * 免得两个随机 deviceId 让「谁当房主」的选举结果在两次跑之间翻面。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import dgram from 'node:dgram'

import { FARM_FILE } from '../src/farm.js'
import { createFuturesStore } from '../src/futures.js'
import { SLOT_MS, notionalOf, roundCoin, takerFeeOf } from '../src/futures-rules.js'
import { createService } from '../src/service.js'

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-net-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

async function seedFarm (dir, coins = 500) {
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins }), 'utf8')
}

/**
 * 票 98：这组端到端用例验的是真钱净额结算。直接在落盘文件里写 `mode:'live'`，
 * 不走 `futures-mode` 动作——切模式会推进一次全局 seq、往流水里记一条 mode，
 * 那两件事会打乱本文件里「新账户 seq=0 / 流水条数」这类既有断言。
 */
async function seedLiveFutures (dir) {
  await writeFile(join(dir, 'futures.json'), JSON.stringify({ version: 1, mode: 'live' }), 'utf8')
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
    // 票 94：结算/报到/对账都调快，别让「等 15/30 秒」变成测试的等待时间。
    futuresTickMs: 20,
    futuresHelloMs: 40,
    futuresSyncMs: 40,
    // 票 98：40ms 一次的 hello/sync 会远超「20 包/10 秒」；这组用例验的是账本同步，
    // 限速本身另有用例，所以把配额放大，避免控制包把业务包挤掉。
    futuresRateLimit: 10000,
    ...overrides
  }
}

/**
 * B 先起（`port:0`），A 再起并主动向 B 的端口广播；双方放行对方并等一次心跳。
 * B 是房主（`futuresHost:true`），A 是 peer（`futuresHost:false`）。
 */
async function connectedPair (t, overrides = {}) {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  const coins = overrides.coins ?? 500
  await seedFarm(dirA, coins)
  await seedFarm(dirB, coins)
  await seedLiveFutures(dirA)
  await seedLiveFutures(dirB)
  const b = makeService(t, optionsFor(dirB, 0, 0, { futuresHost: true, ...overrides.b }))
  await b.ready
  const bPort = b.localPort()
  assert.ok(bPort > 0)
  const a = makeService(t, optionsFor(dirA, 0, bPort, { futuresHost: false, ...overrides.a }))
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
  return { a, b, dirA, dirB, aId, bId, bPort }
}

/** 给某台服务的 UDP 端口直接投一包（模拟「别人拿别人的 deviceId 发指令」）。 */
async function sendRaw (port, packet) {
  const socket = dgram.createSocket('udp4')
  try {
    await new Promise((resolve, reject) => {
      socket.send(Buffer.from(JSON.stringify(packet), 'utf8'), port, '127.0.0.1', (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  } finally {
    socket.close()
  }
}

test('票 94：peer 报到后房主回一份 settle，窗口认出 role=peer 与房主 id', async (t) => {
  const { a, b, aId, bId } = await connectedPair(t)

  // hello 由 service 自己按节拍发（不是测试手喂），走到这里必然已经握手过。
  await waitFor(() => a.futuresWindow().peer.ready === true)
  const window = a.futuresWindow()
  assert.equal(window.role, 'peer')
  assert.equal(window.hostId, bId)
  assert.equal(window.ready, true)
  assert.equal(window.peer.text, '已连上房主，账目每 30 秒对一次')
  assert.equal(typeof window.epoch, 'string')
  assert.ok(window.epoch.length > 0, 'settle 必须带非空 epoch')
  assert.equal(window.balance, 0)
  assert.equal(window.positionCount, 0)
  // 窗口的「壳」照旧由本机下发：没有 crops/limits/slotEnd，peer 窗连按钮都画不出来。
  assert.ok(Array.isArray(window.crops) && window.crops.length > 0)
  assert.ok(Array.isArray(window.limits.leverages) && window.limits.leverages.length > 0)
  assert.equal(typeof window.limits.lotSize, 'number')
  assert.equal(typeof window.limits.takerFeeRate, 'number')
  assert.ok(window.slotEnd > window.now)
  assert.equal(a.futuresHost(), bId)

  // 房主那边：账户是零账，但 epoch 跟自己账本一致；自己不会变成 peer。
  const account = b.futuresAccountOf(aId)
  assert.equal(account.seq, 0)
  assert.equal(account.epoch, window.epoch)
  assert.equal(b.futuresWindow().role, undefined)
  assert.equal(b.futuresHost(), bId)
})

test('票 94：房主替 peer 充值 + 开仓，peer 窗口的余额/持仓与房主账本一致', async (t) => {
  const { a, b, aId } = await connectedPair(t)
  await waitFor(() => a.futuresWindow().peer.ready === true)

  // peer 点「充值」：钱先从自己农场划出，再只把指令发给房主，回执是 pending。
  const deposit = await callAction(a, { action: 'futures-deposit', coins: 100 })
  assert.equal(deposit.status, 200)
  assert.equal(deposit.body.ok, true)
  assert.equal(deposit.body.pending, true)
  assert.equal(deposit.body.notice, '已发给房主，等一拍回执。')

  await waitFor(() => a.futuresWindow().balance === 100)
  assert.equal(b.futuresAccountOf(aId).balance, 100)
  // 房主自己的农场硬币不动：peer 的余额只是「你在我这里的可用额度」。
  assert.equal(b.snapshot().farm.coins, 500)
  // peer 那边真的花了 100 个币：农场少 100，本机托管归零，房主账本多 100（不凭空生币）。
  assert.equal(a.snapshot().farm.coins, 400)
  assert.equal(a.futures().balance, 0)
  assert.equal(a.snapshot().farm.coins + a.futures().balance + b.snapshot().farm.coins +
    b.futuresAccountOf(aId).balance, 1000)

  const opened = await callAction(a, {
    action: 'futures-open',
    cropId: 'tomato',
    side: 'long',
    margin: 20,
    leverage: 10
  })
  assert.equal(opened.body.ok, true)
  assert.equal(opened.body.pending, true)

  await waitFor(() => a.futuresWindow().positionCount === 1)
  const peerWindow = a.futuresWindow()
  const hostAccount = b.futuresAccountOf(aId)
  assert.equal(peerWindow.positions[0].crop, 'tomato')
  assert.equal(peerWindow.positions[0].side, 'long')
  assert.equal(peerWindow.positions[0].leverage, 10)
  assert.ok(peerWindow.positions[0].lots > 0)
  // 余额与保证金是房主算的：两边必须逐分一致（不是「差不多」）。
  assert.equal(peerWindow.balance, hostAccount.balance)
  assert.equal(peerWindow.marginUsed, hostAccount.marginUsed)
  assert.equal(peerWindow.equity, hostAccount.equity)
  assert.ok(peerWindow.balance < 100, '开仓要扣保证金和手续费')
  assert.equal(typeof peerWindow.positions[0].unrealized, 'number')

  // 平仓：同样是发给房主，回执 pending，账目回来后才变。
  const closed = await callAction(a, { action: 'futures-close', positionId: peerWindow.positions[0].id })
  assert.equal(closed.body.pending, true)
  await waitFor(() => a.futuresWindow().positionCount === 0)
  assert.equal(a.futuresWindow().balance, b.futuresAccountOf(aId).balance)
})

test('票 94：过一根之后两边盯市的余额仍然逐分一致（假时钟跳到下一根）', async (t) => {
  // 两台共用同一个可拨的时钟：开盘在第 N 根，然后把时钟拨到第 N+1 根整点，
  // 房主的期货 tick 就会盯市并把新的余额发回来（不然要真等 15 分钟）。
  const clock = { at: Date.UTC(2026, 10, 17, 12, 0, 0) }
  const { a, b, aId } = await connectedPair(t, {
    a: { futuresNow: () => clock.at },
    b: { futuresNow: () => clock.at }
  })
  await waitFor(() => a.futuresWindow().peer.ready === true)

  const deposit = await callAction(a, { action: 'futures-deposit', coins: 200 })
  assert.equal(deposit.body.pending, true)
  await waitFor(() => a.futuresWindow().balance === 200)
  const opened = await callAction(a, {
    action: 'futures-open',
    cropId: 'tomato',
    side: 'long',
    margin: 50,
    leverage: 10
  })
  assert.equal(opened.body.pending, true)
  await waitFor(() => a.futuresWindow().positionCount === 1)
  const beforeSeq = b.futuresAccountOf(aId).seq
  const beforeEntry = a.futuresWindow().positions[0].entry

  clock.at += SLOT_MS

  // seq 变了 = 房主真的盯市并发了一拍新的 settle（不是窗口自己算的）。
  await waitFor(() => b.futuresAccountOf(aId).seq > beforeSeq)
  await waitFor(() => a.futuresWindow().balance === b.futuresAccountOf(aId).balance)
  const peerWindow = a.futuresWindow()
  const hostAccount = b.futuresAccountOf(aId)
  assert.equal(peerWindow.balance, hostAccount.balance)
  assert.equal(peerWindow.marginUsed, hostAccount.marginUsed)
  assert.equal(peerWindow.equity, hostAccount.equity)
  assert.equal(peerWindow.positionCount, hostAccount.positions.length)
  // 盯市会把 entry 挪到这一根的价（同一份账，两边同一个数）。
  assert.equal(peerWindow.positions[0].entry, hostAccount.positions[0].entry)
  assert.notEqual(peerWindow.positions[0].entry, beforeEntry)
})

test('票 96：peer 转现货把作物入本机仓库，房主平合约并按公允价结钱', async (t) => {
  const clock = { at: new Date(2026, 10, 19, 12, 0, 0).getTime() }
  const { a, b, aId } = await connectedPair(t, {
    coins: 2000,
    a: { futuresNow: () => clock.at },
    b: { futuresNow: () => clock.at }
  })
  await waitFor(() => a.futuresWindow().peer.ready === true)

  const deposit = await callAction(a, { action: 'futures-deposit', coins: 2000 })
  assert.equal(deposit.body.pending, true)
  await waitFor(() => a.futuresWindow().balance === 2000)
  const opened = await callAction(a, {
    action: 'futures-open',
    cropId: 'tomato',
    side: 'long',
    margin: 50,
    leverage: 10
  })
  assert.equal(opened.body.pending, true)
  await waitFor(() => a.futuresWindow().positionCount === 1)
  const positionId = a.futuresWindow().positions[0].id
  const beforeCrops = Number(a.snapshot().farm.crops.tomato ?? 0)

  const converted = await callAction(a, { action: 'futures-convert', positionId, lots: 1 })
  assert.equal(converted.body.pending, true, JSON.stringify(converted.body))
  await waitFor(() => b.futuresAccountOf(aId).positions.length === 0 && a.futuresWindow().positionCount === 0)

  assert.equal(a.snapshot().farm.crops.tomato, beforeCrops + 100)
  assert.equal(a.futuresWindow().balance, b.futuresAccountOf(aId).balance)
  const trades = a.futuresWindow().trades.filter((entry) => entry.kind === 'convert')
  assert.equal(trades.length, 1)
  assert.equal(trades[0].lots, 1)
  assert.ok(trades[0].fee > 0)
})

test('票 96：周五 20:00 房主到期交割，peer 的余额与持仓同步清零并收到交割流水', async (t) => {
  const clock = { at: new Date(2026, 10, 20, 19, 0, 0).getTime() }
  const { a, b, aId } = await connectedPair(t, {
    a: { futuresNow: () => clock.at },
    b: { futuresNow: () => clock.at }
  })
  await waitFor(() => a.futuresWindow().peer.ready === true)

  const deposit = await callAction(a, { action: 'futures-deposit', coins: 200 })
  assert.equal(deposit.body.pending, true)
  await waitFor(() => a.futuresWindow().balance === 200)
  const opened = await callAction(a, {
    action: 'futures-open',
    cropId: 'tomato',
    side: 'long',
    margin: 50,
    leverage: 10
  })
  assert.equal(opened.body.pending, true)
  await waitFor(() => a.futuresWindow().positionCount === 1)

  // 拨到到期整点：房主 tick 会先盯市、再走 expireDue 的交割。
  clock.at = new Date(2026, 10, 20, 20, 0, 0).getTime()
  await waitFor(() => b.futuresAccountOf(aId).positions.length === 0 && a.futuresWindow().positionCount === 0)

  const peerWindow = a.futuresWindow()
  const hostAccount = b.futuresAccountOf(aId)
  assert.equal(peerWindow.marginUsed, 0)
  assert.equal(hostAccount.marginUsed, 0)
  assert.equal(peerWindow.balance, hostAccount.balance)
  assert.equal(peerWindow.session.kind, 'expired')
  assert.match(peerWindow.delivery.contract, /-2026W47$/)
  const delivery = peerWindow.trades.filter((entry) => entry.kind === 'delivery')
  assert.equal(delivery.length, 1)
  assert.equal(delivery[0].contract, 'tomato-2026W47')
  assert.equal(delivery[0].lots, 1)
  assert.equal(typeof delivery[0].deliveryFee, 'number')
  assert.equal(hostAccount.trades.filter((entry) => entry.kind === 'delivery').length, 1)
})

test('票 94：同一条 settle 只算一次，倒退的 seq 丢掉，新 epoch 直接采纳', async (t) => {
  const dir = await tempDir(t)
  const farm = { spendCoins: async (qty) => ({ ok: true, qty }), addCoins: async (qty) => ({ ok: true, qty }) }
  const store = await createFuturesStore(dir, { farm, now: () => 1700000000000 })

  const positions = [{
    id: '11111111-1111-4111-8111-111111111111',
    crop: 'tomato',
    contract: 'tomato-2026W47',
    side: 'long',
    lots: 2,
    entry: 5,
    margin: 10,
    leverage: 10
  }]
  const first = store.applySettle({ epoch: 'e1', seq: 5, balance: 100, marginUsed: 10, positions })
  assert.deepEqual(first, { ok: true, applied: true })
  // 重发同一条：不算第二次（否则平白多一笔钱）。
  assert.deepEqual(store.applySettle({ epoch: 'e1', seq: 5, balance: 100, marginUsed: 10, positions }), {
    ok: true,
    applied: false,
    reason: 'stale'
  })
  // 乱序到达的旧包：同样丢。
  assert.deepEqual(store.applySettle({ epoch: 'e1', seq: 4, balance: 999, marginUsed: 0, positions: [] }), {
    ok: true,
    applied: false,
    reason: 'stale'
  })
  assert.equal(store.replicaOf().balance, 100)
  assert.equal(store.replicaOf().lastSeq, 5)

  // 新 epoch = 房主换了账本（重启/换人）：seq 归零也照收。
  assert.deepEqual(store.applySettle({ epoch: 'e2', seq: 1, balance: 7, marginUsed: 0, positions: [] }), {
    ok: true,
    applied: true
  })
  assert.equal(store.replicaOf().epoch, 'e2')
  assert.equal(store.replicaOf().lastSeq, 1)
  assert.equal(store.replicaOf().balance, 7)
  assert.equal(store.replicaOf().positions.length, 0)

  // 坏包一个字节都不落：epoch/seq/positions 任一不合格就整包拒。
  assert.equal(store.applySettle({ epoch: '', seq: 2, balance: 1, marginUsed: 0, positions: [] }).ok, false)
  assert.equal(store.applySettle({ epoch: 'e2', seq: -1, balance: 1, marginUsed: 0, positions: [] }).ok, false)
  assert.equal(store.applySettle({ epoch: 'e3', seq: 2, balance: 1, marginUsed: 0, positions: 'x' }).ok, false)
  assert.equal(store.replicaOf().epoch, 'e2')
  // 重启后副本不落盘：下次启动靠 30 秒 sync 重新要一份。
  const reloaded = await createFuturesStore(dir, { farm })
  assert.equal(reloaded.replicaOf(), null)
})

test('票 94：换源冒充同一个 deviceId 的指令不落账', async (t) => {
  const { a, b, aId, bPort } = await connectedPair(t)
  await waitFor(() => a.futuresWindow().peer.ready === true)
  const deposit = await callAction(a, { action: 'futures-deposit', coins: 100 })
  assert.equal(deposit.body.pending, true)
  await waitFor(() => b.futuresAccountOf(aId).balance === 100)
  const before = b.futuresAccountOf(aId)

  // 同一个 deviceId，但从另一个 UDP 端口发来：房主把它当冒充，整包丢。
  await sendRaw(bPort, {
    v: 1,
    type: 'futures-order',
    deviceId: aId,
    at: Date.now(),
    kind: 'deposit',
    coins: 900
  })
  await delay(300)
  const after = b.futuresAccountOf(aId)
  assert.equal(after.balance, before.balance)
  assert.equal(after.seq, before.seq)
  // peer 那边的副本也一分没多。
  assert.equal(a.futuresWindow().balance, 100)

  // 没放行的 deviceId 更不行：房主连账户都不给它建。
  const strangerId = '22222222-2222-4222-8222-222222222222'
  await sendRaw(bPort, {
    v: 1,
    type: 'futures-order',
    deviceId: strangerId,
    at: Date.now(),
    kind: 'deposit',
    coins: 50
  })
  await delay(300)
  assert.equal(b.futuresAccountOf(strangerId).balance, 0)
  assert.equal(b.futuresAccountOf(strangerId).seq, 0)
  assert.equal(b.futuresAccountOf(aId).balance, before.balance)
})

test('票 95：peer 挂单、房主吃单——一根后两头权益变化之和只等于两笔手续费', async (t) => {
  // 共用同一个冻住的时钟：报价不动，挂单价与手续费都能提前算死。
  const clock = { at: Date.UTC(2026, 10, 17, 12, 0, 0) }
  const { a, b, aId } = await connectedPair(t, {
    a: { futuresNow: () => clock.at },
    b: { futuresNow: () => clock.at }
  })
  await waitFor(() => a.futuresWindow().peer.ready === true)

  // 两边各充 300：A 走 peer 通道（农场 → 本机托管 → 房主账本），B 是房主本机充值。
  assert.equal((await callAction(a, { action: 'futures-deposit', coins: 300 })).body.pending, true)
  await waitFor(() => a.futuresWindow().balance === 300)
  assert.equal((await callAction(b, { action: 'futures-deposit', coins: 300 })).body.ok, true)
  assert.equal(b.futures().balance, 300)

  // 卖单挂在 ask 上：高于 bid 不会立刻被做市商扫掉，只会等人来吃。
  const ask = b.futuresWindow().quotes.tomato.ask
  const price = roundCoin(ask)
  const placed = await callAction(a, {
    action: 'futures-place',
    cropId: 'tomato',
    side: 'short',
    price,
    lots: 1,
    leverage: 10
  })
  assert.equal(placed.body.ok, true)
  assert.equal(placed.body.pending, true)
  assert.equal(placed.body.notice, '已发给房主，等一拍回执。')
  await waitFor(() => a.futuresWindow().orders.length === 1)
  // 房主账本上记的是 A 的挂单，且冻结保证金真的从 A 的余额里划走了。
  const hostBook = b.futuresAccountOf(aId)
  assert.equal(hostBook.orders.length, 1)
  assert.equal(hostBook.orders[0].side, 'short')
  assert.equal(hostBook.orders[0].price, price)
  assert.equal(hostBook.marginUsed, hostBook.orders[0].marginFrozen)
  assert.ok(hostBook.balance < 300)

  // B 下反向买单（价格相同 → 立刻与 A 的卖单交叉，先于做市商扫单）。
  const taken = await callAction(b, {
    action: 'futures-place',
    cropId: 'tomato',
    side: 'long',
    price,
    lots: 1,
    leverage: 10
  })
  assert.equal(taken.body.ok, true)

  await waitFor(() => a.futuresWindow().positionCount === 1 && b.futuresWindow().positionCount === 1)
  // A 的挂单从两边窗口都消失：peer 副本与房主账本都不该再留着它。
  await waitFor(() => a.futuresWindow().orders.length === 0)
  assert.deepEqual(a.futuresWindow().orders, [])
  assert.deepEqual(b.futuresAccountOf(aId).orders, [])

  const peerWindow = a.futuresWindow()
  const hostWindow = b.futuresWindow()
  assert.equal(peerWindow.positions[0].side, 'short')
  assert.equal(peerWindow.positions[0].entry, price)
  assert.equal(peerWindow.positions[0].lots, 1)
  assert.equal(hostWindow.positions[0].side, 'long')
  assert.equal(hostWindow.positions[0].entry, price)
  assert.equal(hostWindow.positions[0].lots, 1)

  // 两边余额与占用逐分一致（账只有一本，peer 只是副本）。
  assert.equal(peerWindow.balance, b.futuresAccountOf(aId).balance)
  assert.equal(peerWindow.marginUsed, b.futuresAccountOf(aId).marginUsed)

  // 零和：保证金只是从「可用」划进「占用」，两头合起来只少了各自那腿手续费。
  const fee = takerFeeOf(notionalOf({ lots: 1, price }))
  assert.equal(roundCoin((peerWindow.equity - 300) + (hostWindow.equity - 300)), roundCoin(-2 * fee))
})

test('票 94：老邻居（没有 futures 能力位）不影响本机，窗口直说对端未升级', async (t) => {
  // 两台都是老版本：谁都没有 futures 能力位，也就选不出房主。
  const oldCaps = ['raid', 'look', 'crops']
  const { a, b } = await connectedPair(t, {
    a: { caps: oldCaps, futuresHost: false },
    b: { caps: oldCaps, futuresHost: false }
  })
  await delay(300)
  assert.deepEqual(a.snapshot().neighbors[0].caps ?? [], oldCaps)
  for (const service of [a, b]) {
    const window = service.futuresWindow()
    assert.equal(window.role, 'peer')
    assert.equal(window.hostId, null)
    assert.equal(window.peer.ready, false)
    assert.equal(window.peer.text, '对端未升级，期货不可用')
    assert.equal(service.futuresHost(), null)
  }
  // 农场与本机账本都没被这条链路动过：老邻居照常种地。
  assert.equal(a.snapshot().farm.coins, 500)
  assert.equal(b.snapshot().farm.coins, 500)
  assert.equal(a.futures().balance, 0)
  assert.equal(b.futures().balance, 0)
})
