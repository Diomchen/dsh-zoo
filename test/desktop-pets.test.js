import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { buildHelperArgs } from '../src/desktop-launch.js'
import { controlsFromSnapshot, droppedVisitors, petsFromSnapshot } from '../src/desktop-pets.js'
import { DSH_PET_ASSET_ENV, resolveDshPetAssetDirs } from '../src/pet-assets.js'
import { createRoom } from '../src/room.js'
import { visitReasonText } from '../src/visit-copy.js'

// ---------------------------------------------------------------------------
// 场景 v2
// ---------------------------------------------------------------------------

const AREA = { x: 0, y: 30, width: 1000, height: 700 }

test('petScene：角色/昵称/动作/颜色来自输入，出生点全部落在工作区内且可复现', () => {
  const pets = [
    { id: 'self', role: 'self', label: '小蓝', anim: '东张西望', color: shared.PET_COLORS[0] },
    { id: 'guest:aaa', role: 'guest', label: '阿蟹', anim: '螃蟹走路' },
    { id: 'visitor:bbb', role: 'visitor', label: '泡泡', anim: null }
  ]
  const scene = shared.petScene(pets, AREA)
  assert.equal(scene.version, 3)
  assert.equal(scene.reset, false)
  assert.deepEqual(scene.items.map((item) => item.id), ['self', 'guest:aaa', 'visitor:bbb'])
  assert.deepEqual(scene.items.map((item) => item.role), ['self', 'guest', 'visitor'])
  assert.equal(scene.items[0].anim, '东张西望')
  assert.equal(scene.items[2].anim, null)
  assert.equal(scene.items[0].kind, 'pet')
  assert.ok(scene.items.every((item) => item.x >= 0 && item.x + item.width <= AREA.width))
  assert.ok(scene.items.every((item) => item.y >= 0 && item.y + item.height <= AREA.height))
  assert.ok(scene.items.every((item) => item.width >= 16 && item.height >= item.width))
  // 同一份输入永远同一份输出（截图、冒烟、场景对账不会漂移）
  assert.deepEqual(shared.petScene(pets, AREA), scene)
  // 场景归一化不能把 petScene 的产物改掉
  assert.deepEqual(shared.normalizeScene(scene), scene)
})

test('petScene：reset 传递、未知角色回落 guest、坏条目丢弃、数量封顶、单条消息不超行', () => {
  const scene = shared.petScene([
    { id: 'a', role: 'nobody', label: 'A', anim: '../evil', color: 'red' },
    { id: 'a', role: 'guest', label: '重复' },
    { id: 'bad id', role: 'guest', label: '坏 id' },
    null,
    'nope'
  ], AREA, { reset: true })
  assert.equal(scene.reset, true)
  assert.equal(scene.items.length, 1)
  assert.equal(scene.items[0].role, 'guest')
  assert.equal(scene.items[0].anim, null)
  assert.equal(scene.items[0].color, shared.DEFAULT_COLOR)

  const many = []
  for (let index = 0; index < shared.MAX_SCENE_ITEMS + 20; index += 1) {
    many.push({ id: 'i' + index, role: 'guest', label: '客人' + index, anim: '东张西望' })
  }
  const capped = shared.petScene(many, AREA)
  assert.equal(capped.items.length, shared.MAX_SCENE_ITEMS)
  const line = shared.encodeMessage({ type: 'update', scene: capped })
  assert.ok(line !== null && line.length < shared.MAX_LINE_LENGTH, '最坏情况的场景也必须塞进一行')
})

test('petScene：极小/缺失工作区也能给出不越界的矩形', () => {
  const tiny = shared.petScene([{ id: 'self', role: 'self', label: '我' }], { width: 40, height: 30 })
  const item = tiny.items[0]
  assert.ok(item.x >= 0 && item.x + item.width <= 40)
  assert.ok(item.y >= 0 && item.y + item.height <= 30)

  const fallback = shared.petScene([{ id: 'self', role: 'self', label: '我' }], null)
  assert.equal(fallback.items.length, 1)
  assert.ok(fallback.items[0].x + fallback.items[0].width <= 1440)
})

test('demoPetScene：截图用固定三只，走真实动作名', () => {
  const scene = shared.demoPetScene(AREA)
  assert.equal(scene.reset, true)
  assert.equal(scene.items.length, 3)
  assert.deepEqual(scene.items.map((item) => item.role), ['self', 'guest', 'guest'])
  assert.ok(scene.items.every((item) => typeof item.anim === 'string' && item.anim.length > 0))
})

test('initialVelocity：同一 id 恒定、方向/速度有界且非零', () => {
  const a = shared.initialVelocity('self')
  const b = shared.initialVelocity('self')
  assert.deepEqual(a, b)
  assert.equal(a.vy, 0)
  assert.ok(Math.abs(a.vx) >= 48 && Math.abs(a.vx) <= 140)
  const seeds = new Set()
  for (let index = 0; index < 20; index += 1) seeds.add(shared.initialVelocity('guest:' + index).vx)
  assert.ok(seeds.size > 3, '不同宠物应该散开')
})

// ---------------------------------------------------------------------------
// 物理
// ---------------------------------------------------------------------------

function run (body, area, seconds, dt = 1 / 60) {
  let current = body
  const frames = Math.round(seconds / dt)
  for (let index = 0; index < frames; index += 1) current = shared.stepBody(current, area, dt)
  return current
}

function assertInside (body, area, label) {
  assert.ok(Number.isFinite(body.x) && Number.isFinite(body.y), label + '：坐标有限')
  assert.ok(Number.isFinite(body.vx) && Number.isFinite(body.vy), label + '：速度有限')
  assert.ok(body.x >= 0 && body.x + body.width <= area.width + 1e-6, label + '：x 在工作区内')
  assert.ok(body.y >= 0 && body.y + body.height <= area.height + 1e-6, label + '：y 在工作区内（不穿地）')
}

test('物理：重力把宠物拉到地面，落地后停住，永远不穿地', () => {
  const area = { width: 800, height: 600 }
  const body = shared.createBody({ x: 100, y: 0, width: 120, height: 120 }, area)
  let current = body
  let sawUpward = false
  for (let index = 0; index < 180; index += 1) {
    current = shared.stepBody(current, area, 1 / 60)
    if (current.vy < -1) sawUpward = true
    assertInside(current, area, '落地过程')
  }
  assert.ok(sawUpward, '落地应该有可见反弹（vy 向上）')
  assert.equal(current.y, shared.groundY(current, area))
  assert.equal(current.vy, 0)
})

test('物理：横向摩擦让滑行停下，撞边反弹后仍在工作区内', () => {
  const area = { width: 800, height: 600 }
  let body = shared.createBody({ x: 690, y: 480, width: 100, height: 120, vx: 900, vy: 0 }, area)
  let bounced = false
  for (let index = 0; index < 240; index += 1) {
    const previous = body
    body = shared.stepBody(body, area, 1 / 60)
    if (body.x + body.width >= area.width - 1e-6 && previous.vx > 0) bounced = true
    assertInside(body, area, '撞边过程')
  }
  assert.ok(bounced, '应该撞到右边缘')
  assert.ok(Math.abs(body.vx) < 5, '地面摩擦后横向速度接近 0（实际 ' + body.vx + '）')
})

test('物理：越过尺寸/NaN/巨大 dt 的输入都被夹回工作区', () => {
  const area = { width: 500, height: 400 }
  const huge = shared.createBody({ x: Number.NaN, y: -100, width: 5000, height: 5000, vx: NaN, vy: Infinity }, area)
  assert.equal(huge.width, 500)
  assert.equal(huge.height, 400)
  assert.equal(huge.x, 0)
  assert.equal(huge.y, 0)
  assert.equal(huge.vx, 0)
  assert.equal(huge.vy, 0)

  let body = shared.createBody({ x: 450, y: 350, width: 80, height: 80, vx: 5000, vy: -5000 }, area)
  body = shared.stepBody(body, area, 10)
  assertInside(body, area, '巨大 dt')
  body = shared.stepBody(body, area, -1)
  assertInside(body, area, '负 dt')
})

test('物理：拖拽是弹簧跟随（逐渐逼近目标、不瞬移），目标越界也被夹住', () => {
  const area = { width: 1000, height: 700 }
  let body = shared.createBody({ x: 0, y: 0, width: 100, height: 120 }, area)
  const target = { x: 500, y: 400 }
  let previousDistance = Infinity
  let movedAt200ms = 0
  for (let index = 0; index < 120; index += 1) {
    body = shared.dragBody(body, target, area, 1 / 60)
    const distance = Math.hypot(target.x - body.x, target.y - body.y)
    assert.ok(distance <= previousDistance + 2, '弹簧不应该明显远离目标')
    previousDistance = distance
    if (index === 12) movedAt200ms = Math.hypot(body.x, body.y)
    assertInside(body, area, '拖拽过程')
  }
  assert.ok(movedAt200ms > 50, '200ms 内要明显跟手')
  assert.ok(previousDistance < 2, '2 秒后基本贴住目标（实际 ' + previousDistance.toFixed(2) + 'px）')

  const far = shared.dragBody(body, { x: 99999, y: -99999 }, area, 1 / 60)
  assert.ok(far.x <= area.width - far.width && far.y >= 0)
  assertInside(far, area, '拖出屏幕')
})

test('物理：松手投掷用最近轨迹算速度，限速，停住/陈旧轨迹算 0', () => {
  const trail = [
    { t: 1000, x: 0, y: 100 },
    { t: 1050, x: 50, y: 90 },
    { t: 1100, x: 100, y: 80 }
  ]
  const velocity = shared.throwVelocityFromTrail(trail, 1100)
  assert.ok(Math.abs(velocity.vx - 1000) < 1, '横向速度 ≈ 1000（实际 ' + velocity.vx + '）')
  assert.ok(Math.abs(velocity.vy - -200) < 1)

  const limited = shared.throwVelocityFromTrail([
    { t: 0, x: 0, y: 0 },
    { t: 10, x: 5000, y: 0 }
  ], 10)
  assert.ok(Math.hypot(limited.vx, limited.vy) <= shared.PHYSICS.MAX_THROW_SPEED + 1e-6)

  assert.deepEqual(shared.throwVelocityFromTrail([], 0), { vx: 0, vy: 0 })
  assert.deepEqual(shared.throwVelocityFromTrail([{ t: 0, x: 0, y: 0 }], 0), { vx: 0, vy: 0 })
  assert.deepEqual(
    shared.throwVelocityFromTrail([{ t: 0, x: 0, y: 0 }, { t: 100, x: 100, y: 0 }], 500),
    { vx: 0, vy: 0 },
    '松手时轨迹已经陈旧 = 放下，不是投掷'
  )
})

test('物理：投掷后速度衰减、落地、仍在工作区内', () => {
  const area = { width: 800, height: 600 }
  let body = shared.createBody({ x: 200, y: 100, width: 100, height: 120 }, area)
  body = shared.throwBody(body, { vx: 1500, vy: -900 }, area)
  assert.ok(Math.abs(body.vx) < 1500 + 1e-6)
  body = run(body, area, 5)
  assertInside(body, area, '投掷 5 秒后')
  assert.ok(Math.abs(body.vx) < 5)
  assert.ok(body.vy === 0)
})

test('物理：工作区变化后每只宠物被重新夹回新边界，落在地面以下会停住', () => {
  const resized = shared.resizeBodies([
    { x: 900, y: 0, width: 100, height: 100, vx: 50, vy: 0 },
    { x: 0, y: 250, width: 100, height: 100, vx: 0, vy: 300 }
  ], { width: 500, height: 300 })
  assert.equal(resized.length, 2)
  assertInside(resized[0], { width: 500, height: 300 }, '右边缘')
  assert.ok(resized[0].x <= 400)
  assertInside(resized[1], { width: 500, height: 300 }, '地面以下')
  assert.equal(resized[1].y, shared.groundY(resized[1], { width: 500, height: 300 }))
  assert.equal(resized[1].vy, 0, '被抬到新地面后不再继续往下冲')
})

test('物理：随机 100 只 × 600 帧，任何一帧都不出界、不穿地、不出现 NaN', () => {
  const area = { width: 900, height: 600 }
  let seed = 123456789
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed / 0x100000000
  }
  const bodies = []
  for (let index = 0; index < 100; index += 1) {
    bodies.push(shared.createBody({
      x: random() * 1800 - 400,
      y: random() * 1200 - 300,
      width: 40 + random() * 120,
      height: 40 + random() * 120,
      vx: random() * 4000 - 2000,
      vy: random() * 4000 - 2000
    }, area))
  }
  let current = bodies
  for (let frame = 0; frame < 600; frame += 1) {
    const dt = random() * 0.2
    current = current.map((body, index) => (
      index % 7 === 0
        ? shared.dragBody(body, { x: random() * 900, y: random() * 600 }, area, dt)
        : shared.stepBody(body, area, dt)
    ))
    for (const body of current) assertInside(body, area, 'fuzz 第 ' + frame + ' 帧')
  }
})

// ---------------------------------------------------------------------------
// 输入租约 / 命中矩形
// ---------------------------------------------------------------------------

test('穿透裁定：busy 租约只在光标压在活矩形上时生效；矩形外/没有矩形一律穿透', () => {
  const rects = [{ id: 'p', x: 100, y: 100, width: 50, height: 50 }]
  const inside = { x: 120, y: 120 }
  const outside = { x: 10, y: 10 }
  const now = 100000

  // 拖拽：宠物落后于光标，但渲染端报的 ui:drag 矩形盖住了光标 → 租约生效。
  assert.deepEqual(
    shared.shouldBeInteractive({ rects, point: inside, busy: true, busyAt: now - 100, now }),
    { interactive: true, reason: 'busy-lease' }
  )
  // A3：租约本身不能把整窗变成可交互；光标不在任何活矩形里 = fail closed。
  assert.deepEqual(
    shared.shouldBeInteractive({ rects, point: outside, busy: true, busyAt: now - 100, now }),
    { interactive: false, reason: 'outside' },
    '光标在命中矩形外时，租约也不能让窗口吃掉点击'
  )
  assert.deepEqual(
    shared.shouldBeInteractive({ rects: [], point: outside, busy: true, busyAt: now, now }),
    { interactive: false, reason: 'no-scene' },
    '没有任何活矩形时，租约也不能让窗口吃掉点击'
  )
  assert.equal(
    shared.shouldBeInteractive({ rects, point: inside, busy: true, busyAt: now - shared.BUSY_LEASE_MS - 1, now }).interactive,
    false,
    '租约超过 BUSY_LEASE_MS 没续期 → 穿透'
  )
  assert.equal(
    shared.shouldBeInteractive({ rects, point: inside, busy: true, busyAt: 0, now }).interactive,
    false,
    '没有时间戳的 busy 不可信'
  )
  assert.equal(
    shared.shouldBeInteractive({ rects, point: inside, busy: false, busyAt: now, now }).interactive,
    false
  )
  assert.deepEqual(
    shared.shouldBeInteractive({ rects, point: inside, lastHoverAt: now - 10, now }),
    { interactive: true, reason: 'hovering' }
  )
  assert.deepEqual(
    shared.shouldBeInteractive({ rects: [], point: inside, lastHoverAt: now, now }),
    { interactive: false, reason: 'no-scene' }
  )
})

test('穿透裁定：租约连续持有超过 BUSY_MAX_MS 也必须收回（泄漏租约不能砖掉桌面）', () => {
  const rects = [{ id: 'p', x: 100, y: 100, width: 50, height: 50 }]
  const inside = { x: 120, y: 120 }
  const now = 100000
  // 心跳很新鲜、光标也在矩形里，但这条租约已经连续续了超过硬上限。
  const leaked = shared.shouldBeInteractive({
    rects,
    point: inside,
    busy: true,
    busyAt: now - 50,
    busySince: now - shared.BUSY_MAX_MS - 1,
    now
  })
  assert.deepEqual(leaked, { interactive: false, reason: 'waiting-for-confirmation' })
  // 刚超过上限一点点也收；上限内仍可信。
  assert.equal(shared.shouldBeInteractive({
    rects, point: inside, busy: true, busyAt: now, busySince: now - shared.BUSY_MAX_MS + 1, now
  }).interactive, true)
  // 调用方显式给一个更短的 busyMaxMs（测试/调试用）。
  assert.equal(shared.shouldBeInteractive({
    rects, point: inside, busy: true, busyAt: now, busySince: now - 500, busyMaxMs: 400, now
  }).interactive, false)
})

test('命中矩形上报：只接受合法矩形、保留 id、数量封顶', () => {
  const rects = shared.normalizeRects([
    { id: 'self', x: 1, y: 2, width: 3, height: 4 },
    { id: 'bad id', x: 10, y: 20, width: 30, height: 40 },
    { id: 'x', x: 0, y: 0, width: 0, height: 10 },
    null,
    'nope'
  ])
  assert.deepEqual(rects, [
    { id: 'self', x: 1, y: 2, width: 3, height: 4 },
    // id 不合法但矩形合法：保留矩形、id 置 null（更保守的将来也能用）
    { id: null, x: 10, y: 20, width: 30, height: 40 }
  ])
  assert.deepEqual(shared.normalizeRects('nope'), [])

  const many = []
  for (let index = 0; index < shared.MAX_SCENE_ITEMS + 5; index += 1) {
    many.push({ id: 'i' + index, x: 0, y: 0, width: 10, height: 10 })
  }
  assert.equal(shared.normalizeRects(many).length, shared.MAX_SCENE_ITEMS)
})

test('命中矩形防守（A3）：超大矩形拒绝、越界裁到工作区、数量封顶', () => {
  const area = { x: 0, y: 0, width: 500, height: 400 }
  const rects = shared.normalizeRects([
    { id: 'screen-size', x: 0, y: 0, width: 10000, height: 10000 },
    { id: 'too-wide', x: 0, y: 0, width: 2000, height: 10 },
    { id: 'off-screen', x: 900, y: 900, width: 50, height: 50 },
    { id: 'edge', x: 480, y: 380, width: 50, height: 50 },
    { id: 'ok', x: 10, y: 10, width: 20, height: 20 }
  ], { area })
  assert.deepEqual(rects.map((rect) => rect.id), ['edge', 'ok'])
  assert.deepEqual(rects[0], { id: 'edge', x: 480, y: 380, width: 20, height: 20 })
  assert.deepEqual(rects[1], { id: 'ok', x: 10, y: 10, width: 20, height: 20 })

  // 单边刚好超过上限就拒绝；刚好多一点也会被裁掉/接受，但绝不会扩大命中区。
  const limit = shared.MAX_HIT_RECT_SIZE
  assert.equal(shared.normalizeRects([{ x: 0, y: 0, width: limit + 1, height: 10 }], { area }).length, 0)
  assert.equal(shared.normalizeRects([{ x: 0, y: 0, width: limit, height: 10 }], { area }).length, 1)
  // 只裁不扩：裁剪后的矩形一定在原矩形 && 工作区里。
  const clipped = shared.normalizeRects([{ id: 'p', x: -20, y: -20, width: 100, height: 100 }], { area })[0]
  assert.deepEqual(clipped, { id: 'p', x: 0, y: 0, width: 80, height: 80 })

  // 数量封顶：不会因为渲染端塞一堆矩形把判定拖垮。
  const many = []
  for (let index = 0; index < shared.MAX_HIT_RECTS + 10; index += 1) {
    many.push({ id: 'r' + index, x: 1, y: 1, width: 5, height: 5 })
  }
  assert.equal(shared.normalizeRects(many, { area }).length, shared.MAX_HIT_RECTS)
})

test('穿透裁定（A2）：弹层只靠 overlay 矩形接管鼠标，不需要输入租约', () => {
  const pet = { id: 'self', x: 100, y: 400, width: 160, height: 200 }
  const popover = { id: 'ui:popover', x: 100, y: 300, width: 160, height: 92 }
  // 渲染端上报顺序：桥接矩形在前、弹层其次、宠物最后（倒序扫描 → 宠物优先）。
  const bridge = { id: 'ui:bridge:popover', ...shared.unionRect([popover, pet]) }
  const rects = [bridge, popover, pet]
  const now = 5000

  // 光标从宠物跨过 8px 间隙走到弹层：桥接矩形必须盖住这条缝。
  for (const point of [{ x: 180, y: 396 }, { x: 180, y: 350 }, { x: 180, y: 320 }]) {
    assert.deepEqual(
      shared.shouldBeInteractive({ rects, point, lastHoverAt: now - 100, now }),
      { interactive: true, reason: 'hovering' },
      '弹层/间隙/宠物之间移动时窗口保持可交互（busy=false，不靠租约）'
    )
  }
  // 光标离开宠物与弹层：窗口必须立刻回到穿透，不能把整块桌面吃掉。
  assert.deepEqual(
    shared.shouldBeInteractive({ rects, point: { x: 900, y: 100 }, lastHoverAt: now - 100, now }),
    { interactive: false, reason: 'outside' }
  )
})

// ---------------------------------------------------------------------------
// 快照 → 桌面宠物
// ---------------------------------------------------------------------------

function snapshotWith (overrides = {}) {
  return {
    version: 1,
    self: {
      deviceId: '11111111-1111-4111-8111-111111111111',
      nickname: '我的电脑',
      pet: { name: '小蓝', anim: '东张西望' },
      bridge: { ok: true, reason: null },
      out: null
    },
    neighbors: [],
    guests: [],
    visitors: [],
    ...overrides
  }
}

test('petsFromSnapshot：自己的宠物优先；没装 dsh-pet 时用昵称+色块；出门时从桌面消失', () => {
  const pets = petsFromSnapshot(snapshotWith())
  assert.equal(pets.length, 1)
  assert.deepEqual(pets[0], {
    id: 'self',
    role: 'self',
    label: '小蓝',
    anim: '东张西望',
    color: shared.PET_COLORS[0]
  })

  const noPet = petsFromSnapshot(snapshotWith({
    self: { ...snapshotWith().self, pet: null }
  }))
  assert.equal(noPet.length, 1)
  assert.equal(noPet[0].label, '我的电脑')
  assert.equal(noPet[0].anim, null)

  const nameless = petsFromSnapshot(snapshotWith({
    self: { ...snapshotWith().self, nickname: '', pet: null }
  }))
  assert.equal(nameless[0].label, '我')

  const away = petsFromSnapshot(snapshotWith({
    self: { ...snapshotWith().self, out: { phase: 'active', nickname: '邻居' } }
  }))
  assert.deepEqual(away, [], '出门期间本机桌面不显示自己（ticket 09 依赖这一条）')
})

test('petsFromSnapshot：只画串门访客；心跳影子不是客人，不画', () => {
  const guestId = '22222222-2222-4222-8222-222222222222'
  const visitorId = '33333333-3333-4333-8333-333333333333'
  const snapshot = snapshotWith({
    guests: [
      { deviceId: guestId, nickname: '阿蟹', anim: '螃蟹走路', since: 1, expiresAt: 2 },
      { deviceId: visitorId, nickname: '泡泡', anim: '原地漂浮踏步', since: 1, expiresAt: 2 },
      { deviceId: 'not-a-uuid/', nickname: '坏家伙', anim: null }
    ],
    visitors: [
      {
        deviceId: visitorId,
        nickname: '泡泡',
        anim: '东张西望',
        visitId: 'v',
        since: 1,
        lastSeen: 1,
        endsAt: null
      }
    ]
  })
  const pets = petsFromSnapshot(snapshot)
  assert.deepEqual(pets.map((pet) => pet.id), ['self', 'visitor:' + visitorId])
  assert.deepEqual(pets.map((pet) => pet.role), ['self', 'visitor'])
  assert.equal(pets[1].label, '泡泡')
  assert.equal(pets[1].anim, '东张西望')
  assert.notEqual(pets[1].color, shared.PET_COLORS[0])

  // 只有心跳影子、没有 visitors：桌面上只有自己——否则“串门”会变成邻居一直待着。
  assert.deepEqual(
    petsFromSnapshot(snapshotWith({ guests: snapshot.guests })).map((pet) => pet.id),
    ['self']
  )
})

test('petsFromSnapshot：坏快照不抛、重复 deviceId 只画一次、最多 MAX_SCENE_ITEMS', () => {
  assert.deepEqual(petsFromSnapshot(null), [])
  assert.deepEqual(petsFromSnapshot({}), [])
  const id = '44444444-4444-4444-8444-444444444444'
  const duplicated = petsFromSnapshot(snapshotWith({
    visitors: [
      { deviceId: id, nickname: 'A', anim: null },
      { deviceId: id, nickname: 'B', anim: null }
    ]
  }))
  assert.equal(duplicated.length, 2)

  const visitors = []
  for (let index = 0; index < shared.MAX_SCENE_ITEMS + 5; index += 1) {
    const suffix = String(index).padStart(12, '0')
    visitors.push({
      deviceId: '55555555-5555-4555-8555-' + suffix,
      nickname: '访客' + index,
      anim: null
    })
  }
  const roomy = snapshotWith({ visitors })
  assert.equal(petsFromSnapshot(roomy).length, shared.MAX_SCENE_ITEMS)
  // 场景放不下的访客数要能被宿主看见（A5：不能静默丢宠物）。
  assert.equal(droppedVisitors(roomy), shared.MAX_SCENE_ITEMS + 5 - (shared.MAX_SCENE_ITEMS - 1))
  assert.equal(droppedVisitors(snapshotWith()), 0)
  assert.equal(droppedVisitors(null), 0)
})

test('controlsFromSnapshot：串门可用性/置灰理由、召回、可送客名单、放行卡、notice', () => {
  const visitorId = '33333333-3333-4333-8333-333333333333'
  const promptId = '44444444-4444-4444-8444-444444444444'
  const snapshot = snapshotWith({
    visitTargets: [{ deviceId: visitorId, nickname: '阿蟹' }],
    visitors: [{ deviceId: visitorId, nickname: '阿蟹', anim: null, since: 1, lastSeen: 1, endsAt: null }],
    prompt: { deviceId: promptId, nickname: '泡泡' },
    notices: [{ text: '「阿蟹」没有回应，等了一会儿，宠物先留在家里了。', at: 5000 }]
  })
  const controls = controlsFromSnapshot(snapshot)
  assert.deepEqual(controls.visit, { enabled: true, reason: null })
  assert.deepEqual(controls.recall, { enabled: false, nickname: null })
  assert.deepEqual(controls.visitors, [{ deviceId: visitorId, label: '阿蟹' }])
  assert.deepEqual(controls.prompt, { deviceId: promptId, nickname: '泡泡' })
  assert.equal(controls.notice.text, '「阿蟹」没有回应，等了一会儿，宠物先留在家里了。')
  assert.equal(controls.notice.at, 5000)

  // 没有任何可串门邻居：置灰，但必须有一句可读的理由（不能静默）。
  const noTargets = controlsFromSnapshot(snapshotWith({ visitTargets: [] }))
  assert.equal(noTargets.visit.enabled, false)
  assert.equal(noTargets.visit.reason, visitReasonText('no-admitted'))
  assert.match(noTargets.visit.reason, /还没有人放行你/)
  assert.match(noTargets.visit.reason, /出不了门/)

  // A6：有人放行、只是都不在线时，按钮不能再说“还没有人放行你”。
  // 原因由 room 判定（快照字段 visitBlockedReason），文案和 notice 共用一份。
  const noOnline = controlsFromSnapshot(snapshotWith({
    visitTargets: [],
    visitBlockedReason: 'no-online'
  }))
  assert.equal(noOnline.visit.enabled, false)
  assert.equal(noOnline.visit.reason, visitReasonText('no-online'))
  assert.match(noOnline.visit.reason, /不在线/)
  assert.doesNotMatch(noOnline.visit.reason, /还没有人放行你/)

  // 按钮的理由和 room 真正写下的 notice 是同一句话（同一个 reason）。
  const T0 = 1_700_000_000_000
  for (const reason of ['no-admitted', 'no-online']) {
    const room = createRoom({ clock: () => T0 })
    room.setIdentity({ deviceId: '11111111-1111-4111-8111-111111111111', nickname: '我' })
    if (reason === 'no-online') {
      // 放行一位从没在线过的邻居：放行名单非空，但没有可去的目标。
      const offline = '22222222-2222-4222-8222-222222222222'
      room.observeBeacon({ deviceId: offline, nickname: '掉线', port: 40001 }, T0)
      room.admit(offline)
    }
    const snapshot = room.snapshot()
    assert.equal(snapshot.visitBlockedReason, reason)
    assert.equal(controlsFromSnapshot(snapshot).visit.reason, room.noVisitTarget().notice)
  }

  // 出门在外：串门置灰、召回可用；理由里带对方昵称。
  const away = controlsFromSnapshot(snapshotWith({
    self: {
      ...snapshotWith().self,
      out: { deviceId: visitorId, nickname: '阿蟹', visitId: 'v', phase: 'active', startedAt: 1, endsAt: 2 }
    }
  }))
  assert.equal(away.visit.enabled, false)
  assert.equal(away.recall.enabled, true)
  assert.equal(away.recall.nickname, '阿蟹')
  assert.equal(away.visit.reason, visitReasonText('already-out', '阿蟹'))
  assert.match(away.visit.reason, /阿蟹/)
  assert.match(away.visit.reason, /召回/)

  // 坏输入：坏 deviceId 不出现；空快照给空控件。
  const broken = controlsFromSnapshot(snapshotWith({
    visitors: [{ deviceId: 'not a uuid', nickname: '坏' }],
    prompt: { deviceId: 'bad id', nickname: '坏' },
    notices: [{ text: '', at: 1 }]
  }))
  assert.deepEqual(broken.visitors, [])
  assert.equal(broken.prompt, null)
  assert.equal(broken.notice, null)
  assert.deepEqual(controlsFromSnapshot(null), shared.emptyControls())
})

// ---------------------------------------------------------------------------
// dsh-pet 素材目录 + helper argv
// ---------------------------------------------------------------------------

test('素材目录解析：环境覆盖 → 用户素材 → 包解析 → profiles 扫描，profile 名不写死', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-assets-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const user = join(dir, 'dsh-pet', 'main-animation', 'webm')
  const packageDir = join(dir, 'custom', 'dsh-pet')
  const packageAssets = join(packageDir, 'assets', 'webm')
  const profileDesktop = join(dir, 'profiles', 'desktop', 'node_modules', 'dsh-pet', 'assets', 'webm')
  const profileWeb = join(dir, 'profiles', 'web', 'node_modules', 'dsh-pet', 'assets', 'webm')
  const override = join(dir, 'override')
  for (const path of [user, packageAssets, profileDesktop, profileWeb, override]) await mkdir(path, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), '{"name":"dsh-pet"}')

  const dirs = resolveDshPetAssetDirs({
    env: { DSH_HOME: dir, [DSH_PET_ASSET_ENV]: override },
    resolvePackage: (id) => {
      assert.equal(id, 'dsh-pet/package.json')
      return join(packageDir, 'package.json')
    }
  })
  assert.deepEqual(dirs, [override, user, packageAssets, profileDesktop, profileWeb])

  const withoutOverride = resolveDshPetAssetDirs({
    env: { DSH_HOME: dir },
    resolvePackage: () => { throw new Error('not installed next door') }
  })
  assert.deepEqual(withoutOverride, [user, profileDesktop, profileWeb])

  const missing = resolveDshPetAssetDirs({ env: { DSH_HOME: join(dir, 'nope') }, resolvePackage: () => { throw new Error('x') } })
  assert.deepEqual(missing, [])
})

test('helper argv：素材目录只接受绝对路径、去重、最多 8 个，且仍带 host pid / debug', () => {
  const args = buildHelperArgs({
    helperPath: '/helper/main.js',
    hostPid: 42,
    debug: true,
    assetRoots: ['/a', '/a', 'relative', '', null, '/b']
  })
  assert.deepEqual(args, [
    '/helper/main.js',
    '--dsh-zoo-host-pid', '42',
    '--dsh-zoo-debug',
    '--dsh-zoo-assets', '/a',
    '--dsh-zoo-assets', '/b'
  ])
  assert.deepEqual(buildHelperArgs({ helperPath: '/h', assetRoots: null }), ['/h'])
})

test('petScene：访客的远端素材地址与语义 fallback 必须传下去（宿主的 src 不能在这里丢）', () => {
  const hash = 'b'.repeat(64)
  const src = 'dshzoo://cache/' + hash + '.webm'
  const scene = shared.petScene([
    { id: 'visitor:x', role: 'visitor', label: '柯基', anim: '东张西望', src, fallback: 'sleeping' },
    { id: 'self', role: 'self', label: '小蓝', anim: null }
  ], AREA)

  const visitor = scene.items.find((item) => item.id === 'visitor:x')
  assert.equal(visitor.src, src)
  assert.equal(visitor.fallback, 'sleeping')
  // 本机宠物没有远端地址；没给的字段不要凭空长出来
  const self = scene.items.find((item) => item.id === 'self')
  assert.equal(self.src, undefined)
  assert.equal(self.fallback, undefined)
  // helper 侧归一化不能把这两个字段改掉
  const normalized = shared.normalizeScene(JSON.parse(JSON.stringify(scene)))
  const roundTrip = normalized.items.find((item) => item.id === 'visitor:x')
  assert.equal(roundTrip.src, src)
  assert.equal(roundTrip.fallback, 'sleeping')
})

test('场景 item 保留合法的 cache src 与语义 fallback，非法值丢掉', () => {
  const hash = 'a'.repeat(64)
  const scene = shared.normalizeScene({
    v: 2,
    items: [
      {
        id: 'visitor:x',
        kind: 'pet',
        role: 'visitor',
        label: '柯基',
        anim: null,
        src: 'dshzoo://cache/' + hash + '.webm',
        fallback: 'sleeping',
        x: 10, y: 10, width: 100, height: 100
      },
      {
        id: 'visitor:y',
        kind: 'pet',
        role: 'visitor',
        label: '猫',
        anim: null,
        src: 'http://evil/x.webm',
        fallback: 'nope',
        x: 20, y: 20, width: 100, height: 100
      }
    ],
    reset: false
  })

  const first = scene.items.find((item) => item.id === 'visitor:x')
  assert.equal(first.src, 'dshzoo://cache/' + hash + '.webm')
  assert.equal(first.fallback, 'sleeping')
  const second = scene.items.find((item) => item.id === 'visitor:y')
  assert.equal(second.src, undefined)
  assert.equal(second.fallback, undefined)
})

test('helper argv 带 cacheRoot：只接受绝对路径', () => {
  assert.deepEqual(
    buildHelperArgs({ helperPath: '/h', cacheRoot: '/tmp/skin-cache' }),
    ['/h', '--dsh-zoo-cache', '/tmp/skin-cache']
  )
  assert.deepEqual(buildHelperArgs({ helperPath: '/h', cacheRoot: 'relative' }), ['/h'])
})

test('场景 item 接受本机待机池：去重、过滤非法名', () => {
  const scene = shared.normalizeScene({
    v: 2,
    items: [{
      id: 'self',
      kind: 'pet',
      role: 'self',
      label: '我',
      idlePool: ['A', 'A', '../x', 'B', 42, ''],
      x: 0, y: 0, width: 100, height: 100
    }],
    reset: false
  })
  assert.deepEqual(scene.items[0].idlePool, ['A', 'B'])
})

test('待机池轮播：每次选择都前进，不会卡在同一段', () => {
  const pool = ['A', 'B', 'C']
  let cursor = 0
  const seen = []
  for (let i = 0; i < 4; i += 1) {
    const picked = shared.pickIdleClip(pool, cursor, new Set())
    seen.push(picked.clip)
    cursor = picked.next
  }
  assert.deepEqual(seen, ['A', 'B', 'C', 'A'])
})

test('待机池轮播：跳过加载失败的片段', () => {
  const picked = shared.pickIdleClip(['A', 'B', 'C'], 0, new Set(['A']))
  assert.equal(picked.clip, 'B')
  assert.equal(picked.next, 2)
})

test('petScene 把本机待机池带进场景（ticket 19 的池子不能在这一层丢）', () => {
  const scene = shared.petScene([
    { id: 'self', role: 'self', label: '我', color: shared.PET_COLORS[0], idlePool: ['A', 'B'] }
  ], AREA)
  assert.deepEqual(scene.items[0].idlePool, ['A', 'B'])
})

test('待机池随机：注入 random 后从随机位置选，并避开刚播过的那段', () => {
  const first = shared.pickIdleClip(['A', 'B', 'C'], 0, new Set(), () => 0, 'A')
  assert.equal(first.clip, 'B')
  const last = shared.pickIdleClip(['A', 'B', 'C'], 0, new Set(), () => 0.99, null)
  assert.equal(last.clip, 'C')
  const only = shared.pickIdleClip(['A'], 0, new Set(), () => 0, 'A')
  assert.equal(only.clip, 'A', '池子只有一段时允许重复')
})

test('controlsFromSnapshot：街上的每一户都送到桌面，去不了的带着理由', () => {
  const goId = '22222222-2222-4222-8222-222222222222'
  const goneId = '33333333-3333-4333-8333-333333333333'
  const snapshot = snapshotWith({
    street: [
      { deviceId: goId, nickname: '老王', action: '改那个 bug', canVisit: true, blockedReason: null },
      { deviceId: goneId, nickname: '秃头哥', action: null, canVisit: false, blockedReason: 'peer-offline' }
    ]
  })

  assert.deepEqual(controlsFromSnapshot(snapshot).street, [
    { deviceId: goId, label: '老王', action: '改那个 bug', canVisit: true, blockedReason: null },
    { deviceId: goneId, label: '秃头哥', action: null, canVisit: false, blockedReason: 'peer-offline' }
  ])

  // 旧快照没有 street：街道是空的，不抛。
  assert.deepEqual(controlsFromSnapshot(snapshotWith()).street, [])
})

test('controlsFromSnapshot：礼物卡跟着访客；正文只在 received 时给，文案来自宿主', () => {
  const visitorId = '33333333-3333-4333-8333-333333333333'
  const giftId = '55555555-5555-4555-8555-555555555555'
  const withGift = (gift) => snapshotWith({
    visitors: [{ deviceId: visitorId, nickname: '阿蟹', anim: null, gift }]
  })

  assert.deepEqual(controlsFromSnapshot(withGift({
    id: giftId, kind: 'text', text: '第一行\n第二行', status: 'received'
  })).gifts, [{
    deviceId: visitorId,
    giftId,
    kind: 'text',
    status: 'received',
    title: '「阿蟹」捎来一张字条',
    text: '第一行\n第二行'
  }])

  // 还没写完磁盘：不画正文（给一半会骗人），只画状态行。
  const pending = controlsFromSnapshot(withGift({
    id: giftId, kind: 'text', text: '第一行\n第二行', status: 'pending'
  })).gifts
  assert.deepEqual(pending, [{
    deviceId: visitorId,
    giftId,
    kind: 'text',
    status: 'pending',
    title: '「阿蟹」捎来一张字条',
    statusText: '刚到，正在收下…'
  }])

  // 坏 gift 只丢这张卡：id 不是 UUID / 未知状态 / 未知 kind / 没有访客。
  for (const bad of [
    { id: 'gift-1', kind: 'text', text: 'x', status: 'received' },
    { id: giftId, kind: 'text', text: 'x', status: 'lost' },
    { id: giftId, kind: 'file', text: 'x', status: 'received' },
    { id: giftId, kind: 'text', text: 'x' }
  ]) {
    assert.deepEqual(controlsFromSnapshot(withGift(bad)).gifts, [], JSON.stringify(bad))
  }
  assert.deepEqual(controlsFromSnapshot(snapshotWith()).gifts, [])
  assert.deepEqual(controlsFromSnapshot(null).gifts, [])
})

test('controlsFromSnapshot：礼物卡没有独立生命周期——访客走了卡片就不在', () => {
  const visitorId = '33333333-3333-4333-8333-333333333333'
  const gift = { id: '55555555-5555-4555-8555-555555555555', kind: 'text', text: 'x', status: 'received' }
  const present = controlsFromSnapshot(snapshotWith({
    visitors: [{ deviceId: visitorId, nickname: '阿蟹', anim: null, gift }]
  }))
  assert.equal(present.gifts.length, 1)
  const gone = controlsFromSnapshot(snapshotWith({ visitors: [] }))
  assert.deepEqual(gone.gifts, [])
})

// ---------------------------------------------------------------------------
// ticket 25：文件礼物的卡片（name/size/thumb/失败原因）
// ---------------------------------------------------------------------------

test('controlsFromSnapshot：文件卡片带 name/size；缩略图只在 received 且是图片时给', () => {
  const visitorId = '33333333-3333-4333-8333-333333333333'
  const giftId = '55555555-5555-4555-8555-555555555555'
  const dir = '20261103-153245-ab12cd12'
  const thumb = 'dshzoo://gifts/' + dir + '/' + encodeURIComponent('照片.PNG')
  const thumbOf = (id) => (id === giftId ? thumb : null)
  const withGift = (gift) => snapshotWith({
    visitors: [{ deviceId: visitorId, nickname: '阿蟹', anim: null, gift }]
  })

  // 图片 + received：给缩略图；正文永远没有。
  assert.deepEqual(controlsFromSnapshot(withGift({
    id: giftId, kind: 'file', name: '照片.PNG', size: 23194, status: 'received'
  }), { thumbOf }).gifts, [{
    deviceId: visitorId,
    giftId,
    kind: 'file',
    status: 'received',
    title: '「阿蟹」捎来一个文件',
    name: '照片.PNG',
    size: 23194,
    thumb
  }])

  // 非图片：不给 thumb（渲染端画文件图标）。
  assert.deepEqual(controlsFromSnapshot(withGift({
    id: giftId, kind: 'file', name: '报价单.pdf', size: 1024, status: 'received'
  }), { thumbOf }).gifts, [{
    deviceId: visitorId,
    giftId,
    kind: 'file',
    status: 'received',
    title: '「阿蟹」捎来一个文件',
    name: '报价单.pdf',
    size: 1024
  }])

  // 还没收下：不给 thumb，状态行来自固定词表；失败原因只认词表里的值。
  const failed = controlsFromSnapshot(withGift({
    id: giftId, kind: 'file', name: '照片.PNG', size: 23194, status: 'failed', reason: 'no-port'
  }), { thumbOf }).gifts
  assert.equal(failed.length, 1)
  assert.equal('thumb' in failed[0], false)
  assert.equal(failed[0].statusText, '对方没开素材端口，东西取不回来。')

  const refused = controlsFromSnapshot(withGift({
    id: giftId, kind: 'file', name: '照片.PNG', size: 23194, status: 'refused', reason: 'too-large'
  }), { thumbOf }).gifts
  assert.equal(refused[0].statusText, '这件东西超过 16 MB，没收下。')

  // 文件卡缺 name 或 size 就整张丢掉（画不出半截卡）。
  for (const bad of [
    { id: giftId, kind: 'file', name: '照片.PNG', status: 'received' },
    { id: giftId, kind: 'file', size: 10, status: 'received' },
    { id: giftId, kind: 'file', name: '照片.PNG', size: 0, status: 'received' }
  ]) {
    assert.deepEqual(controlsFromSnapshot(withGift(bad), { thumbOf }).gifts, [], JSON.stringify(bad))
  }
})

test('皮自带尺寸：比例按 462 算，两只宠物各按自己的宽度排开、共用一条地平线', () => {
  const area = { width: 1440, height: 900 }
  const scene = shared.petScene([
    { id: 'self', role: 'self', label: '我', size: 693 },   // 1.5×
    { id: 'visitor:a', role: 'guest', label: '阿蟹' }        // 没带 size → 1.0
  ], area)

  const [self, guest] = scene.items
  assert.ok(self.width > guest.width, '大皮应当更宽：' + self.width + ' vs ' + guest.width)
  assert.equal(self.width, Math.round(guest.width * 1.5), '693/462 = 1.5')
  assert.equal(self.x, Math.round(900 * 0.035), '第一只从 margin 开始（工作区短边 3.5%，夹在 8..48）')
  assert.ok(self.x < guest.x, '按宽度顺序排开')
  assert.ok(self.x + self.width <= guest.x, '两只不重叠')
  // 同一块地面：包围盒底边对齐（高度含标签，所以看 y+height）。
  assert.equal(self.y + self.height, guest.y + guest.height)
})

test('皮自带尺寸：462 是 1.0，与不带 size 的老场景逐像素相同', () => {
  const area = { width: 1440, height: 900 }
  const withSize = shared.petScene([
    { id: 'self', role: 'self', label: '我', size: 462 },
    { id: 'visitor:a', role: 'guest', label: '阿蟹' },
    { id: 'visitor:b', role: 'guest', label: '泡泡' }
  ], area)
  const without = shared.petScene([
    { id: 'self', role: 'self', label: '我' },
    { id: 'visitor:a', role: 'guest', label: '阿蟹' },
    { id: 'visitor:b', role: 'guest', label: '泡泡' }
  ], area)
  assert.deepEqual(withSize.items.map((item) => [item.x, item.y, item.width, item.height]),
    without.items.map((item) => [item.x, item.y, item.width, item.height]))
})

test('皮自带尺寸：离谱的比例被夹住，不会把宠物撑出工作区', () => {
  const area = { width: 800, height: 600 }
  const scene = shared.petScene([
    { id: 'huge', role: 'self', label: '我', size: 100000 },
    { id: 'tiny', role: 'guest', label: '小', size: 1 }
  ], area)
  const [huge, tiny] = scene.items
  assert.ok(huge.width <= 600, '不能超过工作区短边：' + huge.width)
  assert.ok(tiny.width >= 16, '再小也有下限：' + tiny.width)
  assert.ok(huge.x >= 0 && huge.x + huge.width <= area.width)
})

// ---------------------------------------------------------------------------
// ticket 40：桌面地块条的农场摘要
// ---------------------------------------------------------------------------

test('controlsFromSnapshot：有农场就给摘要（阶段由生长进度推），没有就是 null', () => {
  const snapshot = snapshotWith({
    farm: {
      plots: [
        { id: 'p1', crop: 'tomato', plantedAt: 1, grownMs: 0, growMs: 1800000, waterings: 0, fertilized: false },
        { id: 'p2', crop: 'carrot', plantedAt: 1, grownMs: 7200000, growMs: 7200000, waterings: 1, fertilized: true },
        { id: 'p3', crop: null, plantedAt: null, grownMs: 0, growMs: 0 }
      ],
      coins: 30,
      seeds: { tomato: 2 },
      crops: {},
      dew: 1,
      guard: 0,
      worker: null,
      hire: { enabled: false },
      log: [{ at: 1, kind: 'plant', crop: 'tomato', qty: 1 }]
    }
  })
  const farm = controlsFromSnapshot(snapshot).farm
  assert.deepEqual(farm.plots, [
    { id: 'p1', crop: 'tomato', stage: 'growing', mature: false },
    { id: 'p2', crop: 'carrot', stage: 'mature', mature: true },
    { id: 'p3', crop: null, stage: 'empty', mature: false }
  ])
  assert.equal(farm.coins, 30)
  assert.equal(farm.dew, 1)
  assert.equal(farm.worker, null)
  assert.equal(farm.contractCount, 0)
  // 完整农场（种子/作物/日志）不能进场景：摘要只画地块条。
  for (const key of ['seeds', 'crops', 'log', 'hire', 'guard']) assert.equal(key in farm, false, key)

  // 老宿主/没有桌面层：null 让渲染端不画地块条（不是画 4 块空地）。
  assert.equal(controlsFromSnapshot(snapshotWith()).farm, null)
})

test('controlsFromSnapshot：坏地块丢掉、最多 4 块、数值夹取、雇工只留昵称', () => {
  const farm = controlsFromSnapshot(snapshotWith({
    farm: {
      plots: [
        { id: 'p1', crop: 'tomato', grownMs: 10, growMs: 20 },
        { id: 'p1', crop: 'carrot' },
        { id: 'bad id', crop: 'tomato' },
        { id: 'p2', crop: 'unknown' },
        { id: 'p3', crop: 'pumpkin' },
        { id: 'p4', crop: 'carrot' },
        { id: 'p5', crop: 'tomato' }
      ],
      coins: 1e9,
      dew: 999,
      worker: { nickname: '  阿蟹  ', endsAt: 1 },
      contractCount: 99
    }
  })).farm
  assert.deepEqual(farm.plots.map((plot) => plot.id), ['p1', 'p2', 'p3', 'p4'])
  assert.equal(farm.coins, shared.MAX_FARM_COINS)
  assert.equal(farm.dew, shared.MAX_FARM_DEW)
  assert.deepEqual(farm.worker, { nickname: '阿蟹' })
  assert.equal(farm.contractCount, shared.MAX_FARM_CONTRACTS)
})
