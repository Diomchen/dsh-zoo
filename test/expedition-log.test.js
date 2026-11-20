/**
 * 票 116：出远门的旅行日志。
 *
 * 覆盖：
 *   1. 规则层纯函数：四种结局的标题/正文模板、翻车丢件、超时那句「没等到你，自己回来了」；
 *   2. 存档：每趟结束落一篇日志、最多 30 篇（超出丢最旧）、读档不重复记；
 *   3. 宿主：农场窗只拿最近三篇标题，正文不出窗口；
 *   4. 小窗与农场页的接线：日志页签画全文，农场页细条在 `#batch-bar` 上方。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { appendTripLog, legsFor, normalizeTripLogs, routeOf, TRIP_LOG_LIMIT, tripLog, wipedOut } from '../src/expedition.js'
import { EXPEDITION_FILE, createExpeditionStore } from '../src/expedition-store.js'
import { FARM_FILE } from '../src/farm.js'
import { createService } from '../src/service.js'

const require = createRequire(import.meta.url)
const expeditionView = require('../desktop/expedition-view.js')

const T0 = 1_700_000_000_000

/** 一趟走完的 run：默认是见好就收走了 2 段，loot 里两枚硬币 + 两件特产。 */
function trip (overrides = {}) {
  return {
    id: 'run-1',
    routeId: 'backhill',
    phase: null,
    leg: 2,
    totalLegs: 4,
    until: null,
    loot: [
      { kind: 'coin', qty: 15 },
      { kind: 'souvenir', id: 'herb' },
      { kind: 'coin', qty: 14 },
      { kind: 'souvenir', id: 'pinecone' }
    ],
    startedAt: T0 - 100_000,
    ended: 'back',
    endedAt: T0,
    reason: null,
    ...overrides
  }
}

test('日志：四种结局各有一句固定标题，正文按路线/段数/掉落拼', () => {
  const back = tripLog(trip())
  assert.deepEqual(back, {
    at: T0,
    routeId: 'backhill',
    legs: 2,
    title: '从后山折返，走了 2 段',
    body: '交 500 枚盘缠去后山，走了 2 段就折返，路上捡到草药、松果，带回 29 枚硬币。',
    ended: 'back',
    reason: null
  })

  const complete = tripLog(trip({ ended: 'complete', leg: 4, totalLegs: 4 }))
  assert.equal(complete.title, '走满后山，4 段全程')
  assert.equal(complete.body, '交 500 枚盘缠去后山，4 段全程走完，路上捡到草药、松果，带回 29 枚硬币。')

  const timeout = tripLog(trip({ reason: 'timeout' }))
  assert.equal(timeout.title, '在后山超时，它自己回来了')
  assert.equal(
    timeout.body,
    '交 500 枚盘缠去后山，走了 2 段，路上捡到草药、松果，带回 29 枚硬币。20 秒没等到你，自己回来了。'
  )

  const wipeout = tripLog(trip({
    ended: 'failed',
    reason: 'wipeout',
    leg: 2,
    loot: [{ kind: 'coin', qty: 15 }, { kind: 'coin', qty: 14 }, { kind: 'souvenir', id: 'herb' }]
  }), {
    before: trip()
  })
  assert.equal(wipeout.title, '在后山翻车，只走了 2 段')
  assert.equal(
    wipeout.body,
    '交 500 枚盘缠去后山，走了 2 段就翻了车，路上捡到草药，带回 29 枚硬币。翻车时丢了松果。'
  )
})

test('日志：同一结局换一趟，正文跟着段数与掉落变；翻车不写随机数', () => {
  const short = tripLog(trip({ leg: 1, loot: [{ kind: 'coin', qty: 12 }] }))
  assert.equal(short.title, '从后山折返，走了 1 段')
  assert.equal(short.body, '交 500 枚盘缠去后山，走了 1 段就折返，路上没捡到特产，带回 12 枚硬币。')

  const complete = tripLog(trip({ ended: 'complete', leg: 4, loot: [{ kind: 'coin', qty: 60 }] }))
  assert.equal(complete.body, '交 500 枚盘缠去后山，4 段全程走完，路上没捡到特产，带回 60 枚硬币。')

  const wipeout = tripLog(trip({
    ended: 'failed',
    reason: 'wipeout',
    loot: [{ kind: 'coin', qty: 15 }, { kind: 'souvenir', id: 'herb' }]
  }), { before: trip({ loot: [{ kind: 'coin', qty: 15 }, { kind: 'souvenir', id: 'herb' }] }) })
  assert.equal(wipeout.body, '交 500 枚盘缠去后山，走了 2 段就翻了车，路上捡到草药，带回 15 枚硬币。翻车时特产一件没丢。')
  assert.doesNotMatch(wipeout.body, /\d+(?:\.\d+)?\s*%/, '正文里不该出现概率数字')
})

test('日志：没结束的趟、坏形状、未知原因都不记', () => {
  assert.equal(tripLog(trip({ ended: null, phase: 'walking' })), null)
  assert.equal(tripLog(trip({ routeId: 'moon' })), null)
  assert.equal(tripLog(trip({ reason: 'wipeout' })), null, '折返不会是 wipeout')
  assert.equal(tripLog(null), null)
})

test('日志：新的一篇在最前，超过 30 篇丢最旧的', () => {
  let logs = []
  for (let index = 0; index < TRIP_LOG_LIMIT + 2; index += 1) {
    logs = appendTripLog(logs, { at: T0 + index, title: '第 ' + String(index) + ' 篇' })
  }
  assert.equal(logs.length, TRIP_LOG_LIMIT)
  assert.equal(logs[0].title, '第 31 篇')
  assert.equal(logs.at(-1).title, '第 2 篇')
  assert.equal(appendTripLog(null, { at: T0, title: '只有一篇' }).length, 1)
})

test('日志：读档只留下形状对的篇目，并按上限截断', () => {
  const raw = [
    { at: T0 + 1, routeId: 'backhill', legs: 2, title: '标题', body: '正文', ended: 'back', reason: null },
    { at: 'x', routeId: 'backhill', legs: 2, title: '坏', body: '坏', ended: 'back', reason: null },
    { at: T0, routeId: 'nowhere', legs: 2, title: '坏', body: '坏', ended: 'back', reason: null },
    { at: T0, routeId: 'backhill', legs: 0, title: '坏', body: '坏', ended: 'back', reason: null },
    'not-an-object',
    { at: T0 - 1, routeId: 'backhill', legs: 1, title: '旧', body: '旧正文', ended: 'failed', reason: 'wipeout', extra: '丢掉' }
  ]
  const logs = normalizeTripLogs(raw)
  assert.deepEqual(logs, [
    { at: T0 + 1, routeId: 'backhill', legs: 2, title: '标题', body: '正文', ended: 'back', reason: null },
    { at: T0 - 1, routeId: 'backhill', legs: 1, title: '旧', body: '旧正文', ended: 'failed', reason: 'wipeout' }
  ])
  assert.deepEqual(normalizeTripLogs('nope'), [])
  assert.deepEqual(normalizeTripLogs(Array.from({ length: 40 }, (_, index) => ({
    at: T0 + index, routeId: 'backhill', legs: 1, title: 't', body: 'b', ended: 'back', reason: null
  }))).length, TRIP_LOG_LIMIT)
})

// ---------------------------------------------------------------- 存档 ----------

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-trip-log-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 只实现出远门用到的两件事，与 test/expedition-store.test.js 同一套边界。 */
function fakeFarm (coins) {
  const state = { coins }
  return {
    state,
    async spendCoins (qty) {
      if (state.coins < qty) return { ok: false, error: 'no-coin' }
      state.coins -= qty
      return { ok: true, qty, coins: state.coins }
    },
    async addCoins (qty) {
      state.coins += qty
      return { ok: true, qty, coins: state.coins }
    }
  }
}

async function readState (dir) {
  return JSON.parse(await readFile(join(dir, EXPEDITION_FILE), 'utf8'))
}

/** 挑一个「走这几段都不翻车」的 runId，避免骰子搅红日志断言。 */
function safeRunId (legs = 4) {
  const route = routeOf('backhill')
  for (let i = 0; i < 2000; i += 1) {
    const id = 'log-safe-' + i
    if (legsFor(route, id) < legs) continue
    let clean = true
    for (let leg = 2; leg <= legs; leg += 1) {
      if (wipedOut({ id, routeId: 'backhill' }, leg)) clean = false
    }
    if (clean) return id
  }
  throw new Error('没有找到一路平安的 runId')
}

/** 挑一个在第 `leg` 段必定翻车的 runId。 */
function doomedRunId (leg = 2) {
  for (let i = 0; i < 2000; i += 1) {
    const id = 'log-doomed-' + i
    if (wipedOut({ id, routeId: 'backhill' }, leg)) return id
  }
  throw new Error('没有找到会翻车的 runId')
}

/** 出发 → 走 `legs` 段 → 停在最后一个决策窗；返回到点时刻。 */
async function walkLegs (store, now, legs = 2) {
  const started = await store.start({ routeId: 'backhill' })
  assert.equal(started.ok, true)
  let at = now
  for (let leg = 1; leg <= legs; leg += 1) {
    at += 20000
    assert.equal(await store.tick(at), true)
    const run = store.snapshot().run
    assert.equal(run.phase, 'deciding')
    assert.equal(run.leg, leg)
    if (leg < legs) {
      at += 1000
      const stepped = await store.step(at)
      assert.equal(stepped.ok, true)
    }
  }
  return at
}

test('存档：见好就收落一篇日志，快照与磁盘一致', async (t) => {
  const dir = await tempDir(t)
  const store = await createExpeditionStore(dir, { farm: fakeFarm(600), now: () => T0, newRunId: () => safeRunId(2) })
  const at = await walkLegs(store, T0, 2)
  const back = await store.back(at + 1000)
  assert.equal(back.ok, true)

  const snap = store.snapshot()
  assert.equal(snap.logs.length, 1)
  assert.equal(snap.logs[0].title, '从后山折返，走了 2 段')
  assert.equal(snap.logs[0].ended, 'back')
  assert.equal(snap.logs[0].reason, null)
  assert.match(snap.logs[0].body, /^交 500 枚盘缠去后山，走了 2 段就折返，路上/)
  assert.match(snap.logs[0].body, /带回 \d+ 枚硬币。$/)
  assert.deepEqual((await readState(dir)).logs, snap.logs, '日志要跟着 run 一起落盘')
})

test('存档：翻车写一篇 wipeout 日志，正文写清丢了哪几件', async (t) => {
  const dir = await tempDir(t)
  const store = await createExpeditionStore(dir, { farm: fakeFarm(600), now: () => T0, newRunId: () => doomedRunId(2) })
  const at = await walkLegs(store, T0, 1)
  const stepped = await store.step(at + 1000)
  assert.equal(stepped.ok, true)
  assert.equal(stepped.run.ended, 'failed')

  const log = store.snapshot().logs[0]
  assert.equal(log.ended, 'failed')
  assert.equal(log.reason, 'wipeout')
  assert.equal(log.title, '在后山翻车，只走了 1 段')
  assert.match(log.body, /翻车时(丢了[^。]+|特产一件没丢)。$/)
})

test('存档：走满写 complete，超时写 timeout 并带上那句「自己回来了」', async (t) => {
  const completeDir = await tempDir(t)
  const completeStore = await createExpeditionStore(completeDir, {
    farm: fakeFarm(600), now: () => T0, newRunId: () => safeRunId(4)
  })
  let now = T0
  await completeStore.start({ routeId: 'backhill' })
  for (let guard = 0; guard < 10; guard += 1) {
    const run = completeStore.snapshot().run
    if (run.ended !== null) break
    now = run.until
    if (run.phase === 'walking') await completeStore.tick(now)
    else await completeStore.step(now)
  }
  const complete = completeStore.snapshot().logs[0]
  assert.equal(complete.ended, 'complete')
  assert.equal(complete.reason, null)
  assert.match(complete.title, /^走满后山，\d 段全程$/)
  assert.match(complete.body, /段全程走完，/)

  const timeoutDir = await tempDir(t)
  const timeoutStore = await createExpeditionStore(timeoutDir, {
    farm: fakeFarm(600), now: () => T0, newRunId: () => safeRunId(2)
  })
  const at = await walkLegs(timeoutStore, T0, 2)
  assert.equal(await timeoutStore.tick(at + 20000), true)
  const timeout = timeoutStore.snapshot().logs[0]
  assert.equal(timeout.ended, 'back')
  assert.equal(timeout.reason, 'timeout')
  assert.equal(timeout.title, '在后山超时，它自己回来了')
  assert.match(timeout.body, /20 秒没等到你，自己回来了。$/)
})

test('存档：日志最多 30 篇，第 31 趟把最旧那篇挤掉', async (t) => {
  const dir = await tempDir(t)
  const store = await createExpeditionStore(dir, { farm: fakeFarm(TRIP_LOG_LIMIT * 500 + 500), now: () => T0, newRunId: () => safeRunId(2) })
  const ends = []
  let now = T0
  for (let round = 0; round < TRIP_LOG_LIMIT + 1; round += 1) {
    const at = await walkLegs(store, now, 2)
    const back = await store.back(at + 1000)
    assert.equal(back.ok, true)
    ends.push(back.run.endedAt)
    now += 60000
  }
  const logs = store.snapshot().logs
  assert.equal(logs.length, TRIP_LOG_LIMIT)
  assert.equal(logs[0].at, ends.at(-1), '最新一趟在最前')
  assert.equal(logs.at(-1).at, ends[1], '最旧的那趟被挤掉')
  assert.equal((await readState(dir)).logs.length, TRIP_LOG_LIMIT)
})

test('存档：重启不重复记账；离线期间超时的趟补一篇 timeout', async (t) => {
  const dir = await tempDir(t)
  const first = await createExpeditionStore(dir, { farm: fakeFarm(600), now: () => T0, newRunId: () => safeRunId(2) })
  const at = await walkLegs(first, T0, 2)
  await first.back(at + 1000)
  first.dispose()

  const second = await createExpeditionStore(dir, { farm: fakeFarm(0), now: () => T0 + 30000 })
  assert.equal(second.snapshot().logs.length, 1, '读档不能把同一趟再记一遍')
  second.dispose()

  const third = await createExpeditionStore(dir, { farm: fakeFarm(600), now: () => T0 + 60000, newRunId: () => safeRunId(2) })
  await walkLegs(third, T0 + 60000, 2)
  third.dispose()

  const fourth = await createExpeditionStore(dir, { farm: fakeFarm(0), now: () => T0 + 7200000 })
  const logs = fourth.snapshot().logs
  assert.equal(logs.length, 2)
  assert.equal(logs[0].ended, 'back')
  assert.equal(logs[0].reason, 'timeout', '离线到点的那趟补的是超时日志')
  assert.equal(fourth.snapshot().run.ended, 'back')
  fourth.dispose()
})

// ------------------------------------------------------------ 宿主与白名单 ----------

const SEEDED_LOGS = [
  { at: T0 + 4000, routeId: 'backhill', legs: 4, title: '走满后山，4 段全程', body: '正文一：捡到草药、松果。', ended: 'complete', reason: null },
  { at: T0 + 3000, routeId: 'backhill', legs: 2, title: '在后山翻车，只走了 2 段', body: '正文二：翻车时丢了松果。', ended: 'failed', reason: 'wipeout' },
  { at: T0 + 2000, routeId: 'backhill', legs: 2, title: '在后山超时，它自己回来了', body: '正文三：20 秒没等到你，自己回来了。', ended: 'back', reason: 'timeout' },
  { at: T0 + 1000, routeId: 'backhill', legs: 1, title: '从后山折返，走了 1 段', body: '正文四：只走了一段。', ended: 'back', reason: null }
]

/** 直接把日志写进存档：这几条用例关心的是「宿主怎么下发」，不是怎么产生的。 */
async function seedLogs (dir, logs = SEEDED_LOGS) {
  await writeFile(join(dir, EXPEDITION_FILE), JSON.stringify({
    version: 1, run: null, shelf: { slots: 8, items: [] }, codex: {}, upgrades: { lantern: false }, logs
  }), 'utf8')
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

function callAction (service, body) {
  return call(service, '/dsh-zoo/action', { method: 'POST', body })
}

/** 同时记农场窗与出远门窗的桌面替身。 */
function desktopDouble () {
  const calls = { farm: [], expedition: [] }
  let onEvent = null
  return {
    calls,
    factory (factoryOptions) {
      onEvent = factoryOptions.onEvent
      return {
        start () { return { ok: true, pid: 4242 } },
        update () { return true },
        resync () { return true },
        status () { return { ready: true, farmOpen: false, expeditionOpen: false } },
        farmWindow (payload) { calls.farm.push(payload); return true },
        expeditionWindow (payload) { calls.expedition.push(payload); return true },
        bringWindow () { return true },
        lastCommandFailure () { return null },
        actionResult () {},
        dispose () {}
      }
    },
    ready (workArea = { x: 0, y: 30, width: 1000, height: 700 }) {
      onEvent?.({ type: 'ready', pid: 4242, workArea, displays: [{ id: 1, bounds: workArea, workArea, scaleFactor: 1, primary: true }] })
    }
  }
}

async function makeService (t, dir) {
  const { ctx, routes } = fakeCtx()
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins: 620 }), 'utf8')
  const desktop = desktopDouble()
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    petBridge: false,
    skinServer: false,
    desktopFactory: desktop.factory,
    farmNow: () => T0,
    expeditionNow: () => T0
  })
  service.routes = routes
  t.after(() => service.dispose())
  await service.ready
  desktop.ready()
  return { service, desktop }
}

test('宿主：农场窗只拿最近三篇标题，正文一个字都不下发', async (t) => {
  const dir = await tempDir(t)
  await seedLogs(dir)
  const { service, desktop } = await makeService(t, dir)

  const opened = await callAction(service, { action: 'farm-open' })
  assert.equal(opened.status, 200)
  const farm = desktop.calls.farm.at(-1).farm
  assert.deepEqual(farm.expeditionLog, {
    titles: ['走满后山，4 段全程', '在后山翻车，只走了 2 段', '在后山超时，它自己回来了']
  })
  assert.equal(JSON.stringify(farm).includes('正文'), false, '农场页拿不到日志正文')
})

test('宿主：出远门窗口拿到全部日志与正文', async (t) => {
  const dir = await tempDir(t)
  await seedLogs(dir)
  const { service, desktop } = await makeService(t, dir)

  const opened = await callAction(service, { action: 'expedition-open' })
  assert.equal(opened.status, 200)
  const state = desktop.calls.expedition.at(-1).state
  assert.equal(state.logs.length, SEEDED_LOGS.length)
  assert.equal(state.logs[0].title, '走满后山，4 段全程')
  assert.equal(state.logs[0].body, '正文一：捡到草药、松果。')
  assert.equal(state.logs[0].ended, 'complete')
  assert.equal(state.logs[1].reason, 'wipeout')
})

test('白名单：农场窗能提交 expedition-open，且只留标题、最多三篇', () => {
  assert.equal(shared.FARM_ACTIONS.includes('expedition-open'), true)
  assert.deepEqual(shared.normalizeFarmAction({ action: 'expedition-open' }), { action: 'expedition-open' })
  assert.deepEqual(
    shared.normalizeFarmAction({ action: 'expedition-open', title: '夹带' }),
    { action: 'expedition-open' }
  )
  assert.equal(shared.normalizeFarmAction({ action: 'expedition-shelf' }), null)

  const farm = shared.normalizeFarm({
    expeditionLog: { titles: ['一', '二', '三', '四'], body: '正文不该出现' }
  })
  assert.deepEqual(farm.expeditionLog, { titles: ['一', '二', '三'] })
  assert.deepEqual(shared.normalizeFarm({}).expeditionLog, { titles: [] })
})

test('白名单：出远门视图的 logs 逐字段清洗，最多 30 篇', () => {
  const logs = Array.from({ length: TRIP_LOG_LIMIT + 1 }, (_, index) => ({
    at: T0 + index,
    routeId: 'backhill',
    legs: 1,
    title: '标题 ' + String(index),
    body: '正文 ' + String(index),
    ended: 'back',
    reason: null,
    extra: '丢掉'
  }))
  logs.push({ at: T0, routeId: 'nowhere', legs: 1, title: '坏', body: '坏', ended: 'back', reason: null })
  logs.push({ at: T0, routeId: 'backhill', legs: 1, title: '', body: '坏', ended: 'back', reason: null })

  const view = shared.normalizeExpeditionView({ logs })
  assert.equal(view.logs.length, TRIP_LOG_LIMIT)
  assert.deepEqual(view.logs[0], {
    at: T0, routeId: 'backhill', legs: 1, title: '标题 0', body: '正文 0', ended: 'back', reason: null
  })
  assert.deepEqual(shared.normalizeExpeditionView({}).logs, [])
})

// ------------------------------------------------------------ 页面接线 ----------

async function readDesktop (name) {
  return readFile(new URL('../desktop/' + name, import.meta.url), 'utf8')
}

test('小窗：日志页签画全部正文，时间按 MM-DD HH:mm', async () => {
  const view = { logs: SEEDED_LOGS }
  const entries = expeditionView.tripLogEntries(view)
  assert.equal(entries.length, SEEDED_LOGS.length)
  assert.equal(entries[0].title, '走满后山，4 段全程')
  assert.equal(entries[0].body, '正文一：捡到草药、松果。')
  assert.equal(entries[3].reason, null)

  const pad = (value) => String(value).padStart(2, '0')
  const date = new Date(T0 + 4000)
  const when = pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  assert.equal(entries[0].when, when)
  assert.deepEqual(expeditionView.tripLogEntries(null), [])
  assert.deepEqual(expeditionView.tripLogEntries({ logs: [{ title: '只有标题' }] }), [], '缺正文的坏篇目不画')

  const html = await readDesktop('expedition.html')
  assert.match(html, /data-tab="log"/)
  assert.match(html, /id="logPane"/)
  assert.match(html, /id="logList"/)
  const windowJs = await readDesktop('expedition.js')
  assert.match(windowJs, /tripLogEntries\(/)
  assert.match(windowJs, /renderLogs\(/)
})

test('农场页：细条在 #batch-bar 上方，点开才进窗口', async () => {
  const html = await readDesktop('farm.html')
  const strip = html.indexOf('id="expedition-log"')
  const batch = html.indexOf('id="batch-bar"')
  assert.ok(strip > 0, '农场页要有日志细条')
  assert.ok(batch > 0 && strip < batch, '细条要排在 #batch-bar 上方')
  assert.match(html.slice(strip, strip + 900), /最近三篇/)

  const farmJs = await readDesktop('farm.js')
  assert.match(farmJs, /function renderExpeditionLog \(/)
  assert.match(farmJs, /renderExpeditionLog\(\)/)
  assert.match(farmJs, /expeditionLog/)
  // 2026-11-20：点「看全文」要直接落在日志页（之前只发 expedition-open，落在旅行首页）。
  assert.match(farmJs, /submit\(\{ action: 'expedition-open', tab: 'log' \}\)/)
})
