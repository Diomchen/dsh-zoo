/**
 * 票 112：出远门小窗（不开 Electron）。
 *
 * 覆盖：
 *   1. 纯视图模型：倒计时、已走段数、结算文案、按钮可用性；
 *   2. `desktop/shared.js` 的白名单：`expedition-window` 命令、四个提交动作、
 *      菜单里的「出远门」、坏形状整条拒绝；
 *   3. 宿主侧：开窗下发整份视图；再点一次关窗；走一段后刷新；没有桌面层是 `desktop-off`。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { codexView, legsFor, routeOf, wipedOut } from '../src/expedition.js'
import { EXPEDITION_FILE } from '../src/expedition-store.js'
import { FARM_FILE } from '../src/farm.js'
import { createService } from '../src/service.js'

const require = createRequire(import.meta.url)
const view = require('../desktop/expedition-view.js')

const T0 = 1_700_000_000_000

function sampleRun (overrides = {}) {
  return {
    id: 'run-1',
    routeId: 'backhill',
    routeName: '后山',
    phase: 'walking',
    leg: 1,
    totalLegs: 4,
    until: T0 + 20_000,
    loot: [{ kind: 'coin', qty: 15 }, { kind: 'souvenir', id: 'herb' }],
    startedAt: T0,
    ended: null,
    endedAt: 0,
    danger: '中',
    ...overrides
  }
}

function sampleView (overrides = {}) {
  return {
    ready: true,
    version: 1,
    run: sampleRun(),
    coins: 520,
    now: T0,
    away: 'expedition',
    routes: [{ id: 'backhill', name: '后山', fare: 500, minLegs: 3, maxLegs: 4, coinBase: 15 }],
    shelf: { slots: 8, items: [] },
    codex: { herb: T0 },
    codexView: codexView({ herb: T0 }),
    upgrades: { lantern: false },
    ...overrides
  }
}

test('视图模型：倒计时向上取整，归零就是 0:00', () => {
  assert.equal(view.formatClock(20_000), '0:20')
  assert.equal(view.formatClock(19_001), '0:20')
  assert.equal(view.formatClock(0), '0:00')
  assert.equal(view.formatClock(-5), '0:00')
  assert.equal(view.remainingMs(sampleRun(), T0 + 5_000), 15_000)
  assert.equal(view.remainingMs(sampleRun({ until: null }), T0), 0)
})

test('视图模型：阶段、已走段数与危险度都是人话', () => {
  assert.equal(view.phaseLabel(sampleRun()), '正在走路')
  assert.equal(view.phaseLabel(sampleRun({ phase: 'deciding' })), '想想要不要继续')
  assert.equal(view.phaseLabel(sampleRun({ phase: null, ended: 'complete' })), '走满了，已经回家')
  assert.equal(view.phaseLabel(sampleRun({ phase: null, ended: 'back' })), '见好就收，已经回家')
  assert.equal(view.progressText(sampleRun({ leg: 2, totalLegs: 4 })), '已走 2 / 4 段')
  assert.equal(view.dangerText(sampleRun({ danger: '低' })), '危险度 低')
})

test('视图模型：见好就收只按已走段数的战利品算钱', () => {
  const run = sampleRun({
    phase: null,
    ended: 'back',
    leg: 2,
    loot: [{ kind: 'coin', qty: 12 }, { kind: 'coin', qty: 14 }]
  })
  assert.equal(view.sumLoot(run), 26)
  assert.equal(view.settleText(run), '见好就收，带回 26 枚硬币')
  const complete = sampleRun({ phase: null, ended: 'complete', leg: 4, loot: [{ kind: 'coin', qty: 52 }] })
  assert.equal(view.settleText(complete), '走满全程，带回 52 枚硬币')
})

test('视图模型：按钮只在决策窗可用，硬币不够不能出发', () => {
  const route = { fare: 500 }
  assert.equal(view.canStart({ run: null, coins: 500 }, route), true)
  assert.equal(view.canStart({ run: null, coins: 499 }, route), false)
  assert.equal(view.canStart({ run: sampleRun(), coins: 9999 }, route), false)
  assert.equal(view.canContinue(sampleRun()), false)
  assert.equal(view.canContinue(sampleRun({ phase: 'deciding' })), true)
  assert.equal(view.canBack(sampleRun({ phase: 'deciding' })), true)
  assert.equal(view.primaryLabel(sampleRun()), '走路中…')
  assert.equal(view.primaryLabel(sampleRun({ phase: 'deciding' })), '继续走一段')
  assert.equal(view.primaryLabel(sampleRun({ phase: null, ended: 'back' })), '再走一趟')
})

test('视图模型：图鉴 32 格按路线分组，缺图/坏路径回退 emoji', () => {
  const codex = codexView({ herb: T0 })
  assert.equal(view.codexProgress(codex), '1/32')
  const groups = view.codexGroups(codex)
  assert.deepEqual(groups.map((group) => group.routeName), ['后山', '废矿', '老铁路', '雾岭'])
  assert.deepEqual(groups.map((group) => group.slots.length), [8, 8, 8, 8])
  assert.equal(groups.reduce((sum, group) => sum + group.slots.filter((slot) => slot.owned).length, 0), 1)

  const herb = codex.slots.find((slot) => slot.id === 'herb')
  assert.deepEqual(view.slotEmblem(herb), { kind: 'art', src: 'souvenirs/herb.svg' })
  assert.deepEqual(view.slotEmblem({ art: '', emoji: '🌿' }), { kind: 'emoji', text: '🌿' })
  assert.deepEqual(view.slotEmblem({ art: '../evil.svg', emoji: '' }), { kind: 'emoji', text: '❔' })
  assert.deepEqual(view.souvenirNames(sampleRun(), codex), ['草药'])
  assert.deepEqual(view.souvenirNames(sampleRun({ loot: [] }), codex), [])
  assert.equal(view.codexProgress(null), '0/32', '没有视图也要画满 32 个空格')
})

test('shared：窗口视图保留特产 loot，并清洗 32 格图鉴', () => {
  const codex = codexView({ herb: T0 })
  codex.slots[0].art = '../evil.svg'
  codex.slots[1].art = ''
  const normalized = shared.normalizeHostCommand({
    type: 'expedition-window',
    id: 'c3',
    open: true,
    state: sampleView({
      run: sampleRun({
        loot: [
          { kind: 'coin', qty: 15 },
          { kind: 'souvenir', id: 'herb' },
          { kind: 'souvenir', id: '' }
        ]
      }),
      codexView: codex
    })
  })
  assert.equal(normalized.ok, true)
  assert.deepEqual(normalized.command.state.run.loot, [
    { kind: 'coin', qty: 15 },
    { kind: 'souvenir', id: 'herb' }
  ])
  const viewState = normalized.command.state.codexView
  assert.equal(viewState.total, 32)
  assert.equal(viewState.owned, 1)
  assert.equal(viewState.slots[0].art, '', '坏路径必须当缺图')
  assert.equal(viewState.slots[1].art, '')
  assert.equal(viewState.slots.find((slot) => slot.id === 'herb').label, '草药')
  assert.equal(viewState.slots.find((slot) => slot.id === 'oddstone').label, '???')
})

test('shared：expedition-window 命令与窗口状态事件', () => {
  const normalized = shared.normalizeHostCommand({
    type: 'expedition-window',
    id: 'c1',
    open: true,
    state: sampleView()
  })
  assert.equal(normalized.ok, true)
  assert.equal(normalized.command.open, true)
  assert.equal('close' in normalized.command, false)
  assert.equal(normalized.command.state.run.routeId, 'backhill')
  assert.equal(normalized.command.state.routes.length, 1)

  const closed = shared.normalizeHostCommand({ type: 'expedition-window', id: 'c2', close: true })
  assert.equal(closed.ok, true)
  assert.equal(closed.command.close, true)

  const stateEvent = shared.normalizeHelperEvent({ type: 'expedition-window-state', id: 'e1', open: false })
  assert.equal(stateEvent.ok, true)
  assert.equal(stateEvent.event.open, false)

  const shot = shared.normalizeHostCommand({ type: 'shot', id: 's1', path: 'C:\\tmp\\a.png', window: 'expedition' })
  assert.equal(shot.ok, true)
  assert.equal(shot.command.window, 'expedition')
})

test('shared：四个提交动作只过白名单字段，坏路线整条拒绝', () => {
  assert.equal(shared.normalizeExpeditionAction({ action: 'expedition-step' }).action, 'expedition-step')
  assert.equal(shared.normalizeExpeditionAction({ action: 'expedition-back' }).action, 'expedition-back')
  assert.equal(shared.normalizeExpeditionAction({ action: 'expedition-refresh' }).action, 'expedition-refresh')
  const start = shared.normalizeExpeditionAction({ action: 'expedition-start', routeId: 'backhill', coins: 1 })
  assert.deepEqual(start, { action: 'expedition-start', routeId: 'backhill' })
  assert.equal(shared.normalizeExpeditionAction({ action: 'expedition-start' }), null)
  assert.equal(shared.normalizeExpeditionAction({ action: 'expedition-start', routeId: '' }), null)
  assert.equal(shared.normalizeExpeditionAction({ action: 'expedition-wipeout' }), null)

  const event = shared.normalizeHelperEvent({
    type: 'action',
    id: 'a1',
    action: 'expedition-start',
    routeId: 'backhill'
  })
  assert.equal(event.ok, true)
  assert.equal(event.event.routeId, 'backhill')
  const bad = shared.normalizeHelperEvent({ type: 'action', id: 'a2', action: 'expedition-start' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'bad-expedition-action')
})

test('视图模型：陈列架画满 32 格，锁着的格子带价格', () => {
  const shelf = { slots: 8, items: [] }
  const cells = view.shelfCells(shelf)
  assert.equal(cells.length, 32)
  assert.equal(cells.filter((cell) => cell.locked).length, 24)
  assert.deepEqual(
    cells.slice(0, 8).map((cell) => cell.locked),
    [false, false, false, false, false, false, false, false]
  )
  assert.equal(cells[8].locked, true)
  assert.equal(cells[8].price, 5000)
  assert.equal(cells[31].price, 5000)
  assert.equal(cells[0].empty, true)
  assert.equal(view.shelfProgress(shelf), '已开 8 / 32 格')
  assert.equal(view.shelfProgress(null), '已开 8 / 32 格')
})

test('视图模型：陈列架按位置对格，空格与特产都不串位', () => {
  const shelf = { slots: 9, items: [null, 'herb'] }
  const codex = codexView({ herb: T0 })
  const cells = view.shelfCells(shelf, codex)
  assert.equal(cells[0].empty, true)
  assert.equal(cells[1].itemId, 'herb')
  assert.equal(cells[1].label, '草药')
  assert.deepEqual(cells[1].emblem, { kind: 'art', src: 'souvenirs/herb.svg' })
  assert.equal(cells[8].locked, false, '第 9 格已解锁')
  assert.equal(cells[9].locked, true)
  assert.equal(view.canUnlock(shelf, 10, 5000), true)
  assert.equal(view.canUnlock(shelf, 10, 4999), false)
  assert.equal(view.canUnlock(shelf, 9, 5000), false, '只能按顺序开下一格')
  assert.equal(view.canUnlock(shelf, 11, 5000), false, '隔一格也不行')
})

test('视图模型：可摆放的特产只列已获得且还没上架的', () => {
  const codex = {
    slots: [
      { id: 'herb', name: '草药', owned: true, art: 'souvenirs/herb.svg', emoji: '🌿' },
      { id: 'stone', name: '石子', owned: true, art: '', emoji: '🪨' },
      { id: 'unknown', name: '???', owned: false, art: '', emoji: '❔' }
    ]
  }
  const placeable = view.placeableSouvenirs({ slots: 8, items: ['herb'] }, codex)
  assert.deepEqual(placeable.map((slot) => slot.id), ['stone'])
  assert.deepEqual(view.placeableSouvenirs({ slots: 8, items: [] }, null), [])
})

test('shared：陈列架视图真正归一，不再写死空架子', () => {
  const normalized = shared.normalizeHostCommand({
    type: 'expedition-window',
    id: 'c4',
    open: true,
    state: sampleView({
      shelf: { slots: 9, items: [null, 'herb'], unlocked: 9, maxSlots: 32, slotPrice: 5000 }
    })
  })
  assert.equal(normalized.ok, true)
  assert.deepEqual(normalized.command.state.shelf.items, [null, 'herb'])
  assert.equal(normalized.command.state.shelf.slots, 9)
  assert.equal(normalized.command.state.shelf.unlocked, 9)
  assert.equal(normalized.command.state.shelf.maxSlots, 32)
  assert.equal(normalized.command.state.shelf.slotPrice, 5000)

  const fallback = shared.normalizeHostCommand({
    type: 'expedition-window',
    id: 'c5',
    open: true,
    state: sampleView({ shelf: { slots: 99, items: ['herb', 'herb', 7] } })
  })
  assert.equal(fallback.command.state.shelf.slots, 8)
  assert.deepEqual(fallback.command.state.shelf.items, ['herb'])
})

test('shared：陈列架动作只过 slot/itemId/moveFrom/moveTo', () => {
  assert.deepEqual(
    shared.normalizeExpeditionAction({ action: 'expedition-shelf', slot: 9, coins: 1 }),
    { action: 'expedition-shelf', slot: 9 }
  )
  assert.deepEqual(
    shared.normalizeExpeditionAction({ action: 'expedition-shelf', itemId: 'herb', slot: 2 }),
    { action: 'expedition-shelf', itemId: 'herb', slot: 2 }
  )
  assert.deepEqual(
    shared.normalizeExpeditionAction({ action: 'expedition-shelf', moveFrom: 1, moveTo: 2 }),
    { action: 'expedition-shelf', moveFrom: 1, moveTo: 2 }
  )
  assert.deepEqual(
    shared.normalizeExpeditionAction({ action: 'expedition-shelf', moveFrom: 1 }),
    { action: 'expedition-shelf', moveFrom: 1 }
  )
  assert.equal(shared.normalizeExpeditionAction({ action: 'expedition-shelf' }), null)
  assert.equal(shared.normalizeExpeditionAction({ action: 'expedition-shelf', slot: 0 }), null)
  assert.equal(shared.normalizeExpeditionAction({ action: 'expedition-shelf', slot: 33 }), null)
  assert.equal(shared.normalizeExpeditionAction({ action: 'expedition-shelf', itemId: 7 }), null)
  assert.equal(shared.normalizeExpeditionAction({ action: 'expedition-shelf', itemId: 'herb' }), null)
  assert.equal(
    shared.normalizeExpeditionAction({ action: 'expedition-shelf', slot: 1, moveFrom: 2 }),
    null
  )
  assert.ok(shared.EXPEDITION_SUBMIT_ACTIONS.includes('expedition-shelf'))
  const event = shared.normalizeHelperEvent({
    type: 'action',
    id: 'a3',
    action: 'expedition-shelf',
    moveFrom: 1,
    moveTo: 2
  })
  assert.equal(event.ok, true)
  assert.deepEqual(event.event, { type: 'action', id: 'a3', action: 'expedition-shelf', moveFrom: 1, moveTo: 2 })
})

test('shared：菜单里的「出远门」指向 expedition-open', () => {
  assert.equal(shared.MENU_TOOL_REQUESTS.expedition, 'expedition-open')
  assert.ok(shared.MENU_TOOL_IDS.includes('expedition'))
  assert.ok(shared.MENU_ACTION_IDS.includes('expedition-open'))
  for (const action of shared.EXPEDITION_SUBMIT_ACTIONS) {
    assert.ok(shared.DESKTOP_ACTIONS.includes(action), action + ' 应该在 DESKTOP_ACTIONS 里')
  }
})

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-expedition-window-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
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

function desktopDouble () {
  const calls = { expedition: [] }
  let onEvent = null
  let open = false
  return {
    calls,
    factory (factoryOptions) {
      onEvent = factoryOptions.onEvent
      return {
        start () { return { ok: true, pid: 4242 } },
        update () { return true },
        resync () { return true },
        status () { return { expeditionOpen: open } },
        expeditionWindow (payload) {
          calls.expedition.push(payload)
          if (payload.close === true) open = false
          else if (payload.open === true) open = true
          return true
        },
        lastCommandFailure () { return null },
        actionResult () {},
        dispose () {}
      }
    },
    ready (workArea = { x: 0, y: 30, width: 1000, height: 700 }) {
      onEvent?.({ type: 'ready', pid: 4242, workArea, displays: [{ id: 1, bounds: workArea, workArea, scaleFactor: 1, primary: true }] })
    },
    userClose () {
      open = false
      onEvent?.({ type: 'expedition-window-state', open: false })
    }
  }
}

async function makeService (t, dir, desktop, clock, runId = null) {
  const { ctx, routes } = fakeCtx()
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins: 620 }), 'utf8')
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    petBridge: false,
    skinServer: false,
    desktopFactory: desktop.factory,
    farmNow: () => clock.value,
    expeditionNow: () => clock.value,
    // 113 起每段都会掷翻车：窗口测试固定一个一路平安的 runId。
    expeditionRunId: () => runId ?? cleanRunId()
  })
  service.routes = routes
  t.after(() => service.dispose())
  await service.ready
  return service
}

/** 走 4 段都不翻车的 runId（规则层公共函数探，不抄掷骰公式）。 */
function cleanRunId () {
  for (let i = 0; i < 2000; i += 1) {
    const id = 'window-' + i
    if (legsFor(routeOf('backhill'), id) < 4) continue
    if (![2, 3, 4].some((leg) => wipedOut({ id, routeId: 'backhill' }, leg))) return id
  }
  throw new Error('没有找到一路平安的 runId')
}

/** 第 2 段必翻车的 runId。 */
function doomedRunId () {
  for (let i = 0; i < 2000; i += 1) {
    const id = 'window-doomed-' + i
    if (wipedOut({ id, routeId: 'backhill' }, 2)) return id
  }
  throw new Error('没有找到会翻车的 runId')
}

test('宿主：开窗下发整份视图；再点一次关窗；× 之后能重开', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: T0 }
  const desktop = desktopDouble()
  const service = await makeService(t, dir, desktop, clock)
  desktop.ready()

  const opened = await callAction(service, { action: 'expedition-open' })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.ok, true)
  assert.equal(opened.body.window, 'opened')
  const command = desktop.calls.expedition.at(-1)
  assert.equal(command.open, true)
  assert.equal(command.state.ready, true)
  assert.equal(command.state.coins, 620)
  assert.equal(command.state.run, null)
  assert.deepEqual(command.state.routes.map((route) => route.id), ['backhill'])

  const again = await callAction(service, { action: 'expedition-open' })
  assert.equal(again.body.ok, true)
  assert.equal(again.body.window, 'closed')
  assert.equal(desktop.calls.expedition.at(-1).close, true)

  desktop.userClose()
  const reopened = await callAction(service, { action: 'expedition-open' })
  assert.equal(reopened.body.window, 'opened')
})

test('宿主：陈列架随窗口下发，挪格后重推且不花硬币', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: T0 }
  await writeFile(join(dir, EXPEDITION_FILE), JSON.stringify({
    version: 1,
    run: null,
    shelf: { slots: 9, items: ['herb'] },
    codex: { herb: T0 },
    upgrades: { lantern: false }
  }), 'utf8')
  const desktop = desktopDouble()
  const service = await makeService(t, dir, desktop, clock)
  desktop.ready()
  await callAction(service, { action: 'expedition-open' })

  const opened = desktop.calls.expedition.at(-1)
  assert.equal(opened.state.shelf.slots, 9)
  assert.equal(opened.state.shelf.unlocked, 9)
  assert.equal(opened.state.shelf.maxSlots, 32)
  assert.equal(opened.state.shelf.slotPrice, 5000)
  assert.deepEqual(opened.state.shelf.items, ['herb'])

  const moved = await callAction(service, { action: 'expedition-shelf', moveFrom: 1, moveTo: 2 })
  assert.equal(moved.body.ok, true)
  const pushed = desktop.calls.expedition.at(-1).state
  assert.deepEqual(pushed.shelf.items, [null, 'herb'])
  assert.equal(pushed.coins, 620, '挪格不花钱')
})

test('宿主：出发扣盘缠，到点刷新成决策窗，继续走一段', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: T0 }
  const desktop = desktopDouble()
  const service = await makeService(t, dir, desktop, clock)
  desktop.ready()
  await callAction(service, { action: 'expedition-open' })

  const started = await callAction(service, { action: 'expedition-start', routeId: 'backhill' })
  assert.equal(started.body.ok, true)
  assert.equal(started.body.run.phase, 'walking')
  assert.equal(started.body.run.leg, 1)
  const pushed = desktop.calls.expedition.at(-1)
  assert.equal(pushed.open, false)
  assert.equal(pushed.state.run.phase, 'walking')
  assert.equal(pushed.state.coins, 120)

  clock.value = T0 + 20_001
  const refreshed = await callAction(service, { action: 'expedition-refresh' })
  assert.equal(refreshed.body.ok, true)
  const deciding = desktop.calls.expedition.at(-1).state.run
  assert.equal(deciding.phase, 'deciding')
  assert.equal(deciding.leg, 1)
  assert.equal(deciding.loot.length, 2)
  const coin = deciding.loot.find((item) => item.kind === 'coin')
  assert.ok(coin.qty >= 11 && coin.qty <= 19)
  assert.equal(deciding.loot.find((item) => item.kind === 'souvenir').kind, 'souvenir')
  assert.equal(desktop.calls.expedition.at(-1).state.codexView.total, 32)
  assert.equal(desktop.calls.expedition.at(-1).state.codexView.owned, 1)

  const stepped = await callAction(service, { action: 'expedition-step' })
  assert.equal(stepped.body.ok, true)
  const walking = desktop.calls.expedition.at(-1).state.run
  assert.equal(walking.phase, 'walking')
  assert.equal(walking.leg, 2)
})

test('宿主：见好就收只结算已走段数，盘缠不退', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: T0 }
  const desktop = desktopDouble()
  const service = await makeService(t, dir, desktop, clock)
  desktop.ready()
  await callAction(service, { action: 'expedition-open' })
  await callAction(service, { action: 'expedition-start', routeId: 'backhill' })
  clock.value = T0 + 20_001
  await callAction(service, { action: 'expedition-refresh' })

  const back = await callAction(service, { action: 'expedition-back' })
  assert.equal(back.body.ok, true)
  assert.equal(back.body.settled.legs, 1)
  assert.equal(back.body.settled.ended, 'back')
  const settled = desktop.calls.expedition.at(-1).state
  assert.equal(settled.run.ended, 'back')
  assert.equal(settled.run.coins, undefined)
  // 盘缠 500 不退；回币等于这一段捡到的那一笔。
  assert.equal(settled.coins, 120 + back.body.settled.coins)
})

test('宿主：翻车后窗口收到 ended=failed + reason=wipeout，硬币照给', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: T0 }
  const desktop = desktopDouble()
  const service = await makeService(t, dir, desktop, clock, doomedRunId())
  desktop.ready()
  await callAction(service, { action: 'expedition-open' })
  const started = await callAction(service, { action: 'expedition-start', routeId: 'backhill' })
  const firstCoin = started.body.run.loot.length === 0 ? null : started.body.run.loot[0].qty

  clock.value = T0 + 20_001
  await callAction(service, { action: 'expedition-refresh' })
  const deciding = desktop.calls.expedition.at(-1).state
  assert.equal(deciding.run.phase, 'deciding')
  const coin = deciding.run.loot[0].qty
  assert.equal(deciding.coins, 120 + coin, '第 1 段的钱到点就进农场')
  assert.equal(firstCoin, null, '出发时还没有战利品')

  const stepped = await callAction(service, { action: 'expedition-step' })
  assert.equal(stepped.body.ok, true)
  assert.equal(stepped.body.run.ended, 'failed')
  const wiped = desktop.calls.expedition.at(-1).state
  assert.equal(wiped.run.ended, 'failed')
  assert.equal(wiped.run.reason, 'wipeout')
  assert.equal(wiped.run.phase, null)
  assert.equal(wiped.run.leg, 1, '翻车不推进段数')
  assert.equal(wiped.away, null, '宠物已经回家')
  assert.equal(wiped.coins, 120 + coin, '硬币照给、盘缠不退')
})

test('宿主：决策窗超时后刷新，窗口收到 ended=back + reason=timeout', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: T0 }
  const desktop = desktopDouble()
  const service = await makeService(t, dir, desktop, clock)
  desktop.ready()
  await callAction(service, { action: 'expedition-open' })
  await callAction(service, { action: 'expedition-start', routeId: 'backhill' })

  clock.value = T0 + 20_001
  await callAction(service, { action: 'expedition-refresh' })
  assert.equal(desktop.calls.expedition.at(-1).state.run.phase, 'deciding')

  clock.value = T0 + 40_001
  const refreshed = await callAction(service, { action: 'expedition-refresh' })
  assert.equal(refreshed.body.ok, true)
  const timedOut = desktop.calls.expedition.at(-1).state
  assert.equal(timedOut.run.ended, 'back')
  assert.equal(timedOut.run.reason, 'timeout')
  assert.equal(timedOut.run.phase, null)
  assert.equal(timedOut.away, null)
})

test('宿主：没有桌面层是 desktop-off，不写任何窗口命令', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: T0 }
  const { ctx, routes } = fakeCtx()
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins: 620 }), 'utf8')
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    petBridge: false,
    skinServer: false,
    desktop: false,
    farmNow: () => clock.value,
    expeditionNow: () => clock.value
  })
  service.routes = routes
  t.after(() => service.dispose())
  await service.ready

  const opened = await callAction(service, { action: 'expedition-open' })
  assert.equal(opened.body.ok, false)
  assert.equal(opened.body.error, 'desktop-off')
  const refreshed = await callAction(service, { action: 'expedition-refresh' })
  assert.equal(refreshed.body.ok, false)
  assert.equal(refreshed.body.error, 'desktop-off')
})
