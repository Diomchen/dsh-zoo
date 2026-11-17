/**
 * 票 79：带派里的红包。
 *
 * 红包和字条/文件最大的区别是「东西真的会换手」：寄出时先扣农场，
 * 拆开时才进对方农场。所以这一份测的是钱货两清的三道门：
 *   1. 规则层：装得下什么、上限多少（协议/背包各守一遍）；
 *   2. 账本层：拆过不能再拆、退回不能再拆、重放不重复发；
 *   3. 种子层：红包和字条/文件共用背包，但撤回要把东西原样退回。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  PACKET_LIMITS,
  encodePacketReturn,
  encodeVisitRequest,
  normalizeGift,
  normalizePacketContents,
  parsePacket
} from '../src/protocol.js'
import { createBackpackStore, normalizePacketNote } from '../src/backpack.js'
import { createGiftStore, PACKET_TTL_MS } from '../src/gifts.js'
import { createFarmStore } from '../src/farm.js'
import { resetCropCatalog } from '../src/farm-rules.js'

const GIFT_ID = '55555555-5555-4555-8555-555555555555'
const FROM = '33333333-3333-4333-8333-333333333333'

function fakeMarket () {
  return {
    applyTrade: ({ side, cropId, qty }) => ({ ok: true, side, cropId, qty, unitPrice: 5, total: qty * 5, price: 5 })
  }
}

async function withDir (fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-zoo-packet-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('红包内容：只管装得下什么，不管农场够不够', () => {
  assert.deepEqual(normalizePacketContents({ coins: 20, crops: { tomato: 3 }, seeds: { rice: 1 } }), {
    coins: 20,
    crops: { tomato: 3 },
    seeds: { rice: 1 }
  })
  // 空红包没有意义：一件东西都没有就是 null。
  assert.equal(normalizePacketContents({}), null)
  assert.equal(normalizePacketContents({ coins: 0, crops: {}, seeds: {} }), null)
  // 上限：硬币 200、每种 20、每类最多 5 种。
  assert.equal(normalizePacketContents({ coins: PACKET_LIMITS.maxCoins }).coins, 200)
  assert.equal(normalizePacketContents({ coins: PACKET_LIMITS.maxCoins + 1 }), null)
  assert.equal(normalizePacketContents({ crops: { tomato: PACKET_LIMITS.maxPerCrop } }).crops.tomato, 20)
  assert.equal(normalizePacketContents({ crops: { tomato: 21 } }), null)
  assert.equal(normalizePacketContents({ crops: { tomato: 1, carrot: 1, rice: 1, corn: 1, pumpkin: 1, grape: 1 } }), null)
  // 作物必须是认识的 id：包别人的自制作物会让对方账本对不上。
  assert.equal(normalizePacketContents({ crops: { 'Pepper!': 1 } }), null)
  assert.equal(normalizePacketContents({ crops: { pepper: 1 } }), null)
})

test('红包礼物：kind=packet 只带内容与祝福语，坏形状整件丢掉', () => {
  const gift = normalizeGift({ id: GIFT_ID, kind: 'packet', packet: { coins: 8 }, note: '新年好' })
  assert.deepEqual(gift, {
    id: GIFT_ID,
    kind: 'packet',
    packet: { coins: 8, crops: {}, seeds: {} },
    note: '新年好'
  })
  assert.deepEqual(normalizeGift({ id: GIFT_ID, kind: 'packet', packet: { coins: 8 } }), {
    id: GIFT_ID,
    kind: 'packet',
    packet: { coins: 8, crops: {}, seeds: {} }
  })
  // 超长祝福语、空内容、乱 id 都不能出门。
  assert.equal(normalizeGift({ id: GIFT_ID, kind: 'packet', packet: { coins: 8 }, note: '喵'.repeat(61) }), null)
  assert.equal(normalizeGift({ id: GIFT_ID, kind: 'packet', packet: {} }), null)
  assert.equal(normalizeGift({ id: 'gift-1', kind: 'packet', packet: { coins: 8 } }), null)
})

test('红包回程包：encodePacketReturn 与 parsePacket 对得上，坏内容直接拒绝', () => {
  const buffer = encodePacketReturn({
    deviceId: FROM,
    giftId: GIFT_ID,
    contents: { coins: 5, crops: { tomato: 2 } },
    note: '没拆，退回'
  })
  const parsed = parsePacket(buffer)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.packet.type, 'packet-return')
  assert.equal(parsed.packet.deviceId, FROM)
  assert.equal(parsed.packet.giftId, GIFT_ID)
  assert.deepEqual(parsed.packet.contents, { coins: 5, crops: { tomato: 2 }, seeds: {} })
  assert.equal(parsed.packet.note, '没拆，退回')

  assert.throws(() => encodePacketReturn({ deviceId: FROM, giftId: 'gift-1', contents: { coins: 1 } }), /giftId/)
  assert.throws(() => encodePacketReturn({ deviceId: FROM, giftId: GIFT_ID, contents: {} }), /packet/)
})

test('红包能装进背包：准备成礼物时内容一字不差', async () => {
  await withDir(async (dir) => {
    const backpack = await createBackpackStore(dir)
    const added = await backpack.add({ kind: 'packet', packet: { coins: 6, seeds: { rice: 2 } }, note: '拿去种' })
    assert.equal(added.ok, true)
    assert.equal(added.item.kind, 'packet')
    assert.deepEqual(added.item.packet, { coins: 6, crops: {}, seeds: { rice: 2 } })
    assert.equal(added.item.note, '拿去种')

    const gift = await backpack.prepareGift(added.item)
    assert.equal(gift.ok, true)
    assert.equal(gift.gift.kind, 'packet')
    assert.deepEqual(gift.gift.packet, { coins: 6, crops: {}, seeds: { rice: 2 } })
    assert.equal(gift.gift.note, '拿去种')

    // 撤回：原样退回，连祝福语都不留。
    const removed = await backpack.remove(added.item.id)
    assert.equal(removed.ok, true)
    assert.deepEqual(removed.item.packet, { coins: 6, crops: {}, seeds: { rice: 2 } })
  })
})

test('祝福语是选填的：空串或空白都当没写，不能把红包判成坏礼物', async () => {
  assert.equal(normalizePacketNote(''), '')
  assert.equal(normalizePacketNote('   '), '')
  assert.equal(normalizePacketNote(undefined), '')
  assert.equal(normalizePacketNote('喵'.repeat(61)), null)

  await withDir(async (dir) => {
    const backpack = await createBackpackStore(dir)
    const added = await backpack.add({ kind: 'packet', packet: { coins: 8 }, note: '' })
    assert.equal(added.ok, true)
    assert.equal(added.item.kind, 'packet')
    // 空祝福语不进 item：既省一次落盘字段，也不会在卡片上多出一行空行。
    assert.equal(added.item.note ?? '', '')
  })
})

test('红包落盘按 packet 写：重启后内容还在，不会退化成空字条', async () => {
  // 现场回归：落盘只分了 file / 其它，红包被写成 {kind:'text', text:undefined}。
  // 结果内容全丢，重启后 normalizeBackpackItem 又因缺 text 丢掉整件——
  // 硬币已经扣了，背包里却什么都没有。
  await withDir(async (dir) => {
    const backpack = await createBackpackStore(dir)
    const added = await backpack.add({
      kind: 'packet',
      packet: { coins: 40, crops: { tomato: 2 }, seeds: { rice: 1 } },
      note: '新年好'
    })
    assert.equal(added.ok, true)

    const onDisk = JSON.parse(await readFile(path.join(dir, 'backpack.json'), 'utf8'))
    assert.equal(onDisk.items.length, 1)
    assert.equal(onDisk.items[0].kind, 'packet')
    assert.deepEqual(onDisk.items[0].packet, { coins: 40, crops: { tomato: 2 }, seeds: { rice: 1 } })
    assert.equal(onDisk.items[0].note, '新年好')

    const reloaded = await createBackpackStore(dir)
    const [item] = reloaded.items()
    assert.equal(item.kind, 'packet')
    assert.deepEqual(item.packet, { coins: 40, crops: { tomato: 2 }, seeds: { rice: 1 } })
    assert.equal(item.note, '新年好')
    assert.equal(item.state, 'idle')
  })
})

test('农场按作物扣：不够就不动账本', async () => {
  resetCropCatalog()
  await withDir(async (dir) => {
    const farm = await createFarmStore(dir, { now: () => Date.UTC(2026, 10, 16, 4, 0, 0), market: fakeMarket() })
    await farm.addCrop('tomato', 3)
    const crops = await farm.takeCropOf('tomato', 2)
    assert.equal(crops.ok, true)
    assert.equal(crops.crops.tomato, 1)
    const short = await farm.takeCropOf('tomato', 5)
    assert.equal(short.ok, false)
    assert.equal(short.error, 'not-enough-crops')
    assert.equal(farm.snapshot().crops.tomato, 1)
    // 种子同规矩；拿光就把键删掉，别留一堆 0。
    await farm.addSeed('rice', 2)
    const seeds = await farm.takeSeedOf('rice', 2)
    assert.equal(seeds.ok, true)
    assert.equal('rice' in seeds.seeds, false)
    assert.equal((await farm.takeSeedOf('rice', 1)).error, 'not-enough-seeds')
  })
})

test('红包账本：先落盘再发货，拆过/退回都不许再拆', async () => {
  await withDir(async (dir) => {
    const gifts = await createGiftStore(dir)
    const received = await gifts.receivePacket({
      id: GIFT_ID,
      from: { deviceId: FROM, nickname: '阿蟹' },
      packet: { coins: 20, crops: { tomato: 3 }, seeds: {} },
      note: '给阿蟹',
      receivedAt: 1000
    })
    assert.equal(received.ok, true)
    const listed = await gifts.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].kind, 'packet')
    assert.deepEqual(listed[0].packet, { coins: 20, crops: { tomato: 3 }, seeds: {} })
    assert.equal(listed[0].claimedAt, 0)

    const applied = []
    const claimed = await gifts.claimPacket(GIFT_ID, async ({ packet }) => {
      applied.push(packet)
      return { ok: true }
    })
    assert.equal(claimed.ok, true)
    assert.equal(applied.length, 1)
    assert.deepEqual(applied[0], { coins: 20, crops: { tomato: 3 }, seeds: {} })

    // 重放：东西已经在对方农场里了，不能再来一次。
    const again = await gifts.claimPacket(GIFT_ID, async () => assert.fail('不该再发'))
    assert.equal(again.ok, false)
    assert.equal(again.error, 'packet-claimed')

    // 重新读盘也认得「已拆」。
    const reloaded = await createGiftStore(dir)
    await reloaded.list()
    assert.equal((await reloaded.claimPacket(GIFT_ID, async () => assert.fail('不该再发'))).error, 'packet-claimed')
  })
})

test('红包退回：没拆的能退，拆过的不退，重放只退一次', async () => {
  await withDir(async (dir) => {
    const gifts = await createGiftStore(dir)
    await gifts.receivePacket({ id: GIFT_ID, from: { deviceId: FROM, nickname: '阿蟹' }, packet: { coins: 5 }, receivedAt: 1000 })
    assert.equal((await gifts.markReturned(GIFT_ID, 2000)).ok, true)
    assert.equal((await gifts.claimPacket(GIFT_ID, async () => assert.fail('不该发'))).error, 'packet-returned')
    // 再退一次是幂等的：回程包可能重发三次。
    assert.equal((await gifts.markReturned(GIFT_ID, 3000)).ok, true)
    const record = (await gifts.list())[0]
    assert.equal(record.returnedAt, 2000)
  })

  await withDir(async (dir) => {
    const gifts = await createGiftStore(dir)
    await gifts.receivePacket({ id: GIFT_ID, from: { deviceId: FROM, nickname: '阿蟹' }, packet: { coins: 5 }, receivedAt: 1000 })
    await gifts.claimPacket(GIFT_ID, async () => ({ ok: true }))
    assert.equal((await gifts.markReturned(GIFT_ID, 2000)).ok, false)
  })
})

test('红包 24 小时有效期：meta 里记着到期时间，方便界面倒计时', async () => {
  await withDir(async (dir) => {
    const gifts = await createGiftStore(dir)
    const receivedAt = 1_700_000_000_000
    await gifts.receivePacket({ id: GIFT_ID, from: { deviceId: FROM, nickname: '阿蟹' }, packet: { coins: 1 }, receivedAt })
    const meta = JSON.parse(await readFile(path.join(dir, 'gifts', (await gifts.list())[0].dirName, 'meta.json'), 'utf8'))
    assert.equal(meta.kind, 'packet')
    assert.equal(meta.receivedAt, receivedAt)
    assert.equal(receivedAt + PACKET_TTL_MS, receivedAt + 86_400_000)
  })
})

test('红包进串门请求：不会把别的东西挤掉', () => {
  const buffer = encodeVisitRequest({
    deviceId: FROM,
    visitId: '77777777-7777-4777-8777-777777777777',
    nickname: '阿蟹',
    gift: { id: GIFT_ID, kind: 'packet', packet: { coins: 12 }, note: '新年好' }
  })
  const parsed = parsePacket(buffer)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.packet.type, 'visit-request')
  assert.deepEqual(parsed.packet.gift, { id: GIFT_ID, kind: 'packet', packet: { coins: 12, crops: {}, seeds: {} }, note: '新年好' })
  assert.equal(parsed.packet.nickname, '阿蟹')
})
