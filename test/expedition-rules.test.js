import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DECISION_MS,
  LEG_MS,
  ROUTES,
  advanceRun,
  backRun,
  dangerOf,
  legsFor,
  legCoins,
  normalizeRun,
  roll01,
  rollSouvenir,
  routeOf,
  settledOf,
  startRun,
  stepRun,
  sumCoins
} from '../src/expedition.js'

const T0 = 1_700_000_000_000

/** 后山一趟的段数由 runId 决定：这段取样要同时看到 3 段和 4 段。 */
const RUN_IDS = Array.from({ length: 200 }, (_, i) => 'run-' + String(i))

test('后山是唯一路线：500 盘缠、3–4 段、每段回币 3% 带 25% 抖动', () => {
  const route = routeOf('backhill')
  assert.equal(route, ROUTES.backhill)
  assert.equal(route.name, '后山')
  assert.equal(route.fare, 500)
  assert.equal(route.minLegs, 3)
  assert.equal(route.maxLegs, 4)
  assert.equal(route.coinRate, 0.03)
  assert.equal(route.coinJitter, 0.25)
  assert.equal(routeOf('mine'), null)
  assert.equal(routeOf(null), null)
})

test('段数只落在 3–4，且两个值都出现', () => {
  const seen = new Set()
  for (const runId of RUN_IDS) {
    const legs = legsFor(ROUTES.backhill, runId)
    assert.ok(Number.isInteger(legs), '段数必须是整数')
    assert.ok(legs === 3 || legs === 4, '段数必须落在 3–4：' + legs)
    seen.add(legs)
  }
  assert.deepEqual([...seen].sort(), [3, 4])
})

test('同一个 runId 的段数与每段回币可复现，不靠 Math.random', () => {
  for (const runId of RUN_IDS.slice(0, 20)) {
    assert.equal(legsFor(ROUTES.backhill, runId), legsFor(ROUTES.backhill, runId))
    assert.equal(legCoins(ROUTES.backhill, runId, 1), legCoins(ROUTES.backhill, runId, 1))
  }
  const totals = new Set(RUN_IDS.map((runId) => legsFor(ROUTES.backhill, runId)))
  assert.equal(totals.size, 2, '不同的 runId 至少能派出两档段数')
})

test('每段回币落在 round(500×3%)=15 的 ±25% 内', () => {
  const seen = new Set()
  for (const runId of RUN_IDS) {
    for (let leg = 1; leg <= 4; leg += 1) {
      const coins = legCoins(ROUTES.backhill, runId, leg)
      assert.ok(Number.isInteger(coins), '回币必须是整数')
      assert.ok(coins >= 11 && coins <= 19, '回币越界：' + coins)
      seen.add(coins)
    }
  }
  assert.ok(seen.has(11), '抖动下沿要真的出现过')
  assert.ok(seen.has(19), '抖动上沿要真的出现过')
})

test('roll01 由参数派生，落在 [0,1)', () => {
  for (const runId of RUN_IDS.slice(0, 50)) {
    const value = roll01(runId, 'probe')
    assert.ok(value >= 0 && value < 1, 'roll01 越界：' + value)
    assert.equal(value, roll01(runId, 'probe'))
  }
})

test('出发：第 1 段 walking，20 秒后到点', () => {
  const run = startRun({ routeId: 'backhill', runId: 'r-start', now: T0 })
  assert.equal(run.id, 'r-start')
  assert.equal(run.routeId, 'backhill')
  assert.equal(run.phase, 'walking')
  assert.equal(run.leg, 1)
  assert.equal(run.totalLegs, legsFor(ROUTES.backhill, 'r-start'))
  assert.equal(run.until, T0 + LEG_MS)
  assert.equal(run.startedAt, T0)
  assert.equal(run.ended, null)
  assert.deepEqual(run.loot, [])
  assert.equal(startRun({ routeId: 'nowhere', runId: 'r', now: T0 }), null)
})

test('早于 until 不推进；到点掉一笔回币并进入决策窗', () => {
  const run = startRun({ routeId: 'backhill', runId: 'r-advance', now: T0 })
  assert.equal(advanceRun(run, T0 + LEG_MS - 1), null)

  const at = T0 + LEG_MS
  const result = advanceRun(run, at)
  assert.equal(result.leg, 1)
  assert.equal(result.coins, legCoins(ROUTES.backhill, 'r-advance', 1))
  assert.equal(result.run.phase, 'deciding')
  assert.equal(result.run.leg, 1)
  assert.equal(result.run.until, at + DECISION_MS)
  assert.deepEqual(result.run.loot, [
    { kind: 'coin', qty: result.coins },
    { kind: 'souvenir', id: rollSouvenir('backhill', 'r-advance', 1, []) }
  ])
  assert.equal(result.souvenir, rollSouvenir('backhill', 'r-advance', 1, []))

  // 决策窗里再 tick 不会重复掉币（112 不做超时自动折返）。
  assert.equal(advanceRun(result.run, at + DECISION_MS - 1), null)
})

test('继续走：只有 deciding 能走，段数 +1 并重新走 20 秒', () => {
  const run = startRun({ routeId: 'backhill', runId: 'r-step', now: T0 })
  assert.equal(stepRun(run, T0), null, '走路途中不能再走一段')

  const decided = advanceRun(run, T0 + LEG_MS).run
  const next = stepRun(decided, T0 + LEG_MS + 1000)
  assert.equal(next.phase, 'walking')
  assert.equal(next.leg, 2)
  assert.equal(next.until, T0 + LEG_MS + 1000 + LEG_MS)
  assert.equal(next.loot.length, 2)
})

test('见好就收：只有 deciding 能收，只认已走段数的钱', () => {
  const run = startRun({ routeId: 'backhill', runId: 'r-back', now: T0 })
  assert.equal(backRun(run, T0), null, '还没走完第一段时不能折返')

  const first = advanceRun(run, T0 + LEG_MS)
  const stepped = stepRun(first.run, T0 + LEG_MS + 1000)
  const second = advanceRun(stepped, stepped.until)
  const home = backRun(second.run, second.run.until + 100)
  assert.equal(home.phase, null)
  assert.equal(home.ended, 'back')
  assert.equal(home.until, null)

  const settled = settledOf(home)
  assert.equal(settled.fare, 500)
  assert.equal(settled.legs, 2)
  assert.equal(settled.coins, sumCoins(home.loot))
  assert.deepEqual(settled.items, home.loot.filter((item) => item.kind === 'souvenir').map((item) => item.id))
  assert.equal(settled.items.length, 2)
  assert.equal(settled.ended, 'back')
})

test('走满最后一段自动回家，标记 complete，战利品按段数齐', () => {
  let run = startRun({ routeId: 'backhill', runId: 'r-complete', now: T0 })
  for (let guard = 0; run.ended === null && guard < 10; guard += 1) {
    if (run.phase === 'walking') {
      const result = advanceRun(run, run.until)
      assert.notEqual(result, null)
      run = result.run
    } else {
      run = stepRun(run, run.until)
    }
  }
  assert.equal(run.phase, null)
  assert.equal(run.ended, 'complete')
  assert.equal(run.loot.length, run.totalLegs * 2)
  assert.equal(settledOf(run).items.length, run.totalLegs)
  assert.equal(settledOf(run).legs, run.totalLegs)
  assert.equal(settledOf(run).coins, sumCoins(run.loot))
})

test('危险度 = 基础 5% + 每段 3%', () => {
  assert.equal(dangerOf(ROUTES.backhill, 1), 0.05)
  assert.equal(dangerOf(ROUTES.backhill, 2), 0.08)
  assert.equal(dangerOf(ROUTES.backhill, 3), 0.11)
})

test('normalizeRun 只接受形状完整的 run', () => {
  const run = startRun({ routeId: 'backhill', runId: 'r-normalize', now: T0 })
  assert.deepEqual(normalizeRun(run), run)
  assert.equal(normalizeRun(null), null)
  assert.equal(normalizeRun({}), null)
  assert.equal(normalizeRun({ ...run, routeId: 'nowhere' }), null)
  assert.equal(normalizeRun({ ...run, leg: 0 }), null)
  assert.equal(normalizeRun({ ...run, leg: run.totalLegs + 1 }), null)
  assert.equal(normalizeRun({ ...run, phase: 'walking', ended: 'back' }), null)
  assert.equal(normalizeRun({ ...run, loot: [{ kind: 'coin', qty: -1 }] }), null)
  // 已结束的趟保留在文件里，重启后还能显示上一趟的结果。
  const ended = { ...run, phase: null, until: null, ended: 'back', endedAt: T0 + 1 }
  assert.deepEqual(normalizeRun(ended), ended)
})
