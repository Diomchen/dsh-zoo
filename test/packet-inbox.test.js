/**
 * 票 79 补：收到的红包不能因为访客走了就没入口。
 *
 * 现场：红包随串门请求到达、落盘、卡片贴在访客宠物旁边；访客几秒后就走了，
 * 卡片跟着消失——从此界面上再没有地方点「拆开」，红包一直躺到 24 小时自动退回寄件人。
 * 用户看到的就是「别人发给我的红包看不到」。
 *
 * 修法：宿主把还没拆的红包（`gifts.pendingPackets()`）单独投影成一张**不依赖访客**的卡，
 * 渲染端在访客不在时把它锚在自己宠物旁边。
 *
 * 这条用例走真宿主 + 真礼物目录：目录里先放一只没拆的红包 → 下发到 helper 的场景里
 * 必须有这张卡（桌面上一个访客都没有）→ 在这张卡上点「拆开」真的把钱记进农场 → 卡自己消失。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PACKET_TTL_MS, giftDirName } from '../src/gifts.js'
import { createService } from '../src/service.js'

const GIFT_ID = '55555555-5555-4555-8555-555555555555'
const PEER = '33333333-3333-4333-8333-333333333333'

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor (predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(15)
  }
  throw new Error('等不到：' + label)
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

/** 只记场景的桌面替身；不 spawn Electron。 */
function desktopDouble (workArea = { x: 0, y: 30, width: 1000, height: 700 }) {
  const calls = { scenes: [], results: [] }
  let onEvent = null
  return {
    calls,
    factory (options) {
      onEvent = options.onEvent
      return {
        start () { return { ok: true, pid: 4343 } },
        update (scene) { calls.scenes.push(scene); return true },
        resync (scene) { calls.scenes.push(scene); return true },
        status () { return { farmOpen: false } },
        farmWindow () { return true },
        bringWindow () { return true },
        actionResult (id, result) { calls.results.push({ id, result }) },
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
    },
    gifts () {
      return calls.scenes.at(-1)?.controls?.gifts ?? []
    }
  }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-packet-inbox-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

/** 直接在礼物目录里放一只「已经收下、还没拆」的红包（等价于昨天邻居发来的那只）。 */
async function seedPendingPacket (dir, receivedAt) {
  const dirName = giftDirName(GIFT_ID, receivedAt)
  const giftDir = join(dir, 'gifts', dirName)
  await mkdir(giftDir, { recursive: true })
  await writeFile(join(giftDir, 'meta.json'), JSON.stringify({
    version: 1,
    id: GIFT_ID,
    dir: dirName,
    from: { deviceId: PEER, nickname: '阿蟹' },
    kind: 'packet',
    packet: { coins: 12, crops: { tomato: 2 }, seeds: {} },
    note: '买糖',
    receivedAt,
    opened: false,
    claimedAt: 0,
    returnedAt: 0
  }), 'utf8')
}

test('待拆红包：访客不在也贴在桌面上，点「拆开」真的到账、卡自己消失', async (t) => {
  const dir = await tempDir(t)
  const receivedAt = Date.now() - 60_000
  await seedPendingPacket(dir, receivedAt)

  const { ctx } = fakeCtx()
  const desk = desktopDouble()
  const service = createService(ctx, {
    dataDir: dir,
    network: false,
    petBridge: false,
    skinServer: false,
    desktopFactory: desk.factory,
    desktopSyncMs: 50
  })
  t.after(() => service.dispose())
  await service.ready
  desk.ready()

  await waitFor(() => desk.gifts().length === 1, '红包卡出现在桌面场景里')
  const scene = desk.calls.scenes.at(-1)
  // 桌面上一个访客都没有：这张卡不是「访客捎来的」，是欠着的那只红包。
  assert.deepEqual(scene.controls.visitors, [])
  assert.deepEqual(desk.gifts(), [{
    deviceId: PEER,
    giftId: GIFT_ID,
    kind: 'packet',
    status: 'received',
    title: '「阿蟹」捎来一只红包',
    text: '12 硬币 · 小番茄 ×2',
    packet: { coins: 12, crops: { tomato: 2 }, seeds: {} },
    note: '买糖',
    expiresAt: receivedAt + PACKET_TTL_MS
  }])

  // 卡在手上就能拆：钱真的进农场（12 硬币 + 2 个小番茄）。
  const coinsBefore = service.snapshot().farm.coins
  const tomatoesBefore = service.snapshot().farm.crops.tomato ?? 0
  desk.emit({ type: 'action', id: 'claim-1', action: 'gift-claim', giftId: GIFT_ID })
  await waitFor(() => desk.calls.results.some((entry) => entry.id === 'claim-1'), '拆红包的结果回来')
  const result = desk.calls.results.find((entry) => entry.id === 'claim-1').result
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.notice, '拆开红包：12 硬币 · 小番茄 ×2 已经放进农场。')
  const after = service.snapshot().farm
  assert.equal(after.coins, coinsBefore + 12)
  assert.equal(after.crops.tomato ?? 0, tomatoesBefore + 2)

  // 拆开要留痕：卡片拆完就消失，农场「记录」页是唯一还能查到「收过谁的红包」的地方。
  const claimedEntry = after.log.find((entry) => entry.kind === 'packet' && entry.event === 'claimed')
  assert.ok(claimedEntry !== undefined, '拆开红包要写进农场记录')
  assert.equal(claimedEntry.who, '阿蟹')
  assert.equal(claimedEntry.text, '12 硬币 · 小番茄 ×2')
  assert.equal(claimedEntry.direction, 'in')

  // 拆过的红包不再列出来：卡片跟着下一次场景下发自己消失。
  await waitFor(() => desk.gifts().length === 0, '拆开后卡片消失')
})

test('待拆红包：过了 24 小时就不再画（退回由 expirePackets 负责）', async (t) => {
  const dir = await tempDir(t)
  await seedPendingPacket(dir, Date.now() - PACKET_TTL_MS - 60_000)

  const { ctx } = fakeCtx()
  const desk = desktopDouble()
  const service = createService(ctx, {
    dataDir: dir,
    network: false,
    petBridge: false,
    skinServer: false,
    desktopFactory: desk.factory,
    desktopSyncMs: 50
  })
  t.after(() => service.dispose())
  await service.ready
  desk.ready()

  await waitFor(() => desk.calls.scenes.length > 0, '宿主下发第一帧场景')
  // 多等两拍，确认不是「还没轮到」：过期红包点了也只会失败，画出来只是骗人。
  await delay(200)
  assert.deepEqual(desk.gifts(), [])
})
