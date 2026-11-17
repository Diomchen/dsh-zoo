/**
 * 票 99 的对账证据：真 service、真农场文件、真磁盘，影子模式跑一轮完整生命周期，
 * 然后调 `futures-reconcile` 看「账面应得的农场硬币 − 真实农场硬币」是不是 0。
 *
 * 用法：node scripts/futures-reconcile-probe.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createService } from '../src/service.js'
import { SLOT_MS, roundCoin } from '../src/futures-rules.js'

const MONDAY = new Date(2026, 10, 16, 10, 0, 0, 0).getTime()

function fakeCtx () {
  const routes = []
  return {
    ctx: {
      webServer: { register (options) { routes.push(options); return () => {} } },
      logger: { info () {}, warn () {} }
    },
    routes
  }
}

function makeClock (start) {
  let value = start
  return { now: () => value, advance (ms) { value += ms } }
}

async function call (service, path, { method = 'GET', body } = {}) {
  const route = service.routes.find((candidate) => candidate.path === path)
  const res = {
    statusCode: 0,
    headers: {},
    setHeader (key, value) { this.headers[key] = value },
    end (payload) { this.payload = payload }
  }
  const req = {
    method,
    _listeners: {},
    on (event, fn) { this._listeners[event] = fn; return this },
    destroy () {}
  }
  const pending = route.handler(req, res)
  if (body !== undefined) {
    queueMicrotask(() => req._listeners.data?.(Buffer.from(JSON.stringify(body), 'utf8')))
    queueMicrotask(() => req._listeners.end?.())
  }
  await pending
  const text = typeof res.payload === 'string' ? res.payload : res.payload?.toString?.('utf8') ?? ''
  let parsed = null
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.statusCode, body: parsed }
}

const act = (service, body) => call(service, '/dsh-zoo/action', { method: 'POST', body })

async function farmCoinsOf (dir) {
  const raw = JSON.parse(await readFile(join(dir, 'farm.json'), 'utf8'))
  return raw.coins
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-reconcile-'))
try {
  const FARM0 = 5000
  await writeFile(join(dir, 'farm.json'), JSON.stringify({ version: 1, coins: FARM0 }), 'utf8')
  const clock = makeClock(MONDAY)
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktop: false,
    petBridge: false,
    marketNow: clock.now,
    farmNow: clock.now,
    tradingNow: clock.now,
    futuresNow: clock.now
  })
  service.routes = routes
  await service.ready
  const rows = []

  // 影子模式：只记账，农场硬币一分不动；日额上限 0，所以连开仓都下不进去。
  const shadow = await act(service, { action: 'futures-mode', mode: 'shadow' })
  rows.push(['切到 shadow', shadow.body?.ok === true])
  const dep = await act(service, { action: 'futures-deposit', coins: 600 })
  rows.push(['shadow 充值 600（只记账）', dep.body?.ok === true])
  const shadowOpen = await act(service, { action: 'futures-open', side: 'long', margin: 100, leverage: 20, cropId: 'tomato' })
  rows.push(['shadow 开仓被日额 0 拦住（' + shadowOpen.body?.error + '）', shadowOpen.body?.ok === false])
  const shadowFarm = await farmCoinsOf(dir)
  const shadowCheck = await act(service, { action: 'futures-reconcile' })
  rows.push(['shadow 对账 diff = 0', shadowCheck.body?.diff === 0])

  // 切真钱：此后充提都真的动农场硬币。
  const live = await act(service, { action: 'futures-mode', mode: 'live' })
  rows.push(['切到 live', live.body?.ok === true])
  const open = await act(service, { action: 'futures-open', side: 'long', margin: 100, leverage: 20, cropId: 'tomato' })
  rows.push(['live 开多 100×20', open.body?.ok === true])
  clock.advance(SLOT_MS)
  const settle = await act(service, { action: 'futures-settle' })
  rows.push(['一根后结算', settle.body?.ok !== false])
  const close = await act(service, { action: 'futures-close', positionId: open.body?.position?.id })
  rows.push(['平仓', close.body?.ok === true])
  const wd = await act(service, { action: 'futures-withdraw', coins: 200 })
  rows.push(['live 提现 200', wd.body?.ok === true])
  const liveCheck = await act(service, { action: 'futures-reconcile' })
  const farmAfter = await farmCoinsOf(dir)
  const treasury = roundCoin(liveCheck.body?.custodyTotal ?? 0)

  console.log('影子 → 真钱 一轮')
  for (const [label, ok] of rows) console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  console.log('')
  console.log('shadow 农场硬币 :', shadowFarm, '（起始', FARM0, '，差', roundCoin(shadowFarm - FARM0), '）')
  console.log('shadow 对账     :', JSON.stringify(shadowCheck.body))
  console.log('live 农场硬币   :', farmAfter)
  console.log('live 对账       :', JSON.stringify(liveCheck.body))
  console.log('托管余额        :', treasury)
  console.log('守恒            : 农场', farmAfter, '+ 托管', treasury, '=', roundCoin(farmAfter + treasury),
    '（起始', FARM0, '+ 600 影子充值 + 盈亏 − 手续费）')
  console.log('')
  console.log('结论            :', shadowCheck.body?.diff === 0 && liveCheck.body?.diff === 0
    ? '两段对账差额都是 0 —— 影子模式没碰农场硬币，切真钱后每一次充提都被记在账上。'
    : '对账差额非 0，需要查。')

  await service.dispose()
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

