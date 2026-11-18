/**
 * 农场小窗的替身 DOM 测试床（票 61 抽出来的，票 52 回归复用）。
 *
 * 把**真的** `desktop/farm.js` 跑进 vm：它加载时自己注册 `onState`，测试用 `pushState()`
 * 推宿主下发的整包，用 `tick()` 跑一拍 `setInterval`，用 `advance()` 推假时钟
 * （模拟渲染进程被后台节流：真实过了 5 秒，但只跑了一拍）。
 *
 * 时钟由测试推、interval 不自动跑——「按真实时间走」和「到点确认」这两条
 * 才测得准；换成真 setInterval + 睡觉就会既慢又飘。
 *
 * 只覆盖窗口的**纯渲染行为**：不 spawn Electron、不开端口、不读盘。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const farmView = require('../../desktop/farm-view.js')
const FARM_JS = readFileSync(new URL('../../desktop/farm.js', import.meta.url), 'utf8')

/** 替身元素：够 farm.js 与 farm-view.js 画东西、改文本。 */
export function fakeElement (tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    className: '',
    dataset: {},
    style: {},
    children: [],
    attributes: {},
    hidden: false,
    disabled: false,
    title: '',
    value: '',
    type: '',
    classList: { toggle () {}, add () {}, remove () {}, contains () { return false } },
    appendChild (child) { this.children.push(child); return child },
    setAttribute (name, value) { this.attributes[name] = String(value) },
    getAttribute (name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
    },
    removeEventListener () {},
    addEventListener (type, fn) { (this._listeners ??= {})[type] = fn },
    focus () {},
    remove () {},
    contains () { return false },
    querySelector () { return null },
    querySelectorAll () { return [] },
    closest () { return null },
    matches () { return false },
    getBoundingClientRect () { return { width: 0, height: 0, x: 0, y: 0, top: 0, left: 0 } }
  }
  // 真 DOM 里给容器赋空 textContent 会把子节点清掉，列表渲染全靠这一点；替身不能只当普通属性存。
  let text = ''
  Object.defineProperty(element, 'textContent', {
    get () { return text },
    set (value) {
      text = value === null || value === undefined ? '' : String(value)
      if (text === '') element.children.length = 0
    }
  })
  return element
}

/**
 * 起一个装了真 farm.js 的替身窗口。
 *
 * 返回的 `created` 是窗口画过的全部节点（按创建顺序），测试可以按 `dataset` / `className`
 * 找按钮并点它——这样连"点「我的农场」发哪条动作"都是真代码在跑。
 */
export function bootFarm () {
  let nowMs = 1_700_000_000_000
  class FakeDate extends Date {
    constructor (...args) {
      if (args.length === 0) super(nowMs)
      else super(...args)
    }

    static now () { return nowMs }
  }
  const byId = new Map()
  const tabs = ['farm', 'market', 'hire', 'log'].map((name) => {
    const el = fakeElement('button')
    el.dataset.tab = name
    el._listeners = {}
    return el
  })
  const created = []
  const submits = []
  const results = []
  let onState = null
  let onResult = null
  const document = {
    activeElement: null,
    getElementById (id) {
      if (!byId.has(id)) byId.set(id, fakeElement('div'))
      return byId.get(id)
    },
    createElement (tag) {
      const el = fakeElement(tag)
      created.push(el)
      return el
    },
    querySelector (selector) {
      return selector === '.tabs' ? fakeElement('div') : null
    },
    querySelectorAll (selector) {
      return selector === '.tab[data-tab]' ? tabs : []
    },
    addEventListener () {},
    removeEventListener () {}
  }
  const ticks = []
  const api = {
    ready () {},
    close () {},
    submit (payload) { submits.push(payload) },
    onState (fn) { onState = fn },
    onResult (fn) { onResult = fn }
  }
  const sandbox = {
    window: {
      dshZooFarm: api,
      dshZooFarmView: farmView,
      addEventListener () {},
      removeEventListener () {}
    },
    document,
    Element: class Element {},
    setInterval (fn) { ticks.push(fn); return ticks.length },
    setTimeout () { return 0 },
    clearInterval () {},
    clearTimeout () {},
    requestAnimationFrame () { return 0 },
    console,
    Date: FakeDate,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    JSON,
    Intl
  }
  sandbox.globalThis = sandbox
  sandbox.window.window = sandbox.window
  vm.runInNewContext(FARM_JS, sandbox, { filename: 'desktop/farm.js' })

  return {
    tabs,
    created,
    submits,
    results,
    pushState (payload) {
      assert.equal(typeof onState, 'function', 'farm.js 应该在加载时注册 onState')
      onState(payload)
    },
    /** 宿主回执（`action-result`）：窗口据此复位 busy / 静默处理「到点确认」。 */
    pushResult (result) {
      assert.equal(typeof onResult, 'function', 'farm.js 应该在加载时注册 onResult')
      onResult(result)
    },
    clickTab (name) {
      const el = tabs.find((tab) => tab.dataset.tab === name)
      assert.ok(el, '应该有 ' + name + ' 页签')
      el._listeners.click?.()
    },
    /** 按 id 拿窗口里的元素（`document.getElementById` 的那个替身，带 hidden/textContent）。 */
    element (id) {
      return document.getElementById(id)
    },
    /** 按条件找窗口画过的节点（找按钮并点它用）。 */
    find (predicate) {
      for (let index = created.length - 1; index >= 0; index -= 1) {
        if (predicate(created[index])) return created[index]
      }
      return null
    },
    /** 只推时钟，不跑 interval：模拟 interval 被节流/延迟。 */
    advance (ms) { nowMs += ms },
    /** 跑一拍 setInterval。 */
    tick () { for (const fn of ticks) fn() },
    now () { return nowMs }
  }
}
