/**
 * 多显示器回归：宠物必须能在每一块屏上被看见、被拖、被点。
 *
 * 这台机器上没法真的插两块屏，所以用 test/fixtures/fake-electron.cjs 顶替
 * `require('electron')`，让 **desktop/main.js 本身**跑起来，只是把
 * `screen.getAllDisplays()` / `getCursorScreenPoint()` 换成一份可改写的布局。
 * 被验证的链路与真机一致：main.js 算窗口 bounds → 渲染端（替身）按场景报命中矩形
 * → 主进程用真实光标位置裁定点击穿透。
 *
 * 失败时的读法：
 *   - `ready.workArea` / `status.bounds` 只有第一块屏 → 桌面层没覆盖整张虚拟桌面；
 *   - 光标在第二块屏的宠物身上，`status.ignoring` 仍是 true → 那块屏上没有输入。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const REGISTER = join(HERE, 'fixtures', 'fake-electron-register.cjs')
/** 默认测工作区里的 helper；打个包想验产物时指到解包后的 desktop/main.js。 */
const MAIN = process.env.DSH_ZOO_TEST_HELPER_MAIN || join(ROOT, 'desktop', 'main.js')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const WORK_AREA_Y = 25
const SCREEN = { width: 1440, height: 900 }

function display (id, x) {
  return {
    id,
    bounds: { x, y: 0, width: SCREEN.width, height: SCREEN.height },
    workArea: { x, y: WORK_AREA_Y, width: SCREEN.width, height: SCREEN.height - WORK_AREA_Y },
    scaleFactor: 2
  }
}

/** 左右并排、同一高度：并集就是两块屏的工作区连成的一片。 */
function sideBySideLayout (cursor = { x: 100, y: 100 }) {
  return {
    revision: 1,
    primaryId: 1,
    cursor,
    displays: [display(1, 0), display(2, SCREEN.width)]
  }
}

function primaryOnlyLayout (cursor = { x: 100, y: 100 }) {
  return { revision: 2, primaryId: 1, cursor, displays: [display(1, 0)] }
}

function unionOf (layout) {
  const areas = layout.displays.map((entry) => entry.workArea)
  const left = Math.min(...areas.map((area) => area.x))
  const top = Math.min(...areas.map((area) => area.y))
  const right = Math.max(...areas.map((area) => area.x + area.width))
  const bottom = Math.max(...areas.map((area) => area.y + area.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

async function startHelper (t, layout) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-multiscreen-'))
  const layoutPath = join(dir, 'layout.json')
  await writeFile(layoutPath, JSON.stringify(layout, null, 2))

  const child = spawn(process.execPath, ['--require', REGISTER, MAIN], {
    cwd: ROOT,
    env: { ...process.env, DSH_ZOO_FAKE_LAYOUT: layoutPath },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const events = []
  const waiters = []
  let buffer = ''
  let stderr = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      events.push(event)
      for (const waiter of [...waiters]) {
        if (waiter.predicate(event)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(event)
        }
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })

  function waitFor (predicate, fromIndex = 0, timeoutMs = 5000) {
    for (let index = fromIndex; index < events.length; index += 1) {
      if (predicate(events[index])) return Promise.resolve(events[index])
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (event) => {
          clearTimeout(timer)
          resolve(event)
        }
      }
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1)
        reject(new Error('等不到事件；stderr=' + stderr.slice(-800) + ' 已收到=' + JSON.stringify(events.slice(-6))))
      }, timeoutMs)
      waiters.push(waiter)
    })
  }

  function send (command) {
    child.stdin.write(JSON.stringify(command) + '\n')
  }

  let statusSeq = 0
  async function status () {
    const from = events.length
    const id = 'status-' + ++statusSeq
    send({ type: 'status', id })
    return waitFor((event) => event.type === 'status' && event.id === id, from)
  }

  async function writeLayout (next) {
    await writeFile(layoutPath, JSON.stringify(next, null, 2))
  }

  async function stop () {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        send({ type: 'quit' })
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            resolve()
          }, 2000)
          child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      } catch {
        child.kill('SIGKILL')
      }
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }

  t.after(stop)

  const ready = await waitFor((event) => event.type === 'ready')
  return { child, events, send, status, waitFor, writeLayout, ready, stderr: () => stderr }
}

test('多显示器：桌面层覆盖所有屏幕的工作区，而不是只有主屏', async (t) => {
  const layout = sideBySideLayout()
  const union = unionOf(layout)
  const helper = await startHelper(t, layout)

  assert.deepEqual(
    helper.ready.workArea,
    union,
    'helper 上报的工作区必须是整张虚拟桌面（主屏 union 第二屏），宿主才能把宠物放到第二块屏上'
  )

  const status = await helper.status()
  assert.deepEqual(
    status.bounds,
    union,
    '桌面窗口的 bounds 必须覆盖整张虚拟桌面，否则第二块屏上根本没有窗口接收鼠标'
  )
})

test('多屏：宠物在第二块屏上仍可被命中（跨屏拖动后还能继续操作）', async (t) => {
  // 宠物局部坐标落在第二块屏（x ≥ 1440），光标也在那块屏上。
  const pet = { id: 'self', kind: 'pet', role: 'self', x: 2000, y: 400, width: 160, height: 200, label: '我', color: '#3b74d8' }
  const pointer = { x: pet.x + 80, y: pet.y + 100 }
  const layout = sideBySideLayout(pointer)
  const helper = await startHelper(t, layout)

  helper.send({
    type: 'update',
    scene: { version: 3, reset: true, items: [pet], controls: {}, menu: {} }
  })
  await sleep(150)
  helper.send({ type: 'pointer', point: pointer })
  await sleep(150)

  const status = await helper.status()
  assert.equal(status.hoverInside, true, '渲染端应当在第二块屏上看见光标压在宠物身上')
  assert.equal(
    status.ignoring,
    false,
    '光标在第二块屏的宠物身上时，桌面窗口必须接管鼠标；为 true = 那块屏只能看不能点'
  )
})

test('多屏：第二块屏在主屏左侧时，负坐标同样要能命中', async (t) => {
  const layout = {
    revision: 1,
    primaryId: 1,
    cursor: { x: -1260, y: 500 },
    displays: [display(1, 0), display(2, -SCREEN.width)]
  }
  const pet = { id: 'self', kind: 'pet', role: 'self', x: 100, y: 400, width: 160, height: 200, label: '我', color: '#3b74d8' }
  const helper = await startHelper(t, layout)

  helper.send({
    type: 'update',
    scene: { version: 3, reset: true, items: [pet], controls: {}, menu: {} }
  })
  await sleep(150)
  helper.send({ type: 'pointer', point: { x: -1260, y: 500 } })
  await sleep(150)

  const status = await helper.status()
  assert.deepEqual(status.bounds, unionOf(layout), '负坐标布局也要覆盖两块屏')
  assert.equal(status.hoverInside, true, '左屏上的宠物必须能被命中（窗口局部坐标 = 屏幕坐标 − 窗口左上角）')
  assert.equal(status.ignoring, false, '左屏上的宠物必须可交互')
})

test('多屏：拔掉第二块屏后窗口收回到剩下的屏幕，宠物仍可用', async (t) => {
  const layout = sideBySideLayout()
  const helper = await startHelper(t, layout)
  const before = helper.events.length

  await helper.writeLayout(primaryOnlyLayout())
  const ready = await helper.waitFor((event) => event.type === 'ready', before)

  assert.deepEqual(ready.workArea, display(1, 0).workArea, '拔屏后工作区应只剩主屏')
  const status = await helper.status()
  assert.deepEqual(status.bounds, display(1, 0).workArea, '拔屏后窗口 bounds 应收回到主屏')
})
