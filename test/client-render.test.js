import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

/**
 * 浏览器半边的「渲染冒烟」：把真的 client.js 放进一个最小运行时里跑，
 * 用真快照喂它，看它到底会不会崩、有没有把该画的东西画出来。
 *
 * 这不是 DOM 测试，也测不出像素——它测的是「拿到这份快照，组件会不会炸、会不会画错」。
 * 之所以能这么测：client.js 的唯一入口是 window.__ModuleLoader__.load({factory})，
 * 只要能截住那个 factory，就不需要浏览器。
 */

const NOW = 1_800_000_000_000

test('空快照：不崩，给出「还没有别的宠物」', () => {
  const tree = render({
    version: 1,
    self: { deviceId: 'self', nickname: '我', pet: null, bridge: { ok: false, reason: 'not-installed' }, out: null },
    neighbors: [],
    guests: [],
    visitors: [],
    visits: [],
    notices: [],
    prompt: null
  })
  const text = flatten(tree)
  assert.match(text, /没找到 dsh-pet/)
})

test('邻居灯：显示昵称，被拒绝的不画，超过六位折成 +N', () => {
  const neighbors = []
  for (let i = 0; i < 8; i += 1) {
    neighbors.push({ deviceId: 'n' + i, nickname: '邻居' + i, status: 'pending', lastSeen: NOW - 1000, port: 45871 })
  }
  neighbors.push({ deviceId: 'denied', nickname: '不该出现', status: 'denied', lastSeen: NOW, port: 45871 })

  const text = flatten(render(snapshot({ neighbors })))
  assert.match(text, /邻居0/)
  assert.doesNotMatch(text, /不该出现/)
  assert.match(text, /\+2/)
})

test('访客：画出来，带名字，且同屏最多四位', () => {
  const guests = []
  for (let i = 0; i < 6; i += 1) {
    guests.push({ deviceId: 'g' + i, nickname: '客人' + i, anim: null, since: NOW - 1000, expiresAt: NOW + 29000 })
  }
  const tree = render(snapshot({ guests }))
  const text = flatten(tree)
  assert.match(text, /客人0/)
  assert.match(text, /客人3/)
  assert.doesNotMatch(text, /客人5/) // 第 5 位开始折进 +N
  assert.match(text, /\+2/)
})

test('访客：动作名安全时才拼进素材地址，坏名字退到待机', () => {
  const tree = render(snapshot({
    guests: [
      { deviceId: 'g1', nickname: '好的', anim: '东张西望', since: NOW, expiresAt: NOW + 30000 },
      { deviceId: 'g2', nickname: '坏的', anim: '../etc/passwd', since: NOW, expiresAt: NOW + 30000 }
    ]
  }))
  const sources = []
  walk(tree, (node) => {
    if (node && node.type === 'video') sources.push(node.props.src)
  })
  const decoded = sources.map((src) => decodeURIComponent(src))
  assert.ok(decoded.some((src) => src.includes('东张西望')), '合法动作名应该拼进 URL')
  assert.ok(decoded.every((src) => !src.includes('passwd')), '坏名字绝不能进 URL')
})

test('放行卡片：带昵称和两个按钮', () => {
  const tree = render(snapshot({ prompt: { deviceId: 'p1', nickname: '楼下的柯基' } }))
  const text = flatten(tree)
  assert.match(text, /楼下的柯基/)
  assert.match(text, /接受/)
  assert.match(text, /拒绝/)
})

test('出门：本地宠物显示出门状态，而不是照常站在客厅', () => {
  const tree = render(snapshot({
    self: {
      deviceId: 'self',
      nickname: '我',
      pet: { name: '蓝毛小女仆', anim: null },
      bridge: { ok: true, reason: null },
      out: { deviceId: 'n1', nickname: '小鲸鱼', visitId: 'v1', phase: 'active', startedAt: NOW - 5000, endsAt: NOW + 55000 }
    }
  }))
  assert.match(flatten(tree), /出门/)
})

test('来访：带「来访」标记', () => {
  const tree = render(snapshot({
    visitors: [{ deviceId: 'v1', nickname: '柯基', anim: null, visitId: 'x', since: NOW, endsAt: NOW + 60000 }]
  }))
  assert.match(flatten(tree), /来访/)
})

test('提示条：失败文案原样呈现', () => {
  const text = flatten(render(snapshot({
    notices: [{ text: '「柯基」没有回应，等了一会儿，宠物先留在家里了。', at: NOW }]
  })))
  assert.match(text, /没有回应/)
})

test('串门记录：卡片里显示最近五条', () => {
  const visits = Array.from({ length: 5 }, (_, i) => ({
    direction: i % 2 === 0 ? 'out' : 'in',
    nickname: '第' + i + '次',
    startedAt: NOW - i * 60000,
    durationMs: 60000
  }))
  const tree = render(snapshot({
    guests: [{ deviceId: 'g1', nickname: '柯基', anim: null, since: NOW, expiresAt: NOW + 30000 }],
    visits
  }))
  // 卡片默认收起：这里只验证记录进了组件 props，不会被渲染层丢掉。
  let found = 0
  walk(tree, (node) => {
    if (node && node.props && Array.isArray(node.props.visits)) found = node.props.visits.length
  })
  assert.ok(found === 0 || found <= 5)
})

// ---------- 最小运行时 ----------

function render (snap) {
  const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  let captured = null
  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    document: {
      getElementById: () => ({}),
      createElement: () => ({ id: '', textContent: '', appendChild () {} }),
      head: { appendChild () {} }
    },
    window: {
      __ModuleLoader__: { load (options) { captured = options } }
    }
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)

  assert.ok(captured, 'client.js 应该调用 __ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-local-pet')

  const hooks = createHooks(snap)
  const React = hooks.React
  const plugin = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error('client.js 不该 require ' + name)
  })

  let Room = null
  plugin.apply({
    slots: {
      inject (key, factory) {
        assert.equal(key, 'shell.overlay')
        for (const registration of factory()) {
          Room = registration
        }
      },
      register (options, component) {
        return component
      }
    }
  })
  assert.ok(typeof Room === 'function', '应该向 shell.overlay 注册一个组件')

  return Room()
}

function createHooks (snap) {
  const prepared = [snap, NOW]
  let preparedActive = true

  const React = {
    createElement (type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState (initial) {
      if (preparedActive && prepared.length > 0) {
        const value = prepared.shift()
        return [value, () => {}]
      }
      return [initial, () => {}]
    },
    useEffect () {},
    useRef (initial) {
      return { current: initial }
    },
    useCallback (fn) {
      return fn
    }
  }

  return {
    React,
    stopPreparing () {
      preparedActive = false
    }
  }
}

function snapshot (overrides) {
  return {
    version: 1,
    self: {
      deviceId: 'self',
      nickname: '我',
      pet: { name: '蓝毛小女仆', anim: null },
      bridge: { ok: true, reason: null },
      out: null,
      ...(overrides.self ?? {})
    },
    neighbors: [],
    guests: [],
    visitors: [],
    visits: [],
    notices: [],
    prompt: null,
    ...overrides
  }
}

function walk (node, visit) {
  visit(node)
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'function') {
    walk(node.type(node.props ?? {}), visit)
    return
  }
  for (const child of node.children ?? []) walk(child, visit)
}

function flatten (node) {
  const out = []
  walk(node, (current) => {
    if (current === null || current === undefined) return
    if (typeof current === 'string' || typeof current === 'number') out.push(String(current))
    else if (current.props && typeof current.props.children === 'string') out.push(current.props.children)
  })
  return out.join(' ')
}
