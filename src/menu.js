/**
 * 右键菜单的内容（ticket 22）—— 宿主侧的唯一事实来源。
 *
 * 渲染端只画宿主下发的树；这一层负责把两处素材知识翻成同一份形状：
 *   - 装了 dsh-pet：读它的 `assets/config.jsonc` 里的 `animations`，分类名与它自己右键菜单
 *     **一字不差**（待机/转向/拖拽/点击回应/移动 + 随机分类 id + 事件档位）；
 *   - 没装：退到本机素材源的动作清单（名字即文件名），平铺成一个分类。
 *
 * 为什么必须同源：dsh-pet 的 `/anim` 会按它自己的 animations 集合校验名字，菜单里出现
 * 它不认的名字 = 点了没反应。宁可少一项，不给假入口。
 *
 * 纯逻辑：读文件由调用方注入，便于单测；坏配置只降级，绝不抛。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { stripJsonComments } from './pet-bridge.js'

/** 与 dsh-pet `shared/menu.ts` 的 EVENT_LABELS 对齐。 */
export const MENU_EVENT_LABELS = Object.freeze({
  balance: '余额',
  whisper: '碎碎念',
  workStatus: '工作状态'
})

/** 菜单最多几组 / 每组最多几项：跟着场景一起下发，别把一条 IPC 撑爆。 */
export const MAX_MENU_GROUPS = 24
export const MAX_MENU_ACTIONS = 256

/** 一级工具项。id 是渲染端认的固定集合，文案在这里定。 */
export const MENU_TOOL_LABELS = Object.freeze({
  'open-site': '打开软件',
  home: '回到初始位置',
  reload: '重载配置'
})

/**
 * dsh-pet 的 animations → 菜单分类（空分类丢掉）。
 *
 * 与 `dsh-pet/src/shared/menu.ts` 的 buildMenuTree 同序同标签：
 * 待机 → 转向 → 拖拽 → 点击回应 → 移动 → 随机分类 → 事件档位。
 */
export function groupsFromAnimations (animations) {
  const groups = []
  if (animations === null || typeof animations !== 'object' || Array.isArray(animations)) return groups

  const push = (label, names) => {
    if (groups.length >= MAX_MENU_GROUPS) return
    const actions = []
    const seen = new Set()
    for (const name of Array.isArray(names) ? names : []) {
      if (actions.length >= MAX_MENU_ACTIONS) break
      if (typeof name !== 'string') continue
      const trimmed = name.trim()
      if (trimmed === '' || seen.has(trimmed)) continue
      seen.add(trimmed)
      actions.push(trimmed)
    }
    if (actions.length === 0) return
    groups.push({ label, actions })
  }

  push('待机', animations.idle)
  push('转向', animations.turn)
  push('拖拽', animations.drag)
  push('点击回应', animations.clicks)
  push('移动', Array.isArray(animations.moves?.actions)
    ? animations.moves.actions.map((move) => move?.name)
    : [])

  for (const category of Array.isArray(animations.categories) ? animations.categories : []) {
    if (category === null || typeof category !== 'object') continue
    const label = typeof category.id === 'string' ? category.id.trim() : ''
    if (label === '') continue
    push(label, category.actions)
  }

  // 事件档位：槽位可以是字符串，也可以是"档内随机候选"的数组，展平成逐个叶子。
  const events = animations.events
  if (events !== null && typeof events === 'object' && !Array.isArray(events)) {
    for (const [key, pool] of Object.entries(events)) {
      const names = []
      for (const slot of Array.isArray(pool) ? pool : []) {
        if (typeof slot === 'string') names.push(slot)
        else if (Array.isArray(slot)) names.push(...slot.filter((name) => typeof name === 'string'))
      }
      push(MENU_EVENT_LABELS[key] ?? key, names)
    }
  }

  return groups
}

/** 没有 dsh-pet 时的降级：本机素材源的动作清单，平铺一组。 */
export function groupsFromPool (pool) {
  const names = Array.isArray(pool) ? pool : []
  const actions = []
  const seen = new Set()
  for (const name of names) {
    if (actions.length >= MAX_MENU_ACTIONS) break
    if (typeof name !== 'string') continue
    const trimmed = name.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    actions.push(trimmed)
  }
  return actions.length === 0 ? [] : [{ label: '动作', actions }]
}

/** 一级工具项：打开软件只在宿主拿得到 DSH 地址时出现。 */
export function menuTools ({ hasOrigin = false } = {}) {
  const tools = []
  if (hasOrigin) tools.push({ id: 'open-site', label: MENU_TOOL_LABELS['open-site'] })
  tools.push({ id: 'home', label: MENU_TOOL_LABELS.home })
  tools.push({ id: 'reload', label: MENU_TOOL_LABELS.reload })
  return tools
}

/** 合成完整菜单：工具 + 动作分类。两条素材路都空时只剩工具项。 */
export function buildMenu ({ animations = null, pool = [], hasOrigin = false } = {}) {
  const groups = groupsFromAnimations(animations)
  return {
    tools: menuTools({ hasOrigin }),
    groups: groups.length > 0 ? groups : groupsFromPool(pool)
  }
}

/**
 * 从素材目录找 dsh-pet 的 animations 配置：素材目录是 `.../assets/webm`，
 * 配置是它旁边的 `config.jsonc`。找不到/解析不了就返回 null（调用方降级）。
 */
export async function readAnimationsConfig (assetDirs, { readFileImpl = readFile } = {}) {
  for (const dir of Array.isArray(assetDirs) ? assetDirs : []) {
    if (typeof dir !== 'string' || dir === '') continue
    const path = join(dirname(dir), 'config.jsonc')
    let source
    try {
      source = await readFileImpl(path, 'utf8')
    } catch {
      continue
    }
    try {
      const parsed = JSON.parse(stripJsonComments(source))
      const animations = parsed?.animations
      if (animations !== null && typeof animations === 'object' && !Array.isArray(animations)) {
        return { path, animations }
      }
    } catch {
      // 坏 JSON 只跳过这一个源；下一个源可能还有配置
    }
  }
  return null
}
