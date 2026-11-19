import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { legCoins, legsFor, routeOf, sumCoins, wipedOut } from '../src/expedition.js'
import { EXPEDITION_FILE, createExpeditionStore } from '../src/expedition-store.js'

const T0 = 1_700_000_000_000

/**
 * 挑一个「走这几段都不翻车」的 runId：113 起每段都可能翻车，
 * 验「见好就收 / 走满」这类事件时不能被 8% 的骰子搅红。
 */
function safeRunId (legs = 4) {
  const route = routeOf('backhill')
  for (let i = 0; i < 2000; i += 1) {
    const id = 'safe-' + i
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
    const id = 'doomed-' + i
    if (wipedOut({ id, routeId: 'backhill' }, leg)) return id
  }
  throw new Error('没有找到会翻车的 runId')
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-expedition-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 只实现出远门用到的两件事，跟 test/futures-store.test.js 的 fakeFarm 同一套边界。 */
function fakeFarm (coins) {
  const state = { coins, failAdd: false }
  return {
    state,
    async spendCoins (qty) {
      if (state.coins < qty) return { ok: false, error: 'no-coin' }
      state.coins -= qty
      return { ok: true, qty, coins: state.coins }
    },
    async addCoins (qty) {
      if (state.failAdd) return { ok: false, error: 'write-failed' }
      state.coins += qty
      return { ok: true, qty, coins: state.coins }
    }
  }
}

async function readState (dir) {
  return JSON.parse(await readFile(join(dir, EXPEDITION_FILE), 'utf8'))
}

test('初始化：空目录落一份空存档，货架/图鉴/提灯都有完整形状', async (t) => {
  const dir = await tempDir(t)
  const store = await createExpeditionStore(dir, { now: () => T0 })
  const snap = store.snapshot()
  assert.equal(snap.version, 1)
  assert.equal(snap.run, null)
  assert.deepEqual(snap.shelf, { slots: 8, items: [] })
  assert.deepEqual(snap.codex, {})
  assert.deepEqual(snap.upgrades, { lantern: false })
  assert.equal(store.active(), false)
  assert.deepEqual(await readState(dir), { version: 1, run: null, shelf: { slots: 8, items: [] }, codex: {}, upgrades: { lantern: false } })
})

test('出发先扣 500 盘缠：硬币变 0，run 落盘为 walking', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(500)
  const store = await createExpeditionStore(dir, { farm, now: () => T0 })
  const result = await store.start({ routeId: 'backhill' })
  assert.equal(result.ok, true)
  assert.equal(farm.state.coins, 0, '盘缠必须当场扣掉')
  assert.equal(result.run.phase, 'walking')
  assert.equal(result.run.leg, 1)
  assert.ok(result.run.totalLegs === 3 || result.run.totalLegs === 4)
  assert.equal(result.run.until, T0 + 20000)
  assert.equal(store.active(), true)
  assert.equal((await readState(dir)).run.id, result.run.id)
})

test('硬币不足整趟不开始：499 被拒，run 仍是空，文件里没有半个 run', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(499)
  const store = await createExpeditionStore(dir, { farm, now: () => T0 })
  const result = await store.start({ routeId: 'backhill' })
  assert.deepEqual(result, { ok: false, error: 'not-enough-coins' })
  assert.equal(farm.state.coins, 499)
  assert.equal(store.active(), false)
  assert.equal((await readState(dir)).run, null)
})

test('没有路线 / 没有农场时的拒绝理由', async (t) => {
  const dir = await tempDir(t)
  const store = await createExpeditionStore(dir, { farm: fakeFarm(500), now: () => T0 })
  assert.deepEqual(await store.start({ routeId: 'mine' }), { ok: false, error: 'no-route' })

  const bare = await createExpeditionStore(await tempDir(t), { now: () => T0 })
  assert.deepEqual(await bare.start({ routeId: 'backhill' }), { ok: false, error: 'starting' })
})

test('away 期间不能开第二趟：already-away 且不再扣钱', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(1000)
  const store = await createExpeditionStore(dir, { farm, now: () => T0 })
  const first = await store.start({ routeId: 'backhill' })
  assert.equal(first.ok, true)
  const second = await store.start({ routeId: 'backhill' })
  assert.deepEqual(second, { ok: false, error: 'already-away' })
  assert.equal(farm.state.coins, 500, '第二趟不该再扣 500')
})

test('tick 到点才回币；一段回币进 loot 并进决策窗', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(500)
  const store = await createExpeditionStore(dir, { farm, now: () => T0 })
  const started = await store.start({ routeId: 'backhill' })
  assert.equal(await store.tick(T0 + 19999), false)
  assert.equal(farm.state.coins, 0)

  assert.equal(await store.tick(T0 + 20000), true)
  const snap = store.snapshot()
  assert.equal(snap.run.phase, 'deciding')
  assert.equal(snap.run.until, T0 + 40000)
  const expected = legCoins(routeOf('backhill'), started.run.id, 1)
  assert.deepEqual(snap.run.loot, [{ kind: 'coin', qty: expected }])
  assert.equal(farm.state.coins, expected, '回币要当场进农场')
  assert.equal((await readState(dir)).run.phase, 'deciding')
})

test('走一段 → 继续 → 见好就收：只回已走两段的钱，盘缠不退', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(500)
  const store = await createExpeditionStore(dir, { farm, now: () => T0, newRunId: () => safeRunId(2) })
  const started = await store.start({ routeId: 'backhill' })
  const route = routeOf('backhill')

  await store.tick(T0 + 20000)
  const stepped = await store.step(T0 + 25000)
  assert.equal(stepped.ok, true)
  assert.equal(stepped.run.phase, 'walking')
  assert.equal(stepped.run.leg, 2)

  await store.tick(T0 + 45000)
  const before = farm.state.coins
  const back = await store.back(T0 + 46000)
  assert.equal(back.ok, true)
  assert.equal(back.run.ended, 'back')
  assert.equal(store.active(), false)

  const expected = legCoins(route, started.run.id, 1) + legCoins(route, started.run.id, 2)
  assert.equal(back.settled.coins, expected)
  assert.equal(back.settled.fare, 500)
  assert.equal(back.settled.legs, 2)
  assert.equal(farm.state.coins, before, '折返不再加钱：每段的回币在到点时已经进农场')
  assert.equal(farm.state.coins, expected, '总回币 = 两段的钱')
  assert.equal((await readState(dir)).run.ended, 'back')
})

test('走满最后一段自动回家：complete，回币覆盖全部段', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(500)
  const store = await createExpeditionStore(dir, { farm, now: () => T0, newRunId: () => safeRunId(4) })
  const started = await store.start({ routeId: 'backhill' })
  const route = routeOf('backhill')
  let now = T0
  for (let guard = 0; guard < 10; guard += 1) {
    const snap = store.snapshot()
    if (snap.run.ended !== null) break
    now = snap.run.until
    if (snap.run.phase === 'walking') await store.tick(now)
    else await store.step(now)
  }
  const snap = store.snapshot()
  assert.equal(snap.run.ended, 'complete')
  assert.equal(snap.run.loot.length, snap.run.totalLegs)
  assert.equal(farm.state.coins, sumCoins(snap.run.loot))
  assert.equal(farm.state.coins, sumCoins(snap.run.loot))
  assert.equal(sumCoins(snap.run.loot), Array.from({ length: started.run.totalLegs }, (_, i) => legCoins(route, started.run.id, i + 1)).reduce((a, b) => a + b, 0))
})

test('重复 step/back 在错误阶段回 not-walking，不写坏状态', async (t) => {
  const dir = await tempDir(t)
  const store = await createExpeditionStore(dir, { farm: fakeFarm(500), now: () => T0 })
  await store.start({ routeId: 'backhill' })
  assert.deepEqual(await store.step(T0), { ok: false, error: 'not-walking' })
  assert.deepEqual(await store.back(T0), { ok: false, error: 'not-walking' })
})

test('重启后未完成的那趟能继续：读档、再走一段', async (t) => {
  const dir = await tempDir(t)
  const first = await createExpeditionStore(dir, { farm: fakeFarm(500), now: () => T0, newRunId: () => safeRunId(2) })
  const started = await first.start({ routeId: 'backhill' })
  await first.tick(T0 + 20000)
  first.dispose()

  const farm = fakeFarm(500)
  const second = await createExpeditionStore(dir, { farm, now: () => T0 + 30000 })
  const snap = second.snapshot()
  assert.equal(snap.run.id, started.run.id)
  assert.equal(snap.run.phase, 'deciding')
  assert.equal(snap.run.until, T0 + 40000)

  const stepped = await second.step(T0 + 31000)
  assert.equal(stepped.ok, true)
  assert.equal(stepped.run.leg, 2)
  assert.equal((await readState(dir)).run.leg, 2)
})

test('坏存档只降级，不挡启动；坏 run 被丢掉', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, EXPEDITION_FILE), '{ 这不是 JSON', 'utf8')
  const store = await createExpeditionStore(dir, { farm: fakeFarm(500), now: () => T0 })
  assert.equal(store.snapshot().run, null)
  assert.equal(store.active(), false)

  await writeFile(join(dir, EXPEDITION_FILE), JSON.stringify({ version: 1, run: { routeId: 'backhill', phase: 'walking' } }), 'utf8')
  const repaired = await createExpeditionStore(dir, { farm: fakeFarm(500), now: () => T0 })
  assert.equal(repaired.snapshot().run, null)
  assert.equal((await readState(dir)).run, null, '坏 run 要被清掉写回')
})

test('折返后回到 idle，但上一趟的结果还留在文件里', async (t) => {
  const dir = await tempDir(t)
  const store = await createExpeditionStore(dir, { farm: fakeFarm(500), now: () => T0 })
  await store.start({ routeId: 'backhill' })
  await store.tick(T0 + 20000)
  const back = await store.back(T0 + 21000)
  assert.equal(back.ok, true)
  assert.equal(store.active(), false)
  const reloaded = await createExpeditionStore(dir, { farm: fakeFarm(500), now: () => T0 + 22000 })
  assert.equal(reloaded.snapshot().run.ended, 'back')
  assert.equal(reloaded.active(), false)
  assert.equal((await reloaded.start({ routeId: 'backhill' })).ok, true, '回家之后能再开一趟')
})

test('继续走翻车：已捡的硬币照给、盘缠不退，settled 带 wipeout', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(500)
  const runId = doomedRunId(2)
  const store = await createExpeditionStore(dir, { farm, now: () => T0, newRunId: () => runId })
  await store.start({ routeId: 'backhill' })
  await store.tick(T0 + 20000)
  const coins = legCoins(routeOf('backhill'), runId, 1)
  assert.equal(farm.state.coins, coins, '第 1 段的回币到点就入账')

  const stepped = await store.step(T0 + 25000)
  assert.equal(stepped.ok, true)
  assert.equal(stepped.run.ended, 'failed')
  assert.equal(stepped.run.reason, 'wipeout')
  assert.equal(stepped.run.phase, null)
  assert.equal(stepped.run.leg, 1, '翻车不算走过第 2 段')
  assert.equal(stepped.settled.ended, 'failed')
  assert.equal(stepped.settled.reason, 'wipeout')
  assert.equal(stepped.settled.coins, coins, '已捡的硬币照给')
  assert.equal(stepped.settled.fare, 500, '盘缠不退')
  assert.equal(farm.state.coins, coins, '翻车不再加钱，也不退盘缠')
  assert.equal(store.active(), false)
  const saved = await readState(dir)
  assert.equal(saved.run.ended, 'failed')
  assert.equal(saved.run.reason, 'wipeout')
})

test('决策窗 20 秒没人管：tick 自动折返，ended=back、reason=timeout，不再回币', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(500)
  const runId = safeRunId(2)
  const store = await createExpeditionStore(dir, { farm, now: () => T0, newRunId: () => runId })
  await store.start({ routeId: 'backhill' })
  await store.tick(T0 + 20000)
  assert.equal(store.snapshot().run.phase, 'deciding')

  assert.equal(await store.tick(T0 + 39999), false, '还没到 20 秒不动')
  assert.equal(store.snapshot().run.phase, 'deciding')

  const before = farm.state.coins
  assert.equal(await store.tick(T0 + 40000), true)
  const snap = store.snapshot()
  assert.equal(snap.run.ended, 'back')
  assert.equal(snap.run.reason, 'timeout')
  assert.equal(snap.run.phase, null)
  assert.equal(snap.run.until, null)
  assert.equal(snap.run.endedAt, T0 + 40000)
  assert.equal(farm.state.coins, before, '超时折返不再回币')
  assert.equal(store.active(), false)
  const saved = await readState(dir)
  assert.equal(saved.run.ended, 'back')
  assert.equal(saved.run.reason, 'timeout')
})

test('离线很久再读档：只走完当前这一段，新窗口从读档时刻算', async (t) => {
  const dir = await tempDir(t)
  const runId = safeRunId(4)
  const first = await createExpeditionStore(dir, { farm: fakeFarm(500), now: () => T0, newRunId: () => runId })
  const started = await first.start({ routeId: 'backhill' })
  first.dispose()

  // 离线 10 分钟：按 until 早就该走完好几十段了，但只能推进一个节点。
  const farm = fakeFarm(0)
  const at = T0 + 600000
  const second = await createExpeditionStore(dir, { farm, now: () => at })
  const snap = second.snapshot()
  assert.equal(snap.run.leg, 1, '只走完第 1 段')
  assert.equal(snap.run.phase, 'deciding')
  assert.equal(snap.run.loot.length, 1)
  assert.equal(snap.run.until, at + 20000, '新决策窗从读档时刻起算')
  assert.equal(farm.state.coins, legCoins(routeOf('backhill'), runId, 1), '回币只记一次')
  assert.equal((await readState(dir)).run.phase, 'deciding')
  assert.equal((await readState(dir)).run.id, started.run.id)

  // 再离线 10 分钟：决策窗也过了，直接回家，不会补掷翻车、也不会再走一段。
  second.dispose()
  const third = await createExpeditionStore(dir, { farm, now: () => at + 600000 })
  const home = third.snapshot().run
  assert.equal(home.ended, 'back')
  assert.equal(home.reason, 'timeout')
  assert.equal(home.leg, 1)
  assert.equal(farm.state.coins, legCoins(routeOf('backhill'), runId, 1), '不会重复入账')
})

test('读档还没到点：原样不动，也不写盘', async (t) => {
  const dir = await tempDir(t)
  const first = await createExpeditionStore(dir, { farm: fakeFarm(500), now: () => T0, newRunId: () => safeRunId(2) })
  await first.start({ routeId: 'backhill' })
  first.dispose()
  const before = await readFile(join(dir, EXPEDITION_FILE), 'utf8')

  const farm = fakeFarm(0)
  const second = await createExpeditionStore(dir, { farm, now: () => T0 + 10000 })
  assert.equal(second.snapshot().run.phase, 'walking')
  assert.equal(second.snapshot().run.until, T0 + 20000)
  assert.equal(farm.state.coins, 0)
  assert.equal(await readFile(join(dir, EXPEDITION_FILE), 'utf8'), before)
})

test('读档补记回币失败：这一趟原样留着，等下一次 tick 再补', async (t) => {
  const dir = await tempDir(t)
  const runId = safeRunId(2)
  const first = await createExpeditionStore(dir, { farm: fakeFarm(500), now: () => T0, newRunId: () => runId })
  await first.start({ routeId: 'backhill' })
  first.dispose()

  const farm = fakeFarm(0)
  farm.state.failAdd = true
  const second = await createExpeditionStore(dir, { farm, now: () => T0 + 600000 })
  const snap = second.snapshot()
  assert.equal(snap.run.phase, 'walking', '钱记不上就不推进')
  assert.equal(snap.run.until, T0 + 20000)
  assert.equal(snap.run.loot.length, 0)

  farm.state.failAdd = false
  assert.equal(await second.tick(T0 + 600001), true)
  assert.equal(second.snapshot().run.phase, 'deciding')
  assert.equal(farm.state.coins, legCoins(routeOf('backhill'), runId, 1))
  assert.equal(second.snapshot().run.loot.length, 1)
})
