/**
 * 票 57：宠物不在家（串门 / 去偷 / 在外打工）时桌面仍然是可操作的。
 *
 * 这里验两件纯逻辑：
 *   1. 「不在家」那张人话表（三种 mode 各一句话，白名单与 helper 同源）；
 *   2. 农场小窗的模式：只有真的在串门才是访客页；去偷和在打工时仍然是我家农场。
 *
 * 胶囊/面板本身的绘制与点击在 `scripts/desktop-smoke.mjs` 里用真 Electron 验。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { AWAY_MODES, awayText, isAwayMode } from '../src/away-text.js'
import { createService } from '../src/service.js'

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor (predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(15)
  }
  throw new Error('waitFor timeout')
}

function fakeCtx () {
  const routes = []
  return {
    ctx: {
      webServer: {
        register (options) {
          routes.push(options)
          return () => {}
        }
      },
      logger: { info () {}, warn () {} }
    },
    routes
  }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-away-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

/** 桌面替身：`status().farmOpen` 永远是 false，好让每次 `farm-open` 都真的走“开窗”。 */
function desktopDouble (workArea = { x: 0, y: 30, width: 1000, height: 700 }) {
  const calls = { scenes: [], windows: [], results: [] }
  let onEvent = null
  return {
    calls,
    factory (options) {
      onEvent = options.onEvent
      return {
        start () { return { ok: true, pid: 4343 } },
        update (scene) { calls.scenes.push(scene); return true },
        resync (scene) { calls.scenes.push(scene); return true },
        farmWindow (payload) {
          calls.windows.push(payload)
          return true
        },
        status () { return { farmOpen: false } },
        bringWindow () { return true },
        actionResult (id, result) {
          calls.results.push({ id, result })
        },
        dispose () {}
      }
    },
    ready () {
      onEvent?.({
        type: 'ready',
        pid: 4343,
        workArea,
        displays: [{ id: 1, bounds: workArea, workArea, scaleFactor: 1, primary: true }]
      })
    },
    emit (event) {
      onEvent?.(event)
    }
  }
}

async function openFarmWindow (desktop, id) {
  desktop.emit({ type: 'action', id, action: 'farm-open' })
  await waitFor(() => desktop.calls.results.some((entry) => entry.id === id))
  const result = desktop.calls.results.find((entry) => entry.id === id).result
  assert.equal(result.ok, true, JSON.stringify(result))
  const opened = [...desktop.calls.windows].reverse().find((window) => window.open === true)
  return opened
}

test('awayText：三种不在家各说一句话，mode 白名单与 helper 同源', () => {
  assert.deepEqual(shared.AWAY_MODES, [...AWAY_MODES])
  assert.deepEqual(shared.AWAY_MODES, ['visiting', 'raiding', 'working'])

  assert.deepEqual(awayText('visiting', '阿蟹', '小蓝'), {
    text: '在「阿蟹」家',
    title: '小蓝在「阿蟹」家'
  })
  assert.deepEqual(awayText('raiding', '阿蟹', '小蓝'), {
    text: '去「阿蟹」家偷菜了',
    title: '小蓝去「阿蟹」家偷菜了'
  })
  assert.deepEqual(awayText('working', '柯基', '小蓝'), {
    text: '在「柯基」家打工',
    title: '小蓝在「柯基」家打工'
  })

  // 缺名字也不能出现「undefined」或空书名号：退回「邻居」「宠物」。
  assert.deepEqual(awayText('working', null, null), {
    text: '在「邻居」家打工',
    title: '宠物在「邻居」家打工'
  })
  assert.deepEqual(awayText(null, '阿蟹', '小蓝'), {
    text: '在「阿蟹」家',
    title: '小蓝在「阿蟹」家'
  })

  assert.equal(isAwayMode('visiting'), true)
  assert.equal(isAwayMode('sneaking'), false)
  assert.equal(isAwayMode(null), false)
})

test('农场小窗：打工 / 去偷时仍是我家农场（owner），只有串门才是访客页', async (t) => {
  const dir = await tempDir(t)
  const { ctx } = fakeCtx()
  const desktop = desktopDouble()
  const service = createService(ctx, {
    dataDir: dir,
    network: false,
    petBridge: false,
    skinServer: false,
    desktopFactory: desktop.factory
  })
  t.after(() => service.dispose())
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  const peer = randomUUID()
  service.room.observeBeacon({ deviceId: peer, nickname: '阿蟹', port: 41001 }, Date.now())

  // 1) 在外打工：桌面上没有 self，但农场窗必须还是我自己的（不是访客页）。
  const contractId = randomUUID()
  const working = service.room.beginWorking({
    contractId,
    employerDeviceId: peer,
    employerNickname: '柯基',
    startedAt: Date.now(),
    endsAt: Date.now() + 2 * 60 * 60 * 1000,
    guard: 0.5
  })
  assert.equal(working.ok, true)
  const workWindow = await openFarmWindow(desktop, 'w-work')
  assert.equal(workWindow.mode, 'owner')
  assert.equal('visit' in workWindow, false, '打工不是串门：窗口不该带访客视图')
  assert.equal(service.snapshot().self.work.contractId, contractId)

  service.room.endWorking(contractId, { reason: 'recall' })
  assert.equal(service.snapshot().self.work, null)

  // 2) 去偷：`self.out` 存在（确实是出门了），但偷不是串门——窗口仍是我家农场。
  const raid = service.room.beginVisit(peer, { visitId: randomUUID(), purpose: 'steal', plots: ['p1'] })
  assert.equal(raid.ok, true)
  service.room.observeVisitAck({ deviceId: peer, visitId: raid.visit.visitId })
  assert.equal(service.snapshot().self.out.purpose, 'steal')
  const raidWindow = await openFarmWindow(desktop, 'w-raid')
  assert.equal(raidWindow.mode, 'owner')
  assert.equal('visit' in raidWindow, false, '去偷不该把要偷的那家画成访客页')
  service.room.recallOutbound()
  assert.equal(service.snapshot().self.out, null)

  // 3) 真串门：同一扇窗还是访客页（ticket 43 的约定不变）。
  service.room.admit(peer)
  const visit = service.room.beginVisit(peer, { visitId: randomUUID() })
  assert.equal(visit.ok, true)
  service.room.observeVisitAck({ deviceId: peer, visitId: visit.visit.visitId })
  const visitWindow = await openFarmWindow(desktop, 'w-visit')
  assert.equal(visitWindow.mode, 'visitor')
  assert.equal(visitWindow.visit?.nickname, '阿蟹')
})
