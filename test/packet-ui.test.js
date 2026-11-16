/**
 * 票 79：红包在桌面端的两道门。
 *
 * 宿主守的是账本（谁拆了、退没退），helper 守的是**形状**：
 * 渲染端编不出来的东西，别指望主进程替它兜着。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import shared from '../desktop/shared.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const GIFTS = '55555555-5555-4555-8555-555555555555'
const DEVICE = '33333333-3333-4333-8333-333333333333'

test('helper 收红包：内容按上限夹，一件都没有就整件丢掉', () => {
  assert.deepEqual(shared.normalizeBringGift({
    kind: 'packet',
    packet: { coins: 12, crops: { tomato: 2 }, seeds: {} },
    note: '新年好'
  }), {
    kind: 'packet',
    packet: { coins: 12, crops: { tomato: 2 }, seeds: {} },
    note: '新年好'
  })

  // 上限：helper 这一层按封顶夹住（宿主还会再夹一次）。
  assert.equal(shared.normalizeBringGift({ kind: 'packet', packet: { coins: 201 } }).packet.coins, 200)
  assert.equal(shared.normalizeBringGift({ kind: 'packet', packet: { crops: { tomato: 21 } } }), null)
  assert.equal(shared.normalizeBringGift({ kind: 'packet', packet: {} }), null)
  // 祝福语这一层是截断（和字条同一条清洗），不是拒收。
  assert.equal(Array.from(shared.normalizeBringGift({ kind: 'packet', packet: { coins: 1 }, note: '喵'.repeat(61) }).note).length, 60)
  // 只认认识的作物 id：自制作物不能靠红包过河。
  assert.equal(shared.normalizeBringGift({ kind: 'packet', packet: { crops: { 'Tomato!': 1 } } }), null)
})

test('红包面板：宿主给多少就画多少，但不信它给的上下限', () => {
  const setup = shared.normalizeBringWindow({
    items: [],
    packet: {
      limits: { maxCoins: 9999, maxPerCrop: 9999, maxKinds: 99, maxNoteChars: 999 },
      left: 7,
      coins: 500,
      crops: [{ id: 'tomato', name: '小番茄', have: 4 }, { id: 'Ghost!', name: '幽灵', have: 2 }],
      seeds: [{ id: 'rice', name: '稻米', have: 1 }]
    }
  }).packet
  assert.equal(setup.limits.maxCoins, 200)
  assert.equal(setup.limits.maxPerCrop, 20)
  assert.equal(setup.limits.maxKinds, 5)
  assert.equal(setup.limits.maxNoteChars, 60)
  // 每天最多 3 只：多报的数不能当真。
  assert.equal(setup.left, 3)
  assert.equal(setup.coins, 500)
  assert.deepEqual(setup.crops, [{ id: 'tomato', name: '小番茄', have: 4 }])
  assert.deepEqual(setup.seeds, [{ id: 'rice', name: '稻米', have: 1 }])
})

test('背包里的红包：小窗能显示，但看不到任何路径', () => {
  const item = shared.normalizeBringWindowItem({
    id: GIFTS,
    kind: 'packet',
    packet: { coins: 3 },
    text: '红包 · 3 硬币',
    state: 'idle'
  })
  assert.deepEqual(item, {
    id: GIFTS,
    kind: 'packet',
    packet: { coins: 3, crops: {}, seeds: {} },
    text: '红包 · 3 硬币',
    state: 'idle'
  })
  assert.equal('path' in item, false)
})

test('访客卡片：红包是「拆开」，字条/文件是「打开」', () => {
  const controls = shared.normalizeControls({
    self: { deviceId: DEVICE, nickname: '我' },
    gifts: [{
      deviceId: '44444444-4444-4444-8444-444444444444',
      giftId: GIFTS,
      kind: 'packet',
      packet: { coins: 20, crops: { tomato: 3 } },
      text: '20 硬币 · 小番茄 ×3',
      status: 'received',
      expiresAt: 1_800_000_000_000,
      note: '拿去吃'
    }]
  })
  assert.equal(controls.gifts.length, 1)
  const card = controls.gifts[0]
  assert.equal(card.kind, 'packet')
  assert.equal(card.status, 'received')
  assert.equal(card.text, '20 硬币 · 小番茄 ×3')
  assert.equal(card.note, '拿去吃')
  assert.equal(card.expiresAt, 1_800_000_000_000)
  assert.deepEqual(card.packet, { coins: 20, crops: { tomato: 3 }, seeds: {} })
  // 形状不对的整张卡丢掉，别画半截。
  assert.deepEqual(shared.normalizeControls({
    self: { deviceId: DEVICE, nickname: '我' },
    gifts: [{ deviceId: '44444444-4444-4444-8444-444444444444', giftId: GIFTS, kind: 'packet', status: 'received' }]
  }).gifts, [])
})

test('拆红包走的是 gift-claim：三张白名单都放行，主进程才敢转发', () => {
  assert.ok(shared.GIFT_ACTIONS.includes('gift-claim'))
  assert.ok(shared.CONTROL_ACTIONS.includes('gift-claim'))
  assert.ok(shared.DESKTOP_ACTIONS.includes('gift-claim'))
})

test('红包小窗与卡片的源码契约：面板、按钮、动作都得在', async () => {
  const html = await readFile(path.join(root, 'desktop/gift.html'), 'utf8')
  const gift = await readFile(path.join(root, 'desktop/gift.js'), 'utf8')
  const renderer = await readFile(path.join(root, 'desktop/renderer.js'), 'utf8')
  const preload = await readFile(path.join(root, 'desktop/gift-preload.js'), 'utf8')

  for (const id of ['mode-text', 'mode-packet', 'packet-panel', 'packet-coins', 'packet-crops', 'packet-seeds', 'packet-note']) {
    assert.match(html, new RegExp(`id="${id}"`), id)
  }
  assert.match(gift, /submitPacket/)
  assert.match(gift, /kind: 'packet'/)
  assert.match(renderer, /gift-claim/)
  assert.match(renderer, /lp-gift-packet/)
  assert.match(preload, /packet: gift\.packet/)
  assert.match(preload, /note: gift\.note/)
})

test('bring-window 的红包底数要穿过白名单和主进程，不能在中途被削掉', async () => {
  // 票 79 的真实故障：宿主发了 packet，shared 也认，但 main.js 组装 giftState 时
  // 只抄了 items/count/...，红包页拿不到底数，只能显示「宿主还没把红包底数据过来」。
  const packet = {
    limits: { maxCoins: 200, maxPerCrop: 20, maxKinds: 5, maxNoteChars: 60 },
    left: 2,
    coins: 30,
    crops: [{ id: 'tomato', name: '小番茄', have: 2 }],
    seeds: [{ id: 'rice', name: '稻米', have: 1 }]
  }
  const normalized = shared.normalizeHostCommand({ type: 'bring-window', open: true, items: [], packet })
  assert.equal(normalized.ok, true)
  assert.deepEqual(normalized.command.packet, packet)

  // 旧宿主不发 packet 时不能凭空造一个，窗口自己会退回「字条」。
  const legacy = shared.normalizeHostCommand({ type: 'bring-window', open: true, items: [] })
  assert.equal(legacy.command.packet, undefined)

  const main = await readFile(path.join(root, 'desktop/main.js'), 'utf8')
  assert.match(main, /packet: command\.packet/)
})

test('红包面板比字条高：窗口要够高，底栏要钉住，不然「取消 / 放进背包」会掉出可视区', async () => {
  const main = await readFile(path.join(root, 'desktop/main.js'), 'utf8')
  const height = main.match(/const GIFT_HEIGHT = (\d+)/)
  assert.ok(height !== null, 'GIFT_HEIGHT 必须是字面量常量')
  assert.ok(Number(height[1]) >= 600, `GIFT_HEIGHT=${height[1]} 放不下红包面板`)

  const html = await readFile(path.join(root, 'desktop/gift.html'), 'utf8')
  const card = html.match(/\.card \{[\s\S]*?\n {6}\}/)
  assert.ok(card !== null, '.card 规则必须在')
  assert.match(card[0], /overflow-y:\s*auto/, '卡片内容要能滚，否则底栏被挤出窗口')
  const actions = html.match(/\.actions \{[\s\S]*?\n {6}\}/)
  assert.ok(actions !== null, '.actions 规则必须在')
  assert.match(actions[0], /position:\s*sticky/, '底栏要 sticky 钉住')
  assert.match(actions[0], /bottom:\s*-?\d/, '底栏要贴底')
})

