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
'use strict'

(function () {
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
      const cells = [row.contract, row.side, row.lots, row.entry, row.margin, row.liquidation, row.unrealized]
      cells.forEach((text, index) => {
        const td = document.createElement('td')
        td.textContent = text
        if (index === 6) td.className = row.tone
        tr.appendChild(td)
      })
      const action = document.createElement('td')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'close-btn'
      button.textContent = '平'
      button.dataset.positionId = row.id ?? ''
      action.appendChild(button)
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
      const cells = [row.time, row.contract, row.kind + row.side, row.price, row.lots, row.fee]
      for (const text of cells) {
        const td = document.createElement('td')
        td.textContent = text
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
      const cells = [row.label, row.sideText, row.price, row.lots, row.lotsLeft, row.marginFrozen]
      for (const text of cells) {
        const td = document.createElement('td')
        td.textContent = text
        tr.appendChild(td)
      }
      body.appendChild(tr)
    }
    el('ordersEmpty').hidden = rows.length > 0
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
    if (typeof positionId !== 'string' || positionId === '') return
    if (state.busy) return
    state.busy = true
    bridge.submit({ action: 'futures-close', positionId })
    setTimeout(() => { state.busy = false; render() }, 3000)
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
