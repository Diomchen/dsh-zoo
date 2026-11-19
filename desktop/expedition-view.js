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

  /** 决策窗这里说的是「下一段」的危险度；走路时说的是当前段。 */
  function dangerText (run) {
    if (run === null || typeof run !== 'object') return ''
    if (typeof run.danger === 'string' && run.danger !== '') return '危险度 ' + run.danger
    return ''
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

  /** 能不能出发：没有进行中的趟、硬币够盘缠。 */
  function canStart (view, route) {
    if (isActiveRun(view === null ? null : view.run)) return false
    const fare = route === null || route === undefined ? 0 : num(route.fare)
    const coins = num(view === null ? 0 : view.coins)
    return fare > 0 && coins >= fare
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

  return {
    ACTIVE_PHASES,
    isActiveRun,
    formatCoins,
    formatClock,
    remainingMs,
    phaseLabel,
    progressText,
    dangerText,
    sumLoot,
    settleText,
    primaryLabel,
    canContinue,
    canBack,
    canStart,
    codexSlots,
    codexProgress,
    codexGroups,
    slotEmblem,
    souvenirNames
  }
})
