/**
 * 票 61：雇工页的合同倒计时必须按真实时间走，而且不能倒流。
 *
 * 症状（ticket 47.1 的同一条毛病，当时只修了地块）：
 *   1. `tickContracts` 每拍固定减 1000ms——渲染进程被后台节流/长任务延迟时，
 *      倒计时就慢下来（时间不准）；
 *   2. `contractRow` 每次都拿**快照那一刻**的 remainingMs 重建，而 `renderHire()`
 *      会因为切页/任何一次重画再跑一遍——倒计时于是被拽回旧值（时间倒流）。
 *
 * 这个测试把真的 `desktop/farm.js` 放进替身 DOM 里跑（不是读源码做正则），
 * 用可控时钟模拟「阻塞 5 秒只跑了一拍」和「切走 3 秒再回来」。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const farmView = require('../desktop/farm-view.js')
const FARM_JS = readFileSync(new URL('../desktop/farm.js', import.meta.url), 'utf8')

const CONTRACT_ID = '11111111-1111-4111-8111-111111111111'

/** 替身元素：够 farm.js 与 farm-view.js 画东西、改文本。 */
function fakeElement (tag) {
  return {
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
    textContent: '',
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
}

function contractState (remainingMs) {
  return {
    farm: {
      unlocked: 4,
      maxPlots: 50,
      nextCost: 60,
      plots: [
        { id: 'p1', crop: 'tomato', stage: 'growing', mature: false, remainingMs: 30 * 60 * 1000, waterings: 0, fertilized: false }
      ],
      seeds: { tomato: 2, carrot: 0, pumpkin: 0 },
      crops: { tomato: 0, carrot: 0, pumpkin: 0 },
      coins: 30,
      dew: 5,
      worker: null,
      contractCount: 1,
      hire: { enabled: true, wagePerHour: 10, minHours: 2, maxHours: 8 },
      guard: 0.8,
      log: [],
      carried: []
    },
    market: { prices: {}, index: {}, history: [] },
    crops: null,
    contracts: {
      outgoing: [{
        id: CONTRACT_ID,
        workerNickname: '阿蟹',
        hours: 2,
        wagePerHour: 10,
        wage: 20,
        fee: 1,
        status: 'active',
        earned: 0,
        remainingMs,
        settled: false
      }],
      incoming: [],
      listings: [],
      pendingHire: false
    },
    mode: 'owner',
    visit: null,
    look: null,
    neighbors: [],
    plotId: null
  }
}

/**
 * 把真的 farm.js 跑进替身 DOM。时钟由测试推：`advance(ms)` 之后不会自动跑 interval，
 * 这样才能模拟「阻塞 5 秒，期间只跑到一拍」。
 */
function bootFarm () {
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
  let onState = null
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
    onResult () {}
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

  const metaEl = () => {
    for (let index = created.length - 1; index >= 0; index -= 1) {
      if (created[index].dataset?.contractMeta === CONTRACT_ID) return created[index]
    }
    return null
  }
  return {
    tabs,
    submits,
    pushState (payload) {
      assert.equal(typeof onState, 'function', 'farm.js 应该在加载时注册 onState')
      onState(payload)
    },
    clickTab (name) {
      const el = tabs.find((tab) => tab.dataset.tab === name)
      assert.ok(el, '应该有 ' + name + ' 页签')
      el._listeners.click?.()
    },
    /** 只推时钟，不跑 interval：模拟 interval 被节流/延迟。 */
    advance (ms) { nowMs += ms },
    /** 跑一拍 setInterval。 */
    tick () { for (const fn of ticks) fn() },
    now () { return nowMs },
    metaEl,
    metaText () {
      const el = metaEl()
      return el === null ? null : el.textContent
    }
  }
}

test('倒计时纯函数：按真实时间走，时钟被调到过去也不往回涨', () => {
  assert.equal(farmView.remainingAt(90_000, 1000, 3000), 88_000, '过了 2 秒就少 2 秒')
  assert.equal(farmView.remainingAt(90_000, 1000, 500), 90_000, 'now 早于基线（时钟被调回去）只停在原值')
  assert.equal(farmView.remainingAt(90_000, 1000, 100_000), 0, '不能出现负数')
  assert.equal(farmView.remainingAt(undefined, undefined, 5000, 1234), 1234, '老快照没有基线时退回 remainingMs')
  assert.equal(farmView.remainingAt(undefined, undefined, 5000), 0, '什么都没有就是 0，不是 NaN')
})

/** 从「还剩 1 分 30 秒 · 托管 20 · 手续费 1」里取剩余秒数。 */
function remainingSeconds (text) {
  assert.equal(typeof text, 'string', '合同行应该画出剩余时间：' + String(text))
  const hours = /(\d+)\s*小时/.exec(text)
  const minutes = /(\d+)\s*分/.exec(text)
  const seconds = /(\d+)\s*秒/.exec(text)
  assert.ok(hours !== null || minutes !== null || seconds !== null, '应该能读出剩余时间：' + text)
  return (hours === null ? 0 : Number(hours[1]) * 3600) +
    (minutes === null ? 0 : Number(minutes[1]) * 60) +
    (seconds === null ? 0 : Number(seconds[1]))
}

function bootHiredFarm (remainingMs = 90 * 1000) {
  const harness = bootFarm()
  harness.pushState(contractState(remainingMs))
  harness.clickTab('hire')
  return harness
}

test('合同倒计时：渲染进程被阻塞 5 秒，倒计时也要走 5 秒', () => {
  const harness = bootHiredFarm(90 * 1000)
  assert.ok(remainingSeconds(harness.metaText()) >= 89, '刚推下来应该从 90 秒左右开始')

  // 阻塞 5 秒：期间只跑到一拍（setInterval 被延迟/合并），然后才 tick。
  harness.advance(5000)
  harness.tick()

  const left = remainingSeconds(harness.metaText())
  assert.ok(left <= 86, '真实过去了 5 秒，剩余应该 ≈85 秒，实际 ' + left + ' 秒')
  assert.ok(left >= 84, '不能多减也不能少减太多，实际 ' + left + ' 秒')
})

test('合同倒计时：切走再切回来不会倒流', () => {
  const harness = bootHiredFarm(90 * 1000)
  harness.advance(3000)
  harness.tick()
  const before = remainingSeconds(harness.metaText())

  // 用户在农场页待了 20 秒，再切回雇工页：重画不能让倒计时退回快照值。
  harness.clickTab('farm')
  harness.advance(20000)
  harness.clickTab('hire')
  const after = remainingSeconds(harness.metaText())

  assert.ok(after <= before - 19, '切走 20 秒，回来应该少 20 秒左右：' + before + 's → ' + after + 's')
})

test('合同倒计时：走到 0 请宿主确认，不自己编状态', () => {
  const harness = bootHiredFarm(2000)
  harness.advance(5000)
  harness.tick()

  assert.ok(harness.submits.some((entry) => entry.action === 'farm-refresh'),
    '到点应该请宿主重推一份 state（合同结没结束只有宿主知道）')
  // 窗口不能自己把行改成「已结束」：那要等宿主的 status。
  const text = harness.metaText()
  assert.equal(typeof text, 'string')
  assert.equal(/已结束|已结算|已取消/.test(text), false, '窗口不能自己宣布合同结束：' + text)
  assert.match(text, /马上结束/, '停在「马上结束」等宿主：' + text)
})
