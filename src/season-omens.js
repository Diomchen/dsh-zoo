/**
 * 票 67/74：四季「季候来客」的纯规则。
 *
 * 不碰存档、不碰窗口：只回答「这个选择成不成、扣多少、给什么」。
 * 概率复用农场的守卫值（主人在家 0.3、雇工 0.5、封顶 0.8），
 * 但来客不是偷菜：守卫成功 = 偷菜判定失败。
 *
 * 票 74 起四季各有一位来客；蛙雨/野火在当天随机一个整分钟出现，熊獾/巨鹿固定在
 * 本地 15:00 出现，二者都持续 3 小时。这样重启、换窗口、多开都不会让来客时间漂移；
 * 同一天同一季的玩家看到的是同一个窗口。
 */
import { HOUR_MS, MINUTE_MS } from './season-rules.js'
import { stealSucceeds } from './farm-rules.js'

export const OMEN_WINDOW_MS = 3 * HOUR_MS

const DEFS = Object.freeze({
  spring: Object.freeze({
    id: 'spring-frog-rain',
    name: '蛙雨',
    emoji: '🐸',
    season: 'spring',
    tag: '春夜来客',
    window: Object.freeze({ mode: 'random' }),
    guard: Object.freeze({
      label: '赶走',
      detail: '带人把蛙群赶回田外；失败会踩坏两块正在长的地。'
    }),
    fail: Object.freeze({ witherPlots: 2 }),
    reward: Object.freeze({ coins: 45, dew: 3, seeds: Object.freeze({ pea: 1 }) }),
    feed: Object.freeze({
      label: '引水',
      detail: '花 1 露水挖一条引水沟，把蛙群引去别处，稳过。',
      cost: Object.freeze({ dew: 1 }),
      reward: Object.freeze({})
    }),
    ignore: Object.freeze({ witherPlots: 1 })
  }),
  summer: Object.freeze({
    id: 'summer-wildfire',
    name: '野火',
    emoji: '🔥',
    season: 'summer',
    tag: '夏夜来客',
    window: Object.freeze({ mode: 'random' }),
    guard: Object.freeze({
      label: '隔离',
      detail: '抢在火势蔓延前清出隔离带；失败会烧掉两块成熟作物。'
    }),
    fail: Object.freeze({ witherPlots: 2, matureOnly: true }),
    reward: Object.freeze({ coins: 55, dew: 4, seeds: Object.freeze({ watermelon: 1 }) }),
    feed: Object.freeze({
      label: '浇水',
      detail: '花 2 露水把火头浇灭，稳过。',
      cost: Object.freeze({ dew: 2 }),
      reward: Object.freeze({})
    }),
    ignore: Object.freeze({ witherPlots: 1 })
  }),
  autumn: Object.freeze({
    id: 'autumn-bearger',
    name: '熊獾',
    emoji: '🐻',
    season: 'autumn',
    tag: '秋夜来客',
    window: Object.freeze({ mode: 'fixed', hour: 15 }),
    guard: Object.freeze({
      label: '守夜',
      detail: '按守卫成功率赌一把；失败会被搬走 5 个仓库作物。'
    }),
    fail: Object.freeze({ crops: 5 }),
    reward: Object.freeze({ coins: 70, dew: 5, seeds: Object.freeze({ rice: 1 }) }),
    feed: Object.freeze({
      label: '投喂',
      detail: '交出 3 个仓库作物，换 1 颗稻种 + 2 露水，稳过。',
      cost: Object.freeze({ crops: 3 }),
      reward: Object.freeze({ dew: 2, seeds: Object.freeze({ rice: 1 }) })
    }),
    ignore: Object.freeze({ crops: 2 })
  }),
  winter: Object.freeze({
    id: 'winter-deerclops',
    name: '巨鹿',
    emoji: '🦌',
    season: 'winter',
    tag: '冬夜来客',
    window: Object.freeze({ mode: 'fixed', hour: 15 }),
    guard: Object.freeze({
      label: '硬扛',
      detail: '把巨鹿挡在田外；失败会冻住三块地，换季前不解冻就会冻死。'
    }),
    fail: Object.freeze({ freezePlots: 3 }),
    reward: Object.freeze({ coins: 65, dew: 6, seeds: Object.freeze({ radish: 1 }) }),
    feed: Object.freeze({
      label: '生火',
      detail: '花 2 露水 + 10 硬币点起大火堆，把它引走，稳过。',
      cost: Object.freeze({ dew: 2, coins: 10 }),
      reward: Object.freeze({})
    }),
    ignore: Object.freeze({ freezePlots: 2 })
  })
})

const BY_ID = Object.freeze(Object.fromEntries(
  Object.values(DEFS).map((entry) => [entry.id, entry])
))

function cloneReward (reward = {}) {
  return {
    coins: Math.max(0, Math.floor(Number(reward.coins) || 0)),
    dew: Math.max(0, Math.floor(Number(reward.dew) || 0)),
    seeds: { ...(reward.seeds ?? {}) }
  }
}

function cloneCost (cost = {}) {
  return {
    crops: Math.max(0, Math.floor(Number(cost.crops) || 0)),
    dew: Math.max(0, Math.floor(Number(cost.dew) || 0)),
    coins: Math.max(0, Math.floor(Number(cost.coins) || 0))
  }
}

function cloneLoss (loss = {}) {
  return {
    crops: Math.max(0, Math.floor(Number(loss.crops) || 0)),
    witherPlots: Math.max(0, Math.floor(Number(loss.witherPlots) || 0)),
    freezePlots: Math.max(0, Math.floor(Number(loss.freezePlots) || 0)),
    matureOnly: loss.matureOnly === true
  }
}

function stakesOf (def) {
  return {
    guardReward: cloneReward(def.reward),
    failLoss: Math.max(0, Math.floor(Number(def.fail?.crops) || 0)),
    failWither: Math.max(0, Math.floor(Number(def.fail?.witherPlots) || 0)),
    failFreeze: Math.max(0, Math.floor(Number(def.fail?.freezePlots) || 0)),
    failMatureOnly: def.fail?.matureOnly === true,
    feedCost: cloneCost(def.feed?.cost),
    feedReward: cloneReward(def.feed?.reward),
    ignoreLoss: cloneLoss(def.ignore)
  }
}

function choicesOf (def) {
  return [
    { id: 'guard', label: def.guard.label, detail: def.guard.detail },
    { id: 'feed', label: def.feed.label, detail: def.feed.detail }
  ]
}

export function omenFor (seasonId) {
  const def = DEFS[seasonId]
  if (def === undefined) return null
  return {
    id: def.id,
    name: def.name,
    emoji: def.emoji,
    season: def.season,
    tag: def.tag,
    window: def.window,
    windowMs: OMEN_WINDOW_MS,
    choices: choicesOf(def),
    stakes: stakesOf(def)
  }
}

export function omenForId (id) {
  const def = BY_ID[id]
  return def === undefined ? null : omenFor(def.season)
}

function hash32 (text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * 蛙雨/野火：当天 00:00～21:00 之间的某个整分钟，持续 3 小时；用「当天 start + 来客 id」
 * 做稳定散列，避免 Math.random 在重启后换时间。
 * 熊獾/巨鹿：固定本地 15:00 开始，持续 3 小时。
 */
export function omenWindowFor (season, meta = omenFor(season?.id)) {
  const start = Math.max(0, Math.floor(Number(season?.start) || 0))
  const end = Math.max(start, Math.floor(Number(season?.end) || start))
  if (meta === null || end <= start) return { start, end }
  if (meta.window?.mode === 'fixed') {
    const fixed = new Date(start)
    fixed.setHours(Number(meta.window.hour) || 15, 0, 0, 0)
    const from = Math.min(Math.max(start, fixed.getTime()), Math.max(start, end - OMEN_WINDOW_MS))
    return { start: from, end: Math.min(end, from + OMEN_WINDOW_MS) }
  }
  const room = Math.max(0, end - start - OMEN_WINDOW_MS)
  const slots = Math.floor(room / MINUTE_MS)
  const offset = slots > 0
    ? (hash32(start + ':' + meta.id) % (slots + 1)) * MINUTE_MS
    : 0
  const from = start + offset
  return { start: from, end: Math.min(end, from + OMEN_WINDOW_MS) }
}

export function freshOmen (season) {
  const meta = omenFor(season?.id)
  if (meta === null) return null
  const window = omenWindowFor(season, meta)
  return {
    day: season.start,
    season: season.id,
    id: meta.id,
    start: window.start,
    end: window.end,
    resolved: false,
    choice: null,
    result: null
  }
}

/**
 * 读档收敛：只接受「同一天、同一季、同一个来客、同一个随机窗口」的状态；
 * 其余一律当作没来过，交给 `freshOmen` 按当天重新算窗口。
 */
export function normalizeOmen (raw, season) {
  const meta = omenFor(season?.id)
  if (meta === null || raw === null || typeof raw !== 'object') return null
  const window = omenWindowFor(season, meta)
  if (raw.day !== season.start || raw.id !== meta.id) return null
  if (raw.start !== window.start || raw.end !== window.end) return null
  return {
    day: season.start,
    season: season.id,
    id: meta.id,
    start: window.start,
    end: window.end,
    resolved: raw.resolved === true,
    choice: raw.choice === 'guard' || raw.choice === 'feed' ? raw.choice : null,
    result: raw.result !== null && typeof raw.result === 'object' ? { ...raw.result } : null
  }
}

/** 窗口视图；`canFeed` 由 service 按仓库/硬币/露水补，规则层不知道农场库存。 */
export function omenView (omen, now = Date.now()) {
  if (omen === null || typeof omen !== 'object') return null
  const meta = omenFor(omen.season) ?? omenForId(omen.id)
  if (meta === null) return null
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const start = Math.max(0, Math.floor(Number(omen.start) || 0))
  const end = Math.max(start, Math.floor(Number(omen.end) || start))
  return {
    ...meta,
    day: omen.day,
    start,
    end,
    remainingMs: Math.max(0, end - at),
    active: at >= start && at < end,
    resolved: omen.resolved === true,
    choice: omen.choice,
    result: omen.result === null || omen.result === undefined ? null : { ...omen.result }
  }
}

/**
 * 结算一个选择。`guard` 是 0..0.8 的守卫值，`random` 可注入。
 * 投喂/浇水/生火不掷骰：只要 service 已经扣掉成本，就稳过。
 */
export function resolveOmen (choice, { guard = 0, random = Math.random, now = null, omen = null } = {}) {
  if (choice !== 'guard' && choice !== 'feed') return { ok: false, code: 'bad-choice' }
  const meta = omenFor(omen?.season) ?? omenForId(omen?.id)
  if (meta === null) return { ok: false, code: 'omen-resolved' }

  if (now !== null) {
    const at = Number(now)
    if (!Number.isFinite(at) || at < omen.start || at >= omen.end) {
      return { ok: false, code: 'omen-inactive' }
    }
  }

  const stakes = meta.stakes
  if (choice === 'feed') {
    return {
      ok: true,
      choice,
      success: true,
      loss: cloneLoss({}),
      consume: { ...stakes.feedCost },
      reward: cloneReward(stakes.feedReward)
    }
  }

  const success = !stealSucceeds(guard, random)
  return {
    ok: true,
    choice,
    success,
    loss: success
      ? cloneLoss({})
      : cloneLoss({
          crops: stakes.failLoss,
          witherPlots: stakes.failWither,
          freezePlots: stakes.failFreeze,
          matureOnly: stakes.failMatureOnly
        }),
    consume: cloneCost({}),
    reward: success ? cloneReward(stakes.guardReward) : cloneReward({})
  }
}

// 兼容旧测试/旧调用方：秋天熊獾的常量仍然导出，但规则已经按四季查表。
export const OMEN_ID = DEFS.autumn.id
export const OMEN_SEASON = DEFS.autumn.season
export const OMEN_NAME = DEFS.autumn.name
export const OMEN_EMOJI = DEFS.autumn.emoji
export const OMEN_GUARD_REWARD = Object.freeze({ coins: 70, dew: 5, seeds: Object.freeze({ rice: 1 }) })
export const OMEN_FEED_COST = 3
export const OMEN_FEED_REWARD = Object.freeze({ coins: 0, dew: 2, seeds: Object.freeze({ rice: 1 }) })
export const OMEN_FAIL_LOSS = 5
export const OMEN_IGNORE_LOSS = 2
export const OMEN_CHOICES = Object.freeze(choicesOf(DEFS.autumn))
