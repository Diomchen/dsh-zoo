/**
 * 票 79：红包能力守卫。
 *
 * 1.6.5 之前的接收端会把不认识的 `kind:'packet'` 整件丢掉，串门却照常成功——
 * 发件方看到「送出去了」，红包和里面的东西静默蒸发。所以发件前先看对方声明。
 *
 * 这里用一对**真 service**（回环 UDP + 真 HTTP）走完整链路：
 * 老邻居（caps 里没有 packet）→ 红包留在背包；新邻居（声明了 packet）→ 正常送到。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { CAPS, normalizeCaps, supportsPacket } from '../src/protocol.js'
import { startPair, until } from '../scripts/lib/pet.mjs'

const OLD_CAPS = ['raid', 'look', 'crops']

test('能力声明：packet 在 CAPS 里，老邻居按「不认识红包」处理', () => {
  assert.ok(CAPS.includes('packet'), 'CAPS 应该声明 packet')
  assert.deepEqual(normalizeCaps(['raid', 'look', 'crops', 'packet']), ['raid', 'look', 'crops', 'packet'])
  assert.equal(supportsPacket(['raid', 'look', 'crops', 'packet']), true)
  assert.equal(supportsPacket(OLD_CAPS), false)
  assert.equal(supportsPacket(undefined), false)
  assert.equal(supportsPacket(null), false)
  assert.equal(supportsPacket('packet'), false)
})

/**
 * 让 A 认识 B 并且互相放行；返回时两边都已经是 allowed。
 */
async function befriend (a, b) {
  await until(async () => {
    const [sa, sb] = await Promise.all([a.state(), b.state()])
    return sa.neighbors.some((n) => n.deviceId === b.deviceId) &&
      sb.neighbors.some((n) => n.deviceId === a.deviceId)
  }, { label: '互相发现', timeoutMs: 15000 })
  await a.action('admit', { deviceId: b.deviceId })
  await b.action('admit', { deviceId: a.deviceId })
  await until(async () => {
    const sa = await a.state()
    return sa.neighbors.some((n) => n.deviceId === b.deviceId && n.status === 'allowed')
  }, { label: 'A 放行 B', timeoutMs: 15000 })
}

test('老邻居收不了红包：红包留在背包，这次空手去', async (t) => {
  const pair = await startPair({ b: { caps: OLD_CAPS } })
  t.after(() => pair.close())
  const { a, b } = pair
  await befriend(a, b)

  // A 必须真的看到「老邻居」的能力声明，守卫才有依据。
  await until(async () => {
    const sa = await a.state()
    const peer = sa.neighbors.find((n) => n.deviceId === b.deviceId)
    return peer !== undefined && Array.isArray(peer.caps) && !peer.caps.includes('packet')
  }, { label: 'A 看到老能力声明', timeoutMs: 15000 })

  const brought = await a.action('bring', {
    kind: 'packet',
    packet: { coins: 5, crops: {}, seeds: {} },
    note: ''
  })
  assert.equal(brought.body.ok, true, JSON.stringify(brought.body))
  const giftId = brought.body.giftId

  const visit = await a.action('visit', { deviceId: b.deviceId })
  assert.equal(visit.body.ok, true, JSON.stringify(visit.body))
  assert.equal(visit.body.packetHeld, true, '红包应该被扣下')
  assert.match(String(visit.body.notice ?? ''), /红包/)
  assert.equal(visit.body.giftId, undefined, '这次不该带任何礼物上路')

  const sa = await a.state()
  const kept = (sa.backpack ?? []).find((item) => item.id === giftId)
  assert.ok(kept, '红包应该还在背包里')
  assert.equal(kept.kind, 'packet')
  assert.equal(kept.state, 'idle')

  // 对方那边不该出现红包礼物。
  await until(async () => {
    const sb = await b.state()
    return !(sb.gifts ?? []).some((g) => g.kind === 'packet')
  }, { label: 'B 没有收到红包', timeoutMs: 8000 })
})

test('新邻居声明了 packet：红包照常送到，并能拆开', async (t) => {
  const pair = await startPair()
  t.after(() => pair.close())
  const { a, b } = pair
  await befriend(a, b)

  await until(async () => {
    const sa = await a.state()
    const peer = sa.neighbors.find((n) => n.deviceId === b.deviceId)
    return peer !== undefined && Array.isArray(peer.caps) && peer.caps.includes('packet')
  }, { label: 'A 看到新能力声明', timeoutMs: 15000 })

  const brought = await a.action('bring', {
    kind: 'packet',
    packet: { coins: 5, crops: {}, seeds: {} },
    note: ''
  })
  assert.equal(brought.body.ok, true, JSON.stringify(brought.body))

  const visit = await a.action('visit', { deviceId: b.deviceId })
  assert.equal(visit.body.ok, true, JSON.stringify(visit.body))
  assert.notEqual(visit.body.packetHeld, true, '新邻居不该被扣红包')
  assert.equal(typeof visit.body.giftId, 'string')

  const gift = await until(async () => {
    const sb = await b.state()
    return (sb.gifts ?? []).find((g) => g.kind === 'packet') ?? false
  }, { label: 'B 收到 packet', timeoutMs: 20000 })
  assert.equal(gift.packet.coins, 5)

  const before = (await b.state()).farm.coins
  const claimed = await b.action('gift-claim', { giftId: gift.id })
  assert.equal(claimed.body.ok, true, JSON.stringify(claimed.body))
  const after = (await b.state()).farm.coins
  assert.equal(after, before + 5, '拆开后硬币应该到账')
})
