import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { buildHelperArgs } from '../src/desktop-launch.js'
import { petsFromSnapshot } from '../src/desktop-pets.js'
import { DSH_PET_ASSET_ENV, resolveDshPetAssetDirs } from '../src/pet-assets.js'

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
  assert.equal(scene.version, 2)
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

test('穿透裁定：busy 租约期间光标在矩形外也保持交互；租约过期立即回穿透', () => {
  const rects = [{ id: 'p', x: 100, y: 100, width: 50, height: 50 }]
  const inside = { x: 120, y: 120 }
  const outside = { x: 10, y: 10 }
  const now = 100000

  assert.deepEqual(
    shared.shouldBeInteractive({ rects, point: outside, busy: true, busyAt: now - 100, now }),
    { interactive: true, reason: 'busy-lease' }
  )
  assert.equal(
    shared.shouldBeInteractive({ rects, point: outside, busy: true, busyAt: now - shared.BUSY_LEASE_MS - 1, now }).interactive,
    false,
    '租约超过 BUSY_LEASE_MS 没续期 → 穿透'
  )
  assert.equal(
    shared.shouldBeInteractive({ rects, point: outside, busy: true, busyAt: 0, now }).interactive,
    false,
    '没有时间戳的 busy 不可信'
  )
  assert.equal(
    shared.shouldBeInteractive({ rects: [], point: outside, busy: true, busyAt: now, now }).interactive,
    true,
    '拖拽租约不依赖命中矩形（宠物被拖到窗口外仍要收 pointerup）'
  )
  assert.equal(
    shared.shouldBeInteractive({ rects, point: outside, busy: false, busyAt: now, now }).interactive,
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

test('petsFromSnapshot：心跳影子 + 串门访客都画出来；同一位邻居串门优先，访客画在最后', () => {
  const guestId = '22222222-2222-4222-8222-222222222222'
  const visitorId = '33333333-3333-4333-8333-333333333333'
  const pets = petsFromSnapshot(snapshotWith({
    guests: [
      { deviceId: guestId, nickname: '阿蟹', anim: '螃蟹走路', since: 1, expiresAt: 2 },
      { deviceId: visitorId, nickname: '泡泡', anim: '原地漂浮踏步', since: 1, expiresAt: 2 },
      { deviceId: 'not-a-uuid/', nickname: '坏家伙', anim: null }
    ],
    visitors: [
      { deviceId: visitorId, nickname: '泡泡', anim: '东张西望', visitId: 'v', since: 1, endsAt: 2 }
    ]
  }))
  assert.deepEqual(pets.map((pet) => pet.id), [
    'self',
    'guest:' + guestId,
    'visitor:' + visitorId
  ])
  assert.deepEqual(pets.map((pet) => pet.role), ['self', 'guest', 'visitor'])
  assert.equal(pets[1].label, '阿蟹')
  assert.equal(pets[2].label, '泡泡')
  assert.equal(pets[2].anim, '东张西望')
  assert.notEqual(pets[1].color, shared.PET_COLORS[0])
  assert.notEqual(pets[2].color, shared.PET_COLORS[0])
})

test('petsFromSnapshot：坏快照不抛、重复 deviceId 只画一次、最多 MAX_SCENE_ITEMS', () => {
  assert.deepEqual(petsFromSnapshot(null), [])
  assert.deepEqual(petsFromSnapshot({}), [])
  const id = '44444444-4444-4444-8444-444444444444'
  const duplicated = petsFromSnapshot(snapshotWith({
    guests: [
      { deviceId: id, nickname: 'A', anim: null },
      { deviceId: id, nickname: 'B', anim: null }
    ]
  }))
  assert.equal(duplicated.length, 2)

  const visitors = []
  for (let index = 0; index < 80; index += 1) {
    const suffix = String(index).padStart(12, '0')
    visitors.push({
      deviceId: '55555555-5555-4555-8555-' + suffix,
      nickname: '客人' + index,
      anim: null
    })
  }
  assert.equal(petsFromSnapshot(snapshotWith({ visitors })).length, shared.MAX_SCENE_ITEMS)
})

// ---------------------------------------------------------------------------
// dsh-pet 素材目录 + helper argv
// ---------------------------------------------------------------------------

test('素材目录解析：环境覆盖 → 用户素材 → 包解析 → profiles 扫描，profile 名不写死', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-assets-'))
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
    '--local-pet-host-pid', '42',
    '--local-pet-debug',
    '--local-pet-assets', '/a',
    '--local-pet-assets', '/b'
  ])
  assert.deepEqual(buildHelperArgs({ helperPath: '/h', assetRoots: null }), ['/h'])
})
