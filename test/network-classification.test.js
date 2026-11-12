/**
 * 票 60：测试分档的兜底。
 *
 * 默认 `npm test` 只跑核心用例。这条测试扫所有 `test/*.test.js` 的源码：只要出现
 * `node:dgram` / `node:net`、`createServer(`、`.listen(`、`createSocket(` 这类写法，
 * 它就必须在 `scripts/test-groups.mjs` 的 `NETWORK_TESTS` 里——否则默认测试会偷偷开 socket。
 *
 * 反过来也查一遍：清单里的文件如果其实已经不开 socket，也报错，免得清单越积越脏。
 */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { NETWORK_TESTS, SOCKET_ALLOWLIST, SOCKET_PATTERN } from '../scripts/test-groups.mjs'

const TEST_DIR = new URL('../test/', import.meta.url)

async function testFiles () {
  return (await readdir(TEST_DIR)).filter((name) => name.endsWith('.test.js')).sort()
}

test('开了 socket 的用例必须列进 NETWORK_TESTS', async () => {
  const offenders = []
  for (const name of await testFiles()) {
    if (name === 'network-classification.test.js') continue
    if (SOCKET_ALLOWLIST.has(name)) continue
    const source = await readFile(join(TEST_DIR.pathname, name), 'utf8')
    if (!SOCKET_PATTERN.test(source)) continue
    if (!NETWORK_TESTS.has(name)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], '这些用例会开 socket，但不在网络档里：' + offenders.join(', '))
})

test('NETWORK_TESTS 里不该有已经不开 socket 的用例', async () => {
  const stale = []
  for (const name of NETWORK_TESTS) {
    let source = ''
    try {
      source = await readFile(join(TEST_DIR.pathname, name), 'utf8')
    } catch {
      stale.push(name + '（文件不存在）')
      continue
    }
    if (!SOCKET_PATTERN.test(source)) stale.push(name)
  }
  assert.deepEqual(stale, [], '清单里这些用例已经不开 socket 了，应该移出网络档：' + stale.join(', '))
})

test('分档清单本身有内容，且两个清单不重叠', async () => {
  const all = new Set(await testFiles())
  assert.ok(NETWORK_TESTS.size > 0)
  for (const name of NETWORK_TESTS) {
    assert.ok(all.has(name), '网络档里的 ' + name + ' 应该是真实存在的用例文件')
  }
  for (const name of SOCKET_ALLOWLIST) {
    assert.equal(NETWORK_TESTS.has(name), false, name + ' 不能同时在豁免名单和网络档里')
  }
})
