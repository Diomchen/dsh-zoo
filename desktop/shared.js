/**
 * 桌面 helper 与宿主共用的纯逻辑：stdio 行协议、场景 v2、宠物物理、命中判定、点击穿透的安全裁定。
 *
 * 为什么是 UMD（同时给三种运行环境用）：
 *   - Electron 主进程（desktop/main.js，CJS）—— require('./shared.js')；
 *   - 宿主（src/desktop.js，ESM）—— `import shared from '../desktop/shared.js'`（Node 按最近的
 *     desktop/package.json 把它当 CJS，默认导出即 module.exports）；
 *   - 渲染页（desktop/renderer.js，普通 <script>）—— 挂到 globalThis.LocalPetShared。
 * 一份实现、一份测试，避免「主进程的命中判定」和「渲染端的物理/命中」各写一套然后漂移。
 *
 * 坐标约定：
 *   - 场景里的矩形一律是**窗口局部 DIP**（CSS 像素），渲染端直接拿 clientX/clientY 比；
 *   - 主进程拿 screen.getCursorScreenPoint()（屏幕 DIP）减去 win.getBounds() 左上角再比，两者同尺度；
 *   - 窗口 = 主显示器工作区，因此窗口局部坐标也就是工作区局部坐标。
 *
 * 场景 v2 的分工（ticket 08）：
 *   - 宿主只决定「有谁、叫什么、在播什么」（items 的 id/role/label/anim/color），位置只在**新宠物
 *     出生**时用 item 的 x/y 作种子；
 *   - 渲染端在本地模拟位置与速度，逐帧把自己的命中矩形报给主进程（ipc `local-pet:rects`）；
 *   - 主进程不猜渲染端的位置：命中判定只用渲染端最近上报的矩形（过期就 fail-closed 回穿透）；
 *   - `reset: true` 让渲染端把每只宠物按 item 的 x/y 重新出生一次，用于 helper 重启/强制对账。
 *
 * 安全约定（这一层是点击穿透的「否决权」所在，见 ADR-0005）：
 *   `shouldBeInteractive()` 只在以下两种情况下返回 true：
 *     a) 渲染端拿着输入租约（`busy`，最近 `BUSY_LEASE_MS` 内有心跳）——拖拽时宠物会落后于
 *        光标，位置判定必须让位，否则窗口翻回穿透，pointermove/pointerup 全断；
 *     b) 主进程按真实光标位置算出在渲染端上报的命中矩形内，并且渲染端最近 `maxAgeMs` 内确认过
 *        inside（心跳，不是一次性事件）；渲染端完全没消息时按停留时长兜底。
 *   租约总会过期：渲染端崩了/卡了/失联，最多 BUSY_LEASE_MS 后自动恢复穿透。
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
  const MAX_ANIM_LENGTH = 64
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

  /**
   * 渲染端上报的命中矩形 / 输入租约的保鲜期。
   *
   * 渲染端在宠物移动时约 30Hz 上报矩形，静止时每 300ms 一次心跳；主进程只认这个窗口内的。
   * 过期 = 渲染端卡死/失联 → 没有命中区、没有租约，整窗回到穿透（fail-closed）。
   */
  const RENDERER_RECT_MAX_AGE_MS = 900
  /** 场景刚更新、渲染端还没上报矩形时的兜底：只用出生矩形，最多这么久。 */
  const SCENE_RECT_FALLBACK_MS = 800
  /** 拖拽输入租约：渲染端每 BUSY_HEARTBEAT_MS 续一次，主进程超过 BUSY_LEASE_MS 没收到就释放。 */
  const BUSY_HEARTBEAT_MS = 400
  const BUSY_LEASE_MS = 1500

  const DEFAULT_COLOR = '#3b74d8'
  const ITEM_KINDS = ['pet', 'card']
  const PET_ROLES = ['self', 'guest', 'visitor']
  const SCENE_VERSION = 2

  /** 宠物色板：self 固定第一格，客人按 deviceId 散列到其余颜色。 */
  const PET_COLORS = ['#3b74d8', '#2f8f5b', '#a8542f', '#7a4fd8', '#c2913b', '#2f8fa8', '#b04a86', '#5b7f2f']
  /** dsh-pet 不上报随机待机动作；没有动作时轮播这几段真实存在的素材。 */
  const IDLE_CLIPS = ['东张西望', '原地漂浮踏步', '原地小憩沉眠']

  /**
   * 物理参数。数值不是物理常量，只是「看起来像桌宠」的调参结果：
   * 重力够大、落地有可见反弹、地面摩擦让滑行很快停下、弹簧拖拽跟手但不硬贴。
   */
  const PHYSICS = Object.freeze({
    GRAVITY: 2600,
    BOUNCE: 0.52,
    WALL_BOUNCE: 0.4,
    /** 1/s 的指数衰减系数（不是每帧固定减多少，避免帧率影响手感）。 */
    GROUND_FRICTION: 4.2,
    AIR_FRICTION: 0.22,
    DRAG_STIFFNESS: 120,
    DRAG_DAMPING: 22,
    MAX_THROW_SPEED: 2400,
    /** 落地速度低于它就不再弹，避免在 ground 附近无限抖动。 */
    REST_SPEED: 120,
    /** 单帧最大步长：切后台回来时 dt 可能很大，钳住它物理才稳定。 */
    MAX_DT: 1 / 30,
    /** 宠物脚底离工作区底边的留白：昵称条不贴屏幕/ Dock 边，看起来才像"站在桌面上"。 */
    FLOOR_MARGIN: 8,
    /** 拖拽轨迹窗口（ms）：松手速度只取最近这么久的样本。 */
    THROW_TRAIL_MS: 140
  })

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

  /** 动画名会拼进 `localpet://asset/<name>.webm`：和宿主协议层同一套字符约束。 */
  function normalizeAnim (value) {
    if (typeof value !== 'string') return null
    const name = value.trim()
    if (name === '' || name.length > MAX_ANIM_LENGTH) return null
    if (name === '.' || name === '..') return null
    if (/[\\/\u0000-\u001f\u007f]/.test(name)) return null
    return name
  }

  function normalizeRole (value) {
    return PET_ROLES.includes(value) ? value : null
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
    const isPet = raw.kind === 'pet'
    return {
      id,
      kind: raw.kind,
      role: isPet ? normalizeRole(raw.role) : null,
      anim: isPet ? normalizeAnim(raw.anim) : null,
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
   *
   * v2 在 v1 的矩形/颜色/标签上加了 `role`（self/guest/visitor）与 `anim`（dsh-pet 素材名），
   * 以及整包的 `reset`（渲染端重新出生所有宠物）。未知字段、未知 kind、重复 id 一律丢掉；
   * items 数量有上限，保证一条消息不会超行。
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
    return { version: SCENE_VERSION, reset: raw !== null && typeof raw === 'object' && raw.reset === true, items }
  }

  function emptyScene () {
    return { version: SCENE_VERSION, reset: false, items: [] }
  }

  function normalizeArea (area) {
    const width = Number(area?.width)
    const height = Number(area?.height)
    return {
      width: Number.isFinite(width) && width > 0 ? Math.min(width, MAX_ITEM_SIZE) : 1440,
      height: Number.isFinite(height) && height > 0 ? Math.min(height, MAX_ITEM_SIZE) : 900
    }
  }

  function hashString (value) {
    const text = typeof value === 'string' ? value : String(value ?? '')
    let hash = 2166136261
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
  }

  function colorForPet (seed) {
    return PET_COLORS[hashString(seed) % PET_COLORS.length]
  }

  /**
   * 新宠物的初始横向速度：由 id 决定，所以同一只宠物每次出生都朝同一边、速度一样
   * （截图/冒烟可复现，但每只又各不相同）。竖向永远从 0 开始，由重力接管。
   */
  function initialVelocity (id) {
    const hash = hashString(id)
    const direction = (hash & 1) === 0 ? 1 : -1
    const speed = 48 + (hash % 93)
    return { vx: direction * speed, vy: 0 }
  }

  /**
   * 宿主 → helper 的宠物场景。位置只作为**出生点**：已经在场上的宠物由渲染端保留自己的
   * 位置/速度，宿主改 x/y 不会让它瞬移（要瞬移就带 reset:true）。
   *
   * 纯函数，不读时钟/随机数：同一份 pets + workArea 永远得到同一份场景。
   *
   * @param {Array<{id:string,role?:string,label?:string,anim?:string|null,color?:string}>} pets
   * @param {{x?:number,y?:number,width:number,height:number}} workArea
   * @param {{size?:number,reset?:boolean}} [options]
   */
  function petScene (pets, workArea, options = {}) {
    const area = normalizeArea(workArea)
    const list = []
    if (Array.isArray(pets)) {
      const seen = new Set()
      for (const raw of pets) {
        if (list.length >= MAX_SCENE_ITEMS) break
        if (raw === null || typeof raw !== 'object') continue
        const id = normalizeId(raw.id)
        if (id === null || seen.has(id)) continue
        seen.add(id)
        const role = normalizeRole(raw.role) ?? 'guest'
        list.push({
          id,
          role,
          label: normalizeLabel(raw.label, role === 'self' ? '我' : '邻居'),
          anim: normalizeAnim(raw.anim),
          color: normalizeColor(raw.color)
        })
      }
    }

    const sizeOption = Number(options.size)
    const base = Math.round(Math.min(area.width, area.height) * 0.12)
    let size = Number.isFinite(sizeOption) && sizeOption >= 16
      ? Math.round(sizeOption)
      : base
    size = clampNumber(size, 16, 176)
    size = Math.min(size, Math.floor(area.width), Math.floor(area.height))
    let labelHeight = clampNumber(Math.round(size * 0.22), 14, 32)
    if (size + labelHeight > area.height) labelHeight = Math.max(0, Math.floor(area.height - size))
    const width = Math.max(1, size)
    const height = Math.max(1, Math.min(area.height, size + labelHeight))
    const margin = clampNumber(Math.round(Math.min(area.width, area.height) * 0.035), 8, 48)
    const span = Math.max(0, area.width - margin * 2 - width)
    const ground = groundY({ height }, area)
    const count = list.length

    const items = list.map((pet, index) => {
      const x = count <= 1
        ? Math.round((area.width - width) / 2)
        : Math.round(margin + (span * index) / (count - 1))
      return {
        id: pet.id,
        kind: 'pet',
        role: pet.role,
        anim: pet.anim,
        x,
        y: ground,
        width,
        height,
        label: pet.label,
        color: pet.color
      }
    })
    return { version: SCENE_VERSION, reset: options.reset === true, items }
  }

  /** 截图/冒烟用的固定演示场景：自己的 + 两位客人，走真实素材。 */
  function demoPetScene (workArea) {
    return petScene([
      { id: 'self', role: 'self', label: '小蓝', anim: '东张西望', color: PET_COLORS[0] },
      { id: 'guest:demo-a', role: 'guest', label: '阿蟹', anim: '原地小憩沉眠', color: PET_COLORS[1] },
      { id: 'guest:demo-b', role: 'guest', label: '泡泡', anim: '螃蟹走路', color: PET_COLORS[2] }
    ], workArea, { reset: true })
  }

  /**
   * 渲染端上报的命中矩形。id 只用于诊断和「场景里删掉的宠物立刻撤销命中区」，
   * 没有 id 的矩形也接受（更保守的将来）。
   */
  function normalizeRects (raw) {
    const rects = []
    if (!Array.isArray(raw)) return rects
    for (const candidate of raw) {
      if (rects.length >= MAX_SCENE_ITEMS) break
      const rect = normalizeRect(candidate)
      if (rect === null) continue
      rects.push({ id: normalizeId(candidate.id), x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }
    return rects
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
      case 'debug-input': {
        const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : ''
        if (!['move', 'down', 'up'].includes(action)) return { ok: false, error: 'bad-action' }
        const point = normalizePoint(raw)
        if (point === null) return { ok: false, error: 'bad-point' }
        return { ok: true, command: { type, id, point, action } }
      }
      case 'debug-renderer':
        return { ok: true, command: { type, id } }
      case 'debug-dispatch': {
        const phase = typeof raw.phase === 'string' ? raw.phase.trim().toLowerCase() : ''
        if (!['down', 'move', 'up', 'blur'].includes(phase)) return { ok: false, error: 'bad-phase' }
        const point = normalizePoint(raw)
        if (point === null) return { ok: false, error: 'bad-point' }
        return { ok: true, command: { type, id, point, phase } }
      }
      case 'debug-freeze-hover':
        return { ok: true, command: { type, id, frozen: raw.frozen !== false } }
      case 'debug-freeze-busy':
        return { ok: true, command: { type, id, frozen: raw.frozen !== false } }
      case 'debug-lock-input':
        return { ok: true, command: { type, id, locked: raw.locked !== false } }
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
      busy: raw.busy === true,
      busyAgeMs: isFiniteNumber(raw.busyAgeMs) && raw.busyAgeMs >= 0 ? raw.busyAgeMs : null,
      busyFrozen: raw.busyFrozen === true,
      rendererRects: Number.isInteger(raw.rendererRects) && raw.rendererRects >= 0 ? raw.rendererRects : 0,
      rendererRectsAgeMs: isFiniteNumber(raw.rendererRectsAgeMs) && raw.rendererRectsAgeMs >= 0
        ? raw.rendererRectsAgeMs
        : null,
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
            itemId: normalizeId(raw.itemId),
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
      case 'renderer-state':
        return {
          ok: true,
          event: {
            type,
            id,
            state: raw.state !== null && typeof raw.state === 'object' && !Array.isArray(raw.state)
              ? raw.state
              : null
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

  /** 场景 items 本身就是命中区：宠物、卡片都按自己的矩形接指针。 */
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
      id: item.id,
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

  // -------------------------------------------------------------------------
  // 宠物物理（纯函数）
  // -------------------------------------------------------------------------

  /**
   * 把任意输入整理成一个合法身体：尺寸不超过工作区，位置永远在工作区内（贴地不算穿地）。
   * 所有物理函数都从这里开始，因此「出界/NaN」不可能被传播出去。
   */
  function createBody (raw, workArea) {
    const area = normalizeArea(workArea)
    const source = raw !== null && typeof raw === 'object' ? raw : {}
    const width = clampNumber(isFiniteNumber(source.width) ? source.width : 64, 1, area.width)
    const height = clampNumber(isFiniteNumber(source.height) ? source.height : 64, 1, area.height)
    const x = clampNumber(isFiniteNumber(source.x) ? source.x : 0, 0, area.width - width)
    const y = clampNumber(isFiniteNumber(source.y) ? source.y : 0, 0, groundY({ height }, area))
    return {
      x,
      y,
      width,
      height,
      vx: isFiniteNumber(source.vx) ? clampNumber(source.vx, -PHYSICS.MAX_THROW_SPEED, PHYSICS.MAX_THROW_SPEED) : 0,
      vy: isFiniteNumber(source.vy) ? clampNumber(source.vy, -PHYSICS.MAX_THROW_SPEED, PHYSICS.MAX_THROW_SPEED) : 0
    }
  }

  function groundY (body, workArea) {
    const area = normalizeArea(workArea)
    const source = body !== null && typeof body === 'object' ? body : {}
    const height = clampNumber(isFiniteNumber(source.height) ? source.height : 0, 0, area.height)
    const margin = Math.min(PHYSICS.FLOOR_MARGIN, Math.max(0, area.height - height))
    return Math.max(0, area.height - height - margin)
  }

  function stepBody (body, workArea, dt) {
    const area = normalizeArea(workArea)
    const step = clampNumber(isFiniteNumber(dt) ? dt : 0, 0, PHYSICS.MAX_DT)
    const current = createBody(body, area)
    if (step <= 0) return current
    let { x, y, width, height, vx, vy } = current
    const ground = groundY(current, area)
    vy += PHYSICS.GRAVITY * step
    x += vx * step
    y += vy * step

    if (y >= ground - 0.5) {
      y = ground
      if (vy > 0) vy = vy < PHYSICS.REST_SPEED ? 0 : -vy * PHYSICS.BOUNCE
      vx *= Math.exp(-PHYSICS.GROUND_FRICTION * step)
    } else {
      vy = Math.max(vy, -PHYSICS.MAX_THROW_SPEED)
      vx *= Math.exp(-PHYSICS.AIR_FRICTION * step)
    }

    if (y < 0) {
      y = 0
      if (vy < 0) vy = -vy * PHYSICS.WALL_BOUNCE
    }
    if (x < 0) {
      x = 0
      if (vx < 0) vx = -vx * PHYSICS.WALL_BOUNCE
    } else if (x > area.width - width) {
      x = area.width - width
      if (vx > 0) vx = -vx * PHYSICS.WALL_BOUNCE
    }
    if (Math.abs(vx) < 0.5) vx = 0
    return createBody({ x, y, width, height, vx, vy }, area)
  }

  function stepBodies (bodies, workArea, dt) {
    if (!Array.isArray(bodies)) return []
    return bodies.map((body) => stepBody(body, workArea, dt))
  }

  /**
   * 拖拽：弹簧跟随目标（不是硬贴）。目标点已经被夹在工作区里，所以拖到屏幕边缘时
   * 宠物会停在边上，不会被拖出工作区。松手后的初速度由 throwVelocityFromTrail 提供。
   */
  function dragBody (body, target, workArea, dt) {
    const area = normalizeArea(workArea)
    const step = clampNumber(isFiniteNumber(dt) ? dt : 0, 0, PHYSICS.MAX_DT)
    const current = createBody(body, area)
    const point = target !== null && typeof target === 'object' ? target : current
    const targetX = clampNumber(isFiniteNumber(point.x) ? point.x : current.x, 0, area.width - current.width)
    const targetY = clampNumber(isFiniteNumber(point.y) ? point.y : current.y, 0, groundY(current, area))
    if (step <= 0) return current
    let { x, y, vx, vy } = current
    vx += ((targetX - x) * PHYSICS.DRAG_STIFFNESS - vx * PHYSICS.DRAG_DAMPING) * step
    vy += ((targetY - y) * PHYSICS.DRAG_STIFFNESS - vy * PHYSICS.DRAG_DAMPING) * step
    x += vx * step
    y += vy * step
    return createBody({ x, y, width: current.width, height: current.height, vx, vy }, area)
  }

  /**
   * 松手投掷：速度来自最近 140ms 的指针轨迹。超过最大速度就按比例缩到上限，
   * 避免一甩就飞出屏幕（虽然位置仍会被夹住，但视觉上会像瞬移）。
   */
  function throwVelocityFromTrail (trail, now, maxSpeed = PHYSICS.MAX_THROW_SPEED) {
    const limit = isFiniteNumber(maxSpeed) && maxSpeed > 0 ? maxSpeed : PHYSICS.MAX_THROW_SPEED
    if (!Array.isArray(trail) || trail.length < 2) return { vx: 0, vy: 0 }
    const at = isFiniteNumber(now) ? now : 0
    const samples = trail
      .filter((sample) => sample !== null && typeof sample === 'object' &&
        isFiniteNumber(sample.t) && isFiniteNumber(sample.x) && isFiniteNumber(sample.y) &&
        sample.t <= at + 50 && at - sample.t <= PHYSICS.THROW_TRAIL_MS * 1.5)
      .sort((left, right) => left.t - right.t)
    if (samples.length < 2) return { vx: 0, vy: 0 }
    const last = samples[samples.length - 1]
    // 光标停住超过一帧半再松手：这是一次「放下」，不是投掷。
    if (at - last.t > 100) return { vx: 0, vy: 0 }
    let first = samples[0]
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      if (last.t - samples[index].t <= PHYSICS.THROW_TRAIL_MS) {
        first = samples[index]
      } else {
        break
      }
    }
    const seconds = (last.t - first.t) / 1000
    if (!(seconds > 0.002)) return { vx: 0, vy: 0 }
    let vx = (last.x - first.x) / seconds
    let vy = (last.y - first.y) / seconds
    const speed = Math.hypot(vx, vy)
    if (!Number.isFinite(speed)) return { vx: 0, vy: 0 }
    if (speed > limit) {
      vx = (vx / speed) * limit
      vy = (vy / speed) * limit
    }
    return { vx, vy }
  }

  function throwBody (body, velocity, workArea) {
    const area = normalizeArea(workArea)
    const current = createBody(body, area)
    const source = velocity !== null && typeof velocity === 'object' ? velocity : {}
    let vx = isFiniteNumber(source.vx) ? source.vx : 0
    let vy = isFiniteNumber(source.vy) ? source.vy : 0
    const speed = Math.hypot(vx, vy)
    if (!Number.isFinite(speed)) {
      vx = 0
      vy = 0
    } else if (speed > PHYSICS.MAX_THROW_SPEED) {
      vx = (vx / speed) * PHYSICS.MAX_THROW_SPEED
      vy = (vy / speed) * PHYSICS.MAX_THROW_SPEED
    }
    return createBody({ ...current, vx, vy }, area)
  }

  /**
   * 工作区变了（分辨率/缩放/显示器热插拔）：把每只宠物重新夹进新工作区。
   * 只夹取，不重置速度；已经落到新地面以下的按落地处理并清掉向下速度。
   */
  function resizeBodies (bodies, workArea) {
    if (!Array.isArray(bodies)) return []
    const area = normalizeArea(workArea)
    return bodies.map((body) => {
      const source = body !== null && typeof body === 'object' ? body : {}
      const next = createBody(source, area)
      const ground = groundY(next, area)
      if (isFiniteNumber(source.y) && source.y > ground + 0.5) {
        next.y = ground
        if (next.vy > 0) next.vy = 0
      }
      return next
    })
  }

  function bodyRect (body) {
    const source = body !== null && typeof body === 'object' ? body : {}
    const x = isFiniteNumber(source.x) ? source.x : 0
    const y = isFiniteNumber(source.y) ? source.y : 0
    const width = isFiniteNumber(source.width) && source.width > 0 ? source.width : 1
    const height = isFiniteNumber(source.height) && source.height > 0 ? source.height : 1
    return { x, y, width, height }
  }

  /**
   * 点击穿透的唯一裁定（主进程直接照做）。
   *
   * 优先级：
   *   0. busy 租约新鲜：拖拽中，位置判定不参与（宠物落后于光标，光标可能已在矩形外）；
   *   1. 光标在命中矩形内 + 渲染端最近 maxAgeMs 内确认过 inside（正常路径）；
   *   2. 光标在命中矩形内 + 渲染端完全没消息但停留满 fallbackDwellMs（macOS 兜底）；
   *   3. 其余一律穿透。
   *
   * `rects` 优先于 `scene`：主进程传入渲染端上报的实时矩形，测试/旧调用方可以继续传 scene。
   * 矩形为空永远是 false，busy 过期也永远不再翻案。
   *
   * @returns {{interactive:boolean, reason:'busy-lease'|'no-scene'|'outside'|'waiting-for-confirmation'|'stale-renderer-confirmation'|'hovering'|'main-fallback'}}
   */
  function shouldBeInteractive (options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now()
    const busyAt = Number.isFinite(options.busyAt) ? options.busyAt : 0
    const lease = Number.isFinite(options.busyLeaseMs) && options.busyLeaseMs > 0
      ? options.busyLeaseMs
      : BUSY_LEASE_MS
    if (options.busy === true && busyAt > 0 && now - busyAt <= lease && now - busyAt >= 0) {
      return { interactive: true, reason: 'busy-lease' }
    }

    let rects
    if (Array.isArray(options.rects)) {
      rects = options.rects
    } else if (options.scene !== null && typeof options.scene === 'object' && Array.isArray(options.scene.items)) {
      rects = rectsOfScene(options.scene)
    } else {
      rects = []
    }
    if (rects.length === 0) return { interactive: false, reason: 'no-scene' }

    const point = normalizePoint(options.point)
    if (point === null || hitTestRects(rects, point) === null) {
      return { interactive: false, reason: 'outside' }
    }
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

  return {
    MAX_LINE_LENGTH,
    MAX_SCENE_ITEMS,
    MAX_ID_LENGTH,
    MAX_LABEL_LENGTH,
    MAX_ANIM_LENGTH,
    MAX_PATH_LENGTH,
    MAX_ERROR_LENGTH,
    MAX_DISPLAYS,
    HOVER_HEARTBEAT_MS,
    HOVER_CONFIRM_MAX_AGE_MS,
    POINTER_POLL_MS,
    MAIN_FALLBACK_DWELL_MS,
    RENDERER_RECT_MAX_AGE_MS,
    SCENE_RECT_FALLBACK_MS,
    BUSY_HEARTBEAT_MS,
    BUSY_LEASE_MS,
    DEFAULT_COLOR,
    ITEM_KINDS,
    PET_ROLES,
    SCENE_VERSION,
    PET_COLORS,
    IDLE_CLIPS,
    PHYSICS,
    isFiniteNumber,
    clampNumber,
    normalizeId,
    normalizeLabel,
    normalizeAnim,
    normalizeRole,
    normalizeRect,
    normalizePoint,
    normalizeRects,
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
    hashString,
    colorForPet,
    initialVelocity,
    petScene,
    demoPetScene,
    createBody,
    groundY,
    stepBody,
    stepBodies,
    dragBody,
    throwVelocityFromTrail,
    throwBody,
    resizeBodies,
    bodyRect
  }
})
