import assert from 'node:assert/strict'
import test from 'node:test'

import { STALE_KEEP_MS, streetFrom } from '../src/street.js'

const NOW = 1_700_000_000_000

function neighbor (overrides = {}) {
  return {
    deviceId: 'neighbor-a',
    nickname: '甲',
    status: 'allowed',
    lastSeen: NOW - 1000,
    port: 40001,
    heartbeatAt: NOW - 1000,
    ...overrides
  }
}

test('能去的邻居在名单里，带着它此刻在做什么', () => {
  const street = streetFrom({
    now: NOW,
    targets: [{ deviceId: 'neighbor-a', nickname: '老王' }],
    neighbors: [neighbor({ deviceId: 'neighbor-a', nickname: '老王' })],
    guests: [{ deviceId: 'neighbor-a', anim: 'idle', action: '改那个 bug', say: null }],
    recentSeen: []
  })

  assert.equal(street.length, 1)
  assert.deepEqual(street[0], {
    deviceId: 'neighbor-a',
    nickname: '老王',
    action: '改那个 bug',
    say: null,
    anim: 'idle',
    canVisit: true,
    blockedReason: null,
    lastSeen: NOW - 1000
  })
})

test('去不了的邻居也在街上，理由各不相同', () => {
  const street = streetFrom({
    now: NOW,
    targets: [],
    neighbors: [
      neighbor({ deviceId: 'n-pending', nickname: '楼下新来的', status: 'pending' }),
      neighbor({ deviceId: 'n-quiet', nickname: '小气鬼', heartbeatAt: 0 })
    ],
    guests: [],
    recentSeen: [{ deviceId: 'n-gone', nickname: '秃头哥', lastSeen: NOW - 60_000, status: 'allowed' }]
  })

  const byId = new Map(street.map((row) => [row.deviceId, row]))
  assert.equal(byId.get('n-pending').blockedReason, 'not-admitted')
  assert.equal(byId.get('n-quiet').blockedReason, 'not-mutual')
  assert.equal(byId.get('n-gone').blockedReason, 'peer-offline')
  for (const row of street) assert.equal(row.canVisit, false)
})

test('能去的排在前，各自按最后见过倒序，最多十六户', () => {
  const recentSeen = Array.from({ length: 20 }, (_, i) => ({
    deviceId: 'gone-' + i,
    nickname: '邻居' + i,
    lastSeen: NOW - (i + 1) * 1000,
    status: 'allowed'
  }))

  const street = streetFrom({
    now: NOW,
    targets: [
      { deviceId: 't-old', nickname: '老' },
      { deviceId: 't-new', nickname: '新' }
    ],
    neighbors: [
      neighbor({ deviceId: 't-old', lastSeen: NOW - 20_000 }),
      neighbor({ deviceId: 't-new', lastSeen: NOW - 1_000 })
    ],
    recentSeen
  })

  assert.equal(street.length, 16)
  assert.deepEqual(street.slice(0, 2).map((row) => row.deviceId), ['t-new', 't-old'])

  const blocked = street.slice(2)
  assert.equal(blocked[0].deviceId, 'gone-0')
  assert.deepEqual(
    blocked.map((row) => row.lastSeen),
    [...blocked.map((row) => row.lastSeen)].sort((a, b) => b - a)
  )
})

test('掉线超过十分钟就从街上消失，九分五十九秒还留着', () => {
  const street = streetFrom({
    now: NOW,
    recentSeen: [
      { deviceId: 'just-barely', nickname: '刚好', lastSeen: NOW - (STALE_KEEP_MS - 1000), status: 'allowed' },
      { deviceId: 'long-gone', nickname: '太久', lastSeen: NOW - (STALE_KEEP_MS + 1000), status: 'allowed' }
    ]
  })

  assert.deepEqual(street.map((row) => row.deviceId), ['just-barely'])
  assert.equal(street[0].blockedReason, 'peer-offline')
})

test('没放行的人就算是十分钟前见过，也只会说“还没放行你”，不会说掉线', () => {
  const street = streetFrom({
    now: NOW,
    recentSeen: [
      { deviceId: 'n-pending', nickname: '楼下新来的', lastSeen: NOW - 5 * 60 * 1000, status: 'pending' }
    ]
  })

  assert.equal(street.length, 1)
  assert.equal(street[0].blockedReason, 'not-admitted')
})
