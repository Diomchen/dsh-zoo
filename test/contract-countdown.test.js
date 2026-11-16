/**
 * 票 61：雇工页的合同倒计时必须按真实时间走，而且不能倒流。
 *
 * 症状（ticket 47.1 的同一条毛病，当时只修了地块）：
 *   1. `tickContracts` 每拍固定减 1000ms——渲染进程被后台节流/长任务延迟时，
 *      倒计时就慢下来（时间不准）；
 *   2. `contractRow` 每次都拿**快照那一刻**的 remainingMs 重建，而 `renderHire()`
 *      会因为切页/任何一次重画再跑一遍——倒计时于是被拽回旧值（时间倒流）。
 *
 * 这个测试把真的 `desktop/farm.js` 放进替身 DOM 里跑（不是读源码做正则），
 * 用可控时钟模拟「阻塞 5 秒只跑了一拍」和「切走 3 秒再回来」。
 * 替身 DOM 本身在 `test/fixtures/farm-renderer.js`（票 52 的看田回归共用同一份）。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { bootFarm } from './fixtures/farm-renderer.js'

const require = createRequire(import.meta.url)
const farmView = require('../desktop/farm-view.js')

const CONTRACT_ID = '11111111-1111-4111-8111-111111111111'

function contractState (remainingMs) {
  return {
    farm: {
      unlocked: 4,
      maxPlots: 50,
      nextCost: 60,
      plots: [
        { id: 'p1', crop: 'tomato', stage: 'growing', mature: false, remainingMs: 30 * 60 * 1000, waterings: 0, fertilized: false }
      ],
      seeds: { tomato: 2, carrot: 0, pumpkin: 0 },
      crops: { tomato: 0, carrot: 0, pumpkin: 0 },
      coins: 30,
      dew: 5,
      worker: null,
      contractCount: 1,
      hire: { enabled: true, wagePerHour: 10, minHours: 2, maxHours: 8 },
      guard: 0.8,
      log: [],
      carried: []
    },
    market: { prices: {}, index: {}, history: [] },
    crops: null,
    contracts: {
      outgoing: [{
        id: CONTRACT_ID,
        workerNickname: '阿蟹',
        hours: 2,
        wagePerHour: 10,
        wage: 20,
        fee: 1,
        status: 'active',
        earned: 0,
        remainingMs,
        settled: false
      }],
      incoming: [],
      listings: [],
      pendingHire: false
    },
    mode: 'owner',
    visit: null,
    look: null,
    neighbors: [],
    plotId: null
  }
}

test('倒计时纯函数：按真实时间走，时钟被调到过去也不往回涨', () => {
  assert.equal(farmView.remainingAt(90_000, 1000, 3000), 88_000, '过了 2 秒就少 2 秒')
  assert.equal(farmView.remainingAt(90_000, 1000, 500), 90_000, 'now 早于基线（时钟被调回去）只停在原值')
  assert.equal(farmView.remainingAt(90_000, 1000, 100_000), 0, '不能出现负数')
  assert.equal(farmView.remainingAt(undefined, undefined, 5000, 1234), 1234, '老快照没有基线时退回 remainingMs')
  assert.equal(farmView.remainingAt(undefined, undefined, 5000), 0, '什么都没有就是 0，不是 NaN')
})

/** 从「还剩 1 分 30 秒 · 托管 20 · 手续费 1」里取剩余秒数。 */
function remainingSeconds (text) {
  assert.equal(typeof text, 'string', '合同行应该画出剩余时间：' + String(text))
  const hours = /(\d+)\s*小时/.exec(text)
  const minutes = /(\d+)\s*分/.exec(text)
  const seconds = /(\d+)\s*秒/.exec(text)
  assert.ok(hours !== null || minutes !== null || seconds !== null, '应该能读出剩余时间：' + text)
  return (hours === null ? 0 : Number(hours[1]) * 3600) +
    (minutes === null ? 0 : Number(minutes[1]) * 60) +
    (seconds === null ? 0 : Number(seconds[1]))
}

/** 合同行的元信息节点（「还剩 … · 托管 … · 手续费 …」）。 */
function metaText (harness) {
  const el = harness.find((node) => node.dataset?.contractMeta === CONTRACT_ID)
  return el === null ? null : el.textContent
}

function bootHiredFarm (remainingMs = 90 * 1000) {
  const harness = bootFarm()
  harness.pushState(contractState(remainingMs))
  harness.clickTab('hire')
  return harness
}

test('合同倒计时：渲染进程被阻塞 5 秒，倒计时也要走 5 秒', () => {
  const harness = bootHiredFarm(90 * 1000)
  assert.ok(remainingSeconds(metaText(harness)) >= 89, '刚推下来应该从 90 秒左右开始')

  // 阻塞 5 秒：期间只跑到一拍（setInterval 被延迟/合并），然后才 tick。
  harness.advance(5000)
  harness.tick()

  const left = remainingSeconds(metaText(harness))
  assert.ok(left <= 86, '真实过去了 5 秒，剩余应该 ≈85 秒，实际 ' + left + ' 秒')
  assert.ok(left >= 84, '不能多减也不能少减太多，实际 ' + left + ' 秒')
})

test('合同倒计时：切走再切回来不会倒流', () => {
  const harness = bootHiredFarm(90 * 1000)
  harness.advance(3000)
  harness.tick()
  const before = remainingSeconds(metaText(harness))

  // 用户在农场页待了 20 秒，再切回雇工页：重画不能让倒计时退回快照值。
  harness.clickTab('farm')
  harness.advance(20000)
  harness.clickTab('hire')
  const after = remainingSeconds(metaText(harness))

  assert.ok(after <= before - 19, '切走 20 秒，回来应该少 20 秒左右：' + before + 's → ' + after + 's')
})

test('合同倒计时：走到 0 请宿主确认，不自己编状态', () => {
  const harness = bootHiredFarm(2000)
  harness.advance(5000)
  harness.tick()

  assert.ok(harness.submits.some((entry) => entry.action === 'farm-refresh'),
    '到点应该请宿主重推一份 state（合同结没结束只有宿主知道）')
  // 窗口不能自己把行改成「已结束」：那要等宿主的 status。
  const text = metaText(harness)
  assert.equal(typeof text, 'string')
  assert.equal(/已结束|已结算|已取消/.test(text), false, '窗口不能自己宣布合同结束：' + text)
  assert.match(text, /马上结束/, '停在「马上结束」等宿主：' + text)
})
