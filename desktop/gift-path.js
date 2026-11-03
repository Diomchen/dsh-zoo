'use strict'

/**
 * `localpet://gifts/<礼物目录>/<文件名>` 的路径白名单（ticket 25）。
 *
 * 缩略图是唯一一条「渲染页直接读磁盘」的路径：礼物本体在用户的 `gifts/` 目录里，
 * helper 必须自己把 URL 映射成文件。这里只做三件事，任何一条不满足就返回 null：
 *   1. 目录名必须是 `20261103-153245-ab12cd12` 这种由礼物 store 生成的形状；
 *   2. 文件名不能含路径分隔符/控制字符/前导点，且扩展名只能是 jpg/jpeg/png/gif/webp；
 *   3. 解析出来的绝对路径必须真的落在 gifts 根目录下面（`resolve` + `startsWith(base + sep)`）。
 *
 * CJS：Electron 主进程 require 它，Node 的单测按 CJS 默认导出 import 它。不依赖 Electron。
 */

const path = require('node:path')

/** 与 `src/gifts.js` 的 `GIFT_DIR_RE` 同一个形状（目录名是 store 生成的，不是报文里的）。 */
const GIFT_DIR_RE = /^\d{8}-\d{6}-[0-9a-f]{8}(?:-\d+)?$/
/** 只给这几种图片画缩略图（大小写不敏感）。 */
const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
const MAX_GIFT_NAME = 120
const MAX_GIFT_IMAGE_BYTES = 16 * 1024 * 1024

function isGiftDirName (value) {
  return typeof value === 'string' && GIFT_DIR_RE.test(value)
}

function isSafeGiftFileName (value) {
  if (typeof value !== 'string') return false
  if (value === '' || value.length > 512) return false
  if (value.startsWith('.')) return false
  if (/[/\\\u0000-\u001f\u007f]/.test(value)) return false
  if (Array.from(value).length > MAX_GIFT_NAME) return false
  return Object.prototype.hasOwnProperty.call(IMAGE_TYPES, path.extname(value).toLowerCase())
}

function contentTypeOf (fileName) {
  if (!isSafeGiftFileName(fileName)) return null
  return IMAGE_TYPES[path.extname(fileName).toLowerCase()] ?? null
}

/**
 * 把 URL 里的两段拼成一个绝对路径。`base` 是宿主解析好的 gifts 根目录（绝对路径）。
 * 先用白名单挡掉目录穿越/奇怪名字，再用 resolve + startsWith 夹一次——两层都不省。
 */
function resolveGiftFile (base, dirName, fileName) {
  if (typeof base !== 'string' || base === '' || !path.isAbsolute(base)) return null
  if (!isGiftDirName(dirName) || !isSafeGiftFileName(fileName)) return null
  let root
  try {
    root = path.resolve(base)
  } catch {
    return null
  }
  const candidate = path.resolve(root, dirName, fileName)
  if (!candidate.startsWith(root + path.sep)) return null
  return candidate
}

module.exports = {
  MAX_GIFT_IMAGE_BYTES,
  isGiftDirName,
  isSafeGiftFileName,
  contentTypeOf,
  resolveGiftFile
}
