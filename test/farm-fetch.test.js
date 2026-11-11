/**
 * 票 43：访客宿主拉主人的农场快照（`src/farm-fetch.js`）。
 *
 * 纯函数 + 注入 fetch：不起真实 HTTP，只验“2 秒超时 / 64 KiB / 只私网 / 冷却 60 秒 / 404=结束”
 * 以及白名单重建（绝不回传 stolenBy/helpedBy 原数组）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  FARM_FETCH_COOLDOWN_MS,
  FARM_FETCH_TIMEOUT_MS,
  MAX_FARM_VIEW_BYTES,
  createFarmFetcher,
  normalizeOpenView,
  normalizeVisitView
} from '../src/farm-fetch.js'

function viewPayload (visitId, overrides = {}) {
  return {
    v: 1,
    visitId,
    host: { nickname: '楼上的柯基' },
    guard: 0.3,
    guardParts: { ownerHome: true, worker: false },
    plots: [
      { id: 'p1', crop: 'tomato', stage: 'mature', mature: true, remainingMs: 0, stolenByMe: false, helpedByMe: false },
      { id: 'p2', crop: 'carrot', stage: 'growing', mature: false, remainingMs: 1200, stolenByMe: true, helpedByMe: false }
    ],
    limits: {
      steal: { perVisit: 3, usedInVisit: 0, perFarm: 5, usedOnFarm: 1 },
      help: { perVisit: 3, usedInVisit: 0, perFarm: 5, usedOnFarm: 0 }
    },
    hire: { enabled: true, wagePerHour: 12, minHours: 2, maxHours: 6 },
    market: {
      prices: { tomato: { base: 5, price: 6, volume24h: 2, bid: 5 } },
      index: { tomato: { price: 5.5, at: 1700000000000, samples: 2, stale: false } }
    },
    at: 1700000000000,
    ...overrides
  }
}

function response (body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers })
}

test('get：200 → view；404 → gone；其它状态 → refused（且按 address:port 冷却）', async () => {
  const visitId = randomUUID()
  let calls = 0
  let mode = 'ok'
  const fetcher = createFarmFetcher({
    fetchImpl: async () => {
      calls += 1
      if (mode === 'gone') return response('not found', { status: 404 })
      if (mode === 'refused') return response('nope', { status: 500 })
      return response(JSON.stringify(viewPayload(visitId)))
    },
    now: () => 1000
  })

  const hit = await fetcher.get({ address: '127.0.0.1', port: 45873, visitId })
  assert.equal(hit.ok, true)
  assert.equal(hit.view.visitId, visitId)

  mode = 'gone'
  assert.deepEqual(await fetcher.get({ address: '127.0.0.1', port: 45873, visitId }), {
    ok: false,
    error: 'gone'
  })
  // 404 之后同一台邻居冷却：不再打。
  assert.deepEqual(await fetcher.get({ address: '127.0.0.1', port: 45873, visitId }), {
    ok: false,
    error: 'refused'
  })
  assert.equal(calls, 2)
})

test('get：只私网/回环；坏 port/visitId 直接 refused/no-port；冷却到期后重试', async () => {
  let now = 0
  let calls = 0
  const fetcher = createFarmFetcher({
    fetchImpl: async () => {
      calls += 1
      return response('nope', { status: 500 })
    },
    now: () => now
  })
  const visitId = randomUUID()
  assert.deepEqual(await fetcher.get({ address: '8.8.8.8', port: 80, visitId }), { ok: false, error: 'refused' })
  assert.deepEqual(await fetcher.get({ address: 'example.com', port: 80, visitId }), { ok: false, error: 'refused' })
  assert.deepEqual(await fetcher.get({ address: '127.0.0.1', port: 0, visitId }), { ok: false, error: 'no-port' })
  assert.deepEqual(await fetcher.get({ address: '127.0.0.1', port: 45873, visitId: 'x' }), { ok: false, error: 'refused' })
  assert.equal(calls, 0)

  assert.equal((await fetcher.get({ address: '192.168.1.5', port: 45873, visitId })).error, 'refused')
  assert.equal(calls, 1)
  await fetcher.get({ address: '192.168.1.5', port: 45873, visitId })
  assert.equal(calls, 1, '冷却期内不再打')
  now = FARM_FETCH_COOLDOWN_MS
  await fetcher.get({ address: '192.168.1.5', port: 45873, visitId })
  assert.equal(calls, 2, '冷却到期后重试')
})

test('get：2 秒超时、64 KiB 上限、坏 JSON / 坏形状', async () => {
  const visitId = randomUUID()
  const base = { now: () => 0 }

  const slow = createFarmFetcher({
    ...base,
    timeoutMs: 20,
    fetchImpl: () => new Promise(() => {})
  })
  assert.deepEqual(await slow.get({ address: '127.0.0.1', port: 45873, visitId }), {
    ok: false,
    error: 'timeout'
  })

  const large = createFarmFetcher({
    ...base,
    maxBytes: 64,
    fetchImpl: async () => response('x'.repeat(100))
  })
  assert.deepEqual(await large.get({ address: '127.0.0.1', port: 45873, visitId }), {
    ok: false,
    error: 'too-large'
  })

  const badJson = createFarmFetcher({ ...base, fetchImpl: async () => response('{oops') })
  assert.equal((await badJson.get({ address: '127.0.0.1', port: 45873, visitId })).error, 'bad-json')

  const badShape = createFarmFetcher({ ...base, fetchImpl: async () => response('{"v":1}') })
  assert.equal((await badShape.get({ address: '127.0.0.1', port: 45873, visitId })).error, 'bad-shape')

  // 常量与 SPEC 同口径。
  assert.equal(FARM_FETCH_TIMEOUT_MS, 2000)
  assert.equal(MAX_FARM_VIEW_BYTES, 64 * 1024)
})

test('normalizeVisitView：只输出 stolenByMe/helpedByMe 布尔，绝不泄露别人的 deviceId', () => {
  const visitId = randomUUID()
  const otherA = randomUUID()
  const otherB = randomUUID()
  const view = normalizeVisitView(viewPayload(visitId, {
    host: { nickname: '  楼上 的柯基 ', deviceId: otherA },
    guard: 9,
    plots: [
      {
        id: 'p1',
        crop: 'tomato',
        stage: 'mature',
        mature: true,
        remainingMs: -5,
        stolenBy: [otherA, otherB],
        helpedBy: [otherB],
        stolenByMe: true,
        helpedByMe: false
      },
      { id: 'p9', crop: 'tomato', stolenBy: [otherA] },
      { id: 'p51', crop: 'tomato', stolenBy: [otherA] },
      { id: 'p2', crop: 'alien', stolenByMe: true }
    ],
    market: {
      prices: { tomato: { base: 5, price: 6, volume24h: 2, bid: 5 }, alien: { price: 1 } },
      history: [{ crop: 'tomato', side: 'sell', qty: 1, price: 5, at: 1 }]
    }
  }))
  assert.equal(view.visitId, visitId)
  assert.equal(view.host.nickname, '楼上 的柯基')
  assert.equal(view.guard, 0.8)
  // p9 合法、p51 越界、p2 的作物认不出 → 只留 p1 与 p9；不再补 p1–p4。
  assert.equal(view.plots.length, 2)
  assert.deepEqual(view.plots.map((plot) => plot.id), ['p1', 'p9'])
  assert.deepEqual(view.plots[0], {
    id: 'p1',
    crop: 'tomato',
    stage: 'mature',
    mature: true,
    remainingMs: 0,
    stolenByMe: true,
    helpedByMe: false
  })
  const text = JSON.stringify(view)
  assert.equal(text.includes(otherA), false)
  assert.equal(text.includes(otherB), false)
  assert.equal(text.includes('stolenBy"'), false)
  assert.equal(text.includes('helpedBy"'), false)
  assert.equal(text.includes('"path"'), false)
  assert.equal('history' in view.market, false)
  assert.equal('alien' in view.market.prices, false)

  assert.equal(normalizeVisitView(null), null)
  assert.equal(normalizeVisitView({ ...viewPayload(visitId), visitId: 'nope' }), null)
})

test('v1.1 邻居只发 4 块：新访客原样显示 4 块，不补也不截', () => {
  const plots = ['p1', 'p2', 'p3', 'p4'].map((id) => ({
    id,
    crop: id === 'p2' ? null : 'tomato',
    stage: id === 'p2' ? 'empty' : 'mature',
    mature: id !== 'p2',
    remainingMs: 0,
    stolenByMe: false,
    helpedByMe: false
  }))
  const view = normalizeVisitView(viewPayload(randomUUID(), { plots }))
  assert.deepEqual(view.plots.map((plot) => plot.id), ['p1', 'p2', 'p3', 'p4'])
})

test('open：打到 /open/<viewerId>，白名单重建，硬币与多余字段进不来', async () => {
  const host = '11111111-1111-4111-8111-111111111111'
  const viewer = '22222222-2222-4222-8222-222222222222'
  let seenUrl = null
  const fetcher = createFarmFetcher({
    fetchImpl: async (url) => {
      seenUrl = url
      return response(JSON.stringify({
        v: 1,
        deviceId: host,
        host: { nickname: '小黄' },
        guard: 0.3,
        guardParts: { ownerHome: true, worker: false },
        plots: [{ id: 'p1', crop: 'tomato', stage: 'mature', mature: true, remainingMs: 0 }],
        quotas: { perTrip: 3, perTripLeft: 2 },
        caps: ['raid', 'look', 'nope'],
        // 远端塞进来的多余字段：一律不进结果
        coins: 999,
        crops: { tomato: 5 }
      }))
    }
  })

  const result = await fetcher.open({ address: '127.0.0.1', port: 45873, deviceId: viewer })
  assert.equal(result.ok, true)
  assert.ok(seenUrl.endsWith('/dsh-zoo-farm/open/' + viewer), seenUrl)
  assert.equal(result.view.deviceId, host)
  assert.deepEqual(result.view.caps, ['raid', 'look'])
  assert.equal(result.view.quotas.perTripLeft, 2)
  assert.equal(result.view.coins, undefined)
  assert.equal(result.view.crops, undefined)

  // 视图不合法 = bad-shape，并且进冷却
  const broken = createFarmFetcher({ fetchImpl: async () => response('{"deviceId":"nope"}') })
  assert.deepEqual(await broken.open({ address: '127.0.0.1', port: 45873, deviceId: viewer }), {
    ok: false,
    error: 'bad-shape'
  })
})
