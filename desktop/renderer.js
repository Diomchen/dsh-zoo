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
 * 拖拽：pointerdown 立刻申请输入租约（busy），每 400ms 续期；pointerup/pointercancel/
 * window blur/页面隐藏/2.5s 无移动都会释放。宠物落后于光标、光标跑到矩形外时，
 * 靠租约保持窗口可交互，pointermove/pointerup 才不会断。
 */

;(function () {
  'use strict'

  const shared = globalThis.LocalPetShared
  const api = globalThis.localPetDesktop
  const stage = document.getElementById('stage')
  if (!shared || !stage) return

  const IDLE_ROTATE_MS = 4500
  /** 宠物在动时的矩形上报节拍；静止时降到心跳，避免无意义 IPC。 */
  const RECT_REPORT_MS = 33
  const RECT_HEARTBEAT_MS = 300
  /** 拖拽中这么久没有任何 pointermove：渲染端自己收手（主进程的租约会更早过期）。 */
  const DRAG_TIMEOUT_MS = 2500

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
      // 已经 busy 时再调一次 = 一次显式续期（pointerdown 后不会等 400ms 心跳）。
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

  function hitAt (point) {
    if (point === null) return null
    return shared.hitTestRects(currentRects(), point)
  }

  /** 按当前本地位置重新判定光标是否在宠物上；force 时即使没变也重报（场景换过）。 */
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
    drag = {
      id: pet.id,
      pointerId: pointerId ?? null,
      offsetX: x - pet.body.x,
      offsetY: y - pet.body.y,
      target: { x: pet.body.x, y: pet.body.y },
      trail: [{ t: now, x, y }],
      lastAt: now
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
    setBusy(true)
  }

  function moveDrag (x, y) {
    if (drag === null) return
    const now = performance.now()
    drag.lastAt = now
    drag.target = { x: x - drag.offsetX, y: y - drag.offsetY }
    const last = drag.trail[drag.trail.length - 1]
    if (last === undefined || now - last.t > 4 || Math.abs(x - last.x) > 0.5 || Math.abs(y - last.y) > 0.5) {
      drag.trail.push({ t: now, x, y })
    }
    // 只留最近 400ms；投掷取最后 140ms。
    while (drag.trail.length > 2 && now - drag.trail[0].t > 400) drag.trail.shift()
  }

  function finishDrag (x, y) {
    if (drag === null) return
    const current = drag
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
    setBusy(false)
    if (x !== null && y !== null) pointer = { x, y }
    evaluate(pointer, true)
    reportRects(true)
  }

  /** 取消拖拽（blur/取消/超时/工作区变化）：不投掷，位置停在当前弹簧处。 */
  function abortDrag () {
    if (drag === null) return
    const current = drag
    drag = null
    syntheticDrag = false
    const pet = pets.get(current.id)
    if (pet !== undefined) delete pet.el.dataset.dragging
    setBusy(false)
    evaluate(pointer, true)
    reportRects(true)
  }

  // -------------------------------------------------------------------------
  // 输入 / 生命周期
  // -------------------------------------------------------------------------

  window.addEventListener('pointermove', (event) => {
    if (inputLocked && event.isTrusted) return
    if (syntheticDrag && event.isTrusted) return
    pointer = { x: event.clientX, y: event.clientY }
    if (drag !== null) moveDrag(event.clientX, event.clientY)
    else evaluate(pointer)
  }, { passive: true })

  // forward 模式下 Electron 转发的是 mouse 事件；没有 pointer 事件的合成输入也要能拖。
  window.addEventListener('mousemove', (event) => {
    if (inputLocked && event.isTrusted) return
    if (syntheticDrag && event.isTrusted) return
    pointer = { x: event.clientX, y: event.clientY }
    if (drag !== null) moveDrag(event.clientX, event.clientY)
    else evaluate(pointer)
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
    setBusy(false)
    releaseHover()
  })
  document.addEventListener('visibilitychange', () => {
    if (inputLocked || !document.hidden) return
    abortDrag()
    setBusy(false)
    releaseHover()
  })
  window.addEventListener('mouseleave', () => {
    // 拖拽中光标离开窗口是正常的：租约必须留着，等 pointerup 或超时。
    if (drag === null) releaseHover()
  })

  window.addEventListener('resize', () => {
    area = readArea()
    for (const pet of pets.values()) {
      pet.body = shared.resizeBodies([pet.body], area)[0]
      applyTransform(pet)
    }
    if (drag !== null) abortDrag()
    evaluate(pointer, true)
    reportRects(true)
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
    reportRects(false)
  }

  // -------------------------------------------------------------------------
  // 接线
  // -------------------------------------------------------------------------

  if (api && typeof api.onScene === 'function') api.onScene(applyScene)
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
          const rect = hitAt(point)
          const pet = rect === null ? undefined : pets.get(rect.id)
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
