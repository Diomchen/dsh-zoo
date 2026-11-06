import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTRACT_END_REASONS,
  CONTRACT_STATUSES,
  MAX_CONTRACTS_PER_SIDE,
  MAX_CONTRACT_HOURS,
  MAX_CONTRACT_MS,
  MAX_CONTRACT_WAGE,
  MIN_CONTRACT_HOURS,
  MIN_CONTRACT_WAGE,
  WORK_ERRORS,
  WORK_FEE_RATE,
  contractMsOf,
  earnedFor,
  feeFor,
  isContractStatus,
  isEndReason,
  isHireReason,
  isSettleReason,
  isWorkError,
  normalizeHours,
  normalizeWage,
  provisionalEarned,
  refundFor,
  servedMsOf,
  totalCost,
  wageFor
} from '../src/contracts-rules.js'
import { MAX_HIRE_HOURS, MAX_WAGE, MIN_HIRE_HOURS, MIN_WAGE } from '../src/farm.js'
import {
  HIRE_HOURS_MAX,
  HIRE_HOURS_MIN,
  HIRE_WAGE_MAX,
  HIRE_WAGE_MIN
} from '../src/protocol.js'

test('合同常量与农场/协议同源，防漂移', () => {
  assert.equal(MIN_CONTRACT_HOURS, MIN_HIRE_HOURS)
  assert.equal(MAX_CONTRACT_HOURS, MAX_HIRE_HOURS)
  assert.equal(MIN_CONTRACT_HOURS, HIRE_HOURS_MIN)
  assert.equal(MAX_CONTRACT_HOURS, HIRE_HOURS_MAX)
  assert.equal(MIN_CONTRACT_WAGE, MIN_WAGE)
  assert.equal(MAX_CONTRACT_WAGE, MAX_WAGE)
  assert.equal(MIN_CONTRACT_WAGE, HIRE_WAGE_MIN)
  assert.equal(MAX_CONTRACT_WAGE, HIRE_WAGE_MAX)
  assert.equal(MAX_CONTRACT_MS, 8 * 60 * 60 * 1000)
  assert.equal(WORK_FEE_RATE, 0.05)
  assert.equal(MAX_CONTRACTS_PER_SIDE, 20)
})

test('手续费 ceil(wage×5%)、最低 1', () => {
  assert.equal(feeFor(1), 1)
  assert.equal(feeFor(10), 1)
  assert.equal(feeFor(20), 1)
  assert.equal(feeFor(21), 2)
  assert.equal(feeFor(40), 2)
  assert.equal(feeFor(100), 5)
  assert.equal(feeFor(800), 40)
  assert.equal(feeFor(0), 0)
  assert.equal(feeFor(-5), 0)
  assert.equal(feeFor('abc'), 0)
})

test('工资、总价与合同时长', () => {
  assert.equal(wageFor(10, 4), 40)
  assert.equal(wageFor(1, 2), 2)
  assert.deepEqual(totalCost(10, 4), { wage: 40, fee: 2, total: 42 })
  assert.deepEqual(totalCost(1, 2), { wage: 2, fee: 1, total: 3 })
  assert.equal(contractMsOf(1000, 1000 + MAX_CONTRACT_MS), MAX_CONTRACT_MS)
  assert.equal(contractMsOf(1000, 500), 0)
  assert.equal(contractMsOf('x', 500), 0)
})

test('servedMs 夹在 0..contractMs；earned 用 floor 并夹在 0..wage', () => {
  const contractMs = 4 * 3600_000
  assert.equal(servedMsOf(1000, 1000 + contractMs, contractMs), contractMs)
  assert.equal(servedMsOf(1000, 500, contractMs), 0)
  assert.equal(servedMsOf(1000, 1000 + contractMs * 2, contractMs), contractMs)
  assert.equal(servedMsOf(Number.NaN, 1, contractMs), 0)

  assert.equal(earnedFor(40, contractMs, contractMs), 40)
  assert.equal(earnedFor(40, 0, contractMs), 0)
  assert.equal(earnedFor(40, contractMs / 2, contractMs), 20)
  assert.equal(earnedFor(40, contractMs * 2, contractMs), 40)
  assert.equal(earnedFor(40, 1, contractMs), 0)
  assert.equal(earnedFor(40, contractMs, 0), 0)
  assert.equal(refundFor(40, 0), 40)
  assert.equal(refundFor(40, 10), 30)
  assert.equal(refundFor(40, 40), 0)
  assert.equal(refundFor(40, 999), 0)
})

test('provisionalEarned 只按雇主本地 ack 起点估，不越界', () => {
  const startedAt = 1000
  const endsAt = startedAt + 4 * 3600_000
  const ackedAt = startedAt + 1000
  const record = { wage: 40, startedAt, endsAt, ackedAt }
  assert.equal(provisionalEarned(record, ackedAt), 0)
  assert.equal(provisionalEarned(record, ackedAt + 2 * 3600_000), 20)
  assert.equal(provisionalEarned(record, endsAt + 10 * 3600_000), 40)
  // ended 之后不再随时间涨。
  assert.equal(provisionalEarned({ ...record, endedAt: ackedAt + 3600_000 }, endsAt), 10)
})

test('枚举/范围校验', () => {
  for (const status of ['pending', 'active', 'ended', 'cancelled']) {
    assert.equal(isContractStatus(status), true)
    assert.equal(CONTRACT_STATUSES.includes(status), true)
  }
  assert.equal(isContractStatus('settled'), false)
  for (const reason of ['expired', 'offline', 'recall', 'employer-end', 'denied', 'cancelled', 'shutdown', 'restart']) {
    assert.equal(isEndReason(reason), true)
    assert.equal(CONTRACT_END_REASONS.includes(reason), true)
  }
  assert.equal(isEndReason('whatever'), false)
  assert.equal(isSettleReason('completed'), true)
  assert.equal(isSettleReason('whatever'), false)
  for (const error of ['own-pet', 'worker-unavailable', 'already-working', 'already-hired', 'bad-wage', 'bad-hours', 'no-coin', 'contract-not-found', 'contract-ended', 'contract-busy', 'busy', 'starting']) {
    assert.equal(isWorkError(error), true, error)
    assert.equal(WORK_ERRORS.includes(error), true)
  }
  assert.equal(isWorkError('nope'), false)
  assert.equal(isHireReason('ready'), true)
  assert.equal(isHireReason('off'), true)
  assert.equal(isHireReason('visiting'), true)
  assert.equal(isHireReason('working'), true)
  assert.equal(isHireReason('nope'), false)

  assert.equal(normalizeHours(2), 2)
  assert.equal(normalizeHours(8), 8)
  assert.equal(normalizeHours(1), null)
  assert.equal(normalizeHours(9), null)
  assert.equal(normalizeHours(2.9), 2)
  assert.equal(normalizeWage(1), 1)
  assert.equal(normalizeWage(100), 100)
  assert.equal(normalizeWage(0), null)
  assert.equal(normalizeWage(101), null)
})
