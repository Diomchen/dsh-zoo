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
