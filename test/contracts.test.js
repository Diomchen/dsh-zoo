import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CONTRACTS_FILE,
  CONTRACTS_VERSION,
  createContractStore,
  normalizeContractsFile
} from '../src/contracts.js'

const T0 = 1_700_000_000_000
const HOUR = 3600_000

function uuid () {
  return randomUUID()
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-contracts-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function outgoingRecord (overrides = {}) {
  return {
    id: uuid(),
    requestId: uuid(),
    workerDeviceId: uuid(),
    workerNickname: '阿蟹',
    hours: 4,
    wagePerHour: 10,
    wage: 40,
    fee: 2,
    startedAt: T0,
    endsAt: T0 + 4 * HOUR,
    ackedAt: T0,
    status: 'active',
    earned: 0,
    endedAt: null,
    endReason: null,
    lastSeenAt: T0,
    charged: true,
    refunded: false,
    settledAt: null,
    settleRequestId: null,
    guard: 0.5,
    ...overrides
  }
}

function incomingRecord (overrides = {}) {
  const id = uuid()
  return {
    id,
    requestId: uuid(),
    employerDeviceId: uuid(),
    employerNickname: '楼上的柯基',
    hours: 2,
    wagePerHour: 5,
    wage: 10,
    fee: 1,
    startedAt: T0,
    endsAt: T0 + 2 * HOUR,
    status: 'active',
    earned: 0,
    endedAt: null,
    endReason: null,
    lastSeenAt: T0,
    settledAt: null,
    settleRequestId: null,
    recallRequested: false,
    recallAcked: false,
    ...overrides
  }
}

function contractFile ({ outgoing = [], incoming = [] } = {}) {
  return { version: CONTRACTS_VERSION, outgoing, incoming }
}

test('文件缺失 → 空账本，不告警', async (t) => {
  const dir = await tempDir(t)
  const warnings = []
  const store = await createContractStore(dir, { log: { warn: (line) => warnings.push(line) }, now: () => T0 })
  assert.deepEqual(store.snapshot(), { outgoing: [], incoming: [] })
  assert.deepEqual(warnings, [])
})

test('坏 JSON / 错版本 / 非对象 → 空账本 + 只告警一次', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, CONTRACTS_FILE), '{oops', 'utf8')
  const warnings = []
  const store = await createContractStore(dir, { log: { warn: (line) => warnings.push(line) }, now: () => T0 })
  assert.deepEqual(store.snapshot(), { outgoing: [], incoming: [] })
  assert.equal(warnings.length, 1)

  await writeFile(join(dir, CONTRACTS_FILE), JSON.stringify({ version: 2 }), 'utf8')
  const second = []
  await createContractStore(dir, { log: { warn: (line) => second.push(line) }, now: () => T0 })
  assert.equal(second.length, 1)
})

test('坏条目只丢自己；同侧重复 id 留第一条', () => {
  const good = outgoingRecord()
  const duplicate = { ...good, workerNickname: '第二个' }
  const normalized = normalizeContractsFile(contractFile({
    outgoing: [
      good,
      duplicate,
      { ...outgoingRecord(), hours: 1 },
      { ...outgoingRecord(), wagePerHour: 101 },
      { ...outgoingRecord(), status: 'alien' },
      { ...outgoingRecord(), endsAt: T0 },
      { ...outgoingRecord(), workerDeviceId: 'not-a-uuid' },
      'nope'
    ]
  }))
  assert.equal(normalized.corrupt, false)
  assert.equal(normalized.contracts.outgoing.length, 1)
  assert.equal(normalized.contracts.outgoing[0].id, good.id)
  assert.ok(normalized.repaired >= 7)
})

test('归一化保留内部 WAL 字段并重算 wage/fee', () => {
  const record = outgoingRecord({
    wage: 9999,
    fee: 9999,
    settledAt: T0 + HOUR,
    status: 'ended',
    earned: 1000,
    charged: true,
    refunded: true,
    refundAmount: 12
  })
  const normalized = normalizeContractsFile(contractFile({ outgoing: [record] }))
  const [out] = normalized.contracts.outgoing
  assert.equal(out.wage, 40)
  assert.equal(out.fee, 2)
  assert.equal(out.earned, 40, 'earned 夹在 0..wage')
  assert.equal(out.settledAt, T0 + HOUR)
  assert.equal(out.charged, true)
  assert.equal(out.refunded, true)
  assert.equal(out.refundAmount, 12)
})

test('活动合同没有 ackedAt 时降级成 pending（重启对账退款）', () => {
  const record = outgoingRecord({ ackedAt: null })
  const normalized = normalizeContractsFile(contractFile({ outgoing: [record] }))
  assert.equal(normalized.contracts.outgoing[0].status, 'pending')
})

test('每侧 ≤20：先淘汰已结算/已取消，永不丢未结算', () => {
  const settled = []
  for (let index = 0; index < 25; index += 1) {
    settled.push(outgoingRecord({
      status: 'ended',
      endedAt: T0 + index,
      settledAt: T0 + index + 1,
      earned: 0
    }))
  }
  const active = outgoingRecord({ status: 'active', id: uuid(), requestId: uuid() })
  const endedUnsettled = outgoingRecord({ status: 'ended', endedAt: T0, settledAt: null, earned: 0 })
  const normalized = normalizeContractsFile(contractFile({ outgoing: [...settled, active, endedUnsettled] }))
  const list = normalized.contracts.outgoing
  assert.equal(list.length, 20)
  assert.ok(list.some((record) => record.id === active.id), 'active 不能被淘汰')
  assert.ok(list.some((record) => record.id === endedUnsettled.id), '未结算不能被淘汰')
})

test('store：beginOutgoing → markCharged → confirmOutgoing；落盘走 tmp/rename', async (t) => {
  const dir = await tempDir(t)
  const store = await createContractStore(dir, { now: () => T0 })
  const requestId = uuid()
  const workerDeviceId = uuid()
  const created = await store.beginOutgoing({
    requestId,
    workerDeviceId,
    workerNickname: '阿蟹',
    hours: 4,
    wagePerHour: 10
  })
  assert.equal(created.status, 'pending')
  assert.equal(created.charged, false)
  assert.equal(created.wage, 40)
  assert.equal(created.fee, 2)

  assert.equal(await store.markCharged(requestId), true)
  assert.equal(store.outgoing()[0].charged, true)

  const contractId = uuid()
  assert.equal(await store.confirmOutgoing(requestId, {
    contractId,
    startedAt: T0,
    endsAt: T0 + 4 * HOUR,
    guard: 0.5,
    ackedAt: T0
  }), true)
  const [active] = store.activeOutgoing()
  assert.equal(active.id, contractId)
  assert.equal(active.requestId, requestId)
  assert.equal(active.ackedAt, T0)

  const raw = JSON.parse(await readFile(join(dir, CONTRACTS_FILE), 'utf8'))
  assert.equal(raw.version, CONTRACTS_VERSION)
  assert.equal(raw.outgoing.length, 1)
  const leftovers = (await readdir(dir)).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

test('store：pending 取消幂等；结束时只动 active；noteSeen 刷新 lastSeenAt', async (t) => {
  const dir = await tempDir(t)
  const store = await createContractStore(dir, { now: () => T0 })
  const requestId = uuid()
  await store.beginOutgoing({ requestId, workerDeviceId: uuid(), hours: 2, wagePerHour: 3 })
  assert.equal(await store.cancelOutgoing(requestId), true)
  assert.equal(await store.cancelOutgoing(requestId), false)
  assert.equal(store.outgoing()[0].status, 'cancelled')

  const id = uuid()
  await store.beginIncoming({
    contractId: id,
    requestId: uuid(),
    employerDeviceId: uuid(),
    employerNickname: '柯基',
    hours: 2,
    wagePerHour: 5,
    startedAt: T0,
    endsAt: T0 + 2 * HOUR
  })
  assert.equal(await store.noteSeen(id, T0 + 1234), true)
  assert.equal(store.incoming()[0].lastSeenAt, T0 + 1234)
  assert.equal(await store.end(id, { endedAt: T0 + HOUR, reason: 'recall' }), true)
  assert.equal(await store.end(id, { endedAt: T0 + HOUR, reason: 'recall' }), false)
  const [ended] = store.incoming()
  assert.equal(ended.status, 'ended')
  assert.equal(ended.endReason, 'recall')
})

test('store：结算/退款 WAL 标记只生效一次', async (t) => {
  const dir = await tempDir(t)
  const store = await createContractStore(dir, { now: () => T0 })
  const id = uuid()
  await store.beginIncoming({
    contractId: id,
    requestId: uuid(),
    employerDeviceId: uuid(),
    hours: 2,
    wagePerHour: 5,
    startedAt: T0,
    endsAt: T0 + 2 * HOUR
  })
  await store.end(id, { endedAt: T0 + HOUR, reason: 'recall' })
  const settleRequestId = uuid()
  assert.equal(await store.beginSettle(id, { requestId: settleRequestId, servedMs: HOUR, earned: 5 }), true)
  assert.equal(await store.finishSettle(id, { earned: 5, servedMs: HOUR, settledAt: T0 + HOUR }), true)
  assert.equal(await store.finishSettle(id, { earned: 999, servedMs: HOUR }), false)
  const [record] = store.incoming()
  assert.equal(record.settledAt, T0 + HOUR)
  assert.equal(record.earned, 5)
})

test('store：重启后读回同一份账本；坏文件不覆盖', async (t) => {
  const dir = await tempDir(t)
  const first = await createContractStore(dir, { now: () => T0 })
  const requestId = uuid()
  await first.beginOutgoing({ requestId, workerDeviceId: uuid(), hours: 3, wagePerHour: 7 })
  const second = await createContractStore(dir, { now: () => T0 })
  assert.equal(second.outgoing().length, 1)
  assert.equal(second.outgoing()[0].requestId, requestId)
  assert.equal(second.outgoing()[0].wage, 21)
})
