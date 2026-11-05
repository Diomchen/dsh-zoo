/**
 * 右键菜单的内容（ticket 22）：分类顺序与标签必须和 dsh-pet 自己的菜单一致，
 * 否则会出现"菜单里有、点了被 /anim 拒"的假入口。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MENU_TOOL_LABELS,
  buildMenu,
  groupsFromAnimations,
  groupsFromPool,
  menuTools,
  readAnimationsConfig
} from '../src/menu.js'

const ANIMATIONS = {
  idle: ['待机呼吸休闲'],
  turn: ['东张西望'],
  drag: ['被鼠标拖拽悬空反馈'],
  clicks: ['点击回应-开心跃动', '点击回应-害羞惊讶'],
  moves: { default: {}, actions: [{ name: '螃蟹走路' }, { name: '原地漂浮踏步', params: {} }] },
  categories: [
    { id: '小动作', weight: 20, actions: ['悠闲哼歌', '写代码'] },
    { id: '玩耍', weight: 20, actions: ['原地专心玩魔方'] },
    { id: '空分类', weight: 0, actions: [] }
  ],
  events: {
    balance: ['余额-钱袋满溢'],
    whisper: ['碎碎念-擦桌碎碎念'],
    workStatus: [['工作状态-思考冒泡', '工作状态-忙碌点按']]
  }
}

test('动画分类：顺序与标签对齐 dsh-pet（待机/转向/拖拽/点击回应/移动/随机/事件）', () => {
  const groups = groupsFromAnimations(ANIMATIONS)
  assert.deepEqual(groups.map((group) => group.label), [
    '待机', '转向', '拖拽', '点击回应', '移动', '小动作', '玩耍', '余额', '碎碎念', '工作状态'
  ])
  assert.deepEqual(groups.find((group) => group.label === '移动').actions, ['螃蟹走路', '原地漂浮踏步'])
  // 事件档位里的数组槽位展平；alias 用中文标签
  assert.deepEqual(groups.find((group) => group.label === '工作状态').actions, [
    '工作状态-思考冒泡', '工作状态-忙碌点按'
  ])
})

test('动画分类：坏数据只丢自己，整份坏掉返回空', () => {
  const groups = groupsFromAnimations({
    idle: ['待机呼吸休闲', '待机呼吸休闲', 42, '  '],
    clicks: 'nope',
    moves: { actions: [{ name: '' }, null, { name: '螃蟹走路' }] },
    categories: [null, { id: '' }, { id: '小动作', actions: ['写代码'] }],
    events: { custom: ['自定义事件'] }
  })
  assert.deepEqual(groups, [
    { label: '待机', actions: ['待机呼吸休闲'] },
    { label: '移动', actions: ['螃蟹走路'] },
    { label: '小动作', actions: ['写代码'] },
    { label: 'custom', actions: ['自定义事件'] }
  ])
  for (const bad of [null, undefined, 1, 'x', []]) assert.deepEqual(groupsFromAnimations(bad), [])
})

test('降级清单：本机素材源平铺成一组；空池不出菜单', () => {
  assert.deepEqual(groupsFromPool(['东张西望', '东张西望', '螃蟹走路']), [
    { label: '动作', actions: ['东张西望', '螃蟹走路'] }
  ])
  assert.deepEqual(groupsFromPool([]), [])
  assert.deepEqual(groupsFromPool(null), [])
})

test('工具项：拿得到 DSH 地址才有「打开软件」；顺序固定', () => {
  assert.deepEqual(menuTools({ hasOrigin: true }).map((tool) => tool.id), ['open-site', 'bring', 'home', 'reload', 'scan-skins'])
  assert.deepEqual(menuTools({ hasOrigin: false }).map((tool) => tool.id), ['bring', 'home', 'reload', 'scan-skins'])
  assert.equal(MENU_TOOL_LABELS.reload, '重载配置')
  assert.equal(MENU_TOOL_LABELS.bring, '带派')
  assert.equal(MENU_TOOL_LABELS['scan-skins'], '扫描外观')
})

test('buildMenu：dsh-pet 在就用它的分类；不在就退平铺；两条都空只剩工具', () => {
  const withPet = buildMenu({ animations: ANIMATIONS, pool: ['甲'], hasOrigin: true })
  assert.equal(withPet.groups[0].label, '待机')
  assert.deepEqual(withPet.tools.map((tool) => tool.id), ['open-site', 'bring', 'home', 'reload', 'scan-skins'])

  const fallback = buildMenu({ animations: null, pool: ['甲', '乙'] })
  assert.deepEqual(fallback.groups, [{ label: '动作', actions: ['甲', '乙'] }])
  assert.deepEqual(fallback.tools.map((tool) => tool.id), ['bring', 'home', 'reload', 'scan-skins'])

  const bare = buildMenu({})
  assert.deepEqual(bare.groups, [])
  assert.deepEqual(bare.tools.map((tool) => tool.id), ['bring', 'home', 'reload', 'scan-skins'])
})

test('读动画配置：素材目录旁边的 config.jsonc，剥注释；坏文件跳过看下一个源', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-menu-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const broken = join(dir, 'broken', 'assets')
  const good = join(dir, 'good', 'assets')
  await mkdir(join(broken, 'webm'), { recursive: true })
  await mkdir(join(good, 'webm'), { recursive: true })
  await writeFile(join(broken, 'config.jsonc'), '{ not json')
  await writeFile(join(good, 'config.jsonc'), `{
    // 行注释
    "animations": { "idle": ["待机呼吸休闲"], /* 块注释 */ "clicks": ["点击回应-开心跃动"] }
  }`)

  const found = await readAnimationsConfig([join(broken, 'webm'), join(good, 'webm')])
  assert.equal(found.path, join(good, 'config.jsonc'))
  assert.deepEqual(found.animations.idle, ['待机呼吸休闲'])

  assert.equal(await readAnimationsConfig([join(broken, 'webm')]), null)
  assert.equal(await readAnimationsConfig([]), null)
  assert.equal(await readAnimationsConfig(null), null)
})

test('菜单「外观」：只列合法 id，当前那张带 activeSkin', () => {
  const menu = buildMenu({
    animations: { idle: ['东张西望'] },
    skins: [
      { id: 'fish', label: '鱼' },
      { id: 'cat', label: '猫' },
      { id: '../etc', label: '非法' },
      { id: 'fish', label: '重复' },
      { id: 'no-label' }
    ],
    activeSkin: 'cat'
  })

  assert.deepEqual(menu.skins, [
    { id: 'fish', label: '鱼' },
    { id: 'cat', label: '猫' },
    { id: 'no-label', label: 'no-label' }
  ])
  assert.equal(menu.activeSkin, 'cat')
})

test('菜单「外观」：activeSkin 不在候选里就当没有，别画错勾', () => {
  const menu = buildMenu({ skins: [{ id: 'fish', label: '鱼' }], activeSkin: 'ghost' })
  assert.equal(menu.activeSkin, null)
})
