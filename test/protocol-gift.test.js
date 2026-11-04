/**
 * 票 23：串门请求里的字条（gift）。
 *
 * 两条和 `anim` 相反的约定，是这一组测试的重点：
 *   - gift 校验不过只丢这一个字段，串门照常（不是整包丢）；
 *   - 编码后整包超 4 KiB 时丢 gift 重编，并且调用方拿得到“这次没带上”。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  MAX_GIFT_BYTES,
  MAX_GIFT_TEXT,
  MAX_PACKET_BYTES,
  PROTOCOL_VERSION,
  encodePacket,
  encodeVisitRequest,
  encodeVisitRequestDetailed,
  normalizeGift,
  parsePacket,
  sanitizeNote
} from '../src/protocol.js'

function encodeJson (value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

function visitId () {
  return randomUUID()
}

function giftOf (overrides = {}) {
  return { id: visitId(), kind: 'text', text: '给你留了张便条', ...overrides }
}

function visitRequest (overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    type: 'visit-request',
    deviceId: randomUUID(),
    visitId: visitId(),
    nickname: '楼下的柯基',
    anim: null,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 纯函数：清洗与白名单
// ---------------------------------------------------------------------------

test('sanitizeNote：保留换行，去掉其余控制字符与双向覆盖符，首尾裁掉', () => {
  assert.equal(
    sanitizeNote('\n  第一行\r\n第二行\t带制表符\u0000\u0007\n\n第三行  \n'),
    '第一行\n第二行带制表符\n\n第三行'
  )
  // 双向覆盖符（U+202E 等）能把一段文字显示成完全相反的意思，必须去掉。
  assert.equal(sanitizeNote('正常\u202e文字\u2066'), '正常文字')
  // 空白（含空行）不算一条字条。
  assert.equal(sanitizeNote('   \n\t  '), null)
  assert.equal(sanitizeNote(null), null)
  assert.equal(sanitizeNote(42), null)
})

test('sanitizeNote：≤500 码点，超了返回 null（不截断——截一半比不带更糟）', () => {
  const max = '字'.repeat(MAX_GIFT_TEXT)
  assert.equal(sanitizeNote(max), max)
  assert.equal(sanitizeNote(max + '多'), null)
  // 码点而不是 UTF-16 单元：500 个 emoji 是 1000 个 JS 字符，但仍然是 500 个码点。
  const emoji = '🐕'.repeat(MAX_GIFT_TEXT)
  assert.equal(sanitizeNote(emoji), emoji)
  assert.equal(sanitizeNote(emoji + '🐕'), null)
  // 孤立代理项是坏编码，不收。
  assert.equal(sanitizeNote('\ud800'), null)
})

test('normalizeGift：字条与文件各自一套白名单；形状不对返回 null，不抛', () => {
  const id = visitId()
  assert.deepEqual(
    normalizeGift({ id, kind: 'text', text: '  你好\n世界  ', extra: 'x' }),
    { id, kind: 'text', text: '你好\n世界' }
  )
  // id 统一小写：目录名与后续 action 都以它为准。
  assert.equal(normalizeGift({ id: id.toUpperCase(), kind: 'text', text: 'x' }).id, id)

  // 文件礼物（ticket 24 起发）：报文里只有元数据，**没有路径**；本体由 25 拉取。
  const sha256 = 'sha256:' + 'a'.repeat(64)
  assert.deepEqual(
    normalizeGift({ id, kind: 'file', name: '  报价单.pdf  ', size: 23194, sha256, path: '/tmp/secret' }),
    { id, kind: 'file', name: '报价单.pdf', size: 23194, sha256 }
  )
  // 名字清洗后为空不是错误：退成 `file`（名字只是给人看的）。
  assert.equal(normalizeGift({ id, kind: 'file', name: '../', size: 1, sha256 }).name, 'file')
  assert.equal(
    normalizeGift({ id, kind: 'file', name: 'x'.repeat(200), size: 1, sha256 }).name.length,
    120
  )

  for (const bad of [
    null,
    'text',
    [],
    { id: 'gift-1', kind: 'text', text: 'x' },
    { id, kind: 'file', text: 'x' },
    { id, kind: 'file', name: 'x.pdf', size: 0, sha256 },
    { id, kind: 'file', name: 'x.pdf', size: MAX_GIFT_BYTES + 1, sha256 },
    { id, kind: 'file', name: 'x.pdf', size: 1, sha256: 'sha256:abc' },
    { id, kind: 'file', name: 'x.pdf', size: 1, sha256: 'md5:' + 'a'.repeat(32) },
    { id, kind: 'text', text: '' },
    { id, kind: 'text', text: 'x'.repeat(MAX_GIFT_TEXT + 1) },
    { id, kind: 'text' }
  ]) {
    assert.equal(normalizeGift(bad), null, JSON.stringify(bad))
  }

  // 白名单重建：字条多出来的文件字段、文件多出来的 text 一律丢掉。
  assert.deepEqual(
    normalizeGift({ id, kind: 'text', text: 'x', name: '报价单.pdf', path: '/tmp/x' }),
    { id, kind: 'text', text: 'x' }
  )
  assert.deepEqual(
    normalizeGift({ id, kind: 'file', name: 'x.pdf', size: 7, sha256, text: '夹带' }),
    { id, kind: 'file', name: 'x.pdf', size: 7, sha256 }
  )
})

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

test('encodeVisitRequestDetailed：带 gift 时追加 gift 字段，没有时保持旧形状', () => {
  const deviceId = randomUUID()
  const visit = visitId()
  const gift = giftOf()
  const built = encodeVisitRequestDetailed({
    deviceId,
    visitId: visit,
    nickname: '甲',
    anim: '东张西望',
    gift
  })
  assert.equal(built.giftDropped, false)
  const raw = JSON.parse(built.data.toString('utf8'))
  assert.deepEqual(Object.keys(raw), ['v', 'type', 'deviceId', 'visitId', 'nickname', 'anim', 'gift'])
  assert.deepEqual(raw.gift, gift)

  // 旧报文（没有 gift）一个字节都不多。
  const plain = encodeVisitRequest({ deviceId, visitId: visit, nickname: '甲', anim: '东张西望' })
  assert.deepEqual(Object.keys(JSON.parse(plain.toString('utf8'))), ['v', 'type', 'deviceId', 'visitId', 'nickname', 'anim'])
  assert.equal(encodeVisitRequestDetailed({ deviceId, visitId: visit, nickname: '甲', anim: null }).giftDropped, false)
})

test('encodeVisitRequestDetailed：坏字条被丢，串门请求照常编出来', () => {
  const deviceId = randomUUID()
  const visit = visitId()
  for (const gift of [
    { id: 'not-a-uuid', kind: 'text', text: 'x' },
    { id: visitId(), kind: 'file', text: 'x' },
    { id: visitId(), kind: 'text', text: 'x'.repeat(MAX_GIFT_TEXT + 1) },
    { id: visitId(), kind: 'text', text: '' }
  ]) {
    const built = encodeVisitRequestDetailed({ deviceId, visitId: visit, nickname: '甲', anim: null, gift })
    assert.equal(built.giftDropped, true)
    const raw = JSON.parse(built.data.toString('utf8'))
    assert.equal(raw.gift, undefined)
    assert.equal(raw.visitId, visit)
    assert.equal(raw.nickname, '甲')
    assert.equal(parsePacket(built.data).ok, true)
  }
})

test('encodeVisitRequestDetailed：整包超 4 KiB 时丢 gift 重编一次，并报 giftDropped', () => {
  const deviceId = randomUUID()
  const visit = visitId()
  // 正常 500 码点塞得进 4 KiB（最坏 emoji 约 3 KiB）；这里把上限调小，
  // 让防御路径真的走一遍——生产上限仍然是 MAX_PACKET_BYTES。
  const gift = giftOf({ text: '🐕'.repeat(120) })
  const args = { deviceId, visitId: visit, nickname: '甲', anim: '东张西望', gift }
  const full = encodeVisitRequestDetailed(args)
  assert.equal(full.giftDropped, false)
  assert.ok(full.data.length <= MAX_PACKET_BYTES)

  const tiny = encodeVisitRequestDetailed(args, { maxBytes: full.data.length - 1 })
  assert.equal(tiny.giftDropped, true)
  assert.ok(tiny.data.length <= full.data.length - 1)
  assert.equal(JSON.parse(tiny.data.toString('utf8')).gift, undefined)
  assert.equal(parsePacket(tiny.data).ok, true)

  // 没有 gift 可丢时仍然是“太大”，不静默发出去。
  assert.throws(
    () => encodeVisitRequestDetailed({ deviceId, visitId: visit, nickname: '甲', anim: null }, { maxBytes: 10 }),
    /too large/
  )
})

test('encodePacket 的旧契约不变：visit-request 带 gift 也返回 Buffer', () => {
  const data = encodePacket({
    type: 'visit-request',
    deviceId: randomUUID(),
    visitId: visitId(),
    nickname: '甲',
    anim: null,
    gift: giftOf()
  })
  assert.ok(Buffer.isBuffer(data))
  assert.equal(parsePacket(data).packet.gift.kind, 'text')
})

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

test('parsePacket：合法 gift 进快照；多出来的字段一个都不留', () => {
  const gift = giftOf({ text: '第一行\n第二行' })
  const parsed = parsePacket(encodeJson(visitRequest({ gift: { ...gift, path: '/etc/passwd', size: 1 } })))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.packet.gift, gift)
  assert.deepEqual(Object.keys(parsed.packet.gift), ['id', 'kind', 'text'])
})

test('parsePacket：坏 gift 只丢字段，串门请求照常被接受（与 anim 相反）', () => {
  const base = visitRequest()
  const badGifts = [
    { id: 'gift-1', kind: 'text', text: 'x' },
    { id: base.visitId, kind: 'movie', text: 'x' },
    { id: base.visitId, kind: 'text', text: ' '.repeat(5) },
    { id: base.visitId, kind: 'text', text: 'x'.repeat(MAX_GIFT_TEXT + 1) },
    { id: base.visitId, kind: 'text', text: 42 },
    'gift',
    [],
    { id: base.visitId, kind: 'file', name: '报价单.pdf', size: 0, sha256: 'sha256:' + '0'.repeat(64) }
  ]
  for (const gift of badGifts) {
    const parsed = parsePacket(encodeJson({ ...base, gift }))
    assert.equal(parsed.ok, true, JSON.stringify(gift))
    assert.equal(parsed.packet.gift, undefined, JSON.stringify(gift))
    assert.equal(parsed.packet.visitId, base.visitId)
    assert.equal(parsed.packet.nickname, base.nickname)
  }

  // 对照：anim 坏掉仍然整包丢——这两种策略的差别是刻意的。
  assert.deepEqual(parsePacket(encodeJson({ ...base, anim: '../evil' })), {
    ok: false,
    reason: 'anim'
  })
})

test('parsePacket：没有 gift 的旧报文解析成没有礼物，字段集与 0.3.1 一致', () => {
  const parsed = parsePacket(encodeJson(visitRequest()))
  assert.deepEqual(Object.keys(parsed.packet), ['v', 'type', 'deviceId', 'visitId', 'nickname', 'anim'])
  assert.equal('gift' in parsed.packet, false)
})

test('parsePacket：伪造的超长字段也走白名单，不因为 gift 被放大', () => {
  const parsed = parsePacket(encodeJson(visitRequest({ gift: giftOf(), coordinates: { x: 1, y: 2 }, path: '/tmp/x' })))
  assert.equal(parsed.ok, true)
  assert.equal('coordinates' in parsed.packet, false)
  assert.equal('path' in parsed.packet, false)
  assert.deepEqual(Object.keys(parsed.packet.gift), ['id', 'kind', 'text'])
})

test('文件礼物：编码只带 name/size/sha256，解析后仍然没有路径', () => {
  const deviceId = randomUUID()
  const id = visitId()
  const sha256 = 'sha256:' + 'b'.repeat(64)
  const built = encodeVisitRequestDetailed({
    deviceId,
    visitId: id,
    nickname: '甲',
    anim: null,
    gift: { id, kind: 'file', name: '报价单.pdf', size: 23194, sha256, path: '/tmp/secret' }
  })
  assert.equal(built.giftDropped, false)
  const raw = JSON.parse(built.data.toString('utf8'))
  assert.deepEqual(raw.gift, { id, kind: 'file', name: '报价单.pdf', size: 23194, sha256 })

  const parsed = parsePacket(built.data)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.packet.gift, raw.gift)
  assert.deepEqual(Object.keys(parsed.packet.gift), ['id', 'kind', 'name', 'size', 'sha256'])
})
