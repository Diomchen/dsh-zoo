import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CONTRACT_STATUSES,
  MAX_CONTRACTS_PER_SIDE,
  MAX_CONTRACT_MS,
  contractMsOf,
  earnedFor,
  feeFor,
  isContractStatus,
  isEndReason,
  isSettleReason,
  normalizeHours,
  normalizeWage,
  provisionalEarned,
  wageFor
} from './contracts-rules.js'
import { parseJsonText } from './json-text.js'
import { isDeviceId, normalizeNickname } from './protocol.js'

// 文档/测试常直接从 store 模块取这个上限；真实来源在 contracts-rules。
export { MAX_CONTRACTS_PER_SIDE } from './contracts-rules.js'

/**
 * 雇佣合同账本（ticket 44）：`<dataDir>/contracts.json` v1。
 *
 * **方向（决策 D3，从 SPEC 字段反推、已拍板）：**
 *   - `outgoing` = **我是雇主**：`workerDeviceId / workerNickname` 是来我家打工的那只；
 *     我在雇佣时扣 `wage + fee`，结算时拿回 `wage − earned`。
 *   - `incoming` = **我的宠物是雇工**：`employerDeviceId / employerNickname` 雇了我；
 *     我不扣钱，结算时铸 `earned`。
 *   这与「outgoing = 我的宠物出门」的直觉相反；别按直觉改，改的是钱的方向。
 *
 * 状态机（只前进、所有结束函数幂等）：
 *   pending ──ack ok──▶ active ──到期/召回/结束/离线/拒绝──▶ ended ──settle-ack──▶ settled(settledAt)
 *      └─deny/超时/重启─▶ cancelled（已退款）
 *
 * 钱没有托管账户：合同里只有 `charged / refunded / settledAt` 这些**幂等标记**。
 * 写盘串行 + tmp/rename；坏条目只丢自己；每侧 ≤20；淘汰**永不丢**未结算合同。
 */
export const CONTRACTS_FILE = 'contracts.json'
export const CONTRACTS_VERSION = 1

const MAX_NICK = 32
const SIDES = Object.freeze(['outgoing', 'incoming'])

function finiteNumber (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }
  return null
}

function timestamp (value) {
  const num = finiteNumber(value)
  if (num === null || num <= 0) return null
  return Math.floor(num)
}

function integerOr (value, fallback = 0) {
  const num = finiteNumber(value)
  return num === null ? fallback : Math.floor(num)
}

function normalizeId (value, { requireLower = true } = {}) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (!isDeviceId(id)) return null
  return requireLower ? id.toLowerCase() : id
}

function normalizeGuard (value) {
  const num = finiteNumber(value)
  if (num === null) return 0
  return Math.min(0.8, Math.max(0, num))
}

/** 一条合同记录在校验里是「好」还是「丢」。返回 record 或 null。 */
function normalizeRecord (raw, side) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = normalizeId(raw.id)
  if (id === null) return null
  const requestId = normalizeId(raw.requestId)
  if (requestId === null) return null
  let status = raw.status === undefined
    ? (side === 'outgoing' ? 'pending' : 'active')
    : (isContractStatus(raw.status) ? raw.status : null)
  if (status === null) return null
  if (side === 'outgoing' && status === 'active' && !raw.ackedAt) {
    // 旧文件/手改：active 没有 ack 时间就无法结算，退回 pending 由重启对账退款。
    status = 'pending'
  }
  const hours = normalizeHours(raw.hours)
  const wagePerHour = normalizeWage(raw.wagePerHour)
  if (hours === null || wagePerHour === null) return null
  const wage = wageFor(wagePerHour, hours)
  if (wage <= 0) return null
  const startedAt = timestamp(raw.startedAt)
  const endsAt = timestamp(raw.endsAt)
  if (startedAt === null || endsAt === null) return null
  const contractMs = contractMsOf(startedAt, endsAt)
  if (contractMs <= 0 || contractMs > MAX_CONTRACT_MS) return null

  const workerDeviceId = side === 'outgoing' ? normalizeId(raw.workerDeviceId) : null
  const employerDeviceId = side === 'incoming' ? normalizeId(raw.employerDeviceId) : null
  if (side === 'outgoing' && workerDeviceId === null) return null
  if (side === 'incoming' && employerDeviceId === null) return null

  const endedAt = timestamp(raw.endedAt)
  const settledAt = timestamp(raw.settledAt)
  const settleRequestId = raw.settleRequestId === null || raw.settleRequestId === undefined
    ? null
    : normalizeId(raw.settleRequestId)
  const statusPool = CONTRACT_STATUSES.includes(status) ? status : 'ended'

  const record = {
    id,
    requestId,
    ...(side === 'outgoing'
      ? {
          workerDeviceId,
          workerNickname: normalizeNickname(raw.workerNickname) ?? '邻居'
        }
      : {
          employerDeviceId,
          employerNickname: normalizeNickname(raw.employerNickname) ?? '邻居'
        }),
    hours,
    wagePerHour,
    wage,
    fee: feeFor(wage),
    startedAt,
    endsAt,
    ackedAt: timestamp(raw.ackedAt),
    status: statusPool,
    earned: Math.min(wage, Math.max(0, integerOr(raw.earned))),
    endedAt: endedAt ?? null,
    endReason: isEndReason(raw.endReason) ? raw.endReason : null,
    lastSeenAt: timestamp(raw.lastSeenAt) ?? startedAt,
    // WAL 标记：写入之后才动钱；崩溃窗口按「已经动过」处理（fail-closed）。
    charged: raw.charged === true,
    chargedAt: timestamp(raw.chargedAt),
    refundStartedAt: timestamp(raw.refundStartedAt),
    refunded: raw.refunded === true,
    refundedAt: timestamp(raw.refundedAt),
    refundAmount: Math.max(0, integerOr(raw.refundAmount)),
    settleStartedAt: timestamp(raw.settleStartedAt),
    settledAt: settledAt ?? null,
    settleRequestId,
    settleServedMs: Math.max(0, integerOr(raw.settleServedMs)),
    recallRequested: raw.recallRequested === true,
    recallAcked: raw.recallAcked === true,
    guard: normalizeGuard(raw.guard)
  }
  // 不变量：settled 就意味着 ended；cancelled 不可能有 settledAt。
  if (record.settledAt !== null && record.status !== 'ended') record.status = 'ended'
  if (record.status === 'cancelled') record.settledAt = null
  return record
}

/** 文件的容错读取：坏条目只丢自己；返回 `{ outgoing, incoming, corrupt, repaired }`。 */
export function normalizeContractsFile (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { contracts: { outgoing: [], incoming: [] }, corrupt: true, repaired: 0 }
  }
  if (value.version !== undefined && value.version !== CONTRACTS_VERSION) {
    return { contracts: { outgoing: [], incoming: [] }, corrupt: true, repaired: 0 }
  }
  let repaired = 0
  const contracts = { outgoing: [], incoming: [] }
  for (const side of SIDES) {
    const list = Array.isArray(value[side]) ? value[side] : []
    if (value[side] !== undefined && !Array.isArray(value[side])) repaired += 1
    const seen = new Set()
    for (const raw of list) {
      const record = normalizeRecord(raw, side)
      if (record === null) {
        repaired += 1
        continue
      }
      if (seen.has(record.id)) {
        repaired += 1
        continue
      }
      seen.add(record.id)
      contracts[side].push(record)
    }
    contracts[side] = trimSide(contracts[side])
  }
  return { contracts, corrupt: false, repaired }
}

/** 淘汰规则：先丢最旧的已结算/已取消；**永不丢** active 或 ended 未结算。 */
function trimSide (list) {
  if (list.length <= MAX_CONTRACTS_PER_SIDE) return list
  const kept = [...list]
  const droppable = (record) =>
    record.status === 'cancelled' ||
    (record.status === 'ended' && record.settledAt !== null) ||
    (record.status === 'pending' && record.refunded === true)
  // 旧文件没有顺序保证：按 endedAt/startedAt 从旧到新摘。
  const sorted = [...kept]
    .filter(droppable)
    .sort((left, right) => (left.endedAt ?? left.startedAt) - (right.endedAt ?? right.startedAt))
  for (const record of sorted) {
    if (kept.length <= MAX_CONTRACTS_PER_SIDE) break
    const index = kept.indexOf(record)
    if (index >= 0) kept.splice(index, 1)
  }
  // 全部都是未结算合同：宁可超 20 条（并告警），也不能把钱丢掉。
  return kept
}

function copyRecord (record) {
  return { ...record }
}

function toFileState (contracts) {
  return {
    version: CONTRACTS_VERSION,
    outgoing: contracts.outgoing.map(copyRecord),
    incoming: contracts.incoming.map(copyRecord)
  }
}

export async function createContractStore (dir, { log, now = Date.now } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('contracts: missing data directory')
  const store = new ContractStore({ dir, log, now })
  await store.load()
  return store
}

class ContractStore {
  #dir
  #log
  #now
  #contracts = { outgoing: [], incoming: [] }
  #warned = new Set()
  #chain = Promise.resolve()
  #lastSeenWriteAt = Number.NEGATIVE_INFINITY
  #writeChain = Promise.resolve()

  constructor ({ dir, log, now }) {
    this.#dir = dir
    this.#log = log
    const clock = typeof now === 'function' ? now : () => now
    this.#now = () => {
      const stamp = Number(clock())
      return Number.isFinite(stamp) ? stamp : Date.now()
    }
  }

  async load () {
    let text
    try {
      text = await readFile(join(this.#dir, CONTRACTS_FILE), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#warnOnce('read', '合同读不出来，先按空账本运行（' + errorName(error) + '）')
      }
      return
    }
    let raw
    try {
      raw = parseJsonText(text)
    } catch {
      this.#warnOnce('parse', '合同不是合法 JSON，先按空账本运行')
      return
    }
    const normalized = normalizeContractsFile(raw)
    this.#contracts = normalized.contracts
    if (normalized.corrupt) {
      this.#warnOnce('shape', '合同文件形状不对，先按空账本运行')
    } else if (normalized.repaired > 0) {
      this.#warnOnce('entries', '合同里有 ' + normalized.repaired + ' 处格式不对，已丢掉坏条目')
    }
  }

  snapshot () {
    return {
      outgoing: this.#contracts.outgoing.map(copyRecord),
      incoming: this.#contracts.incoming.map(copyRecord)
    }
  }

  outgoing () {
    return this.#contracts.outgoing.map(copyRecord)
  }

  incoming () {
    return this.#contracts.incoming.map(copyRecord)
  }

  /** 两侧都查；`{ side, record }` 或 null。 */
  byId (id) {
    const key = typeof id === 'string' ? id.trim().toLowerCase() : ''
    if (key === '') return null
    for (const side of SIDES) {
      const record = this.#contracts[side].find((candidate) => candidate.id === key)
      if (record !== undefined) return { side, record: copyRecord(record) }
    }
    return null
  }

  byRequestId (requestId) {
    const key = typeof requestId === 'string' ? requestId.trim().toLowerCase() : ''
    if (key === '') return null
    for (const side of SIDES) {
      const record = this.#contracts[side].find((candidate) => candidate.requestId === key)
      if (record !== undefined) return { side, record: copyRecord(record) }
    }
    return null
  }

  activeOutgoing () {
    return this.#contracts.outgoing.filter((record) => record.status === 'active').map(copyRecord)
  }

  activeIncoming () {
    return this.#contracts.incoming.filter((record) => record.status === 'active').map(copyRecord)
  }

  pendingOutgoing () {
    return this.#contracts.outgoing.filter((record) => record.status === 'pending').map(copyRecord)
  }

  /** 雇主侧还没结算的 ended（要发 work-settle）。 */
  unsettledOutgoing () {
    return this.#contracts.outgoing
      .filter((record) => record.status === 'ended' && record.settledAt === null)
      .map(copyRecord)
  }

  /** 雇工侧还没结算的 ended（等雇主发 work-settle）。 */
  unsettledIncoming () {
    return this.#contracts.incoming
      .filter((record) => record.status === 'ended' && record.settledAt === null)
      .map(copyRecord)
  }

  /** 新建一笔「我要雇人」的 pending；先落盘再扣钱。 */
  beginOutgoing ({ requestId, workerDeviceId, workerNickname, hours, wagePerHour } = {}) {
    return this.#enqueue(async () => {
      const request = normalizeId(requestId)
      const worker = normalizeId(workerDeviceId)
      const safeHours = normalizeHours(hours)
      const safeWage = normalizeWage(wagePerHour)
      if (request === null || worker === null || safeHours === null || safeWage === null) return null
      if (this.#contracts.outgoing.some((record) => record.requestId === request)) return null
      const now = this.#nowMs()
      const record = {
        id: request,
        requestId: request,
        workerDeviceId: worker,
        workerNickname: normalizeNickname(workerNickname) ?? '邻居',
        hours: safeHours,
        wagePerHour: safeWage,
        wage: wageFor(safeWage, safeHours),
        fee: feeFor(wageFor(safeWage, safeHours)),
        startedAt: now,
        endsAt: now + safeHours * 60 * 60 * 1000,
        ackedAt: null,
        status: 'pending',
        earned: 0,
        endedAt: null,
        endReason: null,
        lastSeenAt: now,
        charged: false,
        chargedAt: null,
        refundStartedAt: null,
        refunded: false,
        refundedAt: null,
        refundAmount: 0,
        settleStartedAt: null,
        settledAt: null,
        settleRequestId: null,
        settleServedMs: 0,
        recallRequested: false,
        recallAcked: false,
        guard: 0.5
      }
      this.#contracts.outgoing.unshift(record)
      this.#trim('outgoing')
      await this.#persist()
      return copyRecord(record)
    })
  }

  markCharged (requestId) {
    return this.#updateByRequest('outgoing', requestId, (record) => {
      record.charged = true
      record.chargedAt = this.#nowMs()
    })
  }

  cancelOutgoing (requestId, reason = 'cancelled') {
    return this.#updateByRequest('outgoing', requestId, (record) => {
      if (record.status !== 'pending') return false
      record.status = 'cancelled'
      record.endReason = isEndReason(reason) ? reason : 'cancelled'
      record.endedAt = this.#nowMs()
    })
  }

  /** pending → active；id 改成 ack 里的 contractId，ack 时间只有本地钟。 */
  confirmOutgoing (requestId, { contractId, startedAt, endsAt, guard, ackedAt } = {}) {
    return this.#updateByRequest('outgoing', requestId, (record) => {
      if (record.status !== 'pending') return false
      const id = normalizeId(contractId)
      const start = timestamp(startedAt)
      const end = timestamp(endsAt)
      if (id === null || start === null || end === null) return false
      if (contractMsOf(start, end) <= 0) return false
      record.id = id
      record.status = 'active'
      record.startedAt = start
      record.endsAt = end
      record.guard = normalizeGuard(guard)
      record.ackedAt = timestamp(ackedAt) ?? this.#nowMs()
      record.lastSeenAt = record.ackedAt
    })
  }

  /** 新建 incoming（我是雇工）；ack 发出去之前必须先落盘。 */
  beginIncoming ({
    contractId,
    requestId,
    employerDeviceId,
    employerNickname,
    hours,
    wagePerHour,
    startedAt,
    endsAt,
    guard
  } = {}) {
    return this.#enqueue(async () => {
      const id = normalizeId(contractId)
      const request = normalizeId(requestId)
      const employer = normalizeId(employerDeviceId)
      const safeHours = normalizeHours(hours)
      const safeWage = normalizeWage(wagePerHour)
      const start = timestamp(startedAt)
      const end = timestamp(endsAt)
      if (id === null || request === null || employer === null) return null
      if (safeHours === null || safeWage === null || start === null || end === null) return null
      if (contractMsOf(start, end) <= 0) return null
      if (this.#contracts.incoming.some((record) => record.id === id || record.requestId === request)) {
        return null
      }
      const now = this.#nowMs()
      const record = {
        id,
        requestId: request,
        employerDeviceId: employer,
        employerNickname: normalizeNickname(employerNickname) ?? '邻居',
        hours: safeHours,
        wagePerHour: safeWage,
        wage: wageFor(safeWage, safeHours),
        fee: feeFor(wageFor(safeWage, safeHours)),
        startedAt: start,
        endsAt: end,
        ackedAt: null,
        status: 'active',
        earned: 0,
        endedAt: null,
        endReason: null,
        lastSeenAt: now,
        charged: false,
        chargedAt: null,
        refundStartedAt: null,
        refunded: false,
        refundedAt: null,
        refundAmount: 0,
        settleStartedAt: null,
        settledAt: null,
        settleRequestId: null,
        settleServedMs: 0,
        recallRequested: false,
        recallAcked: false,
        guard: normalizeGuard(guard)
      }
      this.#contracts.incoming.unshift(record)
      this.#trim('incoming')
      await this.#persist()
      return copyRecord(record)
    })
  }

  /** active → ended（幂等：只有 active 会动）。 */
  end (id, { endedAt, reason } = {}) {
    return this.#enqueue(async () => {
      const found = this.#find(id)
      if (found === null) return false
      const { record } = found
      if (record.status !== 'active') return false
      record.status = 'ended'
      record.endedAt = timestamp(endedAt) ?? this.#nowMs()
      record.endReason = isEndReason(reason) ? reason : 'cancelled'
      await this.#persist()
      return true
    })
  }

  /** 心跳/合同活动：刷新 lastSeenAt；落盘最多每 60 秒一次（崩溃最多少算一分钟）。 */
  noteSeen (id, at = this.#nowMs()) {
    return this.#enqueue(async () => {
      const found = this.#find(id)
      if (found === null) return false
      const stamp = timestamp(at) ?? this.#nowMs()
      if (stamp > found.record.lastSeenAt) found.record.lastSeenAt = stamp
      if (this.#nowMs() - this.#lastSeenWriteAt >= 60 * 1000) {
        this.#lastSeenWriteAt = this.#nowMs()
        await this.#persist()
      }
      return true
    })
  }

  /** 结算意图先写盘，再动钱（WAL）。 */
  beginSettle (id, { requestId, servedMs, earned, reason } = {}) {
    return this.#updateById(id, (record) => {
      const request = normalizeId(requestId)
      if (request !== null) record.settleRequestId = request
      record.settleStartedAt = this.#nowMs()
      record.settleServedMs = Math.max(0, integerOr(servedMs))
      if (isSettleReason(reason)) record.endReason = reason
      record.earned = Math.min(record.wage, Math.max(0, integerOr(earned, record.earned)))
    })
  }

  markRefundStarted (id, amount) {
    return this.#updateById(id, (record) => {
      if (record.refunded) return false
      record.refundStartedAt = this.#nowMs()
      record.refundAmount = Math.max(0, integerOr(amount, record.refundAmount))
    })
  }

  markRefunded (id, { amount, at } = {}) {
    return this.#updateById(id, (record) => {
      record.refunded = true
      record.refundedAt = timestamp(at) ?? this.#nowMs()
      if (amount !== undefined) record.refundAmount = Math.max(0, integerOr(amount, record.refundAmount))
      record.refundStartedAt = record.refundStartedAt ?? record.refundedAt
    })
  }

  /** 雇工侧：结算完成（只有一次；重复调用不改金额）。 */
  finishSettle (id, { earned, servedMs, settledAt, reason } = {}) {
    return this.#updateById(id, (record) => {
      if (record.settledAt !== null) return false
      record.settledAt = timestamp(settledAt) ?? this.#nowMs()
      record.earned = Math.min(record.wage, Math.max(0, integerOr(earned, record.earned)))
      if (servedMs !== undefined) record.settleServedMs = Math.max(0, integerOr(servedMs))
      if (isSettleReason(reason)) record.endReason = reason
      record.status = 'ended'
      record.endedAt = record.endedAt ?? record.settledAt
      record.settleStartedAt = record.settleStartedAt ?? record.settledAt
    })
  }

  setRecallRequested (id, at = this.#nowMs()) {
    return this.#updateById(id, (record) => {
      if (record.status !== 'active') return false
      record.recallRequested = true
      record.recallAcked = false
      record.recallRequestedAt = timestamp(at) ?? this.#nowMs()
    })
  }

  markRecallAcked (id) {
    return this.#updateById(id, (record) => {
      record.recallAcked = true
    })
  }

  /** 结算/召回的重试时间只活在这里；重启后由 service 立刻重试一次。 */
  noteSettleAttempt (id, requestId, at = this.#nowMs()) {
    return this.#updateById(id, (record) => {
      if (requestId !== undefined && record.settleRequestId === null) {
        record.settleRequestId = normalizeId(requestId)
      }
      record.settleStartedAt = record.settleStartedAt ?? (timestamp(at) ?? this.#nowMs())
    })
  }

  async endAllActive (endedAt = this.#nowMs(), reason = 'shutdown') {
    return this.#enqueue(async () => {
      let changed = false
      for (const side of SIDES) {
        for (const record of this.#contracts[side]) {
          if (record.status !== 'active') continue
          record.status = 'ended'
          record.endedAt = timestamp(endedAt) ?? this.#nowMs()
          record.endReason = isEndReason(reason) ? reason : 'shutdown'
          changed = true
        }
      }
      if (changed) await this.#persist()
      return changed
    })
  }

  /** 窗口/`/state` 的公开视图：内部 WAL 字段不出门。 */
  windowView (now = this.#nowMs()) {
    const view = (record) => {
      const remaining = Math.max(0, record.endsAt - now)
      return {
        id: record.id,
        requestId: record.requestId,
        ...(record.workerDeviceId === undefined
          ? { employerDeviceId: record.employerDeviceId, employerNickname: record.employerNickname }
          : { workerDeviceId: record.workerDeviceId, workerNickname: record.workerNickname }),
        hours: record.hours,
        wagePerHour: record.wagePerHour,
        wage: record.wage,
        fee: record.fee,
        startedAt: record.startedAt,
        endsAt: record.endsAt,
        ackedAt: record.ackedAt,
        status: record.status,
        earned: record.earned,
        endedAt: record.endedAt,
        endReason: record.endReason,
        settled: record.settledAt !== null,
        settledAt: record.settledAt,
        recallRequested: record.recallRequested,
        remainingMs: record.status === 'active' ? Math.min(remaining, MAX_CONTRACT_MS) : 0,
        // 只给窗口画「大概」，绝不用于结算。
        provisionalEarned: record.status === 'active' ? provisionalEarned(record, now) : record.earned
      }
    }
    return {
      outgoing: this.#contracts.outgoing.map(view),
      incoming: this.#contracts.incoming.map(view)
    }
  }

  #nowMs () {
    return this.#now()
  }

  #find (id) {
    const key = typeof id === 'string' ? id.trim().toLowerCase() : ''
    if (key === '') return null
    for (const side of SIDES) {
      const record = this.#contracts[side].find((candidate) => candidate.id === key)
      if (record !== undefined) return { side, record }
    }
    return null
  }

  #trim (side) {
    const list = this.#contracts[side]
    if (list.length <= MAX_CONTRACTS_PER_SIDE) return
    const before = list.length
    this.#contracts[side] = trimSide(list, side)
    if (this.#contracts[side].length < before) {
      this.#warnOnce('cap-' + side, '合同超过 ' + MAX_CONTRACTS_PER_SIDE +
        ' 条，已淘汰最旧的已结算记录（未结算的永不丢）')
    } else if (before > MAX_CONTRACTS_PER_SIDE) {
      this.#warnOnce('cap-keep-' + side, '合同超过 ' + MAX_CONTRACTS_PER_SIDE +
        ' 条且都未结算；先保留，结算后自动收敛')
    }
  }

  #updateById (id, mutate) {
    return this.#enqueue(async () => {
      const found = this.#find(id)
      if (found === null) return false
      const result = mutate(found.record)
      if (result === false) return false
      await this.#persist()
      return true
    })
  }

  #updateByRequest (side, requestId, mutate) {
    return this.#enqueue(async () => {
      const key = typeof requestId === 'string' ? requestId.trim().toLowerCase() : ''
      const record = this.#contracts[side].find((candidate) => candidate.requestId === key)
      if (record === undefined) return false
      const result = mutate(record)
      if (result === false) return false
      await this.#persist()
      return true
    })
  }

  #enqueue (task) {
    const run = this.#chain.then(task, task)
    this.#chain = run.then(() => {}, () => {})
    return run
  }

  #persist () {
    const target = join(this.#dir, CONTRACTS_FILE)
    const tmp = target + '.tmp-' + randomUUID()
    const run = this.#writeChain.then(async () => {
      try {
        await mkdir(this.#dir, { recursive: true, mode: 0o700 })
        const body = JSON.stringify(toFileState(this.#contracts), null, 2) + '\n'
        await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
        await rename(tmp, target)
        return true
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {})
        this.#warnOnce('write', '合同写不进去：本次运行仍然能用，但重启后可能丢（' + errorName(error) + '）')
        return false
      }
    })
    this.#writeChain = run.then(() => {}, () => {})
    return run
  }

  #warnOnce (key, message) {
    if (this.#warned.has(key)) return
    this.#warned.add(key)
    try {
      this.#log?.warn?.(message)
    } catch {
      // 日志不能反过来把插件搞崩
    }
  }
}

function errorName (error) {
  return error instanceof Error ? error.name : String(error)
}
