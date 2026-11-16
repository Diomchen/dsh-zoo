/**
 * 票 52 回归（渲染端）：看田窗口里，"到点确认"与"切回我的农场"必须是两件事。
 *
 * 现场：看田窗口每"稍微看一下"就自己跳回自己农场。宿主那一半（刷新按 `self.out`
 * 重算模式）由 `test/farm-look-refresh.test.js` 盯着；这里盯窗口这一半：
 *
 *   1. 看田时的倒计时必须走 `look.plots`（邻居家）。以前走的是**自家** `farm.plots`，
 *      于是自家作物一熟就发一次 `farm-refresh`——而宿主把 `farm-refresh` 当成
 *      "回我的农场"，窗口就被自己踢回去了；
 *   2. 邻居家作物到点仍然只发 `farm-refresh`（保持看田），绝不发 `farm-own`；
 *   3. 顶部「我的农场」圆片发的必须是 `farm-own`（唯一出口）。
 *
 * 跑的是真的 `desktop/farm.js`（替身 DOM，可控时钟），不是读源码做正则。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { bootFarm } from './fixtures/farm-renderer.js'

const NEIGHBOR = '22222222-2222-4222-8222-222222222222'
const MINUTE = 60 * 1000

function plot (overrides = {}) {
  return {
    id: 'p1',
    crop: 'tomato',
    stage: 'growing',
    mature: false,
    remainingMs: 30 * MINUTE,
    waterings: 0,
    fertilized: false,
    ...overrides
  }
}

/** 看田模式的一包：`farm` 是自家的，`look` 是邻居家的；两块地故意用同一个 id（p1）。 */
function lookState ({ mineMs, theirsMs, mode = 'look' } = {}) {
  return {
    farm: {
      unlocked: 4,
      maxPlots: 50,
      nextCost: 60,
      plots: [plot({ id: 'p1', remainingMs: mineMs })],
      seeds: { tomato: 2 },
      crops: { tomato: 0 },
      coins: 30,
      dew: 5,
      worker: null,
      contractCount: 0,
      hire: { enabled: false, wagePerHour: 10, minHours: 2, maxHours: 8 },
      guard: 0.3,
      log: [],
      carried: []
    },
    market: null,
    crops: null,
    contracts: null,
    mode,
    visit: null,
    look: mode === 'look'
      ? {
          deviceId: NEIGHBOR,
          nickname: '小黄',
          guard: 0.3,
          quotas: { perTrip: 3, perTripLeft: 2 },
          plots: [plot({ id: 'p1', remainingMs: theirsMs })]
        }
      : null,
    neighbors: [],
    plotId: null
  }
}

test('看田：自家作物到点不再发任何动作（倒计时走邻居家那份）', () => {
  const harness = bootFarm()
  const state = lookState({ mineMs: 2000, theirsMs: 30 * MINUTE })
  harness.pushState(state)

  harness.advance(5000)
  harness.tick()

  assert.deepEqual(harness.submits, [], '看田时自家作物到点不该请宿主刷新——那会被当成"回我的农场"')
  assert.equal(state.farm.plots[0].remainingMs, 2000, '自家的地块不该被看田窗口的 tick 改')
  assert.ok(state.look.plots[0].remainingMs <= 30 * MINUTE - 5000, '邻居家的倒计时才该往前走')
})

test('看田：邻居家作物到点只请宿主重推（farm-refresh），不自己宣布成熟', () => {
  const harness = bootFarm()
  const state = lookState({ mineMs: 30 * MINUTE, theirsMs: 2000 })
  harness.pushState(state)

  harness.advance(5000)
  harness.tick()

  const actions = harness.submits.map((entry) => entry.action)
  assert.ok(actions.includes('farm-refresh'), '到点应该请宿主重推一份邻居视图，实际：' + JSON.stringify(actions))
  assert.equal(actions.includes('farm-own'), false, '不能顺手把窗口切回自己农场')
  assert.equal(state.look.plots[0].remainingMs, 0, '倒计时停在 0')
  assert.equal(state.look.plots[0].stage, 'growing', '熟没熟只认宿主的 stage，窗口不自己标')
})

test('看田：「我的农场」圆片发 farm-own（切回自己农场的唯一出口）', () => {
  const harness = bootFarm()
  harness.pushState(lookState({ mineMs: 30 * MINUTE, theirsMs: 30 * MINUTE }))

  const chip = harness.find((node) =>
    node.tagName === 'BUTTON' && node.dataset?.own === 'true' && node.className === 'nn-chip')
  assert.ok(chip !== null, '看田模式下应该画出「我的农场」圆片')
  assert.equal(chip.disabled, false, '圆片不该是禁用的')
  chip._listeners.click()

  // 提交对象来自 vm 沙箱，prototype 和这边不是同一个：只比字段。
  assert.deepEqual(
    harness.submits.map((entry) => ({ action: entry.action })),
    [{ action: 'farm-own' }],
    '切回自己农场要发 farm-own，不是 farm-refresh'
  )
})
