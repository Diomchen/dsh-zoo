import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 插件加载器用的是严格 JSON.parse：文件开头只要多一个 BOM 就会
// `Unexpected token '﻿'`，整个 bundle 起不来（1.6.7 真踩过：BOM 是
// PowerShell 5.1 的 `Set-Content -Encoding utf8` 写出来的）。
test('package.json：不能带 BOM，且必须是严格可解析的 JSON', () => {
  const bytes = readFileSync(join(ROOT, 'package.json'))
  assert.notDeepEqual(
    [bytes[0], bytes[1], bytes[2]],
    [0xef, 0xbb, 0xbf],
    'package.json 以 UTF-8 BOM 开头，DSH 加载插件时会报 Unexpected token'
  )
  const text = bytes.toString('utf8')
  const parsed = JSON.parse(text)
  assert.equal(parsed.name, 'dsh-zoo')
  assert.match(parsed.version, /^\d+\.\d+\.\d+$/)
  assert.equal(text, text.trimEnd() + '\n', 'package.json 末尾应当只有一个换行')
})

// 同一次 PowerShell 事故还把 description 写成了「UTF-8 被当 GBK 读」的乱码
// （`灞€鍩熺綉`）。它不影响加载，但 `dsh-market` 列表和 npm 元数据都会显示成那样。
test('package.json：description 仍是正常中文，没有被编码事故写坏', () => {
  const parsed = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.match(parsed.description, /局域网 DSH 宠物/)
  assert.equal(parsed.description.includes('\uFFFD'), false, 'description 里有替换字符')
})
