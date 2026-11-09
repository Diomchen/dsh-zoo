/**
 * dsh-zoo 桌面 helper —— Electron 主进程。
 *
 * 职责：
 *   1. 开**一个**全屏透明、无边框、置顶、不抢焦点的窗口，覆盖所有显示器工作区的并集
 *      （整张虚拟桌面；单屏时就是那块屏）。一扇窗才能让跨屏拖动不断指针捕获。
 *   2. 默认整窗点击穿透（setIgnoreMouseEvents(true, { forward: true })），只有光标真的落在
 *      渲染端上报的命中矩形上、并且（a）渲染端在最近 1.2s 内确认过 inside，或（b）渲染端完全
 *      没有消息但光标已停留 300ms（macOS 后台收不到 forward 事件时的兜底），才短暂接管鼠标；
 *      拖拽期间渲染端持有**输入租约**（busy）：位置判定让位，租约过期/pointerup/失焦即交还；
 *   3. 注册 `dshzoo://asset/<name>.webm` 自定义协议，把宿主传进来的 dsh-pet 素材目录
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
 *   - 渲染端必须持续心跳，超过 1.2s 没确认就恢复穿透；busy 租约超过 1.2s 没续也自动释放；
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
    '[dsh-zoo helper] 启动失败：本进程被以「纯 Node 模式」拉起（ELECTRON_RUN_AS_NODE=' +
    JSON.stringify(process.env.ELECTRON_RUN_AS_NODE ?? null) +
    '）。宿主必须在 spawn 前删除该变量（见 src/desktop-launch.js 的 helperEnv）。原始错误：' +
    (error instanceof Error ? error.message.split('\n')[0] : String(error)) +
    '\n'
  )
  process.exit(3)
}
if (electronApi === null || typeof electronApi !== 'object' || typeof electronApi.app !== 'object') {
  process.stderr.write('[dsh-zoo helper] 启动失败：require("electron") 没有返回 Electron API。\n')
  process.exit(3)
}

const { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, screen, shell } = electronApi
const shared = require('./shared.js')
// `dshzoo://gifts/...` 的路径白名单（ticket 25）：纯函数，单独一份、可单测。
const giftPath = require('./gift-path.js')

const APP_NAME = 'dsh-zoo-desktop'
const HOST_STALE_MS = 30000
const HOST_POLL_MS = 2000
const SHOT_DEFAULT_DELAY_MS = 900
const SHOT_MEDIA_WAIT_MS = 3000
const ASSET_SCHEME = 'dshzoo'
const ASSET_HOST = 'asset'
const CACHE_HOST = 'cache'
/** 礼物缩略图主机：与 asset/cache 同一套注册好的 dshzoo:// scheme，只多一个 host。 */
const GIFT_HOST = 'gifts'
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
const debugEnabled = options.debug || process.env.DSH_ZOO_DESKTOP_DEBUG === '1'
const hostPid = isShotMode ? 0 : (options.hostPid > 0 ? options.hostPid : parseHostPid(process.env.DSH_ZOO_HOST_PID))
/** 只接受绝对路径；相对路径会让协议根目录取决于 helper 的 cwd，没有意义。 */
let assetRoots = (Array.isArray(options.assets) ? options.assets : [])
  .filter((dir) => typeof dir === 'string' && dir !== '' && path.isAbsolute(dir))
  .slice(0, 8)
/** 远端素材缓存目录：只允许绝对路径，helper 只读它，不联网。 */
const cacheRoot = typeof options.cache === 'string' && options.cache !== '' && path.isAbsolute(options.cache)
  ? options.cache
  : null
/**
 * 礼物根目录（ticket 25）：宿主把 `<dataDir>/gifts` 当 argv 传进来；helper 只读它，
 * 只为 `dshzoo://gifts/<目录>/<图片>` 服务。没传 = 不注册这条读路径（所有 gifts URL 404）。
 */
const giftsRoot = typeof options.gifts === 'string' && options.gifts !== '' && path.isAbsolute(options.gifts)
  ? options.gifts
  : null
if (isShotMode && !path.isAbsolute(options.shot)) {
  process.stderr.write('[dsh-zoo helper] --dsh-zoo-shot 需要绝对路径：' + options.shot + '\n')
  process.exit(3)
}

// 自定义协议必须在 app ready 之前声明。standard/secure 让 `dshzoo://asset/x` 像普通 URL；
// stream 让 <video> 的 Range 请求/边下边播在 Chromium 里正常工作。
try {
  protocol.registerSchemesAsPrivileged([{
    scheme: ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
  }])
} catch (error) {
  process.stderr.write('[dsh-zoo helper] 注册 dshzoo:// scheme 失败：' + messageOf(error) + '\n')
}

/** 窗口局部/屏幕 DIP 的换算全部靠它；窗口 = 所有显示器工作区的并集（单屏时就是主屏）。 */
let win = null
/**
 * 改名小窗（ticket 13）。它是这套桌宠里**唯一**可聚焦、收键盘的窗口：
 * 主窗必须保持 focusable:false（ADR-0005 的安全约定），所以输入框只能单开一扇。
 * 小窗关掉/崩掉都不会改动主窗的任何状态。
 */
let renameWin = null
/** 正在等宿主答复的那次改名（action id）；宿主的 action-result 认这个 id 才交给小窗。 */
let renamePendingId = null
let renameTimer = null
/** 改名申请的流水号，只用于给 action id 起个不重复的名字。 */
let renameSeq = 0
/**
 * 「带派」小窗（ticket 24）。和改名窗一样是独立、可聚焦、失焦即关的小窗；
 * 它只负责输入与展示，背包内容与增删都在宿主。
 */
let giftWin = null
/** 宿主交下来的背包快照（items/限额），窗口打开或刷新时原样转发给它。 */
let giftState = { items: [], count: 0, maxItems: 2, maxTextLength: 500, maxFileBytes: 0 }
/** 用户在主进程的文件选择器里刚选中的文件；只有这个路径能被提交，渲染端不能自己编。 */
let giftPicked = null
/** 正在等宿主答复的那次 bring/unbring（action id）与它的计时器。 */
let giftPending = null
let giftTimer = null
/** 「带派」申请的流水号，只用于给 action id 起个不重复的名字。 */
let giftSeq = 0
/**
 * 农场小窗（ticket 40）。和改名/带派同一类独立窗口，但**刻意不按失焦关闭**：
 * macOS 中文输入法候选窗会抢焦点，blur 关窗会重演「打中文时小窗消失」。
 * 关窗只由 Esc / 右上角 × / 宿主 `close:true`（再点一次「农场」）/ 主窗 hide / 退出驱动；
 * 10 秒是**动作等待**超时，不是窗口寿命。
 */
let farmWin = null
/** 宿主交下来的完整 farm view（地块/种子/作物/硬币/露水/日志），窗口打开或刷新时原样转发。 */
let farmState = null
/** 交易所页 / `farm-window` 里随农场一起下发的 market view（价目/历史/index）。 */
let farmMarket = null
/** 雇工页（ticket 44）：合同/邻居挂牌/在飞状态，和 farm 一起下发、一起缓存。 */
let farmContracts = null
/** 访客模式（ticket 43）：`owner` / `visitor` 与主人家的快照块（state/guard/plots/limits）。 */
let farmMode = 'owner'
let farmVisit = null
/** 点某块地开窗时带上的 plotId；窗口用它高亮那一块。 */
let farmPlotId = null
/** 正在等宿主答复的那次农场动作（action id）与它的计时器。 */
let farmPending = null
let farmTimer = null
/**
 * 最近一次报给宿主的农场小窗开关（ticket 46）。宿主靠它把右键「农场」变成开/关切换；
 * 只在真的变了时发，避免每次 ready/status 都刷一条。
 */
let lastFarmWindowOpen = null
/** 农场申请的流水号，只用于给 action id 起个不重复的名字。 */
let farmSeq = 0
/** 桌面窗口覆盖的矩形（所有显示器工作区的并集，DIP）；小窗贴宠物时用它把窗口局部矩形换算成屏幕坐标。 */
let workArea = null
let scene = shared.emptyScene()
let sceneAt = 0
/** 渲染端上报的当前素材与失败集合；只用于诊断（宿主 /dsh-zoo/desktop 能读到）。 */
let lastMedia = null
const mediaHistory = []
/**
 * 真实左键的到达次数（ticket 30）。渲染端只在 `isTrusted` 的 pointerdown上报一次；
 * 现场用它对账「窗口显示可交互，点击却根本没进来」。
 */
let trustedDowns = 0
let lastTrustedInputAt = 0
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
 * 控件（弹层/放行卡/召回胶囊）的命中矩形。单独一条通道，因为它们的生命周期跟宠物物理无关；
 * 同样只信最近的快照，过期即无（fail-closed）。宠物矩形排在后面，重叠时宠物优先。
 */
let overlayRects = []
let overlayRectsAt = 0
/**
 * 输入租约：渲染端在拖拽/弹层期间持有。位置判定不参与，但租约必须持续续期；
 * allow=false 表示上一次 forceIgnore（失焦/隐藏/超时收回）之后还没收到「渲染端已放手」的确认，
 * 新的 busy 先不信；since 是这一条租约开始的时间，用于 BUSY_MAX_MS 的硬上限。
 * blocked=true 是硬上限触发后的粘滞状态：只认一次显式 busy:false，连悬停也不能把它复活。
 */
const busy = { active: false, at: 0, since: 0, frozen: false, allow: true, blocked: false }
/** 硬上限可被调试命令临时缩短（冒烟几秒内验证 fail-closed）；生产永远是 BUSY_MAX_MS。 */
let busyCapMs = shared.BUSY_MAX_MS
/** 主进程第一次看见光标进入「某个命中矩形」的时刻（离开即清零），兜底通道的停留计时。 */
let insideSince = 0
/** 调试用：用固定屏幕坐标替代 screen.getCursorScreenPoint()（冒烟脚本注入）。 */
let pointerOverride = null
/** 调试用：锁住输入时忽略窗口 blur（冒烟用合成输入，环境里的焦点变化不应打断用例）。 */
let debugInputLocked = false

let pointerTimer = null
let hostPollTimer = null
let stdinParser = null
/** 宿主 → helper 的输入流（Windows 上是 fd 0 上的读流）；退出时必须显式销毁，见 shutdown()。 */
let hostInput = null

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
    scene = shared.demoPetScene(workArea)
    sceneAt = Date.now()
  } else {
    startHostLink()
  }
  startPointerWatchdog()
}).catch((error) => {
  reportError('create-window-failed', error)
  shutdown(1)
})

/**
 * 桌面表面：所有显示器工作区的并集。
 *
 * 一扇窗铺满整张虚拟桌面，跨屏拖动才可能——指针捕获不能跨窗口，光标一离开 A 窗，
 * pointermove/pointerup 就断了。单屏时并集 == 主屏工作区，行为与以前完全一致。
 * `screen` 抛错或没有显示器时退回主屏工作区（老平台/受限环境仍能起窗）。
 */
function surfaceArea () {
  let displays = []
  try {
    displays = screen.getAllDisplays()
  } catch {
    displays = []
  }
  const area = shared.desktopArea(displays)
  if (area !== null) return area
  return primaryWorkArea()
}

function primaryWorkArea () {
  try {
    return screen.getPrimaryDisplay().workArea
  } catch {
    return { x: 0, y: 0, width: 1440, height: 900 }
  }
}

function createWindow () {
  const area = surfaceArea()
  workArea = area
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

  // 以系统实际给的 bounds 为准：小窗贴宠物时用的是 `workArea`，必须与窗口真的覆盖的矩形一致。
  workArea = surfaceBounds() ?? area

  // 'floating' 是 macOS 的置顶层级（dsh-pet 同款）：'screen-saver' 会压过全屏应用和截图。
  // setVisibleOnAllWorkspaces 只有 macOS/Linux 有实现（Windows 上是空操作），单独判平台，
  // 免得一个平台不支持的调用把 setAlwaysOnTop 一起带进 catch。
  try {
    win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver')
  } catch {
    // 老版本/受限环境没有这个开关：置顶已经由构造参数保证
  }
  if (process.platform !== 'win32') {
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    } catch {
      // 同上：没有这个开关不是错误
    }
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
    // 新渲染端 = 上一份租约/命中矩形全部作废；否则旧租约可能把新页面按住 1.2s。
    busy.active = false
    busy.at = 0
    busy.since = 0
    busy.allow = true
    busy.blocked = false
    rendererRects = []
    rendererRectsAt = 0
    overlayRects = []
    overlayRectsAt = 0
    sceneAt = Date.now()
    setIgnore(true, 'renderer-loaded')
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

/**
 * dock.hide() 的附属应用里，`show()/focus()` 只保证窗口在 app 内是 key；
 * macOS 的输入法（候选窗、输入源切换）跟随**前台应用**，所以用户点「改名/带派」
 * 要打字时显式抢一次前台。只在用户主动打开输入窗时调用，不影响主窗的“不抢焦点”。
 */
function focusAppForDialog () {
  if (process.platform !== 'darwin') return
  try {
    app.focus({ steal: true })
  } catch {
    // 旧版 Electron 没有 steal：窗口自己的 show/focus 已是尽力而为
  }
}

// ---------------------------------------------------------------------------
// dshzoo://asset/<name>.webm
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
    if (url.protocol !== ASSET_SCHEME + ':') return textResponse(404, 'unknown asset')
    // 礼物缩略图（ticket 25）：host=gifts，路径恰好两段；守卫与夹取都在 gift-path.js 里。
    if (url.hostname === GIFT_HOST) return handleGiftRequest(url)
    if (url.hostname !== ASSET_HOST && url.hostname !== CACHE_HOST) {
      return textResponse(404, 'unknown asset')
    }
    let name
    try {
      name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    } catch {
      return textResponse(400, 'bad asset name')
    }
    if (!isSafeAssetName(name)) return textResponse(400, 'bad asset name')
    const file = url.hostname === CACHE_HOST ? resolveCacheFile(name) : resolveAssetFile(name)
    if (file === null) return textResponse(404, 'asset not found')

    const data = await fsp.readFile(file)
    const headers = {
      'content-type': 'video/webm',
      // 本机素材按**动作名**寻址（dshzoo://asset/<名字>.webm）：换皮之后同名动作可能指向
      // 另一个目录里的另一份文件。缓存住的话，切换后点了同名动作还会播旧皮那一段。
      // 远端缓存按内容哈希寻址，内容不会变，照旧可以缓存。
      'cache-control': url.hostname === CACHE_HOST ? 'public, max-age=300' : 'no-store',
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

/**
 * `dshzoo://gifts/<礼物目录>/<图片>`（ticket 25）。
 * 只认两层、只认四种图片扩展名、只认 gifts 根目录下的文件；读不到一律 404（不区分原因）。
 * 这条路径只给缩略图用：卡片上的「打开」走宿主通过 gift-open 命令送来的绝对路径，不经过 URL。
 */
async function handleGiftRequest (url) {
  try {
    if (giftsRoot === null) return textResponse(404, 'gift not found')
    const parts = url.pathname.replace(/^\/+/, '').split('/')
    if (parts.length !== 2) return textResponse(404, 'gift not found')
    let dirName
    let fileName
    try {
      dirName = decodeURIComponent(parts[0])
      fileName = decodeURIComponent(parts[1])
    } catch {
      return textResponse(400, 'bad gift name')
    }
    const file = giftPath.resolveGiftFile(giftsRoot, dirName, fileName)
    if (file === null) return textResponse(404, 'gift not found')
    let info
    try {
      info = await fsp.stat(file)
    } catch {
      return textResponse(404, 'gift not found')
    }
    if (!info.isFile() || info.size <= 0 || info.size > giftPath.MAX_GIFT_IMAGE_BYTES) {
      return textResponse(404, 'gift not found')
    }
    const data = await fsp.readFile(file)
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': giftPath.contentTypeOf(fileName) ?? 'application/octet-stream',
        'content-length': String(data.length),
        // 缩略图跟着这次收到的礼物走：礼物被扔掉/换掉时不要拿缓存里的旧图。
        'cache-control': 'no-store'
      }
    })
  } catch {
    return textResponse(404, 'gift not found')
  }
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

function isSafeCacheName (name) {
  return typeof name === 'string' && /^[0-9a-f]{64}\.webm$/.test(name)
}

function resolveCacheFile (name) {
  if (cacheRoot === null || !isSafeCacheName(name)) return null
  let base
  try {
    base = path.resolve(cacheRoot)
  } catch {
    return null
  }
  const candidate = path.resolve(base, name)
  if (candidate === base || !candidate.startsWith(base + path.sep)) return null
  try {
    const stat = fs.statSync(candidate)
    if (stat.isFile() && stat.size > 0 && stat.size <= MAX_ASSET_BYTES) return candidate
  } catch {
    // 缓存还没落盘：渲染端会走本机素材/通用小人
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
  busy.since = 0
  // 收回租约后，新的 busy 必须等渲染端先确认一次「放开」或重新悬停，才重新被相信。
  busy.allow = false
  busy.blocked = false
  insideSince = 0
  setIgnore(true, reason)
}

function busyFresh (now) {
  if (busy.active !== true || !(busy.at > 0) || busy.blocked === true) return false
  const age = now - busy.at
  if (age < 0 || age > shared.BUSY_LEASE_MS) return false
  const total = busy.since > 0 ? now - busy.since : age
  return total <= busyCapMs
}

/**
 * 收回过期/超上限的租约。这是主进程的硬性 fail-closed：
 * 渲染端还活着但一直续租（例如弹层关不掉）时，超过 BUSY_MAX_MS 也必须把桌面交还。
 * 收回后 allow=false：普通超时可以由一次显式 false 或新的悬停确认恢复；硬上限触发时
 * 额外置 blocked=true，只认显式 false（悬停不能复活），避免有 bug 的弹层周期性占住桌面。
 */
function revokeStaleBusy (now) {
  if (busy.active !== true) return false
  if (busyFresh(now)) return false
  const capped = busy.since > 0 && (now - busy.since) > busyCapMs
  busy.active = false
  busy.at = 0
  busy.since = 0
  busy.allow = false
  // 硬上限触发的收回是粘滞的：只认一次显式 busy:false（渲染端真的关掉了控件），
  // 悬停心跳不能把它复活，否则一个有 bug 的弹层可以每 30s 重新占住整个桌面。
  if (capped) busy.blocked = true
  return true
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
  revokeStaleBusy(now)
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
    busySince: busy.since,
    // 调试里 freeze 表示「渲染端已经死了」：这时连兜底也必须停，验证 fail-closed。
    allowMainFallback: hover.frozen !== true,
    now
  })
  setIgnore(!decision.interactive, decision.reason || reason)
}

/**
 * 主进程眼里的命中区 = 控件矩形 + 宠物矩形。
 * 宠物排在后面，两者重叠时 hitTestRects 倒序优先宠物（“光标在宠物身上”这个诊断不会变成 ui:*）。
 * 控件矩形同样只看最近 RENDERER_RECT_MAX_AGE_MS；过期即无，渲染端卡死时不会留下一个僵尸按钮。
 */
function liveRects (now) {
  let pets
  if (rendererRectsAt > 0 && now - rendererRectsAt <= shared.RENDERER_RECT_MAX_AGE_MS) {
    pets = rendererRects
  } else if (rendererRectsAt === 0 && sceneAt > 0 && now - sceneAt <= shared.SCENE_RECT_FALLBACK_MS && scene.items.length > 0) {
    // 只在渲染端**从未**上报过矩形时用出生矩形兜底；一旦它报过，过期就回穿透（fail-closed）。
    // 出生矩形同样要裁到工作区里，别让一个坏场景把整块屏幕变成可交互区。
    pets = shared.normalizeRects(shared.rectsOfScene(scene), { area: localArea() })
  } else {
    pets = []
  }
  const overlays = overlayRectsAt > 0 && now - overlayRectsAt <= shared.RENDERER_RECT_MAX_AGE_MS
    ? overlayRects
    : []
  if (overlays.length === 0) return pets
  if (pets.length === 0) return overlays
  return overlays.concat(pets)
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

/** 窗口 = 整张虚拟桌面，窗口局部坐标从 (0,0) 起；命中矩形只允许落在这个范围里。 */
function localArea () {
  if (win === null || win.isDestroyed()) return null
  try {
    const bounds = win.getBounds()
    return { x: 0, y: 0, width: bounds.width, height: bounds.height }
  } catch {
    return null
  }
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

ipcMain.on('dsh-zoo:renderer-ready', (event) => {
  if (win === null || win.isDestroyed() || event.sender !== win.webContents) return
  rendererReady = true
  busy.active = false
  busy.at = 0
  busy.since = 0
  busy.allow = true
  overlayRects = []
  overlayRectsAt = 0
  sceneAt = Date.now()
  sendScene()
  applyDecision('renderer-ready')
})

// 渲染端的素材诊断：当前在播哪一段、哪些片段已经失败。只进内存，不落盘。
ipcMain.on('dsh-zoo:media', (event, payload) => {
  if (win === null || win.isDestroyed() || event.sender !== win.webContents) return
  const entry = shared.normalizeMediaReport(payload, Date.now())
  if (entry === null) return
  lastMedia = entry
  mediaHistory.push(entry)
  while (mediaHistory.length > 20) mediaHistory.shift()
})

// 渲染端的「可信输入」心跳（ticket 30）：真实左键有没有到过渲染端，只有它知道。
ipcMain.on('dsh-zoo:input', (event, payload) => {
  if (win === null || win.isDestroyed() || event.sender !== win.webContents) return
  const report = shared.normalizeInputReport(payload)
  if (report === null) return
  lastTrustedInputAt = Date.now()
  if (report.type === 'down') trustedDowns += 1
})

ipcMain.on('dsh-zoo:rects', (event, payload) => {
  if (win === null || win.isDestroyed() || event.sender !== win.webContents) return
  // 渲染端是不可信输入：超大/越界的矩形在这里被拒绝或裁到工作区里（fail closed）。
  rendererRects = shared.normalizeRects(payload, { area: localArea() })
  rendererRectsAt = Date.now()
  // 立即按新矩形复核一次；主进程仍会用自己的光标位置投票。
  applyDecision('renderer-rects')
})

ipcMain.on('dsh-zoo:overlay-rects', (event, payload) => {
  if (win === null || win.isDestroyed() || event.sender !== win.webContents) return
  overlayRects = shared.normalizeRects(payload, { area: localArea() })
  overlayRectsAt = Date.now()
  // 弹层/卡片自己也是命中区：光标压上去时主进程要接管鼠标，不必等悬停心跳。
  applyDecision('renderer-overlays')
})

ipcMain.on('dsh-zoo:busy', (event, payload) => {
  if (win === null || win.isDestroyed() || event.sender !== win.webContents) return
  if (busy.frozen) return
  const next = payload !== null && typeof payload === 'object' && payload.busy === true
  if (next) {
    if (busy.allow !== true || busy.blocked === true) return
    const now = Date.now()
    if (busy.active !== true || !(busy.since > 0)) busy.since = now
    busy.active = true
    busy.at = now
  } else {
    busy.active = false
    busy.at = 0
    busy.since = 0
    busy.allow = true
    busy.blocked = false
  }
  applyDecision(next ? 'renderer-busy' : 'renderer-idle')
})

ipcMain.on('dsh-zoo:action', (event, payload) => {
  if (win === null || win.isDestroyed() || event.sender !== win.webContents) return
  if (!rendererReady) return
  const id = shared.normalizeId(payload?.id)
  const action = typeof payload?.action === 'string' ? payload.action.trim().toLowerCase() : ''
  if (id === null || !shared.DESKTOP_ACTIONS.includes(action)) return
  const needsDevice = action === 'end-visit' || action === 'admit' || action === 'reject' || action === 'dismiss'
  // `visit` 是「可能带对象」：从邻居面板点某一户就带 deviceId；没有就交给宿主随机挑一位
  // （HTTP 口的老行为）。needsDevice 的那几个动作则必须有对象，缺了直接拒绝。
  const deviceId = needsDevice || action === 'visit' ? shared.normalizeId(payload?.deviceId) : null
  if (needsDevice && deviceId === null) {
    sendActionResult({ id, ok: false, notice: '这个操作缺少对象，稍后再试。', error: 'bad-device-id' })
    return
  }
  // 礼物动作只认 UUID 形状的 giftId：路径永远不出渲染端，宿主拿它自己查目录。
  const needsGift = shared.GIFT_ACTIONS.includes(action)
  const giftId = needsGift ? shared.normalizeGiftId(payload?.giftId) : null
  if (needsGift && giftId === null) {
    sendActionResult({ id, ok: false, notice: '这张礼物卡已经不在了。', error: 'bad-gift' })
    return
  }
  // 点播要带动画名：只收安全的动画名，名字由宿主再去 dsh-pet 那边校验一次。
  const name = action === 'play-anim' ? shared.normalizeAnim(payload?.name) : null
  if (action === 'play-anim' && name === null) {
    sendActionResult({ id, ok: false, notice: '这个动作没有名字，播不了。', error: 'bad-name' })
    return
  }
  // 换皮只带素材源 id（ticket 32）：注册表在宿主那边，这里只守 id 的形状。
  const skinId = action === 'use-skin' ? shared.normalizeSkinId(payload?.skinId) : null
  if (action === 'use-skin' && skinId === null) {
    sendActionResult({ id, ok: false, notice: '这个外观没有名字，换不了。', error: 'bad-skin-id' })
    return
  }
  // 农场（ticket 40）：点地块开窗可带 plotId，四个地块动作必须带；种地再要 cropId。
  // 交易所（ticket 41）：不碰地块，只带 cropId + qty（1–99）。
  // 这一层是渲染端 → 宿主的窄口，漏掉一个字段，到 store 就只剩一句 bad-plot。
  const isMarketAction = shared.FARM_MARKET_ACTIONS.includes(action)
  const needsPlot = shared.FARM_PLOT_ACTIONS.includes(action)
  const plotId = needsPlot || action === 'farm-open' ? shared.normalizePlotId(payload?.plotId) : null
  if (needsPlot && plotId === null) {
    sendActionResult({ id, ok: false, notice: '这块地不在桌面上，刷新后再试。', error: 'bad-plot' })
    return
  }
  const cropId = action === 'farm-plant' || isMarketAction
    ? shared.normalizeCropId(payload?.cropId)
    : null
  if ((action === 'farm-plant' || isMarketAction) && cropId === null) {
    sendActionResult({ id, ok: false, notice: '这种作物种不了，换一种吧。', error: 'bad-crop' })
    return
  }
  const qty = isMarketAction ? shared.normalizeTradeQty(payload?.qty) : null
  if (isMarketAction && qty === null) {
    sendActionResult({ id, ok: false, notice: '数量要在 1–99 之间。', error: 'bad-qty' })
    return
  }
  // 雇佣（ticket 44）：四个动作共用 normalizeFarmAction，窗口与主窗走同一道白名单。
  if (shared.FARM_HIRE_ACTIONS.includes(action)) {
    const normalized = shared.normalizeFarmAction({ ...payload, action })
    if (normalized === null) {
      sendActionResult({ id, ok: false, notice: '这个雇佣操作缺少字段，再试一次。', error: 'bad-farm-action' })
      return
    }
    const hireWritten = writeEvent({ type: 'action', id, ...normalized })
    if (!hireWritten) sendActionResult({ id, ok: false, notice: '桌面宿主没有连接。', error: 'host-unavailable' })
    return
  }
  // 渲染端只能**申请**：这一行交给宿主，真正改状态的是宿主的 room/service。
  const written = writeEvent({
    type: 'action',
    id,
    action,
    deviceId,
    ...(name === null ? {} : { name }),
    ...(skinId === null ? {} : { skinId }),
    ...(giftId === null ? {} : { giftId }),
    ...(plotId === null ? {} : { plotId }),
    ...(cropId === null ? {} : { cropId }),
    ...(qty === null ? {} : { qty })
  })
  if (!written) sendActionResult({ id, ok: false, notice: '桌面宿主没有连接，这次操作没有生效。', error: 'host-unavailable' })
})

ipcMain.on('dsh-zoo:hover', (event, payload) => {
  if (win === null || win.isDestroyed() || event.sender !== win.webContents) return
  if (hover.frozen) return
  const inside = payload !== null && typeof payload === 'object' && payload.inside === true
  hover.inside = inside
  hover.lastAt = inside ? Date.now() : 0
  // 渲染端重新看见光标停在命中区 = 它活着且能接指针：允许重新申请输入租约。
  // 但硬上限触发的 blocked 只认 busy:false，悬停不能把它复活。
  if (inside && busy.blocked !== true) busy.allow = true
  // 立即翻转（不用等 100ms 轮询）；主进程仍会用自己的光标位置复核。
  applyDecision(inside ? 'renderer-hover' : 'renderer-leave')
})

// ---------------------------------------------------------------------------
// 改名小窗的 IPC：渲染端只能申请，主进程只转交，真正的写入在宿主那边
// ---------------------------------------------------------------------------

ipcMain.on('dsh-zoo:rename-open', (event) => {
  if (win === null || win.isDestroyed() || event.sender !== win.webContents) return
  // 渲染端还没就绪时开不了窗：它已经把弹层关掉了，这里必须回一句，不能静默。
  if (!openRenameWindow()) {
    try {
      win.webContents.send('dsh-zoo:rename-unavailable')
    } catch {
      // 渲染端正在重启：下一次悬停还会再点一次
    }
  }
})

/** 三条改名 IPC 共用的一行守卫：只认小窗自己的 webContents。 */
function isRenameSender (event) {
  return renameWin !== null && !renameWin.isDestroyed() && event.sender === renameWin.webContents
}

ipcMain.on('dsh-zoo:rename-ready', (event) => {
  if (!isRenameSender(event)) return
  sendRenameInit()
})

ipcMain.on('dsh-zoo:rename-cancel', (event) => {
  if (!isRenameSender(event)) return
  closeRenameWindow('cancel')
})

ipcMain.on('dsh-zoo:rename-submit', (event, payload) => {
  if (!isRenameSender(event)) return
  if (renamePendingId !== null) return
  const raw = typeof payload?.nickname === 'string' ? payload.nickname : ''
  const nickname = raw.slice(0, shared.MAX_ACTION_TEXT)
  if (nickname.trim() === '') {
    sendRenameResult({ ok: false, notice: '名字不能是空的。' })
    return
  }
  renameSeq += 1
  const id = 'rename-' + String(renameSeq) + '-' + Date.now().toString(36)
  renamePendingId = id
  clearRenameTimer()
  renameTimer = setTimeout(() => {
    if (renamePendingId !== id) return
    renamePendingId = null
    sendRenameResult({ ok: false, notice: '桌面宿主没有回应，这次没有改名。' })
  }, RENAME_TIMEOUT_MS)
  renameTimer.unref?.()
  const written = writeEvent({ type: 'action', id, action: 'rename', nickname })
  if (!written) {
    clearRenameTimer()
    renamePendingId = null
    sendRenameResult({ ok: false, notice: '桌面宿主没有连接，这次没有改名。' })
  }
})

// ---------------------------------------------------------------------------
// 「带派」小窗的 IPC：只认这扇窗自己的 webContents
// ---------------------------------------------------------------------------

ipcMain.on('dsh-zoo:gift-ready', (event) => {
  if (!isGiftSender(event)) return
  sendGiftInit()
})

ipcMain.on('dsh-zoo:gift-cancel', (event) => {
  if (!isGiftSender(event)) return
  closeGiftWindow('cancel')
})

ipcMain.on('dsh-zoo:gift-submit', (event, payload) => {
  if (!isGiftSender(event)) return
  if (giftPending !== null) return
  // 选文件不是一次提交：主进程开系统文件选择器，选完把名字/大小推回窗里。
  // 这样 bridge 只需要 submit 一个入口，不必再给渲染端任何 Node 能力。
  if (payload !== null && typeof payload === 'object' && payload.pick === true) {
    void pickGiftFile()
    return
  }
  const gift = shared.normalizeBringGift(payload)
  if (gift === null) {
    sendGiftResult({ ok: false, code: 'bad-gift' })
    return
  }
  // 文件必须是刚才在主进程里选中的那一个：渲染端不能自己编路径。
  if (gift.kind === 'file' && (giftPicked === null || giftPicked.path !== gift.path)) {
    sendGiftResult({ ok: false, code: 'bad-gift' })
    return
  }
  startGiftPending('bring', { action: 'bring', gift })
})

ipcMain.on('dsh-zoo:gift-remove', (event, payload) => {
  if (!isGiftSender(event)) return
  if (giftPending !== null) return
  const giftId = shared.normalizeGiftId(payload?.giftId)
  if (giftId === null) {
    sendGiftResult({ ok: false, code: 'bad-gift' })
    return
  }
  startGiftPending('unbring', { action: 'unbring', giftId })
})

/** 四条「带派」IPC 共用的一行守卫：只认小窗自己的 webContents。 */
function isGiftSender (event) {
  return giftWin !== null && !giftWin.isDestroyed() && event.sender === giftWin.webContents
}

// ---------------------------------------------------------------------------
// 农场小窗的 IPC：只认这扇窗自己的 webContents
// ---------------------------------------------------------------------------

ipcMain.on('dsh-zoo:farm-ready', (event) => {
  if (!isFarmSender(event)) return
  sendFarmState()
})

ipcMain.on('dsh-zoo:farm-close', (event) => {
  if (!isFarmSender(event)) return
  closeFarmWindow('close')
})

ipcMain.on('dsh-zoo:farm-submit', (event, payload) => {
  if (!isFarmSender(event)) return
  // 同一时间只等一条结果：连续点两次时，第二条会静默落空——窗口的 busy 也会挡住它。
  if (farmPending !== null) return
  const action = shared.normalizeFarmAction(payload)
  if (action === null) {
    sendFarmResult({ ok: false, code: 'bad-farm-action' })
    return
  }
  startFarmPending(action.action, action)
})

/** 三条农场 IPC 共用的一行守卫：只认这扇窗自己的 webContents。 */
function isFarmSender (event) {
  return farmWin !== null && !farmWin.isDestroyed() && event.sender === farmWin.webContents
}

function sendScene () {
  if (win === null || win.isDestroyed()) return
  try {
    win.webContents.send('dsh-zoo:scene', scene)
  } catch {
    // 渲染进程正在重启：下一次 did-finish-load 会重发
  }
}

/** 把宿主对某次控件申请的答复交回渲染端；失败也必须有 notice，渲染端才能冒泡。 */
function sendActionResult (result) {
  if (win === null || win.isDestroyed()) return false
  try {
    win.webContents.send('dsh-zoo:action-result', result)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 改名小窗（ticket 13）
//
// 主窗 focusable:false 是刻意的（ADR-0005：一个置顶全屏窗绝不能吃掉焦点），
// 所以输入框只能单开一扇小窗。它只做三件事：显示当前名字、收一个字符串、把
// `{action:'rename', nickname}` 当**申请**交给宿主；真正的写入在宿主那边。
// 小窗的任何异常都不许改动主窗的点穿/租约状态。
// ---------------------------------------------------------------------------

const RENAME_WIDTH = 360
const RENAME_HEIGHT = 168
const RENAME_TIMEOUT_MS = 10000
/**
 * 「带派」小窗（ticket 24）：比改名窗高，要放下字条、选文件按钮和背包列表。
 * 同样是一扇可聚焦的小窗——主窗永远 focusable:false（ADR-0005）。
 */
const GIFT_WIDTH = 380
const GIFT_HEIGHT = 480
const GIFT_TIMEOUT_MS = 10000
/**
 * 农场小窗（ticket 40）：比带派再大一圈，要放下 4 块地、库存行与记录。
 * 10 秒是**一次动作**等宿主回执的上限；窗口本身不因时间关闭（41/44 的页签要久留）。
 */
const FARM_WIDTH = 420
const FARM_HEIGHT = 560
const FARM_TIMEOUT_MS = 10000

/** 自己那只宠物最近的命中矩形（窗口局部 DIP）；`normalizeRects` 输出的是扁平矩形。 */
function selfPetRect () {
  for (const entry of rendererRects) {
    if (entry !== null && entry.id === 'self' && Number.isFinite(entry.width) && Number.isFinite(entry.height)) {
      return entry
    }
  }
  return null
}

/** 贴着宠物开窗；没有命中矩形（宠物刚出门/还没画出来）就落在工作区中央。 */
function renameBounds () {
  const area = workArea ?? screen.getPrimaryDisplay().workArea
  const pet = selfPetRect()
  if (pet === null) {
    return {
      x: Math.round(area.x + (area.width - RENAME_WIDTH) / 2),
      y: Math.round(area.y + (area.height - RENAME_HEIGHT) / 2)
    }
  }
  const petX = area.x + pet.x
  const petY = area.y + pet.y
  const x = Math.round(Math.min(
    Math.max(area.x + 8, petX + pet.width / 2 - RENAME_WIDTH / 2),
    area.x + area.width - RENAME_WIDTH - 8
  ))
  // 优先在宠物上方；上面放不下就落到下方，再不行就夹在工作区里。
  const above = petY - RENAME_HEIGHT - 12
  const below = petY + pet.height + 12
  const y = Math.round(above >= area.y + 8
    ? above
    : Math.min(Math.max(area.y + 8, below), area.y + area.height - RENAME_HEIGHT - 8))
  return { x, y }
}

function currentName () {
  const self = scene.items.find((item) => item.id === 'self')
  return typeof self?.label === 'string' ? self.label : ''
}

function openRenameWindow () {
  if (renameWin !== null && !renameWin.isDestroyed()) {
    renameWin.focus()
    return true
  }
  if (win === null || win.isDestroyed() || !rendererReady) return false
  const bounds = renameBounds()
  const created = new BrowserWindow({
    ...bounds,
    width: RENAME_WIDTH,
    height: RENAME_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    // 这扇窗就是要抢焦点：用户点了改名，接下来要打字。
    focusable: true,
    acceptFirstMouse: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'rename-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: debugEnabled,
      spellcheck: false
    }
  })
  renameWin = created
  try {
    created.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver')
  } catch {
    // 置顶已由构造参数保证
  }
  created.webContents.on('context-menu', (event) => event.preventDefault())
  // **不要**在 blur 时关窗：macOS 上打中文时，输入法候选窗会抢走键盘焦点，这扇窗
  // 也跟着 blur —— 现场就是「打中文时改名小窗消失」。关窗只由 Esc / 取消 / 保存驱动。
  created.on('closed', () => {
    if (renameWin === created) renameWin = null
    clearRenameTimer()
  })
  created.once('ready-to-show', () => {
    if (renameWin !== created || created.isDestroyed()) return
    created.show()
    focusAppForDialog()
    created.focus()
  })
  created.loadFile(path.join(__dirname, 'rename.html')).catch(() => closeRenameWindow('load-failed'))
  return true
}

function closeRenameWindow (reason) {
  if (reason !== 'submit') renamePendingId = null
  clearRenameTimer()
  const target = renameWin
  renameWin = null
  if (target === null || target.isDestroyed()) return
  try {
    target.destroy()
  } catch {
    // 已经没了
  }
}

function clearRenameTimer () {
  if (renameTimer === null) return
  clearTimeout(renameTimer)
  renameTimer = null
}

function sendRenameInit () {
  if (renameWin === null || renameWin.isDestroyed()) return
  try {
    renameWin.webContents.send('dsh-zoo:rename-init', {
      name: currentName(),
      maxLength: shared.MAX_NAME_LENGTH
    })
  } catch {
    // 页面还没挂上：ready 会再来一次
  }
}

function sendRenameResult (result) {
  if (renameWin === null || renameWin.isDestroyed()) return
  try {
    renameWin.webContents.send('dsh-zoo:rename-result', result)
  } catch {
    // 窗口刚被关掉：结果没人接就算了
  }
}

// ---------------------------------------------------------------------------
// 「带派」小窗（ticket 24）
//
// 和改名窗同一套安全模型：独立 preload、只收键盘、只把「申请」交给主进程；
// 背包内容由宿主算好下发（窗口不读盘、不拼路径），文件选择只能走主进程的
// `dialog.showOpenDialog`——渲染端拿不到任意文件路径的入口。
// ---------------------------------------------------------------------------

/** 贴着宠物开窗；没有命中矩形（宠物刚出门/还没画出来）就落在工作区中央。 */
function giftBounds () {
  const area = workArea ?? screen.getPrimaryDisplay().workArea
  const pet = selfPetRect()
  if (pet === null) {
    return {
      x: Math.round(area.x + (area.width - GIFT_WIDTH) / 2),
      y: Math.round(area.y + (area.height - GIFT_HEIGHT) / 2)
    }
  }
  const petX = area.x + pet.x
  const petY = area.y + pet.y
  const x = Math.round(Math.min(
    Math.max(area.x + 8, petX + pet.width / 2 - GIFT_WIDTH / 2),
    area.x + area.width - GIFT_WIDTH - 8
  ))
  const above = petY - GIFT_HEIGHT - 12
  const below = petY + pet.height + 12
  const y = Math.round(above >= area.y + 8
    ? above
    : Math.min(Math.max(area.y + 8, below), area.y + area.height - GIFT_HEIGHT - 8))
  return { x, y }
}

function openGiftWindow () {
  if (giftWin !== null && !giftWin.isDestroyed()) {
    giftWin.focus()
    // 已经开着：把最新背包推一遍（可能刚在别处放进/撤掉了一件）。
    sendGiftInit()
    return true
  }
  if (win === null || win.isDestroyed()) return false
  const created = new BrowserWindow({
    ...giftBounds(),
    width: GIFT_WIDTH,
    height: GIFT_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    focusable: true,
    acceptFirstMouse: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'gift-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: debugEnabled,
      spellcheck: false
    }
  })
  giftWin = created
  giftPicked = null
  giftPending = null
  clearGiftTimer()
  try {
    created.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver')
  } catch {
    // 置顶已由构造参数保证
  }
  created.webContents.on('context-menu', (event) => event.preventDefault())
  // 和改名窗同一条：字条要能打中文，输入法候选窗触发的 blur 不能关窗。
  // 选文件时系统对话框也会让窗口失焦；关窗只由取消 / 提交 / Esc 驱动，不再需要例外。
  created.on('closed', () => {
    if (giftWin === created) giftWin = null
    clearGiftTimer()
  })
  created.once('ready-to-show', () => {
    if (giftWin !== created || created.isDestroyed()) return
    created.show()
    focusAppForDialog()
    created.focus()
  })
  created.loadFile(path.join(__dirname, 'gift.html')).catch(() => closeGiftWindow('load-failed'))
  return true
}

function closeGiftWindow (reason) {
  if (reason !== 'submit') giftPending = null
  clearGiftTimer()
  const target = giftWin
  giftWin = null
  giftPicked = null
  if (target === null || target.isDestroyed()) return
  try {
    target.destroy()
  } catch {
    // 已经没了
  }
}

function clearGiftTimer () {
  if (giftTimer === null) return
  clearTimeout(giftTimer)
  giftTimer = null
}

function sendGiftInit () {
  if (giftWin === null || giftWin.isDestroyed()) return
  try {
    giftWin.webContents.send('dsh-zoo:gift-init', {
      ...giftState,
      picked: giftPicked
    })
  } catch {
    // 页面还没挂上：ready 会再来一次
  }
}

function sendGiftResult (result) {
  if (giftWin === null || giftWin.isDestroyed()) return
  try {
    giftWin.webContents.send('dsh-zoo:gift-result', result)
  } catch {
    // 窗口刚被关掉：结果没人接就算了
  }
}

/**
 * 把一次 bring/unbring 交给宿主，并等 action-result。
 * 和改名共用同一条 action-result 通道：id 对得上才收，成功关窗、失败留在窗里说人话。
 */
function startGiftPending (action, event) {
  giftSeq += 1
  const id = 'gift-' + String(giftSeq) + '-' + Date.now().toString(36)
  giftPending = { id, action }
  clearGiftTimer()
  giftTimer = setTimeout(() => {
    if (giftPending === null || giftPending.id !== id) return
    giftPending = null
    sendGiftResult({ ok: false, code: 'timeout' })
  }, GIFT_TIMEOUT_MS)
  giftTimer.unref?.()
  const written = writeEvent({ ...event, type: 'action', id })
  if (!written) {
    clearGiftTimer()
    giftPending = null
    sendGiftResult({ ok: false, code: 'host-unavailable' })
  }
}

/**
 * 文件选择只能从这里发生：主进程拿到绝对路径，渲染端只看到名字与大小。
 * 提交时还会再核对一次「就是这个路径」，防止渲染端自己编一个。
 */
async function pickGiftFile () {
  if (giftWin === null || giftWin.isDestroyed()) return
  let result
  try {
    result = await dialog.showOpenDialog(giftWin, { properties: ['openFile'] })
  } catch {
    sendGiftResult({ ok: false, code: 'pick-failed' })
    return
  }
  if (giftWin === null || giftWin.isDestroyed()) return
  giftWin.focus()
  if (result === null || typeof result !== 'object' || result.canceled === true) return
  const filePath = Array.isArray(result.filePaths) ? result.filePaths[0] : null
  if (typeof filePath !== 'string' || filePath === '') return
  let info
  try {
    info = await fsp.stat(filePath)
  } catch {
    sendGiftResult({ ok: false, code: 'no-such-file' })
    return
  }
  giftPicked = { path: filePath, name: path.basename(filePath), size: info.size }
  sendGiftInit()
}

// ---------------------------------------------------------------------------
// 农场小窗（ticket 40）
//
// 数据全部来自宿主（`farm-window` 命令），窗口是 file:// 页面，不读盘、不联网。
// 安全模型与改名/带派一致：独立 preload、只把「种/收/浇/施肥」当申请交上去；
// **与它们唯一的区别是不按 blur 关窗**（IME 候选窗会抢焦点），见 openFarmWindow。
// ---------------------------------------------------------------------------

/** 贴着宠物开窗；没有命中矩形（宠物刚出门/还没画出来）就落在工作区中央。 */
function farmBounds () {
  const area = workArea ?? screen.getPrimaryDisplay().workArea
  const pet = selfPetRect()
  if (pet === null) {
    return {
      x: Math.round(area.x + (area.width - FARM_WIDTH) / 2),
      y: Math.round(area.y + (area.height - FARM_HEIGHT) / 2)
    }
  }
  const petX = area.x + pet.x
  const petY = area.y + pet.y
  const x = Math.round(Math.min(
    Math.max(area.x + 8, petX + pet.width / 2 - FARM_WIDTH / 2),
    area.x + area.width - FARM_WIDTH - 8
  ))
  const above = petY - FARM_HEIGHT - 12
  const below = petY + pet.height + 12
  const y = Math.round(above >= area.y + 8
    ? above
    : Math.min(Math.max(area.y + 8, below), area.y + area.height - FARM_HEIGHT - 8))
  return { x, y }
}

function openFarmWindow () {
  if (farmWin !== null && !farmWin.isDestroyed()) {
    farmWin.focus()
    // 已经开着：把最新农场推一遍（可能刚在别处种/收过）。
    sendFarmState()
    return true
  }
  if (win === null || win.isDestroyed()) return false
  const created = new BrowserWindow({
    ...farmBounds(),
    width: FARM_WIDTH,
    height: FARM_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    focusable: true,
    acceptFirstMouse: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'farm-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: debugEnabled,
      spellcheck: false
    }
  })
  farmWin = created
  farmPending = null
  clearFarmTimer()
  notifyFarmWindowState()
  try {
    created.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver')
  } catch {
    // 置顶已由构造参数保证
  }
  created.webContents.on('context-menu', (event) => event.preventDefault())
  // **不要**在 blur 时关窗：macOS 上打中文时输入法候选窗会抢走键盘焦点，这扇窗也会 blur。
  // 农场窗没有输入框也一样——41/44 的页签迟早会加输入。关窗只由 Esc / × / 宿主 close:true /
  // hide / 退出驱动；10 秒超时是「等宿主回执」的上限，不是窗口寿命。
  created.on('closed', () => {
    if (farmWin === created) farmWin = null
    farmPending = null
    clearFarmTimer()
    notifyFarmWindowState()
  })
  created.once('ready-to-show', () => {
    if (farmWin !== created || created.isDestroyed()) return
    created.show()
    focusAppForDialog()
    created.focus()
  })
  created.loadFile(path.join(__dirname, 'farm.html')).catch(() => closeFarmWindow('load-failed'))
  return true
}

function closeFarmWindow (reason) {
  farmPending = null
  clearFarmTimer()
  const target = farmWin
  farmWin = null
  if (target !== null && !target.isDestroyed()) {
    try {
      target.destroy()
    } catch {
      // 已经没了
    }
  }
  notifyFarmWindowState()
}

/**
 * 把农场小窗的真实开关报给宿主（ticket 46）：首次 ready 时 dedupe 会被重置。
 * 只报变化；×/Esc/宿主 `close:true`/hide/退出都汇到这一条。
 */
function notifyFarmWindowState () {
  const open = farmWin !== null && !farmWin.isDestroyed()
  if (open === lastFarmWindowOpen) return
  lastFarmWindowOpen = open
  writeEvent({ type: 'farm-window-state', open })
}

function clearFarmTimer () {
  if (farmTimer === null) return
  clearTimeout(farmTimer)
  farmTimer = null
}

/** 窗口的完整农场数据（地块带 remainingMs，另有种子/作物/硬币/露水/日志/交易所）。 */
function sendFarmState () {
  if (farmWin === null || farmWin.isDestroyed()) return
  try {
    farmWin.webContents.send('dsh-zoo:farm-state', {
      farm: farmState,
      market: farmMarket,
      contracts: farmContracts,
      mode: farmMode,
      visit: farmVisit,
      plotId: farmPlotId
    })
  } catch {
    // 页面还没挂上：ready 会再来一次
  }
}

function sendFarmResult (result) {
  if (farmWin === null || farmWin.isDestroyed()) return
  try {
    farmWin.webContents.send('dsh-zoo:farm-result', result)
  } catch {
    // 窗口刚被关掉：结果没人接就算了
  }
}

/**
 * 把一次种/收/浇/施肥交给宿主，并等 action-result。
 * 与改名/带派同一条 action-result 通道：id 对得上才收；成功**不关窗**（toast 一下继续种）。
 */
function startFarmPending (action, event) {
  farmSeq += 1
  const id = 'farm-' + String(farmSeq) + '-' + Date.now().toString(36)
  farmPending = { id, action }
  clearFarmTimer()
  farmTimer = setTimeout(() => {
    if (farmPending === null || farmPending.id !== id) return
    farmPending = null
    sendFarmResult({ ok: false, code: 'timeout' })
  }, FARM_TIMEOUT_MS)
  farmTimer.unref?.()
  const written = writeEvent({ ...event, type: 'action', id })
  if (!written) {
    clearFarmTimer()
    farmPending = null
    sendFarmResult({ ok: false, code: 'host-unavailable' })
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
  const input = openHostInput()
  hostInput = input
  input.setEncoding('utf8')
  input.on('data', (chunk) => {
    for (const entry of stdinParser.push(chunk)) {
      if (entry.type === 'line') handleHostLine(entry.line)
    }
  })
  input.on('end', () => shutdown(0))
  input.on('close', () => shutdown(0))
  input.on('error', () => shutdown(0))
  input.resume()
}

/**
 * 宿主 → helper 的输入流。
 *
 * **Windows 上不能用 `process.stdin`**：Electron 的 GUI 子系统没有控制台，主进程的
 * `process.stdin` 是个一启动就已经 EOF 的空壳（`process.stdin.fd` 是 `undefined`），
 * 于是 startHostLink 刚挂上监听就收到 `end` → 立刻 shutdown(0) → 窗口在 loadFile
 * 还没完成时被销毁，loadFile 只报一句 `ERR_FAILED (-2)`，看起来像「页面加载失败」。
 *
 * 但宿主确实把 pipe 挂在 fd 0 上（`fs.readSync(0, …)` 能读到宿主写的 JSON 行），
 * 所以这种情况直接从 fd 0 开一条读流。判定收在 shared 里，便于单测（本机没有 Windows）。
 */
function openHostInput () {
  if (shared.shouldReadStdinDirectly(process.platform, process.stdin.fd)) {
    try {
      // autoClose: false —— fd 0 是宿主的 pipe，不该由这条流负责关掉。
      return fs.createReadStream('', { fd: 0, autoClose: false })
    } catch (error) {
      // 建流失败等于「没有宿主输入」：进程会紧接着自己退出，所以这句不躲在 debug 后面。
      process.stderr.write('[dsh-zoo helper] 无法从 fd 0 读取，退回 process.stdin：' + messageOf(error) + '\n')
    }
  }
  return process.stdin
}

function handleHostLine (line) {
  lastHostLineAt = Date.now()
  const parsed = shared.parseLine(line)
  if (!parsed.ok) {
    if (debugEnabled) process.stderr.write('[dsh-zoo helper] 忽略非 JSON 行：' + parsed.error + '\n')
    return
  }
  // 普通运行不接受任何 debug-* 命令；冒烟/调试必须显式带 --dsh-zoo-debug。
  const normalized = shared.normalizeHostCommand(parsed.value, { debug: debugEnabled })
  if (!normalized.ok) {
    if (debugEnabled) process.stderr.write('[dsh-zoo helper] 忽略命令：' + normalized.error + '\n')
    return
  }
  applyCommand(normalized.command)
}

function applyCommand (command) {
  switch (command.type) {
    case 'update': {
      scene = command.scene
      sceneAt = Date.now()
      // ticket 33：换皮之后素材目录跟着场景走。空数组 = 这次没说，沿用启动参数
      // （旧宿主不会带这个字段，helper 不能因此把根目录清空）。
      if (Array.isArray(scene.assetRoots) && scene.assetRoots.length > 0) {
        assetRoots = scene.assetRoots
      }
      pruneRendererRects()
      if (command.scene.reset === true) {
        // 整包重出生：旧控件的矩形对新场景没有意义，先作废，等渲染端重建后再报。
        overlayRects = []
        overlayRectsAt = 0
      }
      // **不要**在这里作废悬停确认：宿主只在宠物集合/动作变化时更新场景，位置是渲染端逐帧
      // 上报的。主进程每一拍都用**新场景 + 新矩形**复核真实光标位置，光标不在命中区就恢复穿透。
      applyDecision('scene-updated')
      sendScene()
      // ticket 40：窗口开着就补推一份新农场；否则收完菜窗口还显示旧硬币/旧地块。
      if (farmWin !== null && !farmWin.isDestroyed()) sendFarmState()
      return
    }
    case 'action-result':
      // 改名小窗的答复走另一条路：成功就连窗带状态一起收，失败留在窗里说人话。
      if (renamePendingId !== null && command.id === renamePendingId) {
        renamePendingId = null
        clearRenameTimer()
        if (command.ok === true) {
          closeRenameWindow('submit')
        } else {
          sendRenameResult({ ok: false, notice: command.notice ?? '改名没有生效。' })
        }
        return
      }
      // 「带派」小窗（ticket 24）：bring 成功就关窗；unbring 成功留在窗里刷新列表，
      // 失败一律把宿主的 notice（或错误码）交回窗口。
      if (giftPending !== null && command.id === giftPending.id) {
        const pending = giftPending
        giftPending = null
        clearGiftTimer()
        if (pending.action === 'bring' && command.ok === true) {
          closeGiftWindow('submit')
        } else {
          sendGiftResult({
            ok: command.ok === true,
            notice: command.notice,
            code: command.error
          })
        }
        return
      }
      // 农场小窗（ticket 40）：按 id 认领，**成功也留在窗里**——收完还要接着种。
      // 结果只把宿主的人话（或错误码）交给窗口做 toast，关窗与否由用户决定。
      if (farmPending !== null && command.id === farmPending.id) {
        farmPending = null
        clearFarmTimer()
        sendFarmResult({
          ok: command.ok === true,
          notice: command.notice,
          code: command.error
        })
        return
      }
      sendActionResult({
        id: command.id,
        ok: command.ok === true,
        notice: command.notice,
        error: command.error
      })
      return
    case 'show':
      showWindow()
      busy.allow = true
      applyDecision('show')
      return
    case 'hide':
      forceIgnore('hide')
      closeRenameWindow('hide')
      closeGiftWindow('hide')
      closeFarmWindow('hide')
      if (win !== null && !win.isDestroyed()) win.hide()
      return
    case 'bring-window': {
      // 宿主交下来的背包快照（ticket 24）：不落盘、不拼路径，只转发给窗口。
      giftState = {
        items: command.items,
        count: command.count,
        maxItems: command.maxItems,
        maxTextLength: command.maxTextLength,
        maxFileBytes: command.maxFileBytes
      }
      if (command.open === true) {
        if (!openGiftWindow()) {
          writeEvent({ type: 'error', id: command.id, code: 'bring-window-failed', message: 'cannot open bring window' })
        }
      } else if (giftWin !== null && !giftWin.isDestroyed()) {
        sendGiftInit()
      }
      return
    }
    case 'farm-window': {
      // 宿主交下来的完整农场 + 交易所 + 访客块（ticket 40/41/43）：不落盘、不拼路径。
      // `open:true` 打开/聚焦（已开则只刷新）；`open:false` 刷新已开着的窗；
      // `close:true` 才是关窗（ticket 46：再点一次「农场」/ `farm-close`），别和刷新混用。
      if (command.close === true) {
        closeFarmWindow('host')
        return
      }
      farmState = command.farm
      farmMarket = command.market
      farmContracts = command.contracts ?? null
      farmMode = command.mode === 'visitor' ? 'visitor' : 'owner'
      farmVisit = command.visit ?? null
      farmPlotId = typeof command.plotId === 'string' ? command.plotId : null
      if (command.open === true) {
        if (!openFarmWindow()) {
          writeEvent({ type: 'error', id: command.id, code: 'farm-window-failed', message: 'cannot open farm window' })
        }
      } else if (farmWin !== null && !farmWin.isDestroyed()) {
        sendFarmState()
      }
      return
    }
    case 'quit':
      shutdown(0)
      return
    case 'ping':
      writeEvent({ type: 'pong', id: command.id })
      return
    case 'status':
      writeEvent(statusEvent(command.id))
      return
    case 'open-url': {
      // 「打开软件」（ticket 22）：地址由宿主给（它拿得到 DSH 的 origin），helper 只负责交出去。
      // 只认 http/https（shared.normalizeHostCommand 已经挡过一遍），这里再挡一次纯属防御。
      const url = typeof command.url === 'string' ? command.url : ''
      if (!/^https?:\/\//i.test(url)) {
        writeEvent({ type: 'error', id: command.id, code: 'bad-url', message: 'only http(s) allowed' })
        return
      }
      void shell.openExternal(url).catch((error) => {
        writeEvent({ type: 'error', id: command.id, code: 'open-failed', message: String(error?.message ?? error).slice(0, 200) })
      })
      return
    }
    case 'gift-open': {
      // 打开便条：交给系统默认程序。shell.openPath 返回空串才是成功，非空是错误文案。
      const target = typeof command.path === 'string' ? command.path : ''
      void shell.openPath(target).then((failure) => {
        if (typeof failure === 'string' && failure !== '') {
          writeEvent({ type: 'error', id: command.id, code: 'open-failed', message: failure.slice(0, 200) })
        }
      }).catch((error) => {
        writeEvent({ type: 'error', id: command.id, code: 'open-failed', message: String(error?.message ?? error).slice(0, 200) })
      })
      return
    }
    case 'gift-reveal': {
      // 在 Finder/资源管理器里显示：只定位，不执行、不打开。
      try {
        shell.showItemInFolder(typeof command.path === 'string' ? command.path : '')
      } catch (error) {
        writeEvent({ type: 'error', id: command.id, code: 'reveal-failed', message: String(error?.message ?? error).slice(0, 200) })
      }
      return
    }
    case 'gift-copy': {
      // 剪贴板只有主进程有（渲染端是 file:// 普通页面），所以复制也走宿主 → helper 这一路。
      if (typeof command.text === 'string' && command.text !== '') {
        try {
          clipboard.writeText(command.text)
        } catch (error) {
          writeEvent({ type: 'error', id: command.id, code: 'copy-failed', message: String(error?.message ?? error).slice(0, 200) })
        }
      }
      return
    }
    case 'gift-discard': {
      // 「扔掉」= 立即删掉**这一件**礼物的目录。路径由宿主解析；这里再确认一次
      // 目标就是某 gifts 目录下的一级子目录——一个坏路径不该变成“删任意目录”。
      const target = typeof command.path === 'string' ? command.path : ''
      if (!isGiftDirPath(target)) {
        writeEvent({ type: 'error', id: command.id, code: 'bad-path', message: 'not a gift directory' })
        return
      }
      void fsp.rm(target, { recursive: true, force: true }).catch((error) => {
        writeEvent({ type: 'error', id: command.id, code: 'discard-failed', message: String(error?.message ?? error).slice(0, 200) })
      })
      return
    }
    case 'shot':
      // 冒烟可以点名抓「带派」/农场小窗；主窗没就绪不影响那扇窗的截图。
      if (command.window === 'bring' || command.window === 'farm') {
        const target = command.window === 'bring' ? giftWin : farmWin
        if (target === null || target.isDestroyed()) {
          writeEvent({
            type: 'error',
            id: command.id,
            code: 'not-ready',
            message: command.window + ' window not open'
          })
          return
        }
        void captureTo(command.path, command.id, command.window)
        return
      }
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
    case 'debug-rename': {
      if (!debugEnabled) return
      if (command.close === true) closeRenameWindow('debug')
      else openRenameWindow()
      return
    }
    case 'debug-blur': {
      // 冒烟用：模拟“输入法候选窗/别的窗口抢走键盘焦点”。任何小窗都不该因此关掉
      // （现场：打中文时小窗消失；农场窗同样不按 blur 关闭）。
      if (!debugEnabled) return
      const target = command.window === 'bring'
        ? giftWin
        : command.window === 'farm' ? farmWin : renameWin
      if (target !== null && !target.isDestroyed()) target.blur()
      return
    }
    case 'debug-dispatch':
      if (!debugEnabled) return
      dispatchInRenderer(command.phase, command.point)
      applyDecision('debug-dispatch-' + command.phase)
      return
    case 'debug-gift-submit': {
      // 冒烟用：在「带派」小窗里填一段字条并按提交。走的是和用户一模一样的
      // form submit 处理器，验证「窗口 → 主进程 → 宿主」那条申请链路。
      if (!debugEnabled) return
      if (giftWin === null || giftWin.isDestroyed()) {
        writeEvent({ type: 'error', id: command.id, code: 'not-ready', message: 'bring window not open' })
        return
      }
      const text = typeof command.text === 'string' ? command.text : ''
      const script = '(() => {' +
        'const el = document.getElementById("text");' +
        'if (!el) return false;' +
        'el.value = ' + JSON.stringify(text) + ';' +
        'el.dispatchEvent(new Event("input"));' +
        'document.getElementById("form").requestSubmit();' +
        'return true;' +
        '})()'
      void giftWin.webContents.executeJavaScript(script, true).catch(() => {})
      return
    }
    case 'debug-gift-remove': {
      // 冒烟用：在「带派」小窗里点第一个可撤的「撤掉」，验窗口 → 主进程 → 宿主的 unbring。
      if (!debugEnabled) return
      if (giftWin === null || giftWin.isDestroyed()) {
        writeEvent({ type: 'error', id: command.id, code: 'not-ready', message: 'bring window not open' })
        return
      }
      const script = '(() => {' +
        'const button = Array.from(document.querySelectorAll(".items .btn.remove")).find((item) => !item.disabled);' +
        'if (!button) return false;' +
        'button.click();' +
        'return true;' +
        '})()'
      void giftWin.webContents.executeJavaScript(script, true).catch(() => {})
      return
    }
    case 'debug-farm-submit': {
      // 冒烟用：在农场小窗里提交一次动作，走的是和用户点击一模一样的 preload → IPC。
      if (!debugEnabled) return
      if (farmWin === null || farmWin.isDestroyed()) {
        writeEvent({ type: 'error', id: command.id, code: 'not-ready', message: 'farm window not open' })
        return
      }
      const payload = JSON.stringify({
        action: command.action,
        plotId: command.plotId,
        cropId: command.cropId,
        qty: command.qty,
        deviceId: command.deviceId,
        hours: command.hours,
        contractId: command.contractId,
        wagePerHour: command.wagePerHour,
        minHours: command.minHours,
        maxHours: command.maxHours,
        enabled: command.enabled
      })
      const script = '(() => {' +
        'if (!window.dshZooFarm) return false;' +
        'window.dshZooFarm.submit(' + payload + ');' +
        'return true;' +
        '})()'
      void farmWin.webContents.executeJavaScript(script, true).catch(() => {})
      return
    }
    case 'debug-farm-tab': {
      // 冒烟用：切到农场小窗的某个页签，好分别截农场/交易所/雇工三页。
      if (!debugEnabled) return
      if (farmWin === null || farmWin.isDestroyed()) {
        writeEvent({ type: 'error', id: command.id, code: 'not-ready', message: 'farm window not open' })
        return
      }
      const tab = command.tab === 'market' || command.tab === 'hire' || command.tab === 'log'
        ? command.tab
        : 'farm'
      const selector = '.tab[data-tab="' + tab + '"]'
      const script = '(() => {' +
        'const tab = document.querySelector(' + JSON.stringify(selector) + ');' +
        'if (!tab) return false;' +
        'tab.click();' +
        'return true;' +
        '})()'
      void farmWin.webContents.executeJavaScript(script, true).catch(() => {})
      return
    }
    case 'debug-farm-close': {
      // 冒烟用：像用户一样关窗。`button` 点右上角 ×，`escape` 在窗口里按 Esc；
      // 两条都走 farm.js → preload → IPC 的真实路径，不是直接 destroy。
      if (!debugEnabled) return
      if (farmWin === null || farmWin.isDestroyed()) {
        writeEvent({ type: 'error', id: command.id, code: 'not-ready', message: 'farm window not open' })
        return
      }
      const script = command.via === 'escape'
        ? '(() => {' +
          'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));' +
          'return true;' +
          '})()'
        : '(() => {' +
          'const button = document.getElementById("close");' +
          'if (!button) return false;' +
          'button.click();' +
          'return true;' +
          '})()'
      void farmWin.webContents.executeJavaScript(script, true).catch(() => {})
      return
    }
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
    case 'debug-busy-max':
      if (!debugEnabled) return
      // 0 = 恢复默认；只影响硬上限，不改变正常租约/心跳判定。
      busyCapMs = command.ms > 0 ? command.ms : shared.BUSY_MAX_MS
      applyDecision('debug-busy-max')
      return
    case 'debug-lock-input':
      if (!debugEnabled) return
      debugInputLocked = command.locked === true
      if (debugInputLocked) forceIgnore('debug-lock-input')
      else busy.allow = true
      void lockRendererInput(debugInputLocked)
      applyDecision(debugInputLocked ? 'debug-lock-input' : 'debug-unlock-input')
      return
    case 'debug-kick-input':
      if (!debugEnabled) return
      // 把「穿透 → 可交互」整条重放一遍（两次真 native 调用）。光标不在命中区时踢完仍是穿透，
      // applyDecision 会重新裁定，不会把整块桌面交出去。Windows 上输入状态卡死时用这个踢。
      setIgnore(true, 'debug-kick-input')
      applyDecision('debug-kick-input')
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
      'globalThis.__dshZooDebug && typeof globalThis.__dshZooDebug.lockInput === "function" ' +
      '? globalThis.__dshZooDebug.lockInput(' + (locked === true ? 'true' : 'false') + ') : false',
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
  const script = 'globalThis.__dshZooDebug && typeof globalThis.__dshZooDebug.dispatch === "function" ' +
    '? globalThis.__dshZooDebug.dispatch(' + JSON.stringify(phase) + ',' +
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
        'globalThis.__dshZooDebug && typeof globalThis.__dshZooDebug.snapshot === "function" ' +
        '? JSON.stringify(globalThis.__dshZooDebug.snapshot()) : null',
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
    // 多屏诊断：窗口实际 bounds、显示器列表、随场景下发的每屏矩形。
    // 混合 DPI 出问题时，这三组数放在一起才能判断是“窗没铺对”还是“屏的坐标就不一致”。
    displays: displayList(),
    floors: Array.isArray(scene.floors) ? scene.floors : [],
    hoverInside: hover.inside,
    lastHoverAgeMs: hover.lastAt > 0 ? now - hover.lastAt : null,
    insideForMs: insideSince > 0 ? now - insideSince : null,
    hoverFrozen: hover.frozen,
    busy: busyFresh(now),
    busyAgeMs: busy.at > 0 ? now - busy.at : null,
    busyHeldMs: busy.since > 0 ? now - busy.since : null,
    busyBlocked: busy.blocked,
    busyCapMs,
    busyFrozen: busy.frozen,
    rendererRects: rendererRects.length,
    rendererRectsAgeMs: rendererRectsAt > 0 ? now - rendererRectsAt : null,
    // ticket 30：可信左键到了几次、最后一次到现在多久——「可交互但点不进来」就看这两个数。
    trustedInputs: trustedDowns,
    lastTrustedInputAgeMs: lastTrustedInputAt > 0 ? now - lastTrustedInputAt : null,
    media: lastMedia,
    mediaHistory: mediaHistory.slice(),
    overlayRects: overlayRects.length,
    overlayRectsAgeMs: overlayRectsAt > 0 ? now - overlayRectsAt : null,
    visible: win !== null && !win.isDestroyed() && win.isVisible(),
    focused: win !== null && !win.isDestroyed() && win.isFocused(),
    /** 改名小窗是否开着；主窗的 focusable 永远是 false，两者互不影响。 */
    renameOpen: renameWin !== null && !renameWin.isDestroyed(),
    /**
     * 开着 ≠ 看得见：透明窗在 `ready-to-show` 之前只是内存里的一个对象。
     * 「点了改名没反应」现场排查就靠这两个数——open 为真、visible 为假，说明窗建出来了没显示。
     */
    renameVisible: renameWin !== null && !renameWin.isDestroyed() && renameWin.isVisible(),
    renameFocused: renameWin !== null && !renameWin.isDestroyed() && renameWin.isFocused(),
    /** 「带派」小窗是否开着（ticket 24）；冒烟用它等窗口真的出来。 */
    bringOpen: giftWin !== null && !giftWin.isDestroyed(),
    /** 农场小窗（ticket 40）：和改名窗一样分开报「开着 / 看得见 / 拿到焦点」。 */
    farmOpen: farmWin !== null && !farmWin.isDestroyed(),
    farmVisible: farmWin !== null && !farmWin.isDestroyed() && farmWin.isVisible(),
    farmFocused: farmWin !== null && !farmWin.isDestroyed() && farmWin.isFocused(),
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
  writeEvent({
    type: 'ready',
    pid: process.pid,
    // 上报**窗口实际覆盖**的矩形，而不是显示器的理论工作区：场景坐标的原点就是它。
    // setBounds 可能被系统夹过；渲染端的物理区域又等于窗口自己（innerWidth/Height），
    // 两者必须是同一个矩形，否则宠物会被宿主放在窗口外（屏幕上看起来就是“不见了”）。
    workArea: surfaceBounds() ?? surfaceArea(),
    displays: displayList(),
    debug: debugEnabled,
    shotMode: isShotMode
  })
  // ticket 46：新 helper 从「没有农场窗」开始。这里强制报一次真实状态，
  // 宿主重启/重连后不会沿用上一个 helper 的旧开关。
  lastFarmWindowOpen = null
  notifyFarmWindowState()
}

/**
 * 当前显示器列表（DIP，屏幕坐标）。`ready` 和 `status` 共用同一份形状：
 * 排查混合 DPI 的坐标问题时要能直接对比 workArea / bounds / scaleFactor。
 */
function displayList () {
  let primary = null
  try {
    primary = screen.getPrimaryDisplay()
  } catch {
    primary = null
  }
  try {
    return screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      primary: primary !== null && display.id === primary.id
    }))
  } catch {
    return []
  }
}

function surfaceBounds () {
  if (win === null || win.isDestroyed()) return null
  try {
    return shared.normalizeRect(win.getBounds())
  } catch {
    return null
  }
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

/**
 * 只接受 `<任意>/gifts/<一个目录>` 这种目标：`gift-discard` 是破坏性操作，
 * 主进程不能因为宿主给错一个路径就把别的东西删了（宿主那一侧也会再校验）。
 */
function isGiftDirPath (value) {
  if (typeof value !== 'string' || value === '') return false
  if (!path.isAbsolute(value)) return false
  const resolved = path.resolve(value)
  if (resolved === path.parse(resolved).root) return false
  if (path.basename(path.dirname(resolved)) !== 'gifts') return false
  return path.basename(resolved) !== '' && path.basename(resolved) !== '.' && path.basename(resolved) !== '..'
}

function reportError (code, error) {
  const message = error instanceof Error ? error.message : String(error)
  writeEvent({ type: 'error', code, message: message.slice(0, shared.MAX_ERROR_LENGTH) })
  if (debugEnabled) process.stderr.write('[dsh-zoo helper] ' + code + ': ' + message + '\n')
}

// ---------------------------------------------------------------------------
// 截图（唯一能看到窗口的办法：这台机器上截不了真实屏幕）
// ---------------------------------------------------------------------------

async function captureTo (filePath, id, target = 'main') {
  // 冒烟可以点名抓小窗：主窗与它们各自 capturePage，别把两扇窗的坐标混在一起。
  const window = target === 'bring' ? giftWin : target === 'farm' ? farmWin : win
  const image = await capturePage(window)
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
    workArea: surfaceBounds() ?? surfaceArea(),
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
    busy: busyFresh(Date.now()),
    overlayRects: overlayRects.length,
    debug: debugEnabled,
    shotMode: isShotMode
  }
}

async function capturePage (target = win) {
  if (target === null || target.isDestroyed()) return null
  let timer = null
  try {
    return await Promise.race([
      target.webContents.capturePage(),
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
// 显示器变化：窗口跟着虚拟桌面走，场景交回宿主重算
// ---------------------------------------------------------------------------

function scheduleDisplayRefresh () {
  if (displayTimer !== null) clearTimeout(displayTimer)
  displayTimer = setTimeout(() => {
    displayTimer = null
    if (quitting || win === null || win.isDestroyed()) return
    // 插/拔/改分辨率都重算整张虚拟桌面，而不是只盯主屏：拔掉一块屏要缩回来，
    // 插上一块要扩出去；只改主屏的话，第二块屏永远是“看得见、点不到”。
    const area = surfaceArea()
    try {
      win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height })
    } catch {
      // 改不了就继续用旧尺寸：判定仍按真实 bounds，不会错位
    }
    workArea = surfaceBounds() ?? area
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
  // fd 0 上的读请求会挂在 libuv 线程池里，Electron 的退出流程要等它回报；
  // 不主动销毁这条流，Windows 上收到 `quit` 后进程会一直停在那里不退出
  // （宿主 dispose 时会顺带关掉管道所以看不出来，冒烟里只发 quit 就卡住了）。
  try {
    if (hostInput !== null) hostInput.destroy()
  } catch {
    // 已经关了
  }
  stopTimers()
  closeRenameWindow('shutdown')
  closeGiftWindow('shutdown')
  closeFarmWindow('shutdown')
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
    assets: [],
    cache: null,
    gifts: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dsh-zoo-shot') {
      parsed.shot = argv[index + 1] ?? null
      index += 1
    } else if (arg.startsWith('--dsh-zoo-shot=')) {
      parsed.shot = arg.slice('--dsh-zoo-shot='.length)
    } else if (arg === '--dsh-zoo-shot-delay') {
      parsed.shotDelayMs = parseDelay(argv[index + 1])
      index += 1
    } else if (arg.startsWith('--dsh-zoo-shot-delay=')) {
      parsed.shotDelayMs = parseDelay(arg.slice('--dsh-zoo-shot-delay='.length))
    } else if (arg === '--dsh-zoo-host-pid') {
      parsed.hostPid = parseHostPid(argv[index + 1])
      index += 1
    } else if (arg.startsWith('--dsh-zoo-host-pid=')) {
      parsed.hostPid = parseHostPid(arg.slice('--dsh-zoo-host-pid='.length))
    } else if (arg === '--dsh-zoo-assets') {
      if (typeof argv[index + 1] === 'string') parsed.assets.push(argv[index + 1])
      index += 1
    } else if (arg.startsWith('--dsh-zoo-assets=')) {
      parsed.assets.push(arg.slice('--dsh-zoo-assets='.length))
    } else if (arg === '--dsh-zoo-cache') {
      if (typeof argv[index + 1] === 'string') parsed.cache = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--dsh-zoo-cache=')) {
      parsed.cache = arg.slice('--dsh-zoo-cache='.length)
    } else if (arg === '--dsh-zoo-gifts') {
      if (typeof argv[index + 1] === 'string') parsed.gifts = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--dsh-zoo-gifts=')) {
      parsed.gifts = arg.slice('--dsh-zoo-gifts='.length)
    } else if (arg === '--dsh-zoo-debug') {
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
