/**
 * 期货窗的 preload 白名单（1.12.1）
 *
 * 为什么单开一份：`desktop/shared.js` 的 `FUTURES_SUBMIT_ACTIONS` 是「窗口能发什么」的
 * 总清单，preload 的 `FIELDS` 是**第二道门**——两份清单一旦漂移，按钮就会变成
 * 「点了没反应」的死按钮，而且没有任何报错（`submit()` 只返回 false）。
 * 1.10.0 的切档、1.11.0 的全部转、1.12.0 的暂停都吃过这个亏（票 112 复盘）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 把 preload 跑起来，返回它暴露给窗口的那个 api 与它发出的 ipc 记录。 */
function loadPreload () {
  const source = readFileSync(path.join(ROOT, 'desktop', 'futures-preload.js'), 'utf8')
  const sent = []
  let exposed = null
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld (name, api) {
        if (name === 'dshZooFutures') exposed = api
      }
    },
    ipcRenderer: {
      send (channel, payload) { sent.push({ channel, payload }) },
      on () {},
      removeListener () {}
    }
  }
  const sandbox = {
    require (id) {
      if (id === 'electron') return fakeElectron
      throw new Error('preload 只能要 electron，实际要了 ' + id)
    },
    module: { exports: {} },
    exports: {},
    console
  }
  vm.runInNewContext(source, sandbox, { filename: 'futures-preload.js' })
  assert.notEqual(exposed, null, 'preload 应该暴露 window.dshZooFutures')
  return { api: exposed, sent }
}

/** preload 在 vm 里跑，它建的对象与本文件不同 realm——比 JSON 而不是比原型。 */
function plain (value) {
  return JSON.parse(JSON.stringify(value))
}

/** 每个动作的合法样例：动作名 → 过桥字段。 */
const SAMPLES = {
  'futures-deposit': { coins: 100 },
  'futures-withdraw': { coins: 50 },
  'futures-open': { side: 'long', margin: 100, leverage: 10, cropId: 'tomato' },
  'futures-close': { positionId: 'a3b1c2d4-0000-4000-8000-000000000000' },
  'futures-place': { side: 'short', cropId: 'tomato', price: 5, lots: 1, leverage: 10 },
  'futures-cancel': { orderId: 'a3b1c2d4-0000-4000-8000-000000000001' },
  'futures-convert': { positionId: 'a3b1c2d4-0000-4000-8000-000000000002', lots: 1 },
  'futures-convert-all': {
    positions: [{ id: 'a3b1c2d4-0000-4000-8000-000000000003', lots: 1 }]
  },
  'futures-mode': { mode: 'live' },
  'futures-account-mode': { accountMode: 'live' },
  'futures-pause': { paused: true },
  'futures-rollback': {},
  'futures-refresh': {}
}

test('preload 的动作白名单必须盖住 shared.js 的 FUTURES_SUBMIT_ACTIONS（漂移即死按钮）', () => {
  const shared = require('../desktop/shared.js')
  const { api } = loadPreload()
  const missing = []
  for (const action of shared.FUTURES_SUBMIT_ACTIONS) {
    const sample = SAMPLES[action]
    assert.notEqual(sample, undefined, '新动作 ' + action + ' 要在本测试里补样例')
    if (api.submit({ action, ...sample }) !== true) missing.push(action)
  }
  assert.deepEqual(missing, [], '这些动作在窗口里点了会被 preload 静默丢掉：' + missing.join('、'))
})

test('preload 只放行白名单里的字段，未知动作直接拒', () => {
  const { api, sent } = loadPreload()
  assert.equal(api.submit({ action: 'futures-take-over-the-world' }), false)
  assert.equal(sent.length, 0)

  assert.equal(api.submit({
    action: 'futures-open',
    side: 'long',
    margin: 100,
    leverage: 10,
    cropId: 'tomato',
    balance: 999999,
    entry: 0.01
  }), true)
  assert.deepEqual(plain(sent[0].payload), {
    action: 'futures-open',
    side: 'long',
    margin: 100,
    leverage: 10,
    cropId: 'tomato'
  })
})

test('「全部转」只收 1–8 笔、每笔 id 与整数张数，别的形状一律不过桥', () => {
  const { api, sent } = loadPreload()
  const good = { id: 'a3b1c2d4-0000-4000-8000-000000000004', lots: 2 }
  assert.equal(api.submit({ action: 'futures-convert-all', positions: [good] }), true)
  assert.deepEqual(plain(sent[0].payload.positions), [{ id: good.id, lots: 2 }])

  assert.equal(api.submit({ action: 'futures-convert-all', positions: [] }), false)
  assert.equal(api.submit({ action: 'futures-convert-all' }), false)
  assert.equal(api.submit({ action: 'futures-convert-all', positions: [good, good, good, good, good, good, good, good, good] }), false)
  assert.equal(api.submit({ action: 'futures-convert-all', positions: [{ id: good.id, lots: 0 }] }), false)
  assert.equal(api.submit({ action: 'futures-convert-all', positions: [{ id: '', lots: 1 }] }), false)
  assert.equal(api.submit({ action: 'futures-convert-all', positions: [{ lots: 1 }] }), false)
  assert.equal(sent.length, 1, '拒掉的都不该发出去')
})

test('暂停与切档只带一个布尔/枚举，别的一律不过桥', () => {
  const { api, sent } = loadPreload()
  assert.equal(api.submit({ action: 'futures-pause', paused: true, coins: 999 }), true)
  assert.deepEqual(plain(sent[0].payload), { action: 'futures-pause', paused: true })

  assert.equal(api.submit({ action: 'futures-account-mode', accountMode: 'live', balance: 1 }), true)
  assert.deepEqual(plain(sent[1].payload), { action: 'futures-account-mode', accountMode: 'live' })
})
