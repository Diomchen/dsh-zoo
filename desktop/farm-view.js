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
   */
  const CROP_META = {
    tomato: { name: '小番茄', emoji: '🍅', seedPrice: 6, base: 5, growMs: 30 * MINUTE_MS, yield: 3 },
    carrot: { name: '胡萝卜', emoji: '🥕', seedPrice: 14, base: 6, growMs: 2 * HOUR_MS, yield: 5 },
    pumpkin: { name: '南瓜', emoji: '🎃', seedPrice: 36, base: 30, growMs: 8 * HOUR_MS, yield: 3 }
  }
  const CROP_IDS = Object.keys(CROP_META)
  const WATER_COST = 1
  const FERTILIZE_COST = 5
  const STAGE_TEXT = { empty: '空地', growing: '生长中', mature: '可收割' }

  function cropMeta (cropId) {
    return Object.prototype.hasOwnProperty.call(CROP_META, cropId) ? CROP_META[cropId] : null
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
  function headerStats (farm) {
    const plots = farm !== null && typeof farm === 'object' && Array.isArray(farm.plots) ? farm.plots : []
    const planted = plots.reduce((count, plot) => (
      plot !== null && typeof plot === 'object' && plot.stage !== 'empty' ? count + 1 : count
    ), 0)
    return {
      planted,
      total: plots.length,
      text: planted + '/' + plots.length + ' 已种植'
    }
  }

  /** 进度条 = 已生长 / 总生长。剩余时间是宿主算的权威值，这里只做显示。 */
  function progressOf (plot) {
    if (plot === null || typeof plot !== 'object') return 0
    if (plot.stage === 'empty') return 0
    if (plot.stage === 'mature' || plot.mature === true) return 1
    const meta = cropMeta(plot.crop)
    if (meta === null) return 0
    const remaining = Number(plot.remainingMs)
    if (!Number.isFinite(remaining)) return 0
    return clamp(1 - remaining / meta.growMs, 0, 1)
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
      const mature = stage === 'mature'
      const growing = stage === 'growing'
      const card = {
        plotId: typeof plot?.id === 'string' ? plot.id : '',
        label: plotLabel(plot, index),
        stage: mature ? 'mature' : growing ? 'growing' : 'empty',
        crop: meta === null ? null : plot.crop,
        cropName: meta === null ? '空地' : meta.name,
        emoji: meta === null ? '＋' : meta.emoji,
        badge: STAGE_TEXT[mature ? 'mature' : growing ? 'growing' : 'empty'],
        mature,
        progress: progressOf(plot),
        detailText: '',
        countdownText: growing ? formatRemaining(plot.remainingMs) : '',
        openPlant: stage === 'empty' || (!mature && !growing),
        selected: selected !== null && plot?.id === selected,
        actions: []
      }
      if (card.openPlant) {
        card.detailText = '点一下选种子'
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
   * 一键播种选目标：第一个空地 + 第一种还有库存的种子（CROP_IDS 固定顺序）。
   * 返回窄形状；窗口只负责把它变成一次 `farm-plant`。
   */
  function batchPlantTarget (farm) {
    const plots = farm !== null && typeof farm === 'object' && Array.isArray(farm.plots) ? farm.plots : []
    const empty = plots.find((plot) => plot !== null && typeof plot === 'object' && plot.stage === 'empty')
    if (empty === undefined) return { ok: false, reason: 'no-plot' }
    const seeds = farm.seeds !== null && typeof farm.seeds === 'object' ? farm.seeds : {}
    const cropId = CROP_IDS.find((id) => Number(seeds[id]) > 0)
    if (cropId === undefined) return { ok: false, reason: 'no-seed' }
    return { ok: true, plotId: empty.id, cropId }
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
    const emoji = document.createElement('span')
    emoji.className = 'crop-emoji'
    emoji.setAttribute('aria-hidden', 'true')
    emoji.textContent = card.emoji
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
    WATER_COST,
    FERTILIZE_COST,
    cropMeta,
    formatRemaining,
    formatGrowTime,
    plotNumber,
    plotLabel,
    headerStats,
    progressOf,
    plotCards,
    batchPlantTarget,
    batchHarvestTargets,
    createButton,
    createPlotCard
  }
})
