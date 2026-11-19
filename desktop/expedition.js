/**
 * 出远门小窗的渲染端（票 112）。
 *
 * 一切以宿主推来的 view 为准：窗口不算段数、不回币、不结算，只画阶段和两个按钮。
 * 倒计时用 view.now 与本地 Date.now 的差做插值；归零时请宿主补一拍（expedition-refresh），
 * 真正的推进仍在服务端秒级 tick 里。
 */
'use strict'

(function () {
  const bridge = window.dshZooExpedition
  const view = window.dshZooExpeditionView

  const el = (id) => document.getElementById(id)
  const ui = {
    coins: el('coins'),
    close: el('close'),
    tabs: el('tabs'),
    tabTravel: el('tabTravel'),
    tabLog: el('tabLog'),
    tabCodex: el('tabCodex'),
    tabShelf: el('tabShelf'),
    travelPane: el('travelPane'),
    routes: el('routes'),
    logPane: el('logPane'),
    logCount: el('logCount'),
    logList: el('logList'),
    lantern: el('lantern'),
    lanternText: el('lanternText'),
    lanternBuy: el('lanternBuy'),
    home: el('home'),
    routeName: el('routeName'),
    routeHint: el('routeHint'),
    routeDesc: el('routeDesc'),
    start: el('start'),
    homeNote: el('homeNote'),
    trip: el('trip'),
    phase: el('phase'),
    clock: el('clock'),
    legs: el('legs'),
    progress: el('progress'),
    danger: el('danger'),
    loot: el('loot'),
    continue: el('continue'),
    back: el('back'),
    done: el('done'),
    doneTitle: el('doneTitle'),
    settle: el('settle'),
    again: el('again'),
    browse: el('browse'),
    codex: el('codex'),
    codexCount: el('codexCount'),
    codexProgress: el('codexProgress'),
    codexGroups: el('codexGroups'),
    shelf: el('shelf'),
    shelfCount: el('shelfCount'),
    shelfProgress: el('shelfProgress'),
    shelfPicker: el('shelfPicker'),
    shelfGrid: el('shelfGrid'),
    shelfTools: el('shelfTools'),
    shelfPick: el('shelfPick'),
    shelfRemove: el('shelfRemove'),
    toast: el('toast')
  }

  let state = null
  let pending = false
  let toastTimer = null
  let activeTab = 'travel'
  /** 陈列架上选中的源格；再点空格就是挪过去。 */
  let selectedSlot = null
  /** 图鉴里选中、准备摆进空格的特产 id。 */
  let pendingItem = null
  /** 当前挑中的路线（只在 home 有意义；路上/结算时以 run.routeId 为准）。 */
  let selectedRoute = null
  /** 结算后点了「换条路线」：暂时把 home 翻出来挑路线，不等下一次出发。 */
  let browsing = false
  /** 收到 view 那一刻的本地时间；倒计时按 now 在此之后的增量走。 */
  let receivedAt = 0
  let refreshAsked = false

  /**
   * 路线选择：优先保留玩家挑的那条；它不存在或锁上了就退回第一条已解锁的。
   * 条件刚满足时下一次推送会重新算 unlocked，这里自然就挑得中。
   */
  function pickRoute (routes, wanted) {
    const list = Array.isArray(routes) ? routes : []
    const found = list.find((route) => route !== null && route.id === wanted)
    if (found !== undefined && found.unlocked !== false) return wanted
    const open = list.find((route) => route !== null && route.unlocked !== false)
    if (open !== undefined) return open.id
    return list.length > 0 ? list[0].id : null
  }

  function activeRoute () {
    if (state === null) return null
    const routes = Array.isArray(state.routes) ? state.routes : []
    const runRouteId = state.run === null || state.run === undefined || browsing ? null : state.run.routeId
    const wanted = runRouteId === null ? selectedRoute : runRouteId
    return routes.find((route) => route !== null && route.id === wanted) ?? routes[0] ?? null
  }

  function toast (text) {
    if (typeof text !== 'string' || text === '') return
    ui.toast.textContent = text
    if (toastTimer !== null) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastTimer = null
      ui.toast.textContent = ''
    }, 2600)
  }

  function send (payload) {
    if (bridge === undefined || typeof bridge.submit !== 'function') {
      toast('窗口没有连上宿主')
      return
    }
    if (pending) return
    if (bridge.submit(payload) !== true) {
      toast('这个动作发不出去')
      return
    }
    pending = true
    paint()
  }

  function renderLegs (run) {
    ui.legs.textContent = ''
    const total = Math.max(0, Math.round(Number(run.totalLegs) || 0))
    for (let index = 1; index <= total; index += 1) {
      const dot = document.createElement('span')
      dot.className = 'leg'
      const walking = run.phase === 'walking'
      if (index < run.leg || (index === run.leg && !walking)) dot.classList.add('done')
      else if (walking ? index === run.leg : index === run.leg + 1) dot.classList.add('current')
      ui.legs.appendChild(dot)
    }
  }

  function emojiNode (text) {
    const span = document.createElement('span')
    span.className = 'emoji'
    span.textContent = text
    return span
  }

  /** 一格图鉴：有 SVG 用图（加载失败也回退 emoji），缺图直接用 emoji，没获得只剩剪影 + ???。 */
  function codexCell (slot) {
    const cell = document.createElement('div')
    cell.className = 'codexCell'
    cell.dataset.owned = slot.owned === true ? 'true' : 'false'
    cell.dataset.rarity = typeof slot.rarity === 'string' ? slot.rarity : ''
    cell.title = slot.owned === true
      ? slot.name + ' · ' + slot.rarityLabel
      : '还没见过这件特产'

    const art = document.createElement('span')
    art.className = 'codexArt'
    const emblem = view.slotEmblem(slot)
    if (emblem.kind === 'art') {
      const img = document.createElement('img')
      img.src = emblem.src
      img.alt = ''
      img.draggable = false
      img.addEventListener('error', () => {
        if (img.parentNode === art) art.replaceChildren(emojiNode(emblemFallback(slot)))
      })
      art.appendChild(img)
    } else {
      art.appendChild(emojiNode(emblem.text))
    }
    cell.appendChild(art)

    const name = document.createElement('span')
    name.className = 'codexName'
    name.textContent = slot.owned === true ? slot.label || slot.name : '???'
    cell.appendChild(name)

    const rarity = document.createElement('span')
    rarity.className = 'codexRarity'
    rarity.textContent = slot.rarityLabel || ''
    cell.appendChild(rarity)
    return cell
  }

  function emblemFallback (slot) {
    const emoji = typeof slot.emoji === 'string' ? slot.emoji.trim() : ''
    return emoji === '' ? '❔' : emoji
  }

  function renderCodex () {
    const codexView = state === null ? null : state.codexView
    ui.codexCount.textContent = view.codexProgress(codexView)
    ui.codexProgress.textContent = view.codexProgress(codexView)
    ui.codexGroups.textContent = ''
    const groups = view.codexGroups(codexView)
    if (groups.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'desc'
      empty.textContent = '图鉴还没准备好，出门走一段再看看。'
      ui.codexGroups.appendChild(empty)
      return
    }
    for (const group of groups) {
      const section = document.createElement('section')
      section.className = 'codexGroup'
      const title = document.createElement('h3')
      title.textContent = group.routeName
      const count = document.createElement('span')
      const owned = group.slots.filter((slot) => slot.owned === true).length
      count.textContent = String(owned) + '/' + String(group.slots.length)
      title.appendChild(count)
      section.appendChild(title)
      const grid = document.createElement('div')
      grid.className = 'codexGrid'
      for (const slot of group.slots) grid.appendChild(codexCell(slot))
      section.appendChild(grid)
      ui.codexGroups.appendChild(section)
    }
  }

  /** 日志页（票 116）：全部正文都只在这里出现，农场页只有标题。 */
  function renderLogs () {
    const entries = view.tripLogEntries(state)
    ui.logCount.textContent = String(entries.length) + ' 篇'
    ui.logList.textContent = ''
    if (entries.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'logEmpty'
      empty.textContent = '还没有日志。出趟门回来，这里会记下这一趟。'
      ui.logList.appendChild(empty)
      return
    }
    for (const entry of entries) {
      const article = document.createElement('article')
      article.className = 'logEntry'
      const head = document.createElement('div')
      head.className = 'logHead'
      const title = document.createElement('span')
      title.className = 'logTitle'
      title.textContent = entry.title
      const when = document.createElement('span')
      when.className = 'logWhen'
      when.textContent = entry.when
      head.appendChild(title)
      head.appendChild(when)
      article.appendChild(head)
      const body = document.createElement('p')
      body.className = 'logBody'
      body.textContent = entry.body
      article.appendChild(body)
      ui.logList.appendChild(article)
    }
  }

  function shelfArt (cell) {
    const art = document.createElement('span')
    art.className = 'shelfArt'
    if (cell.emblem.kind === 'art') {
      const img = document.createElement('img')
      img.src = cell.emblem.src
      img.alt = ''
      img.draggable = false
      img.addEventListener('error', () => {
        if (img.parentNode === art) art.replaceChildren(emojiNode('❔'))
      })
      art.appendChild(img)
    } else {
      art.appendChild(emojiNode(cell.emblem.text))
    }
    return art
  }

  function onShelfCell (cell) {
    if (pending) return
    const shelf = state === null ? null : state.shelf
    if (cell.locked) {
      // 只有下一格能开；后排的锁格只显示价格，避免窗口自己绕开顺序校验。
      if (shelf === null || cell.slot !== shelf.slots + 1) {
        toast('按顺序开，先把前面一格打开。')
        return
      }
      if (!view.canUnlock(shelf, cell.slot, state === null ? 0 : state.coins)) {
        toast('硬币不够开这一格。')
        return
      }
      send({ action: 'expedition-shelf', slot: cell.slot })
      return
    }
    if (cell.empty) {
      if (selectedSlot !== null) {
        const from = selectedSlot
        selectedSlot = null
        pendingItem = null
        send({ action: 'expedition-shelf', moveFrom: from, moveTo: cell.slot })
        return
      }
      if (pendingItem !== null) {
        const itemId = pendingItem
        pendingItem = null
        send({ action: 'expedition-shelf', slot: cell.slot, itemId })
        return
      }
      toast('先点一件特产。')
      return
    }
    pendingItem = null
    selectedSlot = selectedSlot === cell.slot ? null : cell.slot
    renderShelf()
  }

  function renderShelf () {
    const shelf = state === null ? null : state.shelf
    const cells = view.shelfCells(shelf, state === null ? null : state.codexView)
    const slots = shelf === null || typeof shelf !== 'object' ? 8 : shelf.slots
    ui.shelfCount.textContent = String(slots) + '/' + String(view.SHELF_MAX_SLOTS)
    ui.shelfProgress.textContent = view.shelfProgress(shelf)
    const placeable = view.placeableSouvenirs(shelf, state === null ? null : state.codexView)
    if (pendingItem !== null && !placeable.some((slot) => slot.id === pendingItem)) pendingItem = null
    ui.shelfPicker.textContent = ''
    const pickLabel = document.createElement('span')
    pickLabel.className = 'pickLabel'
    pickLabel.textContent = '可摆放：'
    ui.shelfPicker.appendChild(pickLabel)
    if (placeable.length === 0) {
      const none = document.createElement('span')
      none.className = 'pickLabel'
      none.textContent = '图鉴里还没有没上架的特产。'
      ui.shelfPicker.appendChild(none)
    }
    for (const slot of placeable) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'shelfPickItem'
      button.dataset.selected = String(pendingItem === slot.id)
      button.textContent = slot.name || slot.id
      button.title = '选中后点一个空格摆上去'
      button.addEventListener('click', () => {
        if (pending) return
        selectedSlot = null
        pendingItem = pendingItem === slot.id ? null : slot.id
        renderShelf()
      })
      ui.shelfPicker.appendChild(button)
    }
    ui.shelfGrid.textContent = ''
    for (const cell of cells) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'shelfCell'
      button.dataset.slot = String(cell.slot)
      button.dataset.locked = String(cell.locked)
      button.dataset.empty = String(cell.empty)
      button.dataset.selected = String(selectedSlot === cell.slot)
      const no = document.createElement('span')
      no.className = 'shelfSlotNo'
      no.textContent = String(cell.slot)
      button.appendChild(no)
      if (cell.locked) {
        button.dataset.next = String(cell.slot === slots + 1)
        button.title = cell.slot === slots + 1
          ? '花 ' + view.formatCoins(cell.price) + ' 硬币开这一格'
          : '先把前面一格打开'
        const lock = document.createElement('span')
        lock.className = 'shelfLock'
        lock.textContent = '🔒'
        button.appendChild(lock)
        const price = document.createElement('span')
        price.className = 'shelfPrice'
        price.textContent = view.formatCoins(cell.price)
        button.appendChild(price)
      } else if (cell.empty) {
        button.title = selectedSlot === null ? '空格' : '把选中的特产挪到这一格'
        const empty = document.createElement('span')
        empty.className = 'shelfPrice'
        empty.textContent = '空'
        button.appendChild(empty)
      } else {
        button.title = selectedSlot === cell.slot ? '取消选择' : '点一下选中，再点空格挪过去'
        button.appendChild(shelfArt(cell))
        const label = document.createElement('span')
        label.className = 'shelfLabel'
        label.textContent = cell.label
        button.appendChild(label)
      }
      button.addEventListener('click', () => onShelfCell(cell))
      ui.shelfGrid.appendChild(button)
    }
    const selected = selectedSlot === null
      ? null
      : cells.find((cell) => cell.slot === selectedSlot && !cell.empty) ?? null
    if (selected === null) selectedSlot = null
    ui.shelfTools.hidden = selected === null
    if (selected !== null) ui.shelfPick.textContent = '已选「' + selected.label + '」（第 ' + String(selected.slot) + ' 格）'
  }

  function setTab (name) {
    activeTab = name === 'codex'
      ? 'codex'
      : name === 'log'
        ? 'log'
        : name === 'shelf'
          ? 'shelf'
          : 'travel'
    const logActive = activeTab === 'log'
    const codexActive = activeTab === 'codex'
    const shelfActive = activeTab === 'shelf'
    ui.travelPane.hidden = logActive || codexActive || shelfActive
    ui.logPane.hidden = !logActive
    ui.codex.hidden = !codexActive
    ui.shelf.hidden = !shelfActive
    ui.tabTravel.classList.toggle('active', activeTab === 'travel')
    ui.tabLog.classList.toggle('active', logActive)
    ui.tabCodex.classList.toggle('active', codexActive)
    ui.tabShelf.classList.toggle('active', shelfActive)
    ui.tabTravel.setAttribute('aria-selected', String(activeTab === 'travel'))
    ui.tabLog.setAttribute('aria-selected', String(logActive))
    ui.tabCodex.setAttribute('aria-selected', String(codexActive))
    ui.tabShelf.setAttribute('aria-selected', String(shelfActive))
    if (logActive) renderLogs()
    if (codexActive) renderCodex()
    if (shelfActive) renderShelf()
  }

  /** home 的路线卡列表：亮卡可点，灰卡写明解锁条件与进度、点不动。 */
  function renderRoutes () {
    ui.routes.textContent = ''
    if (state === null) return
    const selected = activeRoute()
    for (const card of view.routeCards(state)) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'routeCard'
      button.dataset.locked = card.locked ? 'true' : 'false'
      button.dataset.active = selected !== null && card.id === selected.id ? 'true' : 'false'

      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = card.name
      button.appendChild(name)

      const hint = document.createElement('span')
      hint.className = 'hint'
      hint.textContent = card.hint
      button.appendChild(hint)

      if (card.locked) {
        const lock = document.createElement('span')
        lock.className = 'lock'
        lock.textContent = '解锁条件：' + card.requirement + '（' + card.progress + '）'
        button.appendChild(lock)
        button.disabled = true
        button.title = '还没解锁：' + card.progress
      } else {
        button.addEventListener('click', () => {
          selectedRoute = card.id
          paint()
        })
      }
      ui.routes.appendChild(button)
    }
  }

  function paint () {
    const run = state === null ? null : state.run
    const route = activeRoute()
    const codexView = state === null ? null : state.codexView
    ui.coins.textContent = view.formatCoins(state === null ? 0 : state.coins)
    ui.codexCount.textContent = view.codexProgress(codexView)
    const shelf = state === null ? null : state.shelf
    ui.shelfCount.textContent = String(shelf === null || typeof shelf !== 'object' ? 8 : shelf.slots) +
      '/' + String(view.SHELF_MAX_SLOTS)
    if (activeTab === 'codex') renderCodex()
    if (activeTab === 'log') renderLogs()
    if (activeTab === 'shelf') renderShelf()
    const offer = view.lanternOffer(state)
    ui.lanternText.textContent = offer.hint
    ui.lanternBuy.textContent = offer.label
    ui.lanternBuy.disabled = pending || offer.owned
    ui.homeNote.textContent = state !== null && (state.away === 'visiting' || state.away === 'working')
      ? '宠物现在不在家（' + (state.away === 'working' ? '打工' : '串门') + '），先等它回来。'
      : ''

    if (run === null || (browsing && !view.isActiveRun(run))) {
      browsing = run !== null
      ui.home.hidden = false
      ui.trip.hidden = true
      ui.done.hidden = true
      ui.routes.hidden = false
      renderRoutes()
      if (route !== null) {
        ui.routeName.textContent = route.name
        ui.routeHint.textContent = view.routeHint(route)
        ui.routeDesc.textContent =
          '交一次盘缠，走进' + route.name + '。每走一段掉一笔硬币；见好就收只带回已经走过的段数，盘缠不退。'
        ui.start.textContent = '交 ' + view.formatCoins(route.fare) + ' 盘缠，出发'
      }
      const allowed = route !== null && view.canStart(state, route)
      ui.start.disabled = pending || !allowed
      return
    }

    const active = view.isActiveRun(run)
    if (active) {
      browsing = false
      ui.home.hidden = true
      ui.routes.hidden = true
      ui.trip.hidden = false
      ui.done.hidden = true
      ui.phase.textContent = view.phaseLabel(run)
      ui.progress.textContent = view.progressText(run)
      ui.danger.textContent = view.dangerText(run)
      const loot = view.sumLoot(run)
      const souvenirs = view.souvenirNames(run, codexView)
      ui.loot.textContent = '这一趟已捡 ' + view.formatCoins(loot) + ' 枚硬币' +
        (souvenirs.length === 0 ? '' : ' · 特产 ' + souvenirs.join('、'))
      renderLegs(run)
      const continueAllowed = view.canContinue(run)
      ui.continue.disabled = pending || !continueAllowed
      ui.continue.textContent = view.primaryLabel(run)
      ui.back.disabled = pending || !view.canBack(run)
      updateClock()
      return
    }

    // 结算：run 还在，但 phase 已经 null、ended 有值。
    ui.home.hidden = true
    ui.routes.hidden = true
    ui.trip.hidden = true
    ui.done.hidden = false
    // 评审 A4：四种结局各一句，超时不再并进「见好就收」。
    const settledName = typeof run.routeName === 'string' && run.routeName !== ''
      ? run.routeName
      : (route === null ? '' : route.name)
    ui.doneTitle.textContent = view.settleTitle(run, settledName)
    ui.settle.textContent = view.settleText(run)
    const souvenirs = view.souvenirNames(run, codexView)
    if (souvenirs.length > 0) ui.settle.textContent += '，带回特产：' + souvenirs.join('、')
    ui.again.disabled = pending
  }

  function updateClock () {
    const run = state === null ? null : state.run
    if (!view.isActiveRun(run)) return
    const now = state.now + (Date.now() - receivedAt)
    const left = view.remainingMs(run, now)
    ui.clock.textContent = view.formatClock(left)
    if (left <= 0 && !refreshAsked && run.phase === 'walking') {
      refreshAsked = true
      send({ action: 'expedition-refresh' })
    }
  }

  function applyState (next) {
    if (next === null || typeof next !== 'object') return
    state = next
    selectedRoute = pickRoute(next.routes, selectedRoute)
    receivedAt = Date.now()
    refreshAsked = false
    // 票 120：农场页的陈列架入口要求开窗后直接落这一页；只在带 tab 的那一拍切，
    // 之后玩家自己点的页签不会被后续刷新抢回去。
    if (next.tab === 'shelf') setTab('shelf')
    paint()
  }

  ui.tabTravel.addEventListener('click', () => setTab('travel'))
  ui.tabLog.addEventListener('click', () => setTab('log'))
  ui.tabCodex.addEventListener('click', () => setTab('codex'))
  ui.tabShelf.addEventListener('click', () => setTab('shelf'))
  ui.shelfRemove.addEventListener('click', () => {
    if (selectedSlot === null || pending) return
    const from = selectedSlot
    selectedSlot = null
    send({ action: 'expedition-shelf', moveFrom: from })
  })
  ui.start.addEventListener('click', () => {
    const route = activeRoute()
    if (route === null) return
    send({ action: 'expedition-start', routeId: route.id })
  })
  ui.again.addEventListener('click', () => {
    const route = activeRoute()
    if (route === null) return
    browsing = false
    send({ action: 'expedition-start', routeId: route.id })
  })
  ui.browse.addEventListener('click', () => {
    browsing = true
    paint()
  })
  ui.continue.addEventListener('click', () => send({ action: 'expedition-step' }))
  ui.back.addEventListener('click', () => send({ action: 'expedition-back' }))
  ui.lanternBuy.addEventListener('click', () => send({ action: 'expedition-lantern' }))
  ui.close.addEventListener('click', () => {
    if (bridge !== undefined && typeof bridge.close === 'function') bridge.close()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && bridge !== undefined && typeof bridge.close === 'function') bridge.close()
  })

  setTab('travel')

  if (bridge !== undefined) {
    if (typeof bridge.onState === 'function') bridge.onState(applyState)
    if (typeof bridge.onResult === 'function') {
      bridge.onResult((result) => {
        pending = false
        if (result !== null && typeof result === 'object' && result.ok !== true) {
          toast(result.notice ?? '没成，再试一次')
        } else if (result !== null && typeof result === 'object' && typeof result.notice === 'string') {
          toast(result.notice)
        }
        paint()
      })
    }
    if (typeof bridge.ready === 'function') bridge.ready()
  }

  setInterval(updateClock, 250)
})()
