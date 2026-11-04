/**
 * 右键菜单的纯逻辑（ticket 22）：宿主下发的菜单树、面板贴边、场景回路。
 *
 * 渲染端只负责画——所有"能出现什么"的判断都在这里，所以这一层必须能单测。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import shared from '../desktop/shared.js'

test('菜单：工具项只认固定 id，坏条目只丢自己', () => {
  const menu = shared.normalizeMenu({
    tools: [
      { id: 'home', label: '回到初始位置' },
      { id: 'open-site', label: '打开软件', hint: 'Ctrl+左键' },
      { id: 'rm-rf', label: '删库跑路' },
      { id: 'home', label: '重复的' },
      { id: 'reload' },
      null,
      { id: 'reload', label: '重载配置' }
    ]
  })
  assert.deepEqual(menu.tools, [
    { id: 'home', label: '回到初始位置' },
    { id: 'open-site', label: '打开软件', hint: 'Ctrl+左键' },
    { id: 'reload', label: '重载配置' }
  ])
})

test('菜单：空分类不出现，动画名去重且过安全名校验', () => {
  const menu = shared.normalizeMenu({
    groups: [
      { label: '待机', actions: ['东张西望', '东张西望', '  原地小憩沉眠 '] },
      { label: '事件', actions: [] },
      { label: '转向', actions: ['../etc/passwd'] },
      { label: '待机', actions: ['重复分类'] }
    ]
  })
  assert.deepEqual(menu.groups, [
    { label: '待机', actions: ['东张西望', '原地小憩沉眠'] }
  ])
})

test('菜单：整份坏数据 → 空菜单，不抛', () => {
  for (const bad of [null, undefined, 42, 'menu', [], { tools: 'x', groups: {} }]) {
    assert.deepEqual(shared.normalizeMenu(bad), { tools: [], groups: [], skins: [], activeSkin: null })
  }
})

test('菜单：场景 v3 带 menu；旧场景没有这个字段时是空菜单', () => {
  const fresh = shared.normalizeScene({ items: [] })
  assert.equal(fresh.version, 3)
  assert.deepEqual(fresh.menu, { tools: [], groups: [], skins: [], activeSkin: null })

  const scene = shared.normalizeScene({
    items: [],
    menu: {
      tools: [{ id: 'home', label: '回到初始位置' }],
      groups: [{ label: '待机', actions: ['东张西望'] }]
    }
  })
  assert.deepEqual(scene.menu.tools, [{ id: 'home', label: '回到初始位置' }])
  assert.deepEqual(scene.menu.groups, [{ label: '待机', actions: ['东张西望'] }])
})

test('菜单：petScene 把 menu 原样带进场景', () => {
  const scene = shared.petScene([], { width: 800, height: 600 }, {
    menu: { tools: [{ id: 'reload', label: '重载配置' }], groups: [{ label: '动作', actions: ['螃蟹走路'] }] }
  })
  assert.deepEqual(scene.menu.tools, [{ id: 'reload', label: '重载配置' }])
  assert.deepEqual(scene.menu.groups, [{ label: '动作', actions: ['螃蟹走路'] }])
})

test('菜单：默认贴在指针右侧；右边放不下翻到左侧', () => {
  const area = { width: 800, height: 600 }
  const size = { width: 200, height: 300 }
  const right = shared.placeMenu({ x: 100, y: 100, width: 0, height: 0 }, size, area)
  assert.deepEqual({ x: right.x, y: right.y }, { x: 102, y: 100 })

  const flipped = shared.placeMenu({ x: 700, y: 100, width: 0, height: 0 }, size, area)
  assert.equal(flipped.x, 700 - 200 - 2)
  assert.equal(flipped.y, 100)
})

test('菜单：底部放不下就往上顶，仍然夹在工作区里', () => {
  const area = { width: 800, height: 600 }
  const size = { width: 200, height: 300 }
  const up = shared.placeMenu({ x: 200, y: 560, width: 0, height: 0 }, size, area)
  assert.equal(up.y, 560 - 300)

  // 面板比工作区还高：只能贴边，绝不出现负坐标。
  const tall = shared.placeMenu({ x: 200, y: 100, width: 0, height: 0 }, { width: 200, height: 900 }, area)
  assert.equal(tall.height, 600)
  assert.equal(tall.y, 8)
})

test('菜单：子菜单以父项那条为锚点，贴右侧展开', () => {
  const area = { width: 800, height: 600 }
  const parent = { x: 40, y: 80, width: 160, height: 26 }
  const sub = shared.placeMenu(parent, { width: 180, height: 260 }, area)
  assert.deepEqual({ x: sub.x, y: sub.y }, { x: 40 + 160 + 2, y: 80 })
})

test('菜单：外观候选与当前项都从宿主下发，坏条目只丢自己', () => {
  const menu = shared.normalizeMenu({
    skins: [
      { id: 'fish', label: '鱼' },
      { id: 'cat', label: '猫' },
      { id: 'bad id', label: '带空格' },
      { id: 'fish', label: '重复' },
      { id: 'nil' }
    ],
    activeSkin: 'cat'
  })
  assert.deepEqual(menu.skins, [
    { id: 'fish', label: '鱼' },
    { id: 'cat', label: '猫' }
  ])
  assert.equal(menu.activeSkin, 'cat')

  // 当前项不在候选里 → 当作没有，菜单不会给一个不存在的皮打勾。
  assert.equal(shared.normalizeMenu({ skins: [{ id: 'fish', label: '鱼' }], activeSkin: 'ghost' }).activeSkin, null)
})

test('菜单：use-skin 只带素材源 id，形状不对整条拒绝', () => {
  assert.equal(shared.DESKTOP_ACTIONS.includes('use-skin'), true)
  assert.equal(shared.MENU_ACTION_IDS.includes('use-skin'), true)

  const ok = shared.normalizeHelperEvent({ type: 'action', id: 'act-1', action: 'use-skin', skinId: 'cat' })
  assert.equal(ok.ok, true)
  assert.equal(ok.event.skinId, 'cat')

  for (const bad of [undefined, null, '', '../etc', 'a'.repeat(33)]) {
    assert.deepEqual(
      shared.normalizeHelperEvent({ type: 'action', id: 'act-2', action: 'use-skin', skinId: bad }),
      { ok: false, error: 'bad-skin-id' }
    )
  }
})
