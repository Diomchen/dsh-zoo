/**
 * 农场小窗的纯视图模型（ticket 47）。
 *
 * 这层只做「farm view → 卡片/标题/批量目标」的纯计算，不碰 window、document、
 * IPC，也不改任何数据。渲染页把它当普通 script 加载（`window.dshZooFarmView`），
 * Node 测试用 `require` 同一份文件；两边跑的是同一段逻辑，DOM 由
 * `createPlotCard(document, card)` 用传进来的 document 建，测试可以塞一个最小替身。
 *
 * 为什么单独一层：地块数量不能写死 4。标题计数、卡片标签、网格都从
 * `farm.plots` 推；未来宿主发 20 块，这里就产出 20 张卡，不用改窗口代码。
 */
(function (root, factory) {
  'use strict'
  const api = factory()
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api
  if (root !== null && typeof root === 'object') root.dshZooFarmView = api
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict'

  const MINUTE_MS = 60 * 1000
  const HOUR_MS = 60 * MINUTE_MS
  /**
   * 作物显示表。数值与宿主 `src/farm-rules.js` 的 CROPS 同源（ticket 45 的 drift
   * 测试逐项比对）；这里只用于显示生长时长/产量和进度条，从不参与结算。
   *
   * 票 58：外观不再是一个 emoji，而是包内自带的 SVG（`desktop/crops/<id>.svg`）。
   * `emoji` 留着当兜底——旧版本邻居传来的、或将来加了作物却忘了放图的 id 走这一支，
   * 至少不会在卡片上留一个空格子。路径是相对 `farm.html` 的，窗口用
   * `file://` 加载，CSP 里放行了 `img-src 'self'`。
   */
  const BUILTIN_META = Object.freeze({
    pea: { name: '豌豆', emoji: '🫛', art: 'crops/pea.svg', seedPrice: 6, base: 4, growMs: 25 * MINUTE_MS, yield: 3, season: 'spring' },
    tomato: { name: '小番茄', emoji: '🍅', art: 'crops/tomato.svg', seedPrice: 6, base: 5, growMs: 30 * MINUTE_MS, yield: 3 },
    strawberry: { name: '草莓', emoji: '🍓', art: 'crops/strawberry.svg', seedPrice: 9, base: 7, growMs: 45 * MINUTE_MS, yield: 4 },
    radish: { name: '白萝卜', emoji: '🥬', art: 'crops/radish.svg', seedPrice: 10, base: 4, growMs: 90 * MINUTE_MS, yield: 6, season: 'winter' },
    carrot: { name: '胡萝卜', emoji: '🥕', art: 'crops/carrot.svg', seedPrice: 14, base: 6, growMs: 2 * HOUR_MS, yield: 5 },
    rice: { name: '稻米', emoji: '🌾', art: 'crops/rice.svg', seedPrice: 18, base: 4, growMs: 3 * HOUR_MS, yield: 10, season: 'autumn' },
    corn: { name: '玉米', emoji: '🌽', art: 'crops/corn.svg', seedPrice: 22, base: 9, growMs: 4 * HOUR_MS, yield: 6 },
    watermelon: { name: '西瓜', emoji: '🍉', art: 'crops/watermelon.svg', seedPrice: 30, base: 10, growMs: 6 * HOUR_MS, yield: 8, season: 'summer' },
    pumpkin: { name: '南瓜', emoji: '🎃', art: 'crops/pumpkin.svg', seedPrice: 36, base: 30, growMs: 8 * HOUR_MS, yield: 3 },
    grape: { name: '葡萄', emoji: '🍇', art: 'crops/grape.svg', seedPrice: 52, base: 24, growMs: 12 * HOUR_MS, yield: 5 }
  })
  /** 没有图的作物（`crops.json` 里手写的、还没画图的）用这个当兜底。 */
  const FALLBACK_EMOJI = '🌱'

  /**
   * 当前窗口认的作物表（票 59）。
   *
   * 默认是内置六种；宿主每一包都会带 `crops`，`setCrops()` 用它整份换掉。
   * 数值一律以宿主下发为准，这一层只画；内置条目继续用包里的 SVG，
   * 宿主认识但包里没图的条目退回 emoji（将来图会随目录一起下发）。
   */
  const CROP_META = {}
  const CROP_IDS = []

  function fillMeta (list) {
    for (const id of Object.keys(CROP_META)) delete CROP_META[id]
    CROP_IDS.length = 0
    const source = Array.isArray(list) && list.length > 0 ? list : null
    if (source === null) {
      for (const id of Object.keys(BUILTIN_META)) {
        CROP_META[id] = BUILTIN_META[id]
        CROP_IDS.push(id)
      }
      return
    }
    for (const entry of source) {
      if (entry === null || typeof entry !== 'object') continue
      const id = typeof entry.id === 'string' ? entry.id : ''
      const name = typeof entry.name === 'string' ? entry.name : ''
      if (id === '' || name === '') continue
      const builtin = Object.prototype.hasOwnProperty.call(BUILTIN_META, id) ? BUILTIN_META[id] : null
      CROP_META[id] = {
        name,
        emoji: builtin === null ? FALLBACK_EMOJI : builtin.emoji,
        // 宿主给了图就用宿主的（自定义作物按内容哈希寻址）；没给就回落到包里的 SVG。
        art: typeof entry.art === 'string' && entry.art !== ''
          ? entry.art
          : builtin === null ? '' : builtin.art,
        seedPrice: Number(entry.seedPrice) || 0,
        base: Number(entry.base) || 0,
        growMs: Number(entry.growMs) || 0,
        yield: Number(entry.yield) || 0,
        // 票 64：宿主给四季作物带 season；旧六种和自定义作物没有。
        season: typeof entry.season === 'string' && entry.season !== ''
          ? entry.season
          : builtin === null ? null : (builtin.season ?? null)
      }
      CROP_IDS.push(id)
    }
    // 宿主没发目录、或者发了个空数组：退回内置六种，别把窗口画成空的。
    if (CROP_IDS.length === 0) {
      fillMeta(null)
      return
    }
    CROP_IDS.sort((left, right) => {
      if (CROP_META[left].growMs !== CROP_META[right].growMs) return CROP_META[left].growMs - CROP_META[right].growMs
      return left < right ? -1 : left > right ? 1 : 0
    })
  }

  fillMeta(null)

  /** 宿主下发整份目录时调用（每包一次）；传 null/空数组 = 回到内置六种。 */
  function setCrops (list) {
    fillMeta(list)
  }


  const WATER_COST = 1
  const FERTILIZE_COST = 5
  /** 解锁后至少留一颗最便宜种子的钱；与宿主 PLOT_UNLOCK_RESERVE 同源（drift 测试会读）。 */
  const UNLOCK_RESERVE = 6
  const STAGE_TEXT = { empty: '空地', growing: '生长中', mature: '可收割', withered: '枯萎了' }

  function cropMeta (cropId) {
    return Object.prototype.hasOwnProperty.call(CROP_META, cropId) ? CROP_META[cropId] : null
  }

  /**
   * 作物外观：有图就给 `<img>`，没图（空地、未知作物、旧数据）退回 emoji 文本。
   *
   * 外面永远套一个带 `className` 的 span：现有的字号/阶段滤镜（生长中灰掉、成熟轻弹）
   * 都是挂在这个盒子上的，换成图片不用改 CSS 选择器；图自己按 `1.2em` 缩放，
   * 19px 的种子行/行情行和 34px 的地块卡图框都不用各写一套。
   */
  function cropEmblem (document, spec, className) {
    const span = document.createElement('span')
    span.className = className
    span.setAttribute('aria-hidden', 'true')
    const art = spec !== null && typeof spec === 'object' ? spec.art : ''
    if (typeof art === 'string' && art !== '') {
      const img = document.createElement('img')
      img.className = 'crop-art-img'
      img.setAttribute('src', art)
      // 装饰图：名字在旁边的 <strong> 里已经念过一遍了，读屏不用重复。
      img.setAttribute('alt', '')
      img.setAttribute('draggable', 'false')
      span.appendChild(img)
    } else {
      span.textContent = spec !== null && typeof spec === 'object' && typeof spec.emoji === 'string'
        ? spec.emoji
        : ''
    }
    return span
  }

  function clamp (value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  /** 倒计时文案：一处实现，卡片、弹窗、访客页共用。 */
  function formatRemaining (ms) {
    const total = Math.max(0, Math.ceil(Number(ms) / 1000))
    if (total <= 0) return '马上就好'
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    if (hours > 0) return minutes > 0 ? hours + ' 小时 ' + minutes + ' 分' : hours + ' 小时'
    if (minutes > 0) return seconds > 0 ? minutes + ' 分 ' + seconds + ' 秒' : minutes + ' 分'
    return seconds + ' 秒'
  }

  /** 播种弹窗里的「生长 30 分钟 / 2 小时」。 */
  function formatGrowTime (ms) {
    const total = Math.max(0, Math.ceil(Number(ms) / MINUTE_MS))
    if (total <= 0) return '—'
    const hours = Math.floor(total / 60)
    const minutes = total % 60
    if (hours <= 0) return minutes + ' 分钟'
    return minutes === 0 ? hours + ' 小时' : hours + ' 小时 ' + minutes + ' 分'
  }

  /**
   * 地块序号只从 `plot.id` 的尾号推（p1 → 1），推不出来才退回 1-based 序号。
   * 不维护 PLOT_LABEL 表：宿主多发一块地，标签自动跟着走。
   */
  function plotNumber (plot, index) {
    const id = plot !== null && typeof plot === 'object' && typeof plot.id === 'string' ? plot.id : ''
    const match = /(\d+)$/.exec(id)
    if (match !== null) {
      const value = Number(match[1])
      if (Number.isFinite(value) && value > 0) return value
    }
    return Math.max(1, Number(index) + 1)
  }

  function plotLabel (plot, index) {
    return '地块 ' + plotNumber(plot, index)
  }

  /** 标题下的「X/Y 已种植」：Y 永远等于 farm.plots.length，不写死 4。 */
  /**
   * 票 56：邻居切换器的形状。邻居少就铺一排圆片（一眼全见），多了就收进
   * 「当前视图」胶囊后面的列表——420px 宽的窗里，五颗圆片就开始挤。
   *
   * 排序按**能偷的熟地数**降序：打开这扇窗的目的九成是"去谁家拿点什么"。
   * 老版本邻居不隐藏，标 `old` 灰掉——隐藏会让人以为对方掉线。
   */
  function neighborSwitch (neighbors, currentDeviceId = null, chipsMax = 3) {
    const items = []
    for (const candidate of Array.isArray(neighbors) ? neighbors : []) {
      if (candidate === null || typeof candidate !== 'object') continue
      const deviceId = typeof candidate.deviceId === 'string' ? candidate.deviceId : ''
      if (deviceId === '') continue
      const ripe = Number(candidate.ripePlots)
      const guard = Number(candidate.guard)
      const old = candidate.old === true
      items.push({
        deviceId,
        label: typeof candidate.nickname === 'string' && candidate.nickname !== '' ? candidate.nickname : '邻居',
        ripePlots: Number.isFinite(ripe) ? Math.max(0, Math.floor(ripe)) : 0,
        guard: Number.isFinite(guard) ? Math.min(1, Math.max(0, guard)) : 0,
        old,
        active: deviceId === currentDeviceId,
        sub: old
          ? '旧版本，看不了'
          : '守卫 ' + Math.round((Number.isFinite(guard) ? Math.min(1, Math.max(0, guard)) : 0) * 100) + '%' +
            (Number.isFinite(ripe) && ripe > 0 ? ' · 可偷 ' + Math.floor(ripe) + ' 块' : ' · 没熟地')
      })
    }
    // 能偷的在前；同分按名字，保证顺序稳定（不然每来一包就会跳一下）。
    items.sort((left, right) => {
      if (left.ripePlots !== right.ripePlots) return right.ripePlots - left.ripePlots
      return left.label.localeCompare(right.label, 'zh-Hans-CN')
    })
    const mode = items.length <= chipsMax ? 'chips' : 'menu'
    const current = items.find((item) => item.active) ?? null
    return {
      mode,
      items,
      currentLabel: current === null ? '我的农场' : current.label,
      stealable: items.filter((item) => item.ripePlots > 0 && item.old !== true).length
    }
  }

  function headerStats (farm) {
    const plots = farm !== null && typeof farm === 'object' && Array.isArray(farm.plots) ? farm.plots : []
    const planted = plots.reduce((count, plot) => (
      plot !== null && typeof plot === 'object' && plot.stage !== 'empty' ? count + 1 : count
    ), 0)
    const unlocked = Number(farm?.unlocked)
    const maxPlots = Number(farm?.maxPlots)
    const nextCost = Number(farm?.nextCost)
    const land = Number.isFinite(unlocked) && Number.isFinite(maxPlots)
      ? ' · 地块 ' + unlocked + '/' + maxPlots
      : ''
    // 下一块的地价放进标题：锁定卡被滚到折叠线以下时也看得见。
    const next = Number.isFinite(nextCost) && nextCost > 0 ? ' · 下一块 ' + nextCost : ''
    return {
      planted,
      total: plots.length,
      ...(Number.isFinite(unlocked) ? { unlocked } : {}),
      ...(Number.isFinite(maxPlots) ? { maxPlots } : {}),
      text: planted + '/' + plots.length + ' 已种植' + land + next
    }
  }

  /**
   * 倒计时（地块与合同共用）：快照那一刻的剩余 − **真实经过**的时间。
   *
   * 宿主只在事件上推快照（窗口收不到每秒推送），所以时间只能从收到快照那一刻往后推。
   * 不能「每拍减 1 秒」：Electron 的 interval 会被后台节流/长任务延迟，减出来的秒数
   * 会比真实时间少（ticket 47.1 的地块、ticket 61 的合同都踩过这一条）。
   * 时钟被调到过去时也只会停在原值，不让倒计时涨回去。
   */
  function remainingAt (baseRemainingMs, baseAt, now, fallbackMs = 0) {
    const base = Number(baseRemainingMs)
    const at = Number(baseAt)
    const current = Number(now)
    if (Number.isFinite(base) && Number.isFinite(at) && Number.isFinite(current)) {
      return Math.max(0, base - Math.max(0, current - at))
    }
    const fallback = Number(fallbackMs)
    return Number.isFinite(fallback) ? Math.max(0, fallback) : 0
  }

  /** 进度条 = 已生长 / 总生长。剩余时间是宿主算的权威值，这里只做显示。 */
  function progressOf (plot) {
    if (plot === null || typeof plot !== 'object') return 0
    if (plot.stage === 'empty' || plot.stage === 'withered') return 0
    if (plot.stage === 'mature' || plot.mature === true) return 1
    const meta = cropMeta(plot.crop)
    if (meta === null) return 0
    const remaining = Number(plot.remainingMs)
    if (!Number.isFinite(remaining)) return 0
    return clamp(1 - remaining / meta.growMs, 0, 1)
  }

  /**
   * 票 69：四季作物的买/种可用性。旧六种和自定义作物永远可用；
   * 四季作物只在当季可用，其他季节给一句「下季才有」。
   */
  function seedAvailability (cropId, seasonId) {
    const meta = cropMeta(cropId)
    if (meta === null) return { season: null, plantable: false, buyable: false, reason: '这种作物不在了' }
    const required = typeof meta.season === 'string' && meta.season !== '' ? meta.season : null
    if (required === null) return { season: null, plantable: true, buyable: true, reason: '' }
    // 票 69：宿主没给季节时不能默认「能种」——否则跨季/旧快照会把四季种子放出去。
    if (typeof seasonId !== 'string' || seasonId === '') {
      return { season: required, plantable: false, buyable: false, reason: '季节未知' }
    }
    if (required === seasonId) return { season: required, plantable: true, buyable: true, reason: '' }
    return { season: required, plantable: false, buyable: false, reason: '下季才有' }
  }

  /**
   * 票 69：四格季节条。`calendar` 由宿主按本地日期算好；这里只补
   * 「还剩多久」「是不是最后 4 小时」和节日的显示名。
   */
  function seasonCalendar (season) {
    const source = season !== null && typeof season === 'object' ? season : {}
    const cells = Array.isArray(source.calendar)
      ? source.calendar.map((cell) => ({
        id: typeof cell?.id === 'string' ? cell.id : '',
        name: typeof cell?.name === 'string' ? cell.name : '',
        emoji: typeof cell?.emoji === 'string' ? cell.emoji : '',
        today: cell?.today === true,
        past: cell?.past === true,
        festival: typeof cell?.festival === 'string' ? cell.festival : ''
      }))
      : []
    const remainingMs = Math.max(0, Number(source.remainingMs) || 0)
    return {
      id: typeof source.id === 'string' ? source.id : '',
      name: typeof source.name === 'string' ? source.name : '',
      emoji: typeof source.emoji === 'string' ? source.emoji : '',
      cells,
      remainingMs,
      remainingText: formatRemaining(remainingMs),
      almost: remainingMs > 0 && remainingMs <= 4 * HOUR_MS,
      next: cells.find((cell) => cell.today !== true && cell.past !== true) ?? null
    }
  }

  /** 票 69：节日卡。进度/是否可领都由宿主算，这里只拼文案。 */
  function eventCard (event) {
    if (event === null || typeof event !== 'object') return null
    const requirement = event.requirement ?? {}
    const qty = Math.max(1, Math.floor(Number(requirement.qty) || 1))
    const progress = Math.max(0, Math.floor(Number(event.progress) || 0))
    const claimed = event.claimed === true
    const ready = event.ready === true || progress >= qty
    const kindText = requirement.kind === 'plant'
      ? '种下'
      : requirement.kind === 'harvest'
        ? '收获'
        : requirement.kind === 'sell'
          ? '卖出'
          : requirement.kind === 'water' ? '浇水' : '完成'
    const reward = event.reward ?? {}
    return {
      id: typeof event.id === 'string' ? event.id : '',
      name: typeof event.name === 'string' ? event.name : '今日节日',
      kind: typeof requirement.kind === 'string' ? requirement.kind : '',
      qty,
      progress: Math.min(progress, qty),
      ready,
      claimed,
      canClaim: ready && !claimed,
      progressText: kindText + ' ' + Math.min(progress, qty) + '/' + qty,
      rewardText: '+' + (Number(reward.coins) || 0) + ' 硬币 +' + (Number(reward.dew) || 0) + ' 露水',
      statusText: claimed ? '今天已经领过了' : ready ? '完成了，可以领奖' : '还差 ' + Math.max(0, qty - progress)
    }
  }

  /** 票 69：秋天来客卡。选择与代价来自宿主，窗口不自己算概率。 */
  function omenCard (omen) {
    if (omen === null || typeof omen !== 'object') return null
    const stakes = omen.stakes ?? {}
    const resolved = omen.resolved === true
    const canFeed = omen.canFeed !== false
    return {
      id: typeof omen.id === 'string' ? omen.id : '',
      name: typeof omen.name === 'string' ? omen.name : '来客',
      emoji: typeof omen.emoji === 'string' ? omen.emoji : '🐻',
      resolved,
      choice: typeof omen.choice === 'string' ? omen.choice : null,
      canFeed,
      detail: '秋夜来了位不速之客。守夜可能失败；投喂 3 个仓库作物稳过。',
      guardText: '守夜成功 +' + (Number(stakes.guardReward?.coins) || 0) + ' 硬币 +' +
        (Number(stakes.guardReward?.dew) || 0) + ' 露水；失败被搬走最多 ' + (Number(stakes.failLoss) || 0) + ' 个作物。',
      feedText: '投喂 ' + (Number(stakes.feedCost) || 0) + ' 个仓库作物，换 ' +
        (Number(stakes.feedReward?.seeds?.rice) || 0) + ' 颗稻种 +' +
        (Number(stakes.feedReward?.dew) || 0) + ' 露水。',
      actions: [
        { id: 'guard', label: '守夜', disabled: resolved },
        { id: 'feed', label: '投喂', disabled: resolved || !canFeed, reason: !canFeed ? '仓库作物不够 3 个' : '' }
      ]
    }
  }

  function action (spec) {
    return {
      action: typeof spec.action === 'string' ? spec.action : '',
      label: String(spec.label),
      plotId: spec.plotId,
      ...(spec.cropId === undefined ? {} : { cropId: spec.cropId }),
      ...(spec.className === undefined ? {} : { className: spec.className }),
      disabled: spec.disabled === true,
      ...(spec.reason === undefined ? {} : { reason: spec.reason })
    }
  }

  /**
   * 邻居挂牌过期没有：宿主算好的 `expiresAt` 是本机时间，窗口自己走秒即可；
   * 老宿主没有这个字段（0/缺失）时退回 push 那一刻的 `stale` 快照。
   * 这样邻居断线两分钟后，开着的雇工页会自己变灰，而不是停在「可雇」。
   */
  function listingIsStale (listing, now = Date.now()) {
    const expiresAt = Number(listing?.expiresAt)
    const current = Number(now)
    if (Number.isFinite(expiresAt) && expiresAt > 0 && Number.isFinite(current)) {
      return current >= expiresAt
    }
    return listing?.stale === true
  }

  const MIN_TRADE_QTY = 1
  const MAX_TRADE_QTY = 99
  /** 与宿主 shared.js 的 MAX_FARM_STACK 同源：种子叠到 999 就不能再买。 */
  const MAX_SEED_STACK = 999

  /**
   * 交易所一行的纯模型：这一行此刻能不能买/卖、为什么不能、总价多少。
   *
   * 「为什么不能」必须一起返回，而不是只给一个 disabled：窗口以前只把按钮灰掉，
   * 而灰掉的买卖按钮和可点的长得一模一样（CSS 优先级），点下去既不发申请也不给提示，
   * 看起来就是「交易所坏了」。现在按钮下面永远有一行解释（buyHint / sellHint），
   * 空串才表示可以点。
   */
  function tradeView (farm, market, cropId, rawQty, seasonId = null) {
    const meta = cropMeta(cropId)
    if (meta === null) return null
    const season = seasonId ?? farm?.season?.id ?? null
    const availability = seedAvailability(cropId, season)
    const qty = Number(rawQty)
    const valid = Number.isInteger(qty) && qty >= MIN_TRADE_QTY && qty <= MAX_TRADE_QTY
    const coins = Math.max(0, Math.floor(Number(farm?.coins) || 0))
    const seeds = Math.max(0, Math.floor(Number(farm?.seeds?.[cropId]) || 0))
    const crops = Math.max(0, Math.floor(Number(farm?.crops?.[cropId]) || 0))
    const entry = market?.prices?.[cropId]
    const rawBid = Number(entry?.bid)
    const price = Number(entry?.price)
    const bid = Number.isFinite(rawBid) && rawBid >= 0
      ? Math.max(0, Math.round(rawBid))
      : Number.isFinite(price)
        ? Math.max(0, Math.round(price * 0.9))
        : Math.max(0, Math.round(meta.base * 0.9))
    const count = valid ? qty : 0
    const seedTotal = meta.seedPrice * count
    const sellTotal = bid * count
    const stackLeft = Math.max(0, MAX_SEED_STACK - seeds)
    const canBuy = availability.buyable === true && valid && coins >= seedTotal && qty <= stackLeft
    const canSell = valid && crops >= qty
    const buyHint = availability.buyable !== true
      ? availability.reason
      : !valid
        ? '数量要在 ' + MIN_TRADE_QTY + '–' + MAX_TRADE_QTY + ' 之间'
        : coins < seedTotal
          ? '硬币还差 ' + (seedTotal - coins) + '（需要 ' + seedTotal + '）'
          : qty > stackLeft
            ? '种子最多 ' + MAX_SEED_STACK + ' 颗（已有 ' + seeds + '）'
            : ''
    const sellHint = !valid
      ? '数量要在 ' + MIN_TRADE_QTY + '–' + MAX_TRADE_QTY + ' 之间'
      : crops === 0
        ? '仓库里还没有' + meta.name
        : crops < qty
          ? '仓库只有 ' + crops + ' 个' + meta.name
          : ''
    // 按钮自己的短标签：按钮在折叠线附近时，原因也必须在按钮上看得见。
    const buyShort = availability.buyable !== true
      ? availability.reason
      : !valid
        ? '数量 1–99'
        : coins < seedTotal
          ? '差 ' + (seedTotal - coins) + ' 硬币'
          : qty > stackLeft ? '种子已满' : ''
    const sellShort = !valid
      ? '数量 1–99'
      : crops === 0 ? '没有可卖的' : crops < qty ? '只有 ' + crops + ' 个' : ''
    return {
      cropId,
      name: meta.name,
      emoji: meta.emoji,
      art: meta.art,
      season: availability.season,
      plantable: availability.plantable,
      buyable: availability.buyable,
      seedPrice: meta.seedPrice,
      qty: count,
      valid,
      coins,
      seeds,
      crops,
      bid,
      seedTotal,
      sellTotal,
      canBuy,
      canSell,
      buyHint,
      sellHint,
      buyShort,
      sellShort,
      maxBuy: availability.buyable === true
        ? Math.max(0, Math.min(MAX_TRADE_QTY, Math.floor(coins / meta.seedPrice), stackLeft))
        : 0,
      maxSell: Math.max(0, Math.min(MAX_TRADE_QTY, crops))
    }
  }

  /**
   * 主人模式的地块卡模型。空地不给按钮（整张卡点开播种弹窗）；生长中给浇水/施肥；
   * 成熟给收获/施肥。`busy` 与露水只影响 disabled，不改数据。
   */
  function plotCards (farm, options) {
    const opts = options !== null && typeof options === 'object' ? options : {}
    const plots = farm !== null && typeof farm === 'object' && Array.isArray(farm.plots) ? farm.plots : []
    const dew = Number.isFinite(Number(opts.dew)) ? Number(opts.dew) : Number(farm?.dew) || 0
    const busy = opts.busy === true
    const selected = typeof opts.selectedPlot === 'string' ? opts.selectedPlot : null
    return plots.map((plot, index) => {
      const stage = plot !== null && typeof plot === 'object' && typeof plot.stage === 'string'
        ? plot.stage
        : 'empty'
      const meta = cropMeta(plot?.crop)
      const withered = stage === 'withered'
      const mature = stage === 'mature'
      const growing = stage === 'growing'
      const displayStage = withered ? 'withered' : mature ? 'mature' : growing ? 'growing' : 'empty'
      const card = {
        plotId: typeof plot?.id === 'string' ? plot.id : '',
        label: plotLabel(plot, index),
        stage: displayStage,
        crop: meta === null ? null : plot.crop,
        cropName: meta === null ? '空地' : withered ? meta.name + '（枯萎）' : meta.name,
        emoji: meta === null ? '＋' : meta.emoji,
        art: meta === null ? '' : meta.art,
        badge: STAGE_TEXT[displayStage],
        mature,
        progress: progressOf(plot),
        detailText: '',
        countdownText: growing ? formatRemaining(plot.remainingMs) : '',
        openPlant: displayStage === 'empty' || withered,
        selected: selected !== null && plot?.id === selected,
        actions: []
      }
      if (card.openPlant) {
        card.detailText = withered ? '换季枯了，点一下重种' : '点一下选种子'
      } else if (mature) {
        card.detailText = plot?.fertilized === true ? '已施肥 · 可以收了' : '已经成熟，可以收了'
        card.actions.push(action({
          action: 'harvest',
          plotId: card.plotId,
          label: '收获',
          className: 'harvest',
          disabled: busy
        }))
        card.actions.push(action({
          action: 'fertilize',
          plotId: card.plotId,
          label: '施肥',
          disabled: busy || plot?.fertilized === true || dew < FERTILIZE_COST,
          reason: plot?.fertilized === true
            ? '已经施过肥了'
            : '露水不够（需要 ' + FERTILIZE_COST + '）'
        }))
      } else {
        card.detailText = '还要'
        card.actions.push(action({
          action: 'water',
          plotId: card.plotId,
          label: '浇水',
          disabled: busy || Number(plot?.waterings) >= 1 || dew < WATER_COST,
          reason: Number(plot?.waterings) >= 1
            ? '这株已经浇过水了'
            : '露水不够（需要 ' + WATER_COST + '）'
        }))
        card.actions.push(action({
          action: 'fertilize',
          plotId: card.plotId,
          label: '施肥',
          disabled: busy || plot?.fertilized === true || dew < FERTILIZE_COST,
          reason: plot?.fertilized === true
            ? '已经施过肥了'
            : '露水不够（需要 ' + FERTILIZE_COST + '）'
        }))
      }
      return card
    })
  }

  /**
   * 一键种满（ticket 49）：按空地与种子库存排一条队列。
   * 每块空地消耗一颗种子，种子用完了就停；作物顺序按 CROP_IDS 固定顺序。
   */
  function batchPlantTargets (farm) {
    const plots = farm !== null && typeof farm === 'object' && Array.isArray(farm.plots) ? farm.plots : []
    const source = farm.seeds !== null && typeof farm.seeds === 'object' ? farm.seeds : {}
    const season = farm?.season?.id ?? null
    const seeds = {}
    for (const id of CROP_IDS) seeds[id] = Math.max(0, Math.floor(Number(source[id]) || 0))
    const targets = []
    for (const plot of plots) {
      if (plot === null || typeof plot !== 'object') continue
      if (plot.stage !== 'empty' && plot.stage !== 'withered') continue
      const cropId = CROP_IDS.find((id) => seeds[id] > 0 && seedAvailability(id, season).plantable === true)
      if (cropId === undefined) break
      seeds[cropId] -= 1
      targets.push({ plotId: plot.id, cropId })
    }
    return targets
  }

  /**
   * 锁定卡（ticket 49）：只画「下一块地」。到上限、没有地价、价格坏掉都返回 null。
   * `affordable` 已经算上「至少留一颗种子钱」的 6 硬币；窗口不再自己定规则。
   */
  function unlockCard (farm) {
    if (farm === null || typeof farm !== 'object') return null
    const unlocked = Number(farm.unlocked)
    const maxPlots = Number(farm.maxPlots)
    const nextCost = Number(farm.nextCost)
    if (!Number.isFinite(unlocked) || !Number.isFinite(maxPlots)) return null
    if (unlocked >= maxPlots) return null
    if (!Number.isFinite(nextCost) || nextCost <= 0) return null
    const coins = Number(farm.coins) || 0
    const reserve = UNLOCK_RESERVE
    const ladder = Array.isArray(farm.unlockLadder)
      ? farm.unlockLadder.filter((value) => Number.isFinite(Number(value)) && Number(value) > 0).slice(0, 6).map(Number)
      : []
    return {
      kind: 'unlock',
      plotNumber: unlocked + 1,
      label: '地块 ' + (unlocked + 1),
      nextCost,
      coins,
      reserve,
      ladder,
      affordable: coins >= nextCost + reserve,
      shortText: coins < nextCost
        ? '还差 ' + (nextCost - coins) + ' 硬币'
        : '留 ' + reserve + ' 硬币买种子',
      priceText: nextCost + ' 硬币'
    }
  }

  /** 锁定卡的 DOM（与地块卡同一套 .plot-card 外壳；按钮带 data-land-action）。 */
  function createUnlockCard (document, card) {
    const element = document.createElement('article')
    element.className = 'plot-card locked'
    element.dataset.locked = 'true'
    if (card.affordable !== true) element.dataset.affordable = 'false'

    const badge = document.createElement('p')
    badge.className = 'plot-badge'
    // 价格放进徽标：网格滚到折叠线时也能先看见地价。
    badge.textContent = '未解锁 · ' + card.priceText
    const title = document.createElement('h3')
    title.className = 'plot-title'
    title.textContent = card.label
    const emoji = document.createElement('p')
    emoji.className = 'plot-emoji'
    emoji.setAttribute('aria-hidden', 'true')
    emoji.textContent = '🔒'
    const hint = document.createElement('p')
    hint.className = 'plot-hint'
    hint.textContent = card.affordable === true ? '解锁后可以种一株' : card.shortText

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'chip-btn unlock'
    button.dataset.landAction = 'unlock'
    button.textContent = '解锁'
    // 买不起时也能点开确认层（看还差多少、接下来 5 块的价格）；
    // 真正拦住交易的是弹层里的确认键。
    button.title = card.affordable === true ? '解锁' + card.label : card.shortText

    element.appendChild(badge)
    element.appendChild(title)
    // 按钮紧跟标题：网格滚到一半时也能先看见价格、点到解锁。
    element.appendChild(button)
    element.appendChild(hint)
    element.appendChild(emoji)
    return { element, button }
  }

  /** 一键收割：按当前顺序列出所有成熟地块，窗口逐条发 `farm-harvest`。 */
  function batchHarvestTargets (farm) {
    const plots = farm !== null && typeof farm === 'object' && Array.isArray(farm.plots) ? farm.plots : []
    return plots
      .filter((plot) => plot !== null && typeof plot === 'object' && plot.stage === 'mature')
      .map((plot) => plot.id)
  }

  /** 动作按钮沿用 `data-plot-action` / `data-plot-id` / `data-crop-id` 的窄口。 */
  function createButton (document, spec) {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'chip-btn' + (spec.className === undefined ? '' : ' ' + spec.className)
    element.textContent = spec.label
    element.dataset.plotId = spec.plotId ?? ''
    element.dataset.plotAction = spec.action ?? ''
    if (spec.cropId !== undefined) element.dataset.cropId = spec.cropId
    if (spec.disabled === true) {
      element.disabled = true
      element.title = spec.reason ?? ''
    }
    return element
  }

  /**
   * 把一张卡模型变成 DOM。返回 `{ element, countdown, progress }`：
   * 倒计时节点和进度条节点交给窗口每秒原地更新，不重建按钮。
   */
  function createPlotCard (document, card) {
    const element = document.createElement('article')
    element.className = 'plot-card'
    element.dataset.stage = card.stage
    element.dataset.plot = card.plotId
    if (card.selected === true) element.dataset.selected = 'true'
    if (card.openPlant === true) {
      element.dataset.openPlant = 'true'
      element.setAttribute('role', 'button')
      element.setAttribute('tabindex', '0')
      element.setAttribute('aria-label', card.label + '，空地，点击播种')
    } else {
      element.setAttribute('aria-label', card.label + '，' + card.badge)
    }

    const head = document.createElement('div')
    head.className = 'plot-head'
    const label = document.createElement('span')
    label.className = 'plot-label'
    label.textContent = card.label
    const badge = document.createElement('span')
    badge.className = 'plot-badge'
    badge.textContent = card.badge
    head.appendChild(label)
    head.appendChild(badge)

    const body = document.createElement('div')
    body.className = 'plot-body'
    const emoji = cropEmblem(document, card, 'crop-emoji')
    const info = document.createElement('div')
    info.className = 'plot-info'
    const name = document.createElement('strong')
    name.textContent = card.cropName
    const detail = document.createElement('span')
    detail.className = 'plot-detail'
    let countdown = null
    if (card.countdownText !== '') {
      detail.textContent = card.detailText === '' ? '' : card.detailText + ' '
      countdown = document.createElement('span')
      countdown.className = 'countdown'
      countdown.textContent = card.countdownText
      detail.appendChild(countdown)
    } else {
      detail.textContent = card.detailText
    }
    info.appendChild(name)
    info.appendChild(detail)
    body.appendChild(emoji)
    body.appendChild(info)

    const progress = document.createElement('div')
    progress.className = 'plot-progress'
    const fill = document.createElement('span')
    fill.className = 'plot-progress-fill'
    fill.style.width = Math.round(clamp(card.progress, 0, 1) * 100) + '%'
    progress.appendChild(fill)

    element.appendChild(head)
    element.appendChild(body)
    element.appendChild(progress)

    if (card.actions.length > 0) {
      const actions = document.createElement('div')
      actions.className = 'plot-actions'
      for (const spec of card.actions) actions.appendChild(createButton(document, spec))
      element.appendChild(actions)
    } else if (card.openPlant === true) {
      const cta = document.createElement('span')
      cta.className = 'plot-cta'
      cta.textContent = '＋ 种植'
      element.appendChild(cta)
    }

    return { element, countdown, progress: fill }
  }

  return {
    CROP_META,
    CROP_IDS,
    BUILTIN_META,
    setCrops,
    WATER_COST,
    FERTILIZE_COST,
    UNLOCK_RESERVE,
    MIN_TRADE_QTY,
    MAX_TRADE_QTY,
    MAX_SEED_STACK,
    cropMeta,
    cropEmblem,
    formatRemaining,
    formatGrowTime,
    plotNumber,
    plotLabel,
    headerStats,
    neighborSwitch,
    progressOf,
    remainingAt,
    seedAvailability,
    seasonCalendar,
    eventCard,
    omenCard,
    tradeView,
    listingIsStale,
    plotCards,
    batchPlantTargets,
    batchHarvestTargets,
    unlockCard,
    createUnlockCard,
    createButton,
    createPlotCard
  }
})
