import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SOUVENIR_IDS, legCoins, legsFor, rollSouvenir, routeOf, sumCoins, wipedOut } from '../src/expedition.js'
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

/** 走一趟后山并见好就收：段 1 到点时不会掷翻车，所以这趟必定「已回家」。 */
async function homedBackhillTrip (store, now) {
  const started = await store.start({ routeId: 'backhill' })
  assert.equal(started.ok, true)
  await store.tick(now)
  const home = await store.back(now)
  assert.equal(home.ok, true)
  assert.equal(home.settled.ended, 'back')
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
  assert.equal(snap.codexView.total, 32)
  assert.equal(snap.codexView.owned, 0)
  assert.equal(snap.codexView.slots.length, 32)
  assert.deepEqual(snap.upgrades, { lantern: false })
  assert.deepEqual(snap.trips, {}, '还没回过家的趟')
  assert.equal(store.active(), false)
  assert.deepEqual(await readState(dir), { version: 1, run: null, shelf: { slots: 8, items: [] }, codex: {}, upgrades: { lantern: false }, trips: {} })
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
  assert.deepEqual(await store.start({ routeId: 'nowhere' }), { ok: false, error: 'no-route' })

  const bare = await createExpeditionStore(await tempDir(t), { now: () => T0 })
  assert.deepEqual(await bare.start({ routeId: 'backhill' }), { ok: false, error: 'starting' })
})

test('解锁门控：废矿要 3 趟已回家的后山，第三趟回来当拍就放行', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(10000)
  const clock = { value: T0 }
  const store = await createExpeditionStore(dir, { farm, now: () => clock.value })

  assert.deepEqual(await store.start({ routeId: 'mine' }), { ok: false, error: 'locked' })
  assert.equal(farm.state.coins, 10000, '锁着的路线不扣盘缠')

  await homedBackhillTrip(store, T0 + 20001)
  await homedBackhillTrip(store, T0 + 40002)
  assert.deepEqual(store.snapshot().trips, { backhill: 2 })
  assert.deepEqual(await store.start({ routeId: 'mine' }), { ok: false, error: 'locked' })

  await homedBackhillTrip(store, T0 + 60003)
  assert.deepEqual(store.snapshot().trips, { backhill: 3 })
  assert.deepEqual((await readState(dir)).trips, { backhill: 3 }, '趟数必须落盘')

  const before = farm.state.coins
  const started = await store.start({ routeId: 'mine' })
  assert.equal(started.ok, true)
  assert.equal(started.run.routeId, 'mine')
  assert.equal(started.run.totalLegs, legsFor(routeOf('mine'), started.run.id))
  assert.equal(farm.state.coins, before - 3000, '废矿的盘缠是 3,000')
})

test('翻车的趟不进解锁进度：失败两次后废矿仍然锁着', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(10000)
  const store = await createExpeditionStore(dir, { farm, now: () => T0, newRunId: () => doomedRunId(2) })
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await store.start({ routeId: 'backhill' })).ok, true)
    await store.tick(T0 + 20001)
    const failed = await store.step(T0 + 20001)
    assert.equal(failed.ok, true)
    assert.equal(failed.settled.ended, 'failed')
  }
  assert.deepEqual(store.snapshot().trips, {}, '翻车不算回家的趟')
  assert.deepEqual((await readState(dir)).trips, {})
  assert.deepEqual(await store.start({ routeId: 'mine' }), { ok: false, error: 'locked' })
})

test('图鉴 16 件开老铁路；雾岭还要图鉴 24 件加 1 趟回家的老铁路', async (t) => {
  const dir = await tempDir(t)
  const codex = Object.fromEntries(SOUVENIR_IDS.slice(0, 16).map((id) => [id, T0]))
  await writeFile(join(dir, EXPEDITION_FILE), JSON.stringify({
    version: 1,
    run: null,
    shelf: { slots: 8, items: [] },
    codex,
    upgrades: { lantern: false }
  }), 'utf8')
  const farm = fakeFarm(200000)
  const first = await createExpeditionStore(dir, { farm, now: () => T0 })
  assert.deepEqual(first.snapshot().trips, {})

  const railway = await first.start({ routeId: 'railway' })
  assert.equal(railway.ok, true)
  await first.tick(T0 + 20001)
  const home = await first.back(T0 + 20001)
  assert.equal(home.ok, true)
  assert.deepEqual(first.snapshot().trips, { railway: 1 })

  // 图鉴还差 8 件：雾岭锁着，老铁路可以再走。
  assert.deepEqual(await first.start({ routeId: 'mistridge' }), { ok: false, error: 'locked' })
  assert.equal((await first.start({ routeId: 'railway' })).ok, true)
  await first.tick(T0 + 40002)
  await first.back(T0 + 40002)

  const state = await readState(dir)
  state.codex = Object.fromEntries(SOUVENIR_IDS.slice(0, 24).map((id) => [id, T0]))
  await writeFile(join(dir, EXPEDITION_FILE), JSON.stringify(state), 'utf8')

  const laterFarm = fakeFarm(200000)
  const reloaded = await createExpeditionStore(dir, { farm: laterFarm, now: () => T0 })
  assert.deepEqual(reloaded.snapshot().trips, { railway: 2 }, '重启后已回家的趟数还在')
  const mist = await reloaded.start({ routeId: 'mistridge' })
  assert.equal(mist.ok, true)
  assert.equal(mist.run.routeId, 'mistridge')
  assert.equal(laterFarm.state.coins, 200000 - 60000, '雾岭的盘缠是 60,000')
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
  const souvenir = rollSouvenir('backhill', started.run.id, 1, [])
  assert.deepEqual(snap.run.loot, [{ kind: 'coin', qty: expected }, { kind: 'souvenir', id: souvenir }])
  assert.equal(snap.codex[souvenir], T0 + 20000, '首次获得时间就是掉出来的那一拍')
  assert.equal(snap.codexView.owned, 1)
  assert.equal(snap.codexView.slots.find((slot) => slot.id === souvenir).owned, true)
  assert.equal(farm.state.coins, expected, '回币要当场进农场')
  assert.equal((await readState(dir)).run.phase, 'deciding')
  assert.equal((await readState(dir)).codex[souvenir], T0 + 20000, '图鉴要落盘')
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
  assert.equal(snap.run.loot.length, snap.run.totalLegs * 2, '每段一硬币一特产')
  assert.equal(snap.codexView.owned, snap.run.totalLegs, '走满一趟图鉴至少多这么多件')
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

test('图鉴只记第一次：重开存档后同一件再掉，时间不被覆盖', async (t) => {
  const dir = await tempDir(t)
  const first = await createExpeditionStore(dir, { farm: fakeFarm(500), now: () => T0 })
  const started = await first.start({ routeId: 'backhill' })
  const souvenir = rollSouvenir('backhill', started.run.id, 1, [])
  const saved = await readState(dir)
  saved.codex = { [souvenir]: T0 - 5000 }
  await writeFile(join(dir, EXPEDITION_FILE), JSON.stringify(saved), 'utf8')
  first.dispose()

  const second = await createExpeditionStore(dir, { farm: fakeFarm(0), now: () => T0 + 1000 })
  assert.equal(second.snapshot().codex[souvenir], T0 - 5000)
  assert.equal(await second.tick(T0 + 20000), true)
  const snap = second.snapshot()
  assert.equal(snap.codex[souvenir], T0 - 5000, '重复获得不能覆盖首次时间')
  assert.equal(snap.codexView.slots.find((slot) => slot.id === souvenir).firstSeenAt, T0 - 5000)
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
  assert.equal(snap.run.loot.length, 2, '硬币 + 一件特产')
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
  assert.equal(second.snapshot().run.loot.length, 2, '硬币 + 一件特产')
})

test('陈列架开格：第 9 格起每格 5,000，扣农场的硬币并落盘', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(5000)
  const store = await createExpeditionStore(dir, { farm, now: () => T0 })
  assert.deepEqual(store.snapshot().shelf, { slots: 8, items: [] })

  const result = await store.shelfAction({ slot: 9 })
  assert.equal(result.ok, true)
  assert.equal(result.shelf.slots, 9)
  assert.deepEqual(result.shelf.items, [])
  assert.equal(farm.state.coins, 0, '开一格必须是 5,000')
  assert.equal((await readState(dir)).shelf.slots, 9, '格数要落盘')
})

test('陈列架开格：硬币不够报 not-enough-coins，格数与硬币都不变', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(4999)
  const store = await createExpeditionStore(dir, { farm, now: () => T0 })

  const result = await store.shelfAction({ slot: 9 })
  assert.deepEqual(result, { ok: false, error: 'not-enough-coins' })
  assert.equal(store.snapshot().shelf.slots, 8)
  assert.equal(farm.state.coins, 4999, '失败了不能扣钱')
  assert.equal((await readState(dir)).shelf.slots, 8)
})

test('陈列架开满 32 格共花 120,000；第 33 格报 locked', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(120000)
  const store = await createExpeditionStore(dir, { farm, now: () => T0 })

  for (let slot = 9; slot <= 32; slot += 1) {
    const result = await store.shelfAction({ slot })
    assert.equal(result.ok, true, '开第 ' + String(slot) + ' 格')
    assert.equal(result.shelf.slots, slot)
  }
  assert.equal(farm.state.coins, 0, '8 格 + 24 × 5,000 = 120,000')
  const beyond = await store.shelfAction({ slot: 33 })
  assert.deepEqual(beyond, { ok: false, error: 'locked' })
  assert.equal(store.snapshot().shelf.slots, 32)
  assert.equal(farm.state.coins, 0)
})

test('陈列架摆放/挪格/取下：同一件不能进两格，移动不花硬币', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(0)
  const store = await createExpeditionStore(dir, { farm, now: () => T0 })

  const placed = await store.shelfAction({ slot: 1, itemId: 'herb' })
  assert.equal(placed.ok, true)
  assert.equal(placed.shelf.items[0], 'herb')
  assert.equal(farm.state.coins, 0, '摆放不花钱')

  const duplicate = await store.shelfAction({ slot: 2, itemId: 'herb' })
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.error, 'locked')
  assert.equal(store.snapshot().shelf.items.filter((id) => id === 'herb').length, 1, '同一件只能占一格')

  const moved = await store.shelfAction({ moveFrom: 1, moveTo: 2 })
  assert.equal(moved.ok, true)
  assert.equal(moved.shelf.items[0], null)
  assert.equal(moved.shelf.items[1], 'herb')
  assert.equal(farm.state.coins, 0, '挪格不花钱')

  const removed = await store.shelfAction({ moveFrom: 2 })
  assert.equal(removed.ok, true)
  assert.equal(removed.shelf.items.includes('herb'), false, '取下的格子空了')
  assert.equal(farm.state.coins, 0, '取下不花钱')
})

test('陈列架挪格：目标格没解锁就报 locked，原样不动', async (t) => {
  const dir = await tempDir(t)
  const store = await createExpeditionStore(dir, { farm: fakeFarm(0), now: () => T0 })
  await store.shelfAction({ slot: 1, itemId: 'herb' })

  const result = await store.shelfAction({ moveFrom: 1, moveTo: 9 })
  assert.deepEqual(result, { ok: false, error: 'locked' })
  assert.equal(store.snapshot().shelf.items[0], 'herb')
})

test('陈列架重开进程后内容与格数都还在', async (t) => {
  const dir = await tempDir(t)
  const first = await createExpeditionStore(dir, { farm: fakeFarm(10000), now: () => T0 })
  await first.shelfAction({ slot: 9 })
  await first.shelfAction({ slot: 10 })
  await first.shelfAction({ slot: 9, itemId: 'herb' })
  first.dispose()

  const second = await createExpeditionStore(dir, { farm: fakeFarm(0), now: () => T0 })
  const shelf = second.snapshot().shelf
  assert.equal(shelf.slots, 10)
  assert.equal(shelf.items[8], 'herb')
})
