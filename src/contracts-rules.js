/**
 * 雇佣合同的纯规则（ticket 44）。没有 I/O、没有时钟：输入就是数字/记录，输出就是数字/枚举。
 *
 * 钱的方向（SPEC v5 + 决策 D3/D4）：
 *   - 雇主预付 `wage = 时薪 × 时长`，另付手续费 `fee = ceil(wage × 5%)`（最低 1，烧掉）；
 *   - 结算时雇主拿回 `wage − earned`，雇工主人铸 `earned`；
 *   - `earned = floor(wage × servedMs / contractMs)`，`servedMs` 只取**雇主本地时钟**从
 *     收到 ack 到结束的差值（跨机时钟只借 `endsAt − startedAt` 这个差值）。
 *
 * 这些常量与 `src/farm.js` / `src/protocol.js` 同源；改一处必须三处一起改
 * （`test/contracts-rules.test.js` 有一条断言专门防漂移）。
 */

export const MIN_CONTRACT_HOURS = 2
export const MAX_CONTRACT_HOURS = 8
export const MIN_CONTRACT_WAGE = 1
export const MAX_CONTRACT_WAGE = 100
/** 手续费 5%（向上取整、最低 1）：低价合同也不能零手续费。 */
export const WORK_FEE_RATE = 0.05
export const MAX_CONTRACT_MS = MAX_CONTRACT_HOURS * 60 * 60 * 1000
/** 一侧最多 20 条；淘汰永不丢未结算合同。 */
export const MAX_CONTRACTS_PER_SIDE = 20

export const CONTRACT_STATUSES = Object.freeze(['pending', 'active', 'ended', 'cancelled'])
/**
 * 结束原因固定枚举（报文/合同/日志共用）。`completed` 只出现在结算报文里，
 * 表示「按整段合同结算」，不是合同状态。
 */
export const CONTRACT_END_REASONS = Object.freeze([
  'expired',
  'offline',
  'recall',
  'employer-end',
  'denied',
  'cancelled',
  'shutdown',
  'restart',
  'completed'
])
/** `work-settle` 的 reason：只在两种语义里选，不转发自由文本。 */
export const WORK_SETTLE_REASONS = Object.freeze(['completed', 'recall', 'employer-end', 'offline', 'expired'])
/** 合同相关的错误码（协议 ack、桌面动作、HTTP 动作共用一套）。 */
export const WORK_ERRORS = Object.freeze([
  'own-pet',
  'worker-unavailable',
  'already-working',
  'already-hired',
  'bad-wage',
  'bad-hours',
  'no-coin',
  'contract-not-found',
  'contract-ended',
  'contract-busy',
  'busy',
  'starting'
])
/** 挂牌不可用的原因（digest 的 `reason` 字段）。 */
export const HIRE_REASONS = Object.freeze(['ready', 'off', 'visiting', 'working'])

const STATUS_SET = new Set(CONTRACT_STATUSES)
const END_REASON_SET = new Set(CONTRACT_END_REASONS)
const SETTLE_REASON_SET = new Set(WORK_SETTLE_REASONS)
const WORK_ERROR_SET = new Set(WORK_ERRORS)
const HIRE_REASON_SET = new Set(HIRE_REASONS)

function finiteInt (value, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  const int = Math.floor(num)
  if (int < min || int > max) return null
  return int
}

/** 时薪 1–100 的整数；其余 null。 */
export function normalizeWage (value) {
  return finiteInt(value, MIN_CONTRACT_WAGE, MAX_CONTRACT_WAGE)
}

/** 合同时长 2–8 小时的整数；其余 null。 */
export function normalizeHours (value) {
  return finiteInt(value, MIN_CONTRACT_HOURS, MAX_CONTRACT_HOURS)
}

/** 手续费：`ceil(wage × 0.05)`，最低 1；非法/非正工资返回 0。 */
export function feeFor (wage) {
  const amount = Number(wage)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return Math.max(1, Math.ceil(amount * WORK_FEE_RATE))
}

/** 合同工资：时薪 × 时长；任一项非法返回 0。 */
export function wageFor (wagePerHour, hours) {
  const rate = Number(wagePerHour)
  const count = Number(hours)
  if (!Number.isFinite(rate) || !Number.isFinite(count) || rate <= 0 || count <= 0) return 0
  return Math.round(rate * count)
}

/** 雇主一次要付的钱：工资 + 手续费。 */
export function totalCost (wagePerHour, hours) {
  const wage = wageFor(wagePerHour, hours)
  const fee = feeFor(wage)
  return { wage, fee, total: wage + fee }
}

/** `endsAt − startedAt`；坏值返回 0（绝不 NaN）。 */
export function contractMsOf (startedAt, endsAt) {
  const start = Number(startedAt)
  const end = Number(endsAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  return Math.min(MAX_CONTRACT_MS, end - start)
}

/** 服务毫秒：雇主本地 ackedAt → endedAt，夹在 0..contractMs。 */
export function servedMsOf (ackedAt, endedAt, contractMs) {
  const start = Number(ackedAt)
  const end = Number(endedAt)
  const total = Number(contractMs)
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(total, Math.max(0, end - start))
}

/** `earned = floor(wage × servedMs / contractMs)`，夹在 0..wage。 */
export function earnedFor (wage, servedMs, contractMs) {
  const amount = Number(wage)
  const served = Number(servedMs)
  const total = Number(contractMs)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  if (!Number.isFinite(served) || !Number.isFinite(total) || total <= 0) return 0
  const ratio = Math.min(1, Math.max(0, served / total))
  return Math.min(amount, Math.max(0, Math.floor(amount * ratio)))
}

/** 雇主拿回的剩余工资（手续费不退）。 */
export function refundFor (wage, earned) {
  const amount = Number(wage)
  const paid = Number(earned)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  if (!Number.isFinite(paid) || paid <= 0) return amount
  return Math.max(0, amount - Math.min(amount, Math.floor(paid)))
}

/**
 * 只给 UI 显示用的「大概能拿多少」：合同还在跑时按 now 估，结算时以雇主报文里的
 * `servedMs` 为准。**绝不**用这个值动钱。
 */
export function provisionalEarned (record, now) {
  if (record === null || typeof record !== 'object') return 0
  // 纯函数：时钟必须由调用方给（窗口/测试各用各的 now），绝不回落到 Date.now()。
  const current = Number(now)
  if (!Number.isFinite(current) || current <= 0) return 0
  const wage = Number(record.wage)
  const contractMs = contractMsOf(record.startedAt, record.endsAt)
  if (contractMs <= 0) return 0
  const ackedAt = Number(record.ackedAt)
  const anchor = Number.isFinite(ackedAt) && ackedAt > 0 ? ackedAt : Number(record.startedAt)
  if (!Number.isFinite(anchor)) return 0
  const ended = Number(record.endedAt)
  const endAt = Number.isFinite(ended) && ended > 0 ? Math.min(ended, current) : current
  return earnedFor(wage, servedMsOf(anchor, endAt, contractMs), contractMs)
}

/**
 * 挂牌能不能被雇（ticket 44 D1 / SPEC v5「雇佣」）：只由「开没开」与
 * 「宠物在不在家」决定，不看行情新鲜度（那是接收端的门）。
 *
 * - `off`：主人没开挂牌；
 * - `visiting`：宠物正在串门/去串门的路上；
 * - `working`：宠物在外打工；
 * - `ready`：在家、空闲，可以被雇。
 *
 * `guard` 不在这个函数里：挂牌里的 `guard` 是**雇工贡献的 0.5**，
 * 不是 `farmGuard()` 合成后的 0.3/0.5/0.8。
 */
export function hireAvailability ({ enabled = false, visiting = false, working = false } = {}) {
  if (enabled !== true) return { available: false, reason: 'off' }
  if (visiting === true) return { available: false, reason: 'visiting' }
  if (working === true) return { available: false, reason: 'working' }
  return { available: true, reason: 'ready' }
}

export function isContractStatus (value) {
  return typeof value === 'string' && STATUS_SET.has(value)
}

export function isEndReason (value) {
  return typeof value === 'string' && END_REASON_SET.has(value)
}

export function isSettleReason (value) {
  return typeof value === 'string' && SETTLE_REASON_SET.has(value)
}

export function isWorkError (value) {
  return typeof value === 'string' && WORK_ERROR_SET.has(value)
}

export function isHireReason (value) {
  return typeof value === 'string' && HIRE_REASON_SET.has(value)
}
