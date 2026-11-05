/**
 * 票 25：`dshzoo://gifts/<目录>/<文件名>` 的路径白名单。
 *
 * 这条路径是渲染页唯一能直接读到磁盘的入口，所以单测把「目录名形状、文件名、
 * 扩展名白名单、夹取」逐条钉住。模块是 CJS（Electron 主进程 require 它），
 * 这里按默认导出 import。
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import giftPath from '../desktop/gift-path.js'

const DIR = '20261103-153245-ab12cd12'
const BASE = '/tmp/dsh-zoo/gifts'

test('resolveGiftFile：只认两段合法名字，解析出的绝对路径必须在 gifts 根下面', () => {
  assert.equal(
    giftPath.resolveGiftFile(BASE, DIR, 'thumb.png'),
    join(BASE, DIR, 'thumb.png')
  )
  assert.equal(
    giftPath.resolveGiftFile(BASE, DIR, '报价 单.JPG'),
    join(BASE, DIR, '报价 单.JPG')
  )
  // 目录名必须是 store 生成的形状。
  for (const dir of ['', '.', '..', '../etc', '20261103-153245-zzzzzzzz', '2026-11-03-ab12cd12', DIR + '/x']) {
    assert.equal(giftPath.resolveGiftFile(BASE, dir, 'thumb.png'), null, dir)
  }
  // 文件名不能带路径分隔符、控制字符、前导点，也不能是别的扩展名。
  for (const name of [
    '', '.', '..', '.hidden.png', 'a/b.png', 'a\\b.png', 'a\u0000b.png',
    'note.txt', 'clip.webm', 'image.png.js', 'x'.repeat(121) + '.png'
  ]) {
    assert.equal(giftPath.resolveGiftFile(BASE, DIR, name), null, name)
  }
  // 根目录必须是绝对路径。
  assert.equal(giftPath.resolveGiftFile('relative/gifts', DIR, 'thumb.png'), null)
  assert.equal(giftPath.resolveGiftFile('', DIR, 'thumb.png'), null)
})

test('resolveGiftFile：即使名字绕过白名单，resolve/startsWith 也会把它夹在根里', () => {
  // 这两条名字本来就会被白名单挡掉；这里断言“就算以后放宽白名单，夹取仍然有效”。
  const escaped = giftPath.resolveGiftFile(BASE, DIR, '..%2F..%2Fsecret.png')
  assert.equal(escaped, null)
  const up = giftPath.resolveGiftFile(BASE, DIR, '../../secret.png')
  assert.equal(up, null)
  // 合法情况下解析结果一定以 base + sep 开头。
  const ok = giftPath.resolveGiftFile(BASE, DIR, 'a.png')
  assert.equal(ok.startsWith(BASE + '/'), true)
})

test('contentTypeOf：只给四种图片类型；别的返回 null', () => {
  assert.equal(giftPath.contentTypeOf('a.jpg'), 'image/jpeg')
  assert.equal(giftPath.contentTypeOf('a.JPEG'), 'image/jpeg')
  assert.equal(giftPath.contentTypeOf('a.png'), 'image/png')
  assert.equal(giftPath.contentTypeOf('a.gif'), 'image/gif')
  assert.equal(giftPath.contentTypeOf('a.webp'), 'image/webp')
  assert.equal(giftPath.contentTypeOf('a.svg'), null)
  assert.equal(giftPath.contentTypeOf('a.html'), null)
  assert.equal(giftPath.contentTypeOf('../a.png'), null)
})
