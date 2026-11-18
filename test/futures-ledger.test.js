import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MAX_COINS } from '../src/farm.js'
import {
  createFuturesStore,
  normalizeLedgerSnapshot
} from '../src/futures.js'
import { SLOT_MS, contractOf } from '../src/futures-rules.js'

const CROP = 'tomato'
const NOW = new Date(2026, 10, 17, 12, 0, 0, 0).getTime()
const AT = Math.floor(NOW / SLOT_MS) * SLOT_MS
const SELF = '11111111-1111-4111-8111-111111111111'
const PEER = '22222222-2222-4222-8222-222222222222'

function fakeFarm (coins) {
  const state = { coins }
  return {
    state,
    snapshot: () => ({ coins: state.coins }),
    async spendCoins (qty) {
      if (!(qty > 0) || state.coins < qty) return { ok: false, error: 'no-coin' }
      state.coins -= qty
      return { ok: true, qty, coins: state.coins }
    },
    async addCoins (qty) {
      const amount = Math.max(0, Math.min(MAX_COINS - state.coins, Math.floor(qty)))
      state.coins += amount
      return { ok: true, qty: amount, coins: state.coins }
    }
  }
}

async function makeStore (t, { coins = 5000, mode = 'live' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-ledger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  if (mode !== 'shadow') {
    await writeFile(join(dir, 'futures.json'), JSON.stringify({ version: 1, mode }), 'utf8')
  }
  const farm = fakeFarm(coins)
  const store = await createFuturesStore(dir, { farm, now: () => NOW })
  return { dir, farm, store }
}

/** 房主侧：开一张真钱仓、再挂一张单，账本里才有值得复制的东西。 */
async function seedHostBook (store) {
  await store.setAccountMode('live')
  const deposit = await store.deposit(1000, AT)
  assert.equal(deposit.ok, true)
  const opened = await store.open({ crop: CROP, side: 'long', margin: 100, leverage: 10, at: AT })
  assert.equal(opened.ok, true)
  const quote = store.quoteOf(CROP, AT)
  const price = Math.round((quote.bid - 0.05) * 100) / 100
  const placed = await store.place({
    crop: CROP,
    side: 'short',
    price,
    lots: 1,
    leverage: 10,
    at: AT
  })
  assert.equal(placed.ok, true, JSON.stringify(placed))
  return opened
}

test('1.12.0（B）：房主的整本账能被打包、被邻居落盘，接管后余额仓位挂单都在', async (t) => {
  const host = await makeStore(t)
  const opened = await seedHostBook(host.store)
  const before = host.store.snapshot({ at: AT })
  const snapshot = host.store.ledgerSnapshotOf({ hostId: SELF, at: AT })
  assert.equal(snapshot.hostId, SELF)
  assert.equal(snapshot.accounts.length, 1)
  assert.equal(snapshot.accounts[0].deviceId, SELF)
  assert.equal(snapshot.accounts[0].balance, before.balance)
  assert.equal(snapshot.accounts[0].positions.length, 1)

  const peer = await makeStore(t)
  const applied = await peer.store.applyLedgerSnapshot(JSON.parse(JSON.stringify(snapshot)))
  assert.equal(applied.ok, true)
  assert.equal(applied.applied, true)
  assert.equal(peer.store.adoptableLedger() !== null, true)

  const adopted = await peer.store.adoptLedger(peer.store.adoptableLedger(), { selfId: SELF, at: AT })
  assert.equal(adopted.ok, true)
  const after = peer.store.snapshot({ at: AT })
  assert.equal(after.epoch, before.epoch)
  assert.equal(after.seq, before.seq)
  assert.equal(after.balance, before.balance)
  assert.equal(after.marginUsed, before.marginUsed)
  assert.equal(after.positions.length, 1)
  assert.equal(after.positions[0].id, opened.position.id)
  assert.equal(after.orders.length, 1)
})

test('1.12.0（B）：坏快照整份拒，旧 (epoch, seq) 不覆盖新快照', async (t) => {
  const host = await makeStore(t)
  await seedHostBook(host.store)
  const fresh = JSON.parse(JSON.stringify(host.store.ledgerSnapshotOf({ hostId: SELF, at: AT })))

  const peer = await makeStore(t)
  assert.equal((await peer.store.applyLedgerSnapshot({ ...fresh, hostId: '' })).ok, false)
  assert.equal((await peer.store.applyLedgerSnapshot({ ...fresh, accounts: [] })).ok, false)
  assert.equal((await peer.store.applyLedgerSnapshot({
    ...fresh,
    accounts: [{ ...fresh.accounts[0], balance: -1 }]
  })).ok, false)
  assert.equal(normalizeLedgerSnapshot(null), null)

  assert.equal((await peer.store.applyLedgerSnapshot(fresh)).applied, true)
  // 换了一任房主（epoch 变了）但 `at` 更早：旧快照不许盖掉新的。
  const stale = { ...fresh, epoch: 'older-epoch', at: fresh.at - 60 * 1000 }
  const old = await peer.store.applyLedgerSnapshot(stale)
  assert.equal(old.ok, true)
  assert.equal(old.applied, false)

  const newer = { ...fresh, seq: fresh.seq + 5 }
  assert.equal((await peer.store.applyLedgerSnapshot(newer)).applied, true)
  assert.equal(peer.store.adoptableLedger().seq, fresh.seq + 5)
})

test('1.12.0（B）：已经有账的节点不会被快照接管，空账本才接管', async (t) => {
  const host = await makeStore(t)
  await seedHostBook(host.store)
  const snapshot = JSON.parse(JSON.stringify(host.store.ledgerSnapshotOf({ hostId: SELF, at: AT })))

  const fresh = await makeStore(t, { mode: 'shadow' })
  assert.equal(fresh.store.adoptableLedger(), null)
  await fresh.store.applyLedgerSnapshot(snapshot)
  assert.equal(fresh.store.adoptableLedger() !== null, true)
  await fresh.store.adoptLedger(fresh.store.adoptableLedger(), { selfId: PEER, at: AT })
  // 接管过之后账本不再为空：再调一次不该重复接管（否则会把新成交抹掉）。
  assert.equal(fresh.store.adoptableLedger(), null)

  const busy = await makeStore(t)
  await busy.store.deposit(100, AT)
  await busy.store.applyLedgerSnapshot(snapshot)
  assert.equal(busy.store.adoptableLedger(), null)
})

test('1.12.0（B）：快照落盘，重开之后还能接管；坏账本读盘时被丢掉', async (t) => {
  const host = await makeStore(t)
  await seedHostBook(host.store)
  const snapshot = JSON.parse(JSON.stringify(host.store.ledgerSnapshotOf({ hostId: SELF, at: AT })))

  const peer = await makeStore(t)
  await peer.store.applyLedgerSnapshot(snapshot)
  const raw = JSON.parse(await readFile(join(peer.dir, 'futures.json'), 'utf8'))
  assert.equal(raw.ledger.seq, snapshot.seq)

  const again = await createFuturesStore(peer.dir, { farm: fakeFarm(0), now: () => NOW })
  assert.equal(again.adoptableLedger() !== null, true)

  const broken = JSON.parse(await readFile(join(peer.dir, 'futures.json'), 'utf8'))
  broken.ledger = {
    epoch: 'e1',
    seq: 1,
    at: AT,
    hostId: SELF,
    accounts: [{ deviceId: 'not-a-device' }]
  }
  await writeFile(join(peer.dir, 'futures.json'), JSON.stringify(broken), 'utf8')
  const repaired = await createFuturesStore(peer.dir, { farm: fakeFarm(0), now: () => NOW })
  // 坏账本读盘时被丢掉：不接管半截账，也不会把整个文件判坏。
  assert.equal(repaired.adoptableLedger(), null)
})

test('1.12.0（B）：分片报文有上限——超长分片、越界序号都收不了', async () => {
  const { PROTOCOL_VERSION, parsePacket } = await import('../src/protocol.js')
  const base = {
    v: PROTOCOL_VERSION,
    type: 'futures-ledger',
    deviceId: SELF,
    at: AT,
    epoch: 'e1',
    seq: 1,
    hostId: SELF,
    index: 0,
    total: 2,
    chunk: 'x'.repeat(2800)
  }
  const send = (extra) => parsePacket(Buffer.from(JSON.stringify({ ...base, ...extra }), 'utf8'))
  assert.equal(send({}).ok, true)
  assert.equal(send({ chunk: 'x'.repeat(2801) }).ok, false)
  assert.equal(send({ index: 2 }).ok, false)
  assert.equal(send({ total: 9 }).ok, false)
})

test('1.12.0（B）：快照里的合约编号也是白名单——坏的整份不收', async (t) => {
  const host = await makeStore(t)
  await seedHostBook(host.store)
  const snapshot = JSON.parse(JSON.stringify(host.store.ledgerSnapshotOf({ hostId: SELF, at: AT })))
  const contract = contractOf(CROP, AT)
  assert.equal(snapshot.accounts[0].positions[0].contract, contract.id)

  const bad = JSON.parse(JSON.stringify(snapshot))
  bad.accounts[0].positions[0].contract = 'tomato-19990231'
  assert.equal(normalizeLedgerSnapshot(bad), null)
})
