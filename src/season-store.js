/**
 * 票 65：`<dataDir>/season.json`。
 *
 * 只存本地节日进度和（票 67 的）来客状态；季节本身由 `season-rules.js` 按本地日期算，
 * 不落盘，所以升级/换时区不会把存档里的"今天是第几季"弄错。写盘沿用农场的
 * tmp + rename、串行化和 30 秒节流；坏文件只告警重建，绝不影响 `farm.json`。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  SEASON_ORDER,
  calendarFor,
  eventFor,
  seasonAt
} from './season-rules.js'
import {
  freshOmen,
  normalizeOmen,
  omenView as buildOmenView,
  resolveOmen as resolveOmenRule
} from './season-omens.js'

export const SEASON_VERSION = 1
export const SEASON_FILE = 'season.json'
export const SAVE_THROTTLE_MS = 30 * 1000
export const MAX_EVENT_PROGRESS = 999

const EVENT_KINDS = Object.freeze(['plant', 'harvest', 'sell', 'water'])
const EMPTY_PROGRESS = Object.freeze({ plant: 0, harvest: 0, sell: 0, water: 0 })

let tempCounter = 0

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clampInt (value, min, max, fallback = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function cloneProgress (progress) {
  const out = {}
  for (const kind of EVENT_KINDS) out[kind] = progress?.[kind] ?? 0
  return out
}

/** 本地 00:00 的 `start` 是节日/来客的唯一身份；同一天只认同一个。 */
function freshEvent (season, now) {
  if (season === null) {
    return { start: 0, id: null, progress: cloneProgress(EMPTY_PROGRESS), claimed: false }
  }
  const meta = eventFor(season.id)
  if (meta === null) {
    return {
      start: season.start,
      id: null,
      progress: cloneProgress(EMPTY_PROGRESS),
      claimed: false
    }
  }
  return {
    start: season.start,
    id: meta.id,
    progress: cloneProgress(EMPTY_PROGRESS),
    claimed: false
  }
}

function freshState (now) {
  const season = seasonAt(now)
  return {
    version: SEASON_VERSION,
    event: freshEvent(season, now),
    omen: freshOmen(season)
  }
}

/**
 * 把读到的任意 JSON 收敛成当前这一天的状态。
 * 只要 `event.start` 不是今天、id 对不上、progress 坏了，就整块重建；
 * 不尝试修补半坏的数据——节日进度丢了也就丢了。
 */
export function normalizeSeasonFile (raw, now) {
  const season = seasonAt(now)
  if (season === null) return freshState(now)
  if (!isObject(raw) || raw.version !== SEASON_VERSION) return freshState(now)

  const expected = eventFor(season.id)
  const event = isObject(raw.event) ? raw.event : null
  const valid = expected !== null &&
    event !== null &&
    event.start === season.start &&
    event.id === expected.id &&
    isObject(event.progress)

  if (!valid) return freshState(now)

  const progress = {}
  for (const kind of EVENT_KINDS) {
    progress[kind] = clampInt(event.progress[kind], 0, MAX_EVENT_PROGRESS, 0)
  }

  return {
    version: SEASON_VERSION,
    event: {
      start: season.start,
      id: expected.id,
      progress,
      claimed: event.claimed === true
    },
    // 来客只属于秋天；非秋天或还没到秋天，清掉旧来客，避免明天又冒出来。
    omen: normalizeOmen(raw.omen, season)
  }
}

function eventView (state, season) {
  const meta = eventFor(season.id)
  if (meta === null) return null
  const progress = clampInt(state.event.progress[meta.requirement.kind], 0, MAX_EVENT_PROGRESS, 0)
  return {
    id: meta.id,
    name: meta.name,
    requirement: { kind: meta.requirement.kind, qty: meta.requirement.qty },
    progress,
    ready: progress >= meta.requirement.qty,
    claimed: state.event.claimed === true,
    reward: { coins: meta.reward.coins, dew: meta.reward.dew }
  }
}

class SeasonStore {
  #dir
  #file
  #now
  #log
  #state
  #queue = Promise.resolve()
  #savedAt = 0
  #saveTimer = null
  #disposed = false

  constructor (dir, { now = Date.now, log = null } = {}) {
    this.#dir = dir
    this.#file = join(dir, SEASON_FILE)
    this.#now = typeof now === 'function' ? now : () => Date.now()
    this.#log = log
    this.#state = freshState(this.#now())
  }

  async init () {
    await mkdir(this.#dir, { recursive: true })
    let raw = null
    try {
      raw = JSON.parse(await readFile(this.#file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#warn('season.json 读取失败，按空状态重建：' + (error?.message ?? error))
      }
    }
    this.#state = normalizeSeasonFile(raw, this.#now())
    this.#ensure(this.#now())
    await this.#persist(true)
    return this
  }

  /** 只读快照；测试和 service 的日志判断用。 */
  snapshot () {
    return {
      version: this.#state.version,
      event: {
        start: this.#state.event.start,
        id: this.#state.event.id,
        progress: cloneProgress(this.#state.event.progress),
        claimed: this.#state.event.claimed === true
      },
      omen: this.#state.omen === null ? null : { ...this.#state.omen }
    }
  }

  view (now = this.#now()) {
    this.#ensure(now)
    const season = seasonAt(now)
    if (season === null) return null
    return {
      ...season,
      calendar: calendarFor(season.id),
      event: eventView(this.#state, season),
      omen: this.#omenView(season)
    }
  }

  /** 计数只在动作成功后调用；返回最新节日视图，`ready` 已按新进度算好。 */
  async note (kind, qty = 1, now = this.#now()) {
    if (!EVENT_KINDS.includes(kind)) return null
    this.#ensure(now)
    const season = seasonAt(now)
    const meta = eventFor(season.id)
    if (meta === null || meta.requirement.kind !== kind) return eventView(this.#state, season)

    const current = this.#state.event.progress[kind] ?? 0
    this.#state.event.progress[kind] = clampInt(current + clampInt(qty, 0, MAX_EVENT_PROGRESS, 0), 0, MAX_EVENT_PROGRESS, 0)
    this.#dirty(now)
    return eventView(this.#state, season)
  }

  async claim (now = this.#now()) {
    this.#ensure(now)
    const season = seasonAt(now)
    const view = eventView(this.#state, season)
    if (view === null) return { ok: false, code: 'event-not-ready' }
    if (this.#state.event.claimed === true) return { ok: false, code: 'event-claimed' }
    if (view.ready !== true) return { ok: false, code: 'event-not-ready' }

    this.#state.event.claimed = true
    await this.#persist(true, now)
    return { ok: true, event: eventView(this.#state, season), reward: view.reward }
  }

  /**
   * 换日结算：重置节日，并报告上一季没处理的来客。
   * 返回 `{ changed, eventReset, unresolvedOmen }`，由 service 决定发什么日志/扣多少。
   */
  async settle (now = this.#now()) {
    const before = this.#state.event.start
    const beforeOmen = this.#state.omen
    this.#ensure(now)
    const changed = this.#state.event.start !== before
    const season = seasonAt(now)
    const unresolved = beforeOmen !== null &&
      beforeOmen.resolved !== true &&
      (season?.id !== 'autumn' || season.start !== beforeOmen.start)
      ? { ...beforeOmen }
      : null
    if (changed || unresolved !== null) await this.#persist(true, now)
    return { changed, eventReset: changed, unresolvedOmen: unresolved }
  }

  /**
   * 票 67：结算熊獾。调用方负责先扣投喂成本、后发奖励；
   * 这里只把 choice/result 落到 season.json，保证同一天只能处理一次。
   */
  async resolveOmen (choice, { guard = 0, random = Math.random, now = this.#now() } = {}) {
    this.#ensure(now)
    const omen = this.#state.omen
    if (omen === null) return { ok: false, code: 'omen-resolved' }
    if (omen.resolved === true) return { ok: false, code: 'omen-resolved' }

    const outcome = resolveOmenRule(choice, { guard, random })
    if (!outcome.ok) return outcome

    this.#state.omen = {
      ...omen,
      resolved: true,
      choice: outcome.choice,
      result: {
        success: outcome.success,
        loss: outcome.loss,
        reward: {
          coins: outcome.reward.coins,
          dew: outcome.reward.dew,
          seeds: { ...outcome.reward.seeds }
        }
      }
    }
    await this.#persist(true, now)
    return { ok: true, omen: this.#omenView(seasonAt(now)), outcome }
  }

  /** 票 67：熊獾卡片；service 再补 `canFeed`。 */
  #omenView (season) {
    if (season?.id !== 'autumn') return null
    return buildOmenView(this.#state.omen)
  }

  #ensure (now) {
    const season = seasonAt(now)
    if (season === null) return
    const expectedEvent = eventFor(season.id)
    const event = this.#state.event
    if (event.start !== season.start || event.id !== (expectedEvent?.id ?? null)) {
      this.#state.event = freshEvent(season, now)
    }
    if (season.id !== 'autumn') {
      this.#state.omen = null
    } else if (this.#state.omen === null || this.#state.omen.start !== season.start) {
      this.#state.omen = freshOmen(season)
    }
  }

  #warn (line) {
    this.#log?.warn?.(line)
  }

  #dirty (now) {
    if (now - this.#savedAt >= SAVE_THROTTLE_MS) {
      void this.#persist(false, now)
      return
    }
    if (this.#saveTimer === null) {
      const wait = Math.max(0, SAVE_THROTTLE_MS - (now - this.#savedAt))
      this.#saveTimer = setTimeout(() => {
        this.#saveTimer = null
        void this.#persist(false, this.#now())
      }, wait)
      this.#saveTimer.unref?.()
    }
  }

  async #persist (force, now = this.#now()) {
    if (this.#disposed) return false
    if (!force && now - this.#savedAt < SAVE_THROTTLE_MS) return false
    const run = async () => {
      const body = JSON.stringify(this.#state, null, 2) + '\n'
      const tmp = join(this.#dir, `.${SEASON_FILE}.tmp-${process.pid}-${tempCounter++}`)
      try {
        await writeFile(tmp, body, 'utf8')
        await rename(tmp, this.#file)
        this.#savedAt = now
        return true
      } catch (error) {
        this.#warn('season.json 写入失败：' + (error?.message ?? error))
        return false
      }
    }
    this.#queue = this.#queue.then(run, run)
    return this.#queue
  }

  async dispose () {
    this.#disposed = true
    if (this.#saveTimer !== null) {
      clearTimeout(this.#saveTimer)
      this.#saveTimer = null
    }
    await this.#queue.catch(() => {})
  }
}

export async function createSeasonStore (dir, options = {}) {
  const store = new SeasonStore(dir, options)
  return store.init()
}

export { SEASON_ORDER }
