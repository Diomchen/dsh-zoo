/**
 * 「出远门」的规则层（票 112）。
 *
 * 这里只有纯函数：路线表、段数、每段回币、危险度、状态迁移与结算。不读盘、不看系统时钟，
 * `now` 与随机都由调用方传进来——段数和抖动从 `runId` 派生，所以同一趟在重启后走的是同一条路。
 *
 * 四条路线、32 件特产与图鉴都在这里：掉落只由 `routeId + runId + 段号 + 已捡/已集清单` 决定，
 * 翻车减半也是纯函数；翻车判定、段落推进与结算的时机由 `expedition-store` 按这套纯函数驱动。
 */

/** 走一段的时间：20 秒（手册《出远门》的节奏）。 */
export const LEG_MS = 20000
/** 每段走完后的决策窗：20 秒。到点没选就自动折返（`expireRun`，算「已回家」）。 */
export const DECISION_MS = 20000

/** 陈列架：默认 8 格，第 9 格起每格 5,000，最多 32 格（开满共 120,000）。 */
export const SHELF_BASE_SLOTS = 8
export const SHELF_MAX_SLOTS = 32
export const SHELF_SLOT_PRICE = 5000

/**
 * 提灯（票 118）：一次买断的装备，买了才在决策窗看到下一段的精确危险百分比。
 * 价格是规则层的数，窗口只负责显示宿主给的这一份。
 */
export const LANTERN_PRICE = 10000

/**
 * 路线表。盘缠（fare）入场即扣、永不退；`coinRate` 是每段回币占盘缠的比例，
 * `coinJitter` 是乘在这个比例上的 ± 抖动。`unlock` 是 117 的解锁条件，判定在 `unlockStatus`。
 */
export const ROUTES = Object.freeze({
  backhill: Object.freeze({
    id: 'backhill',
    name: '后山',
    fare: 500,
    minLegs: 3,
    maxLegs: 4,
    coinRate: 0.03,
    coinJitter: 0.25,
    dangerBase: 0.05,
    dangerPerLeg: 0.03,
    unlock: Object.freeze({ kind: 'always' })
  }),
  mine: Object.freeze({
    id: 'mine',
    name: '废矿',
    fare: 3000,
    minLegs: 4,
    maxLegs: 5,
    coinRate: 0.03,
    coinJitter: 0.25,
    dangerBase: 0.08,
    dangerPerLeg: 0.03,
    unlock: Object.freeze({ kind: 'trips', routeId: 'backhill', count: 3 })
  }),
  railway: Object.freeze({
    id: 'railway',
    name: '老铁路',
    fare: 15000,
    minLegs: 5,
    maxLegs: 6,
    coinRate: 0.03,
    coinJitter: 0.25,
    dangerBase: 0.1,
    dangerPerLeg: 0.03,
    unlock: Object.freeze({ kind: 'codex', count: 16 })
  }),
  mistridge: Object.freeze({
    id: 'mistridge',
    name: '雾岭',
    fare: 60000,
    minLegs: 6,
    maxLegs: 7,
    coinRate: 0.03,
    coinJitter: 0.25,
    dangerBase: 0.12,
    dangerPerLeg: 0.03,
    unlock: Object.freeze({ kind: 'codex-trips', count: 24, routeId: 'railway', trips: 1 })
  })
})

export const ROUTE_IDS = Object.freeze(Object.keys(ROUTES))

/**
 * 稀有度档位与权重。手册《战利品》按普通/稀有/珍稀/传说标注，权重在同一档内平均分配，
 * 所以单件特产的期望比就是 30 : 12 : 4 : 1。
 */
export const RARITIES = Object.freeze({
  common: Object.freeze({ id: 'common', label: '普通', weight: 30 }),
  rare: Object.freeze({ id: 'rare', label: '稀有', weight: 12 }),
  precious: Object.freeze({ id: 'precious', label: '珍稀', weight: 4 }),
  legendary: Object.freeze({ id: 'legendary', label: '传说', weight: 1 })
})

/**
 * 32 件特产目录，路线与稀有度照抄 `docs/play-expedition.md` 的战利品表。
 *
 * `art` 是窗口里的相对路径（`file://` 加载，CSP 放行 'self'）；`emoji` 是缺图时的兜底。
 * 四条路线各有 8 件，掉落表与解锁链见手册《出远门》。
 */
export const SOUVENIRS = Object.freeze({
  herb: Object.freeze({ id: 'herb', name: '草药', routeId: 'backhill', rarity: 'common', emoji: '🌿', art: 'souvenirs/herb.svg' }),
  oddstone: Object.freeze({ id: 'oddstone', name: '怪石', routeId: 'backhill', rarity: 'common', emoji: '🪨', art: 'souvenirs/oddstone.svg' }),
  pinecone: Object.freeze({ id: 'pinecone', name: '松果', routeId: 'backhill', rarity: 'common', emoji: '🌰', art: 'souvenirs/pinecone.svg' }),
  feather: Object.freeze({ id: 'feather', name: '羽毛', routeId: 'backhill', rarity: 'common', emoji: '🪶', art: 'souvenirs/feather.svg' }),
  mushroom: Object.freeze({ id: 'mushroom', name: '蘑菇', routeId: 'backhill', rarity: 'common', emoji: '🍄', art: 'souvenirs/mushroom.svg' }),
  shard: Object.freeze({ id: 'shard', name: '陶片', routeId: 'backhill', rarity: 'rare', emoji: '🏺', art: 'souvenirs/shard.svg' }),
  hawthorn: Object.freeze({ id: 'hawthorn', name: '山楂', routeId: 'backhill', rarity: 'rare', emoji: '🍒', art: 'souvenirs/hawthorn.svg' }),
  egg: Object.freeze({ id: 'egg', name: '鸟蛋', routeId: 'backhill', rarity: 'precious', emoji: '🥚', art: 'souvenirs/egg.svg' }),

  ore: Object.freeze({ id: 'ore', name: '矿石', routeId: 'mine', rarity: 'common', emoji: '⛏️', art: 'souvenirs/ore.svg' }),
  coal: Object.freeze({ id: 'coal', name: '煤块', routeId: 'mine', rarity: 'common', emoji: '🪵', art: 'souvenirs/coal.svg' }),
  gear: Object.freeze({ id: 'gear', name: '齿轮', routeId: 'mine', rarity: 'common', emoji: '⚙️', art: 'souvenirs/gear.svg' }),
  bone: Object.freeze({ id: 'bone', name: '兽骨', routeId: 'mine', rarity: 'common', emoji: '🦴', art: 'souvenirs/bone.svg' }),
  oldtool: Object.freeze({ id: 'oldtool', name: '旧工具', routeId: 'mine', rarity: 'rare', emoji: '🔧', art: 'souvenirs/oldtool.svg' }),
  oldcoin: Object.freeze({ id: 'oldcoin', name: '锈钱', routeId: 'mine', rarity: 'rare', emoji: '🪙', art: 'souvenirs/oldcoin.svg' }),
  crystal: Object.freeze({ id: 'crystal', name: '晶簇', routeId: 'mine', rarity: 'rare', emoji: '💎', art: 'souvenirs/crystal.svg' }),
  moonstone: Object.freeze({ id: 'moonstone', name: '月光石', routeId: 'mine', rarity: 'precious', emoji: '🌙', art: 'souvenirs/moonstone.svg' }),

  bell: Object.freeze({ id: 'bell', name: '铜铃', routeId: 'railway', rarity: 'common', emoji: '🔔', art: 'souvenirs/bell.svg' }),
  flag: Object.freeze({ id: 'flag', name: '信号旗', routeId: 'railway', rarity: 'common', emoji: '🚩', art: 'souvenirs/flag.svg' }),
  key: Object.freeze({ id: 'key', name: '铜钥匙', routeId: 'railway', rarity: 'common', emoji: '🗝️', art: 'souvenirs/key.svg' }),
  watch: Object.freeze({ id: 'watch', name: '怀表', routeId: 'railway', rarity: 'rare', emoji: '⏱️', art: 'souvenirs/watch.svg' }),
  ticket: Object.freeze({ id: 'ticket', name: '车票', routeId: 'railway', rarity: 'rare', emoji: '🎫', art: 'souvenirs/ticket.svg' }),
  sign: Object.freeze({ id: 'sign', name: '站台牌', routeId: 'railway', rarity: 'rare', emoji: '🪧', art: 'souvenirs/sign.svg' }),
  badge: Object.freeze({ id: 'badge', name: '徽章', routeId: 'railway', rarity: 'rare', emoji: '🎖️', art: 'souvenirs/badge.svg' }),
  tag: Object.freeze({ id: 'tag', name: '行李牌', routeId: 'railway', rarity: 'precious', emoji: '🏷️', art: 'souvenirs/tag.svg' }),

  mistlamp: Object.freeze({ id: 'mistlamp', name: '雾灯', routeId: 'mistridge', rarity: 'common', emoji: '🏮', art: 'souvenirs/mistlamp.svg' }),
  antler: Object.freeze({ id: 'antler', name: '白鹿角', routeId: 'mistridge', rarity: 'common', emoji: '🦌', art: 'souvenirs/antler.svg' }),
  cloudjade: Object.freeze({ id: 'cloudjade', name: '云纹佩', routeId: 'mistridge', rarity: 'rare', emoji: '🧿', art: 'souvenirs/cloudjade.svg' }),
  starsand: Object.freeze({ id: 'starsand', name: '星砂瓶', routeId: 'mistridge', rarity: 'rare', emoji: '✨', art: 'souvenirs/starsand.svg' }),
  frostbranch: Object.freeze({ id: 'frostbranch', name: '雾凇枝', routeId: 'mistridge', rarity: 'rare', emoji: '🌿', art: 'souvenirs/frostbranch.svg' }),
  whistle: Object.freeze({ id: 'whistle', name: '银哨', routeId: 'mistridge', rarity: 'rare', emoji: '📯', art: 'souvenirs/whistle.svg' }),
  stele: Object.freeze({ id: 'stele', name: '石敢当', routeId: 'mistridge', rarity: 'legendary', emoji: '🗿', art: 'souvenirs/stele.svg' }),
  seal: Object.freeze({ id: 'seal', name: '山神印', routeId: 'mistridge', rarity: 'legendary', emoji: '🔮', art: 'souvenirs/seal.svg' })
})

/** 图鉴的顺序：目录的插入顺序，按路线分成四组。 */
export const SOUVENIR_IDS = Object.freeze(Object.keys(SOUVENIRS))

/** 图鉴满这么多件以后，掉落只从「还没集齐」的件里抽（评审 C3，手册《出远门》同一句）。 */
export const CODEX_FRESH_AT = 8

/** 每条路线可掉的特产；没开的路线的目录也在这里，窗口图鉴照样显示。 */
export const SOUVENIRS_BY_ROUTE = Object.freeze({
  backhill: Object.freeze(SOUVENIR_IDS.filter((id) => SOUVENIRS[id].routeId === 'backhill').map((id) => SOUVENIRS[id])),
  mine: Object.freeze(SOUVENIR_IDS.filter((id) => SOUVENIRS[id].routeId === 'mine').map((id) => SOUVENIRS[id])),
  railway: Object.freeze(SOUVENIR_IDS.filter((id) => SOUVENIRS[id].routeId === 'railway').map((id) => SOUVENIRS[id])),
  mistridge: Object.freeze(SOUVENIR_IDS.filter((id) => SOUVENIRS[id].routeId === 'mistridge').map((id) => SOUVENIRS[id]))
})

/** 图鉴的路线名：窗口只认这份稳定名字，不自己从 ROUTES 里翻。 */
export const SOUVENIR_ROUTE_NAMES = Object.freeze({
  backhill: '后山',
  mine: '废矿',
  railway: '老铁路',
  mistridge: '雾岭'
})

/** 特产对象；未知 id 返回 null。 */
export function souvenirOf (id) {
  if (typeof id !== 'string') return null
  return Object.prototype.hasOwnProperty.call(SOUVENIRS, id) ? SOUVENIRS[id] : null
}

/** 三种结局都认：`back`（折返/超时）、`complete`（走满）、`failed`（翻车）。读档按这个白名单收。 */
const ENDED_KINDS = Object.freeze(['back', 'complete', 'failed'])

/**
 * 结束原因，给 116 的日志写正文用：
 * - `wipeout` 继续走时翻车；
 * - `timeout` 决策窗 20 秒没人管，自己折返。
 * 正常折返/走满不带原因。
 */
export const ENDED_REASONS = Object.freeze(['wipeout', 'timeout'])

/** 规则层说人话的兜底文案；窗口/HTTP 只补宿主没说的那种。 */
export const EXPEDITION_ERROR_TEXT = Object.freeze({
  'already-away': '它正在出远门（或串门/打工），这一趟走不了。',
  'not-enough-coins': '硬币不够付盘缠，这趟走不了。',
  locked: '这条路线还没解锁，先看看灰卡上的条件。',
  'no-route': '没有这条路线。',
  'not-walking': '这一趟现在不用做决定。',
  // 陈列架（115）的 locked 与路线（117）共用同一个 error code；架子那边的文案在
  // service.expeditionShelf 里单独补，这里保留路线的说法。
  starting: '出远门还没准备好，稍等一下。',
  'save-failed': '存档写不进去，这趟没能出发。',
  'desktop-off': '桌面层没在运行，出远门的窗口开不了。'
})

/** 路线对象；未知 id 返回 null（不抛，读档时坏数据只降级）。 */
export function routeOf (routeId) {
  if (typeof routeId !== 'string') return null
  return Object.prototype.hasOwnProperty.call(ROUTES, routeId) ? ROUTES[routeId] : null
}

function countOf (value) {
  return Number.isInteger(value) && value > 0 ? value : 0
}

function routeLabel (routeId) {
  return ROUTES[routeId]?.name ?? SOUVENIR_ROUTE_NAMES[routeId] ?? String(routeId)
}

/**
 * 解锁判定（票 117）：只看「已回家的趟数」与图鉴件数。
 *
 * 返回 `{ unlocked, requirement, progress }`——`requirement` 是灰卡上的解锁条件，
 * `progress` 是当前进度（「还差 2 趟后山」「图鉴 13/16」）；条件满足时 progress 也给出
 * 满额，窗口不用再换算。`trips` 是各路线已回家的趟数，`codexOwned` 是图鉴已点亮件数。
 */
export function unlockStatus (route, { trips = {}, codexOwned = 0 } = {}) {
  const unlock = route !== null && typeof route === 'object' ? route.unlock : null
  const kind = unlock !== null && typeof unlock === 'object' ? unlock.kind : 'always'
  const owned = countOf(codexOwned)
  const tripCount = (routeId) => countOf(trips !== null && typeof trips === 'object' ? trips[routeId] : 0)

  if (kind === 'trips') {
    const need = countOf(unlock.count)
    const done = tripCount(unlock.routeId)
    const name = routeLabel(unlock.routeId)
    return {
      unlocked: done >= need,
      requirement: `走过 ${need} 趟${name}`,
      progress: done >= need ? `${name} ${need}/${need} 趟` : `还差 ${need - done} 趟${name}`
    }
  }
  if (kind === 'codex') {
    const need = countOf(unlock.count)
    const done = Math.min(owned, need)
    return {
      unlocked: owned >= need,
      requirement: `图鉴 ${need} 件`,
      progress: `图鉴 ${done}/${need}`
    }
  }
  if (kind === 'codex-trips') {
    const need = countOf(unlock.count)
    const needTrips = countOf(unlock.trips)
    const done = Math.min(owned, need)
    const doneTrips = Math.min(tripCount(unlock.routeId), needTrips)
    const name = routeLabel(unlock.routeId)
    return {
      unlocked: owned >= need && doneTrips >= needTrips,
      requirement: `图鉴 ${need} 件 · 走过 ${needTrips} 趟${name}`,
      progress: `图鉴 ${done}/${need} · ${name} ${doneTrips}/${needTrips}`
    }
  }
  return { unlocked: true, requirement: '默认开放', progress: '已开放' }
}

/**
 * 这一趟算不算「已回家」：走满、见好就收、超时自己回来都算（超时的 `ended` 也是 `back`，
 * 只有 `reason` 是 `timeout`）；翻车（`failed`）与还在路上的不算。
 */
export function homedRun (run) {
  if (run === null || typeof run !== 'object') return false
  if (run.ended !== 'complete' && run.ended !== 'back') return false
  return routeOf(run.routeId) !== null
}

/**
 * 记一趟「已回家」的行程：只认 complete/back（超时也是 back），按路线累加。
 * 纯函数，返回新的计数对象；不算数的 run 原样返回入参。落盘层负责写回。
 */
export function recordTrip (trips, run) {
  const base = trips !== null && typeof trips === 'object' && !Array.isArray(trips) ? trips : {}
  if (!homedRun(run)) return base
  return { ...base, [run.routeId]: countOf(base[run.routeId]) + 1 }
}

/**
 * 32 位 FNV-1a。只用它把 `runId` 派生成稳定的 [0,1) 随机数：
 * 同一趟、同一段永远重放同一个结果，重启不会「走另一条路」。
 */
export function hash32 (...parts) {
  let hash = 2166136261
  const text = parts.map((part) => String(part)).join('|')
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** murmur3 的尾混合：让末位的一个字符也能把整个 32 位搅乱。 */
function fmix32 (value) {
  let hash = value >>> 0
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return hash >>> 0
}

/**
 * 由参数派生的确定性随机数，落在 [0,1)。
 *
 * 必须先过 fmix32：FNV-1a 对「只差最后一个字符」的两个串（`…|danger|2` /
 * `…|danger|3`）输出只差一个常数，不搅一遍的话「上一段没翻车」会把下一段
 * 的翻车率压低一个量级，`dangerOf` 的递增就形同虚设。
 */
export function roll01 (...parts) {
  return fmix32(hash32(...parts)) / 4294967296
}

/** 这一趟走几段：在路线的 [minLegs, maxLegs] 里按 runId 定。 */
export function legsFor (route, runId) {
  const span = route.maxLegs - route.minLegs + 1
  return route.minLegs + Math.floor(roll01(runId, 'legs') * span)
}

/**
 * 第 `leg` 段掉哪件特产：在本路线还没捡过的池子里按稀有度权重抽。
 *
 * 种子里带着「剩余池子」的快照，所以同一趟重放、跨重启都掉同一件；池子空了返回 null，
 * 让 8 件上限自然封顶（一趟最多 7 段，正常抽不空，这里只是兜底）。
 *
 * 图鉴规则（评审 C3，手册《出远门》同一句）：
 * - 图鉴不满 `CODEX_FRESH_AT` 件时按老规矩抽——已拥有的件还可能再掉，早期重复是设计的一部分；
 * - 满了以后只从**还没集齐**的件里抽（已见过的件不再重复掉）；
 * - 32 件全齐之后不再掉已见过的件：返回 null，这一趟只带硬币回家。
 *   本路线的新件抽完了但别处还有没集齐的，退回老规矩（还能掉本路线的重复件）。
 */
export function rollSouvenir (routeId, runId, leg, takenIds = [], ownedIds = []) {
  const pool = SOUVENIRS_BY_ROUTE[routeId]
  if (!Array.isArray(pool)) return null
  const taken = new Set(Array.isArray(takenIds) ? takenIds : [])
  const owned = new Set(Array.isArray(ownedIds) ? ownedIds : [])
  if (owned.size >= SOUVENIR_IDS.length) return null
  const openAll = pool.filter((entry) => !taken.has(entry.id))
  if (openAll.length === 0) return null
  const fresh = owned.size >= CODEX_FRESH_AT
    ? openAll.filter((entry) => !owned.has(entry.id))
    : []
  const open = fresh.length > 0 ? fresh : openAll
  const total = open.reduce((sum, entry) => sum + RARITIES[entry.rarity].weight, 0)
  let point = roll01(routeId, runId, 'souvenir', leg, open.map((entry) => entry.id).join(',')) * total
  for (const entry of open) {
    point -= RARITIES[entry.rarity].weight
    if (point < 0) return entry.id
  }
  return open[open.length - 1].id
}

/** 每段回币的基数：round(盘缠 × 3%)——后山是 15。 */
export function baseLegCoins (route) {
  return Math.round(route.fare * route.coinRate)
}

/** 第 `leg` 段的回币：基数 × [1-jitter, 1+jitter]，四舍五入，至少 1 枚。 */
export function legCoins (route, runId, leg) {
  const factor = 1 - route.coinJitter + 2 * route.coinJitter * roll01(runId, 'coin', leg)
  return Math.max(1, Math.round(baseLegCoins(route) * factor))
}

/** 第 `leg` 段的危险度：基础 + 每段累加（显示用；判定在 `wipedOut`）。 */
export function dangerOf (route, leg) {
  return Math.min(0.95, route.dangerBase + route.dangerPerLeg * (leg - 1))
}

/** 危险度的人话档位：低 / 中 / 高。 */
export function dangerLabel (rate) {
  if (rate < 0.08) return '低'
  if (rate < 0.15) return '中'
  return '高'
}

/** 一趟是否还在外面（有 phase 就还没回家）。 */
export function isActiveRun (run) {
  return run !== null && typeof run === 'object' && run.phase !== null && run.phase !== undefined
}

/** 出发：形状定死，`until` 由 now 推。未知路线返回 null。 */
export function startRun ({ routeId, runId, now } = {}) {
  const route = routeOf(routeId)
  if (route === null || typeof runId !== 'string' || runId.length === 0) return null
  if (!Number.isFinite(now)) return null
  return {
    id: runId,
    routeId: route.id,
    phase: 'walking',
    leg: 1,
    totalLegs: legsFor(route, runId),
    until: now + LEG_MS,
    loot: [],
    startedAt: now,
    ended: null,
    endedAt: null,
    reason: null
  }
}

/**
 * 到点推进：走完当前段，掉一笔回币和一件特产。
 *
 * - 没到点、不在 walking、或这一趟已结束 → null（调用方不用写盘）。
 * - 走的是最后一段 → 直接 `ended: 'complete'`，回家。
 * - 否则进决策窗，`until` 再给 20 秒。
 *
 * 返回 `{ run, leg, coins, souvenir }`；`run` 是新对象，不改入参。`souvenir` 是特产 id，
 * 池子空了才会是 null（落盘层按 id 记图鉴）。`ownedIds` 是图鉴已集齐的件，用来避开重复掉落。
 */
export function advanceRun (run, now, ownedIds = []) {
  if (!isActiveRun(run) || run.phase !== 'walking') return null
  if (!Number.isFinite(now) || now < run.until) return null
  const route = routeOf(run.routeId)
  if (route === null) return null
  const coins = legCoins(route, run.id, run.leg)
  const leg = run.leg
  const taken = run.loot.filter((item) => item.kind === 'souvenir').map((item) => item.id)
  const souvenir = rollSouvenir(route.id, run.id, leg, taken, ownedIds)
  const loot = [...run.loot, { kind: 'coin', qty: coins }]
  if (souvenir !== null) loot.push({ kind: 'souvenir', id: souvenir })
  if (leg >= run.totalLegs) {
    return {
      run: { ...run, phase: null, until: null, loot, ended: 'complete', endedAt: now },
      leg,
      coins,
      souvenir
    }
  }
  return {
    run: { ...run, phase: 'deciding', until: now + DECISION_MS, loot },
    leg,
    coins,
    souvenir
  }
}

/**
 * 目标段会不会翻车：从 runId 派生，同一趟同一段永远同一个结果。
 * 已经走过 leg 段，下一段的危险度是 dangerOf(route, leg + 1)。
 */
export function wipedOut (run, leg) {
  const route = routeOf(run?.routeId)
  if (route === null || !Number.isInteger(leg)) return false
  return roll01(run.id, 'danger', leg) < dangerOf(route, leg)
}

/**
 * 「继续走」：只有决策窗合法；段数 +1，重新走 20 秒。
 *
 * 迈步前先掷一次翻车（基础 5% + 每已走段 3%）：翻了就地回家，
 * `leg` 不动、盘缠不退；硬币照给，特产按 114 的规则丢一半。
 */
export function stepRun (run, now) {
  if (!isActiveRun(run) || run.phase !== 'deciding') return null
  if (!Number.isFinite(now)) return null
  const nextLeg = run.leg + 1
  if (wipedOut(run, nextLeg)) {
    return {
      ...run,
      phase: null,
      until: null,
      loot: halveSouvenirs(run.loot, run.id),
      ended: 'failed',
      endedAt: now,
      reason: 'wipeout'
    }
  }
  return { ...run, phase: 'walking', leg: nextLeg, until: now + LEG_MS, reason: null }
}

/**
 * 决策窗超时：没人按「继续」也没按「见好就收」，自己折返。
 * 只有 deciding 且真到点才动，返回新 run；否则 null。
 */
export function expireRun (run, now) {
  if (!isActiveRun(run) || run.phase !== 'deciding') return null
  if (!Number.isFinite(now) || now < run.until) return null
  return { ...run, phase: null, until: null, ended: 'back', endedAt: now, reason: 'timeout' }
}

/**
 * 读档续走：只推进到「下一个节点」，不补算错过的段数、不补掷。
 *
 * - 还没到点 → null（原样留着，到点由 tick 接上）。
 * - walking 到点 → 走完这一段，进决策窗；新窗口从读档时刻起算，
 *   而不是 `until + DECISION_MS`，所以离线再久也只多走一段。
 * - deciding 到点 → 按超时折返，不再掷翻车。
 *
 * 返回 `{ run, coins, souvenir }`（coins 是这一段该入账的钱，souvenir 是这一段掉的特产）；
 * 不推进返回 null。`run.loot` 里已经带着这件特产，落盘层据 `souvenir` 补图鉴。
 */
export function resumeRun (run, now) {
  if (!isActiveRun(run) || !Number.isFinite(now)) return null
  if (now < run.until) return null
  if (run.phase === 'walking') {
    const event = advanceRun(run, now)
    return event === null ? null : { run: event.run, coins: event.coins, souvenir: event.souvenir }
  }
  const home = expireRun(run, now)
  return home === null ? null : { run: home, coins: 0, souvenir: null }
}

/** 「见好就收」：只有决策窗合法；标记折返，回币由 settledOf 算。 */
export function backRun (run, now) {
  if (!isActiveRun(run) || run.phase !== 'deciding') return null
  if (!Number.isFinite(now)) return null
  return { ...run, phase: null, until: null, ended: 'back', endedAt: now }
}

/** 战利品里的硬币总数。 */
export function sumCoins (loot) {
  if (!Array.isArray(loot)) return 0
  let total = 0
  for (const item of loot) {
    if (item !== null && typeof item === 'object' && item.kind === 'coin' && Number.isInteger(item.qty)) {
      total += item.qty
    }
  }
  return total
}

/**
 * 回家结算：盘缠是沉没成本，把已走段数掉出来的硬币与特产带回去。
 * 翻车减半由结束迁移在调用这里之前处理（`halveSouvenirs`）。
 */
export function settledOf (run) {
  const route = isActiveRun(run) || (run !== null && typeof run === 'object') ? routeOf(run.routeId) : null
  const items = Array.isArray(run?.loot)
    ? run.loot.filter((item) => item !== null && typeof item === 'object' && item.kind === 'souvenir' && souvenirOf(item.id) !== null).map((item) => item.id)
    : []
  return {
    runId: run?.id ?? null,
    routeId: run?.routeId ?? null,
    fare: route === null ? 0 : route.fare,
    legs: Number.isInteger(run?.leg) ? run.leg : 0,
    coins: sumCoins(run?.loot),
    items,
    ended: run?.ended ?? null,
    reason: ENDED_REASONS.includes(run?.reason) ? run.reason : null
  }
}

/** 旅行日志的上限（票 116）：最多留 30 篇，超出丢最旧的。 */
export const TRIP_LOG_LIMIT = 30

/**
 * 一篇日志的标题 / 正文上限（票 116）。**公开视图（`farm-open`/`farm-fetch`）与窗口共用这一份**：
 * 以前三处各写一个数（80 / 120 / 120），同一篇日志在农场页和邻居页长短不一。
 */
export const TRIP_LOG_TITLE_MAX = 80
export const TRIP_LOG_BODY_MAX = 400

function routeNameOf (routeId) {
  return ROUTES[routeId]?.name ?? SOUVENIR_ROUTE_NAMES[routeId] ?? ''
}

/** 特产 id 列表 → 名字列表（未知 id 跳过，正文里不写看不懂的编号）。 */
function souvenirNamesOf (ids) {
  return ids.map((id) => souvenirOf(id)?.name).filter((name) => typeof name === 'string' && name !== '')
}

/** 战利品里的特产 id，按出现顺序。 */
function souvenirIdsOf (loot) {
  if (!Array.isArray(loot)) return []
  return loot
    .filter((item) => item !== null && typeof item === 'object' && item.kind === 'souvenir')
    .map((item) => item.id)
    .filter((id) => souvenirOf(id) !== null)
}

/** 翻车丢了哪几件：walking → failed 前后 loot 里特产 id 的差集（重复件按次数算）。 */
function lostSouvenirs (before, after) {
  const remaining = new Map()
  for (const id of souvenirIdsOf(after)) remaining.set(id, (remaining.get(id) ?? 0) + 1)
  const lost = []
  for (const id of souvenirIdsOf(before === null || typeof before !== 'object' ? null : before.loot)) {
    const count = remaining.get(id) ?? 0
    if (count > 0) remaining.set(id, count - 1)
    else lost.push(id)
  }
  return lost
}

/**
 * 一趟的结局 → 日志种类（票 116 的四种模板）。`back` 分「见好就收」与「超时折返」，
 * `failed` 只能是翻车；原因与结局对不上就当作没有日志，不猜。
 */
export function tripLogKind (run) {
  if (run === null || typeof run !== 'object' || Array.isArray(run)) return null
  if (isActiveRun(run) || !ENDED_KINDS.includes(run.ended)) return null
  if (run.ended === 'complete') return run.reason === null || run.reason === undefined ? 'complete' : null
  if (run.ended === 'failed') return run.reason === 'wipeout' ? 'wipeout' : null
  if (run.reason === 'timeout') return 'timeout'
  return run.reason === null || run.reason === undefined ? 'back' : null
}

/**
 * 写一篇旅行日志（票 116）。纯模板拼装，不调用任何模型、不掷骰。
 *
 * 四种结局各一句固定标题：折返 / 翻车 / 走满 / 超时；正文写清路线、段数、捡到的特产、
 * 翻车丢了哪几件，超时补一句「没等到你，自己回来了」。`before` 是这一趟翻车前的 run，
 * 只用来算丢件；不是翻车时给不给都一样。
 */
export function tripLog (run, { at = null, before = null } = {}) {
  const kind = tripLogKind(run)
  if (kind === null) return null
  const route = routeOf(run.routeId)
  if (route === null) return null
  const time = Number.isFinite(at) ? at : run.endedAt
  if (!Number.isFinite(time)) return null
  const legs = Number.isInteger(run.leg) ? run.leg : 0
  if (legs < 1) return null

  const routeName = routeNameOf(route.id)
  const names = souvenirNamesOf(souvenirIdsOf(run.loot))
  const coins = sumCoins(run.loot)
  const head = '交 ' + String(route.fare) + ' 枚盘缠去' + routeName + '，'
  const lootText = names.length === 0 ? '路上没捡到特产' : '路上捡到' + names.join('、')
  const coinText = '，带回 ' + String(coins) + ' 枚硬币。'

  let middle = '走了 ' + String(legs) + ' 段'
  let tail = ''
  let title = ''
  if (kind === 'complete') {
    title = '走满' + routeName + '，' + String(legs) + ' 段全程'
    middle = String(legs) + ' 段全程走完'
  } else if (kind === 'back') {
    title = '从' + routeName + '折返，走了 ' + String(legs) + ' 段'
    middle = '走了 ' + String(legs) + ' 段就折返'
  } else if (kind === 'wipeout') {
    title = '在' + routeName + '翻车，只走了 ' + String(legs) + ' 段'
    middle = '走了 ' + String(legs) + ' 段就翻了车'
    const lost = souvenirNamesOf(lostSouvenirs(before, run.loot))
    tail = lost.length === 0 ? '翻车时特产一件没丢。' : '翻车时丢了' + lost.join('、') + '。'
  } else {
    title = '在' + routeName + '超时，它自己回来了'
    tail = String(Math.round(DECISION_MS / 1000)) + ' 秒没等到你，自己回来了。'
  }

  return {
    at: time,
    routeId: route.id,
    legs,
    title,
    body: head + middle + '，' + lootText + coinText + tail,
    ended: run.ended,
    reason: ENDED_REASONS.includes(run.reason) ? run.reason : null
  }
}

/** 新的一篇放最前；超过 30 篇丢最旧的。 */
export function appendTripLog (logs, entry) {
  const list = Array.isArray(logs) ? logs : []
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return list.slice(0, TRIP_LOG_LIMIT)
  }
  return [entry, ...list].slice(0, TRIP_LOG_LIMIT)
}

/** 读档时的日志清洗：只认形状对的篇目，坏数据不挡启动。 */
function normalizeTripLog (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const route = routeOf(raw.routeId)
  if (route === null) return null
  if (!Number.isFinite(raw.at)) return null
  if (!Number.isInteger(raw.legs) || raw.legs < 1) return null
  if (!ENDED_KINDS.includes(raw.ended)) return null
  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  const title = text(raw.title, TRIP_LOG_TITLE_MAX)
  const body = text(raw.body, TRIP_LOG_BODY_MAX)
  if (title === '' || body === '') return null
  return {
    at: raw.at,
    routeId: route.id,
    legs: raw.legs,
    title,
    body,
    ended: raw.ended,
    reason: ENDED_REASONS.includes(raw.reason) ? raw.reason : null
  }
}

/** 日志列表：新在前，最多 30 篇。 */
export function normalizeTripLogs (raw) {
  if (!Array.isArray(raw)) return []
  const logs = []
  for (const entry of raw) {
    if (logs.length >= TRIP_LOG_LIMIT) break
    const log = normalizeTripLog(entry)
    if (log !== null) logs.push(log)
  }
  return logs
}

/**
 * 图鉴记一笔：只记第一次见到的时刻，重复获得不覆盖。
 *
 * 纯函数，返回新的 codex 对象；未知 id 或坏时间原样返回。落盘层负责传 `now`。
 */
export function recordSouvenir (codex, id, now) {
  const base = codex !== null && typeof codex === 'object' && !Array.isArray(codex) ? codex : {}
  if (souvenirOf(id) === null || !Number.isFinite(now)) return base
  if (Object.prototype.hasOwnProperty.call(base, id)) return base
  return { ...base, [id]: now }
}

/**
 * 窗口直接渲染的 32 格图鉴视图：固定的目录顺序，已获得的亮显名字，没获得的显示 `???`。
 * `art` 为空或坏路径时窗口回退 `emoji`。
 */
export function codexView (codex) {
  const seen = codex !== null && typeof codex === 'object' && !Array.isArray(codex) ? codex : {}
  const slots = SOUVENIR_IDS.map((id) => {
    const entry = SOUVENIRS[id]
    const firstSeenAt = Number.isFinite(seen[id]) ? seen[id] : null
    const owned = firstSeenAt !== null
    return {
      id,
      name: entry.name,
      emoji: entry.emoji,
      rarity: entry.rarity,
      rarityLabel: RARITIES[entry.rarity].label,
      routeId: entry.routeId,
      routeName: ROUTES[entry.routeId]?.name ?? SOUVENIR_ROUTE_NAMES[entry.routeId] ?? entry.routeId,
      owned,
      firstSeenAt,
      art: entry.art,
      label: owned ? entry.name : '???'
    }
  })
  return {
    total: slots.length,
    owned: slots.filter((slot) => slot.owned).length,
    slots
  }
}

/**
 * 翻车时特产随机丢一半（向下取整），硬币原样保留。翻车分支只调这个纯函数，
 * 不自己实现减半。`seed` 用 runId，保证同一趟重放丢的是同样那几件。
 */
export function halveSouvenirs (loot, seed = '') {
  if (!Array.isArray(loot)) return []
  const indexes = []
  loot.forEach((item, index) => {
    if (item !== null && typeof item === 'object' && item.kind === 'souvenir' && souvenirOf(item.id) !== null) {
      indexes.push(index)
    }
  })
  // 向下取整：1 件时丢 0 件——只有一件还给人留一件，算手气好（手册《出远门》翻车一节照这个说法）。
  const dropCount = Math.floor(indexes.length / 2)
  const dropped = new Set()
  if (dropCount > 0) {
    const ranked = indexes
      .map((index, ordinal) => ({ index, key: roll01(seed, 'halve', ordinal, loot[index].id) }))
      .sort((left, right) => left.key - right.key || left.index - right.index)
    for (const entry of ranked.slice(0, dropCount)) dropped.add(entry.index)
  }
  return loot
    .filter((item, index) => !dropped.has(index))
    .map((item) => (item !== null && typeof item === 'object' ? { ...item } : item))
}

/**
 * 读档时的形状校验：坏 run 直接丢（当作没出门），不把半个状态带进内存。
 * 允许已结束的趟留在文件里，窗口重开时还能看见上一趟的结果。
 */
export function normalizeRun (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const route = routeOf(raw.routeId)
  if (route === null) return null
  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 128) return null
  if (!Number.isInteger(raw.totalLegs)) return null
  if (raw.totalLegs < route.minLegs || raw.totalLegs > route.maxLegs) return null
  if (!Number.isInteger(raw.leg) || raw.leg < 1 || raw.leg > raw.totalLegs) return null
  if (!Number.isFinite(raw.startedAt)) return null

  const walking = raw.phase === 'walking'
  const deciding = raw.phase === 'deciding'
  const ended = ENDED_KINDS.includes(raw.ended) ? raw.ended : null
  if (walking || deciding) {
    if (ended !== null) return null
    if (!Number.isFinite(raw.until)) return null
  } else if (raw.phase === null || raw.phase === undefined) {
    if (ended === null) return null
  } else {
    return null
  }

  const loot = []
  const seenSouvenirs = new Set()
  if (!Array.isArray(raw.loot)) return null
  for (const item of raw.loot) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    if (item.kind === 'coin') {
      if (!Number.isInteger(item.qty) || item.qty < 1) return null
      loot.push({ kind: 'coin', qty: item.qty })
      continue
    }
    if (item.kind === 'souvenir') {
      const souvenir = souvenirOf(item.id)
      if (souvenir === null || souvenir.routeId !== route.id) return null
      if (seenSouvenirs.has(item.id)) continue
      seenSouvenirs.add(item.id)
      loot.push({ kind: 'souvenir', id: item.id })
      continue
    }
    return null
  }

  const active = walking || deciding
  return {
    id: raw.id,
    routeId: route.id,
    phase: active ? raw.phase : null,
    leg: raw.leg,
    totalLegs: raw.totalLegs,
    until: active ? raw.until : null,
    loot,
    startedAt: raw.startedAt,
    ended: active ? null : ended,
    endedAt: active ? null : (Number.isFinite(raw.endedAt) ? raw.endedAt : null),
    reason: active ? null : (ENDED_REASONS.includes(raw.reason) ? raw.reason : null)
  }
}
