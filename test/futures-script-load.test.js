/**
 * 票 99 的回归：窗口脚本必须「加载即跑通」。
 *
 * 起因是一个真 bug：`desktop/futures.js` 顶上写 `'use strict'` 换行接 `(function () {`，
 * 被当成 `'use strict'(...)` 调用，一加载就 `TypeError: "use strict" is not a function`，
 * 整扇窗停在「—」占位符上。`npm run check` 只做 `node --check`（语法），抓不到这种运行时炸，
 * 所以这里用一个最小的假 DOM 把脚本真跑起来，再推一份 view 看它有没有画上去。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const CONTRACT = 'tomato-20261117'
// `render()` 用的是真实 `Date.now()`（窗口不信任宿主时钟之外的偏移），
// 所以样例 view 的 `now` 也取当下，免得倒计时落进「本根已结束 → 自动请宿主结算」。
const NOW = Date.now()

function fakeNode (tag = 'div') {
  const node = {
    tagName: tag,
    textContent: '',
    hidden: false,
    disabled: false,
    value: '',
    className: '',
    children: [],
    dataset: {},
    style: {},
    classList: { add () {}, remove () {}, toggle () {} },
    appendChild (child) { this.children.push(child); return child },
    querySelectorAll () { return [] },
    addEventListener () {},
    removeEventListener () {},
    focus () {},
    setAttribute () {},
    getAttribute () { return null }
  }
  return node
}

/** 一扇窗的假 DOM：按 id 记住节点，脚本写过什么都能在测试里读回来。 */
function fakeDocument () {
  const nodes = new Map()
  return {
    nodes,
    getElementById (id) {
      if (!nodes.has(id)) nodes.set(id, fakeNode())
      return nodes.get(id)
    },
    createElement (tag) { return fakeNode(tag) },
    addEventListener () {},
    querySelectorAll () { return [] }
  }
}

function loadWindowScript (file, { bridge, view }) {
  const document = fakeDocument()
  const timers = []
  const sandbox = {
    console,
    document,
    window: {
      dshZooFuturesView: view,
      dshZooFutures: bridge,
      prompt: () => null,
      addEventListener () {}
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout () {},
    setInterval: () => 1,
    clearInterval () {}
  }
  sandbox.globalThis = sandbox
  const source = readFileSync(join(ROOT, 'desktop', file), 'utf8')
  vm.runInNewContext(source, sandbox, { filename: file })
  return { document, timers }
}

function sampleView () {
  const crops = [
    { id: 'tomato', label: '番茄', index: 5, contract: CONTRACT },
    { id: 'carrot', label: '胡萝卜', index: 12, contract: 'carrot-20261117' }
  ]
  const quotes = {
    tomato: { fair: 5.21, bid: 5.2, ask: 5.22, contract: { id: CONTRACT } },
    carrot: { fair: 12.4, bid: 12.38, ask: 12.42, contract: { id: 'carrot-20261117' } }
  }
  return {
    ready: true,
    host: true,
    now: NOW,
    epoch: 'e1',
    mode: 'live',
    accountMode: 'live',
    limits: { leverages: [1, 3, 10, 20] },
    crops,
    quotes,
    balance: 1000,
    marginUsed: 240,
    insurance: 12.5,
    shortfall: 0,
    week: { pnl: 42.5 },
    pending: 0,
    session: { kind: 'trading', text: '本周合约交易中。' },
    positions: [
      { id: 'p1', crop: 'tomato', contract: CONTRACT, side: 'long', lots: 20, entry: 5.12, margin: 240, leverage: 10, unrealized: 18.4 }
    ],
    orders: [
      { id: 'o1', crop: 'carrot', contract: 'carrot-20261117', side: 'long', price: 12.1, lots: 8, lotsLeft: 8, marginFrozen: 96, at: NOW - 60000 }
    ],
    trades: [
      { at: NOW - 120000, crop: 'tomato', contract: CONTRACT, side: 'long', lots: 20, price: 5.12, fee: 0.1, kind: 'open' }
    ]
  }
}

test('desktop/futures.js 加载不炸，推一份 view 能画到 DOM 上', () => {
  const view = require(join(ROOT, 'desktop', 'futures-view.js'))
  const submitted = []
  let onState = null
  const bridge = {
    onState (fn) { onState = fn },
    onResult () {},
    onComposing () {},
    submit (message) { submitted.push(message); return true },
    close () {},
    ready () {}
  }
  const { document } = loadWindowScript('futures.js', { bridge, view })
  assert.equal(typeof onState, 'function', '脚本应该把 onState 接上')

  onState(sampleView())

  assert.equal(document.getElementById('balance').textContent, '1000.00')
  assert.equal(document.getElementById('equity').textContent, '1240.00')
  assert.equal(document.getElementById('insurance').textContent, '12.50')
  assert.equal(document.getElementById('positions').children.length, 1)
  assert.equal(document.getElementById('orders').children.length, 1)
  assert.equal(document.getElementById('trades').children.length, 1)
  assert.equal(document.getElementById('quotes').children.length, 2)
  assert.equal(document.getElementById('countdown').textContent.includes(':'), true)
  assert.equal(document.getElementById('accountChip').textContent, '真钱')
  assert.equal(submitted.length, 0)
})

test('desktop/futures.js 的限价挂单按钮把意图交给宿主，价格与张数不过桥', () => {
  const view = require(join(ROOT, 'desktop', 'futures-view.js'))
  const submitted = []
  let onState = null
  const handlers = new Map()
  const document = fakeDocument()
  const originalGet = document.getElementById.bind(document)
  document.getElementById = (id) => {
    const node = originalGet(id)
    if (!node.__wired) {
      node.__wired = true
      node.addEventListener = (event, fn) => handlers.set(id + ':' + event, fn)
    }
    return node
  }
  const sandbox = {
    console,
    document,
    window: {
      dshZooFuturesView: view,
      dshZooFutures: {
        onState (fn) { onState = fn },
        onResult () {},
        onComposing () {},
        submit (message) { submitted.push(message); return true },
        close () {},
        ready () {}
      },
      prompt: () => null,
      addEventListener () {}
    },
    setTimeout: () => 1,
    clearTimeout () {},
    setInterval: () => 1,
    clearInterval () {}
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(readFileSync(join(ROOT, 'desktop', 'futures.js'), 'utf8'), sandbox, { filename: 'futures.js' })

  // 先把作物清单推下去：`#place` 的作物来自 `state.draft.cropId`，而它由 view 初始化。
  onState(sampleView())
  submitted.length = 0

  originalGet('limitPrice').value = '5.05'
  originalGet('limitLots').value = '3'
  const place = handlers.get('place:click')
  assert.equal(typeof place, 'function', '挂单按钮应该有监听')
  place()

  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].action, 'futures-place')
  assert.equal(submitted[0].price, 5.05)
  assert.equal(submitted[0].lots, 3)
  assert.equal(submitted[0].cropId, 'tomato')
})

test('desktop/futures.js 顶栏的「×」交给宿主关窗（无边框窗口没有系统按钮）', () => {
  const view = require(join(ROOT, 'desktop', 'futures-view.js'))
  const handlers = new Map()
  let closed = 0
  const document = fakeDocument()
  const originalGet = document.getElementById.bind(document)
  document.getElementById = (id) => {
    const node = originalGet(id)
    if (!node.__wired) {
      node.__wired = true
      node.addEventListener = (event, fn) => handlers.set(id + ':' + event, fn)
    }
    return node
  }
  const sandbox = {
    console,
    document,
    window: {
      dshZooFuturesView: view,
      dshZooFutures: {
        onState () {},
        onResult () {},
        onComposing () {},
        submit () { return true },
        close () { closed += 1 },
        ready () {}
      },
      prompt: () => null,
      addEventListener () {}
    },
    setTimeout: () => 1,
    clearTimeout () {},
    setInterval: () => 1,
    clearInterval () {}
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(readFileSync(join(ROOT, 'desktop', 'futures.js'), 'utf8'), sandbox, { filename: 'futures.js' })

  const close = handlers.get('close:click')
  assert.equal(typeof close, 'function', '顶栏 × 应该有监听')
  close()
  assert.equal(closed, 1)

  // 无边框窗口靠这三样才「像一扇窗」：画出来的窗框、能拖的顶栏、看得见的关闭按钮。
  const html = readFileSync(join(ROOT, 'desktop', 'futures.html'), 'utf8')
  assert.match(html, /id="close"/)
  assert.match(html, /-webkit-app-region: drag/)
  assert.match(html, /#app \{[^}]*border: 2px solid/)
})


test('desktop/futures.js 把宿主给的拒绝原因显示出来，而不是「没成交，再试一次」', () => {
  const view = require(join(ROOT, 'desktop', 'futures-view.js'))
  let onResult = null
  const bridge = {
    onState () {},
    onResult (fn) { onResult = fn },
    onComposing () {},
    submit () { return true },
    close () {},
    ready () {}
  }
  const { document } = loadWindowScript('futures.js', { bridge, view })
  assert.equal(typeof onResult, 'function', '脚本应该把 onResult 接上')

  // 宿主给的是 { ok, notice, code }：notice 必须原样显示（1.12.1 之前看的是 message，全被吞掉）。
  onResult({ ok: false, code: 'daily-cap', notice: '今日交易额已到上限：上限 5000 名义，已用 3500，这笔要 1560，明天 00:00 重置。' })
  assert.match(document.getElementById('toast').textContent, /^今日交易额已到上限：/)

  // 宿主没给 notice 时按错误码兜底，至少说出「为什么」。
  onResult({ ok: false, code: 'no-balance' })
  assert.match(document.getElementById('toast').textContent, /余额不够/)

  onResult({ ok: false, code: 'daily-cap' })
  assert.match(document.getElementById('toast').textContent, /明天 00:00/)
})