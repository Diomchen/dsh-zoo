/**
 * 票 27：状态出口。
 * `/dsh-zoo/state` 在 room 快照之外多两项：backpack 与 gifts。
 * 两个字段任何时候都是数组；gifts 只列最近 20 件、最新在前，带 path 与 status。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createGiftStore } from '../src/gifts.js'
import { STATE_GIFT_LIMIT, createService } from '../src/service.js'

const T0 = 1_700_000_000_000
const PEER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-state-'))
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
    petBridge: false
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

function note (id, text, receivedAt) {
  return {
    id,
    from: { deviceId: PEER, nickname: '楼下的柯基' },
    text,
    receivedAt
  }
}

test('/state：backpack / gifts 始终是数组；gifts 最近 20 条、最新在前、带 path 与 status', async (t) => {
  const dir = await tempDir(t)
  const ids = []
  const store = await createGiftStore(dir, { log: { warn () {} } })
  for (let index = 0; index < STATE_GIFT_LIMIT + 1; index += 1) {
    const id = '00000000-0000-4000-8000-' + String(index).padStart(12, '0')
    ids.push(id)
    assert.equal((await store.receiveText(note(id, '第 ' + index + ' 张便条', T0 + index * 1000))).ok, true)
  }

  const service = makeService(t, dir)
  // 还没 ready 时也得是数组：store 尚未初始化，字段不能是 undefined。
  const early = await call(service, '/dsh-zoo/state')
  assert.equal(early.status, 200)
  assert.deepEqual(early.body.backpack, [])
  assert.deepEqual(early.body.gifts, [])

  await service.ready
  const state = await call(service, '/dsh-zoo/state')
  assert.equal(state.status, 200)
  assert.deepEqual(state.body.backpack, [])
  assert.equal(Array.isArray(state.body.gifts), true)
  assert.equal(state.body.gifts.length, STATE_GIFT_LIMIT, '只列最近 20 条')
  assert.equal(state.body.gifts[0].id, ids[STATE_GIFT_LIMIT], '最新在前')
  assert.equal(state.body.gifts.at(-1).id, ids[1], '第 0 条被挤出去')
  assert.deepEqual(state.body.gifts[0], {
    id: ids[STATE_GIFT_LIMIT],
    from: { deviceId: PEER, nickname: '楼下的柯基' },
    kind: 'text',
    at: T0 + STATE_GIFT_LIMIT * 1000,
    status: 'received',
    path: state.body.gifts[0].path
  })
  assert.match(state.body.gifts[0].path, /gifts[\\/].+[\\/]note\.txt$/)
  assert.equal('text' in state.body.gifts[0], false, '状态出口不搬运字条正文')
})

test('/state：bring 之后 backpack 出现 FIFO 顺序的条目；service.snapshot() 与路由一致', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, dir)
  await service.ready

  const first = await call(service, '/dsh-zoo/action', {
    method: 'POST',
    body: { action: 'bring', gift: { kind: 'text', text: '先放的' } }
  })
  assert.equal(first.status, 200)
  const second = await call(service, '/dsh-zoo/action', {
    method: 'POST',
    body: { action: 'bring', gift: { kind: 'text', text: '后放的' } }
  })
  assert.equal(second.status, 200)

  const state = await call(service, '/dsh-zoo/state')
  assert.equal(state.body.backpack.length, 2)
  assert.deepEqual(state.body.backpack.map((item) => item.text), ['先放的', '后放的'])
  for (const item of state.body.backpack) {
    assert.deepEqual(Object.keys(item).sort(), ['at', 'id', 'kind', 'state', 'text'])
    assert.equal(item.state, 'idle')
  }
  assert.deepEqual(service.snapshot().backpack, state.body.backpack)
  assert.deepEqual(service.snapshot().gifts, state.body.gifts)
})

test('ticket 44：/state.contracts 始终是完整空形状；farm.guard/worker 来自唯一守卫计算点', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, dir)
  // store 还没起来也不能是 undefined。
  const early = await call(service, '/dsh-zoo/state')
  assert.deepEqual(early.body.contracts, { outgoing: [], incoming: [] })
  assert.equal(early.body.farm.guard, 0.3)
  assert.equal(early.body.farm.worker, null)
  assert.equal(early.body.self.work, null)
  assert.equal(early.body.worker, null)

  await service.ready
  const state = await call(service, '/dsh-zoo/state')
  assert.deepEqual(state.body.contracts, { outgoing: [], incoming: [] })
  assert.equal(state.body.farm.guard, 0.3)
  assert.equal(state.body.farm.worker, null)
  assert.equal(state.body.farm.hire.enabled, false)
  assert.deepEqual(service.snapshot().contracts, state.body.contracts)
  assert.deepEqual(Object.keys(state.body.contracts).sort(), ['incoming', 'outgoing'])
})

test('ticket 45：/state 的 farm / market / contracts 形状与 docs/protocol.md 一致', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, dir)
  await service.ready

  const state = await call(service, '/dsh-zoo/state')
  assert.equal(state.status, 200)
  assert.deepEqual(Object.keys(state.body.farm).sort(), [
    'coins', 'crops', 'dew', 'dewEarned', 'guard', 'hire', 'log', 'maxPlots', 'nextCost',
    'plots', 'seeds', 'unlocked', 'worker'
  ])
  assert.deepEqual(Object.keys(state.body.farm.plots[0]).sort(), [
    'crop', 'fertilized', 'growMs', 'grownMs', 'helpedBy', 'id', 'plantedAt', 'stolenBy', 'waterings'
  ])
  assert.deepEqual(Object.keys(state.body.farm.hire).sort(), ['enabled', 'maxHours', 'minHours', 'wagePerHour'])
  assert.deepEqual(Object.keys(state.body.market).sort(), ['history', 'index', 'prices'])
  assert.deepEqual(Object.keys(state.body.market.prices.tomato).sort(), ['at', 'base', 'price', 'volume24h'])
  assert.deepEqual(state.body.market.history, [])
  assert.deepEqual(state.body.contracts, { outgoing: [], incoming: [] })
})
