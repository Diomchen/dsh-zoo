/**
 * 1.12.x 的报错文案与充值记账回归。
 *
 * 两个都来自同一次自查（「再测测还有没有其他问题」）：
 *   1. 37 个错误码里有一半只有代码没有文案，窗口就退化成「没成交，再试一次」；
 *   2. `deposit()` 直接信农场返回的 `spent.qty`，农场回 `{ ok: true }` 时托管加 0、农场却已扣钱。
 *
 * 这里锁住三件事：源码里出现的期货错误码都有文案；文案非空；农场不回数量时按申请额记账。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FUTURES_ERROR_TEXT, createFuturesStore } from '../src/futures.js'

const NOW = new Date(2026, 10, 17, 12, 0, 0, 0).getTime()

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-errors-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

/** 只做硬币收支的假农场：`spendCoins` 故意**不**回 `qty`，模拟「只回 ok」的实现。 */
function quietFarm (coins = 500) {
  const state = { coins }
  return {
    state,
    snapshot: () => ({ coins: state.coins }),
    async spendCoins (qty) {
      if (!(qty > 0) || state.coins < qty) return { ok: false, error: 'no-coin' }
      state.coins -= qty
      return { ok: true, action: 'spend-coins', coins: state.coins }
    },
    async addCoins (qty) {
      state.coins += Math.max(0, Math.floor(qty))
      return { ok: true, action: 'add-coins', coins: state.coins }
    }
  }
}

test('错误码都有文案：源码里出现的期货错误码逐个对得上 FUTURES_ERROR_TEXT', async () => {
  const source = await readFile(new URL('../src/futures.js', import.meta.url), 'utf8')
  const codes = new Set([...source.matchAll(/error: '([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
  assert.ok(codes.size >= 30, `只扫到 ${codes.size} 个错误码，正则是不是坏了`)
  const missing = [...codes].filter((code) => typeof FUTURES_ERROR_TEXT[code] !== 'string')
  assert.deepEqual(missing, [], '这些错误码没有文案：' + missing.join(', '))
})

test('错误码文案非空：每条都是给玩家看的中文句子', () => {
  const empties = Object.entries(FUTURES_ERROR_TEXT)
    .filter(([, text]) => typeof text !== 'string' || text.trim().length < 4)
    .map(([code]) => code)
  assert.deepEqual(empties, [], '这些文案是空的：' + empties.join(', '))
})

test('充值按农场实扣记账：农场不回 qty 时按申请额进托管，不能凭空少钱', async (t) => {
  const dir = await tempDir(t)
  const farm = quietFarm(500)
  const store = await createFuturesStore(dir, { farm, now: () => NOW })
  const mode = await store.setAccountMode('live', NOW)
  assert.equal(mode.ok, true, JSON.stringify(mode))

  const deposit = await store.deposit(100, NOW)
  assert.equal(deposit.ok, true, JSON.stringify(deposit))
  assert.equal(deposit.coins, 100, '托管余额应当等于申请额')
  assert.equal(farm.state.coins, 400, '农场确实扣了 100')
  assert.equal(store.snapshot({ at: NOW }).balance, 100)
  assert.equal(store.reconcile(NOW).diff, 0, '农场流水与托管余额应当对得上')
})
