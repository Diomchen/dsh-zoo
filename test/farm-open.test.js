/**
 * 票 52：公开只读视图（`/dsh-zoo-farm/open/<viewerId>` 的载荷）。
 *
 * 这是**白名单重建**，不是裁剪：调用方给原始农场状态，这里只造出允许外发的那几个字段。
 * 硬约束（每条都有断言）：
 *   - 不给仓库、硬币、种子、挂牌、行情；
 *   - 不给别人的 deviceId（`stolenByMe` 只回答"我自己有没有偷过"）；
 *   - 不给任何路径；
 *   - 坏地块只丢那一块，不整包失败。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { openFarmView } from '../src/farm-open.js'
import { CROPS } from '../src/farm-rules.js'

const HOST = '11111111-1111-4111-8111-111111111111'
const VIEWER = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'
const NOW = 1_700_000_000_000

function plot (id, crop, { mature = false, stolenBy = [], helpedBy = [] } = {}) {
  if (crop === null) {
    return { id, crop: null, plantedAt: null, grownMs: 0, growMs: 0, waterings: 0, fertilized: false, stolenBy: [], helpedBy: [] }
  }
  const growMs = CROPS[crop].growMs
  return {
    id,
    crop,
    plantedAt: NOW - (mature ? growMs : 1000),
    grownMs: mature ? growMs : 1000,
    growMs,
    waterings: 0,
    fertilized: false,
    stolenBy,
    helpedBy
  }
}

function view (overrides = {}) {
  return openFarmView({
    viewerDeviceId: VIEWER,
    host: { deviceId: HOST, nickname: '小黄' },
    plots: [plot('p1', 'tomato', { mature: true }), plot('p2', 'carrot')],
    unlocked: 4,
    guard: 0.3,
    guardParts: { ownerHome: true, worker: false },
    usedByViewer: 1,
    caps: ['raid', 'look'],
    now: NOW,
    ...overrides
  })
}

test('公开视图：只给地块、守卫和请求者自己的次数', () => {
  const out = view()
  assert.deepEqual(Object.keys(out).sort(), [
    'at', 'caps', 'deviceId', 'guard', 'guardParts', 'host', 'plots', 'quotas', 'v'
  ])
  assert.equal(out.v, 1)
  assert.equal(out.deviceId, HOST)
  assert.deepEqual(out.host, { nickname: '小黄' })

  assert.equal(out.plots.length, 2)
  assert.deepEqual(out.plots[0], {
    id: 'p1',
    crop: 'tomato',
    stage: 'mature',
    mature: true,
    remainingMs: 0,
    stolenByMe: false,
    helpedByMe: false
  })
  assert.equal(out.plots[1].stage, 'growing')
  assert.ok(out.plots[1].remainingMs > 0)

  // 4 块地：每趟 3 个（旧 perVisit 的公式），已经用掉 1 个。
  assert.equal(out.quotas.perTrip, 3)
  assert.equal(out.quotas.perTripLeft, 2)
})

test('脱敏：别人的 deviceId、仓库、硬币、路径都不出现', () => {
  const out = view({
    plots: [plot('p1', 'tomato', { mature: true, stolenBy: [OTHER], helpedBy: [OTHER] })],
    // 调用方多塞的字段一律不进视图
    coins: 999,
    crops: { tomato: 12 },
    seeds: { tomato: 3 },
    hire: { enabled: true },
    market: { prices: {} },
    dir: '/Users/someone/.dsh/dsh-zoo'
  })
  const json = JSON.stringify(out)
  assert.ok(!json.includes(OTHER), '别人的 deviceId 不能出现')
  assert.ok(!json.includes('999'), '硬币不能出现')
  assert.ok(!json.includes('.dsh'), '路径不能出现')
  assert.equal(out.coins, undefined)
  assert.equal(out.crops, undefined)
  assert.equal(out.hire, undefined)

  // 别人偷过 ≠ 我偷过。
  assert.equal(out.plots[0].stolenByMe, false)
  assert.equal(out.plots[0].helpedByMe, false)
})

test('stolenByMe 只认请求者自己', () => {
  const out = view({ plots: [plot('p1', 'tomato', { mature: true, stolenBy: [VIEWER] })] })
  assert.equal(out.plots[0].stolenByMe, true)
})

test('坏地块只丢那一块，不整包失败', () => {
  const broken = { id: 'p2', crop: 'banana', plantedAt: NOW, grownMs: 0, growMs: 1, stolenBy: [], helpedBy: [] }
  const out = view({ plots: [plot('p1', 'tomato', { mature: true }), broken, { id: 'pX' }, null] })
  assert.deepEqual(out.plots.map((entry) => entry.id), ['p1'])
})

test('最多 50 块，且按 pN 排序', () => {
  const many = Array.from({ length: 60 }, (_, index) => plot(`p${index + 1}`, 'tomato'))
  const out = view({ plots: many.reverse(), unlocked: 50 })
  assert.equal(out.plots.length, 50)
  assert.equal(out.plots[0].id, 'p1')
  assert.equal(out.plots[49].id, 'p50')
})
