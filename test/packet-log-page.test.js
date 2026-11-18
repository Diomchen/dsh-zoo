/**
 * 票 79 补（渲染端）：红包记录必须一打开「记录」页就在眼前。
 *
 * 现场：宿主写进 farm.log 了、helper 也没丢，可是「最近 100 条」里红包排到第 30 行开外，
 * 一屏只露十来行——用户翻了半天说「我还是看不到」。所以记录页顶上单钉一块「红包记录」。
 *
 * 跑的是真的 `desktop/farm.js`（替身 DOM），不是读源码做正则。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { bootFarm } from './fixtures/farm-renderer.js'

const NOW = 1_700_000_000_000

function farmState (log) {
  return {
    farm: {
      unlocked: 4,
      maxPlots: 50,
      nextCost: 60,
      plots: [],
      seeds: {},
      crops: {},
      coins: 0,
      dew: 0,
      worker: null,
      contractCount: 0,
      hire: { enabled: false, wagePerHour: 10, minHours: 2, maxHours: 8 },
      guard: 0.3,
      log,
      carried: []
    },
    market: null,
    crops: null,
    contracts: null,
    mode: 'owner',
    visit: null,
    look: null,
    neighbors: [],
    plotId: null
  }
}

function packetRow (overrides = {}) {
  return {
    at: NOW,
    kind: 'packet',
    qty: 0,
    event: 'claimed',
    direction: 'in',
    who: '测试邻居',
    text: '2 硬币',
    ...overrides
  }
}

function rowTexts (listEl) {
  return listEl.children.map((item) => (item.children.length > 0 ? item.children[0].textContent : item.textContent))
}

test('记录页：红包置顶，流水照旧；没有红包时整块不出现', () => {
  const boot = bootFarm()
  // 故意让红包排在流水第 30 行之后——现实里就是这样被埋住的。
  const log = [
    ...Array.from({ length: 30 }, (_, index) => ({ at: NOW - index, kind: 'plant', qty: 1, crop: 'tomato' })),
    packetRow()
  ]
  boot.pushState(farmState(log))
  boot.clickTab('log')

  const section = boot.element('log-packets')
  const pinned = boot.element('log-packet-list')
  const flow = boot.element('log')

  assert.equal(section.hidden, false, '有红包时这块要露出来')
  assert.deepEqual(rowTexts(pinned), ['拆开「测试邻居」的红包 · 2 硬币'])
  // 流水还是完整的 100 条截断逻辑：红包本身也照常在流水里。
  assert.equal(flow.children.length, 31)
  assert.equal(rowTexts(flow).filter((text) => text.includes('红包')).length, 1)

  // 换成一批没有红包的记录：置顶块整块收起来，不留空壳。
  boot.pushState(farmState([{ at: NOW, kind: 'plant', qty: 1, crop: 'tomato' }]))
  boot.clickTab('log')
  assert.equal(boot.element('log-packets').hidden, true)
  assert.deepEqual(rowTexts(boot.element('log-packet-list')), [])
})

test('记录页：四种红包说法各画一句（收到/拆开/送出/退回）', () => {
  const boot = bootFarm()
  boot.pushState(farmState([
    packetRow({ at: NOW, event: 'arrived', direction: 'in', who: '爸爸', text: '12 硬币 · 小番茄 ×2' }),
    packetRow({ at: NOW - 1, event: 'claimed', direction: 'in', who: '爸爸', text: '12 硬币 · 小番茄 ×2' }),
    packetRow({ at: NOW - 2, event: 'sent', direction: 'out', who: '鲸娘', text: '3 硬币' }),
    packetRow({ at: NOW - 3, event: 'returned', direction: 'in', who: '阿蟹', text: '5 硬币' })
  ]))
  boot.clickTab('log')

  assert.deepEqual(rowTexts(boot.element('log-packet-list')), [
    '「爸爸」送来一只红包 · 12 硬币 · 小番茄 ×2（还没拆）',
    '拆开「爸爸」的红包 · 12 硬币 · 小番茄 ×2',
    '给「鲸娘」送出一只红包 · 3 硬币',
    '「阿蟹」没拆，红包退回来了 · 5 硬币'
  ])
})

test('记录页：流水里已经被挤掉了，红包记录还在（取宿主单独攒的那一份）', () => {
  // 现场：早上 08:35 的「拆开红包」到了下午已经被几百条种下/收货挤出最近 100 条，
  // 用户上午看得到、下午再看就没了。所以置顶块读 `farm.packets`，与流水无关。
  const boot = bootFarm()
  const flow = Array.from({ length: 100 }, (_, index) => ({ at: NOW - index, kind: 'plant', qty: 1, crop: 'tomato' }))
  const state = farmState(flow)
  state.farm.packets = [packetRow({ who: '爸爸', text: '12 硬币' })]
  boot.pushState(state)
  boot.clickTab('log')

  assert.equal(boot.element('log-packets').hidden, false)
  assert.deepEqual(rowTexts(boot.element('log-packet-list')), ['拆开「爸爸」的红包 · 12 硬币'])
  assert.equal(boot.element('log').children.length, 100, '流水照旧是 100 条')
})

test('记录页：一条记录都没有时只留「还没有记录。」，红包块不出现', () => {
  const boot = bootFarm()
  boot.pushState(farmState([]))
  boot.clickTab('log')

  assert.equal(boot.element('log-packets').hidden, true)
  assert.deepEqual(rowTexts(boot.element('log')), ['还没有记录。'])
})
