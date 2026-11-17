/**
 * 期货小窗的渲染脚本（票 93）。
 *
 * 只做三件事：把 `dshZooFuturesView.build()` 的结果贴到 DOM、把用户的点击变成
 * `dshZooFutures.submit()`、以及到点请宿主再推一拍（倒计时归零）。
 *
 * 纪律（与 `board.js` 相同）：
 *   - 不读盘、不联网、不算钱：所有数字来自宿主推来的 view，`build()` 只负责格式化；
 *   - 不 import 规则层：杠杆/作物/费率都从 `view.limits` 与 `view.crops` 读；
 *   - 提交只表达意图：side/margin/leverage/cropId/positionId，价格与张数不过桥。
 */

(function () {
  'use strict'

  const api = window.dshZooFuturesView
  const bridge = window.dshZooFutures
  const el = (id) => document.getElementById(id)

  const state = {
    view: null,
    now: Date.now(),
    draft: { side: 'long', margin: 50, leverage: 20, cropId: null },
    composing: false,
    askedRefreshAt: 0,
    busy: false
  }

  function toast (text) {
    const node = el('toast')
    node.textContent = text
    node.classList.add('show')
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => node.classList.remove('show'), 2600)
  }

  /** 重建杠杆按钮与作物下拉（清单来自宿主，不硬编码）。 */
  function syncControls (limits, crops) {
    const bar = el('leverage')
    const wanted = limits.leverages.join(',')
    if (bar.dataset.list !== wanted) {
      bar.dataset.list = wanted
      bar.textContent = ''
      for (const leverage of limits.leverages) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = leverage + '×'
        button.dataset.leverage = String(leverage)
        bar.appendChild(button)
      }
      if (!limits.leverages.includes(state.draft.leverage)) {
        state.draft.leverage = limits.leverages[0]
      }
    }

    const select = el('crop')
    const ids = crops.map((crop) => crop.id).join(',')
    if (select.dataset.list !== ids) {
      select.dataset.list = ids
      select.textContent = ''
      for (const crop of crops) {
        const option = document.createElement('option')
        option.value = crop.id
        option.textContent = crop.label
        select.appendChild(option)
      }
      if (!crops.some((crop) => crop.id === state.draft.cropId)) {
        state.draft.cropId = crops.length > 0 ? crops[0].id : null
      }
      select.value = state.draft.cropId ?? ''
    }
  }

  function paintChips () {
    for (const button of el('side').querySelectorAll('button')) {
      button.classList.toggle('on', button.dataset.side === state.draft.side)
    }
    for (const button of el('leverage').querySelectorAll('button')) {
      button.classList.toggle('on', Number(button.dataset.leverage) === state.draft.leverage)
    }
  }

  function paintQuotes (rows) {
    const body = el('quotes')
    body.textContent = ''
    for (const row of rows) {
      const tr = document.createElement('tr')
      if (row.tone === 'closed') tr.className = 'closed'
      const cells = [row.label + ' · ' + row.contract, row.bid, row.ask, row.spread, row.deviation, row.spreadPct]
      cells.forEach((text, index) => {
        const td = document.createElement('td')
        td.textContent = text
        if (index === 0) td.title = row.contract
        if (index === 4 && row.tone !== 'flat') td.className = row.tone
        tr.appendChild(td)
      })
      body.appendChild(tr)
    }
    el('quotesEmpty').hidden = rows.length > 0
  }

  function paintPositions (rows) {
    const body = el('positions')
    body.textContent = ''
    for (const row of rows) {
      const tr = document.createElement('tr')
      if (row.danger) tr.className = 'danger'
      const cells = [row.label, row.side, row.lots, row.entry, row.margin, row.liquidation, row.unrealized]
      cells.forEach((text, index) => {
        const td = document.createElement('td')
        td.textContent = text
        if (index === 0) td.title = row.contract
        if (index === 6) td.className = row.tone
        tr.appendChild(td)
      })
      const action = document.createElement('td')
      const closeButton = document.createElement('button')
      closeButton.type = 'button'
      closeButton.className = 'close-btn'
      closeButton.textContent = '平'
      closeButton.dataset.positionId = row.id ?? ''
      action.appendChild(closeButton)
      const convertButton = document.createElement('button')
      convertButton.type = 'button'
      convertButton.className = 'close-btn convert-btn'
      convertButton.textContent = '转'
      convertButton.title = '按公允价转成现货'
      convertButton.dataset.convertId = row.id ?? ''
      convertButton.dataset.convertLots = String(row.lotsValue ?? '')
      action.appendChild(convertButton)
      tr.appendChild(action)
      body.appendChild(tr)
    }
    el('positionsEmpty').hidden = rows.length > 0
  }

  function paintTrades (rows) {
    const body = el('trades')
    body.textContent = ''
    for (const row of rows) {
      const tr = document.createElement('tr')
      const cells = [row.time, row.label, row.kind + row.side, row.price, row.lots, row.fee]
      for (const [index, text] of cells.entries()) {
        const td = document.createElement('td')
        td.textContent = text
        if (index === 1) td.title = row.contract
        tr.appendChild(td)
      }
      body.appendChild(tr)
    }
    el('tradesEmpty').hidden = rows.length > 0
  }

  function paintOrders (rows) {
    const body = el('orders')
    body.textContent = ''
    for (const row of rows) {
      const tr = document.createElement('tr')
      // 178px 只放得下五列 + 撤：合约名、方向、限价、张数、剩余；冻结保证金挂到标题上。
      const cells = [row.label, row.side, row.price, row.lots, row.lotsLeft]
      for (const [index, text] of cells.entries()) {
        const td = document.createElement('td')
        td.textContent = text
        if (index === 0) td.title = row.label + ' · 冻结保证金 ' + row.marginFrozen
        tr.appendChild(td)
      }
      const action = document.createElement('td')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'close-btn'
      button.textContent = '撤'
      button.dataset.orderId = row.id ?? ''
      action.appendChild(button)
      tr.appendChild(action)
      body.appendChild(tr)
    }
    el('ordersEmpty').hidden = rows.length > 0
  }

  /** 票 98：三档灰度条。老版本 payload 没有 `mode` 就整行藏掉，窗口不该因此变灰。 */
  function paintMode (built) {
    const bar = el('modebar')
    const mode = built.mode
    if (!mode || typeof mode.kind !== 'string') {
      bar.hidden = true
      return
    }
    bar.hidden = false
    const chip = el('modeChip')
    chip.textContent = mode.label ?? '—'
    chip.className = 'chip ' + mode.kind
    el('modeText').textContent = mode.text ?? ''
    el('caps').textContent = typeof built.capsLine === 'string' ? built.capsLine : ''
    const pending = typeof built.pendingLine === 'string' ? built.pendingLine : ''
    el('pending').textContent = pending
    el('pending').hidden = pending === ''
    el('modeSwitch').hidden = built.isHost !== true
    const select = el('modeSelect')
    if (document.activeElement !== select) select.value = mode.kind
    el('applyMode').disabled = built.isHost !== true
    el('rollback').disabled = built.isHost !== true
  }

  function render () {
    const view = state.view
    state.now = Date.now()
    const built = api.build(view, state.draft, state.now)

    syncControls(built.limits, Array.isArray(view?.crops) ? view.crops : [])
    paintChips()

    el('week').textContent = built.title.replace(/^期货 · /, '').replace(/ · 本根还剩 .*$/, '')
    el('countdown').textContent = built.countdown.text
    el('balance').textContent = built.header.balance
    el('marginUsed').textContent = built.header.marginUsed
    el('equity').textContent = built.header.equity
    el('weekPnl').textContent = built.header.weekPnl + ' · ' + built.header.weekPct
    el('weekPnl').className = built.header.weekTone
    el('insurance').textContent = built.header.insurance
    el('shortfall').textContent = built.header.shortfall

    // 到期日的四根收盘价：有就横在报价表上方，没有就整行藏掉。
    el('delivery').textContent = built.deliveryLine ?? ''
    el('delivery').hidden = built.deliveryLine === null
    // 收盘/周末的说明：常驻一行，比一闪而过的 toast 好核对。
    el('session').textContent = built.sessionLine ?? ''
    el('session').hidden = built.sessionLine === null

    paintQuotes(built.quotes)
    paintPositions(built.positions)
    paintOrders(built.orders)
    paintTrades(built.trades)
    el('ordersTitle').textContent = built.orderCount > 0 ? '我的挂单 · ' + built.orderCount : '我的挂单'

    el('pLots').textContent = built.previewText.lots
    el('pNotional').textContent = built.previewText.notional
    el('pMargin').textContent = built.previewText.margin
    el('pFee').textContent = built.previewText.fee
    el('pLiquidation').textContent = built.previewText.liquidation
    el('pReason').textContent = built.preview.ok ? '' : (built.preview.reason ?? '')
    el('submit').disabled = built.canSubmit !== true || state.busy
    el('submit').textContent = state.draft.side === 'short' ? '做空' : '做多'
    paintMode(built)

    if (built.countdown.atEnd) askRefresh()
  }

  /** 倒计时归零：请宿主结这一根并重推一拍（每 5 秒最多一次，防抖）。 */
  function askRefresh () {
    if (state.composing) return
    if (state.now - state.askedRefreshAt < 5000) return
    state.askedRefreshAt = state.now
    bridge.submit({ action: 'futures-refresh' })
  }

  function applyView (view) {
    state.view = view
    if (typeof view?.now === 'number') state.now = view.now
    render()
  }

  // --- 交互 ---------------------------------------------------------------

  el('side').addEventListener('click', (event) => {
    const side = event.target?.dataset?.side
    if (side !== 'long' && side !== 'short') return
    state.draft.side = side
    render()
  })

  el('leverage').addEventListener('click', (event) => {
    const leverage = Number(event.target?.dataset?.leverage)
    if (!Number.isFinite(leverage)) return
    state.draft.leverage = leverage
    render()
  })

  el('crop').addEventListener('change', () => {
    const cropId = el('crop').value
    if (typeof cropId === 'string' && cropId !== '') {
      state.draft.cropId = cropId
      render()
    }
  })

  el('margin').addEventListener('input', () => {
    const value = Number(el('margin').value)
    state.draft.margin = Number.isFinite(value) ? value : null
    render()
  })

  el('submit').addEventListener('click', () => {
    if (state.busy) return
    const built = api.build(state.view, state.draft, Date.now())
    if (built.canSubmit !== true) {
      toast(built.preview.reason ?? '现在还下不了单')
      return
    }
    state.busy = true
    const accepted = bridge.submit({
      action: 'futures-open',
      side: state.draft.side,
      margin: Math.trunc(state.draft.margin),
      leverage: state.draft.leverage,
      cropId: state.draft.cropId
    })
    if (!accepted) {
      state.busy = false
      toast('窗口状态不对，重开一下。')
      return
    }
    // 回执回来之前不让连点：重复下单比慢一点糟糕得多。
    setTimeout(() => { state.busy = false; render() }, 3000)
    render()
  })

  el('withdraw').addEventListener('click', () => {
    const raw = window.prompt('提现多少币回农场？', '100')
    if (raw === null) return
    const coins = Math.trunc(Number(raw))
    if (!Number.isFinite(coins) || coins <= 0) {
      toast('提现要是正整数币')
      return
    }
    state.busy = true
    bridge.submit({ action: 'futures-withdraw', coins })
    setTimeout(() => { state.busy = false; render() }, 3000)
  })

  el('positions').addEventListener('click', (event) => {
    const positionId = event.target?.dataset?.positionId
    if (typeof positionId === 'string' && positionId !== '') {
      if (state.busy) return
      state.busy = true
      bridge.submit({ action: 'futures-close', positionId })
      setTimeout(() => { state.busy = false; render() }, 3000)
      return
    }
    const convertId = event.target?.dataset?.convertId
    if (typeof convertId === 'string' && convertId !== '') {
      const held = Number(event.target.dataset.convertLots)
      const raw = window.prompt('转多少张成现货？（这批持仓共 ' + (Number.isFinite(held) ? held : '?') + ' 张）', String(held > 0 ? held : 1))
      if (raw === null) return
      const lots = Math.trunc(Number(raw))
      if (!Number.isFinite(lots) || lots <= 0) {
        toast('张数要是正整数')
        return
      }
      if (state.busy) return
      state.busy = true
      bridge.submit({ action: 'futures-convert', positionId: convertId, lots })
      setTimeout(() => { state.busy = false; render() }, 3000)
    }
  })

  el('orders').addEventListener('click', (event) => {
    const orderId = event.target?.dataset?.orderId
    if (typeof orderId !== 'string' || orderId === '') return
    if (state.busy) return
    state.busy = true
    bridge.submit({ action: 'futures-cancel', orderId })
    setTimeout(() => { state.busy = false; render() }, 3000)
  })

  el('place').addEventListener('click', () => {
    if (state.busy) return
    const price = Number(el('limitPrice').value)
    const lots = Math.trunc(Number(el('limitLots').value))
    const hint = el('placeHint')
    if (!Number.isFinite(price) || price <= 0) {
      hint.textContent = '填个价'
      return
    }
    if (!Number.isFinite(lots) || lots <= 0) {
      hint.textContent = '张数要正整数'
      return
    }
    if (typeof state.draft.cropId !== 'string' || state.draft.cropId === '') {
      hint.textContent = '先选作物'
      return
    }
    hint.textContent = ''
    state.busy = true
    const accepted = bridge.submit({
      action: 'futures-place',
      side: state.draft.side,
      cropId: state.draft.cropId,
      price,
      lots,
      leverage: state.draft.leverage
    })
    if (!accepted) {
      state.busy = false
      toast('窗口状态不对，重开一下。')
      return
    }
    setTimeout(() => { state.busy = false; render() }, 3000)
  })

  el('applyMode').addEventListener('click', () => {
    if (state.busy) return
    const mode = el('modeSelect').value
    if (mode !== 'off' && mode !== 'shadow' && mode !== 'live') return
    if (mode === 'live' && !window.confirm('切到真钱档？切完邻居就能用真硬币下单了。')) return
    state.busy = true
    bridge.submit({ action: 'futures-mode', mode })
    setTimeout(() => { state.busy = false; render() }, 3000)
  })

  el('rollback').addEventListener('click', () => {
    if (state.busy) return
    if (!window.confirm('回滚会把所有人的托管余额退回农场、并关掉期货。继续？')) return
    state.busy = true
    bridge.submit({ action: 'futures-rollback' })
    setTimeout(() => { state.busy = false; render() }, 3000)
  })

  // 顶栏的「×」：无边框窗口没有系统关闭按钮，这颗是唯一看得见的出口（Esc 仍可用）。
  el('close').addEventListener('click', () => {
    if (state.composing) return
    bridge.close()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (state.composing) return
    bridge.close()
  })

  // --- 桥 -----------------------------------------------------------------

  bridge.onState(applyView)
  bridge.onResult((result) => {
    state.busy = false
    if (result?.ok === true) {
      if (typeof result.notice === 'string' && result.notice !== '') toast(result.notice)
      else toast('成交了')
      if (result.view !== undefined) applyView(result.view)
      else render()
      return
    }
    state.busy = false
    toast(typeof result?.message === 'string' && result.message !== '' ? result.message : '没成交，再试一次。')
    render()
  })
  bridge.onComposing((flag) => { state.composing = flag })

  bridge.ready()

  // 倒计时每秒走一格；只重绘数字，不重算整份视图（省得表格闪）。
  setInterval(() => {
    if (state.view === null) return
    const built = api.build(state.view, state.draft, Date.now())
    el('countdown').textContent = built.countdown.text
    if (built.countdown.atEnd) askRefresh()
  }, 1000)
})()
