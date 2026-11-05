#!/usr/bin/env node
// 不启动 DSH，直接把宿主半边跑起来：验证 apply() 能挂上路由、能开发现端口、能读 dsh-pet。
// 用法：node scripts/smoke.mjs [--seconds 3]
//
// 它会真的往 <DSH_HOME>/dsh-zoo/ 写 identity（和正式运行一样），但不碰 profile、不改任何配置。

import { apply, name } from '../index.js'

const seconds = Number(argument('seconds') ?? 3)
const origin = argument('origin')
const routes = new Map()
const effects = []
const logs = []

const ctx = {
  webServer: {
    register (options) { routes.set(options.path, options.handler); return () => routes.delete(options.path) },
    ...(typeof origin === 'string' ? { getOrigin: () => origin } : {})
  },
  effect (fn) { effects.push(fn) },
  logger: {
    info (line) { logs.push(['info', line]) },
    warn (line) { logs.push(['warn', line]) }
  }
}

apply(ctx)
console.log(`[smoke] 插件 ${name} 已挂载，路由：${[...routes.keys()].join(', ') || '（无）'}`)

await wait(Math.min(seconds, 5) * 1000)

const res = await call(routes.get('/dsh-zoo/state'), { method: 'GET' })
console.log('[smoke] /dsh-zoo/state →')
console.log(JSON.stringify(res.body, null, 2))

for (const [level, line] of logs) console.log(`[smoke:${level}] ${line}`)

for (const effect of effects) {
  try {
    const dispose = effect()
    if (typeof dispose === 'function') dispose()
  } catch (error) {
    console.warn('[smoke] 卸载时报错：' + error.message)
  }
}
console.log('[smoke] 已卸载')

function wait (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function call (handler, { method = 'GET', body } = {}) {
  if (!handler) throw new Error('路由没有注册')
  const res = {
    statusCode: 0,
    headers: {},
    setHeader (key, value) { this.headers[key] = value },
    end (payload) { this.payload = payload }
  }
  const listeners = {}
  const req = {
    method,
    on (event, fn) { listeners[event] = fn; return this },
    destroy () {}
  }
  const done = handler(req, res)
  if (body !== undefined) {
    queueMicrotask(() => listeners.data?.(Buffer.from(JSON.stringify(body))))
    queueMicrotask(() => listeners.end?.())
  }
  await done
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null }
}

function argument (key) {
  const index = process.argv.indexOf('--' + key)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : true
}
