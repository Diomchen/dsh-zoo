import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DECISION_MS,
  LEG_MS,
  ROUTES,
  advanceRun,
  backRun,
  dangerOf,
  expireRun,
  legsFor,
  legCoins,
  normalizeRun,
  resumeRun,
  roll01,
  rollSouvenir,
  routeOf,
  settledOf,
  startRun,
  stepRun,
  sumCoins
} from '../src/expedition.js'

const T0 = 1_700_000_000_000

/** 一段「站在决策窗里」的 run；只填规则层会读的字段。 */
function decidingRun (runId, { leg = 1, totalLegs = 4, loot = [], until = T0 + 1000 } = {}) {
  return {
    id: runId,
    routeId: 'backhill',
    phase: 'deciding',
    leg,
    totalLegs,
    until,
    loot,
    startedAt: T0 - 60000,
    ended: null,
    endedAt: null,
    reason: null
  }
}

/**
 * 找一个在这一段会翻车（或不会）的 runId。
 * 用公共的 stepRun 去探，而不是照抄内部掷骰公式——测试只认「行为」。
 */
function probeRunId (predicate) {
  for (let i = 0; i < 20000; i += 1) {
    const id = 'probe-' + i
    if (predicate(id)) return id
  }
  throw new Error('没有找到满足条件的 runId')
}

/** 一条道走到黑：只用公共的行走/决策函数，看到哪一段翻车都算数。 */
function playRun (runId) {
  let run = startRun({ routeId: 'backhill', runId, now: T0 })
  for (let guard = 0; run.ended === null && guard < 10; guard += 1) {
    run = run.phase === 'walking' ? advanceRun(run, run.until).run : stepRun(run, run.until)
  }
  return run
}

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
  // 113 起每段都可能翻车，先挑一个一路平安的 runId 才能验「走满」。
  const runId = probeRunId((id) => playRun(id).ended === 'complete')
  const run = playRun(runId)
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

test('继续走会掷翻车：翻车立刻回家，段数不加、战利品不动、盘缠不退', () => {
  const failedId = probeRunId((id) => stepRun(decidingRun(id, { leg: 2 }), T0 + 2000)?.ended === 'failed')
  const run = decidingRun(failedId, { leg: 2, loot: [{ kind: 'coin', qty: 15 }] })
  const wiped = stepRun(run, T0 + 2000)
  assert.equal(wiped.phase, null)
  assert.equal(wiped.until, null)
  assert.equal(wiped.ended, 'failed')
  assert.equal(wiped.reason, 'wipeout')
  assert.equal(wiped.endedAt, T0 + 2000)
  assert.equal(wiped.leg, 2, '翻车不算走过这一段')
  assert.deepEqual(wiped.loot, [{ kind: 'coin', qty: 15 }])

  const settled = settledOf(wiped)
  assert.equal(settled.ended, 'failed')
  assert.equal(settled.reason, 'wipeout')
  assert.equal(settled.legs, 2)
  assert.equal(settled.coins, 15, '已捡的硬币照给')
  assert.equal(settled.fare, 500, '盘缠不退')

  // 同一 runId、同一段再掷一次，结果必须一样（不是 Math.random）。
  assert.deepEqual(stepRun(run, T0 + 2000), wiped)
})

test('翻车概率随已走段数递增，且每段就是 dangerOf 的那一档', () => {
  const runs = 6000
  const reached = new Map()
  const failed = new Map()
  for (let i = 0; i < runs; i += 1) {
    let run = startRun({ routeId: 'backhill', runId: 'sample-' + i, now: T0 })
    while (run.ended === null) {
      if (run.phase === 'walking') {
        run = advanceRun(run, run.until).run
        continue
      }
      const nextLeg = run.leg + 1
      reached.set(nextLeg, (reached.get(nextLeg) ?? 0) + 1)
      const next = stepRun(run, run.until)
      if (next.ended === 'failed') {
        failed.set(nextLeg, (failed.get(nextLeg) ?? 0) + 1)
        break
      }
      run = next
    }
  }
  const rate = (leg) => (failed.get(leg) ?? 0) / (reached.get(leg) ?? 1)
  const leg2 = rate(2)
  const leg3 = rate(3)
  const leg4 = rate(4)
  assert.ok(leg2 < leg3, `第 3 段应该比第 2 段险：${leg2} vs ${leg3}`)
  assert.ok(leg3 < leg4, `第 4 段应该比第 3 段险：${leg3} vs ${leg4}`)
  for (const leg of [2, 3, 4]) {
    const expected = dangerOf(ROUTES.backhill, leg)
    assert.ok(Math.abs(rate(leg) - expected) < 0.02, `第 ${leg} 段翻车率 ${rate(leg)} 离 ${expected} 太远`)
  }
})

test('同一 runId 完整重放：逐段掉落与结局完全一致', () => {
  const play = (runId) => {
    const trace = []
    let run = startRun({ routeId: 'backhill', runId, now: T0 })
    for (let guard = 0; run.ended === null && guard < 10; guard += 1) {
      if (run.phase === 'walking') {
        const event = advanceRun(run, run.until)
        trace.push({ leg: event.leg, coins: event.coins, phase: event.run.phase })
        run = event.run
      } else {
        run = stepRun(run, run.until)
        trace.push({ step: run.leg, ended: run.ended })
      }
    }
    return { trace, run }
  }
  for (const runId of ['replay-a', 'replay-b', 'replay-c']) {
    assert.deepEqual(play(runId), play(runId))
  }
})

test('决策窗超时自动折返：reason=timeout，只有到点才动', () => {
  const run = decidingRun('timeout-1', { loot: [{ kind: 'coin', qty: 12 }] })
  assert.equal(expireRun(run, run.until - 1), null)
  const home = expireRun(run, run.until)
  assert.equal(home.phase, null)
  assert.equal(home.until, null)
  assert.equal(home.ended, 'back')
  assert.equal(home.reason, 'timeout')
  assert.equal(home.endedAt, run.until)
  assert.deepEqual(home.loot, run.loot)
  assert.equal(settledOf(home).coins, 12, '超时折返不再回币')
  assert.equal(expireRun({ ...run, phase: 'walking' }, run.until + 1), null, '走路中不走超时这条路')
})

test('读档只推进一个节点：walking→deciding，deciding→回家，未到点原样', () => {
  const walking = startRun({ routeId: 'backhill', runId: 'resume-1', now: T0 })
  assert.equal(resumeRun(walking, T0 + 1000), null, '还没到点就不推进')

  const at = T0 + 90000
  const resumed = resumeRun(walking, at)
  assert.notEqual(resumed, null)
  assert.equal(resumed.run.phase, 'deciding')
  assert.equal(resumed.run.leg, 1, '只走完当前这一段')
  assert.equal(resumed.run.until, at + DECISION_MS, '新窗口用读档时刻算，不补离线时长')
  assert.equal(resumed.coins, legCoins(ROUTES.backhill, 'resume-1', 1))

  // 决策中到点再读档：直接回家，不补掷翻车。
  const deciding = resumed.run
  const home = resumeRun(deciding, deciding.until)
  assert.equal(home.run.ended, 'back')
  assert.equal(home.run.reason, 'timeout')
  assert.equal(home.coins, 0)
  assert.equal(resumeRun(deciding, deciding.until - 1), null)
  assert.equal(resumeRun(home.run, deciding.until + 1), null, '已经回家的趟不再推进')
})

test('normalizeRun 认翻车与超时原因，未知原因降级为 null', () => {
  const run = startRun({ routeId: 'backhill', runId: 'r-reason', now: T0 })
  const failed = { ...run, phase: null, until: null, ended: 'failed', endedAt: T0 + 1, reason: 'wipeout' }
  assert.deepEqual(normalizeRun(failed), failed)
  const timedOut = { ...failed, ended: 'back', reason: 'timeout' }
  assert.deepEqual(normalizeRun(timedOut), timedOut)
  assert.equal(normalizeRun({ ...failed, reason: 'whatever' }).reason, null)
})
