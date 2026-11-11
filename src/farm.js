import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CROPS,
  CROP_IDS,
  FERTILIZE_COST,
  MAX_DEW,
  MAX_PLOTS,
  PLOT_UNLOCK_RESERVE,
  START_PLOTS,
  WATER_COST,
  advanceDew,
  advanceGrowth,
  clampPlotCount,
  fertilizePlot,
  harvestYield,
  helpPlot,
  isCropId,
  isMature,
  localDayKey,
  offlineElapsed,
  plotUnlockCost,
  visitLimitsFor,
  waterPlot
} from './farm-rules.js'
import {
  MAX_CONTRACT_HOURS,
  MAX_CONTRACT_WAGE,
  MIN_CONTRACT_HOURS,
  MIN_CONTRACT_WAGE
} from './contracts-rules.js'
import { farmErrorText } from './farm-text.js'
import { normalizeTradeQty } from './market.js'
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
 *     "dewEarned": 0,
 *     "dewAt": 1700000000000,
 *     "dewDay": "2026-11-06",
 *     "dewDayEarned": "2026-11-06",
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
 *   - **露水只奖励「DSH 开着但没在玩」**：每 10 分钟 +1，每天最多挣 48
 *     （余额也封顶 48）；关掉 DSH 的时间不算，加载时把计时锚点重置到 now；
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
/** 地块 id 固定 p1–p50；前 4 块开局可用，其余按顺序解锁（ticket 48）。 */
export const PLOT_IDS = Object.freeze(
  Array.from({ length: MAX_PLOTS }, (_, index) => 'p' + (index + 1))
)
export const START_COINS = 30
export const START_SEEDS = Object.freeze({ tomato: 2 })
/** 硬币/种子/作物的硬上限（SPEC v5「货币、仓库与限额」）。 */
export const MAX_COINS = 1_000_000
export const MAX_STACK = 999
/** 农场日志文件最多 200 条；窗口取 100，`/state` 只给最近 20 条。 */
export const MAX_FARM_LOG = 200
export const FARM_LOG_VIEW_LIMIT = 20
export const FARM_LOG_WINDOW_LIMIT = 100
/** 写盘节流：tick 有变化也最多每 30 秒落一次；动作总是立即落盘。 */
export const SAVE_THROTTLE_MS = 30 * 1000

/** 挂牌默认值与合法区间；ticket 44 才改，这里先把文件形状固定下来。 */
export const DEFAULT_HIRE = Object.freeze({
  enabled: false,
  wagePerHour: 10,
  minHours: 2,
  maxHours: 8
})
// 挂牌/雇佣的边界只有一份真相（contracts-rules.js）：这里保留旧名字给农场内部与测试用。
export const MIN_WAGE = MIN_CONTRACT_WAGE
export const MAX_WAGE = MAX_CONTRACT_WAGE
export const MIN_HIRE_HOURS = MIN_CONTRACT_HOURS
export const MAX_HIRE_HOURS = MAX_CONTRACT_HOURS

/** 手改文件里的生长时长上限（只防一行 JSON 把时间推到几百年后）。 */
export const MAX_GROW_MS = 30 * 24 * 60 * 60 * 1000
/** 单块地的偷/帮名单上限；正常一轮只可能有一两个 deviceId。 */
export const MAX_PLOT_VISITORS = 50
/**
 * 访客每日限额（SPEC v5「偷菜与帮忙」，ticket 43；ticket 48 随地块放大）。
 *
 * 主人侧能算的只有「这位访客在我家」和「我家今天一共」；「这位访客在所有农场」
 * 只有访客自己知道，所以 `mine` 是访客本机账本，`byVisitor`/`total` 是主人侧账本。
 * 两本账永远不可能强一致（ADR-0016 明确接受），这里只防误操作与刷屏。
 * 具体数字见 `farm-rules.js` 的 `visitLimitsFor()`：只有一份真相。
 */
/** 每日访客计数最多记多少位访客；超出的按最旧丢（内存/文件都有界）。 */
export const MAX_VISIT_STATS_VISITORS = 64

const LOG_KINDS = new Set(['plant', 'harvest', 'steal', 'help', 'hire', 'settle', 'unlock'])
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/
const WHO_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

/** 每天一份访客计数；跨本地日整份换新（不把昨天的次数带进今天）。 */
function emptyVisitStats (day = null) {
  return {
    day,
    steal: { total: 0, byVisitor: {} },
    help: { total: 0, byVisitor: {} },
    // 访客本机账本：今天「我」在别人家偷/帮了几次（跨农场，只有自己算得清）。
    mine: { steal: 0, help: 0 }
  }
}

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
    // 今天已经挣到的露水：花掉余额不会让这个数变小，第二天才归零。
    dewEarned: 0,
    // 这三个时间由 store 在加载时按 now 补；null 表示「文件里没有/坏了」。
    dewAt: null,
    dewDay: null,
    dewDayEarned: null,
    lastTickAt: null,
    // ticket 48：前 4 块免费，其余按顺序解锁；内部始终存 p1–p50 的完整数组。
    unlocked: START_PLOTS,
    plots: PLOT_IDS.map(emptyPlot),
    hire: { ...DEFAULT_HIRE },
    visitStats: emptyVisitStats(),
    log: []
  }
}

/** 状态出口/窗口只读的那一份；`lastTickAt` 等内部计时不出去。 */
export function farmView (state) {
  const unlocked = clampPlotCount(state.unlocked)
  return {
    // 只把已解锁的地块发出去；锁着的地块连 id 都不出现在视图里。
    plots: state.plots.slice(0, unlocked).map(copyPlot),
    unlocked,
    maxPlots: MAX_PLOTS,
    nextCost: plotUnlockCost(unlocked),
    coins: state.coins,
    seeds: { ...state.seeds },
    crops: { ...state.crops },
    dew: state.dew,
    dewEarned: state.dewEarned,
    hire: { ...state.hire },
    // 完整日志（≤200）；`/state` 只取最近 20，农场小窗的记录页要的是完整的一份。
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

function copyVisitStats (stats) {
  const copy = emptyVisitStats(stats?.day ?? null)
  for (const kind of ['steal', 'help']) {
    const source = stats?.[kind] ?? {}
    copy[kind].total = Number(source.total) || 0
    for (const [deviceId, count] of Object.entries(source.byVisitor ?? {})) {
      copy[kind].byVisitor[deviceId] = count
    }
  }
  copy.mine.steal = Number(stats?.mine?.steal) || 0
  copy.mine.help = Number(stats?.mine?.help) || 0
  return copy
}

/**
 * 日志里的「谁」：昵称来自网络，只留可显示的字，最多 32 码点。
 * 与 protocol 的 `normalizeNickname` 同一口径，但 farm.js 不 import 协议层（避免反向依赖）。
 */
function sanitizeWho (value) {
  if (typeof value !== 'string') return null
  const clean = value
    .replace(WHO_CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean === '') return null
  const chars = Array.from(clean)
  return chars.length > 32 ? chars.slice(0, 32).join('') : clean
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

function normalizeDewEarned (value) {
  if (value === undefined) return { dewEarned: 0, repaired: 0 }
  const num = finiteNumber(value)
  if (num === null) return { dewEarned: 0, repaired: 1 }
  return { dewEarned: Math.min(MAX_DEW, Math.max(0, Math.floor(num))), repaired: 0 }
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

/** 挂牌动作的严格版：必须落在区间里，不夹取；坏值返回 null。 */
function strictHireInt (value, min, max) {
  const num = finiteNumber(value)
  if (num === null || !Number.isInteger(num) || num < min || num > max) return null
  return num
}

/**
 * 每日访客计数（ticket 43）。旧文件没有这一项不算损坏：按空账本补；
 * 坏 deviceId 键/坏计数只丢自己，绝不让脏值进内存。
 */
function normalizeVisitStats (value) {
  if (value === undefined) return { stats: emptyVisitStats(), repaired: 0 }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { stats: emptyVisitStats(), repaired: 1 }
  }

  const stats = emptyVisitStats(normalizeDayKey(value.day))
  let repaired = 0
  for (const kind of ['steal', 'help']) {
    const source = value[kind]
    if (source === undefined) continue
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      repaired += 1
      continue
    }
    const total = nonNegativeInt(source.total, 999)
    if (source.total !== undefined && total === null) repaired += 1
    stats[kind].total = total ?? 0
    const byVisitor = source.byVisitor
    if (byVisitor === undefined) continue
    if (byVisitor === null || typeof byVisitor !== 'object' || Array.isArray(byVisitor)) {
      repaired += 1
      continue
    }
    for (const [rawId, rawCount] of Object.entries(byVisitor)) {
      const deviceId = typeof rawId === 'string' ? rawId.trim() : ''
      const count = nonNegativeInt(rawCount, 999)
      if (deviceId === '' || deviceId.length > 64 || count === null || count <= 0) {
        repaired += 1
        continue
      }
      if (Object.keys(stats[kind].byVisitor).length >= MAX_VISIT_STATS_VISITORS) {
        repaired += 1
        continue
      }
      stats[kind].byVisitor[deviceId] = count
    }
  }
  const mine = value.mine
  if (mine !== undefined) {
    if (mine === null || typeof mine !== 'object' || Array.isArray(mine)) {
      repaired += 1
    } else {
      for (const kind of ['steal', 'help']) {
        const count = nonNegativeInt(mine[kind], 999)
        if (mine[kind] !== undefined && count === null) repaired += 1
        stats.mine[kind] = count ?? 0
      }
    }
  }
  return { stats, repaired }
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
  const who = sanitizeWho(value.who)
  // ticket 44/45：hire/settle 日志带 hours/wage/earned；只保留能被显示的数字。
  const hours = finiteNumber(value.hours)
  const wage = finiteNumber(value.wage)
  const earned = finiteNumber(value.earned)
  // ticket 48：unlock 日志带 plot（第 n 块地）与 cost（花了多少硬币）；只保留能显示的数字。
  const cost = finiteNumber(value.cost)
  const plot = finiteNumber(value.plot)
  return {
    at,
    kind: value.kind,
    ...(crop === null ? {} : { crop }),
    qty,
    ...(who === null ? {} : { who }),
    ...(hours === null ? {} : { hours: Math.min(MAX_HIRE_HOURS, Math.max(0, Math.floor(hours))) }),
    ...(wage === null ? {} : { wage: Math.min(MAX_COINS, Math.max(0, Math.floor(wage))) }),
    ...(earned === null ? {} : { earned: Math.min(MAX_COINS, Math.max(0, Math.floor(earned))) }),
    ...(cost === null ? {} : { cost: Math.min(MAX_COINS, Math.max(0, Math.floor(cost))) }),
    ...(plot === null ? {} : { plot: Math.min(MAX_PLOTS, Math.max(1, Math.floor(plot))) })
  }
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
  const dewEarned = normalizeDewEarned(value.dewEarned)
  const plots = normalizePlots(value.plots)
  const unlocked = normalizeUnlocked(value.unlocked)
  const hire = normalizeHire(value.hire)
  const visitStats = normalizeVisitStats(value.visitStats)
  const log = normalizeLog(value.log)
  repaired += coins.repaired + seeds.repaired + crops.repaired +
    dew.repaired + dewEarned.repaired + plots.repaired + unlocked.repaired + hire.repaired +
    visitStats.repaired + log.repaired

  const dewDay = normalizeDayKey(value.dewDay)
  const dewDayEarned = normalizeDayKey(value.dewDayEarned) ?? dewDay
  return {
    farm: {
      version: FARM_VERSION,
      coins: coins.coins,
      seeds: seeds.stacks,
      crops: crops.stacks,
      dew: dew.dew,
      // 余额一定计进「今天已挣」：旧文件/手改文件不能靠删除计数多出额度。
      dewEarned: Math.max(dewEarned.dewEarned, dew.dew),
      dewAt: normalizeTimestamp(value.dewAt),
      dewDay,
      dewDayEarned,
      lastTickAt: normalizeTimestamp(value.lastTickAt),
      unlocked: unlocked.unlocked,
      plots: plots.plots,
      hire: hire.hire,
      visitStats: visitStats.stats,
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

/** `unlocked` 缺失按起始 4 块；越界/非整数修补回起点（只算一处坏值）。 */
function normalizeUnlocked (value) {
  if (value === undefined) return { unlocked: START_PLOTS, repaired: 0 }
  const count = Number(value)
  if (!Number.isInteger(count) || count < START_PLOTS || count > MAX_PLOTS) {
    return { unlocked: START_PLOTS, repaired: 1 }
  }
  return { unlocked: count, repaired: 0 }
}

/** 访客 deviceId 只用于名单/计数：短标识符即可，形状校验由协议层负责。 */
function normalizeDeviceId (value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (id === '' || id.length > 64) return null
  return id
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
    dewEarned: state.dewEarned,
    dewAt: state.dewAt,
    dewDay: state.dewDay,
    dewDayEarned: state.dewDayEarned,
    lastTickAt: state.lastTickAt,
    unlocked: clampPlotCount(state.unlocked),
    plots: state.plots.map(copyPlot),
    hire: { ...state.hire },
    visitStats: copyVisitStats(state.visitStats),
    log: state.log.map(copyLogEntry)
  }
}

/**
 * 打开（或创建）农场 store。读盘失败不抛：调用方拿到的是一份能玩的初始农场，
 * 只在日志里留一条警告。`now` 只为测试注入，生产不传就是 Date.now。
 *
 * `market`（ticket 41）是 `src/market.js` 的交易所 store；给了它才能买卖。
 * 交易会同时改两本账（硬币/种子/作物 + 价格/历史），所以放在农场自己的串行队列里，
 * 让一笔买卖的库存变化与价格变化在同一段里完成。
 */
export async function createFarmStore (dir, { log, now = Date.now, market = null } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('farm: missing data directory')
  const store = new FarmStore({ dir, log, now, market })
  await store.load()
  return store
}

class FarmStore {
  #dir
  #log
  #now
  #market
  #state = initialFarmState()
  #warned = new Set()
  /** 串行化写盘：同一毫秒里的两个动作不能互相写掉对方的地块/仓库。 */
  #chain = Promise.resolve()
  #lastWriteAt = Number.NEGATIVE_INFINITY

  constructor ({ dir, log, now, market }) {
    this.#dir = dir
    this.#log = log
    this.#market = market
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
    const dayReset = day !== null && (
      (this.#state.dewDay !== null && this.#state.dewDay !== day) ||
      (this.#state.dewDayEarned !== null && this.#state.dewDayEarned !== day)
    )
    // 跨日重置/「余额算进今天已挣」只有一份实现（advanceDew）；把锚点先放到 now，
    // 关掉 DSH 的时长不算待机，也不会补前一天剩下的零头。
    const dew = advanceDew({
      dew: this.#state.dew,
      dewEarned: this.#state.dewEarned,
      dewAt: now,
      dewDay: this.#state.dewDay,
      dewDayEarned: this.#state.dewDayEarned
    }, now)
    this.#state.dew = dew.dew
    this.#state.dewEarned = dew.dewEarned
    this.#state.dewAt = dew.dewAt
    if (dew.dewDay !== null) this.#state.dewDay = dew.dewDay
    if (dew.dewDayEarned !== null) this.#state.dewDayEarned = dew.dewDayEarned
    // 升级旧文件时不因为「余额补进已挣」白写一次 farm.json；只有跨日重置要立刻落盘。
    if (dayReset) changed = true
    // 访客日限额同样按本地日重置：昨天用掉的次数不能带到今天。
    // 这是派生字段：**不**因为加载就立刻落盘（升级旧文件不该白写一次 farm.json）；
    // 下一次动作/tick 自然会把新的一天写入。
    if (day !== null && this.#state.visitStats.day !== day) {
      this.#state.visitStats = emptyVisitStats(day)
    }
    this.#state.lastTickAt = now
    return changed
  }

  /**
   * 只读视图：调用方可以随便改返回值，改不到 store。
   *
   * 先把生长/露水推进到 now 再取视图：`farm-open`/`/state` 不能拿上一次 60 秒 tick
   * 的旧 `remainingMs`，否则窗口会先显示偏长的倒计时，下一次动作再跳回去。
   */
  snapshot () {
    this.#advance(this.#nowMs())
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

  /** 从交易所买种子：扣硬币、加种子；价格是作物表里的固定种子价（ticket 41）。 */
  buySeed (cropId, qty) {
    return this.#enqueue(() => this.#trade('buy-seed', cropId, qty))
  }

  /** 把作物卖给交易所：按本机 bid 成交、加硬币；成交后价格按数量冲击下跌。 */
  sellCrop (cropId, qty) {
    return this.#enqueue(() => this.#trade('sell-crop', cropId, qty))
  }

  /**
   * 解锁下一块地（ticket 48）：扣硬币、`unlocked+1`、写 `unlock` 日志。
   * `expectedUnlocked` 是乐观锁：窗口带着自己看到的数字来，宿主发现已经变了就回
   * `stale`，连点不会一次买两块。
   */
  unlockPlot (expectedUnlocked) {
    return this.#enqueue(() => this.#unlockPlot(expectedUnlocked))
  }

  // -------------------------------------------------------------------------
  // 访客相关的仓库动作（ticket 43）：偷到的作物、帮忙的硬币、先扣后退的露水。
  // 全部走同一条串行队列，绝不绕开 #persist。
  // -------------------------------------------------------------------------

  /** 访客仓库 +n 作物（偷菜成功）；上限 999。 */
  addCrop (cropId, qty = 1) {
    return this.#enqueue(() => this.#addCrop(cropId, qty))
  }

  /** 访客硬币 +n（帮忙成功）；上限 1,000,000。 */
  addCoins (qty = 1) {
    return this.#enqueue(() => this.#addCoins(qty))
  }

  /** 合同结算的扣款/退款也走这一条（ticket 44）：铸币只发生在本地。 */
  spendCoins (qty = 1) {
    return this.#enqueue(() => this.#spendCoins(qty))
  }

  /**
   * 改挂牌（ticket 44）：显式拒绝坏值，绝不静默夹取——窗口填了 0 时薪却看到
   * 「已保存」，用户会以为下一位邻居只花 0 硬币。
   */
  setHire (raw) {
    return this.#enqueue(() => this.#setHire(raw))
  }

  /**
   * 任何一次农场动作都重置待机计时（SPEC v5「待机、露水」）。
   * 工坊动作里只有种/收/浇/施肥/买卖会走各自的 `#resetIdle`；雇佣由 service 显式调这里，
   * 语义上「主人在玩」就重置，不是「露水又攒了一滴」。
   */
  touch () {
    return this.#enqueue(() => this.#touch())
  }

  /** 雇工日志（ticket 45 记录页）：谁、多久、多少工资；只显示，不动钱。 */
  noteHire (raw) {
    return this.#enqueue(() => this.#noteHire(raw))
  }

  /** 结算日志（ticket 45 记录页）：谁、工资里拿到多少；只显示，不动钱。 */
  noteSettle (raw) {
    return this.#enqueue(() => this.#noteSettle(raw))
  }

  /** 帮人之前先扣 1 露水；不够就明确 no-dew（不进入发送）。 */
  spendDew (qty = 1) {
    return this.#enqueue(() => this.#spendDew(qty))
  }

  /** 帮忙失败/超时退回露水；余额封顶 48。 */
  refundDew (qty = 1) {
    return this.#enqueue(() => this.#refundDew(qty))
  }

  /**
   * 主人侧的「偷」落账：校验成熟/未偷过/日限额 → 标记 stolenBy → 写日志。
   * `caught:true` 时只写一条「被抓住」的日志（qty 0），不改地块；但**照样消耗**
   * 访客/农场当天的次数——被抓不能变成「换一个 requestId 重试到成功」。
   * 守卫判定在 service（随机源可注入），这里只负责落账。
   */
  markStolen (plotId, deviceId, options = {}) {
    return this.#enqueue(() => this.#markStolen(plotId, deviceId, options))
  }

  /** 主人侧的「帮」落账：校验生长中/未帮过/日限额 → +10% 生长 → 写日志。 */
  markHelped (plotId, deviceId, options = {}) {
    return this.#enqueue(() => this.#markHelped(plotId, deviceId, options))
  }

  /** 给访客视图用的当日计数（只读；跨日按零算，不改内存）。 */
  visitLimits (deviceId) {
    return this.#visitLimits(deviceId)
  }

  /** 访客本机今天已经偷/帮了几次（跨所有农场）。 */
  visitActionUsed (kind) {
    return this.#visitActionUsed(kind)
  }

  /** 访客本机今天还能偷/帮几次（按自己农场的大小放大；ticket 48）。 */
  visitDailyLimit (kind) {
    const limits = visitLimitsFor(this.#state.unlocked)
    return kind === 'help' ? limits.help.perVisitorDay : limits.steal.perVisitorDay
  }

  /** 访客本机成功一次偷/帮：先查上限，再计数（跨农场 10/5）。 */
  noteVisitAction (kind) {
    return this.#enqueue(() => this.#noteVisitAction(kind))
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
      dewEarned: state.dewEarned,
      dewAt: state.dewAt,
      dewDay: state.dewDay,
      dewDayEarned: state.dewDayEarned
    }, now)
    if (dew.dew !== state.dew || dew.dewEarned !== state.dewEarned ||
      dew.dewAt !== state.dewAt || dew.dewDay !== state.dewDay ||
      dew.dewDayEarned !== state.dewDayEarned) {
      changed = true
    }
    state.dew = dew.dew
    state.dewEarned = dew.dewEarned
    state.dewAt = dew.dewAt
    state.dewDay = dew.dewDay
    state.dewDayEarned = dew.dewDayEarned

    // 访客日限额：跨日整份换新，不把昨天的次数带进今天。
    const day = localDayKey(now)
    if (day !== null && state.visitStats.day !== day) {
      state.visitStats = emptyVisitStats(day)
      changed = true
    }

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
    if (day !== null) {
      this.#state.dewDay = day
      this.#state.dewDayEarned = day
    }
  }

  #appendLog (entry) {
    this.#state.log.unshift(entry)
    if (this.#state.log.length > MAX_FARM_LOG) this.#state.log.length = MAX_FARM_LOG
  }

  /** 已解锁地块的下标；未知或锁着的地块统一 -1（种/收/浇/施肥/偷/帮共用）。 */
  #plotIndex (plotId) {
    const index = PLOT_IDS.indexOf(plotId)
    return index >= 0 && index < this.#state.unlocked ? index : -1
  }

  async #plant (rawPlotId, rawCropId) {
    const plotId = normalizePlotId(rawPlotId)
    if (plotId === null) return farmError('bad-plot')
    const cropId = normalizeCropId(rawCropId)
    if (cropId === null) return farmError('bad-crop')

    const now = this.#nowMs()
    this.#advance(now)

    const index = this.#plotIndex(plotId)
    if (index < 0) return farmError('bad-plot')
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
      dewEarned: this.#state.dewEarned,
      persisted
    }
  }

  async #harvest (rawPlotId) {
    const plotId = normalizePlotId(rawPlotId)
    if (plotId === null) return farmError('bad-plot')

    const now = this.#nowMs()
    this.#advance(now)

    const index = this.#plotIndex(plotId)
    if (index < 0) return farmError('bad-plot')
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
      dewEarned: this.#state.dewEarned,
      persisted
    }
  }

  async #water (rawPlotId) {
    const plotId = normalizePlotId(rawPlotId)
    if (plotId === null) return farmError('bad-plot')

    const now = this.#nowMs()
    this.#advance(now)

    const index = this.#plotIndex(plotId)
    if (index < 0) return farmError('bad-plot')
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
      dewEarned: this.#state.dewEarned,
      persisted
    }
  }

  async #fertilize (rawPlotId) {
    const plotId = normalizePlotId(rawPlotId)
    if (plotId === null) return farmError('bad-plot')

    const now = this.#nowMs()
    this.#advance(now)

    const index = this.#plotIndex(plotId)
    if (index < 0) return farmError('bad-plot')
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
      dewEarned: this.#state.dewEarned,
      persisted
    }
  }

  /**
   * 买卖的唯一入口（ticket 41）。同步段里完成「交易所记账 + 农场仓库变化」：
   *   1. 先 `#advance`（到点了的生长/露水不能因为买卖被跳过）；
   *   2. 检查作物、数量、库存与上限；失败不消耗交易所的每分钟限额；
   *   3. 调交易所同步记账（价格/历史/限速），紧接着改硬币/种子/作物；
   *   4. 两本账各自串行落盘；农场写盘完成后再返回。
   */
  async #trade (kind, rawCropId, rawQty) {
    const cropId = normalizeCropId(rawCropId)
    if (cropId === null) return farmError('bad-crop')
    const qty = normalizeTradeQty(rawQty)
    if (qty === null) return farmError('bad-qty', '数量要在 1–99 之间。')

    const now = this.#nowMs()
    this.#advance(now)

    if (this.#market === null || typeof this.#market.applyTrade !== 'function') {
      return farmError('market-busy', '交易所还没准备好，稍等一下再试。')
    }

    const crop = CROPS[cropId]
    if (kind === 'buy-seed') {
      const total = crop.seedPrice * qty
      if (this.#state.coins < total) return farmError('no-coin')
      const held = this.#state.seeds[cropId] ?? 0
      if (held + qty > MAX_STACK) return farmError('cap')
    } else {
      const held = this.#state.crops[cropId] ?? 0
      // 卖作物和买种子是两个语境：卖的时候仓库没有作物是 no-crop，不借用 no-seed。
      if (held < qty) return farmError('no-crop', '没有这种作物了，先种一点再来卖。')
    }

    let trade
    try {
      trade = this.#market.applyTrade({
        side: kind === 'buy-seed' ? 'buy' : 'sell',
        cropId,
        qty,
        now,
        // ticket 48：卖价冲击的分母随农场规模放大；4 块时仍是 20，行为不变。
        depth: 5 * this.#state.unlocked
      })
    } catch {
      return farmError('market-busy')
    }
    if (trade.ok !== true) return farmError(trade.error ?? 'market-busy')

    const total = trade.total
    if (kind === 'buy-seed') {
      this.#state.coins = Math.max(0, this.#state.coins - total)
      // 上限上面已经检查过；这里仍用 addStack 保证不会写出 1000 颗。
      addStack(this.#state.seeds, cropId, qty)
    } else {
      const held = this.#state.crops[cropId] ?? 0
      const left = held - qty
      if (left <= 0) delete this.#state.crops[cropId]
      else this.#state.crops[cropId] = left
      this.#state.coins = Math.min(MAX_COINS, this.#state.coins + total)
    }
    this.#resetIdle(now)

    const farmPersisted = await this.#persist(true)
    let marketPersisted = true
    if (trade.persisted !== undefined && typeof trade.persisted.then === 'function') {
      marketPersisted = await trade.persisted.catch(() => false)
    }

    const notice = kind === 'buy-seed'
      ? '买了 ' + qty + ' 颗' + crop.name + '种子，花了 ' + total + ' 硬币。'
      : '卖了 ' + qty + ' 个' + crop.name + '，得到 ' + total + ' 硬币。'
    return {
      ok: true,
      action: kind,
      cropId,
      qty,
      unitPrice: trade.unitPrice,
      total,
      price: trade.priceAfter,
      coins: this.#state.coins,
      seeds: { ...this.#state.seeds },
      crops: { ...this.#state.crops },
      dew: this.#state.dew,
      dewEarned: this.#state.dewEarned,
      notice,
      persisted: farmPersisted === true && marketPersisted !== false
    }
  }

  /**
   * 解锁下一块地（ticket 48 / ADR-0017）。
   * 失败：`max-plots`（已到 50）、`stale`（expected 与当前不符）、`no-coin`（不够）、
   * `reserve`（解锁后不够买一颗最便宜种子）。成功：扣币、`unlocked+1`、写 `unlock` 日志、
   * 重置待机计时；新地块是空地，不送种子。
   */
  async #unlockPlot (rawExpected) {
    const now = this.#nowMs()
    this.#advance(now)

    const current = this.#state.unlocked
    if (current >= MAX_PLOTS) return farmError('max-plots', farmErrorText('max-plots'))
    if (rawExpected !== undefined && rawExpected !== null) {
      const expected = Number(rawExpected)
      if (!Number.isInteger(expected) || expected !== current) {
        return farmError('stale', farmErrorText('stale'))
      }
    }

    // 状态里的 unlocked 永远在 4–50，走到这里 plotUnlockCost 不会为空。
    const cost = plotUnlockCost(current)
    if (this.#state.coins < cost) {
      return farmError('no-coin', '硬币不够：解锁下一块要 ' + cost + ' 硬币。')
    }
    if (this.#state.coins - cost < PLOT_UNLOCK_RESERVE) {
      return farmError(
        'reserve',
        '解锁后至少要留 ' + PLOT_UNLOCK_RESERVE + ' 硬币买种子，先卖点作物吧。'
      )
    }

    this.#state.coins -= cost
    this.#state.unlocked = current + 1
    this.#appendLog({ at: now, kind: 'unlock', qty: 1, plot: this.#state.unlocked, cost })
    this.#resetIdle(now)

    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'unlock',
      unlocked: this.#state.unlocked,
      maxPlots: MAX_PLOTS,
      cost,
      coins: this.#state.coins,
      nextCost: plotUnlockCost(this.#state.unlocked),
      plot: copyPlot(this.#state.plots[current]),
      notice: '解锁了第 ' + this.#state.unlocked + ' 块地，花了 ' + cost + ' 硬币。',
      persisted
    }
  }

  async #addCrop (rawCropId, rawQty) {
    const cropId = normalizeCropId(rawCropId)
    if (cropId === null) return farmError('bad-crop')
    const qty = positiveInt(rawQty, MAX_STACK)
    if (qty === null) return farmError('bad-qty')

    const now = this.#nowMs()
    this.#advance(now)
    const before = this.#state.crops[cropId] ?? 0
    const after = addStack(this.#state.crops, cropId, qty)
    const added = Math.max(0, after - before)
    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'add-crop',
      crop: cropId,
      qty: added,
      crops: { ...this.#state.crops },
      persisted
    }
  }

  async #addCoins (rawQty) {
    const qty = positiveInt(rawQty, MAX_COINS)
    if (qty === null) return farmError('bad-qty')
    const now = this.#nowMs()
    this.#advance(now)
    const before = this.#state.coins
    this.#state.coins = Math.min(MAX_COINS, before + qty)
    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'add-coins',
      qty: this.#state.coins - before,
      coins: this.#state.coins,
      persisted
    }
  }

  async #touch () {
    const now = this.#nowMs()
    this.#advance(now)
    this.#resetIdle(now)
    const persisted = await this.#persist(true)
    return { ok: true, action: 'touch', dewAt: now, persisted }
  }

  async #noteHire (raw) {
    const now = this.#nowMs()
    this.#advance(now)
    const entry = { at: now, kind: 'hire', qty: 0 }
    const who = sanitizeWho(raw?.who)
    if (who !== null) entry.who = who
    const hours = positiveInt(raw?.hours, MAX_HIRE_HOURS)
    if (hours !== null) entry.hours = hours
    const wage = nonNegativeInt(raw?.wage, MAX_COINS)
    if (wage !== null) entry.wage = wage
    this.#appendLog(entry)
    const persisted = await this.#persist(true)
    return { ok: true, action: 'note-hire', persisted }
  }

  async #noteSettle (raw) {
    const now = this.#nowMs()
    this.#advance(now)
    const entry = { at: now, kind: 'settle', qty: 0 }
    const who = sanitizeWho(raw?.who)
    if (who !== null) entry.who = who
    const wage = nonNegativeInt(raw?.wage, MAX_COINS)
    if (wage !== null) entry.wage = wage
    const earned = nonNegativeInt(raw?.earned, MAX_COINS)
    if (earned !== null) entry.earned = earned
    this.#appendLog(entry)
    const persisted = await this.#persist(true)
    return { ok: true, action: 'note-settle', persisted }
  }

  async #spendCoins (rawQty) {
    const qty = positiveInt(rawQty, MAX_COINS)
    if (qty === null) return farmError('bad-qty')
    const now = this.#nowMs()
    this.#advance(now)
    if (this.#state.coins < qty) return farmError('no-coin')
    this.#state.coins -= qty
    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'spend-coins',
      qty,
      coins: this.#state.coins,
      persisted
    }
  }

  async #setHire (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return farmError('bad-enabled')
    const current = this.#state.hire
    const enabled = raw.enabled === undefined ? current.enabled : raw.enabled
    if (typeof enabled !== 'boolean') return farmError('bad-enabled')
    const wage = raw.wagePerHour === undefined
      ? current.wagePerHour
      : strictHireInt(raw.wagePerHour, MIN_WAGE, MAX_WAGE)
    if (wage === null) return farmError('bad-wage')
    const minHours = raw.minHours === undefined
      ? current.minHours
      : strictHireInt(raw.minHours, MIN_HIRE_HOURS, MAX_HIRE_HOURS)
    if (minHours === null) return farmError('bad-hours')
    const maxHours = raw.maxHours === undefined
      ? current.maxHours
      : strictHireInt(raw.maxHours, MIN_HIRE_HOURS, MAX_HIRE_HOURS)
    if (maxHours === null) return farmError('bad-hours')
    if (minHours > maxHours) return farmError('bad-hours')
    this.#state.hire = { enabled, wagePerHour: wage, minHours, maxHours }
    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'hire-listing',
      hire: { ...this.#state.hire },
      persisted
    }
  }

  async #spendDew (rawQty) {
    const qty = positiveInt(rawQty, MAX_DEW)
    if (qty === null) return farmError('bad-qty')
    const now = this.#nowMs()
    this.#advance(now)
    if (this.#state.dew < qty) return farmError('no-dew')
    this.#state.dew -= qty
    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'spend-dew',
      qty,
      dew: this.#state.dew,
      persisted
    }
  }

  async #refundDew (rawQty) {
    const qty = positiveInt(rawQty, MAX_DEW)
    if (qty === null) return farmError('bad-qty')
    const now = this.#nowMs()
    this.#advance(now)
    const before = this.#state.dew
    this.#state.dew = Math.min(MAX_DEW, before + qty)
    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'refund-dew',
      qty: this.#state.dew - before,
      dew: this.#state.dew,
      persisted
    }
  }

  /** 只读统计：跨日按零算，但不改内存（等下一次 tick/动作再重置）。 */
  #visitStatsAt (now) {
    const day = localDayKey(now)
    const stats = this.#state.visitStats
    if (day !== null && stats.day !== day) return emptyVisitStats(day)
    return stats
  }

  #visitLimits (rawDeviceId) {
    const deviceId = normalizeDeviceId(rawDeviceId)
    const stats = this.#visitStatsAt(this.#nowMs())
    const limits = visitLimitsFor(this.#state.unlocked)
    const stealUsed = deviceId === null ? 0 : Number(stats.steal.byVisitor[deviceId]) || 0
    const helpUsed = deviceId === null ? 0 : Number(stats.help.byVisitor[deviceId]) || 0
    return {
      steal: {
        perVisit: limits.steal.perVisitorFarm,
        usedInVisit: stealUsed,
        perFarm: limits.steal.perFarmDay,
        usedOnFarm: Number(stats.steal.total) || 0,
        // 跨农场额度只有访客本机算得清：主人快照留 0，访客侧拿到后覆盖。
        perDay: 0,
        usedToday: 0
      },
      help: {
        perVisit: limits.help.perVisitorFarm,
        usedInVisit: helpUsed,
        perFarm: limits.help.perFarmDay,
        usedOnFarm: Number(stats.help.total) || 0,
        // 同上：跨农场额度由访客本机补。
        perDay: 0,
        usedToday: 0
      }
    }
  }

  #visitActionUsed (kind) {
    if (kind !== 'steal' && kind !== 'help') return 0
    const stats = this.#visitStatsAt(this.#nowMs())
    return Number(stats.mine[kind]) || 0
  }

  async #noteVisitAction (kind) {
    if (kind !== 'steal' && kind !== 'help') return farmError('bad-action')
    const now = this.#nowMs()
    this.#advance(now)
    const limit = this.visitDailyLimit(kind)
    const used = Number(this.#state.visitStats.mine[kind]) || 0
    if (used >= limit) return { ok: false, error: 'cap', used, limit, persisted: false }
    this.#state.visitStats.mine[kind] = used + 1
    const persisted = await this.#persist(true)
    return { ok: true, kind, used: used + 1, limit, persisted }
  }

  async #markStolen (rawPlotId, rawDeviceId, options) {
    const plotId = normalizePlotId(rawPlotId)
    if (plotId === null) return farmError('bad-plot')
    const deviceId = normalizeDeviceId(rawDeviceId)
    if (deviceId === null) return farmError('bad-plot')

    const now = this.#nowMs()
    this.#advance(now)
    const index = this.#plotIndex(plotId)
    if (index < 0) return farmError('bad-plot')
    const plot = this.#state.plots[index]
    if (plot === undefined || !isCropId(plot.crop)) return farmError('bad-plot')
    if (!isMature(plot)) return farmError('not-mature')
    if (plot.stolenBy.includes(deviceId)) return farmError('already-stolen')

    const stats = this.#state.visitStats
    const limits = visitLimitsFor(this.#state.unlocked)
    const usedInVisit = Number(stats.steal.byVisitor[deviceId]) || 0
    if (usedInVisit >= limits.steal.perVisitorFarm || stats.steal.total >= limits.steal.perFarmDay) {
      return farmError('cap')
    }

    const crop = plot.crop
    const who = sanitizeWho(options?.who)
    // 被抓住也是一次真实尝试：先记访客/农场次数，再写 qty 0 的日志。
    // 地块本身不动（`stolenBy` 只在成功时加），所以同一块地还能再试，但次数会先耗尽——
    // 不能靠「被抓就重发新 requestId」刷到成功（SPEC v5「偷菜与帮忙」每日上限）。
    stats.steal.total += 1
    stats.steal.byVisitor[deviceId] = usedInVisit + 1
    if (options?.caught === true) {
      this.#appendLog({ at: now, kind: 'steal', crop, qty: 0, ...(who === null ? {} : { who }) })
      const persisted = await this.#persist(true)
      return { ok: false, error: 'guard', caught: true, crop, qty: 0, persisted }
    }

    const next = { ...plot, stolenBy: [...plot.stolenBy, deviceId] }
    this.#state.plots[index] = next
    this.#appendLog({ at: now, kind: 'steal', crop, qty: 1, ...(who === null ? {} : { who }) })

    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'steal',
      plotId,
      crop,
      qty: 1,
      plot: copyPlot(next),
      // 收获时结算的产量：stolenBy 每多一位访客就少 1（harvestYield 是唯一算法）。
      yield: harvestYield(next),
      persisted
    }
  }

  async #markHelped (rawPlotId, rawDeviceId, options) {
    const plotId = normalizePlotId(rawPlotId)
    if (plotId === null) return farmError('bad-plot')
    const deviceId = normalizeDeviceId(rawDeviceId)
    if (deviceId === null) return farmError('bad-plot')

    const now = this.#nowMs()
    this.#advance(now)
    const index = this.#plotIndex(plotId)
    if (index < 0) return farmError('bad-plot')
    const plot = this.#state.plots[index]
    if (plot === undefined || !isCropId(plot.crop) || isMature(plot)) return farmError('bad-plot')
    if (plot.helpedBy.includes(deviceId)) return farmError('already-helped')

    const stats = this.#state.visitStats
    const limits = visitLimitsFor(this.#state.unlocked)
    const usedInVisit = Number(stats.help.byVisitor[deviceId]) || 0
    if (usedInVisit >= limits.help.perVisitorFarm || stats.help.total >= limits.help.perFarmDay) {
      return farmError('cap')
    }

    const helped = helpPlot(plot)
    if (helped === null) return farmError('bad-plot')
    this.#state.plots[index] = { ...helped, helpedBy: [...helped.helpedBy, deviceId] }
    stats.help.total += 1
    stats.help.byVisitor[deviceId] = usedInVisit + 1
    const who = sanitizeWho(options?.who)
    this.#appendLog({
      at: now,
      kind: 'help',
      crop: plot.crop,
      qty: 1,
      ...(who === null ? {} : { who })
    })

    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'help',
      plotId,
      crop: plot.crop,
      qty: 1,
      plot: copyPlot(this.#state.plots[index]),
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

function farmError (error, notice = null) {
  return {
    ok: false,
    error,
    persisted: false,
    ...(notice === null ? {} : { notice })
  }
}
