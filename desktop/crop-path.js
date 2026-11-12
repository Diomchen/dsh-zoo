/**
 * `dshzoo://crops/<hash>.<ext>` 的路径白名单（票 59）。
 *
 * 和礼物缩略图同一套做法：名字只认"16 位十六进制哈希 + svg/png"，别的直接 404。
 * helper 只读宿主准备好的 `<dataDir>/crop-art`，不认包裹之外的任何路径；
 * 哈希由宿主按图内容算（`src/crop-catalog.js` 的 `artFileName`），所以同一个名字
 * 在任何机器上都指向同一张图，缓存也不会串。
 */

'use strict'

const HEX16 = /^[0-9a-f]{16}$/
const EXTENSIONS = ['svg', 'png']
const CONTENT_TYPES = {
  svg: 'image/svg+xml',
  png: 'image/png'
}

/** @returns {{name: string, ext: string} | null} */
function parseCropArtName (value) {
  if (typeof value !== 'string') return null
  if (value === '' || value.length > 32) return null
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return null
  const hash = value.slice(0, dot)
  const ext = value.slice(dot + 1).toLowerCase()
  if (!HEX16.test(hash)) return null
  if (!EXTENSIONS.includes(ext)) return null
  return { name: value, ext }
}

function isCropArtName (value) {
  return parseCropArtName(value) !== null
}

function cropArtContentType (value) {
  const parsed = parseCropArtName(value)
  return parsed === null ? null : CONTENT_TYPES[parsed.ext]
}

module.exports = { parseCropArtName, isCropArtName, cropArtContentType, CROP_ART_EXTENSIONS: EXTENSIONS }
