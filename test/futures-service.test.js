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
  // 票 98：缺省 shadow 只记账；既有验收写的是真钱流水，先切 live。
  const mode = await act(service, { action: 'futures-mode', mode: 'live' })
  assert.equal(mode.status, 200)
  assert.equal(mode.body.ok, true, JSON.stringify(mode.body))
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

  // 等一根走完：盯市结算在本拍 tick 里做，幂等（票面要求「一根只结算一次」）
  clock.advance(SLOT_MS)
  const settle = await act(service, { action: 'futures-settle' })
  assert.equal(settle.body.ok, true)
  assert.equal(settle.body.settled.length, 1)
  assert.equal(settle.body.settled[0].position.id, position.id)
  const marketToMarketPnl = settle.body.settled[0].pnl

  const settled = await state(service)
  assert.equal(settled.futures.positions.length, 1, '盯市之后仓位还在，只是入场价换成了收盘价')
  assert.equal(settled.futures.positions[0].entry, settle.body.settled[0].price)
  assert.equal(settled.futures.marginUsed, position.margin, '保证金不动')
  assert.equal(settled.futures.closed, 0)

  // 手动平掉这一笔
  const closeFirst = await act(service, { action: 'futures-close', positionId: position.id })
  assert.equal(closeFirst.body.ok, true, JSON.stringify(closeFirst.body))
  assert.equal((await state(service)).futures.positions.length, 0)
  assert.equal((await state(service)).futures.marginUsed, 0)

  // 再开一次再平掉，确认平仓这条路反复走也没问题
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
  const totalPnl = marketToMarketPnl + closeFirst.body.pnl + close.body.pnl
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

test('票 109：一次把多笔持仓转成现货，转不动的那笔单独跳过', async (t) => {
  const { service } = await makeService(t, { farmCoins: 5000 })
  await act(service, { action: 'futures-deposit', coins: 2000 })
  const first = await act(service, {
    action: 'futures-open', cropId: 'tomato', side: 'long', margin: 100, leverage: 20
  })
  assert.equal(first.body.ok, true, JSON.stringify(first.body))
  const second = await act(service, {
    action: 'futures-open', cropId: 'rice', side: 'long', margin: 100, leverage: 20
  })
  assert.equal(second.body.ok, true, JSON.stringify(second.body))

  const before = await state(service)
  assert.equal(before.futures.positions.length, 2)
  const coinsBefore = before.farm.coins

  // 一笔真转（1 张），一笔拿不存在的 id 来凑数：前者成、后者算失败，整体仍算成功。
  const batch = await act(service, {
    action: 'futures-convert-all',
    positions: [
      { id: first.body.position.id, lots: 1 },
      { id: '0b7c1f0e-1f2a-4a4b-9a3e-1d2c3b4a5f60', lots: 1 }
    ]
  })
  assert.equal(batch.body.ok, true, JSON.stringify(batch.body))
  assert.equal(batch.body.converted, 1)
  assert.equal(batch.body.failed, 1)

  const after = await state(service)
  const remaining = after.futures.positions.find((row) => row.id === first.body.position.id)
  assert.ok(remaining, '只转 1 张，那笔持仓还在，只是少了一张')
  assert.equal(remaining.lots, first.body.position.lots - 1)
  assert.ok(after.futures.positions.some((row) => row.id === second.body.position.id), '没点名的那笔不动')
  assert.ok(after.futures.balance < before.futures.balance, '按公允价买现货，余额是往下走的')

  // 一笔都转不动：整体 ok:false，给一句人话，账本不动。
  const nothing = await act(service, {
    action: 'futures-convert-all',
    positions: [{ id: second.body.position.id, lots: 100000 }]
  })
  assert.equal(nothing.body.ok, false)
  assert.equal(typeof nothing.body.notice, 'string')
  assert.equal((await state(service)).futures.positions.length, 2)
  assert.equal((await state(service)).farm.crops.tomato.qty, after.farm.crops.tomato.qty)

  const empty = await act(service, { action: 'futures-convert-all', positions: [] })
  assert.equal(empty.body.ok, false)
  assert.equal(empty.body.error, 'bad-positions')
})

test('1.12.0：暂停与退出都是「自己的事」——按了只停自己，提现照常', async (t) => {
  const { service } = await makeService(t, { farmCoins: 5000 })
  await act(service, { action: 'futures-deposit', coins: 1000 })
  const opened = await act(service, {
    action: 'futures-open', cropId: 'tomato', side: 'long', margin: 100, leverage: 10
  })
  assert.equal(opened.body.ok, true, JSON.stringify(opened.body))

  // 暂停：窗口立刻显示「暂停中」，新仓被拒，但合约还在、仓位还在。
  const paused = await act(service, { action: 'futures-pause', paused: true })
  assert.equal(paused.status, 200)
  assert.equal(paused.body.ok, true, JSON.stringify(paused.body))
  assert.equal(paused.body.paused, true)
  const blockedOpen = await act(service, {
    action: 'futures-open', cropId: 'tomato', side: 'long', margin: 100, leverage: 10
  })
  assert.equal(blockedOpen.body.ok, false)
  assert.equal(blockedOpen.body.error, 'paused')
  const pausedState = await state(service)
  assert.equal(pausedState.futures.paused, true)
  assert.equal(pausedState.futures.session.kind, 'trading', '暂停不等于休市')
  assert.equal(pausedState.futures.positions.length, 1)

  // 减风险照常：平仓、提现。
  const closed = await act(service, { action: 'futures-close', positionId: opened.body.position.id })
  assert.equal(closed.body.ok, true, JSON.stringify(closed.body))
  const coinsBefore = (await state(service)).farm.coins
  const out = await act(service, { action: 'futures-withdraw', coins: 50 })
  assert.equal(out.body.ok, true, JSON.stringify(out.body))
  assert.equal(out.body.credited, 50, JSON.stringify(out.body))

  // 继续交易：按钮回到「交易中」。
  const resumed = await act(service, { action: 'futures-pause', paused: false })
  assert.equal(resumed.body.paused, false)
  assert.equal((await state(service)).futures.paused, false)

  // 老入口 `futures-mode{off}` 仍然能用，但语义已经变成「暂停自己」。
  const legacy = await act(service, { action: 'futures-mode', mode: 'off' })
  assert.equal(legacy.body.ok, true)
  assert.equal((await state(service)).futures.paused, true)

  // 退出：只退自己，退完这本账停用。
  const rolled = await act(service, { action: 'futures-rollback' })
  assert.equal(rolled.body.ok, true, JSON.stringify(rolled.body))
  const after = await state(service)
  assert.equal(after.futures.disabled, true)
  assert.equal(after.futures.positions.length, 0)
  assert.ok(after.futures.balance < 1, '余额几乎全退回农场，托管账只剩零头')
})
