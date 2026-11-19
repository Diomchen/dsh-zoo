/**
 * 票 114：32 件特产、掉落表与图鉴。
 *
 * 规则层只认「路线 + runId + 段号」，所以权重、同趟不重复与首次获得时间都能在这里
 * 用大样本/固定种子验证，不需要开窗口或写盘。落盘与 codex 的接线在 expedition-store.test.js。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  LEG_MS,
  advanceRun,
  codexView,
  halveSouvenirs,
  normalizeRun,
  recordSouvenir,
  RARITIES,
  rollSouvenir,
  settledOf,
  SOUVENIRS,
  SOUVENIRS_BY_ROUTE,
  SOUVENIR_IDS,
  startRun,
  stepRun,
  wipedOut
} from '../src/expedition.js'

const T0 = 1_700_000_000_000
const ROUTE_IDS = ['backhill', 'mine', 'railway', 'mistridge']
const RARITY_COUNTS = {
  backhill: { common: 5, rare: 2, precious: 1, legendary: 0 },
  mine: { common: 4, rare: 3, precious: 1, legendary: 0 },
  railway: { common: 3, rare: 4, precious: 1, legendary: 0 },
  mistridge: { common: 2, rare: 4, precious: 0, legendary: 2 }
}

/** 挑一个后山全程不翻车的 runId，让「每段都掉」的用例不受 113 的危险骰干扰。 */
function cleanBackhillRunId (prefix) {
  for (let index = 0; index < 10000; index += 1) {
    const id = prefix + '-' + index
    let clean = true
    for (let leg = 1; leg <= 4; leg += 1) {
      if (wipedOut({ id, routeId: 'backhill' }, leg)) {
        clean = false
        break
      }
    }
    if (clean) return id
  }
  throw new Error('找不到不翻车的 runId：' + prefix)
}

test('32 件特产按四条路线各 8 件，稀有度与手册战利品表一致', () => {
  assert.equal(SOUVENIR_IDS.length, 32)
  assert.equal(new Set(SOUVENIR_IDS).size, 32)
  assert.deepEqual(Object.keys(SOUVENIRS_BY_ROUTE), ROUTE_IDS)
  for (const routeId of ROUTE_IDS) {
    const pool = SOUVENIRS_BY_ROUTE[routeId]
    assert.equal(pool.length, 8, routeId + ' 应该有 8 件特产')
    const counts = { common: 0, rare: 0, precious: 0, legendary: 0 }
    for (const entry of pool) {
      assert.equal(entry.routeId, routeId)
      assert.ok(entry.name.length > 0, entry.id + ' 要有名字')
      assert.ok(entry.emoji.length > 0, entry.id + ' 要有 emoji 兜底')
      assert.equal(entry.art, 'souvenirs/' + entry.id + '.svg')
      assert.ok(RARITIES[entry.rarity], entry.id + ' 的稀有度不认识：' + entry.rarity)
      counts[entry.rarity] += 1
    }
    assert.deepEqual(counts, RARITY_COUNTS[routeId], routeId + ' 的稀有度数量')
  }
  assert.equal(RARITIES.common.weight, 30)
  assert.equal(RARITIES.rare.weight, 12)
  assert.equal(RARITIES.precious.weight, 4)
  assert.equal(RARITIES.legendary.weight, 1)
})

test('32 张 SVG 都真的在 desktop/souvenirs 下', async () => {
  for (const id of SOUVENIR_IDS) {
    const file = join(process.cwd(), 'desktop', 'souvenirs', id + '.svg')
    const body = await readFile(file, 'utf8')
    assert.ok(body.includes('<svg'), id + '.svg 应该是一张 SVG')
  }
})

test('掉落由 runId + 段号决定的随机数选出：可复现，且避开本趟已捡的', () => {
  for (const routeId of ROUTE_IDS) {
    for (const runId of ['r-a', 'r-b', 'r-c']) {
      const first = rollSouvenir(routeId, runId, 1, [])
      assert.ok(first !== null, '池子非空时应该掉一件')
      assert.equal(SOUVENIRS[first].routeId, routeId)
      assert.equal(first, rollSouvenir(routeId, runId, 1, []), '同一趟同一段必须复现')
    }
    const almost = SOUVENIRS_BY_ROUTE[routeId].slice(0, 7).map((entry) => entry.id)
    assert.equal(rollSouvenir(routeId, 'r-full', 1, almost), almost.length === 7
      ? SOUVENIRS_BY_ROUTE[routeId][7].id
      : null)
    assert.equal(rollSouvenir(routeId, 'r-full', 1, SOUVENIRS_BY_ROUTE[routeId].map((entry) => entry.id)), null)
  }
  assert.equal(rollSouvenir('nowhere', 'r', 1, []), null)
})

test('评审 C3：图鉴满 8 件后只掉没集齐的件，32 件集齐后不再掉已见过的件', () => {
  // 手册《出远门》的图鉴规则：满 8 件后掉落改为重掷其它未见过的件；全 32 件集齐后不再掉落
  // 已见过件（以前文档承诺「改发硬币 ×2」，代码里从来没有这回事，评审 C3 把两边对齐到这句）。
  const routeId = 'backhill'
  const pool = SOUVENIRS_BY_ROUTE[routeId]
  const ownedHalf = pool.slice(0, 4).map((entry) => entry.id)

  // 不满 8 件：老规矩，已拥有的件还可能再掉（早期重复是设计的一部分）。
  const early = new Set()
  for (let index = 0; index < 60; index += 1) {
    early.add(rollSouvenir(routeId, 'early-' + index, 1, [], ownedHalf))
  }

  // 满 8 件：池子里只要有没集齐的，就只掉没集齐的。
  const owned8 = [...ownedHalf, ...SOUVENIRS_BY_ROUTE.mine.slice(0, 4).map((entry) => entry.id)]
  assert.equal(owned8.length, 8)
  const fresh = pool.slice(4).map((entry) => entry.id)
  const late = new Set()
  for (let index = 0; index < 80; index += 1) {
    late.add(rollSouvenir(routeId, 'late-' + index, 1, [], owned8))
  }
  for (const id of late) assert.ok(fresh.includes(id), '满 8 件后不该再掉已集齐的 ' + id)

  // 32 件集齐：不再掉任何已见过的件（本路线全见过 → null，硬币照发）。
  assert.equal(rollSouvenir(routeId, 'all', 1, [], SOUVENIR_IDS), null)
  assert.equal(rollSouvenir('nowhere', 'r', 1, [], SOUVENIR_IDS), null)
})

test('权重分布：普通:稀有:珍稀:传说 ≈ 30:12:4:1（大样本，容差放宽）', () => {
  const samples = 2500
  for (const routeId of ROUTE_IDS) {
    const counts = new Map(SOUVENIRS_BY_ROUTE[routeId].map((entry) => [entry.id, 0]))
    for (let index = 0; index < samples; index += 1) {
      for (let leg = 1; leg <= 7; leg += 1) {
        const id = rollSouvenir(routeId, 'dist-' + index, leg, [])
        counts.set(id, counts.get(id) + 1)
      }
    }
    const average = (rarity) => {
      const pool = SOUVENIRS_BY_ROUTE[routeId].filter((entry) => entry.rarity === rarity)
      if (pool.length === 0) return null
      return pool.reduce((sum, entry) => sum + counts.get(entry.id), 0) / pool.length
    }
    const common = average('common')
    const rare = average('rare')
    const precious = average('precious')
    const legendary = average('legendary')
    if (rare !== null) {
      const ratio = common / rare
      assert.ok(ratio > 2.2 && ratio < 2.8, routeId + ' 普通/稀有权重比 ' + ratio.toFixed(2))
    }
    if (precious !== null) {
      const ratio = rare / precious
      assert.ok(ratio > 2.5 && ratio < 3.5, routeId + ' 稀有/珍稀权重比 ' + ratio.toFixed(2))
    }
    if (legendary !== null) {
      const ratio = common / legendary
      assert.ok(ratio > 25 && ratio < 35, routeId + ' 普通/传说权重比 ' + ratio.toFixed(2))
    }
  }
})

test('每段同时掉硬币与特产；一趟之内特产不重复，结算 items 就是它们', () => {
  for (const prefix of ['trip-a', 'trip-b', 'trip-c', 'trip-d']) {
    const runId = cleanBackhillRunId(prefix)
    let run = startRun({ routeId: 'backhill', runId, now: T0 })
    const seen = []
    for (let guard = 0; run.ended === null && guard < 10; guard += 1) {
      if (run.phase === 'walking') {
        const result = advanceRun(run, run.until)
        assert.notEqual(result, null)
        assert.ok(Number.isInteger(result.coins) && result.coins > 0)
        assert.ok(typeof result.souvenir === 'string', '每段都要报出掉了哪件特产')
        assert.equal(seen.includes(result.souvenir), false, '同一趟不能重复：' + result.souvenir)
        seen.push(result.souvenir)
        const souvenirs = result.run.loot.filter((item) => item.kind === 'souvenir')
        assert.deepEqual(souvenirs.map((item) => item.id), seen)
        run = result.run
      } else {
        run = stepRun(run, run.until)
      }
    }
    assert.equal(run.ended, 'complete')
    assert.equal(run.loot.length, run.totalLegs * 2, '每段一硬币一特产')
    assert.deepEqual(settledOf(run).items, seen)
    assert.equal(settledOf(run).coins, run.loot.filter((item) => item.kind === 'coin').reduce((sum, item) => sum + item.qty, 0))
  }
})

test('normalizeRun 接受本路线的特产，拒绝未知/跨路线/重复的掉落', () => {
  let run = startRun({ routeId: 'backhill', runId: 'normalize-souvenir', now: T0 })
  run = advanceRun(run, run.until).run
  const normalized = normalizeRun(run)
  assert.deepEqual(normalized, run)

  const souvenir = run.loot.find((item) => item.kind === 'souvenir')
  assert.ok(souvenir)
  const base = { ...run, phase: null, until: null, ended: 'back', endedAt: T0 + LEG_MS }
  assert.equal(normalizeRun({ ...base, loot: [{ kind: 'souvenir', id: 'not-a-souvenir' }] }), null)
  assert.equal(normalizeRun({ ...base, loot: [{ kind: 'souvenir', id: 'moonstone' }] }), null, '后山不能捡废矿的特产')
  assert.deepEqual(
    normalizeRun({ ...base, loot: [souvenir, souvenir] }).loot,
    [souvenir],
    '重复的同一件只留一次'
  )
})

test('图鉴视图固定 32 格，含 id/名称/稀有度/是否获得；codex 只记首次时间', () => {
  const empty = codexView({})
  assert.equal(empty.total, 32)
  assert.equal(empty.owned, 0)
  assert.equal(empty.slots.length, 32)
  assert.deepEqual(empty.slots.map((slot) => slot.id), SOUVENIR_IDS)
  for (const slot of empty.slots) {
    assert.equal(slot.name, SOUVENIRS[slot.id].name)
    assert.equal(slot.rarity, SOUVENIRS[slot.id].rarity)
    assert.ok(slot.rarityLabel.length > 0)
    assert.equal(slot.owned, false)
    assert.equal(slot.firstSeenAt, null)
    assert.equal(slot.label, '???')
    assert.equal(slot.art, 'souvenirs/' + slot.id + '.svg')
  }

  const view = codexView({ herb: T0, seal: T0 - 5 })
  assert.equal(view.owned, 2)
  const herb = view.slots.find((slot) => slot.id === 'herb')
  assert.equal(herb.owned, true)
  assert.equal(herb.firstSeenAt, T0)
  assert.equal(herb.name, '草药')
  assert.equal(herb.label, '草药')
  assert.equal(herb.rarityLabel, '普通')

  const first = recordSouvenir({}, 'herb', T0)
  assert.deepEqual(first, { herb: T0 })
  const repeat = recordSouvenir(first, 'herb', T0 + 999)
  assert.deepEqual(repeat, { herb: T0 }, '重复获得不能覆盖首次时间')
  assert.equal(recordSouvenir(first, 'not-a-souvenir', T0 + 1), first)
  assert.deepEqual(recordSouvenir(first, 'herb', Number.NaN), first)
})

test('翻车只丢一半特产：硬币原样保留、结果确定、不修改入参', () => {
  const loot = [
    { kind: 'coin', qty: 15 },
    { kind: 'souvenir', id: 'herb' },
    { kind: 'coin', qty: 17 },
    { kind: 'souvenir', id: 'shard' },
    { kind: 'souvenir', id: 'egg' },
    { kind: 'souvenir', id: 'hawthorn' }
  ]
  const before = JSON.parse(JSON.stringify(loot))
  const kept = halveSouvenirs(loot, 'run-failed')
  assert.deepEqual(loot, before, '不能改调用方的战利品')
  assert.equal(kept.filter((item) => item.kind === 'coin').length, 2, '硬币不参与减半')
  assert.equal(kept.filter((item) => item.kind === 'souvenir').length, 2, '4 件特产丢一半')
  assert.deepEqual(kept, halveSouvenirs(loot, 'run-failed'), '同一趟重放结果一致')
  assert.deepEqual(halveSouvenirs([], 'x'), [])
  assert.deepEqual(halveSouvenirs([{ kind: 'coin', qty: 3 }], 'x'), [{ kind: 'coin', qty: 3 }])
})

test('113 的翻车分支接上减半：同一趟只留一半特产，硬币与盘缠规则不变', () => {
  const loot = [
    { kind: 'coin', qty: 15 },
    { kind: 'souvenir', id: 'herb' },
    { kind: 'souvenir', id: 'shard' },
    { kind: 'coin', qty: 17 },
    { kind: 'souvenir', id: 'egg' },
    { kind: 'souvenir', id: 'hawthorn' }
  ]
  const before = JSON.parse(JSON.stringify(loot))
  let wiped = null
  for (let index = 0; index < 4000 && wiped === null; index += 1) {
    const candidate = {
      id: 'wipeout-halve-' + index,
      routeId: 'backhill',
      phase: 'deciding',
      leg: 2,
      totalLegs: 4,
      until: T0,
      loot
    }
    const next = stepRun(candidate, T0 + 1000)
    if (next !== null && next.ended === 'failed') wiped = next
  }
  assert.ok(wiped !== null, '应该能找到一个翻车的 runId')
  assert.equal(wiped.reason, 'wipeout')
  assert.equal(wiped.loot.filter((item) => item.kind === 'coin').length, 2, '硬币照给')
  assert.equal(wiped.loot.filter((item) => item.kind === 'souvenir').length, 2, '4 件特产只留 2 件')
  assert.deepEqual(loot, before, '规则层不能改调用方的 run.loot')
  assert.equal(settledOf(wiped).items.length, 2, '结算只报留下的特产')
  assert.equal(settledOf(wiped).coins, 32)
  assert.equal(settledOf(wiped).fare, 500)
})
