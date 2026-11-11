/**
 * 票 52/54：`mode:'look'` 这条窄口。窗口只认白名单：多一个字段都进不来，
 * 少一个必须的（deviceId）整条拒掉。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import shared from '../desktop/shared.js'

const VIEWER = '22222222-2222-4222-8222-222222222222'

function lookPayload (overrides = {}) {
  return {
    open: true,
    mode: 'look',
    look: {
      deviceId: VIEWER,
      host: { nickname: '小黄' },
      guard: 0.3,
      quotas: { perTrip: 3, perTripLeft: 2 },
      plots: [
        { id: 'p1', crop: 'tomato', stage: 'mature', mature: true, remainingMs: 0, stolenByMe: false },
        { id: 'p2', crop: null, stage: 'empty', mature: false, remainingMs: 0 }
      ],
      // 多余字段：不该出现在结果里
      coins: 999,
      crops: { tomato: 3 },
      ...overrides
    }
  }
}

test('look 窗口：认 mode、白名单重建、多余字段丢掉', () => {
  const view = shared.normalizeFarmWindow(lookPayload())
  assert.equal(view.mode, 'look')
  assert.equal(view.look.deviceId, VIEWER)
  assert.equal(view.look.nickname, '小黄')
  assert.equal(view.look.guard, 0.3)
  assert.deepEqual(view.look.quotas, { perTrip: 3, perTripLeft: 2 })
  assert.deepEqual(view.look.plots.map((plot) => plot.id), ['p1', 'p2'])
  assert.equal(view.look.plots[0].mature, true)
  assert.equal(view.look.coins, undefined)
  assert.equal(view.look.crops, undefined)
})

test('look 窗口：没有 deviceId 就整条拒掉，退回 owner', () => {
  const view = shared.normalizeFarmWindow(lookPayload({ deviceId: undefined }))
  assert.equal(view.mode, 'owner')
  assert.equal(view.look, undefined)
})

test('farm-raid 的窄口：deviceId 必填，plots 可选且只认 pN', () => {
  const ok = shared.normalizeFarmAction({ action: 'farm-raid', deviceId: VIEWER })
  assert.deepEqual(ok, { action: 'farm-raid', deviceId: VIEWER })

  const withPlots = shared.normalizeFarmAction({ action: 'farm-raid', deviceId: VIEWER, plots: ['p1', 'p2', 'p1'] })
  assert.deepEqual(withPlots, { action: 'farm-raid', deviceId: VIEWER, plots: ['p1', 'p2'] })

  assert.equal(shared.normalizeFarmAction({ action: 'farm-raid' }), null)
  assert.equal(shared.normalizeFarmAction({ action: 'farm-raid', deviceId: VIEWER, plots: 'p1' }), null)
  assert.equal(shared.normalizeFarmAction({ action: 'farm-raid', deviceId: VIEWER, plots: ['pX'] }), null)

  assert.deepEqual(
    shared.normalizeFarmAction({ action: 'farm-look', deviceId: VIEWER }),
    { action: 'farm-look', deviceId: VIEWER }
  )
})

test('邻居切换器：只认 uuid + 昵称，重复与坏条目丢掉，最多 8 个', () => {
  const view = shared.normalizeFarmWindow({
    open: true,
    mode: 'owner',
    neighbors: [
      { deviceId: VIEWER, nickname: '鱼姐', canRaid: true },
      { deviceId: VIEWER, nickname: '重复的鱼姐' },
      { deviceId: 'not-a-uuid', nickname: '坏的' },
      { deviceId: '44444444-4444-4444-8444-444444444444', nickname: '  ' }
    ]
  })
  assert.equal(view.neighbors.length, 2)
  assert.equal(view.neighbors[0].deviceId, VIEWER)
  assert.equal(view.neighbors[0].canRaid, true)
  assert.equal(view.neighbors[1].nickname, '邻居', '空昵称回落到「邻居」')
})

test('邻居切换器：没有就给空数组，绝不 undefined', () => {
  assert.deepEqual(shared.normalizeFarmWindow({ open: true }).neighbors, [])
})

test('邻居切换器：≤3 铺圆片，>3 收进胶囊；排序按"能偷的熟地"', () => {
  const view = shared.normalizeFarmWindow({
    open: true,
    mode: 'owner',
    neighbors: [
      { deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nickname: '一飞', ripePlots: 0, guard: 0.3 },
      { deviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', nickname: '鱼姐', ripePlots: 2, guard: 0.8 },
      { deviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', nickname: '吾鲸', old: true }
    ]
  })
  assert.equal(view.neighbors[1].ripePlots, 2)
  assert.equal(view.neighbors[1].guard, 0.8)
  assert.equal(view.neighbors[2].old, true)
})
