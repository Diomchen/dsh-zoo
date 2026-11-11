/**
 * 票 50：单机双宠物 harness。
 *
 * 这是**这个 harness 自己的**验收，不是农场规则的验收——成熟度/守卫/上限/工资
 * 由 `test/farm-visit-e2e.test.js` / `test/work-e2e.test.js` 覆盖。
 * 这里只回答一件事：一台机器上，那两条链能不能真的走一遍。
 *
 * 断言全部过 `startPair()` 一个接口（action / state 是真 HTTP），不碰内部。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { startPair, until } from '../scripts/lib/pet.mjs'

test('两只宠物在回环上互相发现', async (t) => {
  const pair = await startPair()
  t.after(() => pair.close())

  assert.match(pair.a.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.match(pair.a.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.notEqual(pair.a.baseUrl, pair.b.baseUrl)

  const state = await pair.a.state()
  assert.equal(state.version, 1)
  assert.equal(state.self.deviceId, pair.a.deviceId)

  await knowEachOther(pair)
})

test('A 能串门到 B 家：放行之后出门，抵达后 B 的访客表里有 A', async (t) => {
  const pair = await startPair()
  t.after(() => pair.close())
  await admitBoth(pair)
  await visit(pair)

  const atHome = await pair.b.state()
  assert.equal(atHome.visitors.length, 1)
  assert.equal(atHome.visitors[0].deviceId, pair.a.deviceId)
})

test('A 在 B 家偷菜：真 UDP、真农场规则', async (t) => {
  // B 的 p1 开局就是熟的（场景布置）；`farmRandom: () => 1` 让守卫那一掷不掷出「被抓」。
  const pair = await startPair({ b: { mature: { p1: 'tomato' }, farmRandom: () => 1 } })
  t.after(() => pair.close())
  await admitBoth(pair)
  await visit(pair)

  const steal = await pair.a.action('farm-steal', { plotId: 'p1' })
  assert.equal(steal.body.ok, true, JSON.stringify(steal.body))
  assert.equal(steal.body.crop, 'tomato')
  assert.equal(steal.body.qty, 1)

  const host = await pair.b.state()
  assert.ok(host.farm.log.some((entry) => entry.kind === 'steal'), 'B 的农场日志里应该多一条被偷记录')
})

test('A 雇 B 看家：挂牌 → 雇佣 → 提前结束 → 两边结算一致', async (t) => {
  const pair = await startPair()
  t.after(() => pair.close())
  await admitBoth(pair)

  // 挂牌会立刻 force 一次行情摘要（`src/service.js:1752`），所以 A 不用等 30 秒那一拍。
  const listed = await pair.b.action('hire-listing', { enabled: true, wagePerHour: 10, minHours: 2, maxHours: 8 })
  assert.equal(listed.body.ok, true, JSON.stringify(listed.body))

  // 挂牌是一次 UDP 广播，`worker-unavailable` 只代表 A 还没收到那份摘要——重试即可；
  // 别的错误立刻炸出来，别把真失败拖成超时。
  const hired = await until(async () => {
    const result = await pair.a.action('hire', { deviceId: pair.b.deviceId, hours: 2 })
    if (result.body.ok === true) return result
    if (result.body.error === 'worker-unavailable') return false
    assert.fail('雇佣失败：' + JSON.stringify(result.body))
  }, { label: 'A 收到 B 的挂牌并雇到它', timeoutMs: 8000 })

  const employer = await pair.a.state()
  assert.equal(employer.contracts.outgoing.length, 1)
  assert.equal(employer.contracts.outgoing[0].status, 'active')
  assert.equal(employer.farm.guard, 0.8, '主人在家 0.3 + 雇工 0.5')
  assert.notEqual(employer.worker, null, 'A 的桌面上应该出现雇工')

  const workerHome = await pair.b.state()
  assert.equal(workerHome.contracts.incoming.length, 1)
  assert.equal(workerHome.contracts.incoming[0].status, 'active')
  assert.notEqual(workerHome.self.work, null, 'B 的宠物应该显示「在外打工」')
  assert.equal(workerHome.farm.guard, 0, '宠物在外打工时自家守卫是 0')

  const ended = await pair.a.action('end-contract', { contractId: employer.contracts.outgoing[0].id })
  assert.equal(ended.body.ok, true, JSON.stringify(ended.body))

  await until(async () => (await pair.a.state()).contracts.outgoing.every((entry) => entry.settled === true), {
    label: 'A 侧合同结算完成'
  })
  await until(async () => (await pair.b.state()).contracts.incoming.every((entry) => entry.settled === true), {
    label: 'B 侧合同结算完成'
  })
})

test('不用放行也能看邻居的农场（票 52）', async (t) => {
  const pair = await startPair({ b: { mature: { p1: 'tomato' } } })
  t.after(() => pair.close())
  // 只要求"发现"，不放行：看田不需要 admit。
  await knowEachOther(pair)

  // 对方的 LAN 端口是异步起来的，而 `farm-fetch` 失败一次就冷却 60 秒——第一次别抢跑。
  await new Promise((resolve) => setTimeout(resolve, 400))
  // `no-port` / `refused` 都当"还没好"，再重试几拍。
  const looked = await until(async () => {
    const result = await pair.a.action('farm-look', { deviceId: pair.b.deviceId })
    if (result.body.ok === true) return result
    if (result.body.error === 'no-port' || result.body.error === 'refused') {
      throw new Error('看田还没好：' + JSON.stringify(result.body))
    }
    assert.fail('看田失败：' + JSON.stringify(result.body))
  }, { label: 'A 看到 B 的农场' })

  const view = looked.body.view
  assert.equal(view.deviceId, pair.b.deviceId)
  assert.deepEqual(view.plots.map((plot) => plot.id), ['p1', 'p2', 'p3', 'p4'])
  assert.equal(view.plots[0].mature, true)
  assert.equal(view.quotas.perTrip, 3)
  assert.equal(view.coins, undefined, '主人的仓库/硬币不出门')
  assert.equal(view.crops, undefined)
})

/** 两只都出现在对方的邻居表里：所有动作的前提。 */
async function knowEachOther (pair) {
  await until(async () => (await pair.a.state()).neighbors.some((n) => n.deviceId === pair.b.deviceId), {
    label: 'A 的邻居表里出现 B'
  })
  await until(async () => (await pair.b.state()).neighbors.some((n) => n.deviceId === pair.a.deviceId), {
    label: 'B 的邻居表里出现 A'
  })
}

/** 互相放行：不是串门的前提，但 `mayTalkTo` 要它（雇工那条路一定会撞上）。 */
async function admitBoth (pair) {
  await knowEachOther(pair)
  const out = await pair.a.action('admit', { deviceId: pair.b.deviceId })
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true)
  const back = await pair.b.action('admit', { deviceId: pair.a.deviceId })
  assert.equal(back.body.ok, true)
}

/** A 出门到 B 家，等到两边都承认这次串门。 */
async function visit (pair) {
  const visit = await pair.a.action('visit', { deviceId: pair.b.deviceId })
  assert.equal(visit.body.ok, true, JSON.stringify(visit.body))
  await until(async () => (await pair.a.state()).self.out?.phase === 'active', { label: 'A 抵达 B 家' })
  await until(async () => (await pair.b.state()).visitors.length === 1, { label: 'B 的访客表里有 A' })
}
