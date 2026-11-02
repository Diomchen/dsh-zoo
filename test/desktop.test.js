import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { createDesktop, HELPER_MAIN } from '../src/desktop.js'
import {
  DESKTOP_MAX_RESTARTS,
  DESKTOP_RESTART_BASE_MS,
  DESKTOP_RESTART_MAX_MS,
  DESKTOP_STABLE_MS,
  buildHelperArgs,
  candidateElectronPaths,
  createRestartPolicy,
  describeUnavailable,
  helperEnv,
  isDesktopHost,
  resolveElectronBinary
} from '../src/desktop-launch.js'
import { createService } from '../src/service.js'

// ---------------------------------------------------------------------------
// stdio 行协议
// ---------------------------------------------------------------------------

test('行解析：跨 chunk 拼接、单 chunk 多行、CRLF、空行都按一行一条', () => {
  const parser = shared.createLineParser({ maxLineLength: 64 })
  assert.deepEqual(parser.push('{"a":1}\n{"b":'), [{ type: 'line', line: '{"a":1}' }])
  assert.deepEqual(parser.push('2}\r\n'), [{ type: 'line', line: '{"b":2}' }])
  assert.deepEqual(parser.push('\n'), [{ type: 'line', line: '' }])
  assert.equal(parser.pending(), 0)
})

test('行解析：超长行只报一次 oversize，丢弃到换行后恢复，不影响下一行', () => {
  const parser = shared.createLineParser({ maxLineLength: 10 })
  assert.deepEqual(parser.push('x'.repeat(11)), [{ type: 'oversize' }])
  assert.deepEqual(parser.push('tail-of-long-line\n{"z":1}\n'), [{ type: 'line', line: '{"z":1}' }])

  const withNewline = shared.createLineParser({ maxLineLength: 10 })
  assert.deepEqual(withNewline.push('y'.repeat(30) + '\n{"ok":1}\n'), [
    { type: 'oversize' },
    { type: 'line', line: '{"ok":1}' }
  ])

  // 超长行没有换行、而且不停地来：内存不能无限增长
  const flood = shared.createLineParser({ maxLineLength: 10 })
  assert.deepEqual(flood.push('z'.repeat(1000)), [{ type: 'oversize' }])
  assert.deepEqual(flood.push('z'.repeat(100000)), [])
  assert.equal(flood.pending(), 0)
  assert.deepEqual(flood.push('\n{"a":1}\n'), [{ type: 'line', line: '{"a":1}' }])
})

test('encodeMessage/parseLine：只接受对象，超长拒发，坏 JSON 不抛', () => {
  assert.equal(shared.encodeMessage({ type: 'ping' }), '{"type":"ping"}\n')
  assert.equal(shared.encodeMessage(null), null)
  assert.equal(shared.encodeMessage({ type: 'x'.repeat(shared.MAX_LINE_LENGTH) }), null)
  assert.deepEqual(shared.parseLine('{"a":1}'), { ok: true, value: { a: 1 } })
  assert.equal(shared.parseLine('').ok, false)
  assert.equal(shared.parseLine('[]').ok, false)
  assert.equal(shared.parseLine('not json').ok, false)
})

// ---------------------------------------------------------------------------
// 场景 / 协议归一化
// ---------------------------------------------------------------------------

test('场景 v2 归一化：role/anim/reset 保留，未知字段、未知 kind、重复 id、坏矩形全部丢弃', () => {
  const scene = shared.normalizeScene({
    version: 99,
    reset: true,
    extra: 'ignored',
    items: [
      {
        id: 'a', kind: 'pet', role: 'self', anim: '东张西望',
        x: 10, y: 20, width: 30, height: 40, label: 'A', color: '#ABCDEF', junk: true
      },
      { id: 'a', kind: 'pet', x: 0, y: 0, width: 10, height: 10 },
      { id: 'b', kind: 'placeholder', x: 0, y: 0, width: 10, height: 10 },
      { id: 'c', kind: 'pet', x: 0, y: 0, width: 0, height: 10 },
      { id: 'bad id', kind: 'pet', x: 0, y: 0, width: 10, height: 10 },
      { id: 'd', kind: 'card', x: 1, y: 2, width: 3, height: 4, color: 'red' },
      { id: 'e', kind: 'pet', role: 'nobody', anim: '../evil', x: 0, y: 0, width: 10, height: 10 },
      null,
      'nope'
    ]
  })
  assert.equal(scene.version, 2)
  assert.equal(scene.reset, true)
  assert.deepEqual(scene.items.map((item) => item.id), ['a', 'd', 'e'])
  assert.equal(scene.items[0].color, '#abcdef')
  assert.equal(scene.items[0].label, 'A')
  assert.equal(scene.items[0].role, 'self')
  assert.equal(scene.items[0].anim, '东张西望')
  assert.equal(scene.items[1].role, null)
  assert.equal(scene.items[1].color, shared.DEFAULT_COLOR)
  assert.equal(scene.items[2].role, null, '未知 role 归 null')
  assert.equal(scene.items[2].anim, null, '夹斜杠的动画名丢弃')

  const many = { items: [] }
  for (let index = 0; index < shared.MAX_SCENE_ITEMS + 20; index += 1) {
    many.items.push({ id: 'i' + index, kind: 'pet', x: 0, y: 0, width: 10, height: 10 })
  }
  assert.equal(shared.normalizeScene(many).items.length, shared.MAX_SCENE_ITEMS)
})

test('宿主命令：update/show/hide/quit/ping/shot/pointer 白名单，未知与坏字段拒绝', () => {
  assert.equal(shared.normalizeHostCommand({ type: 'show' }).command.type, 'show')
  assert.equal(shared.normalizeHostCommand({ type: 'quit' }).command.type, 'quit')
  assert.equal(shared.normalizeHostCommand({ type: 'ping', id: 7 }).command.id, 7)
  assert.equal(shared.normalizeHostCommand({ type: 'nope' }).ok, false)
  assert.equal(shared.normalizeHostCommand(null).ok, false)
  assert.equal(shared.normalizeHostCommand({ type: 'shot', path: 'relative/path.png' }).ok, false)
  assert.equal(shared.normalizeHostCommand({ type: 'shot', path: '/tmp/a.png' }).command.path, '/tmp/a.png')
  assert.equal(shared.normalizeHostCommand({ type: 'pointer', x: 1, y: 2 }).command.point.x, 1)
  assert.deepEqual(shared.normalizeHostCommand({ type: 'pointer', clear: true }).command.point, null)
  assert.equal(shared.normalizeHostCommand({ type: 'pointer', x: Number.NaN, y: 2 }).ok, false)
  assert.equal(shared.normalizeHostCommand({ type: 'debug-freeze-hover', frozen: true }).command.frozen, true)
  assert.equal(shared.normalizeHostCommand({ type: 'debug-freeze-busy', frozen: true }).command.frozen, true)
  assert.equal(shared.normalizeHostCommand({ type: 'debug-renderer' }).command.type, 'debug-renderer')
  assert.equal(
    shared.normalizeHostCommand({ type: 'debug-dispatch', phase: 'down', x: 5, y: 6 }).command.phase,
    'down'
  )
  assert.equal(
    shared.normalizeHostCommand({ type: 'debug-dispatch', phase: 'blur', x: 5, y: 6 }).command.phase,
    'blur'
  )
  assert.equal(shared.normalizeHostCommand({ type: 'debug-dispatch', phase: 'sideways', x: 5, y: 6 }).ok, false)
  assert.equal(shared.normalizeHostCommand({ type: 'debug-lock-input', locked: false }).command.locked, false)
  assert.equal(
    shared.normalizeHostCommand({ type: 'debug-input', action: 'down', x: 5, y: 6 }).command.action,
    'down'
  )
  assert.equal(shared.normalizeHostCommand({ type: 'debug-input', action: 'nope', x: 5, y: 6 }).ok, false)

  const update = shared.normalizeHostCommand({
    type: 'update',
    scene: { items: [{ id: 'x', kind: 'pet', x: 1, y: 2, width: 3, height: 4 }] }
  })
  assert.equal(update.ok, true)
  assert.equal(update.command.scene.items[0].id, 'x')
  assert.equal(shared.normalizeHostCommand({ type: 'update', scene: 'nope' }).ok, false)
})

test('helper 事件：ready/hit/shot/error/status 归一化，长错误消息不被标签长度截断', () => {
  const ready = shared.normalizeHelperEvent({
    type: 'ready',
    pid: 123,
    workArea: { x: 0, y: 30, width: 1000, height: 700 },
    displays: [
      { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 720 }, workArea: { x: 0, y: 30, width: 1000, height: 690 }, scaleFactor: 2, primary: true }
    ],
    debug: true
  })
  assert.equal(ready.ok, true)
  assert.equal(ready.event.pid, 123)
  assert.equal(ready.event.workArea.y, 30)
  assert.equal(ready.event.displays[0].primary, true)
  assert.equal(shared.normalizeHelperEvent({ type: 'ready' }).ok, false)

  const hit = shared.normalizeHelperEvent({
    type: 'hit',
    inside: true,
    interactive: true,
    point: { x: 10, y: 20 },
    rect: { x: 5, y: 15, width: 30, height: 30 },
    reason: 'hovering'
  })
  assert.equal(hit.event.inside, true)
  assert.equal(hit.event.rect.width, 30)

  const longMessage = 'x'.repeat(900)
  const error = shared.normalizeHelperEvent({ type: 'error', code: 'boom', message: longMessage })
  assert.equal(error.event.message.length, shared.MAX_ERROR_LENGTH)

  const status = shared.normalizeHelperEvent({
    type: 'status',
    ignoring: false,
    sceneItems: 2,
    hoverInside: true,
    hoverFrozen: true,
    visible: true,
    focused: false,
    bounds: { x: 0, y: 30, width: 1000, height: 700 },
    pointer: { x: 1, y: 2 }
  })
  assert.equal(status.event.status.ignoring, false)
  assert.equal(status.event.status.hoverFrozen, true)
  assert.equal(status.event.status.focused, false)
  assert.equal(shared.normalizeHelperEvent({ type: 'unknown' }).ok, false)
})

// ---------------------------------------------------------------------------
// 命中判定与点击穿透裁定
// ---------------------------------------------------------------------------

test('命中数学：右/下边界排他、场景后画的优先、屏幕坐标换算、并集', () => {
  const rect = { x: 10, y: 20, width: 30, height: 40 }
  assert.equal(shared.rectContains(rect, { x: 10, y: 20 }), true)
  assert.equal(shared.rectContains(rect, { x: 39.999, y: 59.999 }), true)
  assert.equal(shared.rectContains(rect, { x: 40, y: 30 }), false)
  assert.equal(shared.rectContains(rect, { x: 20, y: 60 }), false)

  const scene = shared.normalizeScene({
    items: [
      { id: 'under', kind: 'pet', x: 0, y: 0, width: 100, height: 100 },
      { id: 'over', kind: 'pet', x: 10, y: 10, width: 20, height: 20 }
    ]
  })
  assert.equal(shared.hitTestScene(scene, { x: 15, y: 15 }).id, 'over')
  assert.equal(shared.hitTestScene(scene, { x: 50, y: 50 }).id, 'under')
  assert.equal(shared.hitTestScene(scene, { x: 101, y: 50 }), null)

  assert.deepEqual(shared.toLocalPoint({ x: 110, y: 220 }, { x: 100, y: 200, width: 50, height: 50 }), { x: 10, y: 20 })
  assert.equal(shared.toLocalPoint({ x: 1, y: 2 }, null), null)
  assert.deepEqual(shared.unionRect([{ x: 10, y: 10, width: 10, height: 10 }, { x: 30, y: 40, width: 5, height: 5 }]), {
    x: 10,
    y: 10,
    width: 25,
    height: 35
  })
})

test('穿透裁定：光标不在命中区永远是穿透；渲染端确认要新鲜；没确认时按停留兜底', () => {
  const scene = shared.normalizeScene({
    items: [{ id: 'p', kind: 'pet', x: 100, y: 100, width: 50, height: 50 }]
  })
  const inside = { x: 110, y: 110 }
  const outside = { x: 10, y: 10 }
  const now = 10000

  assert.equal(shared.shouldBeInteractive({ scene: shared.emptyScene(), point: inside, lastHoverAt: now, now }).reason, 'no-scene')
  assert.deepEqual(
    shared.shouldBeInteractive({ scene, point: outside, lastHoverAt: now, now }),
    { interactive: false, reason: 'outside' }
  )
  assert.deepEqual(
    shared.shouldBeInteractive({ scene, point: inside, lastHoverAt: now - 100, now }),
    { interactive: true, reason: 'hovering' }
  )
  // 渲染端说在命中区，但主进程看到的光标在外面：以主进程为准
  assert.deepEqual(
    shared.shouldBeInteractive({ scene, point: outside, lastHoverAt: now, insideSince: now - 5000, now }),
    { interactive: false, reason: 'outside' }
  )
  // 渲染端确认过期、停留也不够：继续穿透
  assert.deepEqual(
    shared.shouldBeInteractive({ scene, point: inside, lastHoverAt: now - 5000, insideSince: now - 100, now }),
    { interactive: false, reason: 'stale-renderer-confirmation' }
  )
  // 渲染端完全没消息（macOS 后台收不到 forward 事件）：停留满兜底时长后接管
  assert.deepEqual(
    shared.shouldBeInteractive({ scene, point: inside, lastHoverAt: 0, insideSince: now - 100, now }),
    { interactive: false, reason: 'waiting-for-confirmation' }
  )
  assert.deepEqual(
    shared.shouldBeInteractive({ scene, point: inside, lastHoverAt: 0, insideSince: now - shared.MAIN_FALLBACK_DWELL_MS - 1, now }),
    { interactive: true, reason: 'main-fallback' }
  )
  // 兜底可以关掉（测试/更保守的将来）
  assert.equal(
    shared.shouldBeInteractive({
      scene,
      point: inside,
      lastHoverAt: 0,
      insideSince: now - 1000,
      allowMainFallback: false,
      now
    }).interactive,
    false
  )
})

// ---------------------------------------------------------------------------
// spawn 决策 / 退避
// ---------------------------------------------------------------------------

test('桌面判定：只有 Electron 里的 Node 算桌面宿主；候选路径来自 DSH_HOME', () => {
  assert.equal(isDesktopHost({ electron: '43.3.0' }), true)
  assert.equal(isDesktopHost({ node: '24.18.1' }), false)
  assert.equal(isDesktopHost({ electron: '' }), false)
  assert.equal(isDesktopHost(undefined), false)

  const candidates = candidateElectronPaths({ env: { DSH_HOME: '/tmp/dsh-home', LOCAL_PET_ELECTRON: '/opt/e' }, platform: 'darwin' })
  assert.deepEqual(candidates, [
    '/opt/e',
    '/tmp/dsh-home/electron/Electron.app/Contents/MacOS/Electron'
  ])
  assert.deepEqual(candidateElectronPaths({ env: { DSH_HOME: '/tmp/dsh-home' }, platform: 'linux' }), [])
})

test('Electron 解析：平台不符/文件缺失都降级，存在时取第一个候选', () => {
  const env = { DSH_HOME: '/tmp/dsh-home' }
  assert.equal(resolveElectronBinary({ env, platform: 'linux' }).reason, 'unsupported-platform')
  assert.equal(resolveElectronBinary({ env, platform: 'darwin', exists: () => false }).reason, 'electron-missing')
  const resolved = resolveElectronBinary({
    env: { ...env, LOCAL_PET_ELECTRON: '/opt/custom-electron' },
    platform: 'darwin',
    exists: (candidate) => candidate === '/opt/custom-electron'
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.path, '/opt/custom-electron')
  assert.match(describeUnavailable({ ok: false, reason: 'not-desktop-host' }), /桌面层跳过/)
  assert.match(describeUnavailable({ ok: false, reason: 'electron-missing', candidates: ['/nope'] }), /\/nope/)
})

test('spawn 参数与环境：删掉 ELECTRON_RUN_AS_NODE，参数用 --local-pet- 前缀', () => {
  const base = { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' }
  const env = helperEnv(base, 4321)
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
  assert.equal(env.KEEP, 'yes')
  assert.equal(env.LOCAL_PET_HOST_PID, '4321')
  assert.equal(base.ELECTRON_RUN_AS_NODE, '1')

  const args = buildHelperArgs({ helperPath: '/p/desktop/main.js', hostPid: 99, debug: true })
  assert.deepEqual(args, [
    '/p/desktop/main.js',
    '--local-pet-host-pid',
    '99',
    '--local-pet-debug'
  ])
  assert.deepEqual(buildHelperArgs({ helperPath: '/p/main.js' }), ['/p/main.js'])
})

test('重启策略：指数退避、上限、稳定后清零、N 次后放弃', () => {
  const policy = createRestartPolicy({ now: () => 0 })
  policy.onStart(0)
  const delays = []
  for (let attempt = 1; attempt <= DESKTOP_MAX_RESTARTS; attempt += 1) {
    const decision = policy.onExit(100)
    assert.equal(decision.action, 'restart')
    assert.equal(decision.restarts, attempt)
    delays.push(decision.delayMs)
  }
  assert.deepEqual(delays, [300, 600, 1200, 2400, 4800])
  const givenUp = policy.onExit(100)
  assert.equal(givenUp.action, 'give-up')
  assert.equal(givenUp.restarts, DESKTOP_MAX_RESTARTS + 1)

  const stable = createRestartPolicy({ now: () => 0 })
  stable.onStart(0)
  assert.equal(stable.onExit(100).delayMs, DESKTOP_RESTART_BASE_MS)
  assert.equal(stable.onExit(DESKTOP_STABLE_MS + 100).delayMs, DESKTOP_RESTART_BASE_MS)
  assert.equal(stable.restarts, 1)

  const none = createRestartPolicy({ maxRestarts: 0 })
  none.onStart(0)
  assert.equal(none.onExit(1).action, 'give-up')

  const capped = createRestartPolicy({ baseDelayMs: 5000, maxDelayMs: 6000 })
  capped.onStart(0)
  assert.equal(capped.onExit(1).delayMs, 5000)
  assert.equal(capped.onExit(1).delayMs, 6000)
})

// ---------------------------------------------------------------------------
// 宿主侧 manager（注入假 spawn，不碰 Electron）
// ---------------------------------------------------------------------------

function fakeChild (pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.killCalls = []
  child.lines = []
  child.stdin.on('data', (chunk) => child.lines.push(String(chunk)))
  child.kill = (signal) => {
    child.killCalls.push(signal ?? 'SIGTERM')
    if (child.exitCode === null) {
      child.exitCode = 0
      child.signalCode = signal ?? null
      child.emit('exit', 0, signal ?? null)
    }
    return true
  }
  child.emitLine = (event) => {
    child.stdout.emit('data', JSON.stringify(event) + '\n')
  }
  child.parsedLines = () => child.lines.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return child
}

function fakeClock () {
  const timers = []
  return {
    timers,
    now: () => 1000,
    setTimer (fn, ms) {
      const timer = { fn, ms, cleared: false, unref () {} }
      timers.push(timer)
      return timer
    },
    clearTimer (timer) {
      if (timer) timer.cleared = true
    },
    runDue (ms) {
      const due = timers.find((timer) => !timer.cleared && timer.ms === ms)
      assert.ok(due, '应该有 ' + ms + 'ms 的定时器')
      due.cleared = true
      due.fn()
    }
  }
}

test('manager：不可用时只打一行日志、不 spawn、start 不抛', () => {
  const infos = []
  const warns = []
  let spawned = 0
  const manager = createDesktop({
    desktopHost: false,
    log: { info: (line) => infos.push(line), warn: (line) => warns.push(line) },
    spawn: () => { spawned += 1; return fakeChild(1) }
  })
  const result = manager.start()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-desktop-host')
  assert.equal(spawned, 0)
  assert.equal(infos.length, 1)
  assert.equal(warns.length, 0)
  assert.equal(manager.start().ok, false)
  assert.equal(infos.length, 1, '重复 start 不能重复打日志')
  manager.dispose()
})

test('manager：spawn 参数正确、ready 后补场景、update/shot/status 走 stdio', async (t) => {
  const clock = fakeClock()
  const children = []
  const spawnCalls = []
  let shotId = 0
  const manager = createDesktop({
    desktopHost: true,
    platform: 'darwin',
    env: { DSH_HOME: '/tmp/dsh-home', ELECTRON_RUN_AS_NODE: '1', LOCAL_PET_ELECTRON: '/opt/electron' },
    exists: (candidate) => candidate === '/opt/electron',
    spawn: (command, args, options) => {
      const child = fakeChild(1000 + children.length)
      children.push(child)
      spawnCalls.push({ command, args, options })
      return child
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onEvent: (event) => {
      if (event.type === 'status') shotId = event.id
    },
    pingMs: 100000
  })
  t.after(() => manager.dispose())

  const started = manager.start()
  assert.equal(started.ok, true)
  assert.equal(started.pid, 1000)
  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0].command, '/opt/electron')
  assert.deepEqual(spawnCalls[0].args, [HELPER_MAIN, '--local-pet-host-pid', String(process.pid)])
  assert.equal('ELECTRON_RUN_AS_NODE' in spawnCalls[0].options.env, false)
  assert.equal(spawnCalls[0].options.stdio[0], 'pipe')

  const scene = shared.petScene([
    { id: 'self', role: 'self', label: '小蓝', anim: '东张西望', color: shared.PET_COLORS[0] }
  ], { x: 0, y: 30, width: 1000, height: 700 })
  assert.equal(manager.update(scene), false, 'ready 之前只记场景，不写管道')
  children[0].emitLine({
    type: 'ready',
    pid: 1000,
    workArea: { x: 0, y: 30, width: 1000, height: 700 }
  })
  assert.equal(manager.status().ready, true)
  assert.equal(manager.status().workArea.height, 700)
  await new Promise((resolve) => setTimeout(resolve, 5))
  const afterReady = children[0].parsedLines()
  assert.equal(afterReady.at(-1).type, 'update')
  assert.equal(afterReady.at(-1).scene.items[0].id, 'self')
  assert.equal(afterReady.at(-1).scene.reset, false, 'ready 补发场景不重置现场位置')

  assert.equal(manager.update(scene), true)
  children[0].emitLine({ type: 'hit', inside: true, interactive: true, point: { x: 1, y: 2 }, rect: scene.items[0] })
  const statusPromise = manager.requestStatus()
  const statusCommand = children[0].parsedLines().at(-1)
  assert.equal(statusCommand.type, 'status')
  assert.ok(shotId === 0)
  children[0].emitLine({
    type: 'status',
    id: statusCommand.id,
    ignoring: false,
    sceneItems: 1,
    visible: true,
    bounds: { x: 0, y: 30, width: 1000, height: 700 }
  })
  const status = await statusPromise
  assert.equal(status.ok, true)
  assert.equal(status.status.ignoring, false)

  const shotPromise = manager.shot('/tmp/lp-shot-test.png')
  const shotCommand = children[0].parsedLines().at(-1)
  assert.equal(shotCommand.type, 'shot')
  assert.equal(shotCommand.path, '/tmp/lp-shot-test.png')
  children[0].emitLine({ type: 'shot', id: shotCommand.id, path: '/tmp/lp-shot-test.png', width: 2000, height: 1400, bytes: 10 })
  const shot = await shotPromise
  assert.equal(shot.ok, true)
  assert.equal(shot.width, 2000)
})

test('manager：崩溃退避重启、N 次后熔断、dispose 先 quit 再 kill', async (t) => {
  const clock = fakeClock()
  const children = []
  const warns = []
  const infos = []
  const manager = createDesktop({
    desktopHost: true,
    platform: 'darwin',
    exists: () => true,
    spawn: () => {
      const child = fakeChild(2000 + children.length)
      children.push(child)
      return child
    },
    maxRestarts: 2,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: { info: (line) => infos.push(line), warn: (line) => warns.push(line) },
    pingMs: 100000
  })
  t.after(() => manager.dispose())

  assert.equal(manager.start().ok, true)
  children[0].emitLine({ type: 'ready', pid: 2000, workArea: { x: 0, y: 30, width: 100, height: 100 } })

  children[0].emit('exit', 1, null)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /退出/)
  assert.match(warns[0], /300ms 后重启/)
  assert.equal(manager.status().running, false)

  clock.runDue(300)
  assert.equal(children.length, 2)
  assert.equal(manager.status().pid, 2001)
  children[1].emitLine({ type: 'ready', pid: 2001, workArea: { x: 0, y: 30, width: 100, height: 100 } })

  children[1].emit('exit', 1, null)
  assert.match(warns[1], /600ms 后重启/)
  clock.runDue(600)
  assert.equal(children.length, 3)

  children[2].emit('exit', 137, 'SIGKILL')
  assert.match(warns[2], /已连续崩溃 3 次/)
  assert.match(warns[2], /不再显示宠物/)
  assert.equal(manager.status().restarts, 3)
  assert.equal(clock.timers.filter((timer) => !timer.cleared).length, 0, '熔断后不应再挂重启定时器')

  manager.dispose()
  assert.equal(manager.status().running, false)
  assert.deepEqual(children[2].killCalls, [], '已经崩掉的子进程不该再被 kill')
})

test('manager：dispose 对在跑的 helper 先 quit 再 SIGTERM，并结束 stdin', () => {
  const clock = fakeClock()
  const children = []
  const manager = createDesktop({
    desktopHost: true,
    platform: 'darwin',
    exists: () => true,
    spawn: () => {
      const child = fakeChild(2500 + children.length)
      children.push(child)
      return child
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: { info: () => {}, warn: () => {} },
    pingMs: 100000
  })
  manager.start()
  children[0].emitLine({ type: 'ready', pid: 2500, workArea: { x: 0, y: 30, width: 100, height: 100 } })
  manager.dispose()
  assert.equal(manager.status().running, false)
  assert.ok(children[0].killCalls.includes('SIGTERM'))
  assert.equal(children[0].parsedLines().at(-1).type, 'quit')
  assert.equal(children[0].stdin.writableEnded, true)
  // dispose 之后即使子进程再报 ready 也不该复活
  children[0].emitLine({ type: 'ready', pid: 2500, workArea: { x: 0, y: 30, width: 100, height: 100 } })
  assert.equal(manager.status().ready, false)
})

test('manager：spawn 同步抛错只记录一行并退避，绝不抛出', () => {
  const clock = fakeClock()
  const warns = []
  let calls = 0
  const manager = createDesktop({
    desktopHost: true,
    platform: 'darwin',
    exists: () => true,
    spawn: () => {
      calls += 1
      throw new Error('EACCES')
    },
    maxRestarts: 1,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: { info: () => {}, warn: (line) => warns.push(line) },
    pingMs: 100000
  })
  const result = manager.start()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'spawn-failed')
  assert.equal(calls, 1)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /EACCES/)
  assert.ok(clock.timers.some((timer) => !timer.cleared && timer.ms === 300))
  manager.dispose()
})

test('manager：helper 报错事件有上限地记日志，异常观察者不影响协议', () => {
  const clock = fakeClock()
  const children = []
  const warns = []
  const manager = createDesktop({
    desktopHost: true,
    platform: 'darwin',
    exists: () => true,
    spawn: () => {
      const child = fakeChild(3000 + children.length)
      children.push(child)
      return child
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: { info: () => {}, warn: (line) => warns.push(line) },
    onEvent: () => { throw new Error('observer boom') },
    pingMs: 100000
  })
  manager.start()
  for (let index = 0; index < 7; index += 1) {
    children[0].emitLine({ type: 'error', code: 'boom', message: 'm' + index })
  }
  assert.equal(warns.length, 5)
  manager.dispose()
})

// ---------------------------------------------------------------------------
// service 接线（假 desktop 工厂）
// ---------------------------------------------------------------------------

function fakeCtx () {
  const warnings = []
  const infos = []
  return {
    ctx: {
      webServer: { register: () => () => {} },
      logger: {
        info: (line) => infos.push(line),
        warn: (line) => warnings.push(line)
      }
    },
    warnings,
    infos
  }
}

test('service：桌面层启动、ready 时下发占位场景、dispose 收掉；desktop:false 完全不碰', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-desktop-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const calls = { start: 0, dispose: 0, updates: [], resync: 0 }
  let captured = null
  const factory = (options) => {
    captured = options
    return {
      start () { calls.start += 1; return { ok: true, pid: 4242 } },
      update (scene) { calls.updates.push(scene); return true },
      resync (scene) { calls.resync += 1; calls.updates.push(scene); return true },
      dispose () { calls.dispose += 1 }
    }
  }
  const { ctx, warnings } = fakeCtx()
  const service = createService(ctx, {
    network: false,
    petBridge: false,
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: factory,
    desktopSyncMs: 10000
  })
  t.after(() => service.dispose())
  await service.ready
  assert.equal(calls.start, 1)
  assert.ok(captured)
  captured.onEvent({ type: 'ready', pid: 4242, workArea: { x: 0, y: 30, width: 1000, height: 700 } })
  assert.equal(calls.updates.length, 1)
  assert.equal(calls.resync, 1, '新 helper（pid 第一次出现）走强制整包对账')
  assert.equal(calls.updates[0].version, 2)
  assert.equal(calls.updates[0].reset, true)
  assert.equal(calls.updates[0].items[0].id, 'self')
  assert.equal(calls.updates[0].items[0].role, 'self')
  assert.deepEqual(calls.updates[0].items[0].anim, null)
  // 同一个 helper 的第二次 ready（显示器变化）保留现场位置，不再 reset
  captured.onEvent({ type: 'ready', pid: 4242, workArea: { x: 0, y: 30, width: 1000, height: 700 } })
  assert.equal(calls.resync, 1)
  assert.equal(calls.updates.at(-1).reset, false)
  assert.deepEqual(warnings, [])
  service.dispose()
  assert.equal(calls.dispose, 1)

  let factoryCalls = 0
  const { ctx: ctx2 } = fakeCtx()
  const service2 = createService(ctx2, {
    network: false,
    petBridge: false,
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktop: false,
    desktopFactory: () => { factoryCalls += 1; throw new Error('must not be called') }
  })
  t.after(() => service2.dispose())
  await service2.ready
  assert.equal(factoryCalls, 0)
})

test('service：桌面工厂抛错只降级成一行告警，服务照常 ready', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-desktop-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { ctx, warnings } = fakeCtx()
  const service = createService(ctx, {
    network: false,
    petBridge: false,
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: () => { throw new Error('factory boom') }
  })
  t.after(() => service.dispose())
  await service.ready
  assert.ok(warnings.some((line) => /桌面层初始化失败/.test(line)))
  assert.ok(service.snapshot().self.deviceId)
})

test('service：桌面场景跟着 snapshot 走（串门访客出现/换动作无需逐帧 update）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-desktop-sync-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const updates = []
  let captured = null
  const factory = (options) => {
    captured = options
    return {
      start () { return { ok: true, pid: 9001 } },
      update (scene) { updates.push(scene); return true },
      resync (scene) { updates.push(scene); return true },
      dispose () {}
    }
  }
  const { ctx, warnings } = fakeCtx()
  const service = createService(ctx, {
    network: false,
    petBridge: false,
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: factory,
    desktopSyncMs: 20
  })
  t.after(() => service.dispose())
  await service.ready
  captured.onEvent({ type: 'ready', pid: 9001, workArea: { x: 0, y: 30, width: 1000, height: 700 } })
  assert.equal(updates.at(-1).items.length, 1)
  assert.equal(updates.at(-1).items[0].id, 'self')

  const guestId = '66666666-6666-4666-8666-666666666666'
  const visitId = '77777777-7777-4777-8777-777777777777'
  service.room.setTrust({ allowed: { [guestId]: { nickname: '阿蟹' } } })

  // 心跳影子代表“邻居在线”，不是客人：桌面上不应该因此多一只。
  service.room.observeHeartbeat({ deviceId: guestId, anim: '螃蟹走路' })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(updates.at(-1).items.length, 1)

  // 真正的串门请求才会把客人画到桌面上。
  const replied = service.room.observeVisitRequest({
    deviceId: guestId,
    visitId,
    nickname: '阿蟹',
    anim: '螃蟹走路'
  })
  assert.equal(replied.reply, 'ack')
  await waitFor(() => updates.some((scene) => scene.items.some((item) => item.role === 'visitor')), 1500)
  const withVisitor = updates.at(-1)
  const visitor = withVisitor.items.find((item) => item.role === 'visitor')
  assert.ok(visitor)
  assert.equal(visitor.label, '阿蟹')
  assert.equal(visitor.anim, '螃蟹走路')
  assert.equal(visitor.id, 'visitor:' + guestId)

  service.room.observeHeartbeat({ deviceId: guestId, anim: '东张西望' })
  await waitFor(() => updates.at(-1).items.some((item) => item.role === 'visitor' && item.anim === '东张西望'), 1500)
  assert.deepEqual(warnings, [])
})

async function waitFor (predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待超时')
}
