/**
 * 票 44：两个真 service 的雇佣全链路。
 *
 * B 挂牌 → A 雇 B → A 的桌面出现 work 角标的雇工、B 的宠物在外打工且自家守卫 0 →
 * A 的守卫 0.8 → A 提前结束 → B 结束并结算 → 双方守卫回到 0.3、钱只动一次。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FARM_FILE } from '../src/farm.js'
import { petsFromSnapshot } from '../src/desktop-pets.js'
import { createService } from '../src/service.js'

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 全量并发跑（4 路、2 核）时这两台机器的 UDP 来回会慢到秒级；单跑这一条要 6 秒，
// 所以默认给 20 秒——它只在真出问题时才等满。
async function waitFor (predicate, timeoutMs = 20_000) {
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-work-e2e-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
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
    contractTickMs: 20,
    contractRetryMs: 1000,
    contractRetryMaxMs: 2000,
    contractStartupGraceMs: 5,
    peerLostMs: 20000,
    workRetryMs: 50,
    workTimeoutMs: 1500,
    ...overrides
  }
}

async function connectedPair (t, overrides = {}) {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  // port:0 = 让内核挑端口，避免多个测试进程的 free-port 竞态；
  // A 主动向 B 广播，B 用 discovery 的 beacon-ack 回给来源地址。
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

async function listOn (service, overrides = {}) {
  const result = await callAction(service, {
    action: 'hire-listing',
    enabled: true,
    wagePerHour: 10,
    minHours: 2,
    maxHours: 8,
    ...overrides
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.ok, true)
}

async function hireFrom (a, b, bId, hours = 2) {
  // 挂牌广播 → A 的雇工板看到 available；没有真的发出去就等一下再补。
  let listing = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    b.sendMarketDigest({ force: true })
    listing = a.contractWindow().listings.find((entry) => entry.deviceId === bId && entry.available === true)
    if (listing !== undefined) break
    await delay(600)
  }
  assert.ok(listing, 'A 应该收到 B 的 available 挂牌')
  const hired = await callAction(a, { action: 'hire', deviceId: bId, hours })
  assert.equal(hired.status, 200, JSON.stringify(hired.body))
  assert.equal(hired.body.ok, true, JSON.stringify(hired.body))
  await waitFor(() => a.snapshot().contracts.outgoing[0]?.status === 'active' &&
    b.snapshot().contracts.incoming[0]?.status === 'active')
  return hired.body
}

test('挂牌 → 雇佣 → 雇工画面 → 守卫 0.8/0 → 提前结束 → 结算只发生一次', async (t) => {
  const { a, b, dirA, aId, bId } = await connectedPair(t)
  await listOn(b)
  // 雇佣前记下墙钟：雇佣不能再把在线计时推到点击那一刻。
  const beforeHireAt = Date.now()
  await delay(30)
  await hireFrom(a, b, bId)

  // 钱：A 扣 wage 20 + fee 1；B 一分没扣。
  assert.equal(a.snapshot().farm.coins, 9)
  assert.equal(b.snapshot().farm.coins, 30)
  const outgoing = a.snapshot().contracts.outgoing[0]
  assert.equal(outgoing.wage, 20)
  assert.equal(outgoing.fee, 1)
  assert.equal(outgoing.workerDeviceId, bId)
  const incoming = b.snapshot().contracts.incoming[0]
  assert.equal(incoming.employerDeviceId, aId)

  // 雇佣也是农场动作，但露水按在线时长累计：动作不重置锚点。
  const afterHire = JSON.parse(await readFile(join(dirA, FARM_FILE), 'utf8'))
  assert.ok(afterHire.dewAt <= beforeHireAt, '雇佣不重置在线计时（dewAt 留在原地）')

  // 记录页：双方各一条 hire 日志，带 who / hours / wage。
  await waitFor(() => a.snapshot().farm.log.some((entry) => entry.kind === 'hire') &&
    b.snapshot().farm.log.some((entry) => entry.kind === 'hire'))
  const aHireLog = a.snapshot().farm.log.find((entry) => entry.kind === 'hire')
  const bHireLog = b.snapshot().farm.log.find((entry) => entry.kind === 'hire')
  assert.equal(aHireLog.wage, 20)
  assert.equal(aHireLog.hours, 2)
  assert.equal(aHireLog.who.length > 0, true)
  assert.equal(bHireLog.wage, 20)
  assert.equal(bHireLog.hours, 2)
  assert.equal(bHireLog.who.length > 0, true)

  // 驮包只显示：B（雇工）的工资在途；A（雇主）没有工资条目。
  const bWage = b.carried().find((entry) => entry.kind === 'wage')
  assert.ok(bWage, '雇工驮包里应有工资')
  assert.equal(bWage.contractId, incoming.id)
  assert.equal(a.carried().some((entry) => entry.kind === 'wage'), false)
  assert.equal(b.snapshot().farm.coins, 30, '工资只显示，不提前入账')

  // 房间镜像 + 守卫。
  assert.equal(a.room.inboundWorker().workerNickname.length > 0, true)
  assert.equal(b.room.outboundWork() !== null, true)
  assert.equal(a.farmGuard().guard, 0.8)
  assert.equal(a.farmGuard().worker, true)
  assert.equal(a.snapshot().farm.worker.nickname.length > 0, true)
  assert.equal(a.snapshot().farm.guard, 0.8)
  assert.equal(b.farmGuard().guard, 0)
  assert.equal(b.snapshot().farm.guard, 0)

  // 雇工画面：A 的桌面多一只 role:'worker' + badge:'work'；B 自己的 self 消失。
  const petsA = petsFromSnapshot(a.snapshot())
  const worker = petsA.find((pet) => pet.role === 'worker')
  assert.ok(worker, 'A 的桌面应该有雇工')
  assert.equal(worker.badge, 'work')
  assert.equal(worker.id, 'worker:' + bId)
  assert.equal(petsA.some((pet) => pet.id === 'self'), true)
  const petsB = petsFromSnapshot(b.snapshot())
  assert.equal(petsB.some((pet) => pet.id === 'self'), false)

  // 合同期内不能串门。
  const blocked = await callAction(b, { action: 'visit' })
  assert.equal(blocked.body.ok, false)
  assert.equal(blocked.body.error, 'already-working')

  // A 提前结束：B 结束镜像、A 结算退款。
  const ended = await callAction(a, { action: 'end-contract', contractId: outgoing.id })
  assert.equal(ended.body.ok, true, JSON.stringify(ended.body))
  await waitFor(() => b.snapshot().contracts.incoming[0]?.settled === true)
  await waitFor(() => a.snapshot().contracts.outgoing[0]?.settled === true)
  await waitFor(() => a.snapshot().farm.coins === 29)
  // 服务时长几乎为 0：B 的 earned = 0（floor），手续费烧掉。
  assert.equal(b.snapshot().farm.coins, 30)
  assert.equal(a.snapshot().contracts.outgoing[0].earned, 0)

  // 镜像与守卫回到 0.3。
  await waitFor(() => a.room.inboundWorker() === null && b.room.outboundWork() === null)
  await waitFor(() => a.farmGuard().guard === 0.3 && b.farmGuard().guard === 0.3)
  assert.equal(a.snapshot().farm.worker, null)

  // 结算日志 + 驮包清空：双方各一条 settle，雇工的工资不再「在途」。
  await waitFor(() => a.snapshot().farm.log.some((entry) => entry.kind === 'settle') &&
    b.snapshot().farm.log.some((entry) => entry.kind === 'settle'))
  const aSettle = a.snapshot().farm.log.find((entry) => entry.kind === 'settle')
  const bSettle = b.snapshot().farm.log.find((entry) => entry.kind === 'settle')
  assert.equal(aSettle.earned, 0)
  assert.equal(bSettle.earned, 0)
  assert.equal(bSettle.wage, 20)
  assert.deepEqual(b.carried(), [])
  assert.deepEqual(a.carried(), [])

  // 重复 settle/ack 不双花：等两轮重试窗口，钱不动。
  await delay(300)
  assert.equal(a.snapshot().farm.coins, 29)
  assert.equal(b.snapshot().farm.coins, 30)
})

test('主人召回：雇主结束合同、雇工回家、双方结算且只入账一次', async (t) => {
  const { a, b, bId } = await connectedPair(t)
  await listOn(b, { wagePerHour: 5, minHours: 2, maxHours: 4 })
  await hireFrom(a, b, bId, 2)
  assert.equal(a.snapshot().farm.coins, 19, '30 − (10 + 1)')

  const incoming = b.snapshot().contracts.incoming[0]
  const recalled = await callAction(b, { action: 'recall-worker', contractId: incoming.id })
  assert.equal(recalled.body.ok, true, JSON.stringify(recalled.body))
  await waitFor(() => a.snapshot().contracts.outgoing[0]?.status === 'ended')
  await waitFor(() => b.snapshot().contracts.incoming[0]?.settled === true)
  await waitFor(() => a.snapshot().farm.coins === 29)
  await waitFor(() => a.room.inboundWorker() === null && b.room.outboundWork() === null)
  assert.equal(b.snapshot().farm.coins, 30)
  assert.equal(a.farmGuard().guard, 0.3)
  assert.equal(b.farmGuard().guard, 0.3)
})

test('校验：不能雇自己、没挂牌/不在家时明确失败；重复点不扣两次钱', async (t) => {
  const { a, b, aId, bId } = await connectedPair(t)
  const own = await callAction(a, { action: 'hire', deviceId: aId, hours: 2 })
  assert.equal(own.body.ok, false)
  assert.equal(own.body.error, 'own-pet')

  const unlisted = await callAction(a, { action: 'hire', deviceId: bId, hours: 2 })
  assert.equal(unlisted.body.ok, false)
  assert.equal(unlisted.body.error, 'worker-unavailable')
  assert.equal(a.snapshot().farm.coins, 30, '失败的雇佣一分不扣')

  await listOn(b)
  await hireFrom(a, b, bId)
  // 家里已经有雇工：再点一次立即 already-hired，不产生第二笔扣款。
  const again = await callAction(a, { action: 'hire', deviceId: bId, hours: 2 })
  assert.equal(again.body.ok, false)
  assert.equal(again.body.error, 'already-hired')
  assert.equal(a.snapshot().farm.coins, 9)
  assert.equal(a.snapshot().contracts.outgoing.length, 1)
})

/**
 * 票 61：合同的时间锚点必须落在**本机**时钟上。
 *
 * work-ack 里的 startedAt/endsAt 是雇工那台机器的绝对时间。雇主如果直接拿来当自己的
 * 到期时刻，倒计时就带着两台的时钟差：雇工时钟快 30 分钟，2 小时的合同在雇主这边显示
 * 「还剩 2 小时 30 分」，到期也比合同晚半小时（反过来则一成交就快到期）。
 * 时长只认自己那份 pending 记录里的 hours。
 */
test('雇工那台机器时钟快 30 分钟：雇主看到的合同时长仍是 2 小时', async (t) => {
  const SKEW_MS = 30 * 60 * 1000
  const { a, b, bId } = await connectedPair(t, { b: { contractNow: () => Date.now() + SKEW_MS } })
  await listOn(b)
  const beforeHireAt = Date.now()
  await hireFrom(a, b, bId)
  await delay(50)

  const outgoing = a.snapshot().contracts.outgoing[0]
  assert.equal(outgoing.status, 'active')
  // 雇主这边的锚点应该是自己的钟：ack 那一刻 ± 几秒，而不是雇工那台机器的 +30 分钟。
  assert.ok(Math.abs(outgoing.startedAt - beforeHireAt) < 10_000,
    '雇主应该用本机时钟当时刻，实际差 ' + (outgoing.startedAt - beforeHireAt) + 'ms')
  assert.equal(outgoing.endsAt - outgoing.startedAt, 2 * 60 * 60 * 1000, '合同时长就是雇的 2 小时')
  const remainingMin = outgoing.remainingMs / 60000
  assert.ok(remainingMin > 118 && remainingMin <= 120,
    '雇主窗口「还剩」应该 ≈120 分钟，实际 ' + remainingMin.toFixed(1) + ' 分钟')
})

// ---------------------------------------------------------------------------
// 票 122：结算跑到一半被关停
// ---------------------------------------------------------------------------

/** 给等待加个上限：闸门等不到就立刻失败，别把整份文件挂死。 */
function withTimeout (promise, ms, message) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    // 故意不 unref：等的这段时间事件循环里可能只剩这一个定时器了。
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 把账本的某个写方法临时接一段闸门：先跑真方法，再卡住。
 * 这样「卡在哪一步」是确定的（不靠 sleep 碰运气），闸门由测试手动放开。
 */
function gateAfter (store, method) {
  let open = null
  const opened = new Promise((resolve) => { open = resolve })
  let arrived = null
  const reached = new Promise((resolve) => { arrived = resolve })
  const original = store[method].bind(store)
  store[method] = async (...args) => {
    const result = await original(...args)
    arrived()
    await opened
    return result
  }
  return { reached, release: () => open() }
}

/** 只在本用例里收集 unhandledRejection（不是生产吞异常，是为了把悬空调用抓成断言）。 */
function collectRejections (t) {
  const seen = []
  const listener = (reason) => { seen.push(reason) }
  process.on('unhandledRejection', listener)
  t.after(() => process.off('unhandledRejection', listener))
  return seen
}

/**
 * 票 122：关停把模块级的 `contracts`/`farm` 置空，可一笔结算要跨好几个 await
 * （写 settling → 入账 → 写 settled）。旧写法恢复执行后还去读模块级变量，于是抛出
 * `Cannot read properties of null (reading 'finishSettle')`——onPeer 里是
 * `void handleWorkSettleAck(packet)`，没人接这个 promise，它就成了用例结束后才炸的
 * unhandledRejection，整份文件跟着 not ok。
 *
 * 雇主侧：卡在「退款已经落盘、settledAt 还没写」这个 WAL 中间点（紧接着就是
 * finishSettle），关停后放开闸门。
 */
test('结算中途关停（雇主侧）：不留悬空调用，也不留半条账', async (t) => {
  const rejections = collectRejections(t)
  const { a, b, bId } = await connectedPair(t)
  await listOn(b, { wagePerHour: 5, minHours: 2, maxHours: 4 })
  await hireFrom(a, b, bId, 2)

  const store = a.contractsStore()
  assert.ok(store, '应该能拿到雇主侧的合同账本')
  const gate = gateAfter(store, 'markRefunded')

  const incoming = b.snapshot().contracts.incoming[0]
  const recalled = await callAction(b, { action: 'recall-worker', contractId: incoming.id })
  assert.equal(recalled.body.ok, true, JSON.stringify(recalled.body))
  await withTimeout(gate.reached, 10_000, '雇主的结算应该走到「退款已落盘」之后')

  const frozen = store.outgoing()[0]
  assert.equal(frozen.refunded, true, '卡住时退款已经落盘')
  assert.equal(frozen.settledAt, null, '卡住时还没写 settledAt')

  a.dispose()
  gate.release()

  // 修复前：恢复执行后读模块级 contracts（已是 null）→ TypeError → unhandledRejection。
  await delay(200)
  assert.deepEqual(rejections.map((error) => String(error)), [], '关停后不该再有悬空调用')
  // 账要么没动，要么写全：退款标记在，settledAt 也得补上（不留半条）。
  await waitFor(() => (store.outgoing()[0]?.settledAt ?? null) !== null, 5000)
  const settled = store.outgoing()[0]
  assert.equal(settled.refunded, true)
  assert.ok(settled.refundAmount > 0, '退款额应该留在账上')
  assert.equal(settled.status, 'ended')
})

/**
 * 雇工侧：卡在「settling 意图已经落盘、还没入账」这个 WAL 中间点（紧接着就是
 * `farm.addCoins`），关停后放开闸门。修复前抛的是 `... (reading 'addCoins')`。
 *
 * 这一单的工时几乎为零，earned 就是 0，farm 的 addCoins(0) 本来就返回 bad-qty——
 * 所以正常跑也不会真的入账，账停 WAL 的 settling 中间点等重试/重启对账收尾。
 * 关停把重试也一并停掉，于是「关停那一刻的账」必须仍可恢复：settling 意图在、
 * 钱一分没动；用同一个 dataDir 重开一台，重启对账要按 fail-closed 把 settledAt 补齐
 * （不重复入账、也不留半条）。
 */
test('结算中途关停（雇工侧）：不留悬空调用，也不留半条账', async (t) => {
  const rejections = collectRejections(t)
  const { a, b, dirB, bId } = await connectedPair(t)
  await listOn(b, { wagePerHour: 5, minHours: 2, maxHours: 4 })
  await hireFrom(a, b, bId, 2)

  const store = b.contractsStore()
  assert.ok(store, '应该能拿到雇工侧的合同账本')
  const gate = gateAfter(store, 'beginSettle')

  const incoming = b.snapshot().contracts.incoming[0]
  const recalled = await callAction(b, { action: 'recall-worker', contractId: incoming.id })
  assert.equal(recalled.body.ok, true, JSON.stringify(recalled.body))
  await withTimeout(gate.reached, 10_000, '雇工的结算应该走到「settling 已落盘」之后')

  const frozen = store.incoming()[0]
  assert.notEqual(frozen.settleStartedAt, null, '卡住时 settling 意图已经落盘')
  assert.equal(frozen.settledAt, null, '卡住时还没结算')

  b.dispose()
  gate.release()

  // 修复前：恢复执行后读模块级 farm（已是 null）→ TypeError → unhandledRejection。
  await delay(200)
  assert.deepEqual(rejections.map((error) => String(error)), [], '关停后不该再有悬空调用')
  const left = store.incoming()[0]
  assert.equal(left.settledAt, null, '关停那一刻：结算标记还没写')
  assert.notEqual(left.settleStartedAt, null, '关停那一刻：settling 意图留在盘上，重启能收尾')
  assert.equal(left.earned, 0, '关停那一刻：钱没动')

  // 同一个 dataDir 重开一台：重启对账按 fail-closed 补 settledAt，不重复入账。
  const again = makeService(t, optionsFor(dirB, 0, 0))
  await again.ready
  const store2 = again.contractsStore()
  assert.ok(store2, '重开的服务也应该有合同账本')
  await waitFor(() => (store2.incoming()[0]?.settledAt ?? null) !== null, 5000)
  const recovered = store2.incoming()[0]
  assert.equal(recovered.status, 'ended')
  assert.equal(recovered.earned, 0, '补齐的是标记，不是再入一次账')
})
