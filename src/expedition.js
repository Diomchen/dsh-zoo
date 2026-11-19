/**
 * 「出远门」的规则层（票 112）。
 *
 * 这里只有纯函数：路线表、段数、每段回币、危险度、状态迁移与结算。不读盘、不看系统时钟，
 * `now` 与随机都由调用方传进来——段数和抖动从 `runId` 派生，所以同一趟在重启后走的是同一条路。
 *
 * 112 只开后山一条路线；另外三条、翻车、陈列架是 113 及以后的事。114 先把四条路线的
 * 32 件特产与图鉴放在这里：掉落只由 `routeId + runId + 段号 + 已捡清单` 决定，翻车减半
 * 也是纯函数，真正的翻车判定留给 113。
 */

/** 走一段的时间：20 秒（手册《出远门》的节奏）。 */
export const LEG_MS = 20000
/** 每段走完后的决策窗：20 秒。112 里到点不会自动折返，超时留给 113。 */
export const DECISION_MS = 20000

/**
 * 路线表。盘缠（fare）入场即扣、永不退；`coinRate` 是每段回币占盘缠的比例，
 * `coinJitter` 是乘在这个比例上的 ± 抖动。
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
    dangerPerLeg: 0.03
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
 * 后山以外的三条路线 114 只建目录，路线本身由 113 开。
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

/** 每条路线可掉的特产；没开的路线的目录也在这里，窗口图鉴照样显示。 */
export const SOUVENIRS_BY_ROUTE = Object.freeze({
  backhill: Object.freeze(SOUVENIR_IDS.filter((id) => SOUVENIRS[id].routeId === 'backhill').map((id) => SOUVENIRS[id])),
  mine: Object.freeze(SOUVENIR_IDS.filter((id) => SOUVENIRS[id].routeId === 'mine').map((id) => SOUVENIRS[id])),
  railway: Object.freeze(SOUVENIR_IDS.filter((id) => SOUVENIRS[id].routeId === 'railway').map((id) => SOUVENIRS[id])),
  mistridge: Object.freeze(SOUVENIR_IDS.filter((id) => SOUVENIRS[id].routeId === 'mistridge').map((id) => SOUVENIRS[id]))
})

/** 图鉴的路线名：113 开路线之前 ROUTES 里还没有它们，这里先给窗口一份稳定的名字。 */
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

/** 112 只认「折返 / 走满」；`failed` 是 113 的翻车，读档时先容下。 */
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
  'no-route': '没有这条路线。',
  'not-walking': '这一趟现在不用做决定。',
  starting: '出远门还没准备好，稍等一下。',
  'save-failed': '存档写不进去，这趟没能出发。',
  'desktop-off': '桌面层没在运行，出远门的窗口开不了。'
})

/** 路线对象；未知 id 返回 null（不抛，读档时坏数据只降级）。 */
export function routeOf (routeId) {
  if (typeof routeId !== 'string') return null
  return Object.prototype.hasOwnProperty.call(ROUTES, routeId) ? ROUTES[routeId] : null
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
 */
export function rollSouvenir (routeId, runId, leg, takenIds = []) {
  const pool = SOUVENIRS_BY_ROUTE[routeId]
  if (!Array.isArray(pool)) return null
  const taken = new Set(Array.isArray(takenIds) ? takenIds : [])
  const open = pool.filter((entry) => !taken.has(entry.id))
  if (open.length === 0) return null
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

/** 第 `leg` 段的危险度：基础 + 每段累加（只用于显示，翻车在 113）。 */
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
 * 池子空了才会是 null（落盘层按 id 记图鉴）。
 */
export function advanceRun (run, now) {
  if (!isActiveRun(run) || run.phase !== 'walking') return null
  if (!Number.isFinite(now) || now < run.until) return null
  const route = routeOf(run.routeId)
  if (route === null) return null
  const coins = legCoins(route, run.id, run.leg)
  const leg = run.leg
  const taken = run.loot.filter((item) => item.kind === 'souvenir').map((item) => item.id)
  const souvenir = rollSouvenir(route.id, run.id, leg, taken)
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
 * 翻车减半由 113 在调用这里之前处理（`halveSouvenirs`）。
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
 * 翻车时特产随机丢一半（向下取整），硬币原样保留。113 的翻车分支只调这个纯函数，
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
