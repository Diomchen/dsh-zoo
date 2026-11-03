import assert from 'node:assert/strict'
import test from 'node:test'

import { createRoom } from '../src/room.js'
import { STALE_KEEP_MS } from '../src/street.js'

const T0 = 1_700_000_000_000
const PEER = '11111111-1111-4111-8111-111111111111'

function makeRoom () {
  let now = T0
  const room = createRoom({ clock: () => now })
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  return { room, setNow: (value) => { now = value } }
}

test('心跳里的动作名活到街上的那一户', () => {
  const { room } = makeRoom()
  room.observeBeacon({ deviceId: PEER, nickname: '老王', port: 40001 }, T0)
  room.admit(PEER)
  room.observeHeartbeat({ deviceId: PEER, anim: 'idle', action: '改那个 bug', say: null }, T0 + 1000)

  const street = room.snapshot().street
  assert.equal(street.length, 1)
  assert.equal(street[0].deviceId, PEER)
  assert.equal(street[0].nickname, '老王')
  assert.equal(street[0].action, '改那个 bug')
  assert.equal(street[0].canVisit, true)
  assert.equal(street[0].blockedReason, null)
})

test('掉线十分钟内还灰在街上，过了十分钟才走', () => {
  const { room, setNow } = makeRoom()
  room.observeBeacon({ deviceId: PEER, nickname: '老王', port: 40001 }, T0)
  room.admit(PEER)
  room.observeHeartbeat({ deviceId: PEER, anim: 'idle', action: '改那个 bug' }, T0)

  // 40 秒后：邻居表 30 秒就清人，但街上还得留着他。
  setNow(T0 + 40_000)
  room.tick()
  const stale = room.snapshot().street
  assert.equal(stale.length, 1)
  assert.equal(stale[0].canVisit, false)
  assert.equal(stale[0].blockedReason, 'peer-offline')

  // 十分钟零一秒后：他终于从街上消失了。
  setNow(T0 + STALE_KEEP_MS + 1000)
  room.tick()
  assert.deepEqual(room.snapshot().street, [])
})

test('心跳里的动作名是脏的，就丢掉那个字段，人和那一户都还在', () => {
  const { room } = makeRoom()
  room.observeBeacon({ deviceId: PEER, nickname: '老王', port: 40001 }, T0)
  room.admit(PEER)
  room.observeHeartbeat({ deviceId: PEER, anim: 'idle', action: '../etc/passwd' }, T0 + 1000)

  const street = room.snapshot().street
  assert.equal(street.length, 1)
  assert.equal(street[0].action, null)
  assert.equal(street[0].anim, 'idle')
})
