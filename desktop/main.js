/**
 * dsh-local-pet 桌面 helper —— Electron 主进程。
 *
 * 职责：
 *   1. 开**一个**全屏透明、无边框、置顶、不抢焦点的窗口，覆盖主显示器工作区；
 *   2. 默认整窗点击穿透（setIgnoreMouseEvents(true, { forward: true })），只有光标真的落在
 *      渲染端上报的命中矩形上、并且（a）渲染端在最近 1.2s 内确认过 inside，或（b）渲染端完全
 *      没有消息但光标已停留 300ms（macOS 后台收不到 forward 事件时的兜底），才短暂接管鼠标；
 *      拖拽期间渲染端持有**输入租约**（busy）：位置判定让位，租约过期/pointerup/失焦即交还；
 *   3. 注册 `localpet://asset/<name>.webm` 自定义协议，把宿主传进来的 dsh-pet 素材目录
 *      只读地喂给 file:// 页面（页面拿不到 DSH 的 HTTP 路由）；
 *   4. 与宿主走 stdin/stdout 的 JSON 行协议（见 desktop/README.md），永不监听端口。
 *
 * 为什么不是 `require('electron')` 直接开窗：插件的宿主是 `ELECTRON_RUN_AS_NODE=1` 的纯 Node，
 * 拿不到 BrowserWindow。宿主 spawn 本文件时必须**删掉** ELECTRON_RUN_AS_NODE（设成空串会让
 * Electron 直接 abort，设成 '0' 仍然进纯 Node 模式），见 src/desktop-launch.js 的 helperEnv()。
 *
 * 安全底线（ADR-0005：一个置顶全屏窗如果把点击吃掉，等于把整台机器卡死）：
 *   - 唯一翻转出口是 setIgnore()，初始状态永远是穿透；
 *   - 主进程每 100ms 用真实光标位置独立复核一次；命中矩形只信渲染端最近上报的那份，过期即无；
 *   - 渲染端必须持续心跳，超过 1.2s 没确认就恢复穿透；busy 租约超过 1.5s 没续也自动释放；
 *   - 显示配置变化、窗口失焦/隐藏、宿主失联、进程退出，统统先恢复穿透并收回租约；
 *   - 进程被 kill -9 时窗口随进程消失，操作系统不会留下一个吃点击的窗。
 */

'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

let electronApi
try {
  electronApi = require('electron')
} catch (error) {
  process.stderr.write(
    '[local-pet helper] 启动失败：本进程被以「纯 Node 模式」拉起（ELECTRON_RUN_AS_NODE=' +
    JSON.stringify(process.env.ELECTRON_RUN_AS_NODE ?? null) +
    '）。宿主必须在 spawn 前删除该变量（见 src/desktop-launch.js 的 helperEnv）。原始错误：' +
    (error instanceof Error ? error.message.split('\n')[0] : String(error)) +
    '\n'
  )
  process.exit(3)
}
if (electronApi === null || typeof electronApi !== 'object' || typeof electronApi.app !== 'object') {
  process.stderr.write('[local-pet helper] 启动失败：require("electron") 没有返回 Electron API。\n')
  process.exit(3)
}

const { app, BrowserWindow, ipcMain, protocol, screen } = electronApi
const shared = require('./shared.js')

const APP_NAME = 'dsh-local-pet-desktop'
const HOST_STALE_MS = 30000
const HOST_POLL_MS = 2000
const SHOT_DEFAULT_DELAY_MS = 900
const SHOT_MEDIA_WAIT_MS = 3000
const ASSET_SCHEME = 'localpet'
const ASSET_HOST = 'asset'
const MAX_ASSET_BYTES = 8 * 1024 * 1024
const MAX_ASSET_NAME = 200

// 必须先定名：直接用 `electron main.js` 启动时 Electron 取不到 app 名会回落成 "Electron"，
// userData 就落到所有脚本共用的目录里。
app.setName(APP_NAME)
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
if (process.platform === 'darwin' && app.dock) {
  try {
    app.dock.hide()
  } catch {
    // 没有 Dock（非 macOS / 受限环境）不是错误
  }
}

const options = parseArgs(process.argv.slice(2))
const isShotMode = typeof options.shot === 'string' && options.shot !== ''
const debugEnabled = options.debug || process.env.LOCAL_PET_DESKTOP_DEBUG === '1'
const hostPid = isShotMode ? 0 : (options.hostPid > 0 ? options.hostPid : parseHostPid(process.env.LOCAL_PET_HOST_PID))
/** 只接受绝对路径；相对路径会让协议根目录取决于 helper 的 cwd，没有意义。 */
const assetRoots = (Array.isArray(options.assets) ? options.assets : [])
  .filter((dir) => typeof dir === 'string' && dir !== '' && path.isAbsolute(dir))
  .slice(0, 8)
if (isShotMode && !path.isAbsolute(options.shot)) {
  process.stderr.write('[local-pet helper] --local-pet-shot 需要绝对路径：' + options.shot + '\n')
  process.exit(3)
}

// 自定义协议必须在 app ready 之前声明。standard/secure 让 `localpet://asset/x` 像普通 URL；
// stream 让 <video> 的 Range 请求/边下边播在 Chromium 里正常工作。
try {
  protocol.registerSchemesAsPrivileged([{
    scheme: ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
  }])
} catch (error) {
  process.stderr.write('[local-pet helper] 注册 localpet:// scheme 失败：' + messageOf(error) + '\n')
}

/** 窗口局部/屏幕 DIP 的换算全部靠它；窗口 = 主显示器工作区。 */
let win = null
let scene = shared.emptyScene()
let sceneAt = 0
let rendererReady = false
let quitting = false
let readySent = false
let lastHostLineAt = Date.now()
let displayTimer = null
let mediaWaitTimer = null

/** 当前窗口是否穿透（Electron 没有 isIgnoreMouseEvents 读取 API，只能自己镜像）。 */
const ignoreState = { ignoring: null }
/** 渲染端上报的悬停状态；lastAt 是主进程决定「要不要相信渲染端」的唯一依据。 */
const hover = { inside: false, lastAt: 0, frozen: false }
/** 渲染端逐帧上报的命中矩形（窗口局部 DIP）与时间戳；过期即视为没有命中区。 */
let rendererRects = []
let rendererRectsAt = 0
/**
 * 输入租约：渲染端在拖拽/弹层期间持有。位置判定不参与，但租约必须持续续期；
 * allow=false 表示上一次 forceIgnore 之后还没收到「渲染端已放手」的确认，新的 busy 先不信。
 */
const busy = { active: false, at: 0, frozen: false, allow: true }
/** 主进程第一次看见光标进入「某个命中矩形」的时刻（离开即清零），兜底通道的停留计时。 */
let insideSince = 0
/** 调试用：用固定屏幕坐标替代 screen.getCursorScreenPoint()（冒烟脚本注入）。 */
let pointerOverride = null
/** 调试用：锁住输入时忽略窗口 blur（冒烟用合成输入，环境里的焦点变化不应打断用例）。 */
let debugInputLocked = false

let pointerTimer = null
let hostPollTimer = null
let stdinParser = null

// ---------------------------------------------------------------------------
// 进程级兜底：任何未捕获错误都先恢复穿透再退出，绝不把一个可交互全屏窗留在桌面上。
// ---------------------------------------------------------------------------

process.on('uncaughtException', (error) => {
  reportError('uncaught-exception', error)
  shutdown(1)
})
process.on('unhandledRejection', (error) => {
  reportError('unhandled-rejection', error)
  shutdown(1)
})
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
process.stdout.on('error', () => shutdown(1))

app.on('before-quit', () => {
  quitting = true
  forceIgnore('before-quit')
  stopTimers()
})
app.on('will-quit', () => {
  forceIgnore('will-quit')
  stopTimers()
})
app.on('window-all-closed', () => {
  app.quit()
})

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  registerAssetProtocol()
  createWindow()
  if (isShotMode) {
    // 冒烟截图不依赖宿主：自己在本地放三只演示宠物，抓完图写 PNG + 同名 .json 说明就退出。
    scene = shared.demoPetScene(screen.getPrimaryDisplay().workArea)
    sceneAt = Date.now()
  } else {
    startHostLink()
  }
  startPointerWatchdog()
}).catch((error) => {
  reportError('create-window-failed', error)
  shutdown(1)
})

function createWindow () {
  const area = screen.getPrimaryDisplay().workArea
  win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // 不抢焦点：showInactive() + focusable:false，点宠物也不会把 DSH/别的应用踢到后台。
    // 拖拽只用鼠标事件，不需要键盘焦点。
    focusable: false,
    acceptFirstMouse: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      devTools: debugEnabled,
      spellcheck: false
    }
  })

  // 'floating' 是 macOS 的置顶层级（dsh-pet 同款）：'screen-saver' 会压过全屏应用和截图。
  try {
    win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  } catch {
    // 老版本/受限环境没有这些开关：置顶已经由构造参数保证
  }
  win.webContents.setBackgroundThrottling(false)
  win.webContents.on('context-menu', (event) => event.preventDefault())
  win.webContents.on('render-process-gone', (_event, details) => {
    reportError('render-process-gone', new Error(String(details?.reason ?? 'unknown')))
    shutdown(1)
  })
  win.on('unresponsive', () => forceIgnore('unresponsive'))
  win.on('blur', () => {
    if (debugInputLocked) return
    forceIgnore('blur')
  })
  win.on('hide', () => forceIgnore('hide'))
  win.on('closed', () => {
    win = null
    if (!quitting) {
      reportError('window-closed', new Error('desktop window closed unexpectedly'))
      shutdown(1)
    }
  })

  setIgnore(true, 'initial')
  win.webContents.on('did-finish-load', () => {
    rendererReady = true
    busy.allow = true
    sceneAt = Date.now()
    sendScene()
    if (isShotMode) {
      showWindow()
      setTimeout(() => { void captureStandaloneShot() }, options.shotDelayMs)
    }
  })
  win.once('ready-to-show', () => {
    if (!isShotMode) showWindow()
    sendReady()
  })
  // ready-to-show 依赖首帧；透明窗首帧在个别合成器上会迟到，给一次兜底显示 + ready。
  setTimeout(() => {
    if (win === null || win.isDestroyed() || readySent) return
    showWindow()
    sendReady()
  }, 1500)

  win.loadFile(path.join(__dirname, 'index.html')).catch((error) => {
    reportError('load-failed', error)
    shutdown(1)
  })

  screen.on('display-added', scheduleDisplayRefresh)
  screen.on('display-removed', scheduleDisplayRefresh)
  screen.on('display-metrics-changed', scheduleDisplayRefresh)
}

function showWindow () {
  if (win === null || win.isDestroyed()) return
  try {
    win.showInactive()
  } catch {
    // showInactive 失败不能拖垮 helper
  }
}

// ---------------------------------------------------------------------------
// localpet://asset/<name>.webm
// ---------------------------------------------------------------------------

function registerAssetProtocol () {
  try {
    protocol.handle(ASSET_SCHEME, handleAssetRequest)
  } catch (error) {
    reportError('asset-protocol-failed', error)
  }
}

async function handleAssetRequest (request) {
  try {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return textResponse(400, 'bad asset url')
    }
    if (url.protocol !== ASSET_SCHEME + ':' || url.hostname !== ASSET_HOST) {
      return textResponse(404, 'unknown asset')
    }
    let name
    try {
      name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    } catch {
      return textResponse(400, 'bad asset name')
    }
    if (!isSafeAssetName(name)) return textResponse(400, 'bad asset name')
    const file = resolveAssetFile(name)
    if (file === null) return textResponse(404, 'asset not found')

    const data = await fsp.readFile(file)
    const headers = {
      'content-type': 'video/webm',
      'cache-control': 'public, max-age=300',
      'accept-ranges': 'bytes'
    }
    const range = parseByteRange(request.headers.get('range'), data.length)
    if (range !== null && range.invalid === true) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'content-range': 'bytes */' + String(data.length) }
      })
    }
    if (range !== null) {
      const chunk = data.subarray(range.start, range.end + 1)
      return new Response(new Uint8Array(chunk), {
        status: 206,
        headers: {
          ...headers,
          'content-length': String(chunk.length),
          'content-range': 'bytes ' + range.start + '-' + range.end + '/' + String(data.length)
        }
      })
    }
    return new Response(new Uint8Array(data), {
      headers: { ...headers, 'content-length': String(data.length) }
    })
  } catch (error) {
    reportError('asset-read-failed', error)
    return textResponse(500, 'asset read failed')
  }
}

function textResponse (status, body) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

function isSafeAssetName (name) {
  if (typeof name !== 'string') return false
  if (name === '' || name.length > MAX_ASSET_NAME) return false
  if (name.startsWith('.')) return false
  if (!name.endsWith('.webm')) return false
  return !/[/\\\u0000-\u001f\u007f]/.test(name)
}

function resolveAssetFile (name) {
  for (const root of assetRoots) {
    let base
    try {
      base = path.resolve(root)
    } catch {
      continue
    }
    const candidate = path.resolve(base, name)
    if (candidate === base || !candidate.startsWith(base + path.sep)) continue
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_ASSET_BYTES) return candidate
    } catch {
      // 这个根目录里没有：继续找下一个（用户目录 → 包内目录的降级链）
    }
  }
  return null
}

function parseByteRange (header, size) {
  if (typeof header !== 'string' || header.trim() === '' || !(size > 0)) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return { invalid: true }
  let start
  let end
  if (match[1] === '' && match[2] === '') return { invalid: true }
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (!Number.isInteger(suffix) || suffix <= 0) return { invalid: true }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) {
    return { invalid: true }
  }
  return { start, end }
}

// ---------------------------------------------------------------------------
// 点击穿透：唯一出口 + 两路独立判定
// ---------------------------------------------------------------------------

function setIgnore (ignore, reason) {
  const next = ignore !== false
  if (win === null || win.isDestroyed()) {
    ignoreState.ignoring = true
    return
  }
  if (ignoreState.ignoring === next) return
  try {
    // 穿透期间保留 forward：渲染端还要靠被转发的 mousemove 做命中判定。
    win.setIgnoreMouseEvents(next, { forward: true })
    ignoreState.ignoring = next
  } catch (error) {
    // 翻转失败时按「更安全」的一侧记：我们不知道真实状态，一律当穿透并要求重新判定。
    ignoreState.ignoring = true
    reportError('set-ignore-failed', error)
    return
  }
  emitHit(reason)
}

function forceIgnore (reason) {
  hover.inside = false
  hover.lastAt = 0
  busy.active = false
  busy.at = 0
  // 收回租约后，新的 busy 必须等渲染端先确认一次「放开」或重新悬停，才重新被相信。
  busy.allow = false
  insideSince = 0
  setIgnore(true, reason)
}

function busyFresh (now) {
  return busy.active === true && busy.at > 0 && now - busy.at >= 0 &&
    now - busy.at <= shared.BUSY_LEASE_MS
}

/**
 * 主进程的独立复核。渲染端只能**申请**可交互，最终由这里按真实光标位置 + 心跳新鲜度裁定。
 */
function applyDecision (reason) {
  if (win === null || win.isDestroyed()) return
  if (!win.isVisible()) {
    insideSince = 0
    setIgnore(true, 'hidden')
    return
  }
  const local = localCursor()
  const now = Date.now()
  const rects = liveRects(now)
  const inside = local !== null && shared.hitTestRects(rects, local) !== null
  if (inside) {
    if (insideSince === 0) insideSince = now
  } else {
    insideSince = 0
  }
  const decision = shared.shouldBeInteractive({
    rects,
    point: local,
    lastHoverAt: hover.lastAt,
    insideSince,
    busy: busy.active === true,
    busyAt: busy.at,
    // 调试里 freeze 表示「渲染端已经死了」：这时连兜底也必须停，验证 fail-closed。
    allowMainFallback: hover.frozen !== true,
    now
  })
  setIgnore(!decision.interactive, decision.reason || reason)
}

/** 渲染端最近上报的矩形优先；刚更新场景、渲染端还没报时，用出生矩形兜底最多 800ms。 */
function liveRects (now) {
  if (rendererRectsAt > 0 && now - rendererRectsAt <= shared.RENDERER_RECT_MAX_AGE_MS) {
    return rendererRects
  }
  // 只在渲染端**从未**上报过矩形时用出生矩形兜底；一旦它报过，过期就回穿透（fail-closed）。
  if (rendererRectsAt === 0 && sceneAt > 0 && now - sceneAt <= shared.SCENE_RECT_FALLBACK_MS && scene.items.length > 0) {
    return shared.rectsOfScene(scene)
  }
  return []
}

function startPointerWatchdog () {
  if (pointerTimer !== null) return
  pointerTimer = setInterval(() => {
    try {
      applyDecision('watchdog')
    } catch (error) {
      reportError('watchdog-failed', error)
      forceIgnore('watchdog-failed')
    }
  }, shared.POINTER_POLL_MS)
  pointerTimer.unref?.()
}

function localCursor () {
  const point = pointerOverride ?? safeCursorPoint()
  if (point === null || win === null || win.isDestroyed()) return null
  const bounds = win.getBounds()
  return shared.toLocalPoint(point, bounds)
}

function safeCursorPoint () {
  try {
    return screen.getCursorScreenPoint()
  } catch {
    return null
  }
}

function emitHit (reason) {
  const local = localCursor()
  const screenPoint = pointerOverride ?? safeCursorPoint()
  const rects = liveRects(Date.now())
  const rect = local === null ? null : shared.hitTestRects(rects, local)
  const bounds = win !== null && !win.isDestroyed() ? win.getBounds() : null
  writeEvent({
    type: 'hit',
    // 这个字段的语义是「光标现在在不在命中矩形里」，不是渲染端上次说了什么。
    inside: rect !== null,
    interactive: ignoreState.ignoring === false,
    itemId: rect !== null && typeof rect.id === 'string' ? rect.id : null,
    point: screenPoint,
    rect: rect !== null && bounds !== null
      ? { x: rect.x + bounds.x, y: rect.y + bounds.y, width: rect.width, height: rect.height }
      : null,
    reason
  })
}

// ---------------------------------------------------------------------------
// 渲染端 IPC：命中矩形 / 输入租约 / 悬停确认
// ---------------------------------------------------------------------------

ipcMain.on('local-pet:renderer-ready', (event) => {
  if (win === null || win.isDestroyed() || event.sender !== win.webContents) return
  rendererReady = true
  busy.allow = true
  sceneAt = Date.now()
  sendScene()
  applyDecision('renderer-ready')
})

ipcMain.on('local-pet:rects', (event, payload) => {
  if (win === null || win.isDestroyed() || event.sender !== win.webContents) return
  rendererRects = shared.normalizeRects(payload)
  rendererRectsAt = Date.now()
  // 立即按新矩形复核一次；主进程仍会用自己的光标位置投票。
  applyDecision('renderer-rects')
})

ipcMain.on('local-pet:busy', (event, payload) => {
  if (win === null || win.isDestroyed() || event.sender !== win.webContents) return
  if (busy.frozen) return
  const next = payload !== null && typeof payload === 'object' && payload.busy === true
  if (next) {
    if (busy.allow !== true) return
    busy.active = true
    busy.at = Date.now()
  } else {
    busy.active = false
    busy.at = 0
    busy.allow = true
  }
  applyDecision(next ? 'renderer-busy' : 'renderer-idle')
})

ipcMain.on('local-pet:hover', (event, payload) => {
  if (win === null || win.isDestroyed() || event.sender !== win.webContents) return
  if (hover.frozen) return
  const inside = payload !== null && typeof payload === 'object' && payload.inside === true
  hover.inside = inside
  hover.lastAt = inside ? Date.now() : 0
  // 渲染端重新看见光标停在命中区 = 它活着且能接指针：允许重新申请输入租约。
  if (inside) busy.allow = true
  // 立即翻转（不用等 100ms 轮询）；主进程仍会用自己的光标位置复核。
  applyDecision(inside ? 'renderer-hover' : 'renderer-leave')
})

function sendScene () {
  if (win === null || win.isDestroyed()) return
  try {
    win.webContents.send('local-pet:scene', scene)
  } catch {
    // 渲染进程正在重启：下一次 did-finish-load 会重发
  }
}

function pruneRendererRects () {
  if (rendererRects.length === 0) return
  const ids = new Set(scene.items.map((item) => item.id))
  const kept = rendererRects.filter((rect) => rect.id === null || ids.has(rect.id))
  if (kept.length !== rendererRects.length) rendererRects = kept
}

// ---------------------------------------------------------------------------
// stdio JSON 行协议
// ---------------------------------------------------------------------------

function startHostLink () {
  if (hostPid > 0) {
    hostPollTimer = setInterval(() => {
      if (quitting) return
      if (hostIsGone(hostPid)) {
        forceIgnore('host-gone')
        shutdown(0)
        return
      }
      if (Date.now() - lastHostLineAt > HOST_STALE_MS) {
        // 宿主进程还在但已经 30s 没说话了（插件被卸载、宿主卡死）：自己消失，别留幽灵窗。
        forceIgnore('host-silent')
        shutdown(0)
      }
    }, HOST_POLL_MS)
    hostPollTimer.unref?.()
  }

  stdinParser = shared.createLineParser()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    for (const entry of stdinParser.push(chunk)) {
      if (entry.type === 'line') handleHostLine(entry.line)
    }
  })
  process.stdin.on('end', () => shutdown(0))
  process.stdin.on('close', () => shutdown(0))
  process.stdin.on('error', () => shutdown(0))
  process.stdin.resume()
}

function handleHostLine (line) {
  lastHostLineAt = Date.now()
  const parsed = shared.parseLine(line)
  if (!parsed.ok) {
    if (debugEnabled) process.stderr.write('[local-pet helper] 忽略非 JSON 行：' + parsed.error + '\n')
    return
  }
  const normalized = shared.normalizeHostCommand(parsed.value)
  if (!normalized.ok) {
    if (debugEnabled) process.stderr.write('[local-pet helper] 忽略命令：' + normalized.error + '\n')
    return
  }
  applyCommand(normalized.command)
}

function applyCommand (command) {
  switch (command.type) {
    case 'update': {
      scene = command.scene
      sceneAt = Date.now()
      pruneRendererRects()
      // **不要**在这里作废悬停确认：宿主只在宠物集合/动作变化时更新场景，位置是渲染端逐帧
      // 上报的。主进程每一拍都用**新场景 + 新矩形**复核真实光标位置，光标不在命中区就恢复穿透。
      applyDecision('scene-updated')
      sendScene()
      return
    }
    case 'show':
      showWindow()
      busy.allow = true
      applyDecision('show')
      return
    case 'hide':
      forceIgnore('hide')
      if (win !== null && !win.isDestroyed()) win.hide()
      return
    case 'quit':
      shutdown(0)
      return
    case 'ping':
      writeEvent({ type: 'pong', id: command.id })
      return
    case 'status':
      writeEvent(statusEvent(command.id))
      return
    case 'shot':
      if (!rendererReady) {
        writeEvent({ type: 'error', id: command.id, code: 'not-ready', message: 'renderer not ready' })
        return
      }
      void captureTo(command.path, command.id)
      return
    case 'pointer':
      if (!debugEnabled) return
      pointerOverride = command.point
      applyDecision('debug-pointer')
      return
    case 'debug-move':
      if (!debugEnabled) return
      simulateInput(command.point, 'move')
      applyDecision('debug-move')
      return
    case 'debug-input':
      if (!debugEnabled) return
      simulateInput(command.point, command.action)
      applyDecision('debug-input-' + command.action)
      return
    case 'debug-renderer': {
      if (!debugEnabled) return
      void rendererDebug().then((state) => {
        writeEvent({ type: 'renderer-state', id: command.id, state })
      })
      return
    }
    case 'debug-dispatch':
      if (!debugEnabled) return
      dispatchInRenderer(command.phase, command.point)
      applyDecision('debug-dispatch-' + command.phase)
      return
    case 'debug-freeze-hover':
      if (!debugEnabled) return
      hover.frozen = command.frozen === true
      if (hover.frozen) {
        hover.inside = false
        hover.lastAt = 0
      }
      applyDecision('debug-freeze-hover')
      return
    case 'debug-freeze-busy':
      if (!debugEnabled) return
      busy.frozen = command.frozen === true
      // 结冰只是不再接受续期：已有租约按自己的时间戳自然过期（用来验 timeout）。
      if (!busy.frozen) busy.allow = true
      applyDecision('debug-freeze-busy')
      return
    case 'debug-lock-input':
      if (!debugEnabled) return
      debugInputLocked = command.locked === true
      if (debugInputLocked) forceIgnore('debug-lock-input')
      else busy.allow = true
      void lockRendererInput(debugInputLocked)
      applyDecision(debugInputLocked ? 'debug-lock-input' : 'debug-unlock-input')
      return
    default:
      return
  }
}

/** 把一条合成鼠标事件送进渲染端：走的是和 Electron 转发事件相同的 DOM 事件入口。 */
function simulateInput (point, action) {
  if (win === null || win.isDestroyed() || point === null) return
  pointerOverride = point
  const bounds = win.getBounds()
  const local = shared.toLocalPoint(point, bounds)
  if (local === null || !rendererReady) return
  const type = action === 'down' ? 'mouseDown' : action === 'up' ? 'mouseUp' : 'mouseMove'
  try {
    win.webContents.sendInputEvent({
      type,
      x: Math.round(local.x),
      y: Math.round(local.y),
      button: 'left',
      clickCount: 1,
      modifiers: []
    })
  } catch (error) {
    reportError('simulate-input-failed', error)
  }
}

/** 调试用：让渲染端忽略真实鼠标/焦点事件，冒烟只走 debug-dispatch 的合成输入。 */
async function lockRendererInput (locked) {
  if (win === null || win.isDestroyed() || !rendererReady) return false
  try {
    return await win.webContents.executeJavaScript(
      'globalThis.__localPetDebug && typeof globalThis.__localPetDebug.lockInput === "function" ' +
      '? globalThis.__localPetDebug.lockInput(' + (locked === true ? 'true' : 'false') + ') : false',
      true
    )
  } catch {
    return false
  }
}

/**
 * 在渲染端派发一条合成 PointerEvent（仅调试用）。
 *
 * 为什么不用 sendInputEvent 测拖拽：sendInputEvent 走的是真实输入管线，窗口一旦可交互，
 * 操作系统里那个**真实光标**的转发 mousemove 也会进来，和合成坐标打架（冒烟脚本没法移动
 * 用户鼠标）。这里直接命中渲染端同一套 pointerdown/move/up 处理器，副作用只有这些事件本身。
 */
function dispatchInRenderer (phase, point) {
  if (win === null || win.isDestroyed() || !rendererReady || point === null) return
  pointerOverride = point
  const bounds = win.getBounds()
  const local = shared.toLocalPoint(point, bounds)
  if (local === null) return
  const script = 'globalThis.__localPetDebug && typeof globalThis.__localPetDebug.dispatch === "function" ' +
    '? globalThis.__localPetDebug.dispatch(' + JSON.stringify(phase) + ',' +
    JSON.stringify(local.x) + ',' + JSON.stringify(local.y) + ') : false'
  win.webContents.executeJavaScript(script, true).catch(() => {})
}

/** 读取渲染端的只读探针（仅调试/截图 sidecar 用；不参与点击穿透判定）。 */
async function rendererDebug () {
  if (!rendererReady || win === null || win.isDestroyed()) return null
  let timer = null
  try {
    const raw = await Promise.race([
      win.webContents.executeJavaScript(
        'globalThis.__localPetDebug && typeof globalThis.__localPetDebug.snapshot === "function" ' +
        '? JSON.stringify(globalThis.__localPetDebug.snapshot()) : null',
        true
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 1500)
        timer.unref?.()
      })
    ])
    if (typeof raw !== 'string' || raw === '') return null
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (Array.isArray(parsed.pets)) parsed.pets = parsed.pets.slice(0, shared.MAX_SCENE_ITEMS)
    return parsed
  } catch {
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

function winFlag (read) {
  if (win === null || win.isDestroyed()) return false
  try {
    return read(win) === true
  } catch {
    return false
  }
}

function statusEvent (id) {
  const bounds = win !== null && !win.isDestroyed() ? win.getBounds() : null
  const now = Date.now()
  return {
    type: 'status',
    id,
    ignoring: ignoreState.ignoring !== false,
    sceneItems: scene.items.length,
    hoverInside: hover.inside,
    lastHoverAgeMs: hover.lastAt > 0 ? now - hover.lastAt : null,
    insideForMs: insideSince > 0 ? now - insideSince : null,
    hoverFrozen: hover.frozen,
    busy: busyFresh(now),
    busyAgeMs: busy.at > 0 ? now - busy.at : null,
    busyFrozen: busy.frozen,
    rendererRects: rendererRects.length,
    rendererRectsAgeMs: rendererRectsAt > 0 ? now - rendererRectsAt : null,
    visible: win !== null && !win.isDestroyed() && win.isVisible(),
    focused: win !== null && !win.isDestroyed() && win.isFocused(),
    focusable: winFlag((candidate) => candidate.isFocusable()),
    alwaysOnTop: winFlag((candidate) => candidate.isAlwaysOnTop()),
    allWorkspaces: winFlag((candidate) => candidate.isVisibleOnAllWorkspaces()),
    bounds,
    pointer: pointerOverride ?? safeCursorPoint(),
    debug: debugEnabled
  }
}

function sendReady () {
  readySent = true
  const primary = screen.getPrimaryDisplay()
  let displays = []
  try {
    displays = screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      primary: display.id === primary.id
    }))
  } catch {
    displays = []
  }
  writeEvent({
    type: 'ready',
    pid: process.pid,
    workArea: primary.workArea,
    displays,
    debug: debugEnabled,
    shotMode: isShotMode
  })
}

function writeEvent (event) {
  const line = shared.encodeMessage(event)
  if (line === null) return false
  try {
    process.stdout.write(line)
    return true
  } catch {
    shutdown(1)
    return false
  }
}

function reportError (code, error) {
  const message = error instanceof Error ? error.message : String(error)
  writeEvent({ type: 'error', code, message: message.slice(0, shared.MAX_ERROR_LENGTH) })
  if (debugEnabled) process.stderr.write('[local-pet helper] ' + code + ': ' + message + '\n')
}

// ---------------------------------------------------------------------------
// 截图（唯一能看到窗口的办法：这台机器上截不了真实屏幕）
// ---------------------------------------------------------------------------

async function captureTo (filePath, id) {
  const image = await capturePage()
  if (image === null) {
    writeEvent({ type: 'error', id, code: 'shot-failed', message: 'capturePage failed' })
    return null
  }
  const png = image.toPNG()
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, png)
    // 同名 sidecar：截图里的逻辑坐标、场景、渲染端探针都留档，冒烟脚本据此断言。
    fs.writeFileSync(filePath + '.json', JSON.stringify(await shotSidecar(image), null, 2))
  } catch (error) {
    writeEvent({ type: 'error', id, code: 'shot-write-failed', message: messageOf(error) })
    return null
  }
  const size = image.getSize()
  const event = { type: 'shot', id, path: filePath, width: size.width, height: size.height, bytes: png.length }
  writeEvent(event)
  return event
}

async function shotSidecar (image) {
  const size = image.getSize()
  return {
    capturedAt: new Date().toISOString(),
    pixelWidth: size.width,
    pixelHeight: size.height,
    workArea: screen.getPrimaryDisplay().workArea,
    bounds: win !== null && !win.isDestroyed() ? win.getBounds() : null,
    displays: screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor
    })),
    scene,
    renderer: await rendererDebug(),
    pointer: pointerOverride ?? safeCursorPoint(),
    ignoring: ignoreState.ignoring !== false,
    debug: debugEnabled,
    shotMode: isShotMode
  }
}

async function capturePage () {
  if (win === null || win.isDestroyed()) return null
  let timer = null
  try {
    return await Promise.race([
      win.webContents.capturePage(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 5000)
        timer.unref?.()
      })
    ])
  } catch {
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

async function captureStandaloneShot () {
  if (quitting) return
  await waitForMediaReady()
  await captureTo(options.shot, undefined)
  shutdown(0)
}

/** 截图前等视频首帧/降级落定（最多 3s）；等不到也拍，冒烟会按实际像素断言。 */
async function waitForMediaReady () {
  const deadline = Date.now() + SHOT_MEDIA_WAIT_MS
  while (!quitting && Date.now() < deadline) {
    const state = await rendererDebug()
    const pets = state !== null && Array.isArray(state.pets) ? state.pets : null
    if (pets !== null && pets.length > 0 && pets.every((pet) => pet.source === 'video' || pet.source === 'svg')) {
      return
    }
    await new Promise((resolve) => {
      mediaWaitTimer = setTimeout(resolve, 100)
      mediaWaitTimer.unref?.()
    })
  }
}

// ---------------------------------------------------------------------------
// 显示器变化：窗口跟着工作区走，场景交回宿主重算
// ---------------------------------------------------------------------------

function scheduleDisplayRefresh () {
  if (displayTimer !== null) clearTimeout(displayTimer)
  displayTimer = setTimeout(() => {
    displayTimer = null
    if (quitting || win === null || win.isDestroyed()) return
    const area = screen.getPrimaryDisplay().workArea
    try {
      win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height })
    } catch {
      // 改不了就继续用旧尺寸：判定仍按真实 bounds，不会错位
    }
    forceIgnore('display-changed')
    if (isShotMode) {
      scene = shared.demoPetScene(area)
      sceneAt = Date.now()
    }
    sendScene()
    sendReady()
  }, 500)
  displayTimer.unref?.()
}

// ---------------------------------------------------------------------------
// 退出
// ---------------------------------------------------------------------------

function shutdown (code) {
  if (quitting) return
  quitting = true
  forceIgnore('shutdown')
  stopTimers()
  try {
    if (win !== null && !win.isDestroyed()) win.destroy()
  } catch {
    // 已经没了
  }
  win = null
  try {
    app.quit()
  } catch {
    // fallthrough
  }
  // app.quit 可能被未关闭的窗口/对话框拖住；300ms 后强制退出，绝不无限挂着。
  const timer = setTimeout(() => {
    try {
      app.exit(code)
    } catch {
      process.exit(code)
    }
  }, 300)
  timer.unref?.()
}

function stopTimers () {
  if (pointerTimer !== null) {
    clearInterval(pointerTimer)
    pointerTimer = null
  }
  if (hostPollTimer !== null) {
    clearInterval(hostPollTimer)
    hostPollTimer = null
  }
  if (displayTimer !== null) {
    clearTimeout(displayTimer)
    displayTimer = null
  }
  if (mediaWaitTimer !== null) {
    clearTimeout(mediaWaitTimer)
    mediaWaitTimer = null
  }
}

// ---------------------------------------------------------------------------
// 参数/环境
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  const parsed = {
    shot: null,
    shotDelayMs: SHOT_DEFAULT_DELAY_MS,
    hostPid: 0,
    debug: false,
    assets: []
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--local-pet-shot') {
      parsed.shot = argv[index + 1] ?? null
      index += 1
    } else if (arg.startsWith('--local-pet-shot=')) {
      parsed.shot = arg.slice('--local-pet-shot='.length)
    } else if (arg === '--local-pet-shot-delay') {
      parsed.shotDelayMs = parseDelay(argv[index + 1])
      index += 1
    } else if (arg.startsWith('--local-pet-shot-delay=')) {
      parsed.shotDelayMs = parseDelay(arg.slice('--local-pet-shot-delay='.length))
    } else if (arg === '--local-pet-host-pid') {
      parsed.hostPid = parseHostPid(argv[index + 1])
      index += 1
    } else if (arg.startsWith('--local-pet-host-pid=')) {
      parsed.hostPid = parseHostPid(arg.slice('--local-pet-host-pid='.length))
    } else if (arg === '--local-pet-assets') {
      if (typeof argv[index + 1] === 'string') parsed.assets.push(argv[index + 1])
      index += 1
    } else if (arg.startsWith('--local-pet-assets=')) {
      parsed.assets.push(arg.slice('--local-pet-assets='.length))
    } else if (arg === '--local-pet-debug') {
      parsed.debug = true
    }
  }
  return parsed
}

function parseDelay (value) {
  const num = Number(value)
  return Number.isFinite(num) && num >= 50 && num <= 10000 ? num : SHOT_DEFAULT_DELAY_MS
}

function parseHostPid (value) {
  const pid = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : 0
}

function hostIsGone (pid) {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return Boolean(error) && error.code === 'ESRCH'
  }
}

function messageOf (error) {
  return error instanceof Error ? error.message : String(error)
}
