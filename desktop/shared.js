/**
 * 桌面 helper 与宿主共用的纯逻辑：stdio 行协议、场景归一化、命中判定、点击穿透的安全裁定。
 *
 * 为什么是 UMD（同时给三种运行环境用）：
 *   - Electron 主进程（desktop/main.js，CJS）—— require('./shared.js')；
 *   - 宿主（src/desktop.js，ESM）—— `import shared from '../desktop/shared.js'`（Node 按最近的
 *     desktop/package.json 把它当 CJS，默认导出即 module.exports）；
 *   - 渲染页（desktop/renderer.js，普通 <script>）—— 挂到 globalThis.LocalPetShared。
 * 一份实现、一份测试，避免「主进程的命中判定」和「渲染端的命中判定」各写一套然后漂移。
 *
 * 坐标约定：
 *   - 场景里的矩形一律是**窗口局部 DIP**（CSS 像素），渲染端直接拿 clientX/clientY 比；
 *   - 主进程拿 screen.getCursorScreenPoint()（屏幕 DIP）减去 win.getBounds() 左上角再比，两者同尺度；
 *   - 窗口 = 主显示器工作区，因此窗口局部坐标也就是工作区局部坐标。
 *
 * 安全约定（这一层是点击穿透的「否决权」所在，见 ADR-0005）：
 *   `shouldBeInteractive()` 只在**两条独立通道同时说在命中矩形内**时返回 true：
 *     a) 主进程按真实光标位置（可被测试注入覆盖）算出在矩形内；
 *     b) 渲染端在最近 `maxAgeMs` 内上报过 inside=true（心跳，不是一次性事件）。
 *   任何一条缺失都回到点击穿透。渲染端崩了、卡了、骗人，都只会让窗口更早恢复穿透。
 */
;(function (root, factory) {
  'use strict'
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.LocalPetShared = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  /** 单行上限：协议行很小，64 KiB 已经比任何合法消息大两个数量级。 */
  const MAX_LINE_LENGTH = 64 * 1024
  const MAX_SCENE_ITEMS = 64
  const MAX_ID_LENGTH = 64
  const MAX_LABEL_LENGTH = 40
  const MAX_PATH_LENGTH = 1024
  const MAX_ERROR_LENGTH = 500
  const MAX_DISPLAYS = 8
  const MAX_COORD = 1e6
  const MAX_ITEM_SIZE = 10000

  /** 渲染端「我还在命中区里」的心跳间隔；主进程允许的最大陈旧时间。 */
  const HOVER_HEARTBEAT_MS = 350
  const HOVER_CONFIRM_MAX_AGE_MS = 1200
  /** 主进程按真实光标位置兜底轮询的间隔。 */
  const POINTER_POLL_MS = 100
  /**
   * 渲染端通道完全没消息时，主进程在光标停留多久后自行接管鼠标。
   *
   * 为什么需要它：macOS 上 `forward: true` 依赖 Electron 的鼠标转发钩子，而 helper 是
   * 不抢焦点的后台应用——钩子失效/被系统拦掉时渲染端一个 mousemove 都收不到（本机实测：
   * 光标停在命中区里，渲染端零事件）。没有这条兜底，宠物就永远点不到。
   *
   * 为什么安全：主进程每一拍都按**真实光标位置**复核，光标离开命中矩形 100ms 内必然恢复穿透；
   * 这条兜底最多让「光标正压在宠物上」的那块小矩形暂时接管鼠标，且移动即释放。
   */
  const MAIN_FALLBACK_DWELL_MS = 300

  const DEFAULT_COLOR = '#3b74d8'
  const ITEM_KINDS = ['placeholder', 'pet', 'card']

  function isFiniteNumber (value) {
    return typeof value === 'number' && Number.isFinite(value)
  }

  function clampNumber (value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  function normalizeId (value) {
    if (typeof value !== 'string') return null
    const id = value.trim()
    if (id === '' || id.length > MAX_ID_LENGTH) return null
    // id 只用来做键和日志，限制成可安全打印的字符集。
    return /^[A-Za-z0-9._:-]+$/.test(id) ? id : null
  }

  function normalizeToken (value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'string') return null
    const token = value.trim()
    return token === '' || token.length > MAX_ID_LENGTH ? null : token
  }

  function normalizeText (value, fallback, maxLength) {
    if (typeof value !== 'string') return fallback
    // eslint-disable-next-line no-control-regex
    const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    if (text === '') return fallback
    return text.length > maxLength ? text.slice(0, maxLength) : text
  }

  function normalizeLabel (value, fallback) {
    return normalizeText(value, fallback, MAX_LABEL_LENGTH)
  }

  function normalizeColor (value) {
    return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : DEFAULT_COLOR
  }

  function normalizePath (value) {
    if (typeof value !== 'string') return null
    const path = value.trim()
    if (path === '' || path.length > MAX_PATH_LENGTH) return null
    if (path.includes('\u0000')) return null
    // 只写绝对路径：helper 的 cwd 由宿主决定，相对路径落在哪里没有意义。
    return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : null
  }

  /** 矩形：有限数、正尺寸；溢出值夹到 ±MAX_COORD，坏矩形返回 null。 */
  function normalizeRect (raw) {
    if (raw === null || typeof raw !== 'object') return null
    const x = Number(raw.x)
    const y = Number(raw.y)
    const width = Number(raw.width)
    const height = Number(raw.height)
    if (![x, y, width, height].every(Number.isFinite)) return null
    if (width <= 0 || height <= 0) return null
    return {
      x: clampNumber(x, -MAX_COORD, MAX_COORD),
      y: clampNumber(y, -MAX_COORD, MAX_COORD),
      width: clampNumber(width, 0.001, MAX_ITEM_SIZE),
      height: clampNumber(height, 0.001, MAX_ITEM_SIZE)
    }
  }

  function normalizeItem (raw) {
    if (raw === null || typeof raw !== 'object') return null
    const id = normalizeId(raw.id)
    if (id === null) return null
    if (!ITEM_KINDS.includes(raw.kind)) return null
    const rect = normalizeRect(raw)
    if (rect === null) return null
    return {
      id,
      kind: raw.kind,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      label: normalizeLabel(raw.label, raw.kind),
      color: normalizeColor(raw.color)
    }
  }

  /**
   * 场景是宿主 → helper 的唯一绘制输入。
   * 未知字段、未知 kind、重复 id 一律丢掉；items 数量有上限，保证一条消息不会超行。
   */
  function normalizeScene (raw) {
    const items = []
    if (raw !== null && typeof raw === 'object' && Array.isArray(raw.items)) {
      const seen = new Set()
      for (const candidate of raw.items) {
        if (items.length >= MAX_SCENE_ITEMS) break
        const item = normalizeItem(candidate)
        if (item === null || seen.has(item.id)) continue
        seen.add(item.id)
        items.push(item)
      }
    }
    return { version: 1, items }
  }

  function emptyScene () {
    return { version: 1, items: [] }
  }

  /** 编码一行；超长返回 null，调用方必须放弃发送（而不是把管道写坏）。 */
  function encodeMessage (message) {
    if (message === null || typeof message !== 'object') return null
    let line
    try {
      line = JSON.stringify(message)
    } catch {
      return null
    }
    if (typeof line !== 'string' || line.length > MAX_LINE_LENGTH) return null
    return line + '\n'
  }

  function parseLine (line) {
    if (typeof line !== 'string') return { ok: false, error: 'not-string' }
    const trimmed = line.trim()
    if (trimmed === '') return { ok: false, error: 'empty' }
    let value
    try {
      value = JSON.parse(trimmed)
    } catch {
      return { ok: false, error: 'bad-json' }
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'not-object' }
    }
    return { ok: true, value }
  }

  /**
   * 按 \n 切行，行上限硬约束。超长行不解析、不缓存，丢弃到下一个换行符为止；
   * 返回的条目只有 { type:'line' } 与 { type:'oversize' } 两种，超过上限只报一次。
   */
  function createLineParser (options = {}) {
    const maxLength = Number.isFinite(options.maxLineLength) && options.maxLineLength > 0
      ? options.maxLineLength
      : MAX_LINE_LENGTH
    let buffered = ''
    let discardingTail = false

    return {
      push (chunk) {
        const out = []
        buffered += String(chunk)
        let index
        while ((index = buffered.indexOf('\n')) !== -1) {
          const raw = buffered.slice(0, index)
          buffered = buffered.slice(index + 1)
          if (discardingTail) {
            // 这是超长行的尾巴：已经报过一次 oversize，这里静默吞掉。
            discardingTail = false
            continue
          }
          if (raw.length > maxLength) {
            out.push({ type: 'oversize' })
            continue
          }
          out.push({ type: 'line', line: raw.endsWith('\r') ? raw.slice(0, -1) : raw })
        }
        if (discardingTail) {
          // 这一整段都没有换行：仍然是那条超长行的尾巴，直接丢掉，别把内存撑爆。
          buffered = ''
        } else if (buffered.length > maxLength) {
          discardingTail = true
          buffered = ''
          out.push({ type: 'oversize' })
        }
        return out
      },
      reset () {
        buffered = ''
        discardingTail = false
      },
      pending () {
        return buffered.length
      }
    }
  }

  function normalizePoint (raw) {
    if (raw === null || typeof raw !== 'object') return null
    const x = Number(raw.x)
    const y = Number(raw.y)
    if (![x, y].every(Number.isFinite)) return null
    return { x: clampNumber(x, -MAX_COORD, MAX_COORD), y: clampNumber(y, -MAX_COORD, MAX_COORD) }
  }

  function normalizeDisplay (raw, index) {
    if (raw === null || typeof raw !== 'object') return null
    const id = Number(raw.id)
    const bounds = normalizeRect(raw.bounds)
    const workArea = normalizeRect(raw.workArea)
    if (!Number.isFinite(id) || bounds === null || workArea === null) return null
    return {
      id,
      index,
      bounds,
      workArea,
      scaleFactor: Number.isFinite(Number(raw.scaleFactor)) && Number(raw.scaleFactor) > 0
        ? Number(raw.scaleFactor)
        : 1,
      primary: raw.primary === true
    }
  }

  /** 宿主 → helper 的命令白名单。未知 type / 缺字段一律 not-ok，helper 只记调试信息。 */
  function normalizeHostCommand (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'not-object' }
    }
    const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
    const id = normalizeToken(raw.id)
    switch (type) {
      case 'show':
      case 'hide':
      case 'quit':
        return { ok: true, command: { type, id } }
      case 'ping':
      case 'status':
        return { ok: true, command: { type, id } }
      case 'update':
        if (raw.scene === null || typeof raw.scene !== 'object' || Array.isArray(raw.scene)) {
          return { ok: false, error: 'bad-scene' }
        }
        return { ok: true, command: { type, id, scene: normalizeScene(raw.scene) } }
      case 'shot': {
        const path = normalizePath(raw.path)
        if (path === null) return { ok: false, error: 'bad-path' }
        return { ok: true, command: { type, id, path } }
      }
      case 'pointer': {
        if (raw.clear === true) return { ok: true, command: { type, id, point: null } }
        const point = normalizePoint(raw)
        if (point === null) return { ok: false, error: 'bad-point' }
        return { ok: true, command: { type, id, point } }
      }
      case 'debug-move': {
        const point = normalizePoint(raw)
        if (point === null) return { ok: false, error: 'bad-point' }
        return { ok: true, command: { type, id, point } }
      }
      case 'debug-freeze-hover':
        return { ok: true, command: { type, id, frozen: raw.frozen !== false } }
      default:
        return { ok: false, error: 'unknown-type' }
    }
  }

  function normalizeStatus (raw) {
    const bounds = normalizeRect(raw.bounds)
    const pointer = normalizePoint(raw.pointer)
    return {
      ignoring: raw.ignoring !== false,
      sceneItems: Number.isInteger(raw.sceneItems) && raw.sceneItems >= 0 ? raw.sceneItems : 0,
      hoverInside: raw.hoverInside === true,
      lastHoverAgeMs: isFiniteNumber(raw.lastHoverAgeMs) && raw.lastHoverAgeMs >= 0
        ? raw.lastHoverAgeMs
        : null,
      insideForMs: isFiniteNumber(raw.insideForMs) && raw.insideForMs >= 0
        ? raw.insideForMs
        : null,
      hoverFrozen: raw.hoverFrozen === true,
      visible: raw.visible === true,
      focused: raw.focused === true,
      focusable: raw.focusable === true,
      alwaysOnTop: raw.alwaysOnTop === true,
      allWorkspaces: raw.allWorkspaces === true,
      bounds,
      pointer,
      debug: raw.debug === true
    }
  }

  /** helper → 宿主的事件白名单。未知字段忽略，坏事件整条丢弃。 */
  function normalizeHelperEvent (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'not-object' }
    }
    const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
    const id = normalizeToken(raw.id)
    switch (type) {
      case 'ready': {
        const workArea = normalizeRect(raw.workArea)
        if (workArea === null) return { ok: false, error: 'bad-work-area' }
        const displays = []
        if (Array.isArray(raw.displays)) {
          for (const candidate of raw.displays) {
            if (displays.length >= MAX_DISPLAYS) break
            const display = normalizeDisplay(candidate, displays.length)
            if (display !== null) displays.push(display)
          }
        }
        return {
          ok: true,
          event: {
            type,
            id,
            pid: Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null,
            workArea,
            displays,
            debug: raw.debug === true,
            shotMode: raw.shotMode === true
          }
        }
      }
      case 'hit': {
        const point = normalizePoint(raw.point)
        const rect = normalizeRect(raw.rect)
        return {
          ok: true,
          event: {
            type,
            id,
            inside: raw.inside === true,
            interactive: raw.interactive === true,
            point,
            rect,
            reason: normalizeLabel(raw.reason, '')
          }
        }
      }
      case 'shot': {
        const path = normalizePath(raw.path)
        if (path === null) return { ok: false, error: 'bad-path' }
        return {
          ok: true,
          event: {
            type,
            id,
            path,
            width: Number.isInteger(raw.width) && raw.width > 0 ? raw.width : 0,
            height: Number.isInteger(raw.height) && raw.height > 0 ? raw.height : 0,
            bytes: Number.isInteger(raw.bytes) && raw.bytes >= 0 ? raw.bytes : 0
          }
        }
      }
      case 'error':
        return {
          ok: true,
          event: {
            type,
            id,
            code: normalizeLabel(raw.code, 'helper-error'),
            message: normalizeText(raw.message, 'unknown error', MAX_ERROR_LENGTH)
          }
        }
      case 'pong':
        return { ok: true, event: { type, id } }
      case 'status':
        return { ok: true, event: { type, id, status: normalizeStatus(raw) } }
      default:
        return { ok: false, error: 'unknown-type' }
    }
  }

  function rectContains (rect, point) {
    if (rect === null || typeof rect !== 'object' || point === null || typeof point !== 'object') {
      return false
    }
    return point.x >= rect.x &&
      point.x < rect.x + rect.width &&
      point.y >= rect.y &&
      point.y < rect.y + rect.height
  }

  function hitTestRects (rects, point) {
    if (!Array.isArray(rects) || point === null || typeof point !== 'object') return null
    for (let i = rects.length - 1; i >= 0; i -= 1) {
      if (rectContains(rects[i], point)) return rects[i]
    }
    return null
  }

  /** 场景 items 本身就是命中区：宠物身体、卡片、占位方块都按自己的矩形接指针。 */
  function hitTestScene (scene, point) {
    if (scene === null || typeof scene !== 'object' || !Array.isArray(scene.items)) return null
    for (let i = scene.items.length - 1; i >= 0; i -= 1) {
      const item = scene.items[i]
      if (rectContains(item, point)) return item
    }
    return null
  }

  function rectsOfScene (scene) {
    if (scene === null || typeof scene !== 'object' || !Array.isArray(scene.items)) return []
    return scene.items.map((item) => ({
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height
    }))
  }

  function unionRect (rects) {
    if (!Array.isArray(rects) || rects.length === 0) return null
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const rect of rects) {
      if (rect === null || typeof rect !== 'object') continue
      if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue
      left = Math.min(left, rect.x)
      top = Math.min(top, rect.y)
      right = Math.max(right, rect.x + rect.width)
      bottom = Math.max(bottom, rect.y + rect.height)
    }
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null
    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  function toLocalPoint (screenPoint, bounds) {
    const point = normalizePoint(screenPoint)
    const area = normalizeRect(bounds)
    if (point === null || area === null) return null
    return { x: point.x - area.x, y: point.y - area.y }
  }

  function toScreenPoint (localPoint, bounds) {
    const point = normalizePoint(localPoint)
    const area = normalizeRect(bounds)
    if (point === null || area === null) return null
    return { x: point.x + area.x, y: point.y + area.y }
  }

  /**
   * 点击穿透的唯一裁定（主进程直接照做）。
   *
   * 两种「可以接管鼠标」的理由，优先级从高到低：
   *   1. hovering：主进程看光标在命中区 + 渲染端最近 maxAgeMs 内确认过（正常路径，1 帧内响应）；
   *   2. main-fallback：光标在命中区里连续停留满 fallbackDwellMs，但渲染端一直没消息
   *      （macOS 后台应用收不到 forward 鼠标事件时的兜底，见 MAIN_FALLBACK_DWELL_MS）。
   * 光标不在命中区永远是 false，渲染端说什么都不能翻案。
   *
   * @returns {{interactive:boolean, reason:'no-scene'|'outside'|'waiting-for-confirmation'|'stale-renderer-confirmation'|'hovering'|'main-fallback'}}
   */
  function shouldBeInteractive (options = {}) {
    const scene = options.scene
    const point = normalizePoint(options.point)
    if (scene === null || typeof scene !== 'object' || !Array.isArray(scene.items) || scene.items.length === 0) {
      return { interactive: false, reason: 'no-scene' }
    }
    if (point === null || hitTestScene(scene, point) === null) {
      return { interactive: false, reason: 'outside' }
    }
    const now = Number.isFinite(options.now) ? options.now : Date.now()
    const lastHoverAt = Number.isFinite(options.lastHoverAt) ? options.lastHoverAt : 0
    const maxAge = Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
      ? options.maxAgeMs
      : HOVER_CONFIRM_MAX_AGE_MS
    if (lastHoverAt > 0 && now - lastHoverAt <= maxAge) {
      return { interactive: true, reason: 'hovering' }
    }
    const insideSince = Number.isFinite(options.insideSince) ? options.insideSince : 0
    const dwell = Number.isFinite(options.fallbackDwellMs) && options.fallbackDwellMs >= 0
      ? options.fallbackDwellMs
      : MAIN_FALLBACK_DWELL_MS
    if (options.allowMainFallback !== false && insideSince > 0 && now - insideSince >= dwell) {
      return { interactive: true, reason: 'main-fallback' }
    }
    return {
      interactive: false,
      reason: lastHoverAt > 0 ? 'stale-renderer-confirmation' : 'waiting-for-confirmation'
    }
  }

  /**
   * 占位方块的默认场景：右下偏上的位置，避开菜单栏与 Dock，尺寸随屏幕缩放。
   * 坐标是窗口局部坐标（窗口 = 工作区）。
   */
  function placeholderScene (workArea) {
    const area = normalizeRect(workArea) ?? { x: 0, y: 0, width: 1440, height: 900 }
    const size = clampNumber(Math.round(Math.min(area.width, area.height) * 0.16), 96, 180)
    const x = Math.max(24, Math.round(area.width - size - 56))
    const y = Math.max(24, Math.round((area.height - size) * 0.55))
    return {
      version: 1,
      items: [{
        id: 'placeholder',
        kind: 'placeholder',
        x,
        y,
        width: size,
        height: size,
        label: 'local-pet',
        color: DEFAULT_COLOR
      }]
    }
  }

  return {
    MAX_LINE_LENGTH,
    MAX_SCENE_ITEMS,
    MAX_ID_LENGTH,
    MAX_LABEL_LENGTH,
    MAX_PATH_LENGTH,
    MAX_ERROR_LENGTH,
    MAX_DISPLAYS,
    HOVER_HEARTBEAT_MS,
    HOVER_CONFIRM_MAX_AGE_MS,
    POINTER_POLL_MS,
    MAIN_FALLBACK_DWELL_MS,
    DEFAULT_COLOR,
    ITEM_KINDS,
    isFiniteNumber,
    normalizeId,
    normalizeRect,
    normalizePoint,
    normalizeScene,
    normalizeHostCommand,
    normalizeHelperEvent,
    emptyScene,
    encodeMessage,
    parseLine,
    createLineParser,
    rectContains,
    hitTestRects,
    hitTestScene,
    rectsOfScene,
    unionRect,
    toLocalPoint,
    toScreenPoint,
    shouldBeInteractive,
    placeholderScene
  }
})
