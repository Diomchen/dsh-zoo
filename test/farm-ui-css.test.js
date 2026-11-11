/**
 * 交易所 / 雇工两页的**样式契约**（静态检查）。
 *
 * 锁的是这次「点了没反应」的根因：`.market-trade .btn.buy` 的优先级高于
 * `.btn:disabled`，灰掉的「买种」和可点的完全同色，点下去又不发申请——用户只能
 * 看到「交易所坏了」。用 Electron 去量 computed style 当然更真，但那要起窗口；
 * 这里直接在 CSS 层面断言那几条上色规则必须带 `:not(:disabled)`，并顺手守住
 * 24px 目标、按钮对比度与禁用色。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const html = await readFile(new URL('../desktop/farm.html', import.meta.url), 'utf8')
const renderer = await readFile(new URL('../desktop/farm.js', import.meta.url), 'utf8')
const styleStart = html.indexOf('<style>')
const styleEnd = html.indexOf('</style>')
const css = html.slice(styleStart + '<style>'.length, styleEnd).replace(/\/\*[\s\S]*?\*\//g, '')

function rules (source) {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let match = re.exec(source)
  while (match !== null) {
    out.push({
      selector: match[1].trim().replace(/\s+/g, ' '),
      body: match[2]
    })
    match = re.exec(source)
  }
  return out
}

const all = rules(css)

function bodyOf (selector) {
  const rule = all.find((candidate) => candidate.selector === selector)
  assert.ok(rule, '应该有一条 ' + selector + ' 规则')
  return rule.body
}

function luminance (hex) {
  const value = hex.replace('#', '')
  const channels = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)))
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast (a, b) {
  const first = luminance(a)
  const second = luminance(b)
  const high = Math.max(first, second)
  const low = Math.min(first, second)
  return (high + 0.05) / (low + 0.05)
}

test('上色的买卖/主按钮规则必须带 :not(:disabled)：否则禁用态和可点态同色', () => {
  const painted = all.filter((rule) => {
    if (!/(background|background-color):/.test(rule.body)) return false
    // `:not(:disabled)` 不是禁用规则；把它剥掉之后还剩 :disabled 的才是禁用规则。
    if (/:disabled/.test(rule.selector.replace(/:not\(:disabled\)/g, ''))) return false
    return /\.market-trade \.btn\.(buy|sell)|\.btn\.primary|\.btn\.danger/.test(rule.selector)
  })
  assert.ok(painted.length >= 3, '应该找到买种/卖出/主按钮三条上色规则')
  for (const rule of painted) {
    assert.match(
      rule.selector,
      /:not\(:disabled\)/,
      '规则「' + rule.selector + '」在禁用态也会上色，必须加 :not(:disabled)'
    )
  }
})

test('禁用按钮有自己的底色/文字色，而且和主按钮不一样', () => {
  const disabled = bodyOf('.btn:disabled, .qty-stepper input:disabled')
  const disabledBg = /background:\s*var\(--disabled-bg\)/.exec(disabled)
  assert.ok(disabledBg, '禁用态必须用 --disabled-bg')
  assert.match(disabled, /cursor:\s*not-allowed/)
  const bg = /--disabled-bg:\s*(#[0-9a-f]{6})/i.exec(css)
  const line = /--disabled-line:\s*(#[0-9a-f]{6})/i.exec(css)
  const ink = /--disabled-ink:\s*(#[0-9a-f]{6})/i.exec(css)
  assert.ok(bg && line && ink, '禁用三色 token 必须存在')
  const green = /--emerald-btn:\s*(#[0-9a-f]{6})/i.exec(css)
  assert.ok(green, '--emerald-btn 必须存在')
  assert.notEqual(bg[1].toLowerCase(), green[1].toLowerCase(), '禁用底色不能还是主按钮的绿')
})

test('按钮目标至少 24×24 CSS px（WCAG 2.2 AA），主按钮 28px', () => {
  const btn = bodyOf('.btn')
  const height = /min-height:\s*(\d+)px/.exec(btn)
  assert.ok(height, '.btn 必须有 min-height')
  assert.ok(Number(height[1]) >= 24, '.btn 的 min-height 至少 24px，实际 ' + height[1])
  const stepper = /\.qty-stepper \{([^}]*)\}/.exec(css)
  assert.ok(stepper, '数量步进器必须有尺寸')
  assert.match(stepper[1], /height:\s*28px/)
})

test('白字主按钮与琥珀卖出按钮都达到 4.5:1', () => {
  const green = /--emerald-btn:\s*(#[0-9a-f]{6})/i.exec(css)[1]
  const amberInk = /--amber-ink:\s*(#[0-9a-f]{6})/i.exec(css)[1]
  const sellBg = /\.market-trade \.btn\.sell:not\(:disabled\) \{([^}]*)\}/.exec(css)
  assert.ok(sellBg, '卖出按钮必须有 :not(:disabled) 的描边样式')
  const sellHex = /background:\s*(#[0-9a-f]{6})/i.exec(sellBg[1])
  assert.ok(sellHex, '卖出按钮必须给底色')
  assert.ok(contrast('#ffffff', green) >= 4.5, '白字在买种绿上只有 ' + contrast('#ffffff', green).toFixed(2) + ':1')
  assert.ok(contrast(amberInk, sellHex[1]) >= 4.5, '卖出文字对比度 ' + contrast(amberInk, sellHex[1]).toFixed(2) + ':1')
})

test('窗口里有「不能点」的原因：每行一个 hint，并挂在按钮的 aria-describedby 上', () => {
  assert.match(css, /\.trade-hint\[data-tone='warn'\]/, 'hint 需要一档「不能点」的颜色')
  assert.match(renderer, /data-trade-hint/, '行里要有 hint 节点')
  assert.match(renderer, /aria-describedby.*trade-hint/, '买卖按钮要引用这行解释')
  assert.match(renderer, /buyShort|sellShort/, '禁用按钮自己的短标签要说明原因')
  const hint = /\.trade-hint \{([^}]*)\}/.exec(css)
  assert.ok(hint, '.trade-hint 必须有样式')
  const hintHeight = /min-height:\s*(\d+)px/.exec(hint[1])
  assert.ok(hintHeight, 'hint 行要预留高度，出现时不推走按钮')
  assert.ok(Number(hintHeight[1]) >= 16, 'hint 行高度要够放下 9.5px 文字')
  assert.match(hint[1], /color:\s*var\(--muted\)/)
})

test('雇工表单有就地错误：每个字段一个 aria-describedby 的错误位', () => {
  for (const id of ['hire-wage', 'hire-min', 'hire-max']) {
    assert.match(html, new RegExp('id="' + id + '"[^>]*aria-describedby="' + id + '-error"'), id + ' 要挂错误位')
    assert.match(html, new RegExp('id="' + id + '-error"'), id + ' 的错误位要存在')
  }
  assert.match(css, /\.hire-field input\[type='number'\]\[aria-invalid='true'\]/)
  assert.match(renderer, /不能超过最长/)
  assert.match(renderer, /不能短于最短/)
})
