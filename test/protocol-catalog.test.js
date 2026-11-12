/**
 * 票 59：作物目录的两条报文（`crop-catalog-request` / `crop-catalog`）与 beacon 指纹。
 *
 * 这一层只验 wire：形状、夹取、上限、坏包不崩。**不跑网络**——UDP 收发在
 * `service` 那一层，验收靠纯函数与手动联机（用户明确不要局域网跑测）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CATALOG_VERSION,
  CAPS,
  MAX_CATALOG_CHUNKS,
  MAX_CATALOG_ENTRIES_PER_PACKET,
  MAX_PACKET_BYTES,
  PACKET_TYPES,
  encodeCropCatalog,
  encodeCropCatalogRequest,
  encodePacket,
  normalizeCaps,
  parsePacket
} from '../src/protocol.js'

const DEVICE = '11111111-1111-4111-8111-111111111111'
const HASH = '0123456789abcdef'
const ART = { hash: 'fedcba9876543210', ext: 'svg', bytes: 512 }

function entry (overrides = {}) {
  return { id: 'kiwi', name: '猕猴桃', growMs: 7200000, seedPrice: 20, yield: 5, base: 12, ...overrides }
}

test('能力位：新增 crops，且只认已知能力', () => {
  assert.deepEqual([...CAPS], ['raid', 'look', 'crops'])
  assert.deepEqual(normalizeCaps(['crops', 'nope', 'crops']), ['crops'])
})

test('报文类型表：两条目录报文都在白名单里', () => {
  assert.ok(PACKET_TYPES.includes('crop-catalog-request'))
  assert.ok(PACKET_TYPES.includes('crop-catalog'))
})

test('目录请求：往返只带一个指纹；坏哈希直接拒绝', () => {
  const parsed = parsePacket(encodeCropCatalogRequest({ deviceId: DEVICE, hash: HASH }))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.packet, {
    v: 1,
    type: 'crop-catalog-request',
    deviceId: DEVICE,
    hash: HASH
  })
  assert.throws(() => encodeCropCatalogRequest({ deviceId: DEVICE, hash: 'short' }), /catalog hash/)
  assert.equal(parsePacket(JSON.stringify({ v: 1, type: 'crop-catalog-request', deviceId: DEVICE, hash: 'x' })).ok, false)
})

test('目录分片：定义与图元数据原样往返，数值仍按作物表夹取', () => {
  const buffer = encodeCropCatalog({
    deviceId: DEVICE,
    catalogHash: HASH,
    chunk: 0,
    total: 2,
    entries: [entry({ art: ART }), entry({ id: 'grape', name: '葡萄', growMs: 43200000, seedPrice: 52, yield: 5, base: 24 })]
  })
  const parsed = parsePacket(buffer)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.packet.chunk, 0)
  assert.equal(parsed.packet.total, 2)
  assert.deepEqual(parsed.packet.entries[0], { ...entry(), art: ART })
  assert.equal(parsed.packet.entries[1].id, 'grape')
})

test('目录分片：每片最多 8 条，坏条目只丢自己；整包仍在 4 KiB 内', () => {
  const many = Array.from({ length: MAX_CATALOG_ENTRIES_PER_PACKET + 4 }, (_, index) => entry({
    id: 'crop_' + index,
    name: '作物' + index,
    art: ART
  }))
  many.splice(3, 0, { id: 'BAD', name: '' })
  const buffer = encodeCropCatalog({ deviceId: DEVICE, catalogHash: HASH, chunk: 0, total: 1, entries: many })
  assert.ok(buffer.length <= MAX_PACKET_BYTES, '实际 ' + buffer.length + ' 字节')
  const parsed = parsePacket(buffer)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.packet.entries.length, MAX_CATALOG_ENTRIES_PER_PACKET)
  assert.equal(parsed.packet.entries.some((item) => item.id === 'BAD'), false)
})

test('目录分片：chunk/total/哈希/图元数据不合法都拒绝', () => {
  const good = { deviceId: DEVICE, catalogHash: HASH, chunk: 0, total: 1, entries: [entry()] }
  assert.throws(() => encodeCropCatalog({ ...good, chunk: 1, total: 1 }), /chunk/)
  assert.throws(() => encodeCropCatalog({ ...good, total: 0 }), /total/)
  assert.throws(() => encodeCropCatalog({ ...good, total: MAX_CATALOG_CHUNKS + 1 }), /total/)
  assert.throws(() => encodeCropCatalog({ ...good, catalogHash: 'nope' }), /catalog hash/)

  const wire = (patch) => JSON.stringify({ v: 1, type: 'crop-catalog', deviceId: DEVICE, ...good, ...patch })
  assert.equal(parsePacket(wire({ catalogHash: 'nope' })).reason, 'catalog-hash')
  assert.equal(parsePacket(wire({ chunk: 5, total: 2 })).reason, 'catalog-chunk')
  assert.equal(parsePacket(wire({ entries: 'nope' })).reason, 'catalog-entries')
  // 图元数据坏了只丢图，不丢这条定义。
  const dropped = parsePacket(wire({ entries: [entry({ art: { hash: 'x', ext: 'exe', bytes: 1 } })] }))
  assert.equal(dropped.ok, true)
  assert.equal('art' in dropped.packet.entries[0], false)
})

test('beacon 指纹：带上就解析，坏指纹只是不带、beacon 照常', () => {
  const good = parsePacket(encodePacket({
    type: 'beacon',
    deviceId: DEVICE,
    nickname: '小黄',
    port: 7340,
    caps: ['crops'],
    crops: { v: CATALOG_VERSION, hash: HASH, count: 7 }
  }))
  assert.equal(good.ok, true)
  assert.deepEqual(good.packet.crops, { v: CATALOG_VERSION, hash: HASH, count: 7 })
  assert.deepEqual(good.packet.caps, ['crops'])

  const raw = JSON.stringify({
    v: 1,
    type: 'beacon',
    deviceId: DEVICE,
    nickname: '小黄',
    port: 7340,
    crops: { v: 1, hash: 'nope', count: 7 }
  })
  const parsed = parsePacket(raw)
  assert.equal(parsed.ok, true, '坏指纹不该让整包失败')
  assert.equal('crops' in parsed.packet, false)
})

test('老版本兼容：陌生的目录报文类型在最外层就被丢掉', () => {
  const raw = JSON.stringify({ v: 1, type: 'crop-catalog-x', deviceId: DEVICE, hash: HASH })
  assert.deepEqual(parsePacket(raw), { ok: false, reason: 'type' })
})
