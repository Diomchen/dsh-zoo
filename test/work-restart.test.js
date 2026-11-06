/**
 * 票 44：重启对账（WAL / fail-closed）。
 *
 *   - pending + charged：视为「扣了钱但没成交」——工资与手续费一起退回，合同取消；
 *   - active：恢复 room 镜像（雇工画面、守卫），不重复扣钱；
 *   - settled / settling：绝不重复入账（fail-closed）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CONTRACTS_FILE, CONTRACTS_VERSION } from '../src/contracts.js'
import { FARM_FILE, FARM_VERSION, PLOT_IDS, emptyPlot } from '../src/farm.js'
import { localDayKey } from '../src/farm-rules.js'
import { createService } from '../src/service.js'

const NOW = Date.now()
const HOUR = 3600_000

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor (predicate, timeoutMs = 3000) {
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-work-restart-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeService (t, dir) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktop: false,
    petBridge: false,
    contractStartupGraceMs: 50,
    peerLostMs: 60000
  })
  service.routes = routes
  t.after(() => service.dispose())
  return service
}

function farmFile (coins) {
  const day = localDayKey(NOW)
  return {
    version: FARM_VERSION,
    coins,
    seeds: {},
    crops: {},
    dew: 0,
    dewEarned: 0,
    dewAt: NOW,
    dewDay: day,
    dewDayEarned: day,
    lastTickAt: NOW,
    plots: PLOT_IDS.map(emptyPlot),
    hire: { enabled: false, wagePerHour: 10, minHours: 2, maxHours: 8 },
    log: []
  }
}

function outgoing (overrides = {}) {
  const requestId = randomUUID()
  return {
    id: requestId,
    requestId,
    workerDeviceId: randomUUID(),
    workerNickname: '阿蟹',
    hours: 2,
    wagePerHour: 10,
    wage: 20,
    fee: 1,
    startedAt: NOW,
    endsAt: NOW + 2 * HOUR,
    ackedAt: null,
    status: 'pending',
    earned: 0,
    endedAt: null,
    endReason: null,
    lastSeenAt: NOW,
    charged: true,
    chargedAt: NOW,
    refundStartedAt: null,
    refunded: false,
    refundedAt: null,
    refundAmount: 0,
    settleStartedAt: null,
    settledAt: null,
    settleRequestId: null,
    settleServedMs: 0,
    recallRequested: false,
    recallAcked: false,
    guard: 0.5,
    ...overrides
  }
}

function incoming (overrides = {}) {
  return {
    id: randomUUID(),
    requestId: randomUUID(),
    employerDeviceId: randomUUID(),
    employerNickname: '楼上的柯基',
    hours: 2,
    wagePerHour: 10,
    wage: 20,
    fee: 1,
    startedAt: NOW,
    endsAt: NOW + 2 * HOUR,
    ackedAt: null,
    status: 'active',
    earned: 0,
    endedAt: null,
    endReason: null,
    lastSeenAt: NOW,
    charged: false,
    chargedAt: null,
    refundStartedAt: null,
    refunded: false,
    refundedAt: null,
    refundAmount: 0,
    settleStartedAt: null,
    settledAt: null,
    settleRequestId: null,
    settleServedMs: 0,
    recallRequested: false,
    recallAcked: false,
    guard: 0.5,
    ...overrides
  }
}

async function seed (dir, { coins, outgoing: out = [], incoming: inc = [] }) {
  await writeFile(join(dir, FARM_FILE), JSON.stringify(farmFile(coins)), 'utf8')
  await writeFile(join(dir, CONTRACTS_FILE), JSON.stringify({
    version: CONTRACTS_VERSION,
    outgoing: out,
    incoming: inc
  }), 'utf8')
}

test('pending + charged：重启后退回工资与手续费，合同取消', async (t) => {
  const dir = await tempDir(t)
  await seed(dir, { coins: 9, outgoing: [outgoing()] })
  const service = makeService(t, dir)
  await service.ready
  await waitFor(() => service.snapshot().farm.coins === 30)
  await waitFor(() => service.snapshot().contracts.outgoing[0]?.status === 'cancelled')
  const record = service.snapshot().contracts.outgoing[0]
  assert.equal(record.wage, 20)
  assert.equal(record.fee, 1)
  assert.equal(service.snapshot().farm.coins, 30, '工资 20 + 手续费 1 一起退')
  await delay(200)
  assert.equal(service.snapshot().farm.coins, 30, '只退一次')
})

test('pending 但 charged=false：fail-closed 不退款，只取消', async (t) => {
  const dir = await tempDir(t)
  await seed(dir, { coins: 30, outgoing: [outgoing({ charged: false, chargedAt: null })] })
  const service = makeService(t, dir)
  await service.ready
  await waitFor(() => service.snapshot().contracts.outgoing[0]?.status === 'cancelled')
  assert.equal(service.snapshot().farm.coins, 30)
})

test('active：重启恢复雇工镜像与 0.8 守卫，不重复扣钱', async (t) => {
  const dir = await tempDir(t)
  const record = outgoing({
    status: 'active',
    ackedAt: NOW - 1000,
    lastSeenAt: NOW - 1000,
    endsAt: NOW + HOUR
  })
  await seed(dir, { coins: 9, outgoing: [record] })
  const service = makeService(t, dir)
  await service.ready
  assert.equal(service.snapshot().farm.coins, 9)
  assert.notEqual(service.snapshot().worker, null)
  assert.equal(service.snapshot().worker.workerDeviceId, record.workerDeviceId)
  assert.equal(service.snapshot().farm.worker.contractId, record.id)
  assert.equal(service.snapshot().farm.worker.nickname, '阿蟹')
  assert.equal(service.snapshot().farm.guard, 0.8)
  assert.equal(service.farmGuard().guard, 0.8)
})

test('active incoming：重启恢复在外打工，自家守卫 0', async (t) => {
  const dir = await tempDir(t)
  const record = incoming({ lastSeenAt: NOW - 1000, endsAt: NOW + HOUR })
  await seed(dir, { coins: 30, incoming: [record] })
  const service = makeService(t, dir)
  await service.ready
  assert.equal(service.snapshot().self.work.contractId, record.id)
  assert.equal(service.snapshot().farm.guard, 0)
  assert.equal(service.snapshot().farm.coins, 30)
})

test('settled：重启不再入账（重复结算不双花）', async (t) => {
  const dir = await tempDir(t)
  const record = incoming({
    status: 'ended',
    earned: 10,
    endedAt: NOW - 1000,
    settledAt: NOW - 500,
    endReason: 'employer-end'
  })
  await seed(dir, { coins: 40, incoming: [record] })
  const service = makeService(t, dir)
  await service.ready
  await delay(300)
  assert.equal(service.snapshot().farm.coins, 40)
  assert.equal(service.snapshot().contracts.incoming[0].settled, true)
  assert.equal(service.snapshot().contracts.incoming[0].earned, 10)
})

test('settling 崩溃窗口：按已入账处理，只补 settled 标记', async (t) => {
  const dir = await tempDir(t)
  const record = incoming({
    status: 'ended',
    earned: 10,
    endedAt: NOW - 1000,
    settledAt: null,
    settleStartedAt: NOW - 900,
    settleRequestId: randomUUID(),
    settleServedMs: HOUR,
    endReason: 'employer-end'
  })
  await seed(dir, { coins: 40, incoming: [record] })
  const service = makeService(t, dir)
  await service.ready
  await waitFor(() => service.snapshot().contracts.incoming[0]?.settled === true)
  assert.equal(service.snapshot().farm.coins, 40, 'fail-closed：绝不第二次铸币')
  assert.equal(service.snapshot().contracts.incoming[0].earned, 10)
})

test('refunding 崩溃窗口：按已退款处理，不再退第二次', async (t) => {
  const dir = await tempDir(t)
  const record = outgoing({
    status: 'ended',
    earned: 20,
    endedAt: NOW - 1000,
    endReason: 'employer-end',
    refundStartedAt: NOW - 900,
    refundAmount: 20,
    refunded: false
  })
  await seed(dir, { coins: 9, outgoing: [record] })
  const service = makeService(t, dir)
  await service.ready
  await waitFor(() => service.snapshot().contracts.outgoing[0]?.settled === true)
  assert.equal(service.snapshot().farm.coins, 9, 'refunding 已写过就不再退')
})
