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
    tabCodex: el('tabCodex'),
    travelPane: el('travelPane'),
    lantern: el('lantern'),
    lanternText: el('lanternText'),
    lanternBuy: el('lanternBuy'),
    home: el('home'),
    routeName: el('routeName'),
    routeHint: el('routeHint'),
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
    codex: el('codex'),
    codexCount: el('codexCount'),
    codexProgress: el('codexProgress'),
    codexGroups: el('codexGroups'),
    toast: el('toast')
  }

  let state = null
  let pending = false
  let toastTimer = null
  let activeTab = 'travel'
  /** 收到 view 那一刻的本地时间；倒计时按 now 在此之后的增量走。 */
  let receivedAt = 0
  let refreshAsked = false

  function activeRoute () {
    if (state === null || !Array.isArray(state.routes) || state.routes.length === 0) return null
    const runRouteId = state.run === null || state.run === undefined ? null : state.run.routeId
    return state.routes.find((route) => route.id === runRouteId) ?? state.routes[0]
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

  function setTab (name) {
    activeTab = name === 'codex' ? 'codex' : 'travel'
    const codexActive = activeTab === 'codex'
    ui.travelPane.hidden = codexActive
    ui.codex.hidden = !codexActive
    ui.tabTravel.classList.toggle('active', !codexActive)
    ui.tabCodex.classList.toggle('active', codexActive)
    ui.tabTravel.setAttribute('aria-selected', String(!codexActive))
    ui.tabCodex.setAttribute('aria-selected', String(codexActive))
    if (codexActive) renderCodex()
  }

  function paint () {
    const run = state === null ? null : state.run
    const route = activeRoute()
    const codexView = state === null ? null : state.codexView
    ui.coins.textContent = view.formatCoins(state === null ? 0 : state.coins)
    ui.codexCount.textContent = view.codexProgress(codexView)
    if (activeTab === 'codex') renderCodex()
    const offer = view.lanternOffer(state)
    ui.lanternText.textContent = offer.hint
    ui.lanternBuy.textContent = offer.label
    ui.lanternBuy.disabled = pending || offer.owned
    ui.homeNote.textContent = state !== null && (state.away === 'visiting' || state.away === 'working')
      ? '宠物现在不在家（' + (state.away === 'working' ? '打工' : '串门') + '），先等它回来。'
      : ''

    if (run === null) {
      ui.home.hidden = false
      ui.trip.hidden = true
      ui.done.hidden = true
      if (route !== null) {
        ui.routeName.textContent = route.name
        ui.routeHint.textContent =
          '盘缠 ' + view.formatCoins(route.fare) +
          ' · ' + String(route.minLegs) + '–' + String(route.maxLegs) + ' 段 · 每段回 ' +
          view.formatCoins(Math.round(route.coinBase * 0.75)) + '–' +
          view.formatCoins(Math.round(route.coinBase * 1.25)) + ' 枚'
        ui.start.textContent = '交 ' + view.formatCoins(route.fare) + ' 盘缠，出发'
      }
      const allowed = route !== null && view.canStart(state, route)
      ui.start.disabled = pending || !allowed
      return
    }

    const active = view.isActiveRun(run)
    if (active) {
      ui.home.hidden = true
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
    ui.trip.hidden = true
    ui.done.hidden = false
    ui.doneTitle.textContent = run.ended === 'complete'
      ? '走满了全程'
      : run.ended === 'failed' ? '翻车了' : '见好就收'
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
    receivedAt = Date.now()
    refreshAsked = false
    paint()
  }

  ui.tabTravel.addEventListener('click', () => setTab('travel'))
  ui.tabCodex.addEventListener('click', () => setTab('codex'))
  ui.start.addEventListener('click', () => {
    const route = activeRoute()
    if (route === null) return
    send({ action: 'expedition-start', routeId: route.id })
  })
  ui.again.addEventListener('click', () => {
    const route = activeRoute()
    if (route === null) return
    send({ action: 'expedition-start', routeId: route.id })
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
