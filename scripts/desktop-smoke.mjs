#!/usr/bin/env node
/**
 * 桌面 helper 的真机冒烟（只在 macOS + 本机有 Electron 时有意义；不进 npm test）。
 *
 * 覆盖 ticket 07 的每一条验收：
 *   1. 透明窗口 + 占位方块：--local-pet-shot 走 capturePage，落 PNG + 同名 .json；
 *      这里用 zlib 自己解 PNG，断言背景 alpha=0、方块中心是 #3b74d8、方块外是透明的。
 *   2. 点击穿透：
 *      - 渲染端路径：debug-move 合成 mousemove → 渲染端命中 → IPC → setIgnoreMouseEvents(false)，
 *        hit 事件的 reason 必须是 'hovering'；
 *      - 兜底路径：只改主进程光标（forward 钩子失效的模拟），停留 300ms 后 reason='main-fallback'；
 *      - 反向：光标移出命中区 → 100ms 内恢复穿透（reason='outside'）；
 *      - 渲染端失效：debug-freeze-hover 后 1.2s 内必须恢复穿透；
 *      - 主进程否决：渲染端心跳说 inside，但真实光标在命中区外 → 必须穿透。
 *   3. 生命周期：quit / SIGKILL / 宿主被 SIGKILL 三种情况都不留进程。
 *   4. 宿主 manager：ready、update、shot、崩溃后重启一次、dispose 后进程消失。
 * 只依赖 node:zlib，不装任何包。
 *
 * 用法：npm run smoke:desktop
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'

import shared from '../desktop/shared.js'
import { createDesktop, HELPER_MAIN } from '../src/desktop.js'
import { buildHelperArgs, helperEnv, resolveElectronBinary } from '../src/desktop-launch.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT_DIR = join(tmpdir(), 'dsh-local-pet-desktop-smoke-' + process.pid)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const spawned = []
let checks = 0

function pass (message) {
  checks += 1
  console.log('  ok  ' + message)
}

function info (message) {
  console.log('      ' + message)
}

async function run (name, fn) {
  console.log('\n# ' + name)
  const started = Date.now()
  const result = await fn()
  console.log('  (' + ((Date.now() - started) / 1000).toFixed(1) + 's)')
  return result
}

function assert (condition, message) {
  if (!condition) throw new Error('断言失败：' + message)
  pass(message)
}

// ---------------------------------------------------------------------------
// 极简 PNG 解码（8-bit RGB/RGBA，非隔行）——为了不依赖任何 npm 包
// ---------------------------------------------------------------------------

function decodePng (buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('不是 PNG')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error('不支持的 PNG：bitDepth=' + bitDepth + ' colorType=' + colorType + ' interlace=' + interlace)
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(height * stride)
  let previous = Buffer.alloc(stride)
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]
    const line = raw.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride)
    const current = Buffer.alloc(stride)
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? current[index - channels] : 0
      const up = previous[index]
      const upperLeft = index >= channels ? previous[index - channels] : 0
      let value = line[index]
      if (filter === 1) value = (value + left) & 0xff
      else if (filter === 2) value = (value + up) & 0xff
      else if (filter === 3) value = (value + Math.floor((left + up) / 2)) & 0xff
      else if (filter === 4) {
        const p = left + up - upperLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upperLeft)
        const predictor = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upperLeft)
        value = (value + predictor) & 0xff
      } else if (filter !== 0) {
        throw new Error('未知 PNG filter ' + filter)
      }
      current[index] = value
    }
    current.copy(out, row * stride)
    previous = current
  }
  return { width, height, channels, data: out }
}

function pixelAt (image, x, y) {
  const index = (y * image.width + x) * image.channels
  return [
    image.data[index],
    image.data[index + 1],
    image.data[index + 2],
    image.channels === 4 ? image.data[index + 3] : 255
  ]
}

function countTransparent (image) {
  let transparent = 0
  if (image.channels !== 4) return 0
  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index] === 0) transparent += 1
  }
  return transparent
}

function verifyShot (pngPath, sidecarPath) {
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'))
  const image = decodePng(readFileSync(pngPath))
  const item = sidecar.scene.items[0]
  const scaleX = image.width / sidecar.bounds.width
  const scaleY = image.height / sidecar.bounds.height
  const toPixel = (localX, localY) => [
    Math.round((sidecar.bounds.x + localX) * scaleX),
    Math.round((sidecar.bounds.y + localY) * scaleY)
  ]
  assert(sidecar.bounds.width === sidecar.workArea.width && sidecar.bounds.height === sidecar.workArea.height,
    '窗口铺满工作区：' + sidecar.bounds.width + '×' + sidecar.bounds.height)
  assert(image.width >= sidecar.bounds.width && image.width / sidecar.bounds.width === scaleX,
    '截图像素与逻辑坐标同尺度（scale=' + scaleX + '）')

  const corner = pixelAt(image, 2, 2)
  assert(corner[3] === 0, '窗口背景是透明的（左上角 alpha=0）')
  const target = pixelAt(image, ...toPixel(item.x + item.width / 2, item.y + item.height / 2))
  // capturePage 会按 Skia 的显示色彩配置做一次转换：RGB 各差几个数值是正常的，只做容差比较。
  const nearBlue = Math.abs(target[0] - 0x3b) <= 24 && Math.abs(target[1] - 0x74) <= 24 && Math.abs(target[2] - 0xd8) <= 24
  assert(nearBlue && target[3] === 255,
    '占位方块中心是 #3b74d8 蓝色且不透明（实际 ' + target.join(',') + '）')
  const outside = pixelAt(image, ...toPixel(item.x - 20, item.y - 20))
  assert(outside[3] === 0, '方块外 20px 处是透明的')
  const transparent = countTransparent(image)
  const total = image.width * image.height
  assert(transparent / total > 0.9, '整张图 >90% 像素透明（' + ((transparent / total) * 100).toFixed(2) + '%）')
  return { image, sidecar, item }
}

// ---------------------------------------------------------------------------
// 直接 stdio 客户端：验证 helper 本身
// ---------------------------------------------------------------------------

function createHelperClient (log) {
  const resolved = resolveElectronBinary({})
  assert(resolved.ok, '找到 Electron：' + resolved.path)
  const child = spawn(resolved.path, buildHelperArgs({ helperPath: HELPER_MAIN, hostPid: process.pid, debug: true }), {
    cwd: ROOT,
    env: helperEnv(process.env, process.pid),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  spawned.push(child)
  const events = []
  const stderr = []
  const parser = shared.createLineParser()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    for (const entry of parser.push(chunk)) {
      if (entry.type === 'oversize') continue
      if (entry.type !== 'line' || entry.line.trim() === '') continue
      const parsed = shared.parseLine(entry.line)
      if (!parsed.ok) {
        log('非 JSON stdout：' + entry.line.slice(0, 200))
        continue
      }
      const normalized = shared.normalizeHelperEvent(parsed.value)
      if (!normalized.ok) {
        log('非法事件：' + normalized.error + ' ' + entry.line.slice(0, 200))
        continue
      }
      events.push(normalized.event)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    const line = String(chunk).trim()
    if (line !== '') {
      stderr.push(line)
      log('helper stderr: ' + line.slice(0, 240))
    }
  })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))

  const send = (command) => child.stdin.write(JSON.stringify(command) + '\n')
  const mark = () => events.length
  const waitFrom = async (start, predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (let index = start; index < events.length; index += 1) {
        if (predicate(events[index])) return events[index]
      }
      await sleep(25)
    }
    throw new Error('等待超时：' + label)
  }
  const status = async () => {
    const start = mark()
    send({ type: 'status', id: 'smoke-' + Date.now() })
    const event = await waitFrom(start, (candidate) => candidate.type === 'status', 3000, 'status')
    return event.status
  }
  return { child, events, send, mark, waitFrom, status, exited, stderr }
}

async function verifyHelper () {
  const client = createHelperClient((line) => info(line))
  const readyMark = client.mark()
  const ready = await client.waitFrom(readyMark, (event) => event.type === 'ready', 15000, 'ready')
  assert(ready.pid === client.child.pid, 'ready.pid 就是 helper 进程（' + ready.pid + '）')
  assert(ready.workArea.width > 0 && ready.workArea.height > 0, 'ready 上报主屏工作区 ' + ready.workArea.width + '×' + ready.workArea.height)
  assert(Array.isArray(ready.displays) && ready.displays.length >= 1, 'ready 上报显示器列表')
  assert(ready.debug === true && ready.shotMode === false, 'debug 模式已生效')

  const scene = shared.placeholderScene(ready.workArea)
  const item = scene.items[0]
  client.send({ type: 'update', scene })
  await sleep(500)
  let current = await client.status()
  assert(current.sceneItems === 1, 'stdin 的 update 命令被接受（sceneItems=1）')
  assert(current.ignoring === true, '窗口默认点击穿透（ignoring=true）')
  assert(current.visible === true, '窗口已显示')
  assert(current.focused === false, '窗口不抢焦点（focused=false）')
  assert(current.focusable === false, '窗口不可聚焦（focusable=false）')
  assert(current.alwaysOnTop === true, '窗口置顶（alwaysOnTop=true）')
  assert(current.allWorkspaces === true, '窗口显示在所有工作区（allWorkspaces=true）')
  assert(current.bounds.width === ready.workArea.width && current.bounds.height === ready.workArea.height,
    '窗口尺寸等于工作区，不越界')

  const center = {
    x: ready.workArea.x + item.x + item.width / 2,
    y: ready.workArea.y + item.y + item.height / 2
  }
  const outside = { x: ready.workArea.x + 8, y: ready.workArea.y + 8 }

  // 渲染端路径：合成 mousemove → 渲染端命中 → IPC → 主进程复核
  let start = client.mark()
  client.send({ type: 'debug-move', x: center.x, y: center.y })
  const entered = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '进入命中区')
  assert(entered.inside === true && entered.reason === 'hovering', '光标进命中区 → 渲染端路径接管鼠标（reason=hovering）')
  assert(entered.rect !== null && entered.rect.x === ready.workArea.x + item.x, 'hit 事件上报屏幕坐标的命中矩形')
  current = await client.status()
  assert(current.ignoring === false, '主进程真的调用了 setIgnoreMouseEvents(false)')

  // ticket 08 会逐帧 update：同样的场景重复下发不能把交互闪断
  client.send({ type: 'update', scene })
  await sleep(250)
  current = await client.status()
  assert(current.ignoring === false, '逐帧 update 不打断已接管状态（场景更新按新场景复核）')

  // 场景把方块挪走：即使渲染端还没重新确认，主进程也必须立刻恢复穿透
  const movedScene = shared.normalizeScene({
    items: [{ ...scene.items[0], x: scene.items[0].x - 500 }]
  })
  start = client.mark()
  client.send({ type: 'update', scene: movedScene })
  const moved = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === false, 2000, '场景移走命中区')
  assert(moved.reason === 'outside', '方块移走后穿透（真实光标已不在新场景命中区）')
  client.send({ type: 'update', scene })
  await sleep(300)

  // 移出：恢复穿透
  start = client.mark()
  client.send({ type: 'debug-move', x: outside.x, y: outside.y })
  const left = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === false, 3000, '离开命中区')
  assert(left.reason === 'outside', '光标离开 → 恢复穿透（reason=outside）')
  current = await client.status()
  assert(current.ignoring === true, '主进程真的恢复了 setIgnoreMouseEvents(true)')

  // 兜底路径：只改主进程看到的光标，不产生任何渲染端事件（模拟 macOS 收不到 forward）
  start = client.mark()
  client.send({ type: 'pointer', x: center.x, y: center.y })
  const fallback = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '兜底接管')
  assert(fallback.reason === 'main-fallback', '渲染端无消息时，停留 300ms 由主进程兜底接管')
  current = await client.status()
  assert(typeof current.insideForMs === 'number' && current.insideForMs >= 250, '兜底计时来自主进程真实光标，而非渲染端上报')

  // 兜底接管后先离开，让状态回到穿透（setIgnore 只在状态翻转时发事件）
  start = client.mark()
  client.send({ type: 'pointer', x: outside.x, y: outside.y })
  await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === false, 3000, '兜底后离开')
  assert((await client.status()).ignoring === true, '兜底接管后移出命中区也恢复穿透')

  // 主进程否决：渲染端还在心跳 inside，但真实光标在命中区外 → 必须穿透
  start = client.mark()
  client.send({ type: 'debug-move', x: center.x, y: center.y })
  await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '再次进入')
  start = client.mark()
  client.send({ type: 'pointer', x: outside.x, y: outside.y })
  const vetoed = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === false, 2000, '主进程否决')
  assert(vetoed.reason === 'outside', '渲染端说 inside 也不能否决「真实光标在外面」')

  // 渲染端失效：心跳停止后必须恢复穿透，且兜底不得在冻结状态下重新接管
  start = client.mark()
  client.send({ type: 'debug-move', x: center.x, y: center.y })
  await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '再次进入 2')
  start = client.mark()
  client.send({ type: 'debug-freeze-hover', frozen: true })
  const frozen = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === false, 2500, '冻结后恢复穿透')
  assert(['no-renderer-confirmation', 'stale-renderer-confirmation', 'waiting-for-confirmation'].includes(frozen.reason),
    '渲染端停止确认 → 恢复穿透（reason=' + frozen.reason + '）')
  await sleep(1200)
  current = await client.status()
  assert(current.ignoring === true, '冻结 1.2s 后仍是穿透（兜底不会在渲染端失效时重新接管）')

  // 截图：透明 + 占位方块位置
  mkdirSync(OUT_DIR, { recursive: true })
  const pngPath = join(OUT_DIR, 'helper.png')
  start = client.mark()
  client.send({ type: 'shot', id: 'shot-1', path: pngPath })
  const shot = await client.waitFrom(start, (event) => event.type === 'shot', 8000, 'shot')
  assert(existsSync(pngPath), 'shot 落盘：' + pngPath)
  assert(shot.width > 0 && shot.height > 0, 'shot 返回像素尺寸 ' + shot.width + '×' + shot.height)
  const verified = verifyShot(pngPath, pngPath + '.json')
  info('占位方块：' + JSON.stringify({ scene: verified.item, pointer: verified.sidecar.pointer }))

  // quit：进程自己退出
  const exitPromise = client.exited
  client.send({ type: 'quit' })
  const exit = await Promise.race([exitPromise, sleep(4000).then(() => null)])
  assert(exit !== null, 'quit 命令让 helper 自己退出')
  assert(exit.code === 0 || exit.code === null, 'quit 退出码正常（' + JSON.stringify(exit) + '）')
  return { pngPath, sidecarPath: pngPath + '.json' }
}

// ---------------------------------------------------------------------------
// manager：宿主侧生命周期
// ---------------------------------------------------------------------------

function pidAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil (predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(50)
  }
  throw new Error('等待超时：' + label)
}

async function verifyManager () {
  const infos = []
  const warns = []
  const manager = createDesktop({
    desktopHost: true,
    platform: 'darwin',
    debug: true,
    log: { info: (line) => { infos.push(line); info(line) }, warn: (line) => { warns.push(line); info(line) } }
  })
  try {
    const started = manager.start()
    assert(started.ok === true, 'manager 启动 helper（pid ' + started.pid + '）')
    await waitUntil(() => manager.status().ready, 15000, 'manager ready')
    const workArea = manager.status().workArea
    assert(workArea.width > 0, 'manager 收到 ready 工作区')
    const scene = shared.placeholderScene(workArea)
    assert(manager.update(scene) === true, 'manager 把场景写进 stdin')
    await sleep(400)
    const status = await manager.requestStatus()
    assert(status.ok === true && status.status.sceneItems === 1, 'helper 应用了场景（sceneItems=1）')
    const pngPath = join(OUT_DIR, 'manager.png')
    const shot = await manager.shot(pngPath)
    assert(shot.ok === true && existsSync(pngPath), 'manager 的 shot 命令落盘' + '（' + shot.width + '×' + shot.height + '）')
    verifyShot(pngPath, pngPath + '.json')

    const firstPid = manager.pid
    process.kill(firstPid, 'SIGKILL')
    await waitUntil(() => manager.status().pid !== null && manager.status().pid !== firstPid, 8000, '崩溃后重启')
    assert(warns.some((line) => /退出/.test(line) && /重启/.test(line)), '宿主为 helper 崩溃打了一行日志')
    assert(manager.status().restarts === 1, '重启计数 = 1')
    await waitUntil(() => manager.status().ready, 10000, '重启后 ready')
    assert(manager.update(scene) === true, '重启后场景能重新下发')
    await sleep(300)
    const status2 = await manager.requestStatus()
    assert(status2.ok === true && status2.status.sceneItems === 1, '重启后场景生效')

    const secondPid = manager.pid
    manager.dispose()
    await waitUntil(() => !pidAlive(secondPid), 5000, 'dispose 后 helper 消失')
    assert(manager.status().running === false, 'dispose 后 manager 不再报告运行')
    assert(!pidAlive(firstPid) && !pidAlive(secondPid), '两个 helper 进程都已离开')
  } finally {
    manager.dispose()
  }

  // 不可用：只打一行、不 spawn
  const unavailableInfos = []
  const unavailable = createDesktop({
    desktopHost: false,
    log: { info: (line) => unavailableInfos.push(line), warn: (line) => unavailableInfos.push(line) }
  })
  const unavailableResult = unavailable.start()
  assert(unavailableResult.reason === 'not-desktop-host', 'web profile / 非桌面宿主 → not-desktop-host')
  assert(unavailableInfos.length === 1, '降级只打一行日志')
  unavailable.dispose()

  const missingWarns = []
  const missing = createDesktop({
    desktopHost: true,
    platform: 'darwin',
    env: { DSH_HOME: '/nonexistent-dsh-home-for-smoke' },
    exists: () => false,
    log: { info: () => {}, warn: (line) => missingWarns.push(line) }
  })
  const missingResult = missing.start()
  assert(missingResult.reason === 'electron-missing', 'Electron 缺失 → electron-missing')
  assert(missingWarns.length === 1, 'Electron 缺失只打一行日志')
  missing.dispose()
}

// ---------------------------------------------------------------------------
// 宿主被 SIGKILL：helper 必须自己发现并退出（POSIX 没有 job object 兜底）
// ---------------------------------------------------------------------------

async function verifyHostKill () {
  const hostScript = join(OUT_DIR, 'host-child.mjs')
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(hostScript, `
import { createDesktop } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'desktop.js')).href)}
const manager = createDesktop({ desktopHost: true, platform: 'darwin', log: { info() {}, warn() {} } })
const started = manager.start()
process.stdout.write(JSON.stringify(started) + '\\n')
setInterval(() => {}, 1000)
`, 'utf8')
  const host = spawn(process.execPath, [hostScript], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  spawned.push(host)
  let stdout = ''
  host.stdout.setEncoding('utf8')
  host.stdout.on('data', (chunk) => { stdout += chunk })
  let stderr = ''
  host.stderr.setEncoding('utf8')
  host.stderr.on('data', (chunk) => { stderr += chunk })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !stdout.includes('\n')) await sleep(50)
  const line = stdout.split('\n').find((candidate) => candidate.includes('"pid"'))
  assert(Boolean(line), '宿主子进程拉起了 helper')
  const started = JSON.parse(line)
  const helperPid = started.pid
  assert(pidAlive(helperPid), 'helper 在跑（pid ' + helperPid + '）')

  process.kill(host.pid, 'SIGKILL')
  const gone = await waitUntil(() => !pidAlive(helperPid), 10000, '宿主被杀后 helper 自行退出')
  assert(gone, '宿主被 SIGKILL 后，helper 在 10s 内自行退出（host-liveness / 管道断开）')
  if (stderr.trim() !== '') info('宿主子进程 stderr：' + stderr.trim().slice(0, 500))
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function cleanup () {
  for (const child of spawned) {
    try {
      if (child.exitCode === null) child.kill('SIGKILL')
    } catch {
      // ignore
    }
  }
}

let exitCode = 0
let shot = null
try {
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  console.log('Electron: ' + (resolveElectronBinary({}).path ?? '未找到'))
  console.log('输出目录: ' + OUT_DIR)
  shot = await run('helper：窗口 / 点击穿透 / 截图 / quit', verifyHelper)
  await run('manager：ready / update / shot / 崩溃重启 / dispose', verifyManager)
  await run('生命周期：宿主被 SIGKILL 后 helper 自行退出', verifyHostKill)
  console.log('\n全部通过（' + checks + ' 项断言）。')
  console.log('截图：' + shot.pngPath)
  console.log('说明：' + shot.sidecarPath)
  console.log('PNG 可直接打开查看透明背景与占位方块。')
} catch (error) {
  exitCode = 1
  console.error('\n冒烟失败：' + (error instanceof Error ? error.message : String(error)))
  if (error instanceof Error && error.stack) console.error(error.stack)
  console.error('辅助日志目录：' + OUT_DIR)
} finally {
  cleanup()
}
process.exit(exitCode)
