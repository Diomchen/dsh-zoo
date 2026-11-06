/**
 * 票 26：送达回执（`gift-received`）与退包的纯逻辑。
 *
 * 这一层不起 service/网络，只回答四件事：
 *   1. `gift-received` 的编码/解析只带五个字段，`giftId` 不会被 VISIT_TYPES 吃掉；
 *   2. 三句人话都在 `gift-text.js`，昵称非法时退成「邻居」；
 *   3. 背包的「按 giftId 删 out 件」与「按 visitId 回退」各自只动该动的那一件；
 *   4. 入站串门结束（送客 / 对方召回 / 失联）都会把礼物交给 service，且只交一次。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BACKPACK_FILE, createBackpackStore } from '../src/backpack.js'
import {
  giftLeftBehindText,
  giftNotReceivedText,
  giftReceivedText
} from '../src/gift-text.js'
import {
  MAX_PACKET_BYTES,
  PROTOCOL_VERSION,
  encodeGiftReceived,
  parsePacket
} from '../src/protocol.js'
import { createRoom } from '../src/room.js'

function encodeJson (value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-receipt-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

async function readBackpack (dir) {
  return JSON.parse(await readFile(join(dir, BACKPACK_FILE), 'utf8'))
}

function receiptPayload (overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    type: 'gift-received',
    deviceId: randomUUID(),
    visitId: randomUUID(),
    giftId: randomUUID(),
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 协议
// ---------------------------------------------------------------------------

test('gift-received 编解码：只有五个字段，giftId 不会丢，大小写归一', () => {
  const deviceId = randomUUID()
  const visitId = randomUUID()
  const giftId = randomUUID()
  const data = encodeGiftReceived({
    deviceId: deviceId.toUpperCase(),
    visitId: visitId.toUpperCase(),
    giftId: giftId.toUpperCase()
  })
  assert.ok(data.length < MAX_PACKET_BYTES)

  const parsed = parsePacket(data)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.packet, {
    v: PROTOCOL_VERSION,
    type: 'gift-received',
    deviceId,
    visitId,
    giftId
  })
  // 字段顺序也是契约的一部分（便于抓包对照）。
  assert.deepEqual(Object.keys(parsed.packet), ['v', 'type', 'deviceId', 'visitId', 'giftId'])
})

test('gift-received 校验：缺/坏 giftId 整包丢；多余的昵称/端口/坐标一律不进结果', () => {
  const base = receiptPayload()

  // giftId 是这条报文唯一的意义：缺了、坏了都不能“差不多收下”。
  assert.equal(parsePacket(encodeJson({ ...base, giftId: undefined })).reason, 'gift-id')
  assert.equal(parsePacket(encodeJson({ ...base, giftId: 'gift-1' })).reason, 'gift-id')
  assert.equal(parsePacket(encodeJson({ ...base, giftId: 42 })).reason, 'gift-id')
  assert.equal(parsePacket(encodeJson({ ...base, visitId: 'visit-1' })).reason, 'visit-id')
  assert.equal(parsePacket(encodeJson({ ...base, v: 2 })).reason, 'version')
  assert.equal(parsePacket(encodeJson({ ...base, deviceId: 'not-a-uuid' })).reason, 'device-id')

  // 就算有人把 beacon 的字段塞进来，它们也不会被读取——回执不会被当成 beacon 的素材。
  const extra = parsePacket(encodeJson({
    ...base,
    nickname: '伪造成邻居',
    port: 45871,
    x: 1,
    y: 2,
    coordinates: { x: 3, y: 4 }
  }))
  assert.equal(extra.ok, true)
  assert.deepEqual(extra.packet, base)

  // 本地编码错（程序 bug）是抛，不是静默生成一条没有 giftId 的报文。
  assert.throws(
    () => encodeGiftReceived({ deviceId: base.deviceId, visitId: base.visitId, giftId: 'x' }),
    /giftId/
  )
  assert.throws(
    () => encodeGiftReceived({ deviceId: base.deviceId, visitId: 'x', giftId: base.giftId }),
    /visitId/
  )
})

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

test('回执/没送到/还在 gifts 里：三句话都在 gift-text，昵称非法有兜底', () => {
  assert.equal(giftReceivedText('楼下的柯基'), '「楼下的柯基」收下了。')
  assert.equal(giftReceivedText(null), '「邻居」收下了。')
  assert.equal(giftReceivedText('   '), '「邻居」收下了。')
  assert.equal(
    giftNotReceivedText(),
    '没送到：对方没取到（可能没开端口、或对方版本较旧）。'
  )
  assert.equal(giftLeftBehindText('楼下的柯基'), '「楼下的柯基」捎来的东西还在 gifts 里。')
  assert.equal(giftLeftBehindText(null), '「邻居」捎来的东西还在 gifts 里。')
})

// ---------------------------------------------------------------------------
// 背包：收到回执删件 / 串门结束退包
// ---------------------------------------------------------------------------

test('背包 confirmOut：只有 out 能删；按 giftId 删掉并落盘；重复是 gift-not-found', async (t) => {
  const dir = await tempDir(t)
  const store = await createBackpackStore(dir)
  const first = await store.add({ kind: 'text', text: '要送走的' })
  const second = await store.add({ kind: 'text', text: '留下的' })
  const visitId = randomUUID()
  assert.equal((await store.markOut(first.item.id, visitId)).ok, true)

  // 回执必须对得上 visitId：另一次串门的回执不能删这一件。
  assert.deepEqual(
    await store.confirmOut(first.item.id, randomUUID()),
    { ok: false, error: 'not-out', persisted: false }
  )
  // idle 件只能走 remove，不能被一条回执悄悄吃掉。
  assert.equal((await store.confirmOut(second.item.id, visitId)).error, 'not-out')

  const confirmed = await store.confirmOut(first.item.id, visitId)
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.item.id, first.item.id)
  assert.equal(confirmed.count, 1)
  // 落盘：背包装里只剩第二件（第一件是真的删了，不是退回 idle）。
  const raw = await readBackpack(dir)
  assert.deepEqual(raw.items.map((item) => item.id), [second.item.id])
  assert.equal(raw.items[0].state, 'idle')

  // 幂等：同一条回执再来一次（或晚到的重发）什么也不做。
  assert.equal((await store.confirmOut(first.item.id, visitId)).error, 'gift-not-found')
  assert.equal((await store.confirmOut('gift-1', visitId)).error, 'bad-gift')
})

test('背包 releaseOutByVisit：按 visitId 退回 idle，别的串门不动；没有 out 时明确 false', async (t) => {
  const dir = await tempDir(t)
  const store = await createBackpackStore(dir)
  const first = await store.add({ kind: 'text', text: '这次没送到' })
  const second = await store.add({ kind: 'text', text: '下次再带' })
  const visitId = randomUUID()
  assert.equal((await store.markOut(first.item.id, visitId)).ok, true)

  // 另一次串门的结束不能把这一件退回来。
  const miss = await store.releaseOutByVisit(randomUUID())
  assert.equal(miss.ok, false)
  assert.deepEqual(miss.released, [])
  assert.equal((await readBackpack(dir)).items[0].state, 'out')

  const released = await store.releaseOutByVisit(visitId)
  assert.equal(released.ok, true)
  assert.deepEqual(released.released.map((item) => item.id), [first.item.id])
  const raw = await readBackpack(dir)
  assert.equal(raw.items[0].id, first.item.id)
  assert.equal(raw.items[0].state, 'idle')
  assert.equal('visitId' in raw.items[0], false)
  // 没被带走的那件一直在 idle，没被顺手改动。
  assert.equal(raw.items[1].id, second.item.id)
  assert.equal(raw.items[1].state, 'idle')

  // 一件都没退（回执已经先到了/已经结束过）：调用方据此不重复冒泡。
  assert.deepEqual(await store.releaseOutByVisit(visitId), {
    ok: false,
    error: 'not-out',
    released: [],
    persisted: false
  })
})

// ---------------------------------------------------------------------------
// room：入站结束的三个出口
// ---------------------------------------------------------------------------

test('入站结束（送客 / 对方召回 / 失联）都把礼物交给 service，且每件只交一次', () => {
  let now = 1_000_000
  const room = createRoom({ dir: '/tmp/unused-receipt-room', clock: () => now, peerLostMs: 100 })
  const selfId = randomUUID()
  const peerId = randomUUID()
  room.setIdentity({ deviceId: selfId, nickname: '我' })
  room.observeBeacon({ deviceId: peerId, nickname: '楼下的柯基', port: 45871 }, now)
  assert.equal(room.admit(peerId).ok, true)

  function incoming (giftId) {
    return {
      deviceId: peerId,
      visitId: randomUUID(),
      nickname: '楼下的柯基',
      anim: null,
      gift: { id: giftId, kind: 'text', text: '给你留了张便条' }
    }
  }

  // 1) 送客
  const giftA = randomUUID()
  assert.equal(room.observeVisitRequest(incoming(giftA), now).reply, 'ack')
  now += 10
  assert.equal(room.endInboundVisit(peerId, now).ok, true)
  assert.deepEqual(room.drainEndedInboundGifts(), [
    { deviceId: peerId, nickname: '楼下的柯基', giftId: giftA }
  ])

  // 2) 对方召回（迟到/旧 visitId 也认，按 deviceId 清场）
  const giftB = randomUUID()
  assert.equal(room.observeVisitRequest(incoming(giftB), now).reply, 'ack')
  now += 10
  assert.equal(room.observeVisitRecall({ deviceId: peerId, visitId: randomUUID() }, now).ok, true)
  assert.deepEqual(room.drainEndedInboundGifts(), [
    { deviceId: peerId, nickname: '楼下的柯基', giftId: giftB }
  ])

  // 3) 失联：心跳停 100ms 之后由 tick 清场
  const giftC = randomUUID()
  assert.equal(room.observeVisitRequest(incoming(giftC), now).reply, 'ack')
  now += 200
  room.tick(now)
  assert.deepEqual(room.drainEndedInboundGifts(), [
    { deviceId: peerId, nickname: '楼下的柯基', giftId: giftC }
  ])

  // 队列已空：同一件不会被交第二次。
  assert.deepEqual(room.drainEndedInboundGifts(), [])
})

test('送客提醒只在该访客身上有礼物时排队；没礼物的访客不留条目', () => {
  let now = 2_000_000
  const room = createRoom({ dir: '/tmp/unused-receipt-room', clock: () => now })
  const selfId = randomUUID()
  const peerId = randomUUID()
  room.setIdentity({ deviceId: selfId, nickname: '我' })
  room.observeBeacon({ deviceId: peerId, nickname: '空手来的', port: 45871 }, now)
  assert.equal(room.admit(peerId).ok, true)

  assert.equal(room.observeVisitRequest({
    deviceId: peerId,
    visitId: randomUUID(),
    nickname: '空手来的',
    anim: null
  }, now).reply, 'ack')
  now += 10
  assert.equal(room.endInboundVisit(peerId, now).ok, true)
  assert.deepEqual(room.drainEndedInboundGifts(), [])
})
