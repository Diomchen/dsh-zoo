/**
 * 渲染端：只做两件事——把场景画出来，把「光标在不在某个命中矩形里」报给主进程。
 *
 * 命中判定用 desktop/shared.js，和主进程的兜底判定是同一份代码；主进程仍会用真实光标位置
 * 复核，所以这里的结论最多只是「申请」，不可能单方面把窗口变成可交互。
 *
 * 心跳：光标停在命中区期间每 350ms 报一次 inside=true。主进程只认最近 1.2s 内的确认——
 * 渲染端崩了/卡了/被挂起，心跳一停就自动恢复点击穿透（fail-closed）。
 */
;(function () {
  'use strict'

  const shared = globalThis.LocalPetShared
  const api = globalThis.localPetDesktop
  const stage = document.getElementById('stage')

  if (!shared || !stage) return

  let scene = shared.emptyScene()
  let lastPoint = null
  let lastInside = false
  let heartbeat = null
  /** id → DOM 节点：ticket 08 会逐帧更新位置，按 id 复用节点，避免整棵树重建。 */
  const nodes = new Map()

  function report (inside) {
    if (!api || typeof api.reportHover !== 'function') return
    try {
      api.reportHover(inside === true)
    } catch {
      // 主进程没了/管道断了：什么都不做，窗口本来就会随进程消失
    }
  }

  function setHeartbeat (on) {
    if (on) {
      if (heartbeat === null) {
        heartbeat = setInterval(() => {
          if (lastInside) report(true)
        }, shared.HOVER_HEARTBEAT_MS)
      }
    } else if (heartbeat !== null) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  function render () {
    const alive = new Set()
    for (const item of scene.items) {
      alive.add(item.id)
      let el = nodes.get(item.id)
      if (el === undefined) {
        el = document.createElement('div')
        el.className = 'lp-item'
        el.dataset.id = item.id
        const label = document.createElement('span')
        label.className = 'lp-item-label'
        el.appendChild(label)
        nodes.set(item.id, el)
      }
      if (el.dataset.kind !== item.kind) el.dataset.kind = item.kind
      el.style.left = item.x + 'px'
      el.style.top = item.y + 'px'
      el.style.width = item.width + 'px'
      el.style.height = item.height + 'px'
      el.style.background = item.color
      const label = el.firstElementChild
      if (label !== null && label.textContent !== item.label) label.textContent = item.label
      // appendChild 会把已有节点移到末尾：DOM 顺序 = 场景顺序（后画的在上）
      stage.appendChild(el)
    }
    for (const [id, el] of nodes) {
      if (alive.has(id)) continue
      el.remove()
      nodes.delete(id)
    }
  }

  /**
   * @param {{x:number,y:number}|null} point 窗口局部坐标（clientX/clientY）
   * @param {boolean} [forceReport] 场景刚换过：即使 inside 没变也重报一次（主进程刚作废了旧确认）
   */
  function evaluate (point, forceReport) {
    lastPoint = point
    const inside = point !== null && shared.hitTestScene(scene, point) !== null
    if (inside) {
      // 每帧都刷新心跳时间戳不划算；只在转变或主进程要求时发。
      if (inside !== lastInside || forceReport) {
        lastInside = true
        setHeartbeat(true)
        report(true)
      }
      return
    }
    if (lastInside || forceReport) {
      lastInside = false
      setHeartbeat(false)
      report(false)
    }
  }

  function release () {
    lastPoint = null
    if (!lastInside) return
    lastInside = false
    setHeartbeat(false)
    report(false)
  }

  function applyScene (next) {
    scene = shared.normalizeScene(next)
    render()
    // 场景换了，主进程已把旧的悬停确认作废：按最后已知光标位置重新判定并强制上报一次。
    evaluate(lastPoint, true)
  }

  window.addEventListener('mousemove', (event) => {
    evaluate({ x: event.clientX, y: event.clientY })
  }, { passive: true })

  // 指针离开窗口（forward 模式下也会收到）：立刻交还穿透。
  window.addEventListener('mouseleave', release, { passive: true })
  document.addEventListener('mouseleave', release, { passive: true })
  window.addEventListener('blur', release)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) release()
  })

  if (api && typeof api.onScene === 'function') api.onScene(applyScene)
  if (api && typeof api.ready === 'function') api.ready()

  // 给调试脚本一个只读探针（不参与判定）：当前场景与最近一次命中的道具 id。
  Object.defineProperty(globalThis, '__localPetDebug', {
    value: Object.freeze({
      scene: () => scene,
      lastPoint: () => lastPoint,
      lastInside: () => lastInside,
      hit: () => (lastPoint === null ? null : (shared.hitTestScene(scene, lastPoint)?.id ?? null))
    }),
    configurable: false,
    writable: false
  })
})()

