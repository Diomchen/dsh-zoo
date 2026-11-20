/**
 * 盘口小窗的位置（ADR-0029 / 票 85）：纯坐标算术，单独一份、可单测。
 *
 * 为什么单独抽出来：`desktop/main.js` 一加载就要 `electron`，Node 测试跑不起来；
 * 但“上次拖到哪、换屏后夹到哪”全是普通数学，完全可以在没有 Electron 的情况下验。
 *
 * 约定：
 *   - 保存的是窗口左上角（`getBounds()` 的 x/y，屏幕 DIP），不是标题栏中心；
 *   - 保存点必须落在某块显示器的工作区里，否则视为「离屏」（显示器拔掉/分辨率变了），
 *     回落成今天开窗时的居中位置。这是票 85 的明确取舍，不是“尽量夹回来”；
 *   - 保存点还在某块屏里时，窗口整体夹进**那块屏**的工作区（多屏时不是主屏），
 *     保证标题栏和右上角 × 都还点得到。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** 和农场窗的 `farm-window.json` 放在同一个 userData 目录下。 */
const BOARD_POSITION_FILE = 'board-window.json'
/** 期货小窗（票 93）自己一份：两扇窗可以拖到不同位置。 */
const FUTURES_POSITION_FILE = 'futures-window.json'
/** 出远门小窗（票 112）自己一份。 */
const EXPEDITION_POSITION_FILE = 'expedition-window.json'
/** 窗口边缘留 8px：和改名/农场/盘口原来的居中夹取同一个数。 */
const DEFAULT_EDGE_MARGIN = 8

function isFiniteNumber (value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** `{ x, y }` 只接受真正的有限数字；JSON 里的字符串/NaN/数组一律当没有。 */
function normalizePoint (point) {
  if (point === null || typeof point !== 'object' || Array.isArray(point)) return null
  if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return null
  return { x: point.x, y: point.y }
}

function normalizeArea (area) {
  if (area === null || typeof area !== 'object' || Array.isArray(area)) return null
  if (!isFiniteNumber(area.x) || !isFiniteNumber(area.y)) return null
  if (!isFiniteNumber(area.width) || !isFiniteNumber(area.height)) return null
  if (area.width <= 0 || area.height <= 0) return null
  return { x: area.x, y: area.y, width: area.width, height: area.height }
}

function normalizeSize (size) {
  if (size === null || typeof size !== 'object' || Array.isArray(size)) return null
  if (!isFiniteNumber(size.width) || !isFiniteNumber(size.height)) return null
  if (size.width <= 0 || size.height <= 0) return null
  return { width: size.width, height: size.height }
}

/** 屏幕坐标点是否落在这块工作区里（含边界：贴边也算“在屏里”，再交给夹取）。 */
function isInsideArea (point, area) {
  const normalizedPoint = normalizePoint(point)
  const normalizedArea = normalizeArea(area)
  if (normalizedPoint === null || normalizedArea === null) return false
  return normalizedPoint.x >= normalizedArea.x &&
    normalizedPoint.x <= normalizedArea.x + normalizedArea.width &&
    normalizedPoint.y >= normalizedArea.y &&
    normalizedPoint.y <= normalizedArea.y + normalizedArea.height
}

/** 把窗口整体夹进这块工作区；窗口比工作区还大时贴左上角留一个边距。 */
function clampToWorkArea (point, area, size, margin = DEFAULT_EDGE_MARGIN) {
  const normalizedPoint = normalizePoint(point)
  const normalizedArea = normalizeArea(area)
  const normalizedSize = normalizeSize(size)
  if (normalizedPoint === null || normalizedArea === null || normalizedSize === null) {
    return { x: 0, y: 0 }
  }
  const edge = isFiniteNumber(margin) && margin >= 0 ? margin : DEFAULT_EDGE_MARGIN
  const minX = normalizedArea.x + edge
  const minY = normalizedArea.y + edge
  const maxX = Math.max(minX, normalizedArea.x + normalizedArea.width - normalizedSize.width - edge)
  const maxY = Math.max(minY, normalizedArea.y + normalizedArea.height - normalizedSize.height - edge)
  return {
    x: Math.round(Math.min(Math.max(normalizedPoint.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(normalizedPoint.y, minY), maxY))
  }
}

/**
 * 今天开窗用的居中位置：先居中，再夹进工作区。
 * 和票 79 的 `boardBounds()` 完全同一条公式，所以坏文件/离屏时用户看到的位置不变。
 */
function centerInArea (area, size, margin = DEFAULT_EDGE_MARGIN) {
  const normalizedArea = normalizeArea(area)
  const normalizedSize = normalizeSize(size)
  if (normalizedArea === null || normalizedSize === null) return { x: 0, y: 0 }
  return clampToWorkArea({
    x: normalizedArea.x + (normalizedArea.width - normalizedSize.width) / 2,
    y: normalizedArea.y + (normalizedArea.height - normalizedSize.height) / 2
  }, normalizedArea, normalizedSize, margin)
}

/**
 * 开窗位置：有合法且仍在屏里的保存点就用它（夹进那块屏），否则回落到居中。
 *
 * @param {object} options
 * @param {{x:number,y:number}|null} options.saved 上次保存的位置
 * @param {Array<object>} [options.areas] 所有显示器的工作区（多屏时用来挑保存点所在的那块）
 * @param {object} options.area 主工作区；所有工作区都拿不到时的兜底
 * @param {number} options.width 窗口宽
 * @param {number} options.height 窗口高
 * @param {number} [options.margin] 边缘留白
 * @returns {{x:number,y:number}}
 */
function pickBounds ({ saved, areas, area, width, height, margin = DEFAULT_EDGE_MARGIN } = {}) {
  const size = normalizeSize({ width, height })
  const fallbackArea = normalizeArea(area)
  if (size === null || fallbackArea === null) return { x: 0, y: 0 }

  const savedPoint = normalizePoint(saved)
  if (savedPoint === null) return centerInArea(fallbackArea, size, margin)

  const candidates = []
  if (Array.isArray(areas)) {
    for (const candidate of areas) {
      const normalized = normalizeArea(candidate)
      if (normalized !== null) candidates.push(normalized)
    }
  }
  // 一块真实显示器都没拿到（旧宿主/极端环境）才用兜底区；**不能**把多屏并集塞进来——
  // 并集包含屏幕之间的空隙和菜单栏上沿，会让“离屏”的保存点被误判成在屏里。
  if (candidates.length === 0) candidates.push(fallbackArea)

  // 保存点必须在某块真实工作区里；在两块屏的接缝上时两块都“包含”它，
  // 这时选位移最小的那块（接缝属于副屏，不能被主屏的右边缘夹回去）。
  let best = null
  let bestDistance = Infinity
  for (const candidate of candidates) {
    if (!isInsideArea(savedPoint, candidate)) continue
    const clamped = clampToWorkArea(savedPoint, candidate, size, margin)
    const distance = (clamped.x - savedPoint.x) ** 2 + (clamped.y - savedPoint.y) ** 2
    if (distance < bestDistance) {
      best = clamped
      bestDistance = distance
    }
  }
  // 保存点不在任何工作区里 = 离屏（票 85 的明确回落条件），不是“夹到最近的边上”。
  if (best === null) return centerInArea(fallbackArea, size, margin)
  return best
}

/**
 * 读 `userData/board-window.json`。坏文件、缺文件、旧版本留下的坏形状都返回 null，
 * 让调用方直接走居中；窗口位置不值得让 helper 报错或阻止开窗。
 */
function readPosition (file, fileSystem = fs) {
  if (typeof file !== 'string' || file === '') return null
  try {
    const raw = fileSystem.readFileSync(file, 'utf8')
    return normalizePoint(JSON.parse(raw))
  } catch {
    return null
  }
}

/** 写位置；只写 `{ x, y }`。写不进去只影响下次开窗，不影响这次拖动。 */
function writePosition (file, point, fileSystem = fs) {
  const normalizedPoint = normalizePoint(point)
  if (typeof file !== 'string' || file === '' || normalizedPoint === null) return false
  try {
    fileSystem.mkdirSync(path.dirname(file), { recursive: true })
    fileSystem.writeFileSync(file, JSON.stringify(normalizedPoint, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

module.exports = {
  BOARD_POSITION_FILE,
  FUTURES_POSITION_FILE,
  EXPEDITION_POSITION_FILE,
  DEFAULT_EDGE_MARGIN,
  normalizePoint,
  isInsideArea,
  clampToWorkArea,
  centerInArea,
  pickBounds,
  readPosition,
  writePosition
}
