/**
 * 票 92：期货的服务接线（`/dsh-zoo/action` + `/dsh-zoo/state` 的 `futures`）。
 *
 * 票面的「脚本级验收」在这里跑：充值 100 → 开多 → 等一根结算 → 平仓 → 提现，
 * 全程 `balance + marginUsed` 守恒，差额恰好等于手续费与盈亏。
 * 用真 service、真农场、真磁盘，只把时钟捏在手里（`futuresNow`/`farmNow`/`marketNow`）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createService } from '../src/service.js'
import { HOUR_MS, SLOT_MS, roundCoin } from '../src/futures-rules.js'

const MONDAY = new Date(2026, 10, 16, 10, 0, 0, 0).getTime()

function fakeCtx () {
  const routes = []
  return {
    ctx: {
      webServer: {
        register (options) {
          routes.push(options)
          return () => {}
        }
      },
      logger: { info () {}, warn () {} }
    },
    routes
  }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-svc-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeClock (start) {
  let value = start
  return {
    now: () => value,
    advance (ms) { value += ms }
  }
}

async function makeService (t, { farmCoins = 500 } = {}) {
  const dir = await tempDir(t)
  // 农场硬币是这套东西的「法币」：先在盘上放一笔，等于玩家之前种菜攒下的钱。
  await writeFile(join(dir, 'farm.json'), JSON.stringify({ version: 1, coins: farmCoins }), 'utf8')
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
  t.after(() => service.dispose())
  await service.ready
  return { service, clock, dir }
}

async function call (service, path, { method = 'GET', body } = {}) {
  const route = service.routes.find((candidate) => candidate.path === path)
  assert.ok(route, '应该注册 ' + path)
  const res = {
    statusCode: 0,
    headers: {},
    setHeader (key, value) { this.headers[key] = value },
    end (payload) { this.payload = payload }
  }
  const req = {
    method,
    _listeners: {},
    on (event, fn) {
      this._listeners[event] = fn
      return this
    },
    destroy () {}
  }
  const pending = route.handler(req, res)
  if (body !== undefined) {
    queueMicrotask(() => req._listeners.data?.(Buffer.from(JSON.stringify(body))))
    queueMicrotask(() => req._listeners.end?.())
  }
  await pending
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null }
}

function act (service, body) {
  return call(service, '/dsh-zoo/action', { method: 'POST', body })
}

async function state (service) {
  const res = await call(service, '/dsh-zoo/state')
  assert.equal(res.status, 200)
  return res.body
}

test('脚本级验收：充值 100 → 开多 → 一根结算 → 平仓 → 提现，账在两边都对得上', async (t) => {
  const { service, clock } = await makeService(t)
  const before = await state(service)
  assert.equal(before.futures.balance, 0)
  assert.equal(before.futures.marginUsed, 0)
  assert.deepEqual(before.futures.positions, [], '还没充钱时是空账本')
  assert.deepEqual(before.futures.fees, { insurance: 0, burned: 0 })

  const farmBefore = before.farm.coins

  const deposit = await act(service, { action: 'futures-deposit', coins: 100 })
  assert.equal(deposit.body.ok, true, JSON.stringify(deposit.body))
  assert.equal(deposit.body.balance, 100)

  const afterDeposit = await state(service)
  assert.equal(afterDeposit.farm.coins, farmBefore - 100, '农场硬币等额进了托管账户')
  assert.equal(afterDeposit.futures.balance, 100)
  assert.ok(afterDeposit.futures.quotes.tomato, '行情里应该有番茄')
  assert.ok(afterDeposit.futures.quotes.tomato.ask > afterDeposit.futures.quotes.tomato.bid)

  const open = await act(service, {
    action: 'futures-open', cropId: 'tomato', side: 'long', margin: 50, leverage: 20
  })
  assert.equal(open.body.ok, true, JSON.stringify(open.body))
  const position = open.body.position
  assert.equal(position.crop, 'tomato')
  assert.equal(position.side, 'long')
  assert.ok(position.lots >= 1)

  const opened = await state(service)
  assert.equal(opened.futures.positions.length, 1)
  assert.equal(opened.futures.marginUsed, position.margin)
  assert.equal(
    opened.futures.equity,
    roundCoin(100 - open.body.fee),
    '权益 = 余额 + 保证金 = 本金 − 手续费'
  )

  // 等一根走完：结算在本拍 tick 里做，幂等（票面要求「一根只结算一次」）
  clock.advance(SLOT_MS)
  const settle = await act(service, { action: 'futures-settle' })
  assert.equal(settle.body.ok, true)
  assert.equal(settle.body.settled.length, 1)
  assert.equal(settle.body.settled[0].position.id, position.id)

  const settled = await state(service)
  assert.equal(settled.futures.positions.length, 0)
  assert.equal(settled.futures.marginUsed, 0)
  assert.equal(settled.futures.closed, 1)

  // 再开一次再平掉，走手动平仓那条路
  clock.advance(HOUR_MS)
  const second = await act(service, {
    action: 'futures-open', cropId: 'tomato', side: 'short', margin: 20, leverage: 20
  })
  assert.equal(second.body.ok, true, JSON.stringify(second.body))
  clock.advance(2 * 60 * 1000)
  const close = await act(service, {
    action: 'futures-close', positionId: second.body.position.id
  })
  assert.equal(close.body.ok, true, JSON.stringify(close.body))
  assert.equal((await state(service)).futures.positions.length, 0)

  // 提现：把托管账户里的钱全部拿回农场
  const view = (await state(service)).futures
  const withdraw = await act(service, { action: 'futures-withdraw', coins: Math.floor(view.balance) })
  assert.equal(withdraw.body.ok, true, JSON.stringify(withdraw.body))
  assert.equal(withdraw.body.balance < 1, true)

  const final = await state(service)
  assert.equal(final.futures.balance, withdraw.body.balance)
  assert.equal(final.futures.marginUsed, 0)
  // 守恒：农场现在 = 初始 − 充值 + 提现；托管剩下的零头（分）仍在账上
  assert.equal(final.farm.coins, farmBefore - 100 + Math.floor(view.balance))
  // 两边加起来 = 初始 − 手续费 + 盈亏：钱没有凭空出现，也没有凭空消失
  const totalPnl = settle.body.settled[0].pnl + close.body.pnl
  assert.equal(
    roundCoin(final.farm.coins + final.futures.balance),
    roundCoin(farmBefore - final.futures.fees.insurance - final.futures.fees.burned + totalPnl)
  )
})

test('拒绝路径：坏参数、余额不够、周末休市都说人话，账本不动', async (t) => {
  const { service, clock } = await makeService(t)
  await act(service, { action: 'futures-deposit', coins: 60 })

  const badSide = await act(service, {
    action: 'futures-open', cropId: 'tomato', side: 'flat', margin: 10, leverage: 3
  })
  assert.equal(badSide.body.ok, false)
  assert.equal(badSide.body.error, 'bad-side')

  const badLeverage = await act(service, {
    action: 'futures-open', cropId: 'tomato', side: 'long', margin: 10, leverage: 5
  })
  assert.equal(badLeverage.body.ok, false, '5× 只在盘口白名单里，期货是 1/3/10/20')
  assert.equal(badLeverage.body.error, 'bad-leverage')

  const tooBig = await act(service, {
    action: 'futures-open', cropId: 'tomato', side: 'long', margin: 1000, leverage: 20
  })
  assert.equal(tooBig.body.ok, false)
  assert.equal(tooBig.body.error, 'no-balance')

  const depositTooMuch = await act(service, { action: 'futures-deposit', coins: 1_000_000 })
  assert.equal(depositTooMuch.body.ok, false)
  assert.equal(depositTooMuch.body.error, 'no-coin')

  const view = (await state(service)).futures
  assert.equal(view.balance, 60)
  assert.equal(view.positions.length, 0)

  // 周六：没有可交易的合约
  const saturday = MONDAY + 5 * 24 * HOUR_MS
  clock.advance(saturday - clock.now())
  const closed = await act(service, {
    action: 'futures-open', cropId: 'tomato', side: 'long', margin: 10, leverage: 3
  })
  assert.equal(closed.body.ok, false)
  assert.equal(closed.body.error, 'market-closed')
  assert.equal((await state(service)).futures.quotes.tomato, undefined, '周末行情也应该是空的')
})
