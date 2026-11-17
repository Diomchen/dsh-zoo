import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 票 78：这只窗口在这台机器上收得到 `WM_LBUTTONUP`，却收不到 `WM_LBUTTONDOWN`
 * （`/dsh-zoo/desktop` 里 `windowMessages.leftDown` 恒 0、`leftUp` 一直在涨），
 * 浏览器因此永远凑不出 `click`：右键菜单能弹，菜单项和面板按钮全点不动。
 *
 * 渲染端的兜底是「up 到了、但这次没看到 down，就在同一位置补一次合成 click」。
 * 这条契约不写死就会在某次重构里悄悄消失，所以按源码断言守住它。
 */

const source = readFileSync(new URL('../desktop/renderer.js', import.meta.url), 'utf8')

test('丢 down 兜底：只有「没看到 down 的那次 up」才补点击', () => {
  assert.match(source, /let lostUpAt = 0/)
  assert.match(source, /if \(lost\) lostUpAt = performance\.now\(\)/)
  assert.match(source, /performance\.now\(\) - lostUpAt > 120/)
})

test('丢 down 兜底：只点真正的可点元素，不碰桌面别的地方', () => {
  const start = source.indexOf('if (lostUpAt === 0')
  assert.ok(start > 0, '兜底点击的入口不见了')
  const body = source.slice(Math.max(0, start - 200), start + 900)
  assert.match(body, /if \(!event\.isTrusted \|\| inputLocked\) return/)
  assert.match(body, /document\.elementFromPoint\(event\.clientX, event\.clientY\)/)
  assert.match(body, /closest\('button, \[data-lp-action\], \.lp-pet'\)/)
  assert.match(body, /dispatchEvent\(new MouseEvent\('click'/)
})

test('丢 down 仍然上报给主进程，主进程那条自愈路径不能断', () => {
  assert.match(source, /api\.reportInput\(lost \? \{ type: 'lost-down' \} : \{ type: kind \}\)/)
})
