/**
 * 渲染端：把宿主给的场景 v2 画成桌面宠物，并在本地跑 60fps 物理。
 *
 * 分工（ticket 08）：
 *   - 宿主决定「有谁/叫什么/在播什么」（scene.items 的 id/role/label/anim/color）；
 *   - 这里决定「在哪/多快/朝哪飞」，逐帧把命中矩形报给主进程（`reportRects`）；
 *   - 主进程用真实光标 + 这份矩形裁定点击穿透，位置过期就 fail-closed 回穿透。
 *
 * 素材：dsh-pet 的 WebM 经 helper 的 `localpet://asset/<name>.webm` 协议加载；
 * 动作取不到 → 轮播真实存在的待机片段 → 仍取不到才画内置 SVG 色块。
 * 页面是 file://，这里**没有** `/dsh-pet-7340/thumb/...` 可用。
 *
 * 拖拽：pointerdown 立刻申请输入租约（busy），每 300ms 续期；pointerup/pointercancel/
 * window blur/页面隐藏/2.5s 无移动都会释放。宠物落后于光标、光标跑到矩形外时，
 * 靠租约保持窗口可交互，pointermove/pointerup 才不会断。
 *
 * 控件（ticket 11）：
 *   - 悬停/点击自己的宠物 → 弹层（串门；出门时桌面上没有 self，用常驻「召回」胶囊代替）；
 *   - 点击客人 → 弹层（送客）；放行卡由场景里的 controls.prompt 驱动；
 *   - 弹层打开期间同样持有输入租约：弹层与宠物之间有间隙，光标穿过时窗口不能翻回穿透；
 *   - 弹层/卡片/胶囊的矩形单独上报（local-pet:overlay-rects），所以即使租约被收回，
 *     光标真的压在按钮上时主进程仍能接管鼠标；
 *   - 关闭/离开/失焦/超时/场景 reset 都会释放租约；渲染端整个死掉时主进程按租约超时兜底。
 *   - 点击只是一次**申请**（local-pet:action），状态永远等宿主的场景/action-result 回灌。
 */

;(function () {
  'use strict'

  const shared = globalThis.LocalPetShared
  const api = globalThis.localPetDesktop
  const stage = document.getElementById('stage')
  const uiLayer = document.getElementById('ui-layer')
  if (!shared || !stage || !uiLayer) return

  const IDLE_ROTATE_MS = 4500
  /** 宠物在动时的矩形上报节拍；静止时降到心跳，避免无意义 IPC。 */
  const RECT_REPORT_MS = 33
  const RECT_HEARTBEAT_MS = 300
  /** 拖拽中这么久没有任何 pointermove：渲染端自己收手（主进程的租约会更早过期）。 */
  const DRAG_TIMEOUT_MS = 2500
  /** 弹层最长打开时间；到点自己关掉并交还租约，绝不无限期占着整窗鼠标。 */
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
  /** 点击判定：按下到松开的位移/时长都小才算一次点击，否则是拖拽。 */
  const CLICK_MAX_MOVE = 5
  const CLICK_MAX_MS = 600

  let scene = shared.normalizeScene(null)
  let area = readArea()
  let pointer = null
  let hoverInside = false
  let hoverTimer = null
  let busy = false
  let busyTimer = null
  let lastRectsAt = 0
  let lastFrameAt = 0
  let drag = null
  /** 调试脚本派发的拖拽期间，忽略真实光标的转发事件（冒烟没法移动用户鼠标）。 */
  let syntheticDrag = false
  /** 调试脚本完全接管输入时，连悬停/焦点事件也不看真实环境（冒烟可复现）。 */
  let inputLocked = false
  let rafId = 0

  /**
   * 桌面控件的全部可变状态。租约只有两条来源：拖拽（drag !== null）与打开的弹层（lease）；
   * 放行卡/召回胶囊是常驻控件，不持有租约——它们靠 overlay 矩形按需接管鼠标。
   */
  const ui = {
    popover: null, // { petId, kind, el, signature, openedAt, lastActiveAt }
    prompt: null, // { key, deviceId, nickname, el }
    recall: null, // { el }
    notice: null, // { text, at, el, timer }
    hiddenPromptKey: null,
    hoverSuppressed: false,
    suppressedPetId: null,
    leaveTimer: null,
    openTimer: null,
    lease: false,
    actionSeq: 0,
    pending: new Map(),
    lastNoticeAt: 0,
    lastSelfRect: null,
    layoutAt: 0,
    overlaySignature: '',
    lastOverlayAt: 0
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

  /** 拖拽与打开的弹层都可能需要租约；任何一方还想要，就不能放手。 */
  function updateLease () {
    setBusy(drag !== null || ui.lease)
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
   * 否则租约一收回（失焦/超时/调试冻结）按钮就再也点不到。
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

    // 顺序有讲究：bridge 在前、容器其次、按钮最后。hitTestRects 倒序扫描，
    // 因此按钮 > 卡片/弹层 > 桥接矩形；诊断 itemId 不会永远停在 ui:bridge:* 上。
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

    if (ui.recall !== null) add('ui:recall-chip', ui.recall.el)
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
          pet.body = shared.createBody({
            x: pet.body.x,
            y: pet.body.y,
            width: item.width,
            height: item.height,
            vx: pet.body.vx,
            vy: pet.body.vy
          }, area)
        }
        updateNode(pet)
      }
      applyTransform(pet)
    }
    for (const [id, pet] of [...pets]) {
      if (alive.has(id)) continue
      if (drag !== null && drag.id === id) abortDrag()
      destroyPet(pet)
      pets.delete(id)
    }
  }

  function spawnBody (item) {
    const velocity = shared.initialVelocity(item.id)
    return shared.createBody({
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      vx: velocity.vx,
      vy: velocity.vy
    }, area)
  }

  function createPet (item) {
    const el = document.createElement('div')
    el.className = 'lp-pet'
    el.dataset.id = item.id
    const mediaBox = document.createElement('div')
    mediaBox.className = 'lp-pet-media'
    const nameEl = document.createElement('span')
    nameEl.className = 'lp-pet-name'
    el.appendChild(mediaBox)
    el.appendChild(nameEl)
    el.addEventListener('pointerdown', onPetPointerDown)
    el.addEventListener('mousedown', onPetMouseDown)
    stage.appendChild(el)

    const pet = {
      id: item.id,
      item,
      body: spawnBody(item),
      el,
      mediaBox,
      nameEl,
      video: null,
      svg: null,
      nodeWidth: -1,
      nodeHeight: -1,
      media: {
        clip: null,
        source: 'pending',
        anim: null,
        failed: new Set(),
        idleIndex: shared.hashString(item.id) % shared.IDLE_CLIPS.length,
        nextIdleAt: 0,
        clipStartedAt: 0,
        gaveUp: false
      }
    }
    updateNode(pet)
    updateMedia(pet, performance.now())
    applyTransform(pet)
    return pet
  }

  function updateNode (pet) {
    const item = pet.item
    const role = item.role === 'self' || item.role === 'visitor' ? item.role : 'guest'
    if (pet.el.dataset.role !== role) pet.el.dataset.role = role
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
      el.appendChild(makeButton('串门', 'visit', {
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
        reason: '这位客人已经不在桌面上了。'
      }))
      if (info === undefined) {
        const why = document.createElement('div')
        why.className = 'lp-why'
        why.textContent = '这位客人已经不在桌面上了。'
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
    }, UI_MAX_OPEN_MS)
  }

  function setUiLease (value) {
    const next = value === true
    if (ui.lease === next) return
    ui.lease = next
    updateLease()
  }

  /**
   * 打开弹层：先关掉旧的（不 suppress），挂 DOM、拿租约、定位、开始超时。
   * 租约让光标从宠物跨过间隙走到按钮时窗口不会翻回穿透；overlay 矩形是第二道保险。
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
    setUiLease(true)
    layoutUi(true)
    resetOpenTimer()
    reportOverlayRects(true)
  }

  /**
   * 关闭弹层并立刻交还租约。suppress=true 表示“这次是用户/超时关的”，
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
    setUiLease(false)
    if (options.suppress !== false) {
      ui.hoverSuppressed = true
      ui.suppressedPetId = current.petId
    }
    reportOverlayRects(true)
    layoutUi(true)
  }

  function maybeOpenHoverControls () {
    if (pointer === null || drag !== null || ui.popover !== null || !uiLayer) return
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
  // 召回胶囊（自己出门时桌面没有 self）
  // -------------------------------------------------------------------------

  function hideRecallChip () {
    if (ui.recall === null) return
    try {
      ui.recall.el.remove()
    } catch {
      // 已经没了
    }
    ui.recall = null
    reportOverlayRects(true)
  }

  function syncRecallChip () {
    const recall = scene.controls.recall
    const away = pets.get('self') === undefined
    const need = recall.enabled === true && away
    if (!need) {
      hideRecallChip()
      return
    }
    if (ui.recall !== null) {
      const sub = ui.recall.el.querySelector('.lp-chip-sub')
      const expected = recall.nickname === null ? '' : '在「' + recall.nickname + '」家'
      if (sub !== null && sub.textContent !== expected) sub.textContent = expected
      return
    }
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'lp-recall-chip'
    el.dataset.lpAction = 'recall'
    el.appendChild(document.createTextNode('召回'))
    if (recall.nickname !== null) {
      const sub = document.createElement('span')
      sub.className = 'lp-chip-sub'
      sub.textContent = '在「' + recall.nickname + '」家'
      el.appendChild(sub)
    }
    el.addEventListener('pointerdown', (event) => event.stopPropagation())
    uiLayer.appendChild(el)
    ui.recall = { el }
    reportOverlayRects(true)
    layoutUi(true)
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

    if (ui.recall !== null) {
      positionFloating(ui.recall.el, promptAnchor(), {
        avoid: petRects.concat(occupied),
        gap: UI_GAP
      })
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
    if (ui.popover !== null) {
      if (!pets.has(ui.popover.petId)) closePopover('scene-gone')
      else if (ui.popover.signature !== popoverSignature()) closePopover('controls-changed')
    }
    syncPrompt()
    syncRecallChip()
    syncNotice()
    layoutUi(true)
  }

  // -------------------------------------------------------------------------
  // 点击 → 宿主申请（渲染端永远不直接改状态）
  // -------------------------------------------------------------------------

  function fallbackNoticeFor (action) {
    if (action === 'visit') return '还不能串门：还没有放行你的在线邻居。'
    if (action === 'recall') return '现在不用召回：宠物已经在家了。'
    if (action === 'end-visit') return '这位客人已经不在桌面上了。'
    if (action === 'admit' || action === 'reject') return '这位邻居已经不在了，刷新后再试。'
    if (action === 'dismiss') return '这张卡片暂时关不掉，稍后再试。'
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
    showNotice(notice)
  }

  function requestAction (action, deviceId, options = {}) {
    if (!shared.CONTROL_ACTIONS.includes(action)) return
    ui.actionSeq += 1
    const id = 'act-' + String(ui.actionSeq) + '-' + Date.now().toString(36)
    const pending = {
      id,
      action,
      deviceId: typeof deviceId === 'string' && deviceId !== '' ? deviceId : undefined,
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
      api.requestAction({ id, action, deviceId: pending.deviceId })
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
    if (action === 'visit' || action === 'recall' || action === 'end-visit') {
      // 弹层点击后立刻关掉并交还租约；失败会以气泡出现，不靠弹层赖着。
      closePopover('action')
      requestAction(action, deviceId)
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
      return 'localpet://asset/' + encodeURIComponent(clip) + '.webm'
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
      if (video.dataset.clip === pet.media.clip) pet.media.source = 'video'
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
    pet.svg = svg
    pet.mediaBox.appendChild(svg)
    return svg
  }

  function showSvg (pet) {
    if (pet.media.source === 'svg' && pet.svg !== null) return
    const svg = ensureSvg(pet)
    const body = svg.querySelector('.lp-pet-blob-body')
    if (body !== null) body.setAttribute('fill', pet.item.color)
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
  }

  function playClip (pet, clip) {
    const url = assetUrl(clip)
    if (url === null) {
      // 非法名字（孤立代理项等）：标记失败，下一帧走降级链，而不是永久停在 SVG。
      pet.media.failed.add(clip)
      pet.media.clip = null
      pet.media.source = 'pending'
      pet.media.nextIdleAt = 0
      return
    }
    const video = ensureVideo(pet)
    if (pet.svg !== null) pet.svg.style.display = 'none'
    video.style.display = 'block'
    pet.media.clip = clip
    pet.media.source = 'loading'
    pet.media.clipStartedAt = performance.now()
    video.dataset.clip = clip
    video.src = url
    video.load()
    const played = video.play()
    if (played !== null && typeof played.catch === 'function') played.catch(() => {})
  }

  /**
   * 降级链：宿主给的动作（如果没失败过）→ 轮播内置待机片段（跳过失败的）→ SVG。
   * 每 4.5 秒换一段待机，和 v1 的客厅一致；动作存在时不轮播。
   */
  function updateMedia (pet, now) {
    const media = pet.media
    const anim = pet.item.anim
    if (media.anim !== anim) {
      media.anim = anim
      media.clip = null
      media.idleIndex = shared.hashString(pet.id) % shared.IDLE_CLIPS.length
      media.nextIdleAt = now + IDLE_ROTATE_MS
      media.gaveUp = false
    }
    if (media.gaveUp) return
    // 视频既不 loadeddata 也不 error（文件被锁/读盘卡住）：4s 后当作失败，继续降级。
    if (media.clip !== null && media.source === 'loading' && media.clipStartedAt > 0 &&
      now - media.clipStartedAt > 4000) {
      media.failed.add(media.clip)
      media.clip = null
      media.source = 'pending'
      media.nextIdleAt = 0
    }
    if (anim !== null && !media.failed.has(anim)) {
      if (media.clip !== anim) playClip(pet, anim)
      return
    }
    const due = media.clip === null || now >= media.nextIdleAt
    if (!due) return
    let chosen = null
    for (let offset = 0; offset < shared.IDLE_CLIPS.length; offset += 1) {
      const index = (media.idleIndex + offset) % shared.IDLE_CLIPS.length
      const candidate = shared.IDLE_CLIPS[index]
      if (media.failed.has(candidate)) continue
      chosen = candidate
      media.idleIndex = index
      break
    }
    media.nextIdleAt = now + IDLE_ROTATE_MS
    if (chosen === null) {
      showSvg(pet)
      return
    }
    if (chosen !== media.clip || media.source === 'svg') playClip(pet, chosen)
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
      trail: [{ t: now, x, y }],
      lastAt: now,
      startX: x,
      startY: y,
      startedAt: now,
      moved: 0,
      hadPopover
    }
    // 抓起来就停住动能，交给弹簧跟随；松手再按轨迹给初速度。
    pet.body = shared.createBody({ ...pet.body, vx: 0, vy: 0 }, area)
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
      pet.body = shared.throwBody(pet.body, velocity, area)
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
  }

  // -------------------------------------------------------------------------
  // 输入 / 生命周期
  // -------------------------------------------------------------------------

  function trackPointer (x, y) {
    pointer = { x, y }
    if (drag !== null) {
      moveDrag(x, y)
      updateUiHover()
      return
    }
    evaluate(pointer)
    updateUiHover()
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
    if (drag === null) return
    finishDrag(event.clientX, event.clientY)
  })
  window.addEventListener('pointercancel', () => abortDrag())
  window.addEventListener('mouseup', (event) => {
    if (inputLocked && event.isTrusted) return
    if (drag === null) return
    finishDrag(event.clientX, event.clientY)
  })

  window.addEventListener('blur', () => {
    if (inputLocked) return
    abortDrag()
    closePopover('blur')
    setBusy(false)
    releaseHover()
  })
  document.addEventListener('visibilitychange', () => {
    if (inputLocked || !document.hidden) return
    abortDrag()
    closePopover('hidden')
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
      pet.body = shared.resizeBodies([pet.body], area)[0]
      applyTransform(pet)
    }
    if (drag !== null) abortDrag()
    closePopover('resize')
    layoutUi(true)
    evaluate(pointer, true)
    reportRects(true)
  })

  window.addEventListener('pointerdown', (event) => {
    if (ui.popover === null) return
    const target = event.target
    if (!(target instanceof Element)) return
    // 点在弹层或宠物身上由它们自己处理；点桌面空白处 = 关掉弹层并交还租约。
    if (ui.popover.el.contains(target)) return
    if (target.closest('.lp-pet') !== null) return
    closePopover('outside')
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

    for (const pet of pets.values()) {
      if (drag !== null && drag.id === pet.id) {
        pet.body = shared.dragBody(pet.body, drag.target, area, dt)
      } else {
        pet.body = shared.stepBody(pet.body, area, dt)
      }
      applyTransform(pet)
      updateMedia(pet, now)
    }
    // 弹层/卡片跟着宠物走；overlay 矩形按 10Hz 重新上报，静止时靠心跳。
    if (ui.popover !== null || ui.prompt !== null || ui.recall !== null || ui.notice !== null) {
      layoutUi(false)
    }
    reportRects(false)
  }

  // -------------------------------------------------------------------------
  // 接线
  // -------------------------------------------------------------------------

  if (api && typeof api.onScene === 'function') api.onScene(applyScene)
  if (api && typeof api.onActionResult === 'function') api.onActionResult(handleActionResult)
  if (api && typeof api.ready === 'function') api.ready()
  rafId = requestAnimationFrame(frame)

  // 给调试脚本一个只读探针（不参与判定）。
  Object.defineProperty(globalThis, '__localPetDebug', {
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
          if (pet === null) return false
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
          return drag !== null
        }
        if (phase === 'blur') {
          syntheticDrag = false
          window.dispatchEvent(new Event('blur'))
          return drag === null
        }
        if (phase === 'up') {
          const hadDrag = drag !== null
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
          const button = element.closest('[data-lp-action]')
          if (button !== null) {
            button.click()
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
          recallChip: ui.recall === null ? null : { nickname: scene.controls.recall.nickname },
          notice: ui.notice === null ? null : { text: ui.notice.text, at: ui.notice.at },
          lease: ui.lease,
          pending: [...ui.pending.values()].map((pending) => ({
            id: pending.id,
            action: pending.action,
            deviceId: pending.deviceId ?? null
          })),
          hoverSuppressed: ui.hoverSuppressed
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
          label: pet.item.label,
          anim: pet.item.anim,
          x: round(pet.body.x),
          y: round(pet.body.y),
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
