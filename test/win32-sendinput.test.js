import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * scripts/win32-sendinput.ps1 的契约测试（ticket 30）。
 *
 * 为什么要有它：这个脚本只能在 Windows 上跑，而 0.4.2 现场正是它自己在骗人——名字写着
 * SendInput，实际调的是 mouse_event，于是「真实左键拖不动」被记成了产品缺陷。macOS/Linux
 * 上的 `npm test` 覆盖不到它，所以这里把三条现场结论钉成文本断言：
 *   1. 真的走 SendInput；
 *   2. 声明 DPI 感知（坐标是物理像素）；
 *   3. 按下之前刷新一次 hover 心跳（move / drag 是两个进程，hover 会过期）。
 * 脚本被重构时可以改这里，但要明确知道自己拆掉的是哪一条。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'win32-sendinput.ps1')

const source = await readFile(SCRIPT, 'utf8')

/**
 * 粗暴地去掉注释再断言：说明文字里写「不要用 mouse_event」是对的，
 * 但真的调用它才是缺陷。这一刻粗就够了——这个脚本没有带 # 的字符串。
 */
function stripComments (text) {
  return text
    .replace(/<#[\s\S]*?#>/g, ' ')
    .replace(/(^|\s)#[^\n]*/g, '$1')
}

const code = stripComments(source)
const leftDown = code.indexOf('Mouse(0x0002)')

test('win32-sendinput：真的调用 SendInput，不用 mouse_event 垫片', () => {
  assert.match(code, /SendInput\s*\(/, '必须调用 user32!SendInput')
  assert.doesNotMatch(code, /mouse_event\s*\(/, 'mouse_event 在透明置顶窗上不进真实输入队列（0.4.2 的假通过就是它）')
  assert.match(code, /0x0002/, '要有左键按下（MOUSEEVENTF_LEFTDOWN）')
  assert.match(code, /0x0004/, '要有左键松开（MOUSEEVENTF_LEFTUP）')
})

test('win32-sendinput：声明 DPI 感知，坐标按物理像素解释', () => {
  assert.match(code, /SetProcessDPIAware\s*\(/, '不声明 DPI 感知时 SetCursorPos 的坐标语义会和调用方不一致')
  assert.match(code, /SetCursorPos\s*\(/, '光标要靠 SetCursorPos 挪到宠物上')
})

test('win32-sendinput：按下之前先刷新 hover 心跳', () => {
  assert.ok(leftDown > 0, '脚本里找不到左键按下')
  const moves = (code.slice(0, leftDown).match(/SetCursorPos\s*\(/g) ?? []).length
  // 一次到目标、一次挪开、一次挪回：少一次就没有真实指针事件，渲染端的 hover 会过期。
  assert.ok(moves >= 3,
    '按下之前至少要挪三次光标（到目标 → 挪开 → 挪回），现在只有 ' + moves + ' 次')
})

test('win32-sendinput：保留调用方在用的参数与两个模式', () => {
  assert.match(code, /ValidateSet\('move', 'drag'\)/, 'desktop-smoke.mjs 传的是 -Mode move / -Mode drag')
  assert.match(code, /if \(\$Mode -eq 'move'\) \{ exit 0 \}/, '-Mode move 只挪光标，不能按下')
  for (const name of ['$X', '$Y', '$ToX', '$ToY', '$HoldMs']) {
    assert.ok(code.includes('[int]' + name), '缺参数 ' + name + '：desktop-smoke.mjs 会传它')
  }
})
