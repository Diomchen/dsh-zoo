import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CROPS,
  CROP_IDS,
  FERTILIZE_COST,
  MAX_DEW,
  WATER_COST,
  advanceDew,
  advanceGrowth,
  fertilizePlot,
  harvestYield,
  isCropId,
  isMature,
  localDayKey,
  offlineElapsed,
  waterPlot
} from './farm-rules.js'
import { parseJsonText } from './json-text.js'

/**
 * 一只宠物的农场：`<dataDir>/farm.json`（可手改、可删；删了就是初始农场）。
 *
 * 形状（SPEC v5「存储」）：
 *   {
 *     "version": 1,
 *     "coins": 30,
 *     "seeds": { "tomato": 2 },
 *     "crops": {},
 *     "dew": 0,
 *     "dewAt": 1700000000000,
 *     "dewDay": "2026-11-06",
 *     "lastTickAt": 1700000000000,
 *     "plots": [
 *       { "id": "p1", "crop": "tomato", "plantedAt": 1700000000000,
 *         "grownMs": 0, "growMs": 1800000, "waterings": 0,
 *         "fertilized": false, "stolenBy": [], "helpedBy": [] }
 *     ],
 *     "hire": { "enabled": false, "wagePerHour": 10, "minHours": 2, "maxHours": 8 },
 *     "log": [ { "at": 1700000000000, "kind": "harvest", "crop": "tomato", "qty": 3 } ]
 *   }
 *
 * 三条产品规则决定这里的形状：
 *   - **离线也长，但一次最多补 12 小时**；成熟就停，不枯萎、不生病；
 *   - **露水只奖励「DSH 开着但没在玩」**：每 10 分钟 +1，每天余额上限 48；
 *     关掉 DSH 的时间不算，加载时把计时锚点重置到 now；
 *   - **任何一次成功的农场动作都会重置待机计时**（种/收/浇/施肥）。
 *
 * 容错与 `src/backpack.js` 同一套路：
 *   - 文件不存在：初始农场（4 空地、30 硬币、2 颗小番茄种子），不告警；
 *   - 文件损坏/形状不对：初始农场 + 只告警一次；
 *   - 单块地坏掉只修那块地，整份坏条目最多告警一次；
 *   - 写盘串行 + tmp/rename；写失败只告警一次（本次运行内存里照常）。
 *
 * 账本**绝不能**放进 `gifts/`（那里的配额清理会按最旧删目录）。
 */

export const FARM_FILE = 'farm.json'
export const FARM_VERSION = 1
/** 4 块地，id 固定 p1–p4（SPEC v5「农场与作物」）。 */
export const PLOT_IDS = Object.freeze(['p1', 'p2', 'p3', 'p4'])
export const START_COINS = 30
export const START_SEEDS = Object.freeze({ tomato: 2 })
/** 硬币/种子/作物的硬上限（SPEC v5「货币、仓库与限额」）。 */
export const MAX_COINS = 1_000_000
export const MAX_STACK = 999
/** 农场日志最多 50 条；状态出口只给最近 20 条。 */
export const MAX_FARM_LOG = 50
export const FARM_LOG_VIEW_LIMIT = 20
/** 写盘节流：tick 有变化也最多每 30 秒落一次；动作总是立即落盘。 */
export const SAVE_THROTTLE_MS = 30 * 1000

/** 挂牌默认值与合法区间；ticket 44 才改，这里先把文件形状固定下来。 */
export const DEFAULT_HIRE = Object.freeze({
  enabled: false,
  wagePerHour: 10,
  minHours: 2,
  maxHours: 8
})
export const MIN_WAGE = 1
export const MAX_WAGE = 100
export const MIN_HIRE_HOURS = 2
export const MAX_HIRE_HOURS = 8

/** 手改文件里的生长时长上限（只防一行 JSON 把时间推到几百年后）。 */
export const MAX_GROW_MS = 30 * 24 * 60 * 60 * 1000
/** 单块地的偷/帮名单上限；正常一轮只可能有一两个 deviceId。 */
export const MAX_PLOT_VISITORS = 50

const LOG_KINDS = new Set(['plant', 'harvest', 'steal', 'help', 'hire', 'settle'])
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 一块空地（数组每次新建，避免多块地共享同一个 stolenBy）。 */
export function emptyPlot (id) {
  return {
    id,
    crop: null,
    plantedAt: null,
    grownMs: 0,
    growMs: 0,
    waterings: 0,
    fertilized: false,
    stolenBy: [],
    helpedBy: []
  }
}

/** 初始农场：4 块空地、30 硬币、2 颗小番茄种子、0 露水。 */
export function initialFarmState () {
  return {
    version: FARM_VERSION,
    coins: START_COINS,
    seeds: { ...START_SEEDS },
    crops: {},
    dew: 0,
    // 这两个时间由 store 在加载时按 now 补；null 表示「文件里没有/坏了」。
    dewAt: null,
    dewDay: null,
    lastTickAt: null,
    plots: PLOT_IDS.map(emptyPlot),
    hire: { ...DEFAULT_HIRE },
    log: []
  }
}

/** 状态出口/窗口只读的那一份；`lastTickAt` 等内部计时不出去。 */
export function farmView (state) {
  return {
    plots: state.plots.map(copyPlot),
    coins: state.coins,
    seeds: { ...state.seeds },
    crops: { ...state.crops },
    dew: state.dew,
    hire: { ...state.hire },
    // 完整日志（≤50）；`/state` 只取最近 20，农场小窗的记录页要的是完整的一份。
    log: state.log.map(copyLogEntry)
  }
}

/** 启动早期（store 还没读出来）也要有完整形状，不能给 undefined。 */
export function initialFarmView () {
  return farmView(initialFarmState())
}

function copyPlot (plot) {
  return {
    ...plot,
    stolenBy: Array.isArray(plot.stolenBy) ? [...plot.stolenBy] : [],
    helpedBy: Array.isArray(plot.helpedBy) ? [...plot.helpedBy] : []
  }
}

function copyLogEntry (entry) {
  return { ...entry }
}

function errorName (error) {
  return error?.code || (error instanceof Error ? error.name : 'unknown')
}

// ---------------------------------------------------------------------------
// 归一化：读回来的白名单。坏的字段修、坏的地块跳过，绝不让脏值进内存。
// ---------------------------------------------------------------------------

function finiteNumber (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }
  return null
}

function positiveInt (value, max = Number.MAX_SAFE_INTEGER) {
  const num = finiteNumber(value)
  if (num === null) return null
  const int = Math.floor(num)
  if (int <= 0) return null
  return Math.min(int, max)
}

function nonNegativeInt (value, max = Number.MAX_SAFE_INTEGER) {
  const num = finiteNumber(value)
  if (num === null) return null
  return Math.min(max, Math.max(0, Math.floor(num)))
}

function normalizeTimestamp (value) {
  const num = finiteNumber(value)
  if (num === null || num <= 0) return null
  return Math.floor(num)
}

function normalizeDayKey (value) {
  return typeof value === 'string' && DAY_KEY_RE.test(value) ? value : null
}

function normalizeCoins (value) {
  if (value === undefined) return { coins: START_COINS, repaired: 0 }
  const num = finiteNumber(value)
  if (num === null) return { coins: START_COINS, repaired: 1 }
  return { coins: Math.min(MAX_COINS, Math.max(0, Math.floor(num))), repaired: 0 }
}

function normalizeDew (value) {
  if (value === undefined) return { dew: 0, repaired: 0 }
  const num = finiteNumber(value)
  if (num === null) return { dew: 0, repaired: 1 }
  return { dew: Math.min(MAX_DEW, Math.max(0, Math.floor(num))), repaired: 0 }
}

/**
 * 种子/作物仓库：只认三种作物、只留 1–999 的整数；未知作物与坏计数丢掉。
 * `fallback` 只在字段**缺失**（undefined）时使用；显式的 `{}` 仍然是空仓库。
 */
function normalizeStacks (value, fallback = null) {
  if (value === undefined) {
    return { stacks: fallback === null ? {} : { ...fallback }, repaired: 0 }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { stacks: fallback === null ? {} : { ...fallback }, repaired: 1 }
  }

  const stacks = {}
  let repaired = 0
  for (const id of CROP_IDS) {
    if (value[id] === undefined) continue
    const num = finiteNumber(value[id])
    if (num === null) {
      repaired += 1
      continue
    }
    const count = Math.min(MAX_STACK, Math.max(0, Math.floor(num)))
    if (count > 0) stacks[id] = count
  }
  for (const key of Object.keys(value)) {
    if (!isCropId(key)) repaired += 1
  }
  return { stacks, repaired }
}

function normalizeHire (value) {
  if (value === undefined) return { hire: { ...DEFAULT_HIRE }, repaired: 0 }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { hire: { ...DEFAULT_HIRE }, repaired: 1 }
  }

  let repaired = 0
  let enabled = DEFAULT_HIRE.enabled
  if (value.enabled !== undefined) {
    if (typeof value.enabled === 'boolean') enabled = value.enabled
    else repaired += 1
  }

  const wage = hireInt(value.wagePerHour, MIN_WAGE, MAX_WAGE, DEFAULT_HIRE.wagePerHour)
  const minHours = hireInt(value.minHours, MIN_HIRE_HOURS, MAX_HIRE_HOURS, DEFAULT_HIRE.minHours)
  const maxHours = hireInt(value.maxHours, MIN_HIRE_HOURS, MAX_HIRE_HOURS, DEFAULT_HIRE.maxHours)
  repaired += wage.repaired + minHours.repaired + maxHours.repaired

  return {
    hire: {
      enabled,
      wagePerHour: wage.value,
      minHours: minHours.value,
      // 手改成 min 8 / max 2 时不能让挂牌变成一个不可能成立的区间。
      maxHours: Math.max(minHours.value, maxHours.value)
    },
    repaired
  }
}

function hireInt (value, min, max, fallback) {
  if (value === undefined) return { value: fallback, repaired: 0 }
  const num = finiteNumber(value)
  if (num === null) return { value: fallback, repaired: 1 }
  return { value: Math.min(max, Math.max(min, Math.floor(num))), repaired: 0 }
}

function normalizeIdList (value) {
  if (value === undefined) return { ids: [], repaired: 0 }
  if (!Array.isArray(value)) return { ids: [], repaired: 1 }

  const ids = []
  let repaired = 0
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      repaired += 1
      continue
    }
    const id = candidate.trim()
    if (id === '' || id.length > 64) {
      repaired += 1
      continue
    }
    if (!ids.includes(id)) ids.push(id)
  }
  if (ids.length > MAX_PLOT_VISITORS) {
    repaired += ids.length - MAX_PLOT_VISITORS
    ids.length = MAX_PLOT_VISITORS
  }
  return { ids, repaired }
}

/** 单块地：作物/时间/浇水/施肥/偷帮名单各自夹取；坏作物整块回空地。 */
function normalizePlot (value) {
  const id = value.id
  if (value.crop === undefined || value.crop === null) {
    return { plot: emptyPlot(id), repaired: 0 }
  }
  if (!isCropId(value.crop)) {
    return { plot: emptyPlot(id), repaired: 1 }
  }

  const crop = CROPS[value.crop]
  let repaired = 0

  // growMs 在种下那一刻快照进地块：以后调平衡不会把已经在长的植株改成另一种时长。
  const growValue = positiveInt(value.growMs, MAX_GROW_MS)
  const growMs = growValue === null ? crop.growMs : growValue

  const grownValue = nonNegativeInt(value.grownMs, MAX_GROW_MS)
  if (grownValue === null) repaired += 1
  const grownMs = Math.min(grownValue ?? 0, growMs)

  const plantedAt = normalizeTimestamp(value.plantedAt)
  if (plantedAt === null) repaired += 1

  const rawWaterings = finiteNumber(value.waterings)
  let waterings = 0
  if (rawWaterings === null) {
    if (value.waterings !== undefined) repaired += 1
  } else {
    waterings = Math.min(1, Math.max(0, Math.floor(rawWaterings)))
    if (rawWaterings > 1) repaired += 1
  }

  let fertilized = false
  if (value.fertilized !== undefined) {
    if (typeof value.fertilized === 'boolean') fertilized = value.fertilized
    else repaired += 1
  }

  const stolen = normalizeIdList(value.stolenBy)
  const helped = normalizeIdList(value.helpedBy)
  repaired += stolen.repaired + helped.repaired

  return {
    plot: {
      id,
      crop: value.crop,
      plantedAt: plantedAt ?? 0,
      grownMs,
      growMs,
      waterings,
      fertilized,
      stolenBy: stolen.ids,
      helpedBy: helped.ids
    },
    repaired
  }
}

function normalizePlots (value) {
  if (value === undefined) return { plots: PLOT_IDS.map(emptyPlot), repaired: 0 }
  if (!Array.isArray(value)) return { plots: PLOT_IDS.map(emptyPlot), repaired: 1 }

  const byId = new Map(PLOT_IDS.map((id) => [id, emptyPlot(id)]))
  const seen = new Set()
  let repaired = 0
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      repaired += 1
      continue
    }
    if (!PLOT_IDS.includes(candidate.id) || seen.has(candidate.id)) {
      repaired += 1
      continue
    }
    seen.add(candidate.id)
    const normalized = normalizePlot(candidate)
    byId.set(candidate.id, normalized.plot)
    repaired += normalized.repaired
  }
  // 文件里少写了几块地不算损坏：补齐 p1–p4，顺序永远固定。
  return { plots: PLOT_IDS.map((id) => byId.get(id)), repaired }
}

function normalizeLogEntry (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const at = normalizeTimestamp(value.at)
  if (at === null) return null
  if (typeof value.kind !== 'string' || !LOG_KINDS.has(value.kind)) return null

  let crop = null
  if (value.crop !== undefined && value.crop !== null) {
    if (!isCropId(value.crop)) return null
    crop = value.crop
  }
  const rawQty = finiteNumber(value.qty)
  const qty = rawQty === null ? 0 : Math.min(MAX_STACK, Math.max(0, Math.floor(rawQty)))
  return { at, kind: value.kind, ...(crop === null ? {} : { crop }), qty }
}

function normalizeLog (value) {
  if (value === undefined) return { log: [], repaired: 0 }
  if (!Array.isArray(value)) return { log: [], repaired: 1 }

  const log = []
  let repaired = 0
  for (const candidate of value) {
    const entry = normalizeLogEntry(candidate)
    if (entry === null) {
      repaired += 1
      continue
    }
    log.push(entry)
  }
  log.sort((left, right) => right.at - left.at)
  if (log.length > MAX_FARM_LOG) {
    repaired += log.length - MAX_FARM_LOG
    log.length = MAX_FARM_LOG
  }
  return { log, repaired }
}

/**
 * 读整份 `farm.json`。返回 `{ farm, corrupt, repaired }`：
 *   - `corrupt` = 不是对象 / 版本不认识，调用方按初始农场处理并告警一次；
 *   - `repaired` = 单个字段/地块/日志条目被修补的数量，只用于告警一次；
 *   - 单块地坏掉只回空地，不拖垮其它三块。
 */
export function normalizeFarmFile (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { farm: initialFarmState(), corrupt: true, repaired: 0 }
  }
  if (value.version !== undefined && value.version !== FARM_VERSION) {
    return { farm: initialFarmState(), corrupt: true, repaired: 0 }
  }

  let repaired = 0
  const coins = normalizeCoins(value.coins)
  const seeds = normalizeStacks(value.seeds, START_SEEDS)
  const crops = normalizeStacks(value.crops, null)
  const dew = normalizeDew(value.dew)
  const plots = normalizePlots(value.plots)
  const hire = normalizeHire(value.hire)
  const log = normalizeLog(value.log)
  repaired += coins.repaired + seeds.repaired + crops.repaired +
    dew.repaired + plots.repaired + hire.repaired + log.repaired

  return {
    farm: {
      version: FARM_VERSION,
      coins: coins.coins,
      seeds: seeds.stacks,
      crops: crops.stacks,
      dew: dew.dew,
      dewAt: normalizeTimestamp(value.dewAt),
      dewDay: normalizeDayKey(value.dewDay),
      lastTickAt: normalizeTimestamp(value.lastTickAt),
      plots: plots.plots,
      hire: hire.hire,
      log: log.log
    },
    corrupt: false,
    repaired
  }
}

function normalizePlotId (value) {
  if (typeof value !== 'string') return null
  const id = value.trim().toLowerCase()
  return PLOT_IDS.includes(id) ? id : null
}

function normalizeCropId (value) {
  if (typeof value !== 'string') return null
  const id = value.trim().toLowerCase()
  return isCropId(id) ? id : null
}

function addStack (stacks, cropId, qty) {
  const before = stacks[cropId] ?? 0
  const after = Math.min(MAX_STACK, before + Math.max(0, Math.floor(Number(qty) || 0)))
  if (after > 0) stacks[cropId] = after
  return after
}

function toFileState (state) {
  return {
    version: FARM_VERSION,
    coins: state.coins,
    seeds: { ...state.seeds },
    crops: { ...state.crops },
    dew: state.dew,
    dewAt: state.dewAt,
    dewDay: state.dewDay,
    lastTickAt: state.lastTickAt,
    plots: state.plots.map(copyPlot),
    hire: { ...state.hire },
    log: state.log.map(copyLogEntry)
  }
}

/**
 * 打开（或创建）农场 store。读盘失败不抛：调用方拿到的是一份能玩的初始农场，
 * 只在日志里留一条警告。`now` 只为测试注入，生产不传就是 Date.now。
 */
export async function createFarmStore (dir, { log, now = Date.now } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('farm: missing data directory')
  const store = new FarmStore({ dir, log, now })
  await store.load()
  return store
}

class FarmStore {
  #dir
  #log
  #now
  #state = initialFarmState()
  #warned = new Set()
  /** 串行化写盘：同一毫秒里的两个动作不能互相写掉对方的地块/仓库。 */
  #chain = Promise.resolve()
  #lastWriteAt = Number.NEGATIVE_INFINITY

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
      text = await readFile(join(this.#dir, FARM_FILE), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#warnOnce('read', '农场读不出来，先按初始农场运行（' + errorName(error) + '）')
      }
      this.#state = initialFarmState()
      // 没有可信的 lastTickAt：不做离线补算，也不给离线露水。
      this.#settleLoad(this.#nowMs(), { offline: false })
      return
    }

    let raw
    try {
      raw = parseJsonText(text)
    } catch {
      this.#warnOnce('parse', '农场不是合法 JSON，先按初始农场运行')
      this.#state = initialFarmState()
      this.#settleLoad(this.#nowMs(), { offline: false })
      return
    }

    const normalized = normalizeFarmFile(raw)
    this.#state = normalized.farm
    if (normalized.corrupt) {
      this.#warnOnce('shape', '农场形状不对，先按初始农场运行')
    } else if (normalized.repaired > 0) {
      this.#warnOnce('entries', '农场里有 ' + normalized.repaired + ' 处格式不对，已按默认值修补')
    }

    const changed = this.#settleLoad(this.#nowMs(), { offline: !normalized.corrupt })
    // 补出来的离线生长/跨日重置要立刻落盘；坏文件不覆盖，等下一次动作/ tick 再写。
    if (changed && !normalized.corrupt) await this.#persist(true)
  }

  /**
   * 加载时的两件事：补 `min(now − lastTickAt, 12h)` 的生长（离线），
   * 以及把待机锚点重置到 now（关掉 DSH 的时间不算露水）。
   * 返回本次是否真的改动了要落盘的状态。
   */
  #settleLoad (now, { offline }) {
    let changed = false
    const last = this.#state.lastTickAt
    const elapsed = offline ? offlineElapsed(last, now) : 0
    if (elapsed > 0) {
      this.#state.plots = this.#state.plots.map((plot) => {
        const next = advanceGrowth(plot, elapsed)
        if (next !== plot) changed = true
        return next
      })
    }

    const day = localDayKey(now)
    if (this.#state.dewDay !== null && day !== null && this.#state.dewDay !== day) {
      // 跨日重置：不补前一天的零头，也不把前一天的余额带进今天。
      if (this.#state.dew !== 0) changed = true
      this.#state.dew = 0
      changed = true
    }
    this.#state.dewAt = now
    if (day !== null) this.#state.dewDay = day
    this.#state.lastTickAt = now
    return changed
  }

  /** 只读视图：调用方可以随便改返回值，改不到 store。 */
  snapshot () {
    return farmView(this.#state)
  }

  /** 60 秒一拍：推进生长与露水；有变化才落盘，最多每 30 秒一次。 */
  tick () {
    return this.#enqueue(() => this.#tick())
  }

  async #tick () {
    const changed = this.#advance(this.#nowMs())
    if (!changed) return false
    await this.#persist(false)
    return true
  }

  plant (plotId, cropId) {
    return this.#enqueue(() => this.#plant(plotId, cropId))
  }

  harvest (plotId) {
    return this.#enqueue(() => this.#harvest(plotId))
  }

  water (plotId) {
    return this.#enqueue(() => this.#water(plotId))
  }

  fertilize (plotId) {
    return this.#enqueue(() => this.#fertilize(plotId))
  }

  /**
   * 运行中的时间推进：生长按真实时间走（不设上限），露水按 10 分钟/点攒。
   * 所有 action 进来也先走一遍，这样「到点了但 tick 还没跑」也不会少长一秒。
   */
  #advance (now) {
    const state = this.#state
    let changed = false

    const base = Number.isFinite(state.lastTickAt) ? state.lastTickAt : now
    const elapsed = Math.max(0, now - base)
    if (elapsed > 0) {
      state.plots = state.plots.map((plot) => {
        const next = advanceGrowth(plot, elapsed)
        if (next !== plot) changed = true
        return next
      })
    }

    const dew = advanceDew({
      dew: state.dew,
      dewAt: state.dewAt,
      dewDay: state.dewDay
    }, now)
    if (dew.dew !== state.dew || dew.dewAt !== state.dewAt || dew.dewDay !== state.dewDay) {
      changed = true
    }
    state.dew = dew.dew
    state.dewAt = dew.dewAt
    state.dewDay = dew.dewDay

    if (state.lastTickAt !== now) changed = true
    state.lastTickAt = now
    return changed
  }

  #nowMs () {
    return this.#now()
  }

  #resetIdle (now) {
    this.#state.dewAt = now
    const day = localDayKey(now)
    if (day !== null) this.#state.dewDay = day
  }

  #appendLog (entry) {
    this.#state.log.unshift(entry)
    if (this.#state.log.length > MAX_FARM_LOG) this.#state.log.length = MAX_FARM_LOG
  }

  async #plant (rawPlotId, rawCropId) {
    const plotId = normalizePlotId(rawPlotId)
    if (plotId === null) return farmError('bad-plot')
    const cropId = normalizeCropId(rawCropId)
    if (cropId === null) return farmError('bad-crop')

    const now = this.#nowMs()
    this.#advance(now)

    const index = PLOT_IDS.indexOf(plotId)
    const plot = this.#state.plots[index]
    if (plot === undefined || plot.crop !== null) return farmError('plot-occupied')

    const seeds = this.#state.seeds[cropId] ?? 0
    if (seeds <= 0) return farmError('no-seed')

    if (seeds <= 1) delete this.#state.seeds[cropId]
    else this.#state.seeds[cropId] = seeds - 1

    const planted = {
      id: plotId,
      crop: cropId,
      plantedAt: now,
      grownMs: 0,
      growMs: CROPS[cropId].growMs,
      waterings: 0,
      fertilized: false,
      stolenBy: [],
      helpedBy: []
    }
    this.#state.plots[index] = planted
    this.#appendLog({ at: now, kind: 'plant', crop: cropId, qty: 1 })
    this.#resetIdle(now)

    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'plant',
      plotId,
      crop: cropId,
      plot: copyPlot(planted),
      coins: this.#state.coins,
      seeds: { ...this.#state.seeds },
      crops: { ...this.#state.crops },
      dew: this.#state.dew,
      persisted
    }
  }

  async #harvest (rawPlotId) {
    const plotId = normalizePlotId(rawPlotId)
    if (plotId === null) return farmError('bad-plot')

    const now = this.#nowMs()
    this.#advance(now)

    const index = PLOT_IDS.indexOf(plotId)
    const plot = this.#state.plots[index]
    if (plot === undefined || !isCropId(plot.crop) || !isMature(plot)) {
      return farmError('not-mature')
    }

    const cropId = plot.crop
    const qty = harvestYield(plot)
    addStack(this.#state.crops, cropId, qty)
    this.#state.plots[index] = emptyPlot(plotId)
    this.#appendLog({ at: now, kind: 'harvest', crop: cropId, qty })
    this.#resetIdle(now)

    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'harvest',
      plotId,
      crop: cropId,
      qty,
      plot: emptyPlot(plotId),
      coins: this.#state.coins,
      seeds: { ...this.#state.seeds },
      crops: { ...this.#state.crops },
      dew: this.#state.dew,
      persisted
    }
  }

  async #water (rawPlotId) {
    const plotId = normalizePlotId(rawPlotId)
    if (plotId === null) return farmError('bad-plot')

    const now = this.#nowMs()
    this.#advance(now)

    const index = PLOT_IDS.indexOf(plotId)
    const plot = this.#state.plots[index]
    // 空地/成熟地没有可浇的生长；不把露水浪费在一个不会发生的变化上。
    if (plot === undefined || !isCropId(plot.crop) || isMature(plot)) return farmError('bad-plot')
    if (Number(plot.waterings) >= 1) return farmError('already-watered')
    if (this.#state.dew < WATER_COST) return farmError('no-dew')

    const watered = waterPlot(plot)
    if (watered === null) return farmError('bad-plot')
    this.#state.plots[index] = watered
    this.#state.dew -= WATER_COST
    this.#resetIdle(now)

    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'water',
      plotId,
      plot: copyPlot(watered),
      coins: this.#state.coins,
      seeds: { ...this.#state.seeds },
      crops: { ...this.#state.crops },
      dew: this.#state.dew,
      persisted
    }
  }

  async #fertilize (rawPlotId) {
    const plotId = normalizePlotId(rawPlotId)
    if (plotId === null) return farmError('bad-plot')

    const now = this.#nowMs()
    this.#advance(now)

    const index = PLOT_IDS.indexOf(plotId)
    const plot = this.#state.plots[index]
    if (plot === undefined || !isCropId(plot.crop)) return farmError('bad-plot')
    if (plot.fertilized === true) return farmError('already-fertilized')
    if (this.#state.dew < FERTILIZE_COST) return farmError('no-dew')

    const fertilized = fertilizePlot(plot)
    if (fertilized === null) return farmError('bad-plot')
    this.#state.plots[index] = fertilized
    this.#state.dew -= FERTILIZE_COST
    this.#resetIdle(now)

    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'fertilize',
      plotId,
      plot: copyPlot(fertilized),
      coins: this.#state.coins,
      seeds: { ...this.#state.seeds },
      crops: { ...this.#state.crops },
      dew: this.#state.dew,
      persisted
    }
  }

  #enqueue (task) {
    const run = this.#chain.then(task, task)
    this.#chain = run.then(() => {}, () => {})
    return run
  }

  /** 动作总是立即落盘；tick 走 30 秒节流，避免每拍都写一遍 JSON。 */
  #persist (force) {
    if (!force) {
      const now = this.#nowMs()
      if (now - this.#lastWriteAt < SAVE_THROTTLE_MS) return Promise.resolve(false)
      this.#lastWriteAt = now
    } else {
      this.#lastWriteAt = this.#nowMs()
    }
    return this.#write()
  }

  async #write () {
    const target = join(this.#dir, FARM_FILE)
    const tmp = target + '.tmp-' + randomUUID()
    try {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 })
      const body = JSON.stringify(toFileState(this.#state), null, 2) + '\n'
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
      // 同目录 rename 是原子的：不会留下半个农场，也不会读到写了一半的 JSON。
      await rename(tmp, target)
      return true
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      this.#warnOnce('write', '农场写不进去：本次运行仍然能用，但重启后可能丢（' + errorName(error) + '）')
      return false
    }
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

function farmError (error) {
  return { ok: false, error, persisted: false }
}
