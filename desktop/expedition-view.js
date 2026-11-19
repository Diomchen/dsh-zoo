/**
 * 出远门小窗的纯展示函数（票 112）。
 *
 * 这里不读盘、不看时钟、不算钱：宿主已经把「走到第几段、还有多少毫秒、回了几枚」
 * 算好放进 view。窗口只负责把这些数字变成人话，所以可以单独用 Node 测。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.dshZooExpeditionView = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  const ACTIVE_PHASES = ['walking', 'deciding']

  function isActiveRun (run) {
    return run !== null && typeof run === 'object' && ACTIVE_PHASES.includes(run.phase)
  }

  function num (value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  /** 硬币只画整数；负数/NaN 当 0。 */
  function formatCoins (value) {
    const coins = Math.max(0, Math.round(num(value)))
    return String(coins)
  }

  /** 毫秒 → `0:20`。向上取整：还剩 1ms 也画 0:01，不画 0:00 骗人。 */
  function formatClock (ms) {
    const total = Math.max(0, Math.ceil(num(ms) / 1000))
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return String(minutes) + ':' + String(seconds).padStart(2, '0')
  }

  /** 这一段还剩多少毫秒；没有 until（走满/结算）就是 0。 */
  function remainingMs (run, now) {
    if (run === null || typeof run !== 'object') return 0
    const until = num(run.until)
    if (until <= 0) return 0
    return Math.max(0, until - num(now))
  }

  function phaseLabel (run) {
    if (run === null || typeof run !== 'object') return '还没出门'
    if (run.phase === 'walking') return '正在走路'
    if (run.phase === 'deciding') return '想想要不要继续'
    if (run.ended === 'complete') return '走满了，已经回家'
    if (run.ended === 'back') return '见好就收，已经回家'
    if (run.ended === 'failed') return '翻车了，已经回家'
    return '还没出门'
  }

  function progressText (run) {
    if (run === null || typeof run !== 'object') return ''
    return '已走 ' + String(num(run.leg)) + ' / ' + String(num(run.totalLegs)) + ' 段'
  }

  /**
   * 决策窗这里说的是「下一段」的危险度；走路时说的是当前段。
   * 买了提灯宿主才会给 `dangerPercent`（票 118）：有它就画精确到个位的百分数，
   * 没有就画低 / 中 / 高——窗口自己不算概率。
   */
  function dangerText (run) {
    if (run === null || typeof run !== 'object') return ''
    if (typeof run.dangerPercent === 'number' && Number.isFinite(run.dangerPercent)) {
      return '危险度 ' + String(Math.round(run.dangerPercent)) + '%'
    }
    if (typeof run.danger === 'string' && run.danger !== '') return '危险度 ' + run.danger
    return ''
  }

  /** 价钱带千分位：10000 → 10,000（仍是整数，不引小数）。 */
  function formatPrice (value) {
    return String(Math.max(0, Math.round(num(value)))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  /**
   * 提灯那一行（票 118）：买没买、多少钱、按钮写什么，全按宿主给的视图说。
   * 价钱缺席（老宿主）就不写「0 枚」，只写「买提灯」。
   */
  function lanternOffer (state) {
    const view = state !== null && typeof state === 'object' ? state : {}
    const upgrades = view.upgrades !== null && typeof view.upgrades === 'object' ? view.upgrades : {}
    const owned = upgrades.lantern === true
    const hasPrice = typeof view.lanternPrice === 'number' && Number.isFinite(view.lanternPrice)
    return {
      owned,
      hint: owned
        ? '提灯已买：决策窗显示下一段精确到个位的危险百分比。'
        : '还没买提灯：决策窗只显示低 / 中 / 高，看不出下一段到底多险。',
      label: owned ? '提灯已买' : hasPrice ? '买提灯（' + formatPrice(view.lanternPrice) + ' 枚）' : '买提灯'
    }
  }

  /** 这一趟已经捡到的硬币总数（每段到点就进农场，这里只用于结算文案）。 */
  function sumLoot (run) {
    if (run === null || typeof run !== 'object' || !Array.isArray(run.loot)) return 0
    let total = 0
    for (const item of run.loot) {
      if (item === null || typeof item !== 'object') continue
      total += Math.max(0, Math.round(num(item.qty)))
    }
    return total
  }

  /** 结算那句：只回已经走过的段数对应的钱，盘缠不退。 */
  function settleText (run) {
    if (run === null || typeof run !== 'object') return ''
    if (run.ended === null || run.ended === undefined) return ''
    const coins = formatCoins(sumLoot(run))
    if (run.ended === 'complete') return '走满全程，带回 ' + coins + ' 枚硬币'
    if (run.ended === 'back') return '见好就收，带回 ' + coins + ' 枚硬币'
    if (run.ended === 'failed') return '翻车，带回 ' + coins + ' 枚硬币'
    return ''
  }

  /** 主按钮：走路中只能等；决策窗才能继续；结算后可以再开一趟。 */
  function primaryLabel (run) {
    if (isActiveRun(run)) return run.phase === 'deciding' ? '继续走一段' : '走路中…'
    return '再走一趟'
  }

  function canContinue (run) {
    return isActiveRun(run) && run.phase === 'deciding'
  }

  function canBack (run) {
    return isActiveRun(run) && run.phase === 'deciding'
  }

  /**
   * 能不能出发：没有进行中的趟、路线已解锁、硬币够盘缠。
   * `unlocked` 缺省视为已解锁（112 的老视图没有这个字段），显式 false 才是灰卡。
   */
  function canStart (view, route) {
    if (isActiveRun(view === null ? null : view.run)) return false
    if (route !== null && route !== undefined && route.unlocked === false) return false
    const fare = route === null || route === undefined ? 0 : num(route.fare)
    const coins = num(view === null ? 0 : view.coins)
    return fare > 0 && coins >= fare
  }

  /** 一盘路线的摘要：盘缠、段数、每段回币。窗口和灰卡都画这一行。 */
  function routeHint (route) {
    if (route === null || typeof route !== 'object') return ''
    const base = num(route.coinBase)
    return '盘缠 ' + formatCoins(route.fare) +
      ' · ' + String(num(route.minLegs)) + '–' + String(num(route.maxLegs)) + ' 段 · 每段回 ' +
      formatCoins(Math.round(base * 0.75)) + '–' + formatCoins(Math.round(base * 1.25)) + ' 枚'
  }

  /**
   * home 的路线卡（票 117）：锁着的卡带解锁条件与进度，但盘缠/段数照旧写出来，
   * 好让玩家知道解锁后能走多远。窗口只照着画，不再自己算条件。
   */
  function routeCards (view) {
    const routes = view !== null && typeof view === 'object' && Array.isArray(view.routes) ? view.routes : []
    return routes
      .filter((route) => route !== null && typeof route === 'object' && typeof route.id === 'string' && route.id !== '')
      .map((route) => {
        const locked = route.unlocked === false
        return {
          id: route.id,
          name: typeof route.name === 'string' ? route.name : route.id,
          locked,
          hint: routeHint(route),
          requirement: locked && typeof route.requirement === 'string' ? route.requirement : '',
          progress: locked && typeof route.progress === 'string' ? route.progress : '',
          canStart: canStart(view, route)
        }
      })
  }

  /** 图鉴 32 格：宿主没送或送坏了就当全空，窗口仍然画 32 个灰格。 */
  function codexSlots (view) {
    if (view === null || typeof view !== 'object' || !Array.isArray(view.slots)) return []
    return view.slots.filter((slot) => slot !== null && typeof slot === 'object')
  }

  /** 「已获得 / 全部」，用于图鉴页标题与 tab 角标。视图还没到时也画 0/32。 */
  function codexProgress (view) {
    const slots = codexSlots(view)
    const total = slots.length === 0 ? 32 : slots.length
    const owned = slots.filter((slot) => slot.owned === true).length
    return String(owned) + '/' + String(total)
  }

  /** 按路线分组，保持宿主给的顺序（后山 → 废矿 → 老铁路 → 雾岭）。 */
  function codexGroups (view) {
    const groups = []
    const byRoute = new Map()
    for (const slot of codexSlots(view)) {
      const routeId = typeof slot.routeId === 'string' && slot.routeId !== '' ? slot.routeId : 'unknown'
      let group = byRoute.get(routeId)
      if (group === undefined) {
        group = {
          routeId,
          routeName: typeof slot.routeName === 'string' && slot.routeName !== '' ? slot.routeName : routeId,
          slots: []
        }
        byRoute.set(routeId, group)
        groups.push(group)
      }
      group.slots.push(slot)
    }
    return groups
  }

  /**
   * 一格画什么：有合法 SVG 就用图，缺图/坏路径回退 emoji。
   * 返回描述对象而不是 DOM，窗口与测试各自决定怎么落地。
   */
  function slotEmblem (slot) {
    const art = slot !== null && typeof slot === 'object' && typeof slot.art === 'string' ? slot.art.trim() : ''
    if (/^souvenirs\/[a-z0-9-]+\.svg$/.test(art)) return { kind: 'art', src: art }
    const emoji = slot !== null && typeof slot === 'object' && typeof slot.emoji === 'string' ? slot.emoji.trim() : ''
    return { kind: 'emoji', text: emoji === '' ? '❔' : emoji }
  }

  /** 结算页列出这一趟捡到的特产名字（图鉴里没有的 id 原样显示）。 */
  function souvenirNames (run, view) {
    if (run === null || typeof run !== 'object' || !Array.isArray(run.loot)) return []
    const names = new Map()
    for (const slot of codexSlots(view)) {
      if (typeof slot.id === 'string' && typeof slot.name === 'string') names.set(slot.id, slot.name)
    }
    return run.loot
      .filter((item) => item !== null && typeof item === 'object' && item.kind === 'souvenir' && typeof item.id === 'string')
      .map((item) => names.get(item.id) || item.id)
  }

  /**
   * 陈列架（票 115）：宿主给的是 `{slots, items, ...}`，`items[i]` 对第 i+1 格。
   * 窗口按 32 格的总宽度画，锁着的格子也画出来并标上开格价。
   */
  const SHELF_MAX_SLOTS = 32
  const SHELF_SLOT_PRICE = 5000

  function shelfLayout (shelf) {
    const raw = shelf !== null && typeof shelf === 'object' ? shelf : {}
    const maxSlots = Math.min(
      SHELF_MAX_SLOTS,
      Math.max(8, Math.round(num(raw.maxSlots) || SHELF_MAX_SLOTS))
    )
    const slots = Math.min(maxSlots, Math.max(8, Math.round(num(raw.slots) || 8)))
    const price = Math.max(0, Math.round(num(raw.slotPrice) || SHELF_SLOT_PRICE))
    return { slots, maxSlots, price, items: Array.isArray(raw.items) ? raw.items : [] }
  }

  /** 一格一个描述对象；特产的显示名与图案从图鉴视图里取，取不到就原样显示 id。 */
  function shelfCells (shelf, codex) {
    const layout = shelfLayout(shelf)
    const byId = new Map()
    for (const slot of codexSlots(codex)) {
      if (typeof slot.id === 'string') byId.set(slot.id, slot)
    }
    const cells = []
    for (let index = 0; index < layout.maxSlots; index += 1) {
      const locked = index >= layout.slots
      const raw = locked ? null : layout.items[index]
      const itemId = typeof raw === 'string' && raw !== '' ? raw : null
      const meta = itemId === null ? null : byId.get(itemId)
      cells.push({
        slot: index + 1,
        locked,
        price: locked ? layout.price : 0,
        empty: itemId === null,
        itemId,
        label: meta === null ? (itemId === null ? '' : itemId) : meta.name,
        emblem: meta === null ? { kind: 'emoji', text: '❔' } : slotEmblem(meta)
      })
    }
    return cells
  }

  function shelfProgress (shelf) {
    const layout = shelfLayout(shelf)
    return '已开 ' + String(layout.slots) + ' / ' + String(layout.maxSlots) + ' 格'
  }

  /** 已获得、但还没上架的特产：给「摆进空格」的选择器用。 */
  function placeableSouvenirs (shelf, codex) {
    const layout = shelfLayout(shelf)
    const placed = new Set()
    for (const entry of layout.items) {
      if (typeof entry === 'string' && entry !== '') placed.add(entry)
    }
    return codexSlots(codex).filter((slot) =>
      slot.owned === true && typeof slot.id === 'string' && slot.id !== '' && !placed.has(slot.id)
    )
  }

  /**
   * 只有「下一格」能点开，且硬币要够。后排的锁格只显示价格，点了也不该扣钱，
   * 免得窗口替宿主把顺序校验又实现一遍。
   */
  function canUnlock (shelf, slot, coins) {
    const layout = shelfLayout(shelf)
    return Number.isInteger(slot) && slot === layout.slots + 1 && num(coins) >= layout.price
  }

  return {
    ACTIVE_PHASES,
    SHELF_MAX_SLOTS,
    SHELF_SLOT_PRICE,
    isActiveRun,
    formatCoins,
    formatClock,
    remainingMs,
    phaseLabel,
    progressText,
    dangerText,
    lanternOffer,
    sumLoot,
    settleText,
    primaryLabel,
    canContinue,
    canBack,
    canStart,
    routeHint,
    routeCards,
    codexSlots,
    codexProgress,
    codexGroups,
    slotEmblem,
    souvenirNames,
    shelfCells,
    shelfProgress,
    canUnlock,
    placeableSouvenirs
  }
})
