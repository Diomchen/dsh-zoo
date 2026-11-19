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

const NEXT_MINUTE = NOW + 60_000

function expeditionState (overrides = {}) {
  return {
    codex: { herb: NEXT_MINUTE, oddstone: NEXT_MINUTE + 1 },
    codexView: { total: 32, owned: 2, slots: [] },
    shelf: { slots: 8, items: ['herb', null, 'oddstone'] },
    logs: [
      { at: NOW - 3000, routeId: 'backhill', legs: 7, title: '第一趟', body: '正文秘密甲' },
      { at: NOW - 2000, routeId: 'backhill', legs: 9, title: '第二趟', body: '正文秘密乙' },
      { at: NOW - 1000, routeId: 'backhill', legs: 11, title: '第三趟', body: '正文秘密丙' },
      { at: NOW, routeId: 'backhill', legs: 12, title: '第四趟', body: '正文秘密丁' }
    ],
    ...overrides
  }
}

test('公开视图：只给地块、守卫和请求者自己的次数', () => {
  const out = view()
  assert.deepEqual(Object.keys(out).sort(), [
    'at', 'caps', 'deviceId', 'expedition', 'guard', 'guardParts', 'host', 'plots', 'quotas', 'v'
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

test('票 120：公开视图的远征块只给图鉴件数、前 8 格和日志标题/时间', () => {
  const out = view({ expedition: expeditionState() })
  assert.deepEqual(out.expedition.codex, { owned: 2, total: 32 })
  assert.equal(out.expedition.shelf.length, 8)
  assert.deepEqual(out.expedition.shelf[0], { id: 'herb', name: '草药', emoji: '🌿' })
  assert.equal(out.expedition.shelf[1], null)
  assert.deepEqual(out.expedition.shelf[2], { id: 'oddstone', name: '怪石', emoji: '🪨' })
  assert.equal(out.expedition.shelf[7], null)
  assert.deepEqual(out.expedition.logs, [
    { title: '第一趟', at: NOW - 3000 },
    { title: '第二趟', at: NOW - 2000 },
    { title: '第三趟', at: NOW - 1000 }
  ])

  // 任何正文、路线、段数、图鉴时间戳都不许出现在序列化结果里。
  const json = JSON.stringify(out)
  assert.ok(!json.includes('正文秘密'), '日志正文不能出现')
  assert.ok(!json.includes('backhill'), '路线不能出现')
  assert.ok(!json.includes(String(NEXT_MINUTE)), '图鉴时间戳不能出现')
})

test('票 120：未开格的摆放和超长内容不进公开视图', () => {
  const out = view({
    expedition: expeditionState({
      shelf: {
        slots: 8,
        // 第 9 件及以后是没开的格：即便状态里混进了，也只能出现在前 8 格之外。
        items: ['herb', null, null, null, null, null, null, null, 'oddstone', 'herb'],
        locked: ['oddstone']
      },
      codex: { herb: NEXT_MINUTE, 'not-a-souvenir': NEXT_MINUTE },
      logs: [
        { at: NOW, title: '  ', body: '空标题不算' },
        { at: 'yesterday', title: '坏时间', body: '坏时间不算' },
        { at: NOW - 5, title: '好', body: '正文' },
        { at: NOW - 4, title: '也好', body: '正文' },
        { at: NOW - 3, title: '还好', body: '正文' }
      ]
    })
  })
  assert.deepEqual(out.expedition.shelf.slice(1), [null, null, null, null, null, null, null])
  assert.equal(out.expedition.codex.owned, 1, '未知图鉴条目不计入')
  assert.deepEqual(out.expedition.logs.map((entry) => entry.title), ['好', '也好', '还好'])
  const json = JSON.stringify(out)
  assert.ok(!json.includes('怪石'), '没开格的特产不能出现')
  assert.ok(!json.includes('not-a-souvenir'))
})

test('票 120：对方没玩过时给零值远征块，不报错', () => {
  const zero = { codex: { owned: 0, total: 32 }, shelf: Array.from({ length: 8 }, () => null), logs: [] }
  assert.deepEqual(view().expedition, zero)
  assert.deepEqual(view({ expedition: null }).expedition, zero)
  assert.deepEqual(view({ expedition: { shelf: 'broken', logs: {}, codex: [] } }).expedition, zero)
})

test('票 120：只有串门视图问的时候才带日志正文', () => {
  const quiet = view({ expedition: expeditionState() })
  assert.ok(!JSON.stringify(quiet).includes('正文秘密'))
  const loud = view({ expedition: expeditionState(), expeditionLogBodies: true })
  assert.equal(loud.expedition.logs[0].body, '正文秘密甲')
  assert.deepEqual(Object.keys(loud.expedition.logs[0]).sort(), ['at', 'body', 'title'])
})
