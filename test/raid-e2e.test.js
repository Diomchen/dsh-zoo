/**
 * 票 53：派它去偷（一行程、一个邻居、一趟额度）。
 *
 * 用票 50 的 harness：两只真宠物、真 UDP、真 HTTP。**不建立放行关系**——
 * ADR-0018 之后偷菜不需要它；这文件里的每一条都跑在"没放行"的前提下。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { startPair, until } from '../scripts/lib/pet.mjs'

/** 一来一回：亮的这一会儿设成 0，测试不用等。 */
function pairWith (overrides = {}) {
  return startPair({
    a: { raidVisibleMs: 0, ...overrides.a },
    b: { mature: { p1: 'tomato', p2: 'carrot' }, ...overrides.b }
  })
}

async function discover (pair) {
  await until(async () => (await pair.a.state()).neighbors.some((n) => n.deviceId === pair.b.deviceId), {
    label: 'A 认识 B'
  })
  await until(async () => (await pair.b.state()).neighbors.some((n) => n.deviceId === pair.a.deviceId), {
    label: 'B 认识 A'
  })
}

test('不放行也能派它去偷：作物进自家仓库，主人在日志里看见是谁', async (t) => {
  // 这一条要**看见**那只偷客：亮 2 秒再回家，不然刚抵达就被 recall 收走了。
  const pair = await pairWith({ a: { raidVisibleMs: 2000 }, b: { farmRandom: () => 1 } })
  t.after(() => pair.close())
  await discover(pair)

  const raid = await pair.a.action('farm-raid', { deviceId: pair.b.deviceId })
  assert.equal(raid.body.ok, true, JSON.stringify(raid.body))
  assert.equal(raid.body.action, 'farm-raid')

  // 不带 plots = 由主人挑"能偷的都偷"：p1 番茄 + p2 胡萝卜都在这一趟里。
  await until(async () => {
    const crops = (await pair.a.state()).farm.crops
    return (crops.tomato ?? 0) + (crops.carrot ?? 0) === 2
  }, { label: '偷到的作物进了 A 的仓库' })

  const host = await pair.b.state()
  const steals = host.farm.log.filter((item) => item.kind === 'steal')
  assert.equal(steals.length, 2, '两块熟地各记一条')
  assert.ok(steals.every((item) => item.qty === 1))

  // 主人桌面上那只宠物是「偷客」，不是普通访客。
  assert.deepEqual(host.visitors.map((visitor) => visitor.kind), ['raid'])
  assert.equal(host.visitors[0].deviceId, pair.a.deviceId)

  // 回家之后：状态归位，记录标成 raid。
  await until(async () => (await pair.a.state()).self.out === null, { label: 'A 回家了', timeoutMs: 8000 })
  const mine = await pair.a.state()
  assert.equal(mine.visits[0]?.kind, 'raid')
  assert.equal(mine.visits[0]?.direction, 'out')

  // 回家 = 主人那边的偷客也立刻走（recall 必须走上免放行的出口，
  // 否则那只宠物要在人家桌面上待满 60 秒），并且两边都留一条 raid 记录。
  await until(async () => (await pair.b.state()).visitors.length === 0, { label: 'B 的偷客也走了' })
  assert.equal((await pair.b.state()).visits[0]?.kind, 'raid')
})

test('守卫抓住：这一块白跑，主人的日志 qty 是 0', async (t) => {
  const pair = await pairWith({ b: { farmRandom: () => 0 } })
  t.after(() => pair.close())
  await discover(pair)

  await pair.a.action('farm-raid', { deviceId: pair.b.deviceId })
  await until(async () => (await pair.b.state()).farm.log.some((item) => item.kind === 'steal'), {
    label: 'B 的日志里出现这次尝试'
  })

  const host = await pair.b.state()
  const entry = host.farm.log.find((item) => item.kind === 'steal')
  assert.equal(entry.qty, 0, '被抓住不产出作物，但记一笔')
  assert.equal((await pair.a.state()).farm.crops.tomato ?? 0, 0, 'A 什么也没拿到')

  // 被抓也是"一趟"：它照样到点回家（这条曾经因为收尾路径抛异常而永远不回来）。
  await until(async () => (await pair.a.state()).self.out === null, { label: '被抓住也照样回家' })
})

test('老版本邻居：没广告 raid 就明确回 old-neighbor，不派出去', async (t) => {
  // `caps` 传空数组 = 只会串门的老版本。
  const pair = await startPair({ b: { mature: { p1: 'tomato' }, caps: [] } })
  t.after(() => pair.close())
  await discover(pair)

  const raid = await pair.a.action('farm-raid', { deviceId: pair.b.deviceId })
  assert.equal(raid.body.ok, false)
  assert.equal(raid.body.error, 'old-neighbor')
  assert.equal((await pair.a.state()).self.out, null, '没有出门')
})

test('一趟只偷一个邻居：指定 plots 时只碰那几块', async (t) => {
  const pair = await pairWith({ b: { farmRandom: () => 1 } })
  t.after(() => pair.close())
  await discover(pair)

  await pair.a.action('farm-raid', { deviceId: pair.b.deviceId, plots: ['p2'] })
  await until(async () => ((await pair.a.state()).farm.crops.carrot ?? 0) === 1, { label: '偷到胡萝卜' })

  const mine = await pair.a.state()
  assert.equal(mine.farm.crops.tomato ?? 0, 0, '没点名的地不动')
  const host = await pair.b.state()
  const p1 = host.farm.plots.find((plot) => plot.id === 'p1')
  const p2 = host.farm.plots.find((plot) => plot.id === 'p2')
  assert.deepEqual(p2.stolenBy, [pair.a.deviceId])
  assert.deepEqual(p1.stolenBy, [], 'p1 还是干净的')
})
