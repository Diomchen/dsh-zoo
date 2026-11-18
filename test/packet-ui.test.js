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

test('祝福语可以不写：空白不能把整只红包判成坏礼物', () => {
  // 现场回归：窗口没写祝福语时会把 '' 传下来，字条那条清洗把空串判成非法，
  // 结果整只红包被拒，界面只显示「这件东西没有准备好」。
  const empty = shared.normalizeBringGift({
    kind: 'packet',
    packet: { coins: 200, crops: {}, seeds: {} },
    note: ''
  })
  assert.deepEqual(empty, { kind: 'packet', packet: { coins: 200, crops: {}, seeds: {} } })
  assert.equal('note' in empty, false)
  assert.deepEqual(
    shared.normalizeBringGift({ kind: 'packet', packet: { coins: 5 }, note: '   ' }),
    { kind: 'packet', packet: { coins: 5, crops: {}, seeds: {} } }
  )
  // 真写了还是照旧：超长截断，非法控制字符整件丢。
  assert.equal(shared.normalizeBringGift({ kind: 'packet', packet: { coins: 1 }, note: '\u0000' }), null)
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

test('红包卡不能跟着访客一起消失：访客不在时改锚自己（票 79 补）', async () => {
  // 真实故障：卡片按「访客在不在」决定去留，访客几秒后走了，卡一收，界面上再没有地方
  // 点「拆开」——红包躺在 gifts/ 里直到 24 小时自动退回。宿主侧由 desktop-pets 发常驻卡
  // （见 test/packet-inbox.test.js），渲染端这边必须两处都认「还没拆的红包」：
  //   1. syncGifts 不能因为 `pets` 里没有那位访客就跳过这张卡；
  //   2. layoutUi 的锚点退回 promptAnchor（自己），而不是 hideGiftCard。
  const renderer = await readFile(path.join(root, 'desktop/renderer.js'), 'utf8')
  assert.match(renderer, /function giftOutlivesVisitor \(gift\)/)
  assert.match(renderer, /return gift\.kind === 'packet' && gift\.status === 'received'/)
  // 两处都得问过 giftOutlivesVisitor：syncGifts 放行一张、layoutUi 给它一个锚点。
  assert.match(renderer, /!pets\.has\('visitor:' \+ gift\.deviceId\) && !giftOutlivesVisitor\(gift\)/)
  assert.match(renderer, /else if \(giftOutlivesVisitor\(entry\)\) anchor = promptAnchor\(\)/)
  assert.doesNotMatch(renderer, /if \(!pets\.has\('visitor:' \+ gift\.deviceId\)\) continue/)
})

test('记录页的白名单要认得红包：宿主写了、桌面不能把它丢掉（票 79 补）', () => {
  // 这条是「记录页看不到红包」的真正原因：宿主 farm.log 里有条目，但 helper 的
  // FARM_LOG_KINDS 白名单没有 packet，下发桌面时整条被丢掉，渲染端根本没收到。
  const now = Date.now()
  const window = shared.normalizeFarmWindow({
    open: true,
    farm: {
      log: [
        { at: now, kind: 'packet', qty: 0, event: 'claimed', direction: 'in', who: '测试邻居', text: '2 硬币' },
        { at: now - 1, kind: 'packet', qty: 0, event: 'sent', direction: 'out', who: '爸爸', text: '12 硬币 · 小番茄 ×2' },
        { at: now - 2, kind: 'packet', qty: 0, event: 'bogus', direction: 'sideways', who: '阿蟹', text: '币'.repeat(200) },
        { at: now - 3, kind: 'plant', qty: 1, crop: 'tomato' }
      ]
    }
  })
  const log = window.farm.log
  assert.deepEqual(log.map((entry) => entry.kind), ['packet', 'packet', 'packet', 'plant'])
  assert.equal(log[0].event, 'claimed')
  assert.equal(log[0].direction, 'in')
  assert.equal(log[0].who, '测试邻居')
  assert.equal(log[0].text, '2 硬币')
  assert.equal(log[1].direction, 'out')
  // 不认识的步骤/方向不猜：条目留着、这两个字段丢掉；内容超长夹到 60 码点。
  assert.equal('event' in log[2], false)
  assert.equal('direction' in log[2], false)
  assert.equal(Array.from(log[2].text).length, 60)

  // 票 79 补：红包另存的那一份也要能过 helper 的窄口，不然「流水里被挤掉就再也看不到」。
  const withPackets = shared.normalizeFarmWindow({
    open: true,
    farm: {
      log: [{ at: now, kind: 'plant', qty: 1, crop: 'tomato' }],
      packets: [
        { at: now, kind: 'packet', qty: 0, event: 'claimed', direction: 'in', who: '测试邻居', text: '2 硬币' },
        { at: now - 1, kind: 'plant', qty: 1, crop: 'tomato' },
        { at: now - 2, kind: 'packet', qty: 0, event: 'arrived', direction: 'in', who: '爸爸', text: '' }
      ]
    }
  })
  assert.deepEqual(withPackets.farm.packets.map((entry) => entry.event), ['claimed', 'arrived'], '只收红包，别的混不进来')
  assert.equal(withPackets.farm.packets[0].who, '测试邻居')
  assert.equal(shared.normalizeFarmWindow({ open: true, farm: { log: [] } }).farm.packets, undefined, '老宿主不给就不塞空字段')
})

test('红包记录要在农场「记录」页里能看懂（票 79 补）', async () => {
  // 记录页只认 LOG_TEXT 里的 kind：不加这一行，红包记录会画成「动作」。
  // 而且四种步骤（收到/拆开/送出/退回）必须各说一句话，不能都写成「红包」。
  const farmUi = await readFile(path.join(root, 'desktop/farm.js'), 'utf8')
  assert.match(farmUi, /packet: '红包'/)
  const branch = farmUi.match(/function packetLogText \(entry\)[\s\S]*?\n\}/)
  assert.ok(branch !== null, '红包文案要有自己的一份（置顶块与流水共用）')
  for (const event of ['claimed', 'sent', 'returned']) {
    assert.match(branch[0], new RegExp(`entry\\.event === '${event}'`), event)
  }
  assert.match(branch[0], /还没拆/, '没拆的红包要说明还在等')
  assert.match(farmUi, /if \(entry\.kind === 'packet'\) \{\r?\n\s+return packetLogText\(entry\)/)
})

test('红包记录置顶：流水里几十条种下/收货，红包不能埋在下面（票 79 补）', async () => {
  // 现场：红包记录确实画出来了，但在「最近 100 条」里排到第 30 行开外，
  // 窗口一屏只露十来行——用户翻不到就等于没有。所以记录页顶上单钉一块。
  const html = await readFile(path.join(root, 'desktop/farm.html'), 'utf8')
  const section = html.match(/<section class="log log-packets" id="log-packets"[\s\S]*?<\/section>/)
  assert.ok(section !== null, '记录页要有置顶的红包记录块')
  assert.match(section[0], /<h2>红包记录<\/h2>/)
  assert.match(section[0], /<ul id="log-packet-list"><\/ul>/)
  assert.match(html, /\.log-packets\[hidden\] \{\r?\n\s+display: none;/, '块要能被 hidden 关掉')

  const farmUi = await readFile(path.join(root, 'desktop/farm.js'), 'utf8')
  assert.match(farmUi, /const packetSectionEl = document\.getElementById\('log-packets'\)/)
  assert.match(farmUi, /const packetListEl = document\.getElementById\('log-packet-list'\)/)
  assert.match(farmUi, /const packets = farm !== null && Array\.isArray\(farm\.packets\)/, '要取宿主单独攒的那一份')
  assert.match(farmUi, /packetSectionEl\.hidden = packets\.length === 0/, '没有红包时整块不出现')
  assert.match(farmUi, /for \(const entry of packets\) packetListEl\.appendChild\(logRow\(entry\)\)/)
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

