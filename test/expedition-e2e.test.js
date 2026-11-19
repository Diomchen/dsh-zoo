/**
 * 票 112：出远门的 host e2e（本地 HTTP + 假时钟，不联网）。
 *
 * 走玩家路径：看 `/state` → `expedition-start` 扣盘缠 → 假时钟推一段 → `expedition-step`
 * → `expedition-back` 结算 → 硬币/`expedition.json` 对账。全程不 sleep。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { legCoins, routeOf, sumCoins } from '../src/expedition.js'
import { EXPEDITION_FILE } from '../src/expedition-store.js'
import { FARM_FILE } from '../src/farm.js'
import { createService } from '../src/service.js'

const T0 = 1_700_000_000_000

function fakeCtx () {
  const routes = []
  const warnings = []
  return {
    ctx: {
      webServer: {
        register (options) {
          routes.push(options)
          return () => {}
        }
      },
      logger: { info () {}, warn (line) { warnings.push(line) } }
    },
    routes,
    warnings
  }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-expedition-e2e-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

async function seedFarm (dir, coins) {
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins }), 'utf8')
}

function makeService (t, dir, options = {}) {
  const { ctx, routes, warnings } = fakeCtx()
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktop: false,
    petBridge: false,
    tradingFlow: false,
    ...options
  })
  service.routes = routes
  service.warnings = warnings
  t.after(() => service.dispose())
  return service
}

async function call (service, path, { method = 'GET', body } = {}) {
  const route = service.routes.find((candidate) => candidate.path === path)
  assert.ok(route, '应该注册 ' + path)
  const res = {
    statusCode: 0,
    headers: {},
    setHeader (key, value) { this.headers[key] = value },
    end (payload) { this.payload = payload }
  }
  const req = {
    method,
    _listeners: {},
    on (event, fn) {
      this._listeners[event] = fn
      return this
    },
    destroy () {}
  }
  const pending = route.handler(req, res)
  if (body !== undefined) {
    queueMicrotask(() => req._listeners.data?.(Buffer.from(JSON.stringify(body))))
    queueMicrotask(() => req._listeners.end?.())
  }
  await pending
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null }
}

function state (service) {
  return call(service, '/dsh-zoo/state')
}

function action (service, body) {
  return call(service, '/dsh-zoo/action', { method: 'POST', body })
}

async function readExpedition (dir) {
  return JSON.parse(await readFile(join(dir, EXPEDITION_FILE), 'utf8'))
}

test('e2e：出发扣 500 → 走一段 → 继续 → 见好就收，硬币与存档对得上', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const clock = { value: T0 }
  const service = makeService(t, dir, {
    farmNow: () => clock.value,
    expeditionNow: () => clock.value
  })
  await service.ready

  // 1) 还没出门：状态块形状完整，路线只有后山。
  const before = await state(service)
  assert.equal(before.body.farm.coins, 500)
  assert.equal(before.body.expedition.run, null)
  assert.equal(before.body.expedition.coins, 500)
  assert.deepEqual(before.body.expedition.routes.map((route) => route.id), ['backhill'])
  assert.equal(before.body.expedition.routes[0].fare, 500)

  // 2) 出发：盘缠当场扣，run 进 walking。
  const started = await action(service, { action: 'expedition-start', routeId: 'backhill' })
  assert.equal(started.body.ok, true)
  assert.equal(started.body.run.phase, 'walking')
  assert.equal(started.body.run.leg, 1)
  const runId = started.body.run.id
  const totalLegs = started.body.run.totalLegs
  assert.ok(totalLegs === 3 || totalLegs === 4)
  assert.equal((await state(service)).body.farm.coins, 0)

  // 3) away 期间再点出发：拒绝且不再扣钱。
  const twice = await action(service, { action: 'expedition-start', routeId: 'backhill' })
  assert.equal(twice.body.ok, false)
  assert.equal(twice.body.error, 'already-away')
  assert.equal((await state(service)).body.farm.coins, 0)

  // 4) 假时钟走到第一段末尾：tick 掉币、进决策窗。
  assert.equal(await service.expeditionStore().tick(T0 + 20000), true)
  const afterLeg = await state(service)
  assert.equal(afterLeg.body.expedition.run.phase, 'deciding')
  assert.equal(afterLeg.body.expedition.run.leg, 1)
  const firstCoin = legCoins(routeOf('backhill'), runId, 1)
  assert.equal(afterLeg.body.farm.coins, firstCoin)
  assert.deepEqual(afterLeg.body.expedition.run.loot, [{ kind: 'coin', qty: firstCoin }])

  // 5) 继续走：第二段开始。
  clock.value = T0 + 25000
  const stepped = await action(service, { action: 'expedition-step' })
  assert.equal(stepped.body.ok, true)
  assert.equal(stepped.body.run.phase, 'walking')
  assert.equal(stepped.body.run.leg, 2)

  // 6) 第二段到点后见好就收：只带两段的钱，盘缠不退。
  clock.value = T0 + 45000
  assert.equal(await service.expeditionStore().tick(clock.value), true)
  clock.value = T0 + 46000
  const back = await action(service, { action: 'expedition-back' })
  assert.equal(back.body.ok, true)
  assert.equal(back.body.run.ended, 'back')
  assert.equal(back.body.settled.legs, 2)
  assert.equal(back.body.settled.fare, 500)
  const expected = legCoins(routeOf('backhill'), runId, 1) + legCoins(routeOf('backhill'), runId, 2)
  assert.equal(back.body.settled.coins, expected)
  assert.equal((await state(service)).body.farm.coins, expected, '回币就是两段之和，没有重复结算')
  assert.equal((await state(service)).body.expedition.run.phase, null)

  // 7) 存档：折返的趟留在文件里，窗口重开还能看见结果。
  const saved = await readExpedition(dir)
  assert.equal(saved.run.id, runId)
  assert.equal(saved.run.ended, 'back')
  assert.equal(saved.version, 1)
})

test('e2e：走满最后一段自动回家，ended=complete', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const clock = { value: T0 }
  const service = makeService(t, dir, {
    farmNow: () => clock.value,
    expeditionNow: () => clock.value
  })
  await service.ready

  const started = await action(service, { action: 'expedition-start', routeId: 'backhill' })
  const runId = started.body.run.id
  const totalLegs = started.body.run.totalLegs
  const store = service.expeditionStore()

  for (let guard = 0; guard < 10; guard += 1) {
    const snap = store.snapshot().run
    if (snap.ended !== null) break
    clock.value = snap.until
    if (snap.phase === 'walking') assert.equal(await store.tick(clock.value), true)
    else assert.equal((await action(service, { action: 'expedition-step' })).body.ok, true)
  }

  const snap = store.snapshot().run
  assert.equal(snap.ended, 'complete')
  assert.equal(snap.leg, totalLegs)
  assert.equal(snap.loot.length, totalLegs)
  const expected = Array.from({ length: totalLegs }, (_, i) => legCoins(routeOf('backhill'), runId, i + 1)).reduce((a, b) => a + b, 0)
  assert.equal((await state(service)).body.farm.coins, expected)
  assert.equal((await state(service)).body.expedition.run.ended, 'complete')
})

test('e2e：已有串门/打工时开始被拒 already-away；打工结束后能出发', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const clock = { value: T0 }
  const service = makeService(t, dir, {
    farmNow: () => clock.value,
    expeditionNow: () => clock.value
  })
  await service.ready

  const contractId = randomUUID()
  const working = service.room.beginWorking({
    contractId,
    employerDeviceId: randomUUID(),
    employerNickname: '邻居',
    startedAt: T0,
    endsAt: T0 + 3600_000,
    guard: 0
  }, T0)
  assert.equal(working.ok, true, '先把宠物放进打工状态')
  assert.notEqual(service.room.outboundWork(), null)

  const rejected = await action(service, { action: 'expedition-start', routeId: 'backhill' })
  assert.equal(rejected.body.ok, false)
  assert.equal(rejected.body.error, 'already-away')
  assert.equal((await state(service)).body.farm.coins, 500, '被拒时一分钱都不该扣')

  service.room.endWorking(contractId, T0 + 1000)
  const started = await action(service, { action: 'expedition-start', routeId: 'backhill' })
  assert.equal(started.body.ok, true)
})

test('e2e：关掉再开，未完成的那趟能继续（113 才要求只推进一格）', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const clock = { value: T0 }
  const first = makeService(t, dir, {
    farmNow: () => clock.value,
    expeditionNow: () => clock.value
  })
  await first.ready
  const started = await action(first, { action: 'expedition-start', routeId: 'backhill' })
  await first.expeditionStore().tick(T0 + 20000)
  const runId = started.body.run.id
  first.dispose()

  const second = makeService(t, dir, {
    farmNow: () => clock.value,
    expeditionNow: () => clock.value
  })
  await second.ready
  const resumed = await state(second)
  assert.equal(resumed.body.expedition.run.id, runId)
  assert.equal(resumed.body.expedition.run.phase, 'deciding')
  const stepped = await action(second, { action: 'expedition-step' })
  assert.equal(stepped.body.ok, true)
  assert.equal(stepped.body.run.leg, 2)
})

test('e2e：没有桌面层时开窗/刷新回 desktop-off，不抛', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const service = makeService(t, dir, { expeditionNow: () => T0 })
  await service.ready
  const opened = await action(service, { action: 'expedition-open' })
  assert.equal(opened.body.ok, false)
  assert.equal(opened.body.error, 'desktop-off')
  const refreshed = await action(service, { action: 'expedition-refresh' })
  assert.equal(refreshed.body.ok, false)
  assert.equal(refreshed.body.error, 'desktop-off')
})

test('e2e：硬币不足 499 时整趟不开始，状态与存档都干净', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 499)
  const service = makeService(t, dir, { expeditionNow: () => T0 })
  await service.ready
  const result = await action(service, { action: 'expedition-start', routeId: 'backhill' })
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error, 'not-enough-coins')
  const after = await state(service)
  assert.equal(after.body.farm.coins, 499)
  assert.equal(after.body.expedition.run, null)
  assert.equal((await readExpedition(dir)).run, null)
})

test('e2e：未知路线回 no-route', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const service = makeService(t, dir, { expeditionNow: () => T0 })
  await service.ready
  const result = await action(service, { action: 'expedition-start', routeId: 'mine' })
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error, 'no-route')
  assert.equal((await state(service)).body.farm.coins, 500)
})

test('e2e：结算的硬币总数就是 loot 之和', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const service = makeService(t, dir, { expeditionNow: () => T0 })
  await service.ready
  const started = await action(service, { action: 'expedition-start', routeId: 'backhill' })
  const run = service.expeditionStore().snapshot().run
  await service.expeditionStore().tick(run.until)
  const snap = service.expeditionStore().snapshot().run
  assert.equal(sumCoins(snap.loot), legCoins(routeOf('backhill'), started.body.run.id, 1))
})
