/**
 * 1.12.9：peer 的账是房主账本的镜像，不是第二本账。
 *
 * 实测症状：peer 上点过充值/开仓/切档之后，`futures.json` 停在本机算出来的数字上；
 * 房主每 15 秒推来的 settle 只在内存里缓存一份副本，`snapshot()`（也就是 `/state` 的
 * `futures`）照样读本机账本——于是窗口（读副本）和本机账本（读本机）长期各说各话：
 * 余额 3127.68 vs 402.07，占用 1559.16 vs 599.94，仓位 entry 15.56 vs 17.9982，流水 28 条 vs 0 条。
 *
 * 这组用例钉住三件事：
 * 1）副本一到，余额/占用/仓位/挂单逐分跟着副本走，本机算过的数字必须让位；
 * 2）本地审计流水（`kind: 'mode'` 这类）不被副本覆盖，也不参与余额/占用；
 * 3）副本还没到（老存档、刚启动、对端未升级）时，窗口不许拿本机数字冒充房主。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createService } from '../src/service.js'
import { FUTURES_FILE, createFuturesStore } from '../src/futures.js'
import { contractOf, roundCoin } from '../src/futures-rules.js'

const MONDAY = new Date(2026, 10, 16, 10, 0, 0, 0).getTime()
// 房主账本上那一手空单的 id；长度符合账本的 id 上限。
const HOST_POSITION_ID = '22222222-2222-4222-8222-222222222222'

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-mirror-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function logSink () {
  const warnings = []
  return { warnings, log: { warn (line) { warnings.push(line) } } }
}

/** 假农场：`addCoins` 在上限处静默截断，和真农场一样。 */
function fakeFarm (coins, { max = 1_000_000 } = {}) {
  const state = { coins }
  return {
    state,
    async spendCoins (qty) {
      if (state.coins < qty) return { ok: false, error: 'no-coin' }
      state.coins -= qty
      return { ok: true, qty, coins: state.coins }
    },
    async addCoins (qty) {
      const before = state.coins
      state.coins = Math.min(max, before + qty)
      return { ok: true, qty: state.coins - before, coins: state.coins }
    }
  }
}

async function makeStore (t, { coins = 1000 } = {}) {
  const dir = await tempDir(t)
  const farm = fakeFarm(coins)
  const sink = logSink()
  const store = await createFuturesStore(dir, { farm, now: () => MONDAY, log: sink.log })
  // 缺省是 shadow（只记账）；这组用例写的是真钱账户的行为，显式切过去。
  await store.setMode('live')
  return { dir, farm, store, sink }
}

/** 房主那一拍 settle：余额/占用/仓位都是房主算的，跟本机账本对不上是常态。 */
function hostSettle (overrides = {}) {
  const contract = contractOf('tomato', MONDAY)
  return {
    epoch: 'host-1',
    seq: 7,
    balance: 402.07,
    marginUsed: 599.94,
    positions: [{
      id: HOST_POSITION_ID,
      crop: 'tomato',
      contract: contract.id,
      side: 'short',
      lots: 1,
      entry: 17.9982,
      margin: 599.94,
      leverage: 3
    }],
    orders: [],
    trades: [],
    insurance: 12.5,
    shortfall: 0,
    house: -3.5,
    mode: 'live',
    accountMode: 'live',
    paused: false,
    pending: 0,
    at: MONDAY,
    ...overrides
  }
}

test('peer 本地充过值、开过仓：房主副本一到，余额/占用/仓位一律以副本为准', async (t) => {
  const { dir, farm, store, sink } = await makeStore(t, { coins: 5000 })

  // 本机先按自己的账做了一轮：充值 1000、开一手多。
  assert.equal((await store.deposit(1000)).ok, true)
  const opened = await store.open({ crop: 'tomato', side: 'long', margin: 200, leverage: 20, at: MONDAY })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const local = store.snapshot({ at: MONDAY })
  assert.equal(local.positions.length, 1, '本地这一轮真的改过账本')
  assert.ok(local.balance > 0)
  assert.ok(local.marginUsed > 0)

  // 房主的账完全是另一套：余额 402.07、占用 599.94、一手空单 3×（实测里那手是 blueberry，
  // 这个仓库的作物表里没有，所以换成番茄——仓位形状与校验完全一样）。
  const applied = store.applySettle(hostSettle())
  assert.deepEqual(applied, { ok: true, applied: true })

  const view = store.snapshot({ at: MONDAY })
  // 副本是唯一真相：本机算出来的余额/占用必须让位（不是「差不多」）。
  assert.equal(view.balance, 402.07)
  assert.equal(view.marginUsed, 599.94)
  assert.equal(view.equity, roundCoin(402.07 + 599.94))
  assert.equal(view.positionCount, 1)
  assert.equal(view.positions[0].id, HOST_POSITION_ID)
  assert.equal(view.positions[0].crop, 'tomato')
  assert.equal(view.positions[0].side, 'short')
  assert.equal(view.positions[0].lots, 1)
  assert.equal(view.positions[0].entry, 17.9982)
  assert.equal(view.positions[0].leverage, 3)
  assert.deepEqual(view.orders, [], '本地没挂单，副本也没有')
  // 全局数（保险基金/做市商）也是房主的账，不是本机那份。
  assert.equal(view.insurance, 12.5)
  assert.equal(view.house, -3.5)
  // 农场硬币只被本机那次充值动过：副本不改农场。
  assert.equal(farm.state.coins, 4000)

  // 落盘也得是副本的数，否则重启之后本机账本又变回本地那套。
  await store.flush()
  const raw = JSON.parse(await readFile(join(dir, FUTURES_FILE), 'utf8'))
  assert.equal(raw.balance, 402.07)
  assert.equal(raw.marginUsed, 599.94)
  assert.equal(raw.positions.length, 1)
  assert.equal(raw.positions[0].entry, 17.9982)

  // 重启后读得回来：镜像写回的形状必须和本地仓位/挂单的格式一致，不能被当成坏条目丢掉。
  const reloaded = await createFuturesStore(dir, { farm, now: () => MONDAY, log: sink.log })
  const again = reloaded.snapshot({ at: MONDAY })
  assert.equal(again.balance, 402.07)
  assert.equal(again.positions.length, 1)
  assert.equal(again.positions[0].entry, 17.9982)
  assert.equal(reloaded.replicaOf(), null, '副本本身不落盘：重启后靠 sync 重新要一份')
  assert.deepEqual(sink.warnings, [], '镜像写回账本不该让读盘报「格式不对」')
})

test('副本不覆盖本地审计流水，流水也不参与余额与占用', async (t) => {
  const { store } = await makeStore(t, { coins: 1000 })

  // 本机切了两次档、按了一次暂停：这些是审计流水（kind: 'mode'），不是钱。
  assert.equal((await store.setAccountMode('shadow', MONDAY)).ok, true)
  assert.equal((await store.setAccountMode('live', MONDAY + 1000)).ok, true)
  assert.equal((await store.setPaused(true, MONDAY + 2000)).ok, true)
  const localModes = store.snapshot({ at: MONDAY }).trades.filter((trade) => trade.kind === 'mode')
  assert.ok(localModes.length >= 3, '本地确实记下了这几条档位流水')

  // 房主那一拍只带数字、不带流水（实测里副本的 trades 就是 0 条）。
  store.applySettle(hostSettle({
    balance: 88.8,
    marginUsed: 0,
    positions: [],
    insurance: 0,
    house: 0,
    paused: false
  }))
  const view = store.snapshot({ at: MONDAY })

  // 流水原样留着：审计记录不能被副本抹掉，也不能被副本的流水替换。
  assert.equal(
    view.trades.filter((trade) => trade.kind === 'mode').length,
    localModes.length,
    '本地档位流水一条都不该少'
  )
  assert.deepEqual(
    view.trades.filter((trade) => trade.kind === 'mode').map((trade) => trade.note),
    localModes.map((trade) => trade.note)
  )
  // 流水不是钱：余额/占用/权益只按副本的两个数算。
  assert.equal(view.balance, 88.8)
  assert.equal(view.marginUsed, 0)
  assert.equal(view.equity, 88.8)
  // 暂停是本机偏好，不跟着副本改（副本说没暂停，本机仍然暂停）。
  assert.equal(view.paused, true)
})

test('peer 不是清算所：副本存在时本地 settleDue/matchDue/expireDue 空转', async (t) => {
  const { store } = await makeStore(t, { coins: 5000 })
  store.applySettle(hostSettle())
  const before = store.snapshot({ at: MONDAY })

  // 房主会在它那一拍里盯市、撮合、交割；peer 再按镜像仓位算一遍，同一根行情就记了两次。
  const settled = await store.settleDue(MONDAY + 4 * 60 * 60 * 1000)
  assert.deepEqual(settled.settled, [])
  assert.deepEqual(settled.remotes ?? [], [])
  const matched = await store.matchDue(MONDAY + 4 * 60 * 60 * 1000)
  assert.equal(matched.fills, 0)
  const expired = await store.expireDue(MONDAY + 4 * 60 * 60 * 1000)
  assert.deepEqual(expired.deliveries, [])

  const after = store.snapshot({ at: MONDAY })
  assert.equal(after.balance, before.balance)
  assert.equal(after.marginUsed, before.marginUsed)
  assert.equal(after.positions[0].entry, before.positions[0].entry)
})

test('副本还没到时窗口不拿本机数字冒充房主，也不许从副本里提现', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'farm.json'), JSON.stringify({ version: 1, coins: 5000 }), 'utf8')
  const routes = []
  const ctx = {
    webServer: { register (options) { routes.push(options); return () => {} } },
    logger: { info () {}, warn () {} }
  }
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktop: false,
    petBridge: false,
    futuresHost: false, // 固定成 peer：房主是邻居那台
    marketNow: () => MONDAY,
    farmNow: () => MONDAY,
    tradingNow: () => MONDAY,
    futuresNow: () => MONDAY
  })
  t.after(() => service.dispose())
  await service.ready

  // 本机账上讲，账户里躺着 500。
  const store = service.futuresStore()
  assert.equal((await store.deposit(500)).ok, true)
  assert.equal(service.futures().balance, 500, '没副本时本机账本仍然能读（降级视图）')

  // 但窗口不该把 500 当成房主认过的余额：副本没到就是 0 + 等对端。
  const waiting = service.futuresWindow()
  assert.equal(waiting.role, 'peer')
  assert.equal(waiting.peer.ready, false)
  assert.equal(waiting.peer.text, '等对端…')
  assert.equal(waiting.balance, 0)
  assert.equal(waiting.marginUsed, 0)
  assert.deepEqual(waiting.positions, [])

  // 第一拍副本到了：窗口与本机账本同一个数（不再各说各话）。
  store.applySettle(hostSettle())
  const ready = service.futuresWindow()
  assert.equal(ready.peer.ready, true)
  assert.equal(ready.peer.text, '已连上房主，账目每 30 秒对一次')
  assert.equal(ready.balance, 402.07)
  assert.equal(ready.marginUsed, 599.94)
  assert.equal(ready.positions.length, 1)
  assert.equal(service.futures().balance, ready.balance)

  // 余额是房主账上的：本机不能自己扣账，更不能给自家农场凭空加币。
  // 1.13.1 起提现改成「报意图」——本机一条字节都不动账，只把申请发出去；
  // 这里没开网络，所以直接说发不出去，账上 402.07 一分不少。
  const route = routes.find((candidate) => candidate.path === '/dsh-zoo/action')
  assert.ok(route, '应该注册 /dsh-zoo/action')
  const out = await postAction(route, { action: 'futures-withdraw', coins: 10 })
  assert.equal(out.status, 409)
  assert.equal(out.body.ok, false)
  assert.equal(out.body.error, 'network-off')
  assert.equal(service.futures().balance, 402.07, '没发出去的提现不能动账')
})

/** 最小的 action 路由驱动：只发一次 POST，够这组用例用。 */
async function postAction (route, body) {
  const res = {
    statusCode: 0,
    headers: {},
    setHeader (key, value) { this.headers[key] = value },
    end (payload) { this.payload = payload }
  }
  const req = {
    method: 'POST',
    _listeners: {},
    on (event, fn) {
      this._listeners[event] = fn
      return this
    },
    destroy () {}
  }
  const pending = route.handler(req, res)
  queueMicrotask(() => req._listeners.data?.(Buffer.from(JSON.stringify(body))))
  queueMicrotask(() => req._listeners.end?.())
  await pending
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null }
}
