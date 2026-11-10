/**
 * 票 27：礼物限额。
 *   - 频率：同一邻居 ≤10 件/小时、≤50 件/天，两个滑动窗口要独立；
 *   - 同一 giftId 的重试不能重复计数（visit-request 本身会重发三次）；
 *   - 磁盘：gifts/ 总量 ≤500 MiB、≤200 件，超了按 receivedAt 删最旧整目录；
 *     先写后剪——新收到的那一件一定保留。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  GIFT_RATE_DAY_MS,
  GIFT_RATE_HOUR_MS,
  createGiftRateLimiter
} from '../src/gift-limits.js'
import {
  GIFTS_DIR,
  MAX_GIFT_COUNT,
  MAX_GIFT_TOTAL_BYTES,
  createGiftStore,
  giftDirName
} from '../src/gifts.js'

const T0 = 1_700_000_000_000

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-limits-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function textGift (id, text = '给你留了一张便条') {
  return {
    id,
    from: { deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nickname: '楼下的柯基' },
    text,
    receivedAt: T0
  }
}

test('频率限额：一小时 10 件、一天 50 件；同一件重试不重复计数', () => {
  const limiter = createGiftRateLimiter()
  const neighbor = randomUUID()
  const first = randomUUID()

  assert.equal(limiter.allow(neighbor, first, T0), true)
  for (let index = 1; index < 10; index += 1) {
    assert.equal(limiter.allow(neighbor, randomUUID(), T0 + index), true, '第 ' + (index + 1) + ' 件')
  }
  // 第 10 件已经是一小时额度的最后一件；同一件重试仍然放行，但不占新额度。
  assert.equal(limiter.allow(neighbor, first, T0 + 500), true)
  assert.equal(limiter.allow(neighbor, randomUUID(), T0 + 600), false, '第 11 件必须 refused')

  // 一小时后窗口滑走，又能在新的一小时里收了；但这一天已经收了 10 件，还远不到 50。
  assert.equal(limiter.allow(neighbor, randomUUID(), T0 + GIFT_RATE_HOUR_MS + 1), true)

  // 另一个邻居有自己的额度。
  assert.equal(limiter.allow(randomUUID(), randomUUID(), T0 + 601), true)
})

test('频率限额：一天 50 件是独立于小时窗口的第二道闸', () => {
  const limiter = createGiftRateLimiter({ perHour: 100, perDay: 5 })
  const neighbor = randomUUID()
  for (let index = 0; index < 5; index += 1) {
    assert.equal(limiter.allow(neighbor, randomUUID(), T0 + index), true, '第 ' + (index + 1) + ' 件')
  }
  assert.equal(limiter.allow(neighbor, randomUUID(), T0 + 10), false)

  // 熬过一小时（小时窗口已空）仍然不行：这一天已经 5 件了。
  assert.equal(limiter.allow(neighbor, randomUUID(), T0 + GIFT_RATE_HOUR_MS + 1), false)
  // 熬过一整天，两道窗口都滑走。
  assert.equal(limiter.allow(neighbor, randomUUID(), T0 + GIFT_RATE_DAY_MS + 1), true)
})

test('频率限额：非法 deviceId / giftId 一律不放行；超过来源上限时挤掉最久没动静的', () => {
  const limiter = createGiftRateLimiter({ maxSources: 2 })
  const a = randomUUID()
  const b = randomUUID()
  const c = randomUUID()
  assert.equal(limiter.allow('not-a-uuid', randomUUID(), T0), false)
  assert.equal(limiter.allow(a, 'not-a-uuid', T0), false)
  assert.equal(limiter.allow(a, randomUUID(), T0), true)
  assert.equal(limiter.allow(b, randomUUID(), T0 + 1), true)
  assert.equal(limiter.size(), 2)
  assert.equal(limiter.allow(c, randomUUID(), T0 + 2), true, '挤掉最旧的来源，仍然接受新邻居')
  assert.equal(limiter.size(), 2)
  limiter.clear()
  assert.equal(limiter.size(), 0)
})

test('默认限额就是 SPEC 的 500 MiB / 200 件', () => {
  assert.equal(MAX_GIFT_TOTAL_BYTES, 500 * 1024 * 1024)
  assert.equal(MAX_GIFT_COUNT, 200)
})

test('磁盘限额：超过 200 件按 receivedAt 删最旧，刚写的永远保留', async (t) => {
  const dir = await tempDir(t)
  const log = { warn () {} }
  const store = await createGiftStore(dir, { log, maxCount: 3 })
  const ids = [0, 1, 2, 3].map(() => randomUUID())

  for (let index = 0; index < ids.length; index += 1) {
    const saved = await store.receiveText({
      ...textGift(ids[index], '第 ' + index + ' 件'),
      receivedAt: T0 + index
    })
    assert.equal(saved.ok, true)
  }

  const dirs = await readdir(join(dir, GIFTS_DIR))
  assert.equal(dirs.length, 3, '超过 3 件后立刻剪到 3 件')
  assert.equal(dirs.includes(giftDirName(ids[0], T0)), false, '最旧的那件被整目录删掉')
  assert.equal(dirs.includes(giftDirName(ids[3], T0 + 3)), true, '刚写的这一件一定在')
  assert.deepEqual(store.list().map((record) => record.id), [ids[3], ids[2], ids[1]])
})

test('磁盘限额：总量超了也按 receivedAt 删最旧；收下新礼物本身不失败', async (t) => {
  const dir = await tempDir(t)
  const log = { warn () {} }
  // 1 字节上限：每收下一件都会超，于是只保留刚写进来的那一件。
  const store = await createGiftStore(dir, { log, maxTotalBytes: 1 })
  const first = randomUUID()
  const second = randomUUID()
  const third = randomUUID()

  assert.equal((await store.receiveText({ ...textGift(first), receivedAt: T0 })).ok, true)
  assert.equal((await store.receiveText({ ...textGift(second), receivedAt: T0 + 1 })).ok, true)
  const saved = await store.receiveText({ ...textGift(third), receivedAt: T0 + 2 })
  assert.equal(saved.ok, true, '再紧的限额也不能让新件写不进去')
  assert.equal(saved.gift.id, third)

  const dirs = await readdir(join(dir, GIFTS_DIR))
  assert.deepEqual(dirs, [giftDirName(third, T0 + 2)])
  const sizes = await Promise.all(dirs.map(async (name) => {
    const files = await readdir(join(dir, GIFTS_DIR, name))
    const stats = await Promise.all(files.map((file) => stat(join(dir, GIFTS_DIR, name, file))))
    return stats.reduce((sum, info) => sum + info.size, 0)
  }))
  assert.ok(sizes[0] > 0)
  assert.deepEqual(store.list().map((record) => record.id), [third])
})
