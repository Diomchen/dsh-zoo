/**
 * 票 119：出远门的出门互斥与看家失效。
 *
 * 走 service 动作层（和 112 的 e2e 同一套假时钟/临时目录），只断言玩家看得见的东西：
 * 报什么错、硬币动没动、守卫多少、家里有没有多出半个访客/合同。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FARM_FILE } from '../src/farm.js'
import { OWNER_GUARD } from '../src/farm-rules.js'
import { farmErrorText } from '../src/farm-text.js'
import { VISIT_DENY_REASONS } from '../src/protocol.js'
import { createService } from '../src/service.js'
import { isVisitReason, visitReasonText } from '../src/visit-copy.js'

const T0 = 1_700_000_000_000
const PEER = '11111111-1111-4111-8111-111111111111'

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-expedition-away-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

async function seedFarm (dir, coins) {
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins }), 'utf8')
}

function makeService (t, dir, clock) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktop: false,
    petBridge: false,
    tradingFlow: false,
    farmNow: () => clock.value,
    expeditionNow: () => clock.value
  })
  service.routes = routes
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

/** 邻居要真在放行名单里、心跳也来过：入站串门才会走到「家里有没有人」这一步。 */
function admitPeer (room) {
  room.observeBeacon({ deviceId: PEER, nickname: '甲', port: 40001 }, T0)
  assert.equal(room.admit(PEER).ok, true)
  assert.equal(room.observeHeartbeat({ deviceId: PEER, anim: null }, T0), true)
}

async function startExpedition (service) {
  const started = await action(service, { action: 'expedition-start', routeId: 'backhill' })
  assert.equal(started.body.ok, true, JSON.stringify(started.body))
  assert.equal(started.body.run.phase, 'walking')
  return started.body.run
}

/** 把这一趟走完（继续/折返都行），让 run.phase 回到 null。 */
async function finishExpedition (service, clock) {
  const store = service.expeditionStore()
  for (let guard = 0; guard < 10; guard += 1) {
    const run = store.snapshot().run
    if (run === null || run.ended !== null) return run
    clock.value = run.until
    if (run.phase === 'walking') await store.tick(clock.value)
    else await action(service, { action: 'expedition-back' })
  }
  throw new Error('这一趟没有在十步内走完')
}

test('出门中 hire 报 already-away：不扣钱、不留下半份合同', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 1000)
  const clock = { value: T0 }
  const service = makeService(t, dir, clock)
  await service.ready

  await startExpedition(service)
  const coins = (await state(service)).body.farm.coins

  const hired = await action(service, { action: 'hire', deviceId: PEER, hours: 2 })
  assert.equal(hired.body.ok, false)
  assert.equal(hired.body.error, 'already-away')
  assert.equal((await state(service)).body.farm.coins, coins, '被拒时一枚硬币都不该动')
  assert.deepEqual(service.snapshot().contracts.outgoing, [], '不该留下 pending 合同')

  // 窗口显示的是人话，不是英文 code。
  const text = farmErrorText('already-away')
  assert.equal(typeof text, 'string')
  assert.ok(!text.includes('already-away'))
})

test('出门中发起串门报 already-away，不产生半个访问状态', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 1000)
  const clock = { value: T0 }
  const service = makeService(t, dir, clock)
  await service.ready

  await startExpedition(service)

  const visit = await action(service, { action: 'visit', deviceId: PEER })
  assert.equal(visit.body.ok, false)
  assert.equal(visit.body.error, 'already-away')
  assert.equal(visit.body.notice, visitReasonText('already-away'))
  assert.equal(service.room.outboundVisit(), null, '不该留下走到一半的出门状态')
  assert.deepEqual(service.room.snapshot().visitors, [])

  // 串门原因表也要认这个码，否则桌面按钮/气泡只能显示兜底句。
  assert.equal(isVisitReason('already-away'), true)
})

test('串门中发起出远门同样报 already-away，盘缠一分不扣', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 1000)
  const clock = { value: T0 }
  const service = makeService(t, dir, clock)
  await service.ready

  admitPeer(service.room)
  const begun = service.room.beginVisit(PEER, { at: T0, visitId: randomUUID() })
  assert.equal(begun.ok, true, '先把宠物放进串门状态')

  const rejected = await action(service, { action: 'expedition-start', routeId: 'backhill' })
  assert.equal(rejected.body.ok, false)
  assert.equal(rejected.body.error, 'already-away')
  assert.equal((await state(service)).body.farm.coins, 1000)
  assert.equal((await state(service)).body.expedition.run, null)
})

test('出门时看家掉到无守卫，回家后回到 0.3', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 1000)
  const clock = { value: T0 }
  const service = makeService(t, dir, clock)
  await service.ready

  assert.equal((await state(service)).body.farm.guard, OWNER_GUARD)

  await startExpedition(service)
  assert.equal((await state(service)).body.farm.guard, 0, '主人不在家，看家只剩雇工那部分')
  assert.equal((await state(service)).body.expedition.away, 'expedition')

  await finishExpedition(service, clock)
  const home = await state(service)
  assert.equal(home.body.farm.guard, OWNER_GUARD, '回家后看家立刻恢复')
  assert.equal(home.body.expedition.away, null)
})

test('回家后串门与雇工都能重新发起', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 1000)
  const clock = { value: T0 }
  const service = makeService(t, dir, clock)
  await service.ready

  await startExpedition(service)
  await finishExpedition(service, clock)

  const visit = await action(service, { action: 'visit', deviceId: PEER })
  assert.notEqual(visit.body.error, 'already-away')
  const hired = await action(service, { action: 'hire', deviceId: PEER, hours: 2 })
  assert.notEqual(hired.body.error, 'already-away')
})

test('出门时邻居来串门被拒 already-away，回执是人话且不建访客', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 1000)
  const clock = { value: T0 }
  const service = makeService(t, dir, clock)
  await service.ready

  admitPeer(service.room)
  await startExpedition(service)

  const visitId = randomUUID()
  const denied = service.room.observeVisitRequest({ deviceId: PEER, visitId }, T0 + 1000)
  assert.equal(denied.reply, 'deny')
  assert.equal(denied.reason, 'already-away')
  assert.deepEqual(service.room.snapshot().visitors, [], '被拒的请求不该留下访客')
  assert.equal((await state(service)).body.farm.coins, 500, '拒收不涉及硬币')

  // 拒绝理由要走协议枚举，否则对面整包丢弃，只能等到超时。
  assert.ok(VISIT_DENY_REASONS.includes('already-away'))
  assert.equal(typeof visitReasonText('already-away', '甲'), 'string')
  assert.ok(!visitReasonText('already-away', '甲').includes('already-away'))
})

test('出门时邻居来雇它打工同样被拒，不产生合同也不扣钱', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 1000)
  const clock = { value: T0 }
  const service = makeService(t, dir, clock)
  await service.ready

  await startExpedition(service)

  // work-request 的入站校验走同一个 away 判定：宠物在外，接不了活。
  const reply = service.room.incomingWorkError()
  assert.equal(reply, 'worker-unavailable')
  assert.deepEqual(service.snapshot().contracts.incoming, [])
})

test('收到 already-away 的拒绝回执，发起方看到的也是人话', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 1000)
  const clock = { value: T0 }
  const service = makeService(t, dir, clock)
  await service.ready

  admitPeer(service.room)
  const visitId = randomUUID()
  assert.equal(service.room.beginVisit(PEER, { at: T0, visitId }).ok, true)

  const denied = service.room.observeVisitDeny(
    { deviceId: PEER, visitId, reason: 'already-away' },
    T0 + 1000
  )
  assert.equal(denied.ok, true)
  assert.equal(denied.error, 'already-away', '不能被塌成 peer-offline/denied')
  assert.equal(denied.notice, visitReasonText('already-away', '甲'))
  assert.equal(service.room.outboundVisit(), null)
})
