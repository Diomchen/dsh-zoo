/**
 * 桌面脚本「装得下、跑得动」的回归（票 120 之后补的）。
 *
 * 由来：`desktop/expedition.js` 曾经是
 *
 *     'use strict'
 *     (function () { ... })()
 *
 * `(` 在新行不会触发 ASI，整份脚本被解析成 `'use strict'(...)` 的调用，
 * 一加载就抛 `TypeError: "use strict" is not a function`——窗口只剩静态 HTML，
 * 所有按钮都是死的。`node --check` 只做语法检查，`check-desktop.mjs` 也是，
 * 所以这条必须用「真的执行一遍」来守。
 *
 * 覆盖：
 *   1. 静态守卫：没有哪个桌面脚本把指令直接接在 `(` 前面；
 *   2. 冒烟：在最小 DOM 桩里执行 `desktop/expedition.js`，必须走完初始化，
 *      只允许因为「环境里没有 Electron」而停下，不允许一开头就崩。
 */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop')

/** 指令语句后面紧接 `(` 的写法：ASI 不会补分号，`(` 变成调用。 */
const DIRECTIVE_THEN_CALL = /(?:^|\n)\s*(['"])use strict\1\s*\r?\n\s*\(/

/** 去掉注释再判：注释夹在指令和 `(` 之间同样拦不住 ASI，不能让它躲过去。 */
function stripComments (source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
}

test('桌面脚本没有「指令 + 换行 + (」的 ASI 陷阱', async () => {
  const names = (await readdir(DESKTOP)).filter((name) => name.endsWith('.js')).sort()
  assert.ok(names.length > 10, '桌面脚本应当不止十个，路径可能错了')

  const offenders = []
  for (const name of names) {
    const source = await readFile(join(DESKTOP, name), 'utf8')
    if (DIRECTIVE_THEN_CALL.test(stripComments(source))) offenders.push(name)
  }
  assert.deepEqual(offenders, [], '这些脚本会在加载时抛 TypeError："use strict" is not a function')
})

/**
 * 够用的假元素：任何属性都当成可调用的空函数，`classList` / `dataset` 之类
 * 递归返回自身，`textContent` 之类允许赋值。
 */
function fakeElement () {
  const target = {
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    checked: false,
    style: {},
    dataset: {},
    children: [],
    classList: { add () {}, remove () {}, toggle () {}, contains () { return false } },
    append () {},
    appendChild () {},
    removeChild () {},
    remove () {},
    setAttribute () {},
    getAttribute () { return null },
    hasAttribute () { return false },
    addEventListener () {},
    removeEventListener () {},
    focus () {},
    blur () {},
    querySelector () { return fakeElement() },
    querySelectorAll () { return [] },
    closest () { return null },
    replaceChildren () {},
    insertBefore () {},
    contains () { return false }
  }
  return new Proxy(target, {
    get (obj, key) {
      if (key in obj) return obj[key]
      if (typeof key === 'symbol') return undefined
      return () => fakeElement()
    },
    set (obj, key, value) { obj[key] = value; return true }
  })
}

function bootSandbox (source) {
  const document = {
    getElementById () { return fakeElement() },
    querySelector () { return fakeElement() },
    querySelectorAll () { return [] },
    createElement () { return fakeElement() },
    addEventListener () {},
    body: fakeElement(),
    documentElement: fakeElement()
  }
  // 计时器只发号、不排程：冒烟测试关心的是「加载时会不会当场崩」，
  // 真让 1 秒一跳的时钟跑起来会把测试进程一直挂着。
  let timerId = 0
  const sandbox = {
    document,
    console,
    setTimeout: () => ++timerId,
    clearTimeout: () => {},
    setInterval: () => ++timerId,
    clearInterval: () => {},
    Date,
    Math,
    JSON,
    Intl
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.dshZooExpedition = {
    onState () {},
    onResult () {},
    ready () {},
    submit () {},
    close () {}
  }
  sandbox.dshZooExpeditionView = {
    routeOf: () => null,
    legsFor: () => 4,
    dangerOf: () => 0,
    dangerLabel: () => '低',
    isActiveRun: () => false,
    tripLog: () => ({ title: '', body: '' }),
    phaseLabel: () => '',
    clockLabel: () => '',
    coinLabel: () => '',
    lootLabel: () => '',
    settleLabel: () => ({ title: '', lines: [] }),
    codexView: () => ({ slots: [], total: 0 }),
    shelfView: () => ({ slots: [], items: [] }),
    startLabel: () => '',
    routeCard: () => ({ title: '', hint: '', desc: '' })
  }
  return vm.createContext(sandbox)
}

test('desktop/expedition.js 在最小 DOM 桩里能跑完初始化', async () => {
  const source = await readFile(join(DESKTOP, 'expedition.js'), 'utf8')
  const context = bootSandbox(source)

  assert.doesNotThrow(
    () => vm.runInContext(source, context, { filename: 'desktop/expedition.js' }),
    '窗口脚本一加载就抛异常的话，界面上的按钮一个都不会有反应'
  )
})
