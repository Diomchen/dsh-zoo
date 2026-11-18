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
    busy: false,
    // 1.10.0：上一拍画出来的账户档位（切换按钮用它算「下一档」）。
    account: null,
    // 1.12.0：上一拍画出来的暂停状态（按钮用它算「切到哪一档」）。
    pause: null,
    // 票 109：「全部转」要提交的持仓清单（id + 张数），每拍重算。
    convertTargets: []
  }

  function toast (text) {
    const node = el('toast')
    node.textContent = text
    node.classList.add('show')
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => node.classList.remove('show'), 2600)
  }

  /**
   * 宿主没给 `notice` 时的兜底文案：按错误码说一句人话。
   * 这些码来自 `src/futures.js` 的 `FUTURES_ERROR_TEXT`，窗口只补「宿主没说」的那几种。
   */
  const RESULT_TEXT = {
    'daily-cap': '今天的交易额用完了，明天 00:00 重置。',
    'notional-cap': '持仓名义到上限了，先平掉一点再开。',
    'position-limit': '持仓笔数到上限了，先平掉一笔。',
    'order-limit': '挂单已经有 8 笔了，先撤一笔。',
    'no-balance': '托管余额不够：先充一点再下单。',
    paused: '你暂停了期货交易，点「继续交易」再来。',
    disabled: '这个账户已经退出了，要重新充值才会开一张新账。',
    'market-closed': '现在不在交易时段。',
    'self-trade': '不能跟自己成交，换个价或换个方向。',
    'bad-market-order': '这笔市价单的形状不对（方向/保证金/杠杆）。',
    'bad-order': '这笔挂单的形状不对（价格/张数/杠杆）。',
    timeout: '宿主没回话，稍等一下再试。',
    'host-unavailable': '连不上房主，等一下再试。'
  }

  /**
   * 窗口 → 宿主。preload 会按动作白名单再筛一遍：没登记的动作 `submit()` 返回 false、
   * 一个字节都不发（1.10–1.12 的切档/全部转/暂停就这么「点了没反应」过）。
   * 所以这里不吞返回值——发不出去至少说一句，别让按钮看起来像坏了。
   */
  function send (payload) {
    const accepted = bridge.submit(payload)
    if (accepted === false) {
      toast('这个操作发不出去：窗口的动作白名单里没有它，更新插件后重开窗口试试。')
    }
    return accepted
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

  /**
   * 1.10.0 / 1.12.0：档位条。左边是**这本账**的档位（纸面/真钱），旁边一颗切换按钮；
   * 右边是「暂停 / 继续」与「退出」——三件事都只作用于自己这本账，谁都点得动。
   * 老版本 payload 没有账户档位就整行藏掉。
   */
  function paintMode (built) {
    const bar = el('modebar')
    const account = built.account
    const mode = built.mode
    const pause = built.pause
    if (!account || typeof account.kind !== 'string') {
      bar.hidden = true
      return
    }
    bar.hidden = false
    state.account = account
    state.pause = pause ?? null
    const chip = el('accountChip')
    chip.textContent = account.label ?? '—'
    chip.className = 'chip ' + account.kind
    const closed = mode !== null && mode.kind === 'off'
    el('accountText').textContent = closed ? (mode.text || '') : (account.text ?? '')
    const toggle = el('accountSwitch')
    toggle.textContent = account.toggleLabel ?? '切档'
    toggle.disabled = built.canSwitchAccount !== true
    el('caps').textContent = typeof built.capsLine === 'string' ? built.capsLine : ''
    const pending = typeof built.pendingLine === 'string' ? built.pendingLine : ''
    el('pending').textContent = pending
    el('pending').hidden = pending === ''
    // 1.12.0：暂停 / 继续只停自己；退出只退自己。
    const paused = pause !== null && pause !== undefined && pause.paused === true
    el('pauseText').textContent = paused ? (pause.text || '') : ''
    el('pauseBtn').textContent = (pause && pause.toggleLabel) || (paused ? '继续交易' : '暂停交易')
    el('pauseBtn').disabled = built.canPause !== true
    el('rollback').disabled = closed
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
    el('house').textContent = built.header.house
    el('house').className = built.header.houseTone

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

    // 票 109：交割前的提醒，与「全部转」按钮同一处——错过就只能现金结算。
    const expiry = built.expiry ?? { text: null, urgent: false }
    el('expiryHint').textContent = expiry.text ?? ''
    el('expiryHint').hidden = expiry.text === null
    el('convertAll').disabled = built.canConvertAll !== true || state.busy
    state.convertTargets = (built.positions ?? [])
      .filter((row) => typeof row.id === 'string' && row.lotsValue > 0)
      .map((row) => ({ id: row.id, lots: row.lotsValue }))

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
    send({ action: 'futures-refresh' })
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
    const accepted = send({
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
    send({ action: 'futures-withdraw', coins })
    setTimeout(() => { state.busy = false; render() }, 3000)
  })

  el('positions').addEventListener('click', (event) => {
    const positionId = event.target?.dataset?.positionId
    if (typeof positionId === 'string' && positionId !== '') {
      if (state.busy) return
      state.busy = true
      send({ action: 'futures-close', positionId })
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
      send({ action: 'futures-convert', positionId: convertId, lots })
      setTimeout(() => { state.busy = false; render() }, 3000)
    }
  })

  // 票 109：一次把全部持仓转成现货。钱不够/仓库放不下的那几笔会被宿主拒，剩下的照转。
  el('convertAll').addEventListener('click', () => {
    if (state.busy) return
    const targets = Array.isArray(state.convertTargets) ? state.convertTargets : []
    if (targets.length === 0) return
    if (!window.confirm('把这 ' + targets.length + ' 笔持仓全部按公允价转成现货？')) return
    state.busy = true
    send({ action: 'futures-convert-all', positions: targets })
    setTimeout(() => { state.busy = false; render() }, 3000)
  })

  el('orders').addEventListener('click', (event) => {
    const orderId = event.target?.dataset?.orderId
    if (typeof orderId !== 'string' || orderId === '') return
    if (state.busy) return
    state.busy = true
    send({ action: 'futures-cancel', orderId })
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
    const accepted = send({
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

  // 1.10.0：切自己的档位。切到真钱要确认一次——那之后充提都动农场硬币。
  el('accountSwitch').addEventListener('click', () => {
    if (state.busy) return
    const account = state.account
    if (!account || (account.next !== 'live' && account.next !== 'shadow')) return
    if (account.next === 'live' && !window.confirm('把这本账切到真钱？之后充值/提现都动农场硬币，盈亏也是真的。')) return
    state.busy = true
    send({ action: 'futures-account-mode', accountMode: account.next })
    setTimeout(() => { state.busy = false; render() }, 3000)
  })

  // 1.12.0：暂停 / 继续——只停自己这本账（房主按下去也停不了别人）。
  el('pauseBtn').addEventListener('click', () => {
    if (state.busy) return
    const paused = state.pause !== null && state.pause !== undefined && state.pause.paused === true
    state.busy = true
    send({ action: 'futures-pause', paused: !paused })
    setTimeout(() => { state.busy = false; render() }, 3000)
  })

  // 1.12.0：退出——强平自己的仓位、余额退回自己的农场，别人的账一分不动。
  el('rollback').addEventListener('click', () => {
    if (state.busy) return
    if (!window.confirm('退出会把你的仓位按当前价强平、余额退回你的农场，并关掉你这本账。继续？')) return
    state.busy = true
    send({ action: 'futures-rollback' })
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
    // 宿主回的是 `{ ok, notice, code }`（不是 `message`）：以前只认 `message`，
    // 于是所有拒绝都显示同一句「没成交，再试一次」——把人挡在门外还不说为什么。
    const said = typeof result?.notice === 'string' && result.notice !== ''
      ? result.notice
      : (typeof result?.message === 'string' && result.message !== '' ? result.message : '')
    toast(said !== '' ? said : (RESULT_TEXT[result?.code] ?? '没成交，再试一次。'))
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
