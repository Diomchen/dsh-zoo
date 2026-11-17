/**
 * `npm run check` 的前半步：把 `desktop/` 下每个窗口脚本都过一遍语法检查。
 *
 * 以前是一串手写 `node --check desktop/xxx.js && …`，加一个窗口就漏一个
 * （`futures*.js` 就是这么漏掉的）。这里按目录扫，新窗口自动纳入。
 * 注意：`node --check` 只看语法，加载期就炸的写法（比如 `'use strict'` 换行接 IIFE）
 * 要靠 `test/futures-script-load.test.js` 那种「真跑一遍」的用例兜。
 */
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(ROOT, 'desktop')
const files = (await readdir(dir)).filter((name) => name.endsWith('.js')).sort()

let failed = 0
for (const name of files) {
  const result = spawnSync(process.execPath, ['--check', join(dir, name)], { encoding: 'utf8' })
  if (result.status === 0) continue
  failed += 1
  console.error(`✗ desktop/${name}`)
  process.stderr.write(result.stderr ?? '')
}
if (failed > 0) {
  console.error(`\n${failed} 个窗口脚本没通过语法检查`)
  process.exit(1)
}
console.log(`✓ desktop/ 下 ${files.length} 个脚本语法检查通过`)
