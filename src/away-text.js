/**
 * 「宠物不在家」的人话（ticket 57）。
 *
 * 与 `visit-copy.js` / `gift-text.js` 同一套做法：宿主把一句话算好，渲染端只画。
 * 三个地方共用同一份文案：桌面上的「不在家」胶囊、它的面板标题、邻居小街的抬头。
 *
 * 为什么不在渲染端拼：三种「不在家」下一步完全不同（等它回来 / 等合同到点 / 等这一趟
 * 偷完），文案与行为（召回还是叫它回家）必须同源，否则按钮写着召回、点下去却是结束合同。
 */

import { normalizeNickname } from './protocol.js'

const FALLBACK_NICKNAME = '邻居'
const FALLBACK_PET = '宠物'

/** 三种「不在家」。顺序与 `desktop/shared.js` 的同名白名单一致（改的时候两边一起改）。 */
export const AWAY_MODES = Object.freeze(['visiting', 'raiding', 'working'])

const MODE_SET = new Set(AWAY_MODES)

export function isAwayMode (value) {
  return typeof value === 'string' && MODE_SET.has(value)
}

/**
 * @param {'visiting'|'raiding'|'working'|null} mode
 * @param {string|null} nickname 宠物在哪位邻居那儿（缺省说「邻居」）
 * @param {string|null} petName 我的宠物叫什么（缺省说「宠物」）
 * @returns {{text:string, title:string}} text 给胶囊/小街抬头的一句话；title 带上宠物名字
 */
export function awayText (mode, nickname, petName) {
  const name = normalizeNickname(nickname) ?? FALLBACK_NICKNAME
  const pet = normalizeNickname(petName) ?? FALLBACK_PET
  if (mode === 'working') {
    return { text: `在「${name}」家打工`, title: `${pet}在「${name}」家打工` }
  }
  if (mode === 'raiding') {
    // 偷不是串门：说「去……偷菜了」，不说「在……家」。
    return { text: `去「${name}」家偷菜了`, title: `${pet}去「${name}」家偷菜了` }
  }
  return { text: `在「${name}」家`, title: `${pet}在「${name}」家` }
}
