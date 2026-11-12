/**
 * 渲染端：把宿主给的场景 v3 画成桌面宠物，并在本地跑 60fps 物理。
 *
 * 分工（ticket 08）：
 *   - 宿主决定「有谁/叫什么/在播什么」（scene.items 的 id/role/label/anim/color）；
 *   - 这里决定「在哪/多快/朝哪飞」，逐帧把命中矩形报给主进程（`reportRects`）；
 *   - 主进程用真实光标 + 这份矩形裁定点击穿透，位置过期就 fail-closed 回穿透。
 *
 * 素材：dsh-pet 的 WebM 经 helper 的 `dshzoo://asset/<name>.webm` 协议加载；
 * 动作取不到 → 轮播真实存在的待机片段 → 仍取不到才画内置 SVG 色块。
 * 页面是 file://，这里**没有** `/dsh-pet-7340/thumb/...` 可用。
 *
 * 拖拽：pointerdown 立刻申请输入租约（busy），每 300ms 续期；pointerup/pointercancel/
 * window blur/页面隐藏/2.5s 无移动都会释放。宠物落后于光标时，租约 + 一条跟随光标的
 * `ui:drag` 命中矩形一起保持窗口可交互，pointermove/pointerup 才不会断。
 *
 * 控件（ticket 11 / 57）：
 *   - 悬停/点击自己的宠物 → 弹层（串门 / 改名）；
 *   - 自己不在家（串门 / 去偷 / 在外打工）时桌面上没有 self：用常驻胶囊代替，
 *     点开是「不在家」面板（农场 / 邻居 / 带派 / 改名 / 召回或叫它回家 / 更多），
 *     右键胶囊直接开完整菜单。没有这个入口，宠物一出门整张桌面就什么都点不到；
 *   - 点击访客 → 弹层（送客）；放行卡由场景里的 controls.prompt 驱动；
 *   - 弹层**不持有输入租约**：它和宠物之间的 8px 间隙由 overlay 的桥接矩形盖住，
 *     光标离开宠物与弹层后窗口立刻回到穿透——点桌面别处不会被弹层吃掉；
 *   - 弹层/卡片/胶囊的矩形单独上报（dsh-zoo:overlay-rects），主进程只认这些矩形；
 *   - 关闭/离开/失焦/超时/场景 reset 都会撤掉控件矩形；渲染端整个死掉时主进程按矩形过期兜底。
 *   - 点击只是一次**申请**（dsh-zoo:action），状态永远等宿主的场景/action-result 回灌。
 */

;(function () {
  'use strict'

  const shared = globalThis.DshZooShared
  const api = globalThis.dshZooDesktop
  const stage = document.getElementById('stage')
  const uiLayer = document.getElementById('ui-layer')
  if (!shared || !stage || !uiLayer) return

  const IDLE_ROTATE_MS = 8000
  /** 宠物在动时的矩形上报节拍；静止时降到心跳，避免无意义 IPC。 */
  const RECT_REPORT_MS = 33
  const RECT_HEARTBEAT_MS = 300
  /** 拖拽中这么久没有任何 pointermove：渲染端自己收手（主进程的租约会更早过期）。 */
  const DRAG_TIMEOUT_MS = 2500
  /** 弹层最长打开时间；到点自己关掉并撤掉命中矩形，绝不无限期留在桌面上。 */
  const UI_MAX_OPEN_MS = 12000
  /** 光标离开宠物与弹层后的宽限：够跨过 ~8px 的间隙，又不至于让弹层赖着不走。 */
  const UI_LEAVE_GRACE_MS = 500
  /** 失败提示的停留时间；要求“一小会儿”，不能永久糊在桌面上。 */
  const NOTICE_VISIBLE_MS = 4200
  /** 控件申请的兜底超时：宿主没答复也必须冒一句人话，不能静默。 */
  const ACTION_TIMEOUT_MS = 2600
  /** 场景里带回来的旧 notice 只在这段时间内冒泡；避免 helper 重启把陈年旧事翻出来。 */
  const NOTICE_MAX_AGE_MS = 30000
  /** 浮动控件与锚点之间的间隙。 */
  const UI_GAP = 8
  /** 某一户换了动作时，它自己探头多久（ticket 21）。 */
  const STREET_PEEK_MS = 700
  /** 点击判定：按下到松开的位移/时长都小才算一次点击，否则是拖拽。 */
  const CLICK_MAX_MOVE = 5
  const CLICK_MAX_MS = 600
  /**
   * 拖拽时跟随光标的命中半径。宠物是弹簧跟随，快速拖动时光标会跑到宠物矩形外面；
   * 主进程的输入租约又只认“光标压在一条活矩形上”，所以拖拽期间额外报一条以光标为
   * 中心的小矩形（`ui:drag`）。它只覆盖光标附近，不会把整窗变成可交互。
   */
  const DRAG_HIT_RADIUS = 80

  let scene = shared.normalizeScene(null)
  let area = readArea()
  /**
   * 地面带：宿主随场景下发的 `floors` 合并成“可以连续走的水平带”
   * （同高相邻的屏是一条；高度不同的屏各自一条，见 `shared.walkBands`）。
   * 空数组 = 单屏 / 老宿主：不限制，物理退回整张桌面。
   */
  let bands = []
  let pointer = null
  let hoverInside = false
  let hoverTimer = null
  let busy = false
  let busyTimer = null
  let lastRectsAt = 0
  let lastFrameAt = 0
  let drag = null
  /** 胶囊的拖动（ticket 57 现场反馈：常驻胶囊挡住视线时必须能挪开）。null = 没在拖。 */
  let chipDrag = null
  /** 调试脚本派发的拖拽期间，忽略真实光标的转发事件（冒烟没法移动用户鼠标）。 */
  let syntheticDrag = false
  /** 调试脚本完全接管输入时，连悬停/焦点事件也不看真实环境（冒烟可复现）。 */
  let inputLocked = false
  let rafId = 0

  /**
   * 桌面控件的全部可变状态。输入租约只有一条来源：拖拽（drag !== null）。
   * 弹层/放行卡/召回胶囊都不持有租约——它们靠 overlay 命中矩形按需接管鼠标。
   */
  const ui = {
    popover: null, // { petId, kind, el, signature, openedAt, lastActiveAt }
    menu: null, // { petId, root, panels: [{ level, el }], openedAt, lastActiveAt, leaveTimer }
    street: null, // { petId, el, head, title, grid, more, actions, showBlocked, openedAt, lastActiveAt }
    prompt: null, // { key, deviceId, nickname, el }
    // ticket 23：giftId → { el, deviceId, giftId, status, titleEl, bodyEl, statusEl, signature }
    gifts: new Map(),
    // ticket 11/57：「宠物不在家」的常驻胶囊（自己出门串门、去偷、在外打工都算）。
    recall: null, // { el, mainEl }
    // ticket 57：胶囊点开的面板（农场 / 邻居 / 带派 / 改名 / 召回 / 更多）。
    awayPanel: null, // { el, signature, openedAt, lastActiveAt }
    // ticket 57 现场反馈：胶囊挡住视线时用户会把它拖走。用户拖过之后就不再跟着
    // 宠物最后出现的位置（null = 还没拖过，照旧锚在 promptAnchor）；只在本次运行内记住。
    awayChipPos: null, // { x, y } 窗口局部 DIP
    notice: null, // { text, at, el, timer }
    hiddenPromptKey: null,
    hoverSuppressed: false,
    suppressedPetId: null,
    leaveTimer: null,
    openTimer: null,
    actionSeq: 0,
    pending: new Map(),
    lastNoticeAt: 0,
    lastSelfRect: null,
    layoutAt: 0,
    overlaySignature: '',
    lastOverlayAt: 0,
    lastDragRectAt: 0
  }

  const ACTION_FAILED_NOTICE = '这次操作没有完成，稍后再试。'
  const ACTION_TIMEOUT_NOTICE = '桌面宿主没有回应，这次操作可能没有生效。'

  /** id → pet。场景是唯一权威：不在场景里的 pet 立即销毁。 */
  const pets = new Map()

  function readArea () {
    return {
      width: Math.max(1, Math.round(window.innerWidth)),
      height: Math.max(1, Math.round(window.innerHeight))
    }
  }

  /**
   * 宠物脚下是哪条地面带（窗口局部 DIP）。
   *
   * 同高相邻的屏是一条带，可以在上面来回走；高度不同的屏各自一条带，宠物不会走进
   * 矮屏下方那块没有显示器的黑区。用身体中心找带：中心落在哪条带的水平范围里，
   * 就取竖直方向最近的那条；中心在水平空洞里才退回 2D 最近。
   */
  function bandOf (body) {
    return shared.bandAt(bands, {
      x: body.x + body.width / 2,
      y: body.y + body.height / 2
    })
  }

  function reportHover (inside) {
    if (!api || typeof api.reportHover !== 'function') return
    try {
      api.reportHover(inside === true)
    } catch {
      // 主进程没了/管道断了：窗口本来就会随进程消失
    }
  }

  function currentRects () {
    const rects = []
    for (const pet of pets.values()) {
      const body = pet.body
      rects.push({ id: pet.id, x: body.x, y: body.y, width: body.width, height: body.height })
    }
    return rects
  }

  function reportRects (force) {
    if (!api || typeof api.reportRects !== 'function') return
    const now = performance.now()
    const interval = isMoving() ? RECT_REPORT_MS : RECT_HEARTBEAT_MS
    if (force !== true && now - lastRectsAt < interval) return
    lastRectsAt = now
    try {
      api.reportRects(currentRects())
    } catch {
      // 下一次心跳会再试
    }
  }

  function isMoving () {
    if (drag !== null) return true
    for (const pet of pets.values()) {
      const body = pet.body
      if (Math.abs(body.vx) > 0.4 || Math.abs(body.vy) > 0.4) return true
      if (body.y < area.height - body.height - 0.5) return true
    }
    return false
  }

  function sendBusy () {
    if (!api || typeof api.setBusy !== 'function') return
    try {
      api.setBusy(busy)
    } catch {
      // 管道断了：主进程会按租约超时自己收回
    }
  }

  function setBusy (next) {
    const value = next === true
    if (value === busy) {
      // 已经 busy 时再调一次 = 一次显式续期（pointerdown 后不会等 300ms 心跳）。
      if (value) sendBusy()
      return
    }
    busy = value
    sendBusy()
    if (value) {
      if (busyTimer === null) {
        busyTimer = setInterval(() => {
          if (busy) sendBusy()
        }, shared.BUSY_HEARTBEAT_MS)
      }
    } else if (busyTimer !== null) {
      clearInterval(busyTimer)
      busyTimer = null
    }
  }

  /** 唯一需要输入租约的是拖拽：宠物落后于光标时位置判定必须让位；胶囊拖动同理。 */
  function updateLease () {
    setBusy(drag !== null || chipDrag !== null)
  }

  function stopHoverHeartbeat () {
    if (hoverTimer === null) return
    clearInterval(hoverTimer)
    hoverTimer = null
  }

  function releaseHover () {
    stopHoverHeartbeat()
    if (!hoverInside) return
    hoverInside = false
    reportHover(false)
  }

  /**
   * 控件矩形（弹层/放行卡/胶囊）是第二批命中区。它们不参与物理，但必须能被主进程看见，
   * 否则控件一旦不报矩形（失焦/超时/调试冻结）按钮就再也点不到。
   * 桥接矩形把锚点宠物和控件之间的间隙也盖住，光标横穿时不会短暂落空。
   */
  function uiRects () {
    const rects = []
    const rectOf = (id, el) => {
      if (el === null || el === undefined || el.hidden === true) return null
      const box = el.getBoundingClientRect()
      if (!(box.width > 0) || !(box.height > 0)) return null
      const rect = { id, x: box.left, y: box.top, width: box.width, height: box.height }
      return rect
    }
    const add = (id, el) => {
      const rect = rectOf(id, el)
      if (rect !== null) rects.push(rect)
      return rect
    }

    // 顺序有讲究：drag/bridge 在前、容器其次、按钮最后。hitTestRects 倒序扫描，
    // 因此按钮 > 卡片/弹层 > 桥接矩形 > 拖拽矩形；诊断 itemId 不会停在辅助矩形上。
    if (drag !== null) {
      const pet = pets.get(drag.id)
      const point = drag.point
      if (pet !== undefined && point !== null) {
        const around = {
          x: point.x - DRAG_HIT_RADIUS,
          y: point.y - DRAG_HIT_RADIUS,
          width: DRAG_HIT_RADIUS * 2,
          height: DRAG_HIT_RADIUS * 2
        }
        const union = shared.unionRect([
          { x: pet.body.x, y: pet.body.y, width: pet.body.width, height: pet.body.height },
          around
        ])
        if (union !== null) rects.push({ id: 'ui:drag', ...union })
      }
    }

    const popoverRect = ui.popover === null ? null : rectOf('ui:popover', ui.popover.el)
    if (popoverRect !== null) {
      const pet = pets.get(ui.popover.petId)
      if (pet !== undefined) {
        const bridge = shared.unionRect([popoverRect, { x: pet.body.x, y: pet.body.y, width: pet.body.width, height: pet.body.height }])
        if (bridge !== null) rects.push({ id: 'ui:bridge:popover', ...bridge })
      }
      rects.push(popoverRect)
      for (const button of ui.popover.el.querySelectorAll('[data-lp-action]')) {
        add('ui:btn:' + button.dataset.lpAction, button)
      }
    }

    const promptRect = ui.prompt === null ? null : rectOf('ui:prompt', ui.prompt.el)
    if (promptRect !== null) {
      const bridge = shared.unionRect([promptRect, promptAnchor()])
      if (bridge !== null) rects.push({ id: 'ui:bridge:prompt', ...bridge })
      rects.push(promptRect)
      for (const button of ui.prompt.el.querySelectorAll('[data-lp-action]')) {
        add('ui:btn:' + button.dataset.lpAction, button)
      }
    }

    // 礼物卡（ticket 23）：矩形与按钮都带 giftId；桥接矩形把它和**那位访客**连起来。
    for (const entry of ui.gifts.values()) {
      const rect = rectOf('ui:gift:' + entry.giftId, entry.el)
      if (rect === null) continue
      const pet = pets.get('visitor:' + entry.deviceId)
      if (pet !== undefined) {
        const bridge = shared.unionRect([rect, anchorOfPet(pet)])
        if (bridge !== null) rects.push({ id: 'ui:gift-bridge:' + entry.giftId, ...bridge })
      }
      rects.push(rect)
      for (const button of entry.el.querySelectorAll('[data-lp-action]')) {
        add('ui:gift-btn:' + button.dataset.lpAction + ':' + entry.giftId, button)
      }
    }

    const streetRect = ui.street === null ? null : rectOf('ui:street', ui.street.el)
    if (streetRect !== null) {
      const bridge = shared.unionRect([streetRect, promptAnchor()])
      if (bridge !== null) rects.push({ id: 'ui:bridge:street', ...bridge })
      rects.push(streetRect)
      for (const button of ui.street.el.querySelectorAll('[data-lp-action]')) {
        const device = typeof button.dataset.lpDevice === 'string' && button.dataset.lpDevice !== ''
          ? ':' + button.dataset.lpDevice
          : ''
        add('ui:street:' + button.dataset.lpAction + device, button)
      }
    }

    if (ui.menu !== null) {
      const panels = []
      for (const panel of ui.menu.panels) {
        const rect = rectOf('ui:menu:' + String(panel.level), panel.el)
        if (rect !== null) panels.push(rect)
      }
      // 桥接只连"一级面板 ↔ 宠物"，不把整串子菜单并进来：并集会变成一大块可交互区，
      // 等于在桌面上挖掉一片本该穿透的地方。
      const pet = pets.get(ui.menu.petId)
      if (panels.length > 0 && pet !== undefined) {
        const bridge = shared.unionRect([panels[0], anchorOfPet(pet)])
        if (bridge !== null) rects.push({ id: 'ui:menu-bridge', ...bridge })
      }
      for (const rect of panels) rects.push(rect)
    }

    if (ui.recall !== null) add('ui:recall-chip', ui.recall.el)

    // 胶囊拖动（ticket 57 现场反馈）：和宠物拖拽同一个理由——快速拖动时命中矩形
    // 必须跟着光标走，否则主进程按 900ms 过期把窗口翻回穿透，pointermove/up 就断了。
    if (chipDrag !== null && chipDrag.point !== null) {
      const around = {
        x: chipDrag.point.x - DRAG_HIT_RADIUS,
        y: chipDrag.point.y - DRAG_HIT_RADIUS,
        width: DRAG_HIT_RADIUS * 2,
        height: DRAG_HIT_RADIUS * 2
      }
      const chipRect = ui.recall === null ? null : elementRect(ui.recall.el)
      const union = shared.unionRect(chipRect === null ? [around] : [chipRect, around])
      if (union !== null) rects.push({ id: 'ui:chip-drag', ...union })
    }

    // 「不在家」面板（ticket 57）：和弹层同一条规矩——面板、按钮各自上报，
    // 再加一条「胶囊 ↔ 面板」的桥接矩形，光标横穿间隙时窗口不会先翻回穿透。
    const awayRect = ui.awayPanel === null ? null : rectOf('ui:away-panel', ui.awayPanel.el)
    if (awayRect !== null) {
      const chipRect = ui.recall === null ? null : elementRect(ui.recall.el)
      const bridge = shared.unionRect([awayRect, chipRect ?? promptAnchor()])
      if (bridge !== null) rects.push({ id: 'ui:bridge:away', ...bridge })
      rects.push(awayRect)
      for (const button of ui.awayPanel.el.querySelectorAll('[data-lp-action]')) {
        add('ui:away:' + button.dataset.lpAction, button)
      }
    }
    return rects
  }

  function allHitRects () {
    const overlays = uiRects()
    const petRects = currentRects()
    // 宠物排在后面：hitTestRects 倒序扫描，重叠时先命中宠物（诊断/拖拽都依赖这一点）。
    return overlays.concat(petRects)
  }

  function hitAt (point) {
    if (point === null) return null
    return shared.hitTestRects(allHitRects(), point)
  }

  /** 只命中宠物（用于“点到了谁/悬停谁”），不会把弹层按钮误当成宠物。 */
  function petAt (point) {
    if (point === null) return null
    const rect = shared.hitTestRects(currentRects(), point)
    return rect === null ? null : (pets.get(rect.id) ?? null)
  }

  function reportOverlayRects (force) {
    if (!api || typeof api.reportOverlayRects !== 'function') return
    const now = performance.now()
    const rects = uiRects()
    const signature = JSON.stringify(rects)
    if (force !== true && signature === ui.overlaySignature && now - ui.lastOverlayAt < RECT_HEARTBEAT_MS) {
      return
    }
    ui.overlaySignature = signature
    ui.lastOverlayAt = now
    try {
      api.reportOverlayRects(rects)
    } catch {
      // 下一次心跳会再试
    }
  }

  /** 按当前本地位置重新判定光标是否在命中区（宠物或控件）里；force 时即使没变也重报。 */
  function evaluate (point, force) {
    if (point !== null) pointer = point
    const inside = point !== null && hitAt(point) !== null
    if (inside === hoverInside && force !== true) return
    hoverInside = inside
    if (inside) {
      if (hoverTimer === null) {
        hoverTimer = setInterval(() => {
          if (hoverInside && drag === null) reportHover(true)
        }, shared.HOVER_HEARTBEAT_MS)
      }
    } else {
      stopHoverHeartbeat()
    }
    reportHover(inside)
  }

  // -------------------------------------------------------------------------
  // 场景 → DOM / 物理体
  // -------------------------------------------------------------------------

  function applyScene (raw) {
    const next = shared.normalizeScene(raw)
    const reset = next.reset === true
    scene = next
    bands = shared.walkBands(next.floors)
    syncPets(reset)
    applyOrder()
    syncControls(reset)
    evaluate(pointer, true)
    reportRects(true)
  }

  function syncPets (reset) {
    const alive = new Set()
    for (const item of scene.items) {
      if (item.kind !== 'pet') continue
      alive.add(item.id)
      let pet = pets.get(item.id)
      if (pet === undefined) {
        pet = createPet(item)
        pets.set(item.id, pet)
      } else {
        pet.item = item
        if (reset) {
          pet.body = spawnBody(item)
          if (drag !== null && drag.id === pet.id) abortDrag()
        } else if (pet.body.width !== item.width || pet.body.height !== item.height) {
          pet.body = shared.confineBodyToBand({
            x: pet.body.x,
            y: pet.body.y,
            width: item.width,
            height: item.height,
            vx: pet.body.vx,
            vy: pet.body.vy
          }, area, bandOf({ ...pet.body, width: item.width, height: item.height }))
        }
        updateNode(pet)
      }
      applyTransform(pet)
    }
    for (const [id, pet] of [...pets]) {
      if (alive.has(id)) continue
      if (drag !== null && drag.id === id) abortDrag()
      if (ui.menu !== null && ui.menu.petId === id) closeMenu('gone')
      destroyPet(pet)
      pets.delete(id)
    }
  }

  function spawnBody (item) {
    const velocity = shared.initialVelocity(item.id)
    return shared.confineBodyToBand({
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      vx: velocity.vx,
      vy: velocity.vy
    }, area, shared.bandAt(bands, { x: item.x + item.width / 2, y: item.y + item.height / 2 }))
  }

  function createPet (item) {
    const el = document.createElement('div')
    el.className = 'lp-pet'
    el.dataset.id = item.id
    const mediaBox = document.createElement('div')
    mediaBox.className = 'lp-pet-media'
    const nameEl = document.createElement('span')
    nameEl.className = 'lp-pet-name'
    // ticket 44：雇工角标固定「打工」，不是自由文本（host 只发枚举 badge:'work'）。
    const badgeEl = document.createElement('span')
    badgeEl.className = 'lp-pet-badge'
    badgeEl.textContent = '打工'
    badgeEl.hidden = true
    el.appendChild(mediaBox)
    el.appendChild(nameEl)
    el.appendChild(badgeEl)
    el.addEventListener('pointerdown', onPetPointerDown)
    el.addEventListener('mousedown', onPetMouseDown)
    el.addEventListener('contextmenu', onPetContextMenu)
    stage.appendChild(el)

    const pet = {
      id: item.id,
      item,
      body: spawnBody(item),
      // 「回到初始位置」回这里：它第一次出现时宿主给的那个出生点。场景后续的 x/y 只是
      // "如果要重出生就用这个"，不会让已经在场上的宠物瞬移，所以不能拿它当 home。
      spawn: { x: item.x, y: item.y },
      el,
      mediaBox,
      nameEl,
      badgeEl,
      video: null,
      svg: null,
      badge: null,
      nodeWidth: -1,
      nodeHeight: -1,
      media: {
        clip: null,
        src: null,
        source: 'pending',
        anim: null,
        failed: new Set(),
        idleIndex: shared.hashString(item.id) % shared.IDLE_CLIPS.length,
        nextIdleAt: 0,
        clipStartedAt: 0,
        durationMs: 0,
        poolKey: '',
        gaveUp: false,
        // 本机兜底点播：{ name, until }。有它时 updateMedia 优先播这一段。
        local: null
      }
    }
    updateNode(pet)
    updateMedia(pet, performance.now())
    applyTransform(pet)
    return pet
  }

  function updateNode (pet) {
    const item = pet.item
    const role = item.role === 'self' || item.role === 'visitor' || item.role === 'worker'
      ? item.role
      : 'guest'
    if (pet.el.dataset.role !== role) pet.el.dataset.role = role
    // 角标是固定枚举：只有 work 才画（渲染端不猜也不接受任意字符串）。
    const showBadge = item.badge === 'work'
    if (pet.badgeEl.hidden !== !showBadge) pet.badgeEl.hidden = !showBadge
    if (pet.el.getAttribute('aria-label') !== item.label) {
      pet.el.setAttribute('aria-label', item.label)
      pet.el.setAttribute('role', 'img')
    }
    if (pet.nameEl.textContent !== item.label) {
      pet.nameEl.textContent = item.label
      pet.nameEl.title = item.label
    }
  }

  function applyTransform (pet) {
    const body = pet.body
    if (pet.item.role === 'self') {
      // 自己出门后桌面没有 self：召回胶囊/放行卡锚在它最后出现的位置。
      ui.lastSelfRect = { x: body.x, y: body.y, width: body.width, height: body.height }
    }
    if (pet.nodeWidth !== body.width || pet.nodeHeight !== body.height) {
      pet.nodeWidth = body.width
      pet.nodeHeight = body.height
      pet.el.style.width = body.width + 'px'
      pet.el.style.height = body.height + 'px'
    }
    pet.el.style.transform = 'translate3d(' + body.x.toFixed(2) + 'px,' + body.y.toFixed(2) + 'px,0)'
  }

  function applyOrder () {
    // appendChild 会把已有节点移到末尾：DOM 顺序 = 场景顺序（后画在上，命中判定也按这个顺序）。
    for (const item of scene.items) {
      const pet = pets.get(item.id)
      if (pet !== undefined) stage.appendChild(pet.el)
    }
  }

  function destroyPet (pet) {
    if (pet.video !== null) {
      try {
        pet.video.pause()
        pet.video.removeAttribute('src')
        pet.video.load()
      } catch {
        // 已经没了
      }
    }
    pet.el.removeEventListener('pointerdown', onPetPointerDown)
    pet.el.removeEventListener('mousedown', onPetMouseDown)
    pet.el.removeEventListener('contextmenu', onPetContextMenu)
    pet.el.remove()
  }

  // -------------------------------------------------------------------------
  // 桌面控件（ticket 11）：弹层 / 放行卡 / 召回胶囊 / 提示气泡
  // -------------------------------------------------------------------------

  function elementRect (el) {
    if (el === null || el === undefined || el.hidden === true) return null
    const box = el.getBoundingClientRect()
    if (!(box.width > 0) || !(box.height > 0)) return null
    return { x: box.left, y: box.top, width: box.width, height: box.height }
  }

  function pointInRect (point, rect) {
    return point !== null && rect !== null &&
      point.x >= rect.x && point.x < rect.x + rect.width &&
      point.y >= rect.y && point.y < rect.y + rect.height
  }

  function pointInElement (point, el) {
    return pointInRect(point, elementRect(el))
  }

  function intersectionArea (a, b) {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    return width > 0 && height > 0 ? width * height : 0
  }

  /**
   * 把浮动控件放在锚点旁边，并尽量不盖住任何宠物/已放置的控件。
   * 四个方向都放不下时退到屏幕四角；仍放不下则选重叠面积最小的位置。
   * 屏幕再小也不把控件放到窗口外——否则按钮就真的点不到了。
   */
  function positionFloating (el, anchor, options = {}) {
    const margin = 8
    const gap = Number.isFinite(options.gap) ? options.gap : UI_GAP
    const width = Math.max(1, el.offsetWidth || 120)
    const height = Math.max(1, el.offsetHeight || 40)
    const viewport = {
      width: Math.max(1, Math.round(window.innerWidth)),
      height: Math.max(1, Math.round(window.innerHeight))
    }
    const clampX = (value) => Math.min(Math.max(margin, value), Math.max(margin, viewport.width - width - margin))
    const clampY = (value) => Math.min(Math.max(margin, value), Math.max(margin, viewport.height - height - margin))
    const avoid = (Array.isArray(options.avoid) ? options.avoid : [])
      .filter((rect) => rect !== null && typeof rect === 'object' && rect.width > 0 && rect.height > 0)
    const candidates = [
      { x: anchor.x + anchor.width + gap, y: anchor.y + (anchor.height - height) / 2 },
      { x: anchor.x - width - gap, y: anchor.y + (anchor.height - height) / 2 },
      { x: anchor.x + (anchor.width - width) / 2, y: anchor.y - height - gap },
      { x: anchor.x + (anchor.width - width) / 2, y: anchor.y + anchor.height + gap },
      { x: margin, y: margin },
      { x: viewport.width - width - margin, y: margin },
      { x: margin, y: viewport.height - height - margin },
      { x: viewport.width - width - margin, y: viewport.height - height - margin }
    ]
    let best = null
    for (const candidate of candidates) {
      const rect = { x: clampX(candidate.x), y: clampY(candidate.y), width, height }
      let overlap = 0
      for (const other of avoid) overlap += intersectionArea(rect, other)
      // 锚点宠物本身是硬约束：宁可压到别的宠物/控件，也绝不盖住“我”的宠物本体。
      if (intersectionArea(rect, anchor) > 0) overlap += 1e9
      if (overlap === 0) {
        el.style.left = rect.x.toFixed(1) + 'px'
        el.style.top = rect.y.toFixed(1) + 'px'
        return rect
      }
      if (best === null || overlap < best.overlap) best = { rect, overlap }
    }
    el.style.left = best.rect.x.toFixed(1) + 'px'
    el.style.top = best.rect.y.toFixed(1) + 'px'
    return best.rect
  }

  function anchorOfPet (pet) {
    const body = pet.body
    return { x: body.x, y: body.y, width: body.width, height: body.height }
  }

  /** 自己出门时桌面没有 self；放行卡/召回胶囊锚在它最后出现的位置。 */
  function promptAnchor () {
    const self = pets.get('self')
    if (self !== undefined) return anchorOfPet(self)
    if (ui.lastSelfRect !== null) return ui.lastSelfRect
    return {
      x: Math.max(0, Math.round(area.width / 2 - 88)),
      y: Math.max(0, Math.round(area.height - 220)),
      width: 176,
      height: 176
    }
  }

  function makeButton (label, action, options = {}) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'lp-btn' + (options.tone === 'quiet' ? ' lp-btn-quiet' : options.tone === 'danger' ? ' lp-btn-danger' : '')
    button.textContent = label
    button.dataset.lpAction = action
    if (typeof options.deviceId === 'string' && options.deviceId !== '') button.dataset.lpDevice = options.deviceId
    // 「叫它回家」要带合同号（recall-worker）；按钮自己不知道合同，只在宿主给了时才挂上。
    if (typeof options.contractId === 'string' && options.contractId !== '') {
      button.dataset.lpContract = options.contractId
    }
    // 礼物按钮必须带 giftId：矩形 id 与 action 都要能落回具体那一张卡（两张卡不撞名）。
    if (typeof options.giftId === 'string' && options.giftId !== '') button.dataset.lpGift = options.giftId
    if (options.disabled === true) {
      button.dataset.disabled = 'true'
      button.dataset.reason = typeof options.reason === 'string' ? options.reason : ''
      button.setAttribute('aria-disabled', 'true')
      button.title = typeof options.reason === 'string' ? options.reason : ''
    }
    return button
  }

  function visitorDeviceId (pet) {
    if (pet === null || pet === undefined) return null
    const id = pet.item.id
    if (typeof id !== 'string' || !id.startsWith('visitor:')) return null
    return id.slice('visitor:'.length) || null
  }

  function popoverSignature () {
    return JSON.stringify({
      visit: scene.controls.visit,
      recall: scene.controls.recall,
      visitors: scene.controls.visitors
    })
  }

  function buildPopover (pet, kind) {
    const el = document.createElement('div')
    el.className = 'lp-popover'
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-label', kind === 'self' ? '我的宠物' : pet.item.label)

    if (kind === 'self') {
      const visit = scene.controls.visit
      el.appendChild(makeButton('串门', 'open-street', {
        disabled: visit.enabled !== true,
        reason: visit.reason === null ? '现在还不能串门。' : visit.reason
      }))
      if (visit.enabled !== true) {
        const why = document.createElement('div')
        why.className = 'lp-why'
        why.textContent = visit.reason === null ? '现在还不能串门。' : visit.reason
        el.appendChild(why)
      }
      if (scene.controls.recall.enabled === true) el.appendChild(makeButton('召回', 'recall'))
      // 改名（ticket 13）：名字只有一份，改的是宿主那边 dsh-pet 的配置（ADR-0007）。
      el.appendChild(makeButton('改名', 'rename', { tone: 'quiet' }))
    } else {
      const deviceId = visitorDeviceId(pet)
      const info = deviceId === null
        ? undefined
        : scene.controls.visitors.find((candidate) => candidate.deviceId === deviceId)
      const title = document.createElement('div')
      title.className = 'lp-popover-title'
      title.textContent = pet.item.label
      el.appendChild(title)
      el.appendChild(makeButton('送客', 'end-visit', {
        deviceId: info?.deviceId ?? deviceId ?? undefined,
        disabled: info === undefined,
        reason: '这位访客已经不在桌面上了。'
      }))
      if (info === undefined) {
        const why = document.createElement('div')
        why.className = 'lp-why'
        why.textContent = '这位访客已经不在桌面上了。'
        el.appendChild(why)
      }
    }
    return el
  }

  function cancelLeaveTimer () {
    if (ui.leaveTimer === null) return
    clearTimeout(ui.leaveTimer)
    ui.leaveTimer = null
  }

  function cancelOpenTimer () {
    if (ui.openTimer === null) return
    clearTimeout(ui.openTimer)
    ui.openTimer = null
  }

  function resetOpenTimer () {
    cancelOpenTimer()
    ui.openTimer = setTimeout(() => {
      ui.openTimer = null
      if (ui.popover !== null) closePopover('timeout')
      if (ui.street !== null) closeStreet('timeout')
      if (ui.menu !== null) closeMenu('timeout')
      if (ui.awayPanel !== null) hideAwayPanel('timeout')
    }, UI_MAX_OPEN_MS)
  }

  /**
   * 打开弹层：先关掉旧的（不 suppress），挂 DOM、定位、开始超时。
   * 不拿输入租约：光标从宠物跨过间隙走到按钮时，靠 overlay 的桥接矩形接管鼠标；
   * 离开宠物与弹层之后窗口必须立刻回到穿透（否则点桌面别处会被弹层吃掉）。
   */
  function openPopover (pet) {
    if (pet === null || pet === undefined) return
    const kind = pet.item.role === 'self' ? 'self' : pet.item.role === 'visitor' ? 'visitor' : null
    if (kind === null) return
    if (ui.popover !== null && ui.popover.petId === pet.id) return
    closePopover('replace', { suppress: false })
    const el = buildPopover(pet, kind)
    el.addEventListener('pointerdown', (event) => event.stopPropagation())
    uiLayer.appendChild(el)
    ui.popover = {
      petId: pet.id,
      kind,
      el,
      signature: popoverSignature(),
      openedAt: performance.now(),
      lastActiveAt: performance.now()
    }
    ui.hoverSuppressed = false
    ui.suppressedPetId = null
    cancelLeaveTimer()
    layoutUi(true)
    resetOpenTimer()
    reportOverlayRects(true)
  }

  /**
   * 关闭弹层并立刻撤掉它的命中矩形。suppress=true 表示“这次是用户/超时关的”，
   * 光标还停在自己的宠物上时不要马上又弹出——必须离开再回来。
   */
  function closePopover (reason, options = {}) {
    if (ui.popover === null) return
    const current = ui.popover
    ui.popover = null
    cancelLeaveTimer()
    cancelOpenTimer()
    try {
      current.el.remove()
    } catch {
      // 已经没了
    }
    if (options.suppress !== false) {
      ui.hoverSuppressed = true
      ui.suppressedPetId = current.petId
    }
    reportOverlayRects(true)
    layoutUi(true)
  }

  // -------------------------------------------------------------------------
  // 右键菜单（ticket 22 / ADR-0010）
  //
  // 只挂自己的宠物。菜单是自绘 DOM：宿主下发树（scene.menu），这里只负责画和收。
  // 每一级面板都是**平级**的绝对定位盒子：右/下贴边翻到另一侧，各自独立滚动。
  // 菜单矩形进 overlay-rects，整窗其余部分继续穿透——点菜单外不关菜单（那一击要落到桌面）。
  // -------------------------------------------------------------------------

  /** 面板与父项之间的缝；和 owner 的 item 挨得够近，但不至于盖住父项。 */
  const MENU_GAP = 2
  const MENU_MARGIN = 4

  function menuUsable (menu) {
    if (menu === null || typeof menu !== 'object') return false
    const tools = Array.isArray(menu.tools) ? menu.tools.length : 0
    const groups = Array.isArray(menu.groups) ? menu.groups.length : 0
    return tools > 0 || groups > 0
  }

  function onPetContextMenu (event) {
    if (inputLocked && event.isTrusted) return
    const pet = pets.get(event.currentTarget.dataset.id)
    if (pet === undefined || pet.item.role !== 'self') return
    event.preventDefault()
    event.stopPropagation()
    if (!menuUsable(scene.menu)) return
    if (ui.menu !== null && ui.menu.petId === pet.id) {
      closeMenu('toggle')
      return
    }
    openMenu(pet, event.clientX, event.clientY)
  }

  /**
   * 打开菜单。`pet` 通常是自己的宠物；宠物不在家时（ticket 57）传 null，
   * 锚点换成胶囊/「更多」按钮：菜单内容与宿主下发的那棵树完全一样，只是没有可停住的宠物。
   */
  function openMenu (pet, x, y) {
    closeMenu('replace')
    closePopover('menu', { suppress: false })
    closeStreet('menu')
    hideAwayPanel('menu')
    const root = document.createElement('div')
    root.className = 'lp-menu'
    root.setAttribute('role', 'menu')
    root.addEventListener('pointerdown', (event) => event.stopPropagation())
    root.addEventListener('click', onMenuClick)
    uiLayer.appendChild(root)
    ui.menu = {
      petId: pet === null ? null : pet.id,
      root,
      panels: [],
      // 一级的两个分支共用 1/2 级面板：branch 决定 1 级画分类还是画「外观」（ticket 32）。
      branch: 'anim',
      groupIndex: 0,
      hoverRow: null,
      openedAt: performance.now(),
      lastActiveAt: performance.now(),
      leaveTimer: null
    }
    // 停住：菜单悬停期间它不飞、不漫游（dsh-pet 的 stopThrow/stopMove 同一个意思）。
    if (pet !== null) {
      pet.body = shared.confineBodyToBand({ ...pet.body, vx: 0, vy: 0 }, area, bandOf(pet.body))
    }
    openMenuPanel(0, { x, y, width: 0, height: 0 })
    resetOpenTimer()
    reportOverlayRects(true)
  }

  function closeMenu (reason) {
    if (ui.menu === null) return
    const current = ui.menu
    ui.menu = null
    if (current.leaveTimer !== null) clearTimeout(current.leaveTimer)
    try {
      current.root.remove()
    } catch {
      // 已经没了
    }
    void reason
    reportOverlayRects(true)
  }

  function trimMenuPanels (level) {
    if (ui.menu === null) return
    while (ui.menu.panels.length > level) {
      const panel = ui.menu.panels.pop()
      try {
        panel.el.remove()
      } catch {
        // 已经没了
      }
    }
  }

  /**
   * 打开第 level 级面板，锚点是父项那一条（一级菜单用指针处的一个点）。
   * 先裁掉更深的旧面板：悬停换了分类，上一串子菜单必须立刻消失，不能留在屏幕上。
   */
  function openMenuPanel (level, anchor) {
    if (ui.menu === null) return
    trimMenuPanels(level)
    const el = buildMenuPanel(level)
    if (el === null) return
    el.dataset.level = String(level)
    ui.menu.root.appendChild(el)
    const rect = shared.placeMenu(
      anchor,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: Math.max(1, Math.round(window.innerWidth)), height: Math.max(1, Math.round(window.innerHeight)) },
      { margin: MENU_MARGIN, gap: MENU_GAP }
    )
    el.style.left = rect.x.toFixed(1) + 'px'
    el.style.top = rect.y.toFixed(1) + 'px'
    ui.menu.panels.push({ level, el })
    ui.menu.lastActiveAt = performance.now()
    reportOverlayRects(true)
  }

  function menuRow (label, options = {}) {
    const row = document.createElement('div')
    row.className = 'lp-menu-item'
    row.setAttribute('role', 'menuitem')
    if (options.kind === 'tool') {
      row.dataset.menuKind = 'tool'
      row.dataset.menuId = options.id
    } else if (options.kind === 'branch') {
      row.dataset.menuKind = 'branch'
      row.dataset.menuBranch = options.branch === 'skin' ? 'skin' : 'anim'
    } else if (options.kind === 'skin') {
      row.dataset.menuKind = 'skin'
      row.dataset.menuId = options.id
    } else if (options.kind === 'group') {
      row.dataset.menuKind = 'group'
      row.dataset.menuGroup = String(options.index)
    } else if (options.kind === 'anim') {
      row.dataset.menuKind = 'anim'
      row.dataset.menuAnim = options.name
    }
    const text = document.createElement('span')
    text.className = 'lp-menu-label'
    text.textContent = label
    row.appendChild(text)
    if (typeof options.hint === 'string' && options.hint !== '') {
      const hint = document.createElement('span')
      hint.className = 'lp-menu-hint'
      hint.textContent = options.hint
      row.appendChild(hint)
    }
    if (options.arrow === true) {
      const arrow = document.createElement('span')
      arrow.className = 'lp-menu-arrow'
      arrow.textContent = '›'
      row.appendChild(arrow)
    }
    return row
  }

  function buildMenuPanel (level) {
    const menu = scene.menu
    const panel = document.createElement('div')
    panel.className = 'lp-menu-panel'
    panel.setAttribute('role', 'menu')
    if (level === 0) {
      for (const tool of menu.tools) {
        // 「回到初始位置」只在宠物真的在桌面上时才有意思（ticket 57：不在家时菜单
        // 从胶囊打开，点了什么也不会发生——宁可少一项，不给假入口）。
        if (tool.id === 'home' && !pets.has('self')) continue
        panel.appendChild(menuRow(tool.label, { kind: 'tool', id: tool.id, hint: tool.hint }))
      }
      if (menu.groups.length > 0) {
        panel.appendChild(menuRow('动作', { kind: 'branch', branch: 'anim', arrow: true }))
      }
      // 只有一张皮时不出现「外观」：一个选项的菜单只是噪音（ticket 32）。
      if (menu.skins.length > 1) {
        panel.appendChild(menuRow('外观', { kind: 'branch', branch: 'skin', arrow: true }))
      }
      return panel
    }
    const branch = ui.menu === null ? 'anim' : ui.menu.branch
    if (level === 1 && branch === 'skin') {
      for (const skin of menu.skins) {
        panel.appendChild(menuRow(skin.label, {
          kind: 'skin',
          id: skin.id,
          hint: skin.id === menu.activeSkin ? '✓' : undefined
        }))
      }
      return panel
    }
    if (level === 1) {
      menu.groups.forEach((group, index) => {
        panel.appendChild(menuRow(group.label, { kind: 'group', index, arrow: true }))
      })
      return panel
    }
    const group = menu.groups[ui.menu === null ? 0 : ui.menu.groupIndex]
    if (group === undefined) return null
    for (const name of group.actions) {
      panel.appendChild(menuRow(name, { kind: 'anim', name }))
    }
    return panel
  }

  /**
   * 悬停切链：跟着指针走（pointermove），不靠 mouseover——整窗在穿透与可交互之间翻，
   * 指针事件才是每个输入路径都会有的那一份。
   */
  function updateMenuPointer (point) {
    if (ui.menu === null || point === null) return
    const element = document.elementFromPoint(point.x, point.y)
    const row = element === null ? null : element.closest('.lp-menu-item')
    if (row === null || row === ui.menu.hoverRow) return
    ui.menu.hoverRow = row
    ui.menu.lastActiveAt = performance.now()
    const kind = row.dataset.menuKind
    const panel = row.closest('.lp-menu-panel')
    const level = panel === null ? 0 : Number(panel.dataset.level)
    const rect = row.getBoundingClientRect()
    if (kind === 'branch') {
      ui.menu.branch = row.dataset.menuBranch === 'skin' ? 'skin' : 'anim'
      openMenuPanel(1, { x: rect.right, y: rect.top, width: 0, height: 0 })
    } else if (kind === 'group') {
      ui.menu.groupIndex = Number(row.dataset.menuGroup)
      openMenuPanel(2, { x: rect.right, y: rect.top, width: 0, height: 0 })
    } else {
      trimMenuPanels(level + 1)
    }
  }

  function onMenuClick (event) {
    if (ui.menu === null) return
    const target = event.target
    if (!(target instanceof Element)) return
    const row = target.closest('.lp-menu-item')
    if (row === null) return
    event.preventDefault()
    event.stopPropagation()
    const kind = row.dataset.menuKind
    ui.lastMenuClick = { kind, name: row.dataset.menuAnim ?? null, id: row.dataset.menuId ?? null, at: performance.now() }
    if (kind === 'tool') {
      const id = row.dataset.menuId
      const petId = ui.menu.petId
      closeMenu('action')
      runMenuTool(id, petId)
      return
    }
    if (kind === 'anim') {
      const name = row.dataset.menuAnim
      const petId = ui.menu.petId
      closeMenu('action')
      playAnimFromMenu(petId, name)
    }
    if (kind === 'skin') {
      // 换皮只发一条申请：注册表、落盘和场景重建都在宿主那边（ADR-0013）。
      const skinId = row.dataset.menuId
      closeMenu('action')
      requestAction('use-skin', undefined, { skinId })
    }
    // branch / group 只是展开，点击不收起
  }

  function runMenuTool (id, petId) {
    const pet = pets.get(petId)
    if (id === 'home') {
      if (pet !== undefined) homePet(pet)
      return
    }
    // 「带派」只发一个空动作（ticket 24）：开窗与背包内容全由宿主决定，渲染端不碰输入。
    // 「农场」（ticket 40/46）：同样是空申请；开/关由宿主按小窗的真实状态切换。
    // 扫描外观（ticket 37）：和「重载配置」一样只是一次申请，扫与写全在宿主那边。
    if (id === 'reload' || id === 'open-site' || id === 'bring' || id === 'scan-skins' || id === 'farm') {
      requestAction(id === 'farm' ? 'farm-open' : id)
    }
  }

  /** 「回到初始位置」：只动这一只，回到它自己的出生点。不牵连访客，也不用全场景 reset。 */
  function homePet (pet) {
    const spawn = pet.spawn ?? { x: pet.item.x, y: pet.item.y }
    pet.body = shared.confineBodyToBand({
      x: spawn.x,
      y: spawn.y,
      width: pet.body.width,
      height: pet.body.height,
      vx: 0,
      vy: 0
    }, area, shared.bandAt(bands, { x: spawn.x + pet.body.width / 2, y: spawn.y + pet.body.height / 2 }))
    applyTransform(pet)
    reportRects(true)
  }

  function playAnimFromMenu (petId, name) {
    const pet = pets.get(petId)
    if (pet === undefined) return
    // 「动作」来自当前这张皮时，名字只在皮自己的目录里存在（dsh-pet 不认识）。
    // 直接在本机播：送 `/anim` 只会被拒，再冒一句没必要的失败提示。
    if (scene.menu.actionsLocal === true) {
      playLocalAnim(pet, name)
      return
    }
    const fallback = () => playLocalAnim(pet, name)
    // 先申请本体的点播；宿主说不行（没装/不可达/被拒）再退成本机播一次。
    requestAction('play-anim', undefined, { name, fallback })
  }

  /**
   * 本机兜底：在影子上播一次，并在这一段结束前不让 `/state` 把它盖回去。
   * 只影响本地表现——本体的动作仍然是它自己的事（ADR-0009 的降级路径）。
   */
  function playLocalAnim (pet, name) {
    if (name === null || name === undefined || name === '') return
    pet.media.failed.delete(name)
    pet.media.local = { name, until: performance.now() + 8000 }
    playClip(pet, name)
    reportOverlayRects(true)
  }

  // -------------------------------------------------------------------------
  // 邻居面板（ticket 21）：那条小街
  // -------------------------------------------------------------------------

  /**
   * 去不了的那一户，第二行说什么。
   * 这里只有“此刻为什么去不了”的短句；点击失败仍然是 visit-copy.js 那一套长句，
   * 两边不许各自发明理由。
   */
  function streetStatusText (row) {
    if (row.blockedReason === 'peer-offline') return '刚掉线了'
    if (row.blockedReason === 'not-mutual') return '它还没放行你'
    if (row.blockedReason === 'not-admitted') return '你还没放行它'
    return '现在去不了'
  }

  /**
   * 一户人家的脸色与屋顶，都从 deviceId 哈希来，同一个人每次都长一样。
   * 屋顶单独一套暖色：和脸色同色的话，那颗头看着像戴了顶自己的帽子。
   */
  const ROOF_COLORS = ['#f4a8a8', '#f7d17e', '#9ed5c0', '#b5b8e8', '#f0b48c']

  function streetColors (deviceId) {
    const palette = shared.PET_COLORS.slice(1)
    const hash = shared.hashString(deviceId)
    return { face: palette[hash % palette.length], roof: ROOF_COLORS[hash % ROOF_COLORS.length] }
  }

  function buildHouse (row) {
    const house = document.createElement(row.canVisit === true ? 'button' : 'div')
    house.className = 'lp-house'
    house.dataset.canVisit = row.canVisit === true ? 'true' : 'false'
    house.title = row.label
    if (row.canVisit === true) {
      house.type = 'button'
      house.dataset.lpAction = 'visit'
    }
    house.dataset.lpDevice = row.deviceId
    // 票 54：右键这一户 = 看看他家的农场（ADR-0018 之后不需要放行）。
    // 左键仍然是「去串门」，两个动作不抢同一个手势。
    house.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      requestAction('farm-look', row.deviceId)
    })

    const top = document.createElement('span')
    top.className = 'lp-house-top'
    const colors = streetColors(row.deviceId)
    const roof = document.createElement('span')
    roof.className = 'lp-roof'
    roof.style.setProperty('--lp-roof', colors.roof)
    const wall = document.createElement('span')
    wall.className = 'lp-wall'
    const face = document.createElement('span')
    face.className = 'lp-face'
    face.style.background = colors.face
    for (const side of ['l', 'r']) {
      const eye = document.createElement('i')
      eye.className = 'lp-eye lp-eye-' + side
      face.appendChild(eye)
    }
    wall.appendChild(face)
    top.appendChild(roof)
    top.appendChild(wall)

    const name = document.createElement('span')
    name.className = 'lp-house-name'
    name.textContent = row.label
    const doing = document.createElement('span')
    doing.className = 'lp-house-doing'
    // 能去的说它在干什么，去不了的说为什么去不了——第二行永远有字，不留空。
    doing.textContent = row.canVisit === true
      ? (typeof row.action === 'string' && row.action !== '' ? row.action : '在附近')
      : streetStatusText(row)

    house.appendChild(top)
    house.appendChild(name)
    house.appendChild(doing)
    return house
  }

  /** 那一户自己探一次头；用一次性动画，不常驻，免得整条街一直动。 */
  function peekHouse (house) {
    const face = house.querySelector('.lp-face')
    if (face === null) return
    face.dataset.peek = 'true'
    setTimeout(() => {
      if (face.isConnected) delete face.dataset.peek
    }, STREET_PEEK_MS)
  }

  function openStreet (petId) {
    closeStreet('replace')
    const el = document.createElement('div')
    el.className = 'lp-street'
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-label', '邻居')
    const head = document.createElement('div')
    head.className = 'lp-street-head'
    const grid = document.createElement('div')
    grid.className = 'lp-street-grid'
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'lp-street-more'
    more.dataset.lpAction = 'street-more'
    el.appendChild(head)
    el.appendChild(grid)
    el.appendChild(more)
    el.addEventListener('pointerdown', (event) => event.stopPropagation())
    uiLayer.appendChild(el)

    ui.street = {
      petId,
      el,
      head,
      grid,
      more,
      actions: new Map(),
      order: [],
      rows: new Map(),
      showBlocked: false,
      openedAt: performance.now(),
      lastActiveAt: performance.now()
    }
    renderStreet()
    reportOverlayRects(true)
    layoutUi(true)
  }

  function closeStreet (reason) {
    if (ui.street === null) return
    const current = ui.street
    ui.street = null
    try {
      current.el.remove()
    } catch {
      // 已经没了
    }
    reportOverlayRects(true)
    layoutUi(true)
  }

  function renderStreet () {
    const street = ui.street
    if (street === null) return
    const rows = Array.isArray(scene.controls.street) ? scene.controls.street : []
    const recall = scene.controls.recall
    const away = recall.enabled === true

    street.el.dataset.away = away ? 'true' : 'false'
    street.head.textContent = ''
    const title = document.createElement('span')
    title.className = 'lp-street-title'
    const visitable = rows.filter((row) => row.canVisit === true)
    if (away) {
      // 抬头说清它在哪、在干什么（宿主算好的人话）；按钮跟着 mode 走：
      // 串门/偷菜是召回，打工是叫它回家（ticket 57）。
      title.textContent = recall.title ?? recall.text ?? '宠物不在家'
      street.head.appendChild(title)
      street.head.appendChild(awayPrimaryButton(recall))
    } else {
      title.textContent = '邻居'
      const sub = document.createElement('span')
      sub.className = 'lp-street-sub'
      sub.textContent = visitable.length + ' 位在附近'
      street.head.appendChild(title)
      street.head.appendChild(sub)
    }

    const blocked = rows.filter((row) => row.canVisit !== true)
    const rowsById = new Map(rows.map((row) => [row.deviceId, row]))

    // 顺序冻结（bug 修复）：面板开着的时候，已经在这条街上的人不动位置，新来的排到队尾。
    // 宿主每来一轮心跳都会按 lastSeen 重排一次；照搬那个顺序，房子就在光标底下换位置，
    // 于是点空或者点到隔壁。
    const alive = new Set(rowsById.keys())
    street.order = street.order.filter((deviceId) => alive.has(deviceId))
    for (const row of rows) {
      if (!street.order.includes(row.deviceId)) street.order.push(row.deviceId)
    }

    // 就地更新，不重建节点（bug 修复之二）：光标底下那个元素被换成新节点，
    // 一次 click 的 pointerdown/pointerup 就落在两个元素上，浏览器干脆不派发 click。
    const wanted = []
    const peeked = []
    for (const deviceId of street.order) {
      const row = rowsById.get(deviceId)
      if (row === undefined) continue
      if (row.canVisit !== true && street.showBlocked !== true) continue
      let entry = street.rows.get(deviceId)
      if (entry === undefined || entry.canVisit !== (row.canVisit === true)) {
        const el = buildHouse(row)
        entry = {
          el,
          canVisit: row.canVisit === true,
          name: el.querySelector('.lp-house-name'),
          doing: el.querySelector('.lp-house-doing'),
          face: el.querySelector('.lp-face')
        }
        street.rows.set(deviceId, entry)
      }
      if (entry.name.textContent !== row.label) entry.name.textContent = row.label
      if (entry.el.title !== row.label) entry.el.title = row.label
      const text = row.canVisit === true
        ? (typeof row.action === 'string' && row.action !== '' ? row.action : '在附近')
        : streetStatusText(row)
      if (entry.doing.textContent !== text) entry.doing.textContent = text
      wanted.push(entry.el)
      // 谁换了动作，哪户探个头：面板因此是活的，又不会一直吵。
      if (row.canVisit === true) {
        const seen = street.actions.get(deviceId)
        if (seen !== undefined && seen !== row.action && row.action !== null) peeked.push(entry.el)
      }
      street.actions.set(deviceId, row.action)
    }
    for (const deviceId of [...street.actions.keys()]) {
      if (!alive.has(deviceId)) street.actions.delete(deviceId)
    }

    for (const [deviceId, entry] of [...street.rows]) {
      if (!wanted.includes(entry.el)) {
        entry.el.remove()
        street.rows.delete(deviceId)
      }
    }

    // 顺序没变就一个字都不动 DOM：每 2 秒一轮心跳都重排一次，悬停和探头会被打断。
    const current = [...street.grid.children]
    const sameOrder = wanted.length > 0 &&
      current.length === wanted.length &&
      current.every((el, index) => el === wanted[index])
    if (!sameOrder) {
      street.grid.textContent = ''
      for (const el of wanted) street.grid.appendChild(el)
      if (wanted.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'lp-street-empty'
        empty.textContent = away ? '它现在在外面。' : '这条街还只有你一家。'
        street.grid.appendChild(empty)
      }
    }
    for (const el of peeked) peekHouse(el)

    street.more.hidden = blocked.length === 0 || away
    street.more.textContent = street.showBlocked
      ? '收起 ›'
      : '附近还有 ' + blocked.length + ' 位，现在去不了 ›'

    layoutUi(true)
  }

  function syncStreet () {
    if (ui.street === null) return
    renderStreet()
  }

  /** 光标离开面板与锚点宠物后的宽限关闭；和弹层同一套手感。 */
  function updateStreetHover () {
    if (ui.street === null || pointer === null) return
    const street = ui.street
    const inside = pointInElement(pointer, street.el)
    const self = pets.get(street.petId)
    const onAnchor = self !== undefined && pointInRect(pointer, anchorOfPet(self))
    if (inside || onAnchor) {
      street.lastActiveAt = performance.now()
      cancelLeaveTimer()
      resetOpenTimer()
      return
    }
    if (ui.leaveTimer !== null) return
    ui.leaveTimer = setTimeout(() => {
      ui.leaveTimer = null
      if (ui.street === street) closeStreet('leave')
    }, UI_LEAVE_GRACE_MS)
  }

  function maybeOpenHoverControls () {
    // 菜单开着时不再弹左键弹层：右键菜单和悬停弹层是两套入口，同时出现会互相抢鼠标。
    if (pointer === null || drag !== null || ui.popover !== null || ui.menu !== null || !uiLayer) return
    const pet = petAt(pointer)
    // 悬停抑制只对“被关掉的那只宠物”生效：光标还停在它身上时不要原地重弹；
    // 指针一旦离开它（例如从放行卡按钮移回宠物），抑制就解除。
    if (ui.hoverSuppressed) {
      if (pet !== null && pet.id === ui.suppressedPetId) return
      ui.hoverSuppressed = false
      ui.suppressedPetId = null
    }
    if (pet === null) return
    if (pet.item.role !== 'self') return
    openPopover(pet)
  }

  /** 光标离开弹层与锚点宠物后，给一小段宽限再关闭。 */
  function updateUiHover () {
    updateStreetHover()
    updateMenuHover()
    updateAwayHover()
    if (ui.popover === null || pointer === null) return
    const current = ui.popover
    const pet = pets.get(current.petId)
    const insidePopover = pointInElement(pointer, current.el)
    const insidePet = pet !== undefined && pointInRect(pointer, anchorOfPet(pet))
    if (insidePopover || insidePet) {
      current.lastActiveAt = performance.now()
      cancelLeaveTimer()
      resetOpenTimer()
      return
    }
    if (ui.leaveTimer !== null) return
    ui.leaveTimer = setTimeout(() => {
      ui.leaveTimer = null
      if (ui.popover === current) closePopover('leave')
    }, UI_LEAVE_GRACE_MS)
  }

  /**
   * 菜单的收起：点菜单外不关（那一击已经落到桌面上了），只能靠"移开"和超时。
   * 光标从宠物跨进菜单要穿过一小段缝，所以给和弹层同一档宽限。
   */
  /**
   * 光标是不是压在菜单上。
   *
   * 不能量 `.lp-menu` 根节点：它里面全是 `position:absolute` 的面板，根节点自己 0×0，
   * 于是"在菜单里"永远判 false —— 光标一离开宠物，500ms 宽限一到菜单就自己关了
   * （用户看到的"一瞬间就消失"）。真正有尺寸的是每一级面板。
   */
  function menuContainsPoint (point) {
    if (ui.menu === null || point === null) return false
    for (const panel of ui.menu.panels) {
      if (pointInRect(point, elementRect(panel.el))) return true
    }
    return false
  }

  function updateMenuHover () {
    if (ui.menu === null || pointer === null) return
    const current = ui.menu
    const pet = pets.get(current.petId)
    const insideMenu = menuContainsPoint(pointer)
    const insidePet = pet !== undefined && pointInRect(pointer, anchorOfPet(pet))
    if (insideMenu || insidePet) {
      current.lastActiveAt = performance.now()
      if (current.leaveTimer !== null) {
        clearTimeout(current.leaveTimer)
        current.leaveTimer = null
      }
      resetOpenTimer()
      return
    }
    if (current.leaveTimer !== null) return
    current.leaveTimer = setTimeout(() => {
      current.leaveTimer = null
      if (ui.menu === current) closeMenu('leave')
    }, UI_LEAVE_GRACE_MS)
  }

  // -------------------------------------------------------------------------
  // 放行卡
  // -------------------------------------------------------------------------

  function hidePrompt (options = {}) {
    if (ui.prompt === null) return
    try {
      ui.prompt.el.remove()
    } catch {
      // 已经没了
    }
    ui.prompt = null
    if (options.forget !== false) ui.hiddenPromptKey = null
    reportOverlayRects(true)
    layoutUi(true)
  }

  function buildPrompt (prompt) {
    hidePrompt({ forget: false })
    const el = document.createElement('div')
    el.className = 'lp-card'
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-label', '新邻居 ' + prompt.nickname)

    const head = document.createElement('div')
    head.className = 'lp-card-head'
    const title = document.createElement('div')
    title.className = 'lp-card-title'
    title.textContent = '新邻居「' + prompt.nickname + '」'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'lp-x'
    close.dataset.lpAction = 'dismiss'
    close.dataset.lpDevice = prompt.deviceId
    close.setAttribute('aria-label', '稍后再说')
    close.title = '稍后再说'
    close.textContent = '×'
    head.appendChild(title)
    head.appendChild(close)

    const text = document.createElement('p')
    text.className = 'lp-card-text'
    text.textContent = '接受后，你们才能互相串门。'

    const actions = document.createElement('div')
    actions.className = 'lp-card-actions'
    actions.appendChild(makeButton('接受', 'admit', { deviceId: prompt.deviceId }))
    actions.appendChild(makeButton('拒绝', 'reject', { deviceId: prompt.deviceId, tone: 'quiet' }))

    el.appendChild(head)
    el.appendChild(text)
    el.appendChild(actions)
    el.addEventListener('pointerdown', (event) => event.stopPropagation())
    uiLayer.appendChild(el)
    ui.prompt = { key: prompt.deviceId, deviceId: prompt.deviceId, nickname: prompt.nickname, el }
    ui.hiddenPromptKey = null
    reportOverlayRects(true)
    layoutUi(true)
  }

  function syncPrompt () {
    const prompt = scene.controls.prompt
    if (prompt === null) {
      hidePrompt()
      return
    }
    if (ui.hiddenPromptKey === prompt.deviceId) {
      if (ui.prompt !== null) hidePrompt({ forget: false })
      return
    }
    if (ui.prompt !== null && ui.prompt.key === prompt.deviceId) {
      if (ui.prompt.nickname !== prompt.nickname) {
        // 昵称会随心跳更新：只改文字，不重建按钮，避免打断用户。
        const title = ui.prompt.el.querySelector('.lp-card-title')
        if (title !== null) title.textContent = '新邻居「' + prompt.nickname + '」'
        ui.prompt.nickname = prompt.nickname
      }
      return
    }
    buildPrompt(prompt)
  }

  function setPromptBusy (busyNow) {
    if (ui.prompt === null) return
    for (const button of ui.prompt.el.querySelectorAll('[data-lp-action]')) {
      button.dataset.disabled = busyNow === true ? 'true' : 'false'
      button.setAttribute('aria-disabled', busyNow === true ? 'true' : 'false')
    }
  }

  // -------------------------------------------------------------------------
  // 礼物卡（ticket 23）
  //
  // 卡片贴在**那位访客**旁边，不是贴在自己旁边：礼物是“谁捎来的”，不是“给我的提醒”。
  // 内容全部来自 scene.controls.gifts（标题/正文/状态文案由宿主算好），渲染端只画。
  // 矩形进 overlay-rects（卡 + 按钮 + 与访客之间的桥接），整窗其余部分照旧穿透。
  // -------------------------------------------------------------------------

  function giftSignature (gift) {
    return JSON.stringify({
      title: gift.title,
      kind: gift.kind,
      text: gift.text ?? null,
      name: gift.name ?? null,
      size: gift.size ?? null,
      thumb: gift.thumb ?? null,
      status: gift.status,
      statusText: gift.statusText ?? null
    })
  }

  /** 文件大小只给人看个量级；精确字节数没有意义，也不该让卡片挤成一团。 */
  function formatFileSize (bytes) {
    if (!Number.isInteger(bytes) || bytes <= 0) return ''
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) {
      return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + ' KB'
    }
    return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB'
  }

  function setGiftButtonsEnabled (entry, enabled) {
    for (const button of entry.el.querySelectorAll('[data-lp-action]')) {
      // 「扔掉」在哪种状态下都该能点：写坏了的礼物更需要能清理掉。
      const allowed = enabled || button.dataset.lpAction === 'gift-discard'
      button.dataset.disabled = allowed ? 'false' : 'true'
      button.setAttribute('aria-disabled', allowed ? 'false' : 'true')
      if (!allowed) {
        button.title = '东西还没收下，稍等一下。'
        button.dataset.reason = '东西还没收下，稍等一下。'
      } else {
        button.removeAttribute('title')
        delete button.dataset.reason
      }
    }
  }

  function buildGiftCard (gift) {
    const el = document.createElement('div')
    el.className = 'lp-card lp-gift-card'
    // 卡片右上角的小邮票按 kind 写「信」或「件」（纯装饰，内容仍以标题为准）。
    el.dataset.kind = gift.kind === 'file' ? 'file' : 'text'
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-label', gift.title)

    const head = document.createElement('div')
    head.className = 'lp-card-head'
    const title = document.createElement('div')
    title.className = 'lp-card-title'
    head.appendChild(title)

    // 正文走 textContent + CSS pre-wrap：便条的换行是内容，不能被折掉，也绝不解析 HTML。
    const body = document.createElement('p')
    body.className = 'lp-gift-text'

    // 文件卡（ticket 25）：缩略图只在宿主给了 thumb 时出现；没有就画文件图标 + 名字 + 大小。
    // 图片同样走 textContent/URL 白名单：src 来自宿主校验过的 dshzoo://gifts/...
    const fileBox = document.createElement('div')
    fileBox.className = 'lp-gift-file'
    fileBox.hidden = true
    const thumb = document.createElement('img')
    thumb.className = 'lp-gift-thumb'
    thumb.alt = ''
    thumb.draggable = false
    thumb.hidden = true
    const fileRow = document.createElement('div')
    fileRow.className = 'lp-gift-file-row'
    const fileIcon = document.createElement('span')
    fileIcon.className = 'lp-gift-file-icon'
    fileIcon.setAttribute('aria-hidden', 'true')
    fileIcon.textContent = '▤'
    const fileMeta = document.createElement('span')
    fileMeta.className = 'lp-gift-file-meta'
    const fileName = document.createElement('span')
    fileName.className = 'lp-gift-file-name'
    const fileSize = document.createElement('span')
    fileSize.className = 'lp-gift-file-size'
    fileMeta.appendChild(fileName)
    fileMeta.appendChild(fileSize)
    fileRow.appendChild(fileIcon)
    fileRow.appendChild(fileMeta)
    fileBox.appendChild(thumb)
    fileBox.appendChild(fileRow)

    const status = document.createElement('p')
    status.className = 'lp-gift-status'

    const actions = document.createElement('div')
    actions.className = 'lp-card-actions lp-gift-actions'
    actions.appendChild(makeButton('打开', 'gift-open', { giftId: gift.giftId }))
    // 只有字条有正文可复制；文件卡的按钮在 update 里隐藏（不留一个点了没用的按钮）。
    const copyButton = makeButton('复制', 'gift-copy', { giftId: gift.giftId })
    actions.appendChild(copyButton)
    actions.appendChild(makeButton('在文件夹里显示', 'gift-reveal', { giftId: gift.giftId }))
    actions.appendChild(makeButton('扔掉', 'gift-discard', { giftId: gift.giftId, tone: 'danger' }))

    el.appendChild(head)
    el.appendChild(body)
    el.appendChild(fileBox)
    el.appendChild(status)
    el.appendChild(actions)
    el.addEventListener('pointerdown', (event) => event.stopPropagation())
    uiLayer.appendChild(el)

    const entry = {
      el,
      giftId: gift.giftId,
      deviceId: gift.deviceId,
      status: gift.status,
      kind: gift.kind,
      name: gift.name ?? null,
      size: gift.size ?? null,
      titleEl: title,
      bodyEl: body,
      fileEl: fileBox,
      thumbEl: thumb,
      fileNameEl: fileName,
      fileSizeEl: fileSize,
      copyButton,
      statusEl: status,
      signature: ''
    }
    updateGiftCard(entry, gift)
    return entry
  }

  function updateGiftCard (entry, gift) {
    const signature = giftSignature(gift)
    entry.deviceId = gift.deviceId
    entry.status = gift.status
    entry.kind = gift.kind
    entry.name = gift.name ?? null
    entry.size = gift.size ?? null
    if (entry.signature === signature) return
    entry.signature = signature
    entry.el.dataset.kind = gift.kind === 'file' ? 'file' : 'text'
    entry.titleEl.textContent = gift.title
    entry.el.setAttribute('aria-label', gift.title)
    const isFile = gift.kind === 'file'
    entry.bodyEl.textContent = isFile ? '' : (gift.text ?? '')
    entry.bodyEl.hidden = isFile || gift.text === undefined
    entry.fileEl.hidden = !isFile
    if (isFile) {
      entry.fileNameEl.textContent = gift.name ?? '文件'
      const sizeText = formatFileSize(gift.size)
      entry.fileSizeEl.textContent = sizeText
      entry.fileSizeEl.hidden = sizeText === ''
      if (typeof gift.thumb === 'string' && gift.thumb !== '') {
        if (entry.thumbEl.getAttribute('src') !== gift.thumb) entry.thumbEl.setAttribute('src', gift.thumb)
        entry.thumbEl.hidden = false
      } else {
        entry.thumbEl.hidden = true
        entry.thumbEl.removeAttribute('src')
      }
    } else {
      entry.thumbEl.hidden = true
      entry.thumbEl.removeAttribute('src')
    }
    entry.copyButton.hidden = isFile
    entry.statusEl.textContent = gift.statusText ?? ''
    entry.statusEl.hidden = gift.statusText === undefined
    setGiftButtonsEnabled(entry, gift.status === 'received')
  }

  function hideGiftCard (giftId) {
    const entry = ui.gifts.get(giftId)
    if (entry === undefined) return
    ui.gifts.delete(giftId)
    try {
      entry.el.remove()
    } catch {
      // 已经没了
    }
  }

  /**
   * 卡片集合完全由 scene.controls.gifts 决定：
   *   - 礼物没了 / 访客不在了 → 收起（访客离开时宿主自然不再输出这张卡）；
   *   - 同一 giftId 只画一张，标题/正文/状态原地更新，不重建 DOM（不打断点击）。
   */
  function syncGifts () {
    const gifts = Array.isArray(scene.controls.gifts) ? scene.controls.gifts : []
    const alive = new Set()
    for (const gift of gifts) {
      // 卡片跟着访客：访客没被画出来（场景放不下/已经走了）就不单独留一张卡。
      if (!pets.has('visitor:' + gift.deviceId)) continue
      alive.add(gift.giftId)
      const existing = ui.gifts.get(gift.giftId)
      if (existing === undefined) ui.gifts.set(gift.giftId, buildGiftCard(gift))
      else updateGiftCard(existing, gift)
    }
    for (const giftId of [...ui.gifts.keys()]) {
      if (!alive.has(giftId)) hideGiftCard(giftId)
    }
  }

  // -------------------------------------------------------------------------
  // 「宠物不在家」胶囊 + 面板（ticket 11 / 57）
  //
  // 自己出门串门、去偷、在外打工时桌面上都没有 self：右键菜单、悬停弹层、农场入口
  // 全靠 self 做锚点，于是整个桌面一下变得什么都点不到（用户报的“所有操作都消失了”）。
  // 这里用一个常驻胶囊接住它：点开是面板（农场 / 邻居 / 带派 / 改名 / 召回或叫它回家 /
  // 更多），右键直接开完整菜单。胶囊与面板都是宿主权威——它们只发申请。
  // -------------------------------------------------------------------------

  function awayActive () {
    return scene.controls.recall.enabled === true && pets.get('self') === undefined
  }

  /** 光标下的胶囊（不在家时桌面上唯一可抓的东西）。调试脚本与自己都用这一份判断。 */
  function chipElementAt (point) {
    if (point === null || ui.recall === null) return null
    return pointInElement(point, ui.recall.el) ? ui.recall.el : null
  }

  /** 把胶囊钉在用户放手的位置；越界夹回工作区（窗口再小也能点到）。 */
  function placeAwayChip (pos) {
    if (ui.recall === null) return null
    const el = ui.recall.el
    const width = Math.max(1, el.offsetWidth || 120)
    const height = Math.max(1, el.offsetHeight || 30)
    const margin = 4
    const x = Math.min(
      Math.max(margin, Number(pos?.x) || 0),
      Math.max(margin, window.innerWidth - width - margin)
    )
    const y = Math.min(
      Math.max(margin, Number(pos?.y) || 0),
      Math.max(margin, window.innerHeight - height - margin)
    )
    el.style.left = x.toFixed(1) + 'px'
    el.style.top = y.toFixed(1) + 'px'
    ui.awayChipPos = { x, y }
    return { x, y, width, height }
  }

  /**
   * 按住胶囊 = 拖动（ticket 57 现场反馈：它常驻在宠物最后出现的位置，挡住视线时挪不开）。
   *
   * 位置归渲染端（ADR-0003），宿主不知道也不该知道；拖过之后本次运行一直记住，
   * 不再跟着 promptAnchor 跑。没拖动（位移 < CLICK_MAX_MOVE）= 一次点击，仍然开面板。
   * 拖动期间和宠物拖拽一样持输入租约 + 一条跟随光标的命中矩形：窗口不能在拖到一半时
   * 翻回穿透，否则 pointermove/pointerup 全断。
   */
  function startChipDrag (event) {
    if (inputLocked && event.isTrusted) return
    if (event.button !== 0 || ui.recall === null) return
    const rect = elementRect(ui.recall.el)
    if (rect === null) return
    event.preventDefault()
    event.stopPropagation()
    // 面板先收：拖的是胶囊，留着面板会盖住要拖去的地方。
    hideAwayPanel('chip-drag')
    const now = performance.now()
    chipDrag = {
      pointerId: Number.isInteger(event.pointerId) ? event.pointerId : null,
      offsetX: event.clientX - rect.x,
      offsetY: event.clientY - rect.y,
      startX: event.clientX,
      startY: event.clientY,
      point: { x: event.clientX, y: event.clientY },
      moved: 0,
      startedAt: now,
      lastAt: now
    }
    ui.recall.el.dataset.dragging = 'true'
    if (chipDrag.pointerId !== null) {
      try {
        ui.recall.el.setPointerCapture(chipDrag.pointerId)
      } catch {
        // 合成输入没有真实指针：window 级监听照样收得到
      }
    }
    pointer = { x: event.clientX, y: event.clientY }
    updateLease()
    reportOverlayRects(true)
  }

  function moveChipDrag (x, y) {
    if (chipDrag === null) return
    const now = performance.now()
    chipDrag.lastAt = now
    chipDrag.point = { x, y }
    chipDrag.moved = Math.max(chipDrag.moved, Math.hypot(x - chipDrag.startX, y - chipDrag.startY))
    placeAwayChip({ x: x - chipDrag.offsetX, y: y - chipDrag.offsetY })
    // 命中矩形跟指针走（33ms 一报，和宠物拖拽同一个节拍）：拖得快也不会掉出命中区。
    if (now - ui.lastDragRectAt >= RECT_REPORT_MS) {
      ui.lastDragRectAt = now
      reportOverlayRects(false)
    }
  }

  function finishChipDrag (x, y) {
    if (chipDrag === null) return
    const current = chipDrag
    chipDrag = null
    const el = ui.recall === null ? null : ui.recall.el
    if (el !== null) delete el.dataset.dragging
    const hasPoint = Number.isFinite(x) && Number.isFinite(y)
    if (hasPoint) {
      placeAwayChip({ x: x - current.offsetX, y: y - current.offsetY })
      pointer = { x, y }
    }
    updateLease()
    const duration = performance.now() - current.startedAt
    const isClick = current.moved <= CLICK_MAX_MOVE && duration <= CLICK_MAX_MS
    if (hasPoint) evaluate(pointer, true)
    reportOverlayRects(true)
    // 点一下（几乎没动）= 开面板；真拖动过就只改位置，不弹。
    if (isClick) toggleAwayPanel()
  }

  function abortChipDrag () {
    if (chipDrag === null) return
    chipDrag = null
    if (ui.recall !== null) delete ui.recall.el.dataset.dragging
    updateLease()
    reportOverlayRects(true)
  }

  /** 胶囊上那句话：宿主算好的人话（away-text.js），渲染端不猜 mode。 */
  function awayChipText () {
    const recall = scene.controls.recall
    const text = typeof recall.text === 'string' && recall.text !== '' ? recall.text : null
    return text ?? (recall.mode === 'working' ? '在外打工' : recall.mode === 'raiding' ? '去偷菜了' : '不在家')
  }

  function hideAwayChip () {
    if (ui.recall === null) return
    try {
      ui.recall.el.remove()
    } catch {
      // 已经没了
    }
    ui.recall = null
    reportOverlayRects(true)
  }

  function syncAwayChip () {
    const need = awayActive()
    if (!need) {
      hideAwayPanel('not-away')
      hideAwayChip()
      return
    }
    if (ui.recall !== null) {
      const expected = awayChipText()
      if (ui.recall.mainEl !== null && ui.recall.mainEl.textContent !== expected) {
        ui.recall.mainEl.textContent = expected
        ui.recall.el.setAttribute('aria-label', '我的宠物不在家：' + expected)
      }
      return
    }
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'lp-recall-chip'
    el.dataset.lpAway = 'chip'
    el.setAttribute('aria-label', '我的宠物不在家：' + awayChipText())
    el.title = '点开是它在哪、能做什么；拖走可以挪开；右键打开菜单'
    const main = document.createElement('span')
    main.className = 'lp-chip-main'
    main.textContent = awayChipText()
    el.appendChild(main)
    const caret = document.createElement('span')
    caret.className = 'lp-chip-caret'
    caret.setAttribute('aria-hidden', 'true')
    caret.textContent = '▾'
    el.appendChild(caret)
    el.addEventListener('pointerdown', startChipDrag)
    el.addEventListener('contextmenu', (event) => {
      // 右键胶囊 = 完整菜单（和右键自己那只宠物同一棵树）。
      event.preventDefault()
      event.stopPropagation()
      const box = elementRect(el)
      hideAwayPanel('menu')
      openMenu(null, box === null ? 0 : box.x + box.width, box === null ? 0 : box.y)
    })
    uiLayer.appendChild(el)
    ui.recall = { el, mainEl: main }
    reportOverlayRects(true)
    layoutUi(true)
  }

  function awayPanelSignature () {
    return JSON.stringify(scene.controls.recall)
  }

  function hideAwayPanel (reason) {
    if (ui.awayPanel === null) return
    const current = ui.awayPanel
    ui.awayPanel = null
    try {
      current.el.remove()
    } catch {
      // 已经没了
    }
    void reason
    reportOverlayRects(true)
    layoutUi(true)
  }

  function toggleAwayPanel () {
    if (ui.awayPanel !== null) {
      hideAwayPanel('toggle')
      return
    }
    openAwayPanel()
  }

  function openAwayPanel () {
    if (!awayActive()) return
    hideAwayPanel('replace')
    const el = buildAwayPanel()
    el.addEventListener('pointerdown', (event) => event.stopPropagation())
    uiLayer.appendChild(el)
    ui.awayPanel = {
      el,
      signature: awayPanelSignature(),
      openedAt: performance.now(),
      lastActiveAt: performance.now()
    }
    closeMenu('away-panel')
    closeStreet('away-panel')
    reportOverlayRects(true)
    layoutUi(true)
    resetOpenTimer()
  }

  /** 「不在家」时的主按钮：串门/偷菜是召回；打工是叫它回家（recall-worker + contractId）。 */
  function awayPrimaryButton (recall) {
    if (recall.mode === 'working') {
      const contractId = typeof recall.contractId === 'string' ? recall.contractId : ''
      return makeButton('叫它回家', 'recall-worker', {
        contractId,
        disabled: contractId === '',
        reason: '这份合同还没落到本机，等一会儿再试。'
      })
    }
    return makeButton('召回', 'recall')
  }

  function buildAwayPanel () {
    const recall = scene.controls.recall
    const el = document.createElement('div')
    el.className = 'lp-popover lp-away-panel'
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-label', recall.title ?? '宠物不在家')

    const title = document.createElement('div')
    title.className = 'lp-popover-title'
    title.textContent = recall.title ?? awayChipText()
    el.appendChild(title)

    // 打工要能说清“我还能不能把它叫回来”：合同是两小时的，召回是提前结束、按实际时长结算。
    const status = document.createElement('div')
    status.className = 'lp-away-status'
    status.textContent = recall.mode === 'working'
      ? '在别人家看家，到点会自己回来；叫它回家会提前结束合同。'
      : recall.mode === 'raiding'
        ? '这一趟偷完就自己回家，也可以现在召回。'
        : '到点会自己回来，也可以现在召回。'
    el.appendChild(status)

    // 只有「召回 / 叫它回家」是主按钮：一次点击就改变宠物在哪，其余都是开窗/看东西。
    el.appendChild(makeButton('农场', 'farm-open', { tone: 'quiet' }))
    el.appendChild(makeButton('邻居', 'street-open', { tone: 'quiet' }))
    el.appendChild(makeButton('带派', 'bring', { tone: 'quiet' }))
    el.appendChild(makeButton('改名', 'rename', { tone: 'quiet' }))
    el.appendChild(awayPrimaryButton(recall))
    el.appendChild(makeButton('更多', 'away-more', { tone: 'quiet' }))
    return el
  }

  /** 面板一直开着时，宿主状态变了（换了个地方/合同结束）就收起来，别画一份旧状态。 */
  function syncAwayPanel () {
    if (ui.awayPanel === null) return
    if (!awayActive() || ui.awayPanel.signature !== awayPanelSignature()) {
      hideAwayPanel('controls-changed')
      return
    }
    ui.awayPanel.lastActiveAt = performance.now()
  }

  /** 光标离开胶囊与面板后的宽限关闭（和弹层同一套手感）。 */
  function updateAwayHover () {
    if (ui.awayPanel === null || pointer === null) return
    const insidePanel = pointInElement(pointer, ui.awayPanel.el)
    const insideChip = ui.recall !== null && pointInElement(pointer, ui.recall.el)
    if (insidePanel || insideChip) {
      ui.awayPanel.lastActiveAt = performance.now()
      cancelLeaveTimer()
      resetOpenTimer()
      return
    }
    if (ui.leaveTimer !== null) return
    ui.leaveTimer = setTimeout(() => {
      ui.leaveTimer = null
      if (ui.awayPanel !== null) hideAwayPanel('leave')
    }, UI_LEAVE_GRACE_MS)
  }

  // -------------------------------------------------------------------------
  // 失败提示气泡
  // -------------------------------------------------------------------------

  function hideNotice () {
    if (ui.notice === null) return
    const current = ui.notice
    ui.notice = null
    if (current.timer !== null) clearTimeout(current.timer)
    try {
      current.el.remove()
    } catch {
      // 已经没了
    }
  }

  function showNotice (text, at) {
    const message = typeof text === 'string' ? text.trim() : ''
    if (message === '') return
    const now = performance.now()
    if (ui.notice !== null && ui.notice.text === message && now - ui.notice.shownAt < 1500) {
      if (ui.notice.timer !== null) clearTimeout(ui.notice.timer)
      ui.notice.timer = setTimeout(hideNotice, NOTICE_VISIBLE_MS)
      ui.notice.shownAt = now
      return
    }
    hideNotice()
    const el = document.createElement('div')
    el.className = 'lp-notice'
    el.setAttribute('role', 'status')
    el.textContent = message
    uiLayer.appendChild(el)
    const notice = {
      text: message,
      at: Number.isFinite(at) ? at : Date.now(),
      el,
      shownAt: now,
      timer: setTimeout(hideNotice, NOTICE_VISIBLE_MS)
    }
    ui.notice = notice
    layoutUi(true)
  }

  function syncNotice () {
    const notice = scene.controls.notice
    if (notice === null) return
    if (notice.at <= ui.lastNoticeAt) return
    ui.lastNoticeAt = notice.at
    // 场景可能在 helper 重启后重发旧记录：太老的不再冒泡。
    if (Date.now() - notice.at > NOTICE_MAX_AGE_MS) return
    showNotice(notice.text, notice.at)
  }

  // -------------------------------------------------------------------------
  // 定位 + overlay 命中区上报
  // -------------------------------------------------------------------------

  function layoutUi (force) {
    const now = performance.now()
    if (force !== true && now - ui.layoutAt < 100) return
    ui.layoutAt = now
    const self = pets.get('self')
    if (self !== undefined) ui.lastSelfRect = anchorOfPet(self)

    const petRects = currentRects()
    const occupied = []

    if (ui.prompt !== null) {
      const rect = positionFloating(ui.prompt.el, promptAnchor(), {
        avoid: petRects.concat(occupied),
        gap: UI_GAP
      })
      if (rect !== null) occupied.push(rect)
    }

    // 礼物卡插在放行卡之后：锚点是**那位访客**，不是自己（礼物是“谁捎来的”）。
    for (const entry of [...ui.gifts.values()]) {
      const pet = pets.get('visitor:' + entry.deviceId)
      if (pet === undefined) {
        hideGiftCard(entry.giftId)
        continue
      }
      const rect = positionFloating(entry.el, anchorOfPet(pet), {
        avoid: petRects.concat(occupied),
        gap: UI_GAP
      })
      if (rect !== null) occupied.push(rect)
    }

    if (ui.popover !== null) {
      const pet = pets.get(ui.popover.petId)
      if (pet === undefined) {
        closePopover('gone')
      } else {
        const rect = positionFloating(ui.popover.el, anchorOfPet(pet), {
          avoid: petRects.concat(occupied),
          gap: UI_GAP
        })
        if (rect !== null) occupied.push(rect)
      }
    }

    if (ui.street !== null) {
      positionFloating(ui.street.el, promptAnchor(), {
        avoid: petRects.concat(occupied),
        gap: UI_GAP
      })
    }

    if (ui.recall !== null) {
      // 用户拖过就钉在他放下的地方；没拖过才跟着宠物最后出现的位置。
      const rect = ui.awayChipPos === null
        ? positionFloating(ui.recall.el, promptAnchor(), {
          avoid: petRects.concat(occupied),
          gap: UI_GAP
        })
        : placeAwayChip(ui.awayChipPos)
      if (rect !== null) occupied.push(rect)
    }

    if (ui.awayPanel !== null) {
      // 面板跟着胶囊走；胶囊万一不在（场景刚换），退回宠物最后出现的位置。
      const chipRect = ui.recall === null ? null : elementRect(ui.recall.el)
      const rect = positionFloating(ui.awayPanel.el, chipRect ?? promptAnchor(), {
        avoid: petRects.concat(occupied),
        gap: UI_GAP
      })
      if (rect !== null) occupied.push(rect)
    }

    if (ui.notice !== null) {
      // 气泡不接指针，但仍然不盖宠物，保持“在宠物旁边”的阅读位置。
      positionFloating(ui.notice.el, promptAnchor(), {
        avoid: petRects.concat(occupied),
        gap: UI_GAP
      })
    }

    reportOverlayRects(force === true)
  }

  function syncControls (reset) {
    if (reset === true) closePopover('scene-reset')
    if (reset === true) closeStreet('scene-reset')
    if (reset === true) hideAwayPanel('scene-reset')
    if (ui.popover !== null) {
      if (!pets.has(ui.popover.petId)) closePopover('scene-gone')
      else if (ui.popover.signature !== popoverSignature()) closePopover('controls-changed')
    }
    syncPrompt()
    syncGifts()
    syncStreet()
    syncAwayChip()
    syncAwayPanel()
    syncNotice()
    layoutUi(true)
  }

  // -------------------------------------------------------------------------
  // 点击 → 宿主申请（渲染端永远不直接改状态）
  // -------------------------------------------------------------------------

  function fallbackNoticeFor (action) {
    if (action === 'visit') return '还不能串门：还没有放行你的在线邻居。'
    if (action === 'recall') return '现在不用召回：宠物已经在家了。'
    if (action === 'end-visit') return '这位访客已经不在桌面上了。'
    if (action === 'admit' || action === 'reject') return '这位邻居已经不在了，刷新后再试。'
    if (action === 'dismiss') return '这张卡片暂时关不掉，稍后再试。'
    if (action === 'farm-open') return '农场窗口没有打开，稍后再试。'
    if (action.startsWith('gift-')) return '这张礼物卡已经不在了。'
    return ACTION_FAILED_NOTICE
  }

  function setPromptBusyFor (deviceId, busyNow) {
    if (ui.prompt === null || ui.prompt.deviceId !== deviceId) return
    setPromptBusy(busyNow)
  }

  function settleAction (id, result) {
    const pending = ui.pending.get(id)
    if (pending === undefined) return
    if (pending.timer !== null) clearTimeout(pending.timer)
    ui.pending.delete(id)
    if (pending.prompt) setPromptBusyFor(pending.deviceId, false)
    if (result !== null && result.ok === true) {
      if (pending.prompt) {
        ui.hiddenPromptKey = pending.deviceId
        hidePrompt({ forget: false })
      }
      // 成功也允许宿主带一句话（例如“字条已经复制到剪贴板”）：复制这种动作没有
      // 可见状态变化，不给一句反馈就和没点一样。
      const notice = typeof result.notice === 'string' ? result.notice.trim() : ''
      if (notice !== '') showNotice(notice)
      return
    }
    if (pending.prompt) {
      // 失败时把卡片放回去，让用户可以重试。
      ui.hiddenPromptKey = null
      syncPrompt()
    } else if (pending.action === 'dismiss') {
      // “稍后再说”失败：本地已经藏起来的卡片要能重新出现。
      ui.hiddenPromptKey = null
      syncPrompt()
    }
    const notice = result !== null && typeof result.notice === 'string' && result.notice.trim() !== ''
      ? result.notice
      : fallbackNoticeFor(pending.action)
    // 本机兜底先于气泡：点了动作，宠物先动起来，再解释"只是本机播了一次"。
    if (typeof pending.fallback === 'function') {
      try {
        pending.fallback(result)
      } catch {
        // 兜底自己坏了，至少还有气泡
      }
    }
    showNotice(notice)
  }

  function requestAction (action, deviceId, options = {}) {
    if (!shared.DESKTOP_ACTIONS.includes(action)) return
    ui.actionSeq += 1
    const id = 'act-' + String(ui.actionSeq) + '-' + Date.now().toString(36)
    const pending = {
      id,
      action,
      deviceId: typeof deviceId === 'string' && deviceId !== '' ? deviceId : undefined,
      // 点播要带名字；其余动作为 undefined。
      name: typeof options.name === 'string' && options.name !== '' ? options.name : undefined,
      // 换皮只带素材源 id（ticket 32）；其余动作为 undefined。
      skinId: typeof options.skinId === 'string' && options.skinId !== '' ? options.skinId : undefined,
      // 礼物动作只带 giftId；路径与磁盘操作全在宿主那边，渲染端连字符串都拿不到。
      giftId: typeof options.giftId === 'string' && options.giftId !== '' ? options.giftId : undefined,
      // 合同的「叫它回家」（ticket 57）：只带合同号，钱与结算全在宿主。
      contractId: typeof options.contractId === 'string' && options.contractId !== '' ? options.contractId : undefined,
      // 失败时的本机兜底（点播不可达 → 本机播一次）。只能影响本地表现，绝不能改状态。
      fallback: typeof options.fallback === 'function' ? options.fallback : null,
      prompt: options.prompt === true,
      at: Date.now(),
      timer: null
    }
    pending.timer = setTimeout(() => {
      const still = ui.pending.get(id)
      if (still === undefined) return
      ui.pending.delete(id)
      if (still.prompt) setPromptBusyFor(still.deviceId, false)
      if (still.action === 'dismiss') {
        // 没等到宿主答复：把本地藏起来的放行卡放回来，别让用户失去重试入口。
        ui.hiddenPromptKey = null
        syncPrompt()
      }
      showNotice(ACTION_TIMEOUT_NOTICE)
    }, ACTION_TIMEOUT_MS)
    ui.pending.set(id, pending)
    if (!api || typeof api.requestAction !== 'function') {
      settleAction(id, { ok: false, notice: ACTION_FAILED_NOTICE })
      return
    }
    try {
      api.requestAction({
        id,
        action,
        deviceId: pending.deviceId,
        name: pending.name,
        skinId: pending.skinId,
        giftId: pending.giftId,
        contractId: pending.contractId
      })
    } catch {
      settleAction(id, { ok: false, notice: ACTION_FAILED_NOTICE })
    }
  }

  function handleActionResult (result) {
    if (result === null || typeof result !== 'object') return
    if (typeof result.id !== 'string') return
    settleAction(result.id, result)
  }

  function onUiAction (button) {
    const action = button.dataset.lpAction
    if (typeof action !== 'string') return
    const deviceId = typeof button.dataset.lpDevice === 'string' ? button.dataset.lpDevice : undefined
    if (button.dataset.disabled === 'true') {
      const reason = typeof button.dataset.reason === 'string' && button.dataset.reason !== ''
        ? button.dataset.reason
        : fallbackNoticeFor(action)
      showNotice(reason)
      return
    }
    if (action.startsWith('gift-')) {
      // 礼物动作：只把 giftId 交给宿主。卡片/磁盘状态等宿主回灌，渲染端不自己改。
      const giftId = typeof button.dataset.lpGift === 'string' ? button.dataset.lpGift : ''
      if (giftId === '') return
      requestAction(action, undefined, { giftId })
      return
    }
    if (action === 'open-street') {
      // 「串门」先开那条街：挑谁去哪家，而不是替用户掷骰子（ticket 21）。
      closePopover('action')
      openStreet('self')
      return
    }
    if (action === 'street-open') {
      // ticket 57：不在家时也能看邻居（看田是只读的，不需要先串门）。街道本身会说明
      // 「宠物正在谁家」，并给出召回/叫它回家。
      hideAwayPanel('action')
      openStreet(null)
      return
    }
    if (action === 'away-more') {
      // 「更多」= 完整的右键菜单（农场/带派/重载/扫描外观/外观/动作）。菜单由宿主下发，
      // 这里只是换个锚点；宠物不在家时没有「回到初始位置」那一项。
      const chipRect = ui.recall === null ? null : elementRect(ui.recall.el)
      hideAwayPanel('action')
      if (chipRect !== null) openMenu(null, chipRect.x + chipRect.width, chipRect.y)
      return
    }
    if (action === 'street-more') {
      if (ui.street !== null) {
        ui.street.showBlocked = ui.street.showBlocked !== true
        renderStreet()
      }
      return
    }
    if (action === 'visit' || action === 'recall' || action === 'end-visit') {
      // 弹层/面板点击后立刻关掉并撤掉命中矩形；失败会以气泡出现，不靠控件赖着。
      closePopover('action')
      closeStreet('action')
      hideAwayPanel('action')
      requestAction(action, deviceId)
      return
    }
    if (action === 'recall-worker') {
      // 打工的「叫它回家」= recall-worker + 合同号（合同号由宿主随 controls 下发）。
      const contractId = typeof button.dataset.lpContract === 'string' ? button.dataset.lpContract : ''
      hideAwayPanel('action')
      if (contractId === '') {
        showNotice('这份合同还没落到本机，等一会儿再试。')
        return
      }
      requestAction('recall-worker', undefined, { contractId })
      return
    }
    if (action === 'rename') {
      // 输入要靠另一扇可聚焦的小窗：主窗 focusable:false，永远收不到键盘。
      closePopover('action')
      hideAwayPanel('action')
      if (!api || typeof api.openRename !== 'function') {
        showNotice('这扇桌面窗口开不了改名框，改用 POST /dsh-zoo/action。')
        return
      }
      try {
        api.openRename()
      } catch {
        showNotice(ACTION_FAILED_NOTICE)
      }
      return
    }
    if (action === 'farm-open' || action === 'bring') {
      // ticket 57：不在家面板上的「农场」「带派」与右键菜单里的同名项走同一条申请。
      hideAwayPanel('action')
      requestAction(action)
      return
    }
    if (action === 'dismiss') {
      ui.hiddenPromptKey = deviceId ?? ui.prompt?.deviceId ?? null
      hidePrompt({ forget: false })
      requestAction(action, deviceId)
      return
    }
    if (action === 'admit' || action === 'reject') {
      setPromptBusy(true)
      requestAction(action, deviceId, { prompt: true })
      return
    }
  }

  // -------------------------------------------------------------------------
  // 素材：dsh-pet WebM → 待机片段 → 内置 SVG
  // -------------------------------------------------------------------------

  function assetUrl (clip) {
    try {
      return 'dshzoo://asset/' + encodeURIComponent(clip) + '.webm'
    } catch {
      // 孤立代理项等非法字符串不能把渲染弄崩
      return null
    }
  }

  function ensureVideo (pet) {
    if (pet.video !== null) return pet.video
    const video = document.createElement('video')
    video.className = 'lp-pet-video'
    video.autoplay = true
    video.loop = true
    video.muted = true
    video.defaultMuted = true
    video.playsInline = true
    video.setAttribute('playsinline', '')
    video.setAttribute('muted', '')
    video.setAttribute('aria-hidden', 'true')
    video.preload = 'auto'
    video.draggable = false
    video.addEventListener('loadeddata', () => {
      // 只认当前这一段：切片段之后旧 load 的 loadeddata 不能把 source 改回去。
      if (video.dataset.clip === pet.media.clip) {
        pet.media.source = 'video'
        pet.media.durationMs = Number.isFinite(video.duration) ? video.duration * 1000 : 0
        // 成功也要回报（ticket 28）：以前只在开始加载时报一次 loading，
        // `/dsh-zoo/desktop` 的 media.source 就永远停在 loading，看着像素材坏了。
        reportMedia(pet, pet.media.clip, 'video')
      }
    })
    video.addEventListener('error', () => {
      const failedClip = typeof video.dataset.clip === 'string' && video.dataset.clip !== ''
        ? video.dataset.clip
        : pet.media.clip
      if (failedClip !== null && failedClip !== undefined) pet.media.failed.add(failedClip)
      if (pet.media.clip !== failedClip) return
      pet.media.clip = null
      pet.media.source = 'pending'
      pet.media.nextIdleAt = 0
      reportMedia(pet, failedClip, 'pending')
      // 立刻走降级链：动作 → 下一段待机 → SVG。
      updateMedia(pet, performance.now())
    })
    pet.video = video
    pet.mediaBox.appendChild(video)
    return video
  }

  function ensureSvg (pet) {
    if (pet.svg !== null) return pet.svg
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 96 96')
    svg.setAttribute('aria-hidden', 'true')
    svg.classList.add('lp-pet-svg')
    const body = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse')
    body.setAttribute('cx', '48')
    body.setAttribute('cy', '52')
    body.setAttribute('rx', '32')
    body.setAttribute('ry', '29')
    body.setAttribute('class', 'lp-pet-blob-body')
    body.setAttribute('fill', shared.DEFAULT_COLOR)
    const shine = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse')
    shine.setAttribute('cx', '36')
    shine.setAttribute('cy', '34')
    shine.setAttribute('rx', '10')
    shine.setAttribute('ry', '7')
    shine.setAttribute('fill', 'rgba(255,255,255,0.28)')
    const leftEye = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    leftEye.setAttribute('cx', '37')
    leftEye.setAttribute('cy', '48')
    leftEye.setAttribute('r', '4')
    leftEye.setAttribute('fill', 'rgba(18,24,32,0.82)')
    const rightEye = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    rightEye.setAttribute('cx', '59')
    rightEye.setAttribute('cy', '48')
    rightEye.setAttribute('r', '4')
    rightEye.setAttribute('fill', 'rgba(18,24,32,0.82)')
    const mouth = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    mouth.setAttribute('d', 'M38 61 Q48 68 58 61')
    mouth.setAttribute('fill', 'none')
    mouth.setAttribute('stroke', 'rgba(18,24,32,0.62)')
    mouth.setAttribute('stroke-width', '2')
    mouth.setAttribute('stroke-linecap', 'round')
    svg.appendChild(body)
    svg.appendChild(shine)
    svg.appendChild(leftEye)
    svg.appendChild(rightEye)
    svg.appendChild(mouth)
    const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    badge.setAttribute('x', '48')
    badge.setAttribute('y', '14')
    badge.setAttribute('text-anchor', 'middle')
    badge.setAttribute('font-size', '12')
    badge.setAttribute('fill', 'rgba(18,24,32,0.72)')
    badge.setAttribute('class', 'lp-pet-badge')
    svg.appendChild(badge)
    pet.badge = badge
    pet.svg = svg
    pet.mediaBox.appendChild(svg)
    return svg
  }

  function showSvg (pet) {
    if (pet.media.source === 'svg' && pet.svg !== null) return
    const svg = ensureSvg(pet)
    const body = svg.querySelector('.lp-pet-blob-body')
    if (body !== null) body.setAttribute('fill', pet.item.color)
    if (pet.badge !== null) {
      const badge = shared.semanticBadge(pet.item.fallback)
      pet.badge.textContent = badge
      pet.badge.style.display = badge === '' ? 'none' : 'block'
    }
    svg.style.display = 'block'
    if (pet.video !== null) {
      pet.video.style.display = 'none'
      try {
        pet.video.pause()
      } catch {
        // ignore
      }
    }
    pet.media.clip = null
    pet.media.source = 'svg'
    pet.media.gaveUp = true
    reportMedia(pet, null, 'svg')
  }

  function playClip (pet, clip) {
    playUrl(pet, assetUrl(clip), clip)
  }

  function playUrl (pet, url, key) {
    if (url === null) {
      // 非法名字 / 非法 URL：标记失败，下一帧走降级链，而不是永久停在 SVG。
      pet.media.failed.add(key)
      pet.media.clip = null
      pet.media.source = 'pending'
      pet.media.nextIdleAt = 0
      reportMedia(pet, typeof key === 'string' ? key : null, 'pending')
      return
    }
    const video = ensureVideo(pet)
    if (pet.svg !== null) pet.svg.style.display = 'none'
    video.style.display = 'block'
    pet.media.clip = key
    pet.media.source = 'loading'
    pet.media.clipStartedAt = performance.now()
    video.dataset.clip = key
    video.src = url
    video.load()
    const played = video.play()
    if (played !== null && typeof played.catch === 'function') played.catch(() => {})
    reportMedia(pet, key, 'loading')
  }

  /** 把当前片段与失败集合报给主进程；只进内存几条记录，不影响播放。 */
  function reportMedia (pet, clip, source) {
    if (typeof api?.reportMedia !== 'function') return
    try {
      api.reportMedia({
        clip,
        source,
        // 诊断用：文件读不出来时 readyState 卡在 0；窗口被遮挡/隐藏时 visibility 是 hidden。
        readyState: pet.video !== null ? pet.video.readyState : null,
        visibility: document.visibilityState,
        failed: [...pet.media.failed].slice(-16)
      })
    } catch {
      // 诊断坏了不能影响播放
    }
  }

  /**
   * 降级链：宿主给的动作（如果没失败过）→ 轮播内置待机片段（跳过失败的）→ SVG。
   * 每 4.5 秒换一段待机，和 v1 的客厅一致；动作存在时不轮播。
   */
  function updateMedia (pet, now) {
    const media = pet.media
    const anim = pet.item.anim
    // 本机兜底点播（ADR-0009 的降级路径）：这一段播完之前，不被 /state 的镜像盖回去。
    if (media.local !== null && media.local !== undefined) {
      if (anim !== null && anim === media.local.name) {
        // 本体已经回灌了同一个动作：兜底使命结束，交还给镜像。
        media.local = null
      } else if (now < media.local.until) {
        if (media.clip !== media.local.name) playClip(pet, media.local.name)
        return
      } else {
        media.local = null
      }
    }
    const src = pet.item.src ?? null
    // 本机素材池由宿主下发（dsh-pet 的全部动作）；没有就退回内置 3 段。
    const pool = Array.isArray(pet.item.idlePool) && pet.item.idlePool.length > 0
      ? pet.item.idlePool
      : shared.IDLE_CLIPS
    const poolKey = pool.join('\u0000')
    if (media.poolKey !== poolKey) {
      media.poolKey = poolKey
      media.clip = null
      media.idleIndex = shared.hashString(pet.id) % pool.length
      media.nextIdleAt = now + IDLE_ROTATE_MS
      media.gaveUp = false
    }
    if (media.src !== src) {
      media.src = src
      media.clip = null
      media.idleIndex = shared.hashString(pet.id) % pool.length
      media.nextIdleAt = now + IDLE_ROTATE_MS
      media.gaveUp = false
    }
    if (media.anim !== anim) {
      media.anim = anim
      media.clip = null
      media.idleIndex = shared.hashString(pet.id) % pool.length
      media.nextIdleAt = now + IDLE_ROTATE_MS
      media.gaveUp = false
    }
    if (media.gaveUp) return
    // 视频既不 loadeddata 也不 error（文件被锁/读盘卡住）：4s 后当作失败，继续降级。
    if (media.clip !== null && media.source === 'loading' && media.clipStartedAt > 0 &&
      now - media.clipStartedAt > 4000) {
      media.failed.add(media.clip)
      const stuck = media.clip
      media.clip = null
      media.source = 'pending'
      media.nextIdleAt = 0
      reportMedia(pet, stuck, 'pending')
    }
    // 远端自带素材优先；失败/没有 src 时再用本机同名素材。
    if (src !== null && !media.failed.has(src)) {
      if (media.clip !== src) playUrl(pet, src, src)
      return
    }
    if (anim !== null && !media.failed.has(anim)) {
      if (media.clip !== anim) playClip(pet, anim)
      return
    }
    const due = media.clip === null || now >= media.nextIdleAt
    if (!due) return
    const picked = shared.pickIdleClip(pool, media.idleIndex, media.failed, Math.random, media.clip)
    const chosen = picked.clip
    media.idleIndex = picked.next
    media.nextIdleAt = now + idleDelay(media)
    if (chosen === null) {
      showSvg(pet)
      return
    }
    if (chosen !== media.clip || media.source === 'svg') playClip(pet, chosen)
  }

  /** 待机片段尽量放完再换：4–12 秒，按视频时长自适应，避免总是把长动作拦腰截断。 */
  function idleDelay (media) {
    const duration = Number.isFinite(media.durationMs) && media.durationMs > 0 ? media.durationMs : IDLE_ROTATE_MS
    return Math.min(12000, Math.max(4000, duration))
  }

  // -------------------------------------------------------------------------
  // 拖拽
  // -------------------------------------------------------------------------

  function onPetPointerDown (event) {
    if (inputLocked && event.isTrusted) return
    if (event.button !== 0) return
    const pet = pets.get(event.currentTarget.dataset.id)
    if (pet === undefined) return
    event.preventDefault()
    startDrag(pet, event.clientX, event.clientY, event.pointerId)
  }

  /**
   * pointer 事件被吞掉时的兜底（例如某些合成输入只产生 mouse 事件）。
   * 已经有 drag 时直接忽略，不会双开。
   */
  function onPetMouseDown (event) {
    if (inputLocked && event.isTrusted) return
    if (event.button !== 0 || drag !== null) return
    const pet = pets.get(event.currentTarget.dataset.id)
    if (pet === undefined) return
    event.preventDefault()
    startDrag(pet, event.clientX, event.clientY, null)
  }

  function startDrag (pet, x, y, pointerId) {
    if (drag !== null) abortDrag()
    const now = performance.now()
    // 点在自己的弹层锚点上：这次按下如果是“点击”，语义是关掉弹层（toggle），不是重新打开。
    const hadPopover = ui.popover !== null && ui.popover.petId === pet.id
    if (ui.popover !== null) closePopover('drag')
    ui.hoverSuppressed = true
    ui.suppressedPetId = pet.id
    drag = {
      id: pet.id,
      pointerId: pointerId ?? null,
      offsetX: x - pet.body.x,
      offsetY: y - pet.body.y,
      target: { x: pet.body.x, y: pet.body.y },
      point: { x, y },
      trail: [{ t: now, x, y }],
      lastAt: now,
      startX: x,
      startY: y,
      startedAt: now,
      moved: 0,
      hadPopover
    }
    // 抓起来就停住动能，交给弹簧跟随；松手再按轨迹给初速度。
    pet.body = shared.confineBodyToBand({ ...pet.body, vx: 0, vy: 0 }, area, bandOf(pet.body))
    pet.el.dataset.dragging = 'true'
    if (pointerId !== null) {
      try {
        pet.el.setPointerCapture(pointerId)
      } catch {
        // 捕获失败不影响 window 级 pointermove/pointerup
      }
    }
    pointer = { x, y }
    evaluate(pointer, true)
    updateLease()
  }

  function moveDrag (x, y) {
    if (drag === null) return
    const now = performance.now()
    drag.lastAt = now
    drag.point = { x, y }
    drag.moved = Math.max(drag.moved, Math.hypot(x - drag.startX, y - drag.startY))
    drag.target = { x: x - drag.offsetX, y: y - drag.offsetY }
    const last = drag.trail[drag.trail.length - 1]
    if (last === undefined || now - last.t > 4 || Math.abs(x - last.x) > 0.5 || Math.abs(y - last.y) > 0.5) {
      drag.trail.push({ t: now, x, y })
    }
    // 只留最近 400ms；投掷取最后 140ms。
    while (drag.trail.length > 2 && now - drag.trail[0].t > 400) drag.trail.shift()
  }

  /**
   * 松手。位移/时长都小 = 一次点击：不投掷，按“点到了谁”打开弹层。
   * 点击只是打开控件，真正的动作要再点一次按钮——宠物身上的拖动永远优先。
   */
  function finishDrag (x, y) {
    if (drag === null) return
    const current = drag
    const duration = performance.now() - current.startedAt
    const isClick = current.moved <= CLICK_MAX_MOVE && duration <= CLICK_MAX_MS
    drag = null
    syntheticDrag = false
    const pet = pets.get(current.id)
    if (pet !== undefined) {
      if (x !== null && y !== null) {
        const now = performance.now()
        current.trail.push({ t: now, x, y })
      }
      const velocity = shared.throwVelocityFromTrail(current.trail, performance.now())
      // 落点按**宠物自己**所在的屏算（不是光标）：弹簧跟随可能还落后在上一块屏。
      // `bandAt` 先看水平方向落在哪条带里，所以被拖到矮屏下方黑区松手时，会回到
      // 脚下那块矮屏，而不是旁边更近的高屏；`confineBodyToBand` 连 x 一起夹回去。
      const band = bandOf(pet.body)
      pet.body = shared.confineBodyToBand(pet.body, area, band)
      pet.body = shared.throwBody(pet.body, velocity, area, band === null ? null : band.bottom)
      delete pet.el.dataset.dragging
      if (current.pointerId !== null) {
        try {
          pet.el.releasePointerCapture(current.pointerId)
        } catch {
          // 捕获可能已经自动释放
        }
      }
    }
    updateLease()
    if (x !== null && y !== null) pointer = { x, y }
    evaluate(pointer, true)
    reportRects(true)
    // 立刻撤掉 ui:drag：否则主进程还会把光标附近那块当成命中区，最多 900ms。
    reportOverlayRects(true)
    if (isClick && pet !== undefined) {
      ui.hoverSuppressed = false
      ui.suppressedPetId = null
      if (current.hadPopover) {
        // 点开着的宠物 = 关掉；startDrag 已经关了，这里保持关闭（等指针离开再允许悬停打开）。
        ui.hoverSuppressed = true
        ui.suppressedPetId = pet.id
      } else {
        openPopover(pet)
      }
    }
  }

  /** 取消拖拽（blur/取消/超时/工作区变化）：不投掷，位置停在当前弹簧处。 */
  function abortDrag () {
    if (drag === null) return
    const current = drag
    drag = null
    syntheticDrag = false
    const pet = pets.get(current.id)
    if (pet !== undefined) delete pet.el.dataset.dragging
    updateLease()
    evaluate(pointer, true)
    reportRects(true)
    reportOverlayRects(true)
  }

  // -------------------------------------------------------------------------
  // 输入 / 生命周期
  // -------------------------------------------------------------------------

  function trackPointer (x, y) {
    pointer = { x, y }
    if (chipDrag !== null) {
      moveChipDrag(x, y)
      updateUiHover()
      return
    }
    if (drag !== null) {
      moveDrag(x, y)
      updateUiHover()
      return
    }
    evaluate(pointer)
    updateUiHover()
    updateMenuPointer(pointer)
    maybeOpenHoverControls()
  }

  window.addEventListener('pointermove', (event) => {
    if (inputLocked && event.isTrusted) return
    if (syntheticDrag && event.isTrusted) return
    trackPointer(event.clientX, event.clientY)
  }, { passive: true })

  // forward 模式下 Electron 转发的是 mouse 事件；没有 pointer 事件的合成输入也要能拖。
  window.addEventListener('mousemove', (event) => {
    if (inputLocked && event.isTrusted) return
    if (syntheticDrag && event.isTrusted) return
    trackPointer(event.clientX, event.clientY)
  }, { passive: true })

  window.addEventListener('pointerup', (event) => {
    if (inputLocked && event.isTrusted) return
    if (chipDrag !== null) {
      finishChipDrag(event.clientX, event.clientY)
      return
    }
    if (drag === null) return
    finishDrag(event.clientX, event.clientY)
  })
  /**
   * 真实输入的心跳（ticket 30）：只数 `isTrusted` 的按下/抬起，合成事件一律不算。
   * 冒烟锁住输入时也不数——那是测试在用 sendInputEvent 驱动，不是人真的点了。
   */
  function onTrustedPointer (event) {
    if (!event.isTrusted || inputLocked) return
    if (typeof api?.reportInput !== 'function') return
    try {
      api.reportInput({ type: event.type === 'pointerdown' ? 'down' : 'up' })
    } catch {
      // 诊断坏了不能影响输入
    }
  }

  window.addEventListener('pointerdown', onTrustedPointer, { capture: true, passive: true })
  window.addEventListener('pointerup', onTrustedPointer, { capture: true, passive: true })

  window.addEventListener('pointercancel', () => {
    abortDrag()
    abortChipDrag()
  })
  window.addEventListener('mouseup', (event) => {
    if (inputLocked && event.isTrusted) return
    if (chipDrag !== null) {
      finishChipDrag(event.clientX, event.clientY)
      return
    }
    if (drag === null) return
    finishDrag(event.clientX, event.clientY)
  })

  window.addEventListener('blur', () => {
    if (inputLocked) return
    abortDrag()
    abortChipDrag()
    closePopover('blur')
    hideAwayPanel('blur')
    setBusy(false)
    releaseHover()
  })
  document.addEventListener('visibilitychange', () => {
    if (inputLocked || !document.hidden) return
    abortDrag()
    abortChipDrag()
    closePopover('hidden')
    hideAwayPanel('hidden')
    setBusy(false)
    releaseHover()
  })
  window.addEventListener('mouseleave', () => {
    // 拖拽中光标离开窗口是正常的：租约必须留着，等 pointerup 或超时。
    if (drag !== null) return
    releaseHover()
    updateUiHover()
  })

  window.addEventListener('resize', () => {
    area = readArea()
    for (const pet of pets.values()) {
      // 先按新窗口夹回并集；每屏的带子会随宿主的新场景一起到，下一帧再按带子收敛。
      pet.body = shared.resizeBodies([pet.body], area)[0]
      applyTransform(pet)
    }
    if (drag !== null) abortDrag()
    abortChipDrag()
    closePopover('resize')
    hideAwayPanel('resize')
    closeMenu('resize')
    layoutUi(true)
    evaluate(pointer, true)
    reportRects(true)
  })

  window.addEventListener('pointerdown', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (ui.popover !== null) {
      // 点在弹层或宠物身上由它们自己处理；点桌面空白处 = 关掉弹层。
      if (!ui.popover.el.contains(target) && target.closest('.lp-pet') === null) closePopover('outside')
    }
    if (ui.awayPanel !== null) {
      // 面板同理：点面板外（包括胶囊本身）就收起来，胶囊的 click 再决定是开还是合。
      if (!ui.awayPanel.el.contains(target) && (ui.recall === null || !ui.recall.el.contains(target))) {
        hideAwayPanel('outside')
      }
    }
  }, true)

  uiLayer.addEventListener('pointerdown', (event) => {
    // 控件上的按下不参与宠物拖拽/命中；按钮自己的 click 照常。
    event.stopPropagation()
  })
  uiLayer.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest('[data-lp-action]')
    if (button === null) return
    event.preventDefault()
    event.stopPropagation()
    onUiAction(button)
  })

  // -------------------------------------------------------------------------
  // 60fps
  // -------------------------------------------------------------------------

  function frame (now) {
    rafId = requestAnimationFrame(frame)
    const dt = lastFrameAt === 0
      ? 1 / 60
      : Math.min(shared.PHYSICS.MAX_DT, Math.max(0, (now - lastFrameAt) / 1000))
    lastFrameAt = now

    if (drag !== null && now - drag.lastAt > DRAG_TIMEOUT_MS) abortDrag()
    if (chipDrag !== null && now - chipDrag.lastAt > DRAG_TIMEOUT_MS) abortChipDrag()

    const frozenId = ui.menu === null ? null : ui.menu.petId
    for (const pet of pets.values()) {
      // 菜单开着的那只停住：不飞、不漫游，也不轮播换段（ADR-0010）。
      if (pet.id === frozenId) {
        applyTransform(pet)
        continue
      }
      if (drag !== null && drag.id === pet.id) {
        // 拖拽期间用整张桌面：目标可以跨到另一块屏；松手时按落点选地面带。
        pet.body = shared.dragBody(pet.body, drag.target, area, dt)
      } else {
        // 走路只在当前这条地面带里：同高相邻屏可来回走；高度不同时停在屏边，
        // 不会掉进矮屏下方那块没有显示器的黑区。
        pet.body = shared.stepOnBand(pet.body, area, dt, bandOf(pet.body))
      }
      applyTransform(pet)
      updateMedia(pet, now)
    }
    // 弹层/卡片/菜单跟着宠物走；overlay 矩形按 10Hz 重新上报，静止时靠心跳。
    //
    // 这里**必须**包括菜单：矩形只在变化时报一次的话，主进程 900ms 后按过期处理，
    // 窗口翻回穿透——菜单画着，点击却落到后面的 app 上（用户报的"点了没反应、穿透"）。
    // reportOverlayRects 自己按 300ms 节流，逐帧调用不会刷屏。
    if (ui.popover !== null || ui.prompt !== null || ui.recall !== null || ui.notice !== null ||
      ui.menu !== null || ui.street !== null || ui.gifts.size > 0 || ui.awayPanel !== null) {
      layoutUi(false)
      reportOverlayRects(false)
    }
    // 拖拽时 ui:drag 必须紧跟光标：租约只有在“光标压在活矩形上”时才生效。
    if ((drag !== null || chipDrag !== null) && now - ui.lastDragRectAt >= RECT_REPORT_MS) {
      ui.lastDragRectAt = now
      reportOverlayRects(false)
    }
    reportRects(false)
  }

  // -------------------------------------------------------------------------
  // 接线
  // -------------------------------------------------------------------------

  if (api && typeof api.onScene === 'function') api.onScene(applyScene)
  if (api && typeof api.onActionResult === 'function') api.onActionResult(handleActionResult)
  if (api && typeof api.onRenameUnavailable === 'function') {
    api.onRenameUnavailable(() => showNotice('改名窗口还没准备好，稍后再试。'))
  }
  if (api && typeof api.ready === 'function') api.ready()
  rafId = requestAnimationFrame(frame)

  // 给调试脚本一个只读探针（不参与判定）。
  Object.defineProperty(globalThis, '__dshZooDebug', {
    value: Object.freeze({
      scene: () => scene,
      lastPoint: () => pointer,
      lastInside: () => hoverInside,
      hit: () => {
        const rect = hitAt(pointer)
        return rect === null ? null : rect.id
      },
      /**
       * 调试用：在渲染端派发 PointerEvent，走和真实输入同一套处理器。
       * 冒烟脚本没法移动用户鼠标，而 sendInputEvent 会被真实光标的转发事件干扰。
       */
      /** 调试用：锁住/解锁真实输入（冒烟用合成事件时，环境里的鼠标/焦点事件不应干扰）。 */
      lockInput: (locked) => {
        const next = locked === true
        if (next === inputLocked) return inputLocked
        inputLocked = next
        if (inputLocked) {
          // 锁输入 = 测试要自己控制光标：先把现有的悬停声明确实撤掉，别让心跳继续骗主进程。
          releaseHover()
          closePopover('input-locked')
        } else if (pointer !== null) {
          evaluate(pointer, true)
        }
        return inputLocked
      },
      dispatch: (phase, x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false
        const point = { x, y }
        pointer = point
        if (phase === 'down') {
          const pet = petAt(point)
          const target = pet !== null ? pet.el : chipElementAt(point)
          if (target === null) return false
          syntheticDrag = true
          target.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            pointerId: 77,
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
            buttons: 1
          }))
          return true
        }
        if (phase === 'move') {
          window.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            pointerId: 77,
            pointerType: 'mouse',
            isPrimary: true,
            buttons: 1
          }))
          return drag !== null || chipDrag !== null
        }
        if (phase === 'blur') {
          syntheticDrag = false
          window.dispatchEvent(new Event('blur'))
          return drag === null
        }
        /** 右键：在光标下的宠物元素上派发 contextmenu，走和真实右键同一套处理器。 */
        if (phase === 'context') {
          const element = document.elementFromPoint(x, y)
          const petEl = element === null ? null : element.closest('.lp-pet')
          if (petEl === null) return false
          petEl.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            button: 2,
            buttons: 2
          }))
          return true
        }
        if (phase === 'up') {
          const hadDrag = drag !== null || chipDrag !== null
          window.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            pointerId: 77,
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
            buttons: 0
          }))
          syntheticDrag = false
          return hadDrag
        }
        /**
         * 在屏幕坐标上做一次真实 DOM 点击：先 elementFromPoint 命中，再走元素自己的 click。
         * 按钮走 click；宠物走 pointerdown+pointerup，和真实鼠标一样经过拖拽/点击判定。
         */
        if (phase === 'click') {
          const element = document.elementFromPoint(x, y)
          if (element === null) return false
          const menuRow = element.closest('.lp-menu-item')
          if (menuRow !== null) {
            menuRow.click()
            return true
          }
          const button = element.closest('[data-lp-action]')
          if (button !== null) {
            button.click()
            return true
          }
          // 「不在家」胶囊不是动作按钮（点开的是面板），冒烟也要能像真实鼠标一样点它：
          // 走 pointerdown + pointerup，点击/拖动的判定和用户一致。
          const awayChip = element.closest('[data-lp-away]')
          if (awayChip !== null) {
            syntheticDrag = true
            awayChip.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              screenX: x,
              screenY: y,
              pointerId: 77,
              pointerType: 'mouse',
              isPrimary: true,
              button: 0,
              buttons: 1
            }))
            window.dispatchEvent(new PointerEvent('pointerup', {
              bubbles: true,
              clientX: x,
              clientY: y,
              screenX: x,
              screenY: y,
              pointerId: 77,
              pointerType: 'mouse',
              isPrimary: true,
              button: 0,
              buttons: 0
            }))
            syntheticDrag = false
            return true
          }
          const petEl = element.closest('.lp-pet')
          if (petEl === null) return false
          const pet = pets.get(petEl.dataset.id)
          if (pet === undefined) return false
          syntheticDrag = true
          pet.el.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            pointerId: 77,
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
            buttons: 1
          }))
          window.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            pointerId: 77,
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
            buttons: 0
          }))
          syntheticDrag = false
          return true
        }
        return false
      },
      snapshot: () => ({
        at: round(performance.now()),
        area: { width: area.width, height: area.height },
        bands: bands.map((band) => ({ x: band.x, width: band.width, bottom: band.bottom })),
        busy,
        dragging: drag === null ? null : drag.id,
        dragTarget: drag === null ? null : { x: round(drag.target.x), y: round(drag.target.y) },
        hoverInside,
        pointer: pointer === null ? null : { x: round(pointer.x), y: round(pointer.y) },
        controls: {
          popover: ui.popover === null
            ? null
            : {
                petId: ui.popover.petId,
                kind: ui.popover.kind,
                disabled: [...ui.popover.el.querySelectorAll('[data-disabled="true"]')]
                  .map((button) => button.dataset.lpAction)
              },
          prompt: ui.prompt === null ? null : { deviceId: ui.prompt.deviceId, nickname: ui.prompt.nickname },
          street: scene.controls.street.map((row) => ({
            deviceId: row.deviceId,
            label: row.label,
            canVisit: row.canVisit
          })),
          gifts: [...ui.gifts.values()].map((entry) => {
            const box = entry.el.getBoundingClientRect()
            return {
              giftId: entry.giftId,
              deviceId: entry.deviceId,
              kind: entry.kind,
              name: entry.name,
              size: entry.size,
              status: entry.status,
              title: entry.titleEl.textContent,
              text: entry.bodyEl.textContent,
              statusText: entry.statusEl.hidden ? null : entry.statusEl.textContent,
              // 缩略图诊断：loaded=true 才证明 CSP + dshzoo://gifts 协议真的把图喂进了 <img>。
              thumb: entry.thumbEl.hidden
                ? null
                : {
                    src: entry.thumbEl.getAttribute('src'),
                    loaded: entry.thumbEl.complete && entry.thumbEl.naturalWidth > 0,
                    width: entry.thumbEl.naturalWidth,
                    height: entry.thumbEl.naturalHeight
                  },
              copyVisible: entry.copyButton.hidden !== true,
              x: round(box.left),
              y: round(box.top),
              width: round(box.width),
              height: round(box.height)
            }
          }),
          streetOpen: ui.street !== null,
          streetShowBlocked: ui.street === null ? false : ui.street.showBlocked,
          recallChip: ui.recall === null
            ? null
            : {
                text: awayChipText(),
                mode: scene.controls.recall.mode,
                title: scene.controls.recall.title
              },
          awayPanel: ui.awayPanel === null
            ? null
            : {
                title: scene.controls.recall.title,
                buttons: [...ui.awayPanel.el.querySelectorAll('[data-lp-action]')]
                  .map((button) => button.dataset.lpAction)
              },
          notice: ui.notice === null ? null : { text: ui.notice.text, at: ui.notice.at },
          pending: [...ui.pending.values()].map((pending) => ({
            id: pending.id,
            action: pending.action,
            deviceId: pending.deviceId ?? null
          })),
          hoverSuppressed: ui.hoverSuppressed
        },
        lastMenuClick: ui.lastMenuClick ?? null,
        // 诊断：菜单开着时不该还有弹层 DOM（两套入口会互相抢鼠标）。
        strayPopovers: uiLayer === null ? 0 : uiLayer.querySelectorAll('.lp-popover').length,
        menu: ui.menu === null
          ? null
          : {
              petId: ui.menu.petId,
              panels: ui.menu.panels.map((panel) => {
                const box = panel.el.getBoundingClientRect()
                return {
                  level: panel.level,
                  x: round(box.left),
                  y: round(box.top),
                  width: round(box.width),
                  height: round(box.height)
                }
              }),
              rows: [...ui.menu.root.querySelectorAll('.lp-menu-item')].map((row) => {
                const box = row.getBoundingClientRect()
                return {
                  kind: row.dataset.menuKind ?? null,
                  label: row.querySelector('.lp-menu-label')?.textContent ?? row.textContent,
                  x: round(box.left),
                  y: round(box.top),
                  width: round(box.width),
                  height: round(box.height)
                }
              })
            },
        uiRects: uiRects().map((rect) => ({
          id: rect.id,
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height)
        })),
        pets: [...pets.values()].map((pet) => ({
          id: pet.id,
          role: pet.item.role,
          badge: pet.item.badge ?? null,
          label: pet.item.label,
          anim: pet.item.anim,
          x: round(pet.body.x),
          y: round(pet.body.y),
          // 「回到初始位置」的目标点：调试/冒烟要能断言"回到哪儿"。
          spawnX: round(pet.spawn?.x ?? pet.item.x),
          spawnY: round(pet.spawn?.y ?? pet.item.y),
          width: round(pet.body.width),
          height: round(pet.body.height),
          vx: round(pet.body.vx),
          vy: round(pet.body.vy),
          dragging: drag !== null && drag.id === pet.id,
          source: pet.media.source,
          clip: pet.media.clip
        }))
      })
    }),
    configurable: false,
    writable: false
  })

  function round (value) {
    return Math.round(value * 100) / 100
  }

  // 模块级变量只用于调试；显式引用一次，避免 lint 把 rafId 当未使用（没有 lint，但保持意图清楚）。
  void rafId
})()
