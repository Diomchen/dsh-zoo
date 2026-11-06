/**
 * 测试替身：只实现 desktop/main.js 用到的那一小块 Electron API。
 *
 * 存在的唯一理由：这台机器上没法真的插两块屏，而「多屏」是 main.js 里少数没法用纯函数
 * 测的路径——它读 `screen.getAllDisplays()`、把窗口 bounds 设成某个矩形、再用真实光标位置
 * 裁命中区。替身把这几处换成一份可改写的 JSON 布局，其余（窗口、IPC、生命周期）尽量按
 * Electron 的形状来，让被测的仍是 desktop/main.js 本身，而不是一段重写的逻辑。
 *
 * 布局文件（环境变量 DSH_ZOO_FAKE_LAYOUT 指定）：
 *   {
 *     "revision": 1,
 *     "primaryId": 1,
 *     "cursor": { "x": 10, "y": 10 },
 *     "displays": [{ "id":1, "bounds":{...}, "workArea":{...}, "scaleFactor":2 }]
 *   }
 * revision 变化时按增删发出 display-added / display-removed / display-metrics-changed。
 *
 * 渲染端替身：收到 `dsh-zoo:scene` 后按场景矩形（窗口局部 DIP）上报 `dsh-zoo:rects`，
 * 并在光标压在矩形上时上报 `dsh-zoo:hover`——与 desktop/renderer.js 的最小行为一致，
 * 足以让主进程的点击穿透裁定走真实代码路径。
 */

'use strict'

const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const layoutPath = process.env.DSH_ZOO_FAKE_LAYOUT || ''
let layout = readLayout()
let revision = layout === null ? -1 : Number(layout.revision) || 0
let scene = null
let mainContents = null
let pollTimer = null

function readLayout () {
  if (layoutPath === '') return null
  try {
    const parsed = JSON.parse(fs.readFileSync(layoutPath, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function displays () {
  return layout !== null && Array.isArray(layout.displays) ? layout.displays : []
}

function primaryDisplay () {
  const list = displays()
  const primaryId = layout !== null ? layout.primaryId : null
  return list.find((display) => display.id === primaryId) ?? list[0] ?? null
}

function cursorPoint () {
  const point = layout !== null ? layout.cursor : null
  return point !== null && typeof point === 'object' &&
    Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
    ? { x: Number(point.x), y: Number(point.y) }
    : { x: 0, y: 0 }
}

// ---------------------------------------------------------------------------
// ipcMain：主进程注册监听；替身渲染端用 emit 从「渲染端」发消息
// ---------------------------------------------------------------------------

class FakeIpcMain extends EventEmitter {}

const ipcMain = new FakeIpcMain()

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

class FakeWebContents extends EventEmitter {
  constructor (window) {
    super()
    this.win = window
  }

  send (channel, payload) {
    if (channel === 'dsh-zoo:scene') {
      scene = payload
      // 真渲染端在下一帧按本地物理上报；这里下一拍就报，等价于「宠物流畅地画在场景里」。
      setTimeout(() => reportRects(this, true), 0).unref?.()
    }
    return true
  }

  setBackgroundThrottling () {}

  executeJavaScript () {
    return Promise.resolve(null)
  }

  capturePage () {
    return Promise.resolve(null)
  }
}

class FakeBrowserWindow extends EventEmitter {
  constructor (options = {}) {
    super()
    this.options = options
    this.bounds = {
      x: Number.isFinite(options.x) ? options.x : 0,
      y: Number.isFinite(options.y) ? options.y : 0,
      width: Number.isFinite(options.width) ? options.width : 800,
      height: Number.isFinite(options.height) ? options.height : 600
    }
    this.destroyed = false
    this.visible = false
    this.focused = false
    this.webContents = new FakeWebContents(this)
    // 主窗是唯一用 desktop/preload.js 的那扇；改名/带派是各自的 *-preload.js。
    const preload = options.webPreferences?.preload
    if (typeof preload === 'string' && path.basename(preload) === 'preload.js') {
      mainContents = this.webContents
    }
  }

  loadFile () {
    setTimeout(() => {
      if (this.destroyed) return
      this.webContents.emit('did-finish-load')
      this.emit('ready-to-show')
    }, 0).unref?.()
    return Promise.resolve()
  }

  loadURL () {
    return this.loadFile()
  }

  showInactive () {
    this.visible = true
  }

  show () {
    this.visible = true
    this.focused = true
  }

  focus () {
    this.focused = true
  }

  hide () {
    this.visible = false
    this.emit('hide')
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    this.visible = false
    this.emit('closed')
  }

  close () {
    this.destroy()
  }

  isDestroyed () {
    return this.destroyed
  }

  isVisible () {
    return this.visible
  }

  isFocused () {
    return this.focused
  }

  isFocusable () {
    return this.options.focusable !== false
  }

  isAlwaysOnTop () {
    return this.options.alwaysOnTop === true
  }

  isVisibleOnAllWorkspaces () {
    return true
  }

  setBounds (next) {
    if (this.destroyed) return
    const bounds = next !== null && typeof next === 'object' ? next : {}
    for (const key of ['x', 'y', 'width', 'height']) {
      if (Number.isFinite(bounds[key])) this.bounds[key] = bounds[key]
    }
  }

  getBounds () {
    return { ...this.bounds }
  }

  setPosition () {}
  setAlwaysOnTop () {}
  setVisibleOnAllWorkspaces () {}
  setIgnoreMouseEvents (ignore) {
    this.ignoring = ignore !== false
  }

  sendInputEvent () {}
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

class FakeScreen extends EventEmitter {
  getPrimaryDisplay () {
    const display = primaryDisplay()
    return display === null ? undefined : display
  }

  getAllDisplays () {
    return displays()
  }

  getCursorScreenPoint () {
    return cursorPoint()
  }
}

const screen = new FakeScreen()

function pollLayout () {
  const next = readLayout()
  if (next === null) return
  const nextRevision = Number(next.revision) || 0
  if (nextRevision === revision) {
    // 光标可能在同一版布局里被挪动：替身渲染端靠这次刷新决定要不要报 hover。
    layout = next
    return
  }
  const before = layout
  layout = next
  revision = nextRevision
  const beforeIds = new Set((before?.displays ?? []).map((display) => display.id))
  const afterIds = new Set(displays().map((display) => display.id))
  const added = [...afterIds].some((id) => !beforeIds.has(id))
  const removed = [...beforeIds].some((id) => !afterIds.has(id))
  if (added) screen.emit('display-added', {}, primaryDisplay())
  if (removed) screen.emit('display-removed', {}, primaryDisplay())
  if (!added && !removed) screen.emit('display-metrics-changed', {}, primaryDisplay())
  // 布局变了：窗口 bounds 改变后渲染端会重新报矩形（真渲染端收 resize 事件）。
  setTimeout(() => {
    if (mainContents !== null) reportRects(mainContents, true)
  }, 0).unref?.()
}

pollTimer = setInterval(pollLayout, 50)
pollTimer.unref?.()

// ---------------------------------------------------------------------------
// 渲染端替身
// ---------------------------------------------------------------------------

function sceneRects () {
  if (scene === null || !Array.isArray(scene.items)) return []
  return scene.items.map((item) => ({
    id: item.id,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height
  }))
}

function reportRects (contents, includeHover) {
  if (contents.win.destroyed) return
  ipcMain.emit('dsh-zoo:rects', { sender: contents }, sceneRects())
  if (includeHover === true) reportHover(contents)
}

/** 光标在场景矩形里 = 渲染端看到指针压在宠物上（真渲染端由 pointermove 驱动）。 */
function reportHover (contents) {
  if (contents.win.destroyed) return
  const point = cursorPoint()
  const bounds = contents.win.bounds
  const local = { x: point.x - bounds.x, y: point.y - bounds.y }
  const inside = sceneRects().some((rect) =>
    local.x >= rect.x && local.x < rect.x + rect.width &&
    local.y >= rect.y && local.y < rect.y + rect.height)
  ipcMain.emit('dsh-zoo:hover', { sender: contents }, { inside })
}

const heartbeat = setInterval(() => {
  if (mainContents === null || mainContents.win.destroyed) return
  if (scene === null) return
  reportRects(mainContents, true)
}, 200)
heartbeat.unref?.()

// ---------------------------------------------------------------------------
// app / protocol / 杂项
// ---------------------------------------------------------------------------

const app = new EventEmitter()
app.setName = () => {}
app.commandLine = { appendSwitch: () => {} }
app.dock = { hide: () => {} }
app.focus = () => {}
app.whenReady = () => Promise.resolve()
app.isReady = () => true
app.quit = () => {
  app.emit('before-quit')
  app.emit('will-quit')
  process.exitCode = 0
  setTimeout(() => process.exit(0), 20).unref?.()
}
app.exit = (code) => process.exit(Number.isFinite(code) ? code : 0)

const protocol = {
  registerSchemesAsPrivileged: () => {},
  handle: () => {}
}

const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] })
}

const shell = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
  showItemInFolder: () => {}
}

const clipboard = { writeText: () => {} }

module.exports = {
  app,
  BrowserWindow: FakeBrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  protocol,
  screen,
  shell
}
