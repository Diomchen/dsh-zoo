/**
 * 票 59：`dshzoo://crops/<hash>.<ext>` 的白名单（`desktop/crop-path.js`）。
 *
 * 这条路径给 helper 读 `<dataDir>/crop-art` 用。它跟礼物缩略图是同一类东西：
 * 名字直接来自 URL，必须只认"16 位内容哈希 + svg/png"，别的都当 404。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const cropPath = require('../desktop/crop-path.js')

const HASH = '0123456789abcdef'

test('作物图名：只认 16 位哈希 + svg/png', () => {
  assert.deepEqual(cropPath.parseCropArtName(HASH + '.svg'), { name: HASH + '.svg', ext: 'svg' })
  assert.deepEqual(cropPath.parseCropArtName(HASH + '.PNG'), { name: HASH + '.PNG', ext: 'png' }, '扩展名大小写不敏感')
  assert.equal(cropPath.isCropArtName(HASH + '.svg'), true)
  assert.equal(cropPath.isCropArtName(HASH + '.png'), true)
})

test('作物图名：短哈希、怪扩展名、路径分隔符、空值一律不认', () => {
  for (const bad of [
    null,
    undefined,
    42,
    '',
    '0123.svg',
    HASH + '.webm',
    HASH + '.svg.exe',
    HASH, // 没有扩展名
    '../' + HASH + '.svg',
    HASH + '/../x.svg',
    'AAAABBBBCCCCDDDD.svg',
    HASH + '.svg\u0000'
  ]) {
    assert.equal(cropPath.isCropArtName(bad), false, String(bad))
  }
})

test('作物图的 content-type：svg 用 image/svg+xml，png 用 image/png', () => {
  assert.equal(cropPath.cropArtContentType(HASH + '.svg'), 'image/svg+xml')
  assert.equal(cropPath.cropArtContentType(HASH + '.png'), 'image/png')
  assert.equal(cropPath.cropArtContentType(HASH + '.webm'), null)
})
