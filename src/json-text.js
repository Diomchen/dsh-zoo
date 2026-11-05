/**
 * 读本机 JSON 文件时的第一道清理：剥掉 UTF-8 BOM。
 *
 * 为什么值得单独一个模块：Windows 的两个常见写法都会写 BOM——
 * `PowerShell Set-Content -Encoding utf8`（PS 5.1）和记事本的"UTF-8"选项——
 * 而 `JSON.parse` 不认它。后果按文件不同，但都不轻：
 *   - `skin.json` 带 BOM → 被当成坏文件，静默回落自动源，用户只看到"第二张皮没了"；
 *   - `identity.json` 带 BOM → 解析失败 → 当场换一个新 deviceId，邻居把你当新机器；
 *   - `settings.json` / `peers.json` / `visits.json` / `backpack.json` → 静默回默认值。
 *
 * 这里只做"文本 → 文本"，各文件自己的容错策略（回默认 / 回空 / 抛）留在调用处。
 */

export const BOM = '\uFEFF'

/** @param {unknown} text @returns {unknown} 去掉开头一个 BOM 的同一个字符串 */
export function stripBom (text) {
  if (typeof text !== 'string') return text
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 本机 JSON 文件专用：先剥 BOM 再 parse。
 * 坏 JSON 照常抛给调用方——每个文件的"坏了怎么办"不一样，这里不替它们决定。
 */
export function parseJsonText (text) {
  return JSON.parse(stripBom(text))
}
