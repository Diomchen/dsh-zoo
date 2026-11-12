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
  // 雇佣前记下墙钟：A 的 farm.json 还没有写过时，用时间下界验证「雇佣重置待机」。
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

  // 雇佣也是一次农场动作：待机锚点被推到点击那一刻。
  const afterHire = JSON.parse(await readFile(join(dirA, FARM_FILE), 'utf8'))
  assert.ok(afterHire.dewAt >= beforeHireAt + 20, '雇佣重置待机计时（dewAt 被推到点击那一刻）')

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
