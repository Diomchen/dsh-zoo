/**
 * 票 68：季节/节日/来客的 HTTP 集成。
 *
 * 只走 `/dsh-zoo/state` 与 `/dsh-zoo/action`；时间用注入时钟，随机用注入的
 * `farmRandom`。`season.json` 是 sidecar，不要求 `farm.json` 升版本。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFarmStore } from '../src/farm.js'
import { seasonAt } from '../src/season-rules.js'
import { createService } from '../src/service.js'

const AUTUMN = new Date(2026, 10, 17, 12, 0, 0).getTime()

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-season-http-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeService (t, dir, options = {}) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktop: false,
    petBridge: false,
    ...options
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

function action (service, body) {
  return call(service, '/dsh-zoo/action', { method: 'POST', body })
}

function state (service) {
  return call(service, '/dsh-zoo/state')
}

async function seedFarm (dir, now, { crops = {}, coins = 30 } = {}) {
  const store = await createFarmStore(dir, {
    now: () => now,
    market: {
      applyTrade ({ side, cropId, qty }) {
        return { ok: true, total: 0, unit: 0, persisted: true, cropId, qty, side }
      }
    }
  })
  if (coins > 30) await store.addCoins(coins - 30)
  for (const [cropId, qty] of Object.entries(crops)) await store.addCrop(cropId, qty)
}

async function seedSeason (dir, now, { progress = 0, omen = null } = {}) {
  const season = seasonAt(now)
  await writeFile(join(dir, 'season.json'), JSON.stringify({
    version: 1,
    event: {
      start: season.start,
      id: 'autumn-harvest',
      progress: { plant: 0, harvest: progress, sell: 0, water: 0 },
      claimed: false
    },
    omen
  }), 'utf8')
}

test('state：秋天带季节、丰收祭、熊獾；未完成不能领奖', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, dir, { farmNow: () => AUTUMN })
  await service.ready

  const body = (await state(service)).body
  assert.equal(body.farm.season.id, 'autumn')
  assert.equal(body.farm.season.name, '秋')
  assert.equal(body.farm.season.event.id, 'autumn-harvest')
  assert.equal(body.farm.season.event.progress, 0)
  assert.equal(body.farm.season.event.ready, false)
  assert.equal(body.farm.season.omen.id, 'autumn-bearger')
  assert.equal(body.farm.season.omen.canFeed, false)
  assert.equal(body.farm.season.calendar.length, 4)

  const notReady = await action(service, {
    action: 'farm-event-claim',
    expectedStart: body.farm.season.start
  })
  assert.equal(notReady.body.ok, false)
  assert.equal(notReady.body.error, 'event-not-ready')

  const stale = await action(service, {
    action: 'farm-event-claim',
    expectedStart: body.farm.season.start - 1
  })
  assert.equal(stale.body.error, 'stale-season')
})

test('festival：完成后领一次，硬币/露水到账，重复领被拒', async (t) => {
  const dir = await tempDir(t)
  const season = seasonAt(AUTUMN)
  await seedSeason(dir, AUTUMN, { progress: 15 })
  const service = makeService(t, dir, { farmNow: () => AUTUMN })
  await service.ready

  const before = (await state(service)).body.farm
  assert.equal(before.season.event.ready, true)

  const claimed = await action(service, {
    action: 'farm-event-claim',
    expectedStart: season.start
  })
  assert.equal(claimed.body.ok, true)
  assert.equal(claimed.body.action, 'farm-event-claim')
  assert.deepEqual(claimed.body.reward, { coins: 50, dew: 4 })
  assert.match(claimed.body.notice, /丰收祭/)

  const after = (await state(service)).body.farm
  assert.equal(after.coins, 80)
  assert.equal(after.dew, 4)
  assert.equal(after.season.event.claimed, true)
  assert.equal(after.log.at(-1).kind, 'event')

  const again = await action(service, {
    action: 'farm-event-claim',
    expectedStart: season.start
  })
  assert.equal(again.body.ok, false)
  assert.equal(again.body.error, 'event-claimed')
})

test('omen：投喂扣 3 个仓库作物，换 1 颗稻种 + 2 露水；只能结算一次', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, AUTUMN, { crops: { tomato: 3 } })
  const service = makeService(t, dir, { farmNow: () => AUTUMN })
  await service.ready

  const before = (await state(service)).body.farm
  assert.equal(before.season.omen.canFeed, true)

  const fed = await action(service, {
    action: 'farm-omen-resolve',
    choice: 'feed',
    expectedStart: before.season.start
  })
  assert.equal(fed.body.ok, true)
  assert.equal(fed.body.outcome.success, true)
  assert.equal(fed.body.outcome.loss, 0)

  const after = (await state(service)).body.farm
  assert.deepEqual(after.crops, {})
  assert.equal(after.seeds.rice, 1)
  assert.equal(after.dew, 2)
  assert.equal(after.season.omen.resolved, true)
  assert.equal(after.season.omen.choice, 'feed')
  assert.equal(after.log.at(-1).kind, 'omen')

  const again = await action(service, {
    action: 'farm-omen-resolve',
    choice: 'feed',
    expectedStart: before.season.start
  })
  assert.equal(again.body.error, 'omen-resolved')
})

test('omen：守夜失败最多搬 3 个；成功给 40 硬币 + 3 露水', async (t) => {
  const failDir = await tempDir(t)
  await seedFarm(failDir, AUTUMN, { crops: { tomato: 3 } })
  const fail = makeService(t, failDir, { farmNow: () => AUTUMN, farmRandom: () => 0.9 })
  await fail.ready
  const failOmen = (await state(fail)).body.farm.season
  const failed = await action(fail, {
    action: 'farm-omen-resolve',
    choice: 'guard',
    expectedStart: failOmen.start
  })
  assert.equal(failed.body.ok, true)
  assert.equal(failed.body.outcome.success, false)
  assert.equal(failed.body.outcome.loss, 3)
  assert.deepEqual((await state(fail)).body.farm.crops, {})

  const winDir = await tempDir(t)
  await seedFarm(winDir, AUTUMN, {})
  const win = makeService(t, winDir, { farmNow: () => AUTUMN, farmRandom: () => 0.1 })
  await win.ready
  const winOmen = (await state(win)).body.farm.season
  const won = await action(win, {
    action: 'farm-omen-resolve',
    choice: 'guard',
    expectedStart: winOmen.start
  })
  assert.equal(won.body.ok, true)
  assert.equal(won.body.outcome.success, true)
  const after = (await state(win)).body.farm
  assert.equal(after.coins, 70)
  assert.equal(after.dew, 3)
})

test('season.json 落盘：领奖后 claimed=true，且 farm.json 版本不变', async (t) => {
  const dir = await tempDir(t)
  const season = seasonAt(AUTUMN)
  await seedSeason(dir, AUTUMN, { progress: 15 })
  const service = makeService(t, dir, { farmNow: () => AUTUMN })
  await service.ready
  const claimed = await action(service, {
    action: 'farm-event-claim',
    expectedStart: season.start
  })
  assert.equal(claimed.body.ok, true)

  const raw = JSON.parse(await readFile(join(dir, 'season.json'), 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.event.claimed, true)
  assert.equal(raw.event.id, 'autumn-harvest')

  const farm = JSON.parse(await readFile(join(dir, 'farm.json'), 'utf8'))
  assert.equal(farm.version, 1)
})

test('omen：仓库不够投喂时 not-enough-crops，season.json 仍是未处理', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, dir, { farmNow: () => AUTUMN })
  await service.ready
  const before = (await state(service)).body.farm
  assert.equal(before.season.omen.canFeed, false)

  const fed = await action(service, {
    action: 'farm-omen-resolve',
    choice: 'feed',
    expectedStart: before.season.start
  })
  assert.equal(fed.body.ok, false)
  assert.equal(fed.body.error, 'not-enough-crops')
  assert.match(fed.body.notice, /作物/)

  const after = (await state(service)).body.farm
  assert.equal(after.season.omen.resolved, false)
  const raw = JSON.parse(await readFile(join(dir, 'season.json'), 'utf8'))
  assert.equal(raw.omen.resolved, false)
})

test('omen：旧 start 拒绝、坏选择拒绝，且都不写 season.json', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, dir, { farmNow: () => AUTUMN })
  await service.ready
  const season = (await state(service)).body.farm.season
  const before = await readFile(join(dir, 'season.json'), 'utf8')

  const stale = await action(service, {
    action: 'farm-omen-resolve',
    choice: 'guard',
    expectedStart: season.start - 1
  })
  assert.equal(stale.body.error, 'stale-season')

  const bad = await action(service, {
    action: 'farm-omen-resolve',
    choice: 'run',
    expectedStart: season.start
  })
  assert.equal(bad.body.error, 'bad-choice')

  const after = await readFile(join(dir, 'season.json'), 'utf8')
  assert.equal(after, before)
  assert.equal((await state(service)).body.farm.season.omen.resolved, false)
})

test('重启后 season.json 不重复领奖', async (t) => {
  const dir = await tempDir(t)
  const season = seasonAt(AUTUMN)
  await seedSeason(dir, AUTUMN, { progress: 15 })
  const first = makeService(t, dir, { farmNow: () => AUTUMN })
  await first.ready
  const claimed = await action(first, {
    action: 'farm-event-claim',
    expectedStart: season.start
  })
  assert.equal(claimed.body.ok, true)
  first.dispose()

  const second = makeService(t, dir, { farmNow: () => AUTUMN })
  await second.ready
  const body = (await state(second)).body.farm
  assert.equal(body.season.event.claimed, true)
  const again = await action(second, {
    action: 'farm-event-claim',
    expectedStart: season.start
  })
  assert.equal(again.body.ok, false)
  assert.equal(again.body.error, 'event-claimed')
})

test('重启后 season.json 不重复结算来客', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, AUTUMN, { crops: { tomato: 3 } })
  const first = makeService(t, dir, { farmNow: () => AUTUMN })
  await first.ready
  const before = (await state(first)).body.farm.season
  const fed = await action(first, {
    action: 'farm-omen-resolve',
    choice: 'feed',
    expectedStart: before.start
  })
  assert.equal(fed.body.ok, true)
  first.dispose()

  const second = makeService(t, dir, { farmNow: () => AUTUMN })
  await second.ready
  const body = (await state(second)).body.farm
  assert.equal(body.season.omen.resolved, true)
  assert.equal(body.season.omen.choice, 'feed')
  const again = await action(second, {
    action: 'farm-omen-resolve',
    choice: 'feed',
    expectedStart: before.start
  })
  assert.equal(again.body.ok, false)
  assert.equal(again.body.error, 'omen-resolved')
})
