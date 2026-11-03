import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { MAX_NICKNAME } from '../src/protocol.js'
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

test('场景 v3 归一化：role/anim/reset/menu 保留，未知字段、未知 kind、重复 id、坏矩形全部丢弃', () => {
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
  assert.equal(scene.version, 3)
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

test('场景 v2 controls：置灰理由/召回/可送客/放行卡/notice 归一化，坏条目丢弃', () => {
  const deviceId = '33333333-3333-4333-8333-333333333333'
  const scene = shared.normalizeScene({
    items: [],
    controls: {
      visit: { enabled: false, reason: '  还没有人放行你  ' },
      recall: { enabled: true, nickname: '  阿蟹  ' },
      visitors: [
        { deviceId, label: '阿蟹' },
        { deviceId, label: '重复' },
        { deviceId: 'bad id', label: '坏 id' }
      ],
      prompt: { deviceId, nickname: '  泡泡  ' },
      notice: { text: '「阿蟹」没有回应，宠物先留在家里了。', at: 1234 }
    }
  })
  assert.deepEqual(scene.controls.visit, { enabled: false, reason: '还没有人放行你' })
  assert.deepEqual(scene.controls.recall, { enabled: true, nickname: '阿蟹' })
  assert.deepEqual(scene.controls.visitors, [{ deviceId, label: '阿蟹' }])
  assert.deepEqual(scene.controls.prompt, { deviceId, nickname: '泡泡' })
  assert.equal(scene.controls.notice.text, '「阿蟹」没有回应，宠物先留在家里了。')
  assert.equal(scene.controls.notice.at, 1234)

  // enabled 时不信任调用方给的 reason；null/坏形状回落成空控件。
  const enabled = shared.normalizeScene({
    items: [],
    controls: { visit: { enabled: true, reason: '不应该显示' }, notice: { text: 'x', at: Number.NaN } }
  })
  assert.deepEqual(enabled.controls.visit, { enabled: true, reason: null })
  assert.equal(enabled.controls.notice, null)
  assert.deepEqual(shared.normalizeScene({ items: [], controls: 'nope' }).controls, shared.emptyControls())
})

test('helper 动作：白名单 + id + deviceId 校验；坏动作/缺 id/缺 deviceId 整条丢弃', () => {
  const deviceId = '33333333-3333-4333-8333-333333333333'
  const visit = shared.normalizeHelperEvent({ type: 'action', id: 'act-1', action: 'visit' })
  assert.equal(visit.ok, true)
  assert.deepEqual(visit.event, { type: 'action', id: 'act-1', action: 'visit', deviceId: null, nickname: null })

  const end = shared.normalizeHelperEvent({ type: 'action', id: 'act-2', action: 'end-visit', deviceId })
  assert.equal(end.ok, true)
  assert.equal(end.event.deviceId, deviceId)

  // 改名是唯一带正文的动作：helper 只截长度，清洗与 32 码点截断交给宿主。
  const rename = shared.normalizeHelperEvent({
    type: 'action', id: 'act-6', action: 'rename', nickname: '  新 名字  '
  })
  assert.equal(rename.ok, true)
  assert.equal(rename.event.nickname, '  新 名字  ')
  assert.equal(rename.event.deviceId, null)
  const longName = shared.normalizeHelperEvent({
    type: 'action', id: 'act-7', action: 'rename', nickname: '喵'.repeat(100)
  })
  assert.equal(longName.event.nickname.length, shared.MAX_ACTION_TEXT)

  assert.equal(shared.normalizeHelperEvent({ type: 'action', id: 'act-3', action: 'quit' }).ok, false)
  assert.equal(shared.normalizeHelperEvent({ type: 'action', action: 'visit' }).ok, false)
  assert.equal(shared.normalizeHelperEvent({ type: 'action', id: 'act-4', action: 'admit' }).ok, false)
  assert.equal(shared.normalizeHelperEvent({ type: 'action', id: 'act-5', action: 'admit', deviceId: 'bad id' }).ok, false)
})

test('Windows 的 process.stdin 是空壳时才直接从 fd 0 读宿主输入', () => {
  // Windows + Electron GUI：没有控制台，stdin 一启动就 EOF（fd 是 undefined）→ 走 fd 0。
  assert.equal(shared.shouldReadStdinDirectly('win32', undefined), true)
  // 同上但 stdin 真的有 fd（控制台版 / 被正常 spawn）：保持 process.stdin，不改既有行为。
  assert.equal(shared.shouldReadStdinDirectly('win32', 0), false)
  // 其它平台永远用 process.stdin。
  assert.equal(shared.shouldReadStdinDirectly('darwin', undefined), false)
  assert.equal(shared.shouldReadStdinDirectly('linux', 0), false)
})

test('改名小窗的上限与线路上的昵称上限是同一个数', () => {
  // 显示得比广播长，就等于又造出两个名字（ADR-0007）；桌面侧不能自己悄悄改这个数。
  assert.equal(shared.MAX_NAME_LENGTH, MAX_NICKNAME)
})

test('宿主命令 action-result：id 必填，notice 截断到可显示长度', () => {
  const result = shared.normalizeHostCommand({
    type: 'action-result',
    id: 'act-1',
    ok: false,
    notice: '还没有人放行你，宠物出不了门。',
    error: 'no-admitted'
  })
  assert.equal(result.ok, true)
  assert.equal(result.command.ok, false)
  assert.equal(result.command.notice, '还没有人放行你，宠物出不了门。')
  assert.equal(result.command.error, 'no-admitted')
  assert.equal(shared.normalizeHostCommand({ type: 'action-result', ok: true }).ok, false)
  assert.equal(shared.normalizeHostCommand({ type: 'action-result', id: 7, ok: true }).ok, false, 'action-result 的 id 必须是字符串')

  const long = shared.normalizeHostCommand({
    type: 'action-result',
    id: 'act-2',
    ok: false,
    notice: '坏'.repeat(shared.MAX_NOTICE_LENGTH + 50)
  })
  assert.equal(long.command.notice.length, shared.MAX_NOTICE_LENGTH)
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
  assert.equal(shared.normalizeHostCommand({ type: 'debug-busy-max', ms: 700 }).command.ms, 700)
  assert.equal(shared.normalizeHostCommand({ type: 'debug-busy-max', ms: 0 }).command.ms, 0)
  assert.equal(shared.normalizeHostCommand({ type: 'debug-busy-max', ms: -1 }).ok, false)
  assert.equal(shared.normalizeHostCommand({ type: 'debug-busy-max', ms: 60001 }).ok, false)
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
    busy: true,
    busyHeldMs: 5000,
    busyBlocked: true,
    busyCapMs: 700,
    rendererRects: 2,
    overlayRects: 3,
    overlayRectsAgeMs: 12,
    visible: true,
    focused: false,
    bounds: { x: 0, y: 30, width: 1000, height: 700 },
    pointer: { x: 1, y: 2 }
  })
  assert.equal(status.event.status.ignoring, false)
  assert.equal(status.event.status.hoverFrozen, true)
  assert.equal(status.event.status.focused, false)
  assert.equal(status.event.status.busyBlocked, true)
  assert.equal(status.event.status.busyHeldMs, 5000)
  assert.equal(status.event.status.busyCapMs, 700)
  assert.equal(status.event.status.overlayRects, 3)
  assert.equal(status.event.status.overlayRectsAgeMs, 12)
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
  // Windows：dsh-pet 把 Electron 落在同一个 $DSH_HOME/electron，只是可执行文件叫 electron.exe。
  assert.deepEqual(candidateElectronPaths({ env: { DSH_HOME: '/tmp/dsh-home' }, platform: 'win32' }), [
    '/tmp/dsh-home/electron/electron.exe'
  ])
  assert.deepEqual(
    candidateElectronPaths({
      env: { DSH_HOME: '/tmp/dsh-home', LOCAL_PET_ELECTRON: 'C:\\electron\\electron.exe' },
      platform: 'win32'
    }),
    ['C:\\electron\\electron.exe', '/tmp/dsh-home/electron/electron.exe']
  )
})

test('Electron 解析：平台不符/文件缺失都降级，存在时取第一个候选', () => {
  const env = { DSH_HOME: '/tmp/dsh-home' }
  assert.equal(resolveElectronBinary({ env, platform: 'linux' }).reason, 'unsupported-platform')
  assert.equal(resolveElectronBinary({ env, platform: 'darwin', exists: () => false }).reason, 'electron-missing')
  // Windows 和 macOS 一样可用：候选是 $DSH_HOME/electron/electron.exe。
  const onWindows = resolveElectronBinary({
    env,
    platform: 'win32',
    exists: (candidate) => candidate === '/tmp/dsh-home/electron/electron.exe'
  })
  assert.equal(onWindows.ok, true)
  assert.equal(onWindows.path, '/tmp/dsh-home/electron/electron.exe')
  assert.equal(resolveElectronBinary({ env, platform: 'win32', exists: () => false }).reason, 'electron-missing')
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

test('manager：Windows 宿主照样起 helper（不再被 darwin-only 的闸门挡掉）', () => {
  const infos = []
  const warns = []
  const spawnCalls = []
  const manager = createDesktop({
    desktopHost: true,
    platform: 'win32',
    env: { DSH_HOME: '/tmp/dsh-home' },
    exists: (candidate) => candidate === '/tmp/dsh-home/electron/electron.exe',
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options })
      return fakeChild(2000)
    },
    log: { info: (line) => infos.push(line), warn: (line) => warns.push(line) },
    pingMs: 100000
  })
  const started = manager.start()
  assert.equal(started.ok, true)
  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0].command, '/tmp/dsh-home/electron/electron.exe')
  assert.equal(warns.length, 0)
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

test('manager：控件 action 事件透传给宿主，actionResult 把 ok/notice 原样写回 stdin', async (t) => {
  const clock = fakeClock()
  const children = []
  const events = []
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
    onEvent: (event) => events.push(event),
    pingMs: 100000
  })
  t.after(() => manager.dispose())
  manager.start()
  children[0].emitLine({ type: 'ready', pid: 3000, workArea: { x: 0, y: 30, width: 1000, height: 700 } })
  await new Promise((resolve) => setTimeout(resolve, 5))

  const deviceId = '33333333-3333-4333-8333-333333333333'
  children[0].emitLine({ type: 'action', id: 'act-7', action: 'end-visit', deviceId })
  const received = events.find((event) => event.type === 'action')
  assert.ok(received, 'manager 把渲染端的控件申请透传给宿主观察者')
  assert.equal(received.action, 'end-visit')
  assert.equal(received.deviceId, deviceId)

  assert.equal(manager.actionResult('act-7', { ok: false, notice: '这位客人已经不在桌面上了。', error: 'no-visitor' }), true)
  const result = children[0].parsedLines().at(-1)
  assert.equal(result.type, 'action-result')
  assert.equal(result.id, 'act-7')
  assert.equal(result.ok, false)
  assert.equal(result.notice, '这位客人已经不在桌面上了。')
  assert.equal(manager.actionResult('', { ok: true }), false, '空 id 不写管道')
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
  assert.equal(calls.updates[0].version, 3)
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

test('service：桌面控件申请走同一套 action 并回 action-result；失败一定带人话 notice', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-desktop-actions-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const updates = []
  const results = []
  let captured = null
  const factory = (options) => {
    captured = options
    return {
      start () { return { ok: true, pid: 9100 } },
      update (scene) { updates.push(scene); return true },
      resync (scene) { updates.push(scene); return true },
      actionResult (id, result) { results.push({ id, ...result }) },
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
  captured.onEvent({ type: 'ready', pid: 9100, workArea: { x: 0, y: 30, width: 1000, height: 700 } })
  await waitFor(() => updates.length > 0, 500)

  // 场景里已经带上了控件状态：没有可串门邻居 → 置灰 + 理由。
  assert.equal(updates.at(-1).controls.visit.enabled, false)
  assert.match(updates.at(-1).controls.visit.reason, /还没有人放行你/)

  // “召回”在家：走同一个 handleAction，失败 notice 原样回给 helper。
  captured.onEvent({ type: 'action', id: 'act-recall', action: 'recall', deviceId: null })
  await waitFor(() => results.some((result) => result.id === 'act-recall'), 1500)
  const recall = results.find((result) => result.id === 'act-recall')
  assert.equal(recall.ok, false)
  assert.match(recall.notice, /在家|不用召回/)

  // “串门”没有目标：失败也必须有可读提示，不能静默。
  captured.onEvent({ type: 'action', id: 'act-visit', action: 'visit', deviceId: null })
  await waitFor(() => results.some((result) => result.id === 'act-visit'), 1500)
  const visit = results.find((result) => result.id === 'act-visit')
  assert.equal(visit.ok, false)
  assert.match(visit.notice, /还没有人放行你/)
  assert.equal(visit.error, 'no-admitted')

  // 有客人时“送客”成功：action-result ok，场景立刻少一只，控件名单也清空。
  const guestId = '88888888-8888-4888-8888-888888888888'
  service.room.setTrust({ allowed: { [guestId]: { nickname: '阿蟹' } } })
  service.room.observeHeartbeat({ deviceId: guestId, anim: '螃蟹走路' })
  const replied = service.room.observeVisitRequest({
    deviceId: guestId,
    visitId: '99999999-9999-4999-8999-999999999999',
    nickname: '阿蟹',
    anim: '螃蟹走路'
  })
  assert.equal(replied.reply, 'ack')
  await waitFor(() => updates.at(-1).controls.visitors.length === 1, 1500)
  assert.equal(updates.at(-1).controls.visitors[0].deviceId, guestId)
  captured.onEvent({ type: 'action', id: 'act-end', action: 'end-visit', deviceId: guestId })
  await waitFor(() => results.some((result) => result.id === 'act-end'), 1500)
  const end = results.find((result) => result.id === 'act-end')
  assert.equal(end.ok, true)
  assert.equal(end.notice, null)
  await waitFor(() => updates.at(-1).items.every((item) => item.role !== 'visitor'), 1500)
  assert.deepEqual(updates.at(-1).controls.visitors, [])
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

test('LOCAL_PET_DESKTOP 是逃生开关：关闭后不启动 helper，服务照常', async (t) => {
  for (const value of ['0', 'false', 'off', 'NO']) {
    const dir = await mkdtemp(join(tmpdir(), 'lp-kill-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    let spawned = 0
    const { ctx } = fakeCtx()
    const service = createService(ctx, {
      network: false,
      petBridge: false,
      dataDir: dir,
      petConfigPath: join(dir, 'missing.jsonc'),
      env: { LOCAL_PET_DESKTOP: value },
      desktopFactory: () => { spawned += 1; return null }
    })
    await service.ready
    assert.equal(spawned, 0, value + ' 应该关掉桌面层')
    service.dispose()
  }
})

test('LOCAL_PET_DESKTOP 为空或其它值时仍然启动桌面层', async (t) => {
  for (const value of [undefined, '1', 'on']) {
    const dir = await mkdtemp(join(tmpdir(), 'lp-kill-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    let spawned = 0
    const { ctx } = fakeCtx()
    const service = createService(ctx, {
      network: false,
      petBridge: false,
      dataDir: dir,
      petConfigPath: join(dir, 'missing.jsonc'),
      env: value === undefined ? {} : { LOCAL_PET_DESKTOP: value },
      desktopFactory: () => { spawned += 1; return null }
    })
    await service.ready
    assert.equal(spawned, 1, JSON.stringify(value) + ' 不该关掉桌面层')
    service.dispose()
  }
})

// ---------------------------------------------------------------------------
// pong 看门狗（A4）
// ---------------------------------------------------------------------------

function tickingClock (start = 1_000_000) {
  let value = start
  const timers = []
  const intervals = []
  const make = (fn, ms) => ({ fn, ms, cleared: false, unref () {} })
  return {
    now: () => value,
    advance (ms) { value += ms },
    timers,
    intervals,
    setTimer (fn, ms) {
      const timer = make(fn, ms)
      timers.push(timer)
      return timer
    },
    clearTimer (timer) {
      if (timer) timer.cleared = true
    },
    setInterval (fn, ms) {
      const timer = make(fn, ms)
      intervals.push(timer)
      return timer
    },
    clearInterval (timer) {
      if (timer) timer.cleared = true
    },
    tickIntervals (ms) {
      for (const timer of intervals) {
        if (!timer.cleared && timer.ms === ms) timer.fn()
      }
    },
    runDue (ms) {
      const due = timers.find((timer) => !timer.cleared && timer.ms === ms)
      assert.ok(due, '应该有 ' + ms + 'ms 的定时器')
      due.cleared = true
      due.fn()
    }
  }
}

test('manager：pong 看门狗——超过 15s 没回 pong 杀掉并按现有退避重启（A4）', (t) => {
  const clock = tickingClock()
  const children = []
  const warns = []
  const manager = createDesktop({
    desktopHost: true,
    platform: 'darwin',
    exists: () => true,
    spawn: () => {
      const child = fakeChild(4000 + children.length)
      children.push(child)
      return child
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    pongTimeoutMs: 15000,
    watchdogTickMs: 1000,
    log: { info () {}, warn: (line) => warns.push(line) },
    pingMs: 100000
  })
  t.after(() => manager.dispose())

  assert.equal(manager.start().ok, true)
  // ready 之前 helper 还没开始读 stdin：冷启动再慢也不能算卡死。
  clock.advance(60000)
  clock.tickIntervals(1000)
  assert.deepEqual(children[0].killCalls, [], 'ready 之前不杀')

  children[0].emitLine({ type: 'ready', pid: 4000, workArea: { x: 0, y: 30, width: 1000, height: 700 } })
  // 正常的长 GC / 卡顿：12s 内回一包 pong，看门狗不误杀。
  clock.advance(12000)
  children[0].emitLine({ type: 'pong', id: 1 })
  clock.tickIntervals(1000)
  assert.deepEqual(children[0].killCalls, [], 'pong 新鲜时不杀')
  assert.equal(manager.status().pongAgeMs, 0)
  assert.equal(manager.status().pongTimeoutMs, 15000)

  // 从此不再回 pong：超过阈值就杀掉，然后走现有退避（默认 300ms）。
  clock.advance(16000)
  clock.tickIntervals(1000)
  assert.deepEqual(children[0].killCalls, ['SIGKILL'])
  assert.ok(warns.some((line) => /没有回 pong/.test(line)), '日志要说明为什么杀掉：' + warns.join(' / '))
  assert.equal(manager.status().running, false)
  clock.runDue(300)
  assert.equal(children.length, 2)
  assert.equal(manager.status().pid, 4001)

  // 新 helper 重新 ready 之后看门狗重新计时：不会拿着旧时间戳接着杀。
  children[1].emitLine({ type: 'ready', pid: 4001, workArea: { x: 0, y: 30, width: 1000, height: 700 } })
  clock.advance(1000)
  clock.tickIntervals(1000)
  assert.deepEqual(children[1].killCalls, [])
  // 只有一次杀掉：看门狗不会在进程退出的间隙里反复 kill。
  assert.equal(children[0].killCalls.length, 1)
})

// ---------------------------------------------------------------------------
// 场景上限与溢出提示（A5）
// ---------------------------------------------------------------------------

test('service：访客超出场景上限时不静默丢宠物，宿主给一条人话提示（A5）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-overflow-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const updates = []
  let captured = null
  const factory = (options) => {
    captured = options
    return {
      start () { return { ok: true, pid: 9200 } },
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
  captured.onEvent({ type: 'ready', pid: 9200, workArea: { x: 0, y: 30, width: 1000, height: 700 } })
  await waitFor(() => updates.length > 0, 500)

  // 一次来 30 位访客：超过 64 的旧上限，但在新的场景上限之内。
  const idAt = (index) => '88888888-8888-4888-8888-' + String(index).padStart(12, '0')
  const allowed = {}
  for (let index = 0; index < 30; index += 1) allowed[idAt(index)] = { nickname: '访客' + index }
  service.room.setTrust({ allowed })
  const visitId = '99999999-9999-4999-8999-999999999999'
  for (let index = 0; index < 30; index += 1) {
    const replied = service.room.observeVisitRequest({
      deviceId: idAt(index),
      visitId,
      nickname: '访客' + index,
      anim: null
    })
    assert.equal(replied.reply, 'ack')
  }
  await waitFor(() => (updates.at(-1).items.length === 31), 3000)
  assert.equal(updates.at(-1).controls.visitors.length, 30, '30 位访客都能被送客')
  assert.equal(updates.at(-1).controls.notice, null, '没有溢出就不该打扰用户')

  // 再来 30 位（共 60 位）：旧的 64 上限下会被静默丢掉，现在必须画出来。
  for (let index = 30; index < 60; index += 1) {
    allowed[idAt(index)] = { nickname: '访客' + index }
  }
  service.room.setTrust({ allowed })
  for (let index = 30; index < 60; index += 1) {
    service.room.observeVisitRequest({ deviceId: idAt(index), visitId, nickname: '访客' + index, anim: null })
  }
  await waitFor(() => updates.at(-1).items.length === 61, 3000)

  // 真的超过场景上限时：画出上限那么多，并给一条能读懂的提示（不是静默丢弃）。
  const overflow = shared.MAX_SCENE_ITEMS + 5
  for (let index = 60; index < overflow; index += 1) {
    allowed[idAt(index)] = { nickname: '访客' + index }
  }
  service.room.setTrust({ allowed })
  for (let index = 60; index < overflow; index += 1) {
    service.room.observeVisitRequest({ deviceId: idAt(index), visitId, nickname: '访客' + index, anim: null })
  }
  await waitFor(() => updates.at(-1).controls.notice !== null, 3000)
  const scene = updates.at(-1)
  assert.equal(scene.items.length, shared.MAX_SCENE_ITEMS)
  const missing = overflow - (shared.MAX_SCENE_ITEMS - 1)
  assert.match(scene.controls.notice.text, /放不下/)
  assert.match(scene.controls.notice.text, new RegExp(String(missing) + ' 位'))

  // 同一次拥挤只提醒一次，不会每 500ms 刷一条新 notice。
  const at = scene.controls.notice.at
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(updates.at(-1).controls.notice.at, at)
  assert.deepEqual(warnings, [])
})

test('normalizeControls：街上的房子去重、封顶十六、认不出的理由降级成“去不了”', () => {
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'

  const controls = shared.normalizeControls({
    street: [
      { deviceId: a, label: '老王', action: '改那个 bug', canVisit: true, blockedReason: null },
      { deviceId: a, label: '重复', canVisit: true },
      { deviceId: b, label: '秃头哥', action: '', canVisit: false, blockedReason: 'nonsense' },
      { deviceId: 'not an id', label: '坏' }
    ]
  })

  assert.deepEqual(controls.street, [
    { deviceId: a, label: '老王', action: '改那个 bug', canVisit: true, blockedReason: null },
    { deviceId: b, label: '秃头哥', action: null, canVisit: false, blockedReason: null }
  ])

  // 没有 street 的旧 scene：空街，不抛。
  assert.deepEqual(shared.normalizeControls({}).street, [])
  assert.deepEqual(shared.emptyControls().street, [])

  // 封顶：多出来的房子不塞进一条消息。
  const many = Array.from({ length: 20 }, (_, index) => ({
    deviceId: '33333333-3333-4333-8333-' + String(index).padStart(12, '0'),
    label: '邻居' + index,
    canVisit: true
  }))
  assert.equal(shared.normalizeControls({ street: many }).street.length, 16)
})

test('buildHelperArgs：默认不带 --no-sandbox，只有显式开关才关沙箱', () => {
  const base = { helperPath: '/tmp/helper.js', hostPid: 1 }
  const previous = process.env.LOCAL_PET_HELPER_NO_SANDBOX
  try {
    delete process.env.LOCAL_PET_HELPER_NO_SANDBOX
    assert.equal(buildHelperArgs(base).includes('--no-sandbox'), false)
    process.env.LOCAL_PET_HELPER_NO_SANDBOX = '1'
    assert.equal(buildHelperArgs(base).includes('--no-sandbox'), true)
  } finally {
    if (previous === undefined) delete process.env.LOCAL_PET_HELPER_NO_SANDBOX
    else process.env.LOCAL_PET_HELPER_NO_SANDBOX = previous
  }
})

test('manager：reload 杀掉 helper 后立刻重建，不计崩溃、不占退避（ticket 22）', async (t) => {
  const clock = fakeClock()
  const children = []
  const infos = []
  const manager = createDesktop({
    desktopHost: true,
    platform: 'darwin',
    exists: () => true,
    spawn: () => {
      const child = fakeChild(4000 + children.length)
      children.push(child)
      return child
    },
    maxRestarts: 1,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: { info: (line) => infos.push(line), warn: () => {} },
    pingMs: 100000
  })
  t.after(() => manager.dispose())

  manager.start()
  children[0].emitLine({ type: 'ready', pid: 4000, workArea: { x: 0, y: 30, width: 100, height: 100 } })

  const reloadResult = manager.reload()
  assert.equal(reloadResult.ok, true, JSON.stringify(reloadResult))
  assert.ok(children[0].killCalls.includes('SIGTERM'), '重载 = 让 helper 退出，由退出事件重建')
  children[0].emit('exit', 0, 'SIGTERM')
  clock.runDue(0)
  assert.equal(children.length, 2, '手动重载立刻重建，不排队等退避')
  assert.equal(manager.status().restarts, 0, '手动重载不算崩溃')

  // 之后真的崩了，仍然按第一次退避（300ms），不是"已连续崩溃 2 次"
  children[1].emitLine({ type: 'ready', pid: 4001, workArea: { x: 0, y: 30, width: 100, height: 100 } })
  children[1].emit('exit', 1, null)
  clock.runDue(300)
  assert.equal(children.length, 3)
  assert.equal(manager.status().restarts, 1)
})

test('manager：openUrl 只把 http(s) 地址写进管道，坏地址不写', async (t) => {
  const clock = fakeClock()
  const children = []
  const manager = createDesktop({
    desktopHost: true,
    platform: 'darwin',
    exists: () => true,
    spawn: () => {
      const child = fakeChild(4200 + children.length)
      children.push(child)
      return child
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: { info: () => {}, warn: () => {} },
    pingMs: 100000,
    assetRoots: []
  })
  t.after(() => manager.dispose())
  manager.start()
  children[0].emitLine({ type: 'ready', pid: 4200, workArea: { x: 0, y: 30, width: 100, height: 100 } })

  assert.equal(manager.openUrl('http://127.0.0.1:64071/'), true)
  assert.deepEqual(children[0].parsedLines().at(-1), {
    type: 'open-url',
    id: null,
    url: 'http://127.0.0.1:64071/'
  })

  // file:/javascript: 这类地址在 shared 的命令白名单处就被丢掉，写不进管道
  assert.equal(manager.openUrl('file:///etc/passwd'), false)
  assert.equal(children[0].parsedLines().at(-1).type, 'open-url')
})

// ---------------------------------------------------------------------------
// ticket 23：礼物卡的四道白名单
// ---------------------------------------------------------------------------

test('normalizeNoteText：保留换行、去控制字符与双向覆盖符，按码点截到 500', () => {
  assert.equal(
    shared.normalizeNoteText('  第一行\r\n第二行\t\u0000\n\n第三行  '),
    '第一行\n第二行\n\n第三行'
  )
  assert.equal(shared.normalizeNoteText('正常\u202e文字'), '正常文字')
  assert.equal(shared.normalizeNoteText('   '), null)
  assert.equal(shared.normalizeNoteText(null), null)
  const long = '喵'.repeat(shared.MAX_GIFT_TEXT_LENGTH + 20)
  assert.equal(Array.from(shared.normalizeNoteText(long)).length, shared.MAX_GIFT_TEXT_LENGTH)
  assert.equal(shared.MAX_GIFT_TEXT_LENGTH, 500, '与 src/protocol.js 的 MAX_GIFT_TEXT 同一个数')
})

test('场景 controls.gifts：只认字条 + 已知状态 + UUID，正文只在 received 时保留', () => {
  const deviceId = '33333333-3333-4333-8333-333333333333'
  const giftId = '55555555-5555-4555-8555-555555555555'
  const scene = shared.normalizeScene({
    items: [],
    controls: {
      gifts: [
        {
          deviceId,
          giftId,
          kind: 'text',
          status: 'received',
          title: '  「阿蟹」捎来一张字条  ',
          text: '  第一行\r\n第二行  ',
          statusText: '不该出现'
        },
        { deviceId, giftId, kind: 'text', status: 'pending', title: '重复', text: '重复' },
        { deviceId: 'bad id', giftId, kind: 'text', status: 'received', title: 'x' },
        { deviceId, giftId: 'gift-1', kind: 'text', status: 'received', title: 'x' },
        { deviceId, giftId: '66666666-6666-4666-8666-666666666666', kind: 'file', status: 'received', title: 'x' },
        { deviceId, giftId: '77777777-7777-4777-8777-777777777777', kind: 'text', status: 'lost', title: 'x' },
        null,
        'nope'
      ]
    }
  })
  assert.deepEqual(scene.controls.gifts, [{
    deviceId,
    giftId,
    kind: 'text',
    status: 'received',
    title: '「阿蟹」捎来一张字条',
    text: '第一行\n第二行'
  }])

  // 非 received 时正文不画；状态行保留，标题缺省有一句兜底。
  const pending = shared.normalizeScene({
    items: [],
    controls: {
      gifts: [{
        deviceId,
        giftId,
        kind: 'text',
        status: 'pending',
        title: '',
        text: '还没写完',
        statusText: '  刚到，正在收下…  '
      }]
    }
  }).controls.gifts
  assert.deepEqual(pending, [{
    deviceId,
    giftId,
    kind: 'text',
    status: 'pending',
    title: '捎来一件东西',
    statusText: '刚到，正在收下…'
  }])
  assert.deepEqual(shared.emptyControls().gifts, [])
})

test('helper 动作：礼物四动作必须带 giftId；别的动作带上也会被丢掉', () => {
  const giftId = '55555555-5555-4555-8555-555555555555'
  for (const action of shared.GIFT_ACTIONS) {
    const ok = shared.normalizeHelperEvent({ type: 'action', id: 'act-1', action, giftId })
    assert.equal(ok.ok, true, action)
    assert.equal(ok.event.giftId, giftId)
    assert.equal(ok.event.deviceId, null)
    assert.equal(shared.normalizeHelperEvent({ type: 'action', id: 'act-1', action }).ok, false, action + ' 缺 giftId')
    assert.equal(
      shared.normalizeHelperEvent({ type: 'action', id: 'act-1', action, giftId: 'not a uuid' }).ok,
      false,
      action + ' 坏 giftId'
    )
  }
  // visit 不是礼物动作：即便坏字段也直接丢掉，不影响事件本身。
  const visit = shared.normalizeHelperEvent({ type: 'action', id: 'act-2', action: 'visit', giftId })
  assert.equal(visit.ok, true)
  assert.equal('giftId' in visit.event, false)
})

test('宿主命令：gift-open/reveal/discard 只收绝对路径；gift-copy 只收清洗后的字条', () => {
  for (const type of ['gift-open', 'gift-reveal', 'gift-discard']) {
    const ok = shared.normalizeHostCommand({ type, id: 'cmd-1', path: '/Users/me/.dsh/gifts/20261103-153245-ab12cd12/note.txt' })
    assert.equal(ok.ok, true, type)
    assert.deepEqual(ok.command, {
      type,
      id: 'cmd-1',
      path: '/Users/me/.dsh/gifts/20261103-153245-ab12cd12/note.txt'
    })
    assert.equal(shared.normalizeHostCommand({ type, path: 'relative/note.txt' }).ok, false, type)
    assert.equal(shared.normalizeHostCommand({ type }).ok, false, type)
  }
  const copy = shared.normalizeHostCommand({ type: 'gift-copy', id: 'cmd-2', text: ' 第一行\r\n第二行 ' })
  assert.equal(copy.ok, true)
  assert.deepEqual(copy.command, { type: 'gift-copy', id: 'cmd-2', text: '第一行\n第二行' })
  assert.equal(shared.normalizeHostCommand({ type: 'gift-copy', text: '   ' }).ok, false)
  assert.equal(shared.normalizeHostCommand({ type: 'gift-copy', text: 42 }).ok, false)
})

test('manager：gift-open/reveal/discard 只写绝对路径，gift-copy 只写清洗后的正文', async (t) => {
  const clock = fakeClock()
  const children = []
  const manager = createDesktop({
    desktopHost: true,
    platform: 'darwin',
    exists: () => true,
    spawn: () => {
      const child = fakeChild(4300 + children.length)
      children.push(child)
      return child
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: { info: () => {}, warn: () => {} },
    pingMs: 100000,
    assetRoots: []
  })
  t.after(() => manager.dispose())
  manager.start()
  children[0].emitLine({ type: 'ready', pid: 4300, workArea: { x: 0, y: 30, width: 100, height: 100 } })
  const notePath = '/Users/me/.dsh/local-pet/gifts/20261103-153245-ab12cd12/note.txt'

  assert.equal(manager.giftOpen(notePath), true)
  assert.deepEqual(children[0].parsedLines().at(-1), { type: 'gift-open', id: null, path: notePath })
  assert.equal(manager.giftReveal(notePath), true)
  assert.deepEqual(children[0].parsedLines().at(-1), { type: 'gift-reveal', id: null, path: notePath })
  assert.equal(manager.giftDiscard('/Users/me/.dsh/local-pet/gifts/20261103-153245-ab12cd12'), true)
  assert.equal(children[0].parsedLines().at(-1).type, 'gift-discard')
  assert.equal(manager.giftCopy('第一行\r\n第二行'), true)
  assert.deepEqual(children[0].parsedLines().at(-1), { type: 'gift-copy', id: null, text: '第一行\n第二行' })

  // 相对路径 / 空正文在白名单处就被丢掉，写不进管道。
  assert.equal(manager.giftOpen('relative/note.txt'), false)
  assert.equal(manager.giftCopy('   '), false)
  assert.equal(children[0].parsedLines().at(-1).type, 'gift-copy')
})

// ---------------------------------------------------------------------------
// ticket 24：背包小窗的桥与宿主命令
// ---------------------------------------------------------------------------

test('normalizeBringGift：字条 ≤500 保留换行；文件只认绝对路径；多出的字段丢掉', () => {
  assert.deepEqual(shared.normalizeBringGift({ kind: 'text', text: '  第一行\r\n第二行  ' }), {
    kind: 'text',
    text: '第一行\n第二行'
  })
  assert.deepEqual(shared.normalizeBringGift({ kind: 'file', path: '/Users/me/a.pdf', text: 'x' }), {
    kind: 'file',
    path: '/Users/me/a.pdf'
  })
  assert.equal(shared.normalizeBringGift({ kind: 'text', text: '字'.repeat(501) }), null)
  assert.equal(shared.normalizeBringGift({ kind: 'text', text: '  ' }), null)
  assert.equal(shared.normalizeBringGift({ kind: 'file', path: 'relative.pdf' }), null)
  assert.equal(shared.normalizeBringGift({ pick: true }), null)
  assert.equal(shared.normalizeBringGift(null), null)
})

test('bring-window：窗口只拿 id/kind/文案/state，路径与多余物品都被丢掉', () => {
  const id = '55555555-5555-4555-8555-555555555555'
  const command = shared.normalizeHostCommand({
    type: 'bring-window',
    open: true,
    items: [
      { id, kind: 'text', text: ' 第一行\r\n第二行 ', state: 'idle', path: '/tmp/secret' },
      { id, kind: 'file', name: '../报价单.pdf', state: 'out', path: '/tmp/secret' },
      { id: 'not-a-uuid', kind: 'text', text: '坏' },
      { id, kind: 'movie', text: '坏' }
    ]
  })
  assert.equal(command.ok, true)
  assert.deepEqual(command.command.items, [
    { id, kind: 'text', text: '第一行\n第二行', state: 'idle' },
    { id, kind: 'file', name: '../报价单.pdf', state: 'out' }
  ])
  assert.equal('path' in command.command.items[0], false)
  assert.equal(command.command.open, true)
  assert.equal(command.command.count, 2)
  assert.equal(command.command.maxItems, shared.MAX_BACKPACK_ITEMS)
  assert.equal(command.command.maxTextLength, shared.MAX_GIFT_TEXT_LENGTH)
  assert.equal(command.command.maxFileBytes, shared.MAX_GIFT_FILE_BYTES)

  // open:false = 只刷新；缺省是 false。
  assert.equal(shared.normalizeHostCommand({ type: 'bring-window', items: [] }).command.open, false)
  // 超过两件只留前两件（上限由 shared 自己定，不信宿主）。
  const capped = shared.normalizeHostCommand({
    type: 'bring-window',
    items: Array.from({ length: 5 }, (_, index) => ({
      id: '6666666' + String(index) + '-6666-4666-8666-666666666666',
      kind: 'text',
      text: '第' + index
    }))
  }).command
  assert.equal(capped.items.length, shared.MAX_BACKPACK_ITEMS)
})

test('helper 动作：bring 可带物品也可空手（开窗）；unbring 必须带 giftId', () => {
  const gift = shared.normalizeHelperEvent({
    type: 'action',
    id: 'act-bring',
    action: 'bring',
    gift: { kind: 'text', text: '带去的东西' }
  })
  assert.equal(gift.ok, true)
  assert.deepEqual(gift.event.gift, { kind: 'text', text: '带去的东西' })
  assert.equal('giftId' in gift.event, false)

  // 右键菜单的 bring 没有物品：这是“开窗”申请，不能被当成坏礼物。
  const empty = shared.normalizeHelperEvent({ type: 'action', id: 'act-open', action: 'bring' })
  assert.equal(empty.ok, true)
  assert.equal('gift' in empty.event, false)

  assert.deepEqual(shared.normalizeHelperEvent({
    type: 'action',
    id: 'act-bad',
    action: 'bring',
    gift: { kind: 'file', path: 'relative.pdf' }
  }), { ok: false, error: 'bad-gift' })

  const unbring = shared.normalizeHelperEvent({
    type: 'action',
    id: 'act-unbring',
    action: 'unbring',
    giftId: '77777777-7777-4777-8777-777777777777'
  })
  assert.equal(unbring.ok, true)
  assert.equal(unbring.event.giftId, '77777777-7777-4777-8777-777777777777')
  assert.equal(shared.normalizeHelperEvent({ type: 'action', id: 'act-unbring', action: 'unbring' }).ok, false)

  // 新动作都进了帮助侧白名单：渲染端菜单/小窗才发得出来。
  assert.equal(shared.DESKTOP_ACTIONS.includes('bring'), true)
  assert.equal(shared.DESKTOP_ACTIONS.includes('unbring'), true)
  assert.equal(shared.MENU_TOOL_IDS.includes('bring'), true)
})

test('status 白名单放行 bringOpen：冒烟能等到「带派」小窗真的打开', () => {
  const status = shared.normalizeHelperEvent({
    type: 'status',
    id: 'status-1',
    bringOpen: true,
    renameOpen: false,
    ignored: 'x'
  })
  assert.equal(status.ok, true)
  assert.equal(status.event.status.bringOpen, true)
  assert.equal(status.event.status.renameOpen, false)
  assert.equal('ignored' in status.event.status, false)
})

test('manager：bringWindow 把背包快照写进管道，路径不在命令里', async (t) => {
  const clock = fakeClock()
  const children = []
  const manager = createDesktop({
    desktopHost: true,
    platform: 'darwin',
    exists: () => true,
    spawn: () => {
      const child = fakeChild(4400 + children.length)
      children.push(child)
      return child
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: { info: () => {}, warn: () => {} },
    pingMs: 100000,
    assetRoots: []
  })
  t.after(() => manager.dispose())
  manager.start()
  children[0].emitLine({ type: 'ready', pid: 4400, workArea: { x: 0, y: 30, width: 100, height: 100 } })

  const id = '88888888-8888-4888-8888-888888888888'
  assert.equal(manager.bringWindow({
    open: true,
    items: [{ id, kind: 'text', text: '一条字条', state: 'idle' }]
  }), true)
  const command = children[0].parsedLines().at(-1)
  assert.equal(command.type, 'bring-window')
  assert.equal(command.open, true)
  assert.deepEqual(command.items, [{ id, kind: 'text', text: '一条字条', state: 'idle' }])
  assert.equal(command.maxItems, shared.MAX_BACKPACK_ITEMS)

  assert.equal(manager.bringWindow({ open: false, items: [] }), true)
  assert.equal(children[0].parsedLines().at(-1).open, false)
})
