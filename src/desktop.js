/**
 * 宿主侧的桌面层：拉起 Electron helper、喂它场景、崩了退避重启、卸载时收尸。
 *
 * 这一层最重要的性质是「不可见地失败」：
 *   - 任何一条路径都不许把异常抛进插件的 apply（全部 try/catch + 返回 {ok:false}）；
 *   - 宿主不是桌面版 / 不是 macOS / 找不到 Electron → 只打一行日志，然后当作桌面层不存在；
 *   - helper 崩溃只影响宠物显示，DSH 本身和插件的网络/信任逻辑照常；
 *   - dispose 时先 quit 再 SIGTERM，1s 后 SIGKILL；宿主进程退出时同步 SIGKILL。
 *
 * 协议见 desktop/README.md。JSON 行、双向、无端口。
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import shared from '../desktop/shared.js'
import {
  DESKTOP_PING_MS,
  DESKTOP_SHOT_TIMEOUT_MS,
  DESKTOP_STATUS_TIMEOUT_MS,
  buildHelperArgs,
  createRestartPolicy,
  describeUnavailable,
  helperEnv,
  isDesktopHost,
  resolveElectronBinary
} from './desktop-launch.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 包内的 helper 主进程；不经 npm 解析，打包时随 files 一起带上。 */
export const HELPER_MAIN = join(HERE, '..', 'desktop', 'main.js')
export const HELPER_STDERR_BUFFER = 8

function noop () {}

function messageOf (error) {
  return error instanceof Error ? error.message : String(error)
}

function safe (fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * @param {object} [options]
 * @param {{info?:Function,warn?:Function}} [options.log] 只打单行；由 service 加前缀
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {NodeJS.ProcessVersions} [options.versions]
 * @param {boolean} [options.desktopHost] 覆盖桌面版判定（测试/冒烟用）
 * @param {Function} [options.spawn] child_process.spawn 注入
 * @param {Function} [options.exists] 路径存在性注入
 * @param {string[]} [options.assetRoots] 宿主解析好的 dsh-pet 素材目录（helper 的 localpet:// 根）
 * @param {Function} [options.onEvent] 收到 helper 事件（ready/hit/...）时回调；异常被吞
 */
export function createDesktop (options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const versions = options.versions ?? process.versions
  const spawnFn = typeof options.spawn === 'function' ? options.spawn : nodeSpawn
  const exists = typeof options.exists === 'function' ? options.exists : undefined
  const now = typeof options.now === 'function' ? options.now : Date.now
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout
  const helperMain = typeof options.helperPath === 'string' && options.helperPath !== ''
    ? options.helperPath
    : HELPER_MAIN
  const hostPid = Number.isInteger(options.hostPid) && options.hostPid > 0 ? options.hostPid : process.pid
  const assetRoots = Array.isArray(options.assetRoots) ? options.assetRoots.slice() : []
  const debug = options.debug === true
  const pingMs = Number.isFinite(options.pingMs) && options.pingMs >= 100 ? options.pingMs : DESKTOP_PING_MS
  const log = {
    info: typeof options.log?.info === 'function' ? options.log.info : noop,
    warn: typeof options.log?.warn === 'function' ? options.log.warn : noop
  }
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null
  const policy = createRestartPolicy({
    maxRestarts: options.maxRestarts,
    baseDelayMs: options.restartBaseMs,
    maxDelayMs: options.restartMaxMs,
    stableMs: options.stableMs,
    now
  })

  let availability = null
  let unavailableLogged = false
  let disposed = false
  let child = null
  let ready = false
  let workArea = null
  let lastScene = null
  let lastEvent = null
  let lastError = null
  let helperErrors = 0
  let restartTimer = null
  let pingTimer = null
  let shotTimer = null
  let statusTimer = null
  let pendingShot = null
  let pendingStatus = null
  let sequence = 0
  let exitHook = null
  const stdoutParser = shared.createLineParser()
  const stderrParser = shared.createLineParser()
  const stderrLines = []
  const debugLines = []

  // -------------------------------------------------------------------------
  // 可用性
  // -------------------------------------------------------------------------

  function computeAvailability () {
    if (options.desktopHost === false) return { ok: false, reason: 'not-desktop-host' }
    if (options.desktopHost !== true && !isDesktopHost(versions)) {
      return { ok: false, reason: 'not-desktop-host' }
    }
    if (platform !== 'darwin') return { ok: false, reason: 'unsupported-platform', platform }
    const resolved = resolveElectronBinary({ env, platform, exists })
    if (!resolved.ok) return resolved
    return resolved
  }

  function logUnavailable (result) {
    if (unavailableLogged) return
    unavailableLogged = true
    const line = describeUnavailable(result, { helperPath: helperMain })
    if (result.reason === 'not-desktop-host') log.info(line)
    else log.warn(line)
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  function start () {
    try {
      if (disposed) return { ok: false, reason: 'disposed' }
      if (availability === null) availability = computeAvailability()
      if (!availability.ok) {
        logUnavailable(availability)
        return { ...availability }
      }
      if (child !== null) return { ok: true, pid: child.pid ?? null, reused: true }
      return spawnHelper()
    } catch (error) {
      lastError = messageOf(error)
      log.warn('桌面层启动失败：' + lastError)
      return { ok: false, reason: 'error', detail: lastError }
    }
  }

  function spawnHelper () {
    if (disposed || child !== null || availability === null || !availability.ok) {
      return { ok: false, reason: 'not-running' }
    }
    const args = buildHelperArgs({ helperPath: helperMain, hostPid, debug, assetRoots })
    policy.onStart(now())
    let spawned = null
    try {
      spawned = spawnFn(availability.path, args, {
        cwd: dirname(helperMain),
        env: helperEnv(env, hostPid),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      return failSpawn(error)
    }
    if (spawned === null || typeof spawned.once !== 'function') {
      return failSpawn(new Error('spawn 没有返回子进程'))
    }
    child = spawned
    ready = false
    workArea = null
    stdoutParser.reset()
    stderrParser.reset()
    installExitHook()
    installPingTimer()
    if (debug) log.info('桌面 helper 已拉起（pid ' + String(spawned.pid ?? '?') + '）')

    safe(() => spawned.stdout?.setEncoding('utf8'))
    safe(() => spawned.stderr?.setEncoding('utf8'))
    spawned.stdout?.on('data', (chunk) => {
      if (disposed || child !== spawned) return
      for (const entry of stdoutParser.push(chunk)) {
        if (entry.type === 'line') handleHelperLine(entry.line)
        else recordDebug('stdout 超长行已丢弃')
      }
    })
    spawned.stderr?.on('data', (chunk) => {
      if (disposed || child !== spawned) return
      for (const entry of stderrParser.push(chunk)) {
        if (entry.type !== 'line') continue
        const line = entry.line.trim()
        if (line === '') continue
        stderrLines.push(line.slice(0, 500))
        while (stderrLines.length > HELPER_STDERR_BUFFER) stderrLines.shift()
        if (debug) log.warn('[helper] ' + line.slice(0, 300))
      }
    })
    spawned.stdin?.on('error', () => {
      // EPIPE：helper 正在退出/重启。写失败静默，退出事件会统一处理。
    })
    spawned.once('error', (error) => {
      if (child !== spawned) return
      lastError = messageOf(error)
      if (spawned.pid !== undefined) {
        // 活着的进程报错（例如 kill 失败）：等 exit，别重复计算一次崩溃。
        recordDebug('helper 进程错误：' + lastError)
        return
      }
      child = null
      ready = false
      settlePending('helper-error')
      const decision = policy.onExit(now())
      log.warn('桌面 helper 进程错误（' + lastError + '）' + restartSuffix(decision))
      scheduleRestart(decision)
    })
    spawned.once('exit', (code, signal) => {
      if (child !== spawned) return
      child = null
      ready = false
      workArea = null
      settlePending('helper-exited')
      if (disposed) return
      const decision = policy.onExit(now())
      const detail = 'code=' + String(code ?? 'null') + ', signal=' + String(signal ?? 'null')
      if (decision.action === 'give-up') {
        log.warn('桌面 helper 退出（' + detail + '），已连续崩溃 ' +
          String(decision.restarts) + ' 次，本次会话不再显示宠物')
        return
      }
      log.warn('桌面 helper 退出（' + detail + '），' + String(decision.delayMs) + 'ms 后重启')
      scheduleRestart(decision)
    })

    return { ok: true, pid: spawned.pid ?? null }
  }

  function failSpawn (error) {
    lastError = messageOf(error)
    const decision = policy.onExit(now())
    log.warn('桌面 helper 启动失败（' + lastError + '）' + restartSuffix(decision))
    scheduleRestart(decision)
    return { ok: false, reason: 'spawn-failed', detail: lastError }
  }

  function restartSuffix (decision) {
    if (decision.action === 'give-up') {
      return '，已连续崩溃 ' + String(decision.restarts) + ' 次，本次会话不再重启'
    }
    return '，' + String(decision.delayMs) + 'ms 后重启'
  }

  function scheduleRestart (decision) {
    if (disposed || decision.action !== 'restart') return
    if (restartTimer !== null) return
    restartTimer = setTimer(() => {
      restartTimer = null
      if (disposed || child !== null) return
      spawnHelper()
    }, decision.delayMs)
    restartTimer?.unref?.()
  }

  function installExitHook () {
    if (exitHook !== null) return
    exitHook = () => {
      // 宿主进程正在退出：同步补一刀，绝不把 helper 留在桌面上。
      try {
        if (child !== null) child.kill('SIGKILL')
      } catch {
        // 已经没了
      }
    }
    process.once('exit', exitHook)
  }

  function removeExitHook () {
    if (exitHook === null) return
    try {
      process.removeListener('exit', exitHook)
    } catch {
      // ignore
    }
    exitHook = null
  }

  function installPingTimer () {
    if (pingTimer !== null || disposed) return
    pingTimer = setInterval(() => {
      if (child !== null) send({ type: 'ping', id: nextId() })
    }, pingMs)
    pingTimer?.unref?.()
  }

  // -------------------------------------------------------------------------
  // 协议
  // -------------------------------------------------------------------------

  function send (command) {
    if (child === null || child.stdin === null || child.stdin === undefined) return false
    if (child.stdin.destroyed === true) return false
    const line = shared.encodeMessage(command)
    if (line === null) return false
    try {
      child.stdin.write(line)
      return true
    } catch {
      return false
    }
  }

  function handleHelperLine (line) {
    if (disposed || child === null) return
    const parsed = shared.parseLine(line)
    if (!parsed.ok) {
      recordDebug('helper stdout 非 JSON 行：' + line.slice(0, 200))
      return
    }
    const normalized = shared.normalizeHelperEvent(parsed.value)
    if (!normalized.ok) {
      recordDebug('helper 事件不合法（' + normalized.error + '）：' + line.slice(0, 200))
      return
    }
    handleEvent(normalized.event)
  }

  function handleEvent (event) {
    lastEvent = event
    if (event.type === 'ready') {
      ready = true
      workArea = event.workArea
      // 重启/重载后 helper 是空的：把最后一份场景补给它（服务层在 ready 时还会对账一次）。
      // 这里刻意去掉 reset：新渲染端本来就会按 x/y 出生；显示器变化时保留现场位置更自然。
      if (lastScene !== null) send({ type: 'update', scene: { ...lastScene, reset: false } })
    } else if (event.type === 'shot') {
      if (pendingShot !== null && (event.id === null || event.id === pendingShot.id)) {
        const pending = pendingShot
        pendingShot = null
        if (shotTimer !== null) {
          clearTimer(shotTimer)
          shotTimer = null
        }
        pending.resolve({ ok: true, ...event })
      }
    } else if (event.type === 'status') {
      if (pendingStatus !== null && (event.id === null || event.id === pendingStatus.id)) {
        const pending = pendingStatus
        pendingStatus = null
        if (statusTimer !== null) {
          clearTimer(statusTimer)
          statusTimer = null
        }
        pending.resolve({ ok: true, status: event.status })
      }
    } else if (event.type === 'error') {
      lastError = event.code + ': ' + event.message
      helperErrors += 1
      if (helperErrors <= 5) log.warn('桌面 helper 报错（' + event.code + '）：' + event.message)
    }
    if (onEvent !== null) {
      try {
        onEvent(event)
      } catch {
        // 观察者坏掉不能影响协议处理
      }
    }
  }

  function nextId () {
    sequence += 1
    return sequence
  }

  function settlePending (reason) {
    if (pendingShot !== null) {
      const pending = pendingShot
      pendingShot = null
      if (shotTimer !== null) {
        clearTimer(shotTimer)
        shotTimer = null
      }
      pending.resolve({ ok: false, error: reason })
    }
    if (pendingStatus !== null) {
      const pending = pendingStatus
      pendingStatus = null
      if (statusTimer !== null) {
        clearTimer(statusTimer)
        statusTimer = null
      }
      pending.resolve({ ok: false, error: reason })
    }
  }

  function recordDebug (line) {
    debugLines.push(line)
    while (debugLines.length > 10) debugLines.shift()
  }

  // -------------------------------------------------------------------------
  // 公共 API（全部不抛）
  // -------------------------------------------------------------------------

  function update (scene) {
    try {
      lastScene = shared.normalizeScene(scene)
      if (!ready) return false
      return send({ type: 'update', scene: lastScene })
    } catch {
      return false
    }
  }

  /**
   * 强制整包对账：即使场景内容没变，也让渲染端按 item 的 x/y 重新出生所有宠物。
   * 用于 helper 重启（新渲染端本来是空的，这只算保险）和宿主主动「把宠物摆回原位」。
   */
  function resync (scene) {
    try {
      const normalized = shared.normalizeScene(scene)
      normalized.reset = true
      lastScene = normalized
      if (!ready) return false
      return send({ type: 'update', scene: normalized })
    } catch {
      return false
    }
  }

  function show () {
    try {
      return send({ type: 'show' })
    } catch {
      return false
    }
  }

  function hide () {
    try {
      return send({ type: 'hide' })
    } catch {
      return false
    }
  }

  /**
   * 回一条控件申请的结果给 helper（ticket 11）。id 必须原样带回，渲染端才能把
   * “这次点击失败了”对上是哪一次；notice 必须是能直接显示给人看的一句话。
   */
  function actionResult (id, result = {}) {
    try {
      if (typeof id !== 'string' || id.trim() === '' || id.length > shared.MAX_ID_LENGTH) return false
      return send({
        type: 'action-result',
        id,
        ok: result !== null && typeof result === 'object' && result.ok === true,
        notice: typeof result?.notice === 'string' ? result.notice : null,
        error: typeof result?.error === 'string' ? result.error : null
      })
    } catch {
      return false
    }
  }

  function shot (filePath) {
    return new Promise((resolve) => {
      try {
        if (!ready || child === null) {
          resolve({ ok: false, error: 'not-ready' })
          return
        }
        if (typeof filePath !== 'string' || filePath === '') {
          resolve({ ok: false, error: 'bad-path' })
          return
        }
        if (pendingShot !== null) {
          resolve({ ok: false, error: 'busy' })
          return
        }
        const id = nextId()
        pendingShot = { id, resolve }
        if (!send({ type: 'shot', id, path: filePath })) {
          pendingShot = null
          resolve({ ok: false, error: 'send-failed' })
          return
        }
        shotTimer = setTimer(() => {
          if (pendingShot === null || pendingShot.id !== id) return
          pendingShot = null
          shotTimer = null
          resolve({ ok: false, error: 'timeout' })
        }, DESKTOP_SHOT_TIMEOUT_MS)
        shotTimer?.unref?.()
      } catch (error) {
        resolve({ ok: false, error: messageOf(error) })
      }
    })
  }

  function requestStatus () {
    return new Promise((resolve) => {
      try {
        if (child === null) {
          resolve({ ok: false, error: 'not-running' })
          return
        }
        if (pendingStatus !== null) {
          resolve({ ok: false, error: 'busy' })
          return
        }
        const id = nextId()
        pendingStatus = { id, resolve }
        if (!send({ type: 'status', id })) {
          pendingStatus = null
          resolve({ ok: false, error: 'send-failed' })
          return
        }
        statusTimer = setTimer(() => {
          if (pendingStatus === null || pendingStatus.id !== id) return
          pendingStatus = null
          statusTimer = null
          resolve({ ok: false, error: 'timeout' })
        }, DESKTOP_STATUS_TIMEOUT_MS)
        statusTimer?.unref?.()
      } catch (error) {
        resolve({ ok: false, error: messageOf(error) })
      }
    })
  }

  function status () {
    return {
      available: availability !== null && availability.ok === true,
      reason: availability === null ? 'not-started' : (availability.ok ? null : availability.reason),
      electronPath: availability !== null && availability.ok ? availability.path : null,
      helperPath: helperMain,
      candidates: availability !== null && Array.isArray(availability.candidates)
        ? availability.candidates.slice()
        : [],
      running: child !== null,
      pid: child?.pid ?? null,
      ready,
      restarts: policy.restarts,
      workArea,
      lastError,
      helperErrors,
      lastEvent,
      assetRoots: assetRoots.slice(),
      stderr: stderrLines.slice(),
      debug: debugLines.slice()
    }
  }

  function dispose () {
    if (disposed) return
    disposed = true
    if (restartTimer !== null) {
      clearTimer(restartTimer)
      restartTimer = null
    }
    if (pingTimer !== null) {
      clearInterval(pingTimer)
      pingTimer = null
    }
    settlePending('disposed')
    const target = child
    child = null
    ready = false
    if (target !== null) {
      // 先温柔地让它自己收窗（穿过 stdin 的 quit），再 SIGTERM，最后 1s 后 SIGKILL。
      try {
        if (target.stdin !== null && target.stdin !== undefined && target.stdin.destroyed !== true) {
          const line = shared.encodeMessage({ type: 'quit' })
          if (line !== null) target.stdin.write(line)
          target.stdin.end()
        }
      } catch {
        // 管道已经断了
      }
      try {
        target.kill('SIGTERM')
      } catch {
        // 已经退出了
      }
      const killTimer = setTimer(() => {
        try {
          if (target.exitCode === null && target.signalCode === null) target.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, 1000)
      killTimer?.unref?.()
    }
    removeExitHook()
  }

  return {
    start,
    update,
    resync,
    show,
    hide,
    actionResult,
    shot,
    requestStatus,
    status,
    dispose,
    get pid () {
      return child?.pid ?? null
    },
    get availability () {
      if (availability === null) availability = computeAvailability()
      return availability
    }
  }
}
