import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PEERS_FILE, createPeerStore } from '../src/peers.js'

const T0 = 1_700_000_000_000

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-peers-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('没有 peers.json 时从空名单开始，不告警', async (t) => {
  const dir = await tempDir(t)
  const warnings = []
  const store = await createPeerStore(dir, { log: { warn: (line) => warnings.push(line) } })

  assert.deepEqual(store.trust(), { allowed: {}, denied: {} })
  assert.deepEqual(store.counts(), { allowed: 0, denied: 0 })
  assert.equal(store.isAllowed(randomUUID()), false)
  assert.deepEqual(warnings, [])
})

test('放行/拒绝真实落盘，重启后原样读回', async (t) => {
  const dir = await tempDir(t)
  const allowedId = randomUUID()
  const deniedId = randomUUID()
  const store = await createPeerStore(dir, { now: () => T0 })

  assert.equal(await store.admit({ deviceId: allowedId, nickname: '  隔壁 同事  ', at: T0 }), true)
  assert.equal(await store.reject({ deviceId: deniedId, nickname: '发广告的', at: T0 + 1 }), true)
  assert.equal(store.isAllowed(allowedId), true)
  assert.equal(store.isDenied(deniedId), true)

  const expected = {
    allowed: { [allowedId]: { nickname: '隔壁 同事', allowedAt: T0 } },
    denied: { [deniedId]: { nickname: '发广告的', deniedAt: T0 + 1 } }
  }
  assert.deepEqual(store.trust(), expected)
  // 文件形状就是契约：可手改、可删。
  assert.deepEqual(JSON.parse(await readFile(join(dir, PEERS_FILE), 'utf8')), expected)

  const restarted = await createPeerStore(dir)
  assert.deepEqual(restarted.trust(), expected)
  assert.equal(restarted.isAllowed(allowedId), true)
  assert.equal(restarted.isDenied(deniedId), true)
})

test('损坏的名单文件按空名单运行，只告警一次，之后仍能重写', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, PEERS_FILE), '{ not json', 'utf8')
  const warnings = []
  const store = await createPeerStore(dir, { log: { warn: (line) => warnings.push(line) } })

  assert.deepEqual(store.trust(), { allowed: {}, denied: {} })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /放行名单/)

  const deviceId = randomUUID()
  assert.equal(await store.admit({ deviceId, nickname: '甲', at: T0 }), true)
  assert.deepEqual(JSON.parse(await readFile(join(dir, PEERS_FILE), 'utf8')), {
    allowed: { [deviceId]: { nickname: '甲', allowedAt: T0 } },
    denied: {}
  })
})

test('形状不对的名单文件也不会崩', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, PEERS_FILE), '[]', 'utf8')
  const warnings = []
  const store = await createPeerStore(dir, { log: { warn: (line) => warnings.push(line) } })
  assert.deepEqual(store.trust(), { allowed: {}, denied: {} })
  assert.equal(warnings.length, 1)
})

test('手改文件：非法条目被忽略，缺昵称有兜底，拒绝优先于放行', async (t) => {
  const dir = await tempDir(t)
  const conflictId = randomUUID()
  const upperId = randomUUID().toUpperCase()
  const bareId = randomUUID()

  await writeFile(join(dir, PEERS_FILE), JSON.stringify({
    allowed: {
      [conflictId]: { nickname: '原本放行', allowedAt: 10 },
      'not-a-uuid': { nickname: '坏键', allowedAt: 11 },
      [upperId]: { nickname: '大写 ID', allowedAt: 12 },
      [bareId]: { allowedAt: 13 },
      'also-bad': 'not-an-object'
    },
    denied: {
      [conflictId]: { nickname: '拒绝优先', deniedAt: 20 }
    }
  }), 'utf8')

  const store = await createPeerStore(dir)
  const trust = store.trust()
  assert.deepEqual(Object.keys(trust.allowed).sort(), [upperId.toLowerCase(), bareId].sort())
  assert.deepEqual(Object.keys(trust.denied), [conflictId])
  assert.equal(trust.allowed[upperId.toLowerCase()].nickname, '大写 ID')
  assert.equal(trust.allowed[bareId].nickname, '邻居')
  assert.equal(trust.denied[conflictId].nickname, '拒绝优先')
  assert.equal(store.isAllowed(conflictId), false)
  assert.equal(store.isDenied(conflictId), true)
})

test('名单有条数上限，超出丢最旧的，文件不会无限长', async (t) => {
  const dir = await tempDir(t)
  const store = await createPeerStore(dir, { now: () => T0, maxPeers: 3 })

  const ids = []
  for (let index = 0; index < 5; index += 1) {
    const deviceId = randomUUID()
    ids.push(deviceId)
    await store.admit({ deviceId, nickname: '邻居' + index, at: T0 + index })
  }
  assert.equal(store.counts().allowed, 3)
  assert.equal(store.isAllowed(ids[0]), false)
  assert.equal(store.isAllowed(ids[1]), false)
  assert.equal(store.isAllowed(ids[4]), true)

  const raw = JSON.parse(await readFile(join(dir, PEERS_FILE), 'utf8'))
  assert.equal(Object.keys(raw.allowed).length, 3)
})

test('写不进去时内存里照常生效，只告警一次', async (t) => {
  const dir = await tempDir(t)
  const blocker = join(dir, 'a-file')
  await writeFile(blocker, 'x', 'utf8')
  const warnings = []
  const store = await createPeerStore(join(blocker, 'nested'), {
    now: () => T0,
    log: { warn: (line) => warnings.push(line) }
  })

  const allowedId = randomUUID()
  const deniedId = randomUUID()
  assert.equal(await store.admit({ deviceId: allowedId, nickname: '甲', at: T0 }), false)
  assert.equal(await store.reject({ deviceId: deniedId, nickname: '乙', at: T0 }), false)

  assert.equal(store.isAllowed(allowedId), true)
  assert.equal(store.isDenied(deniedId), true)
  assert.equal(warnings.filter((line) => /写不进去/.test(line)).length, 1)
})

test('非法 deviceId 不会被写进名单', async (t) => {
  const dir = await tempDir(t)
  const store = await createPeerStore(dir)
  assert.equal(await store.admit({ deviceId: 'neighbor-a', nickname: '甲' }), false)
  assert.equal(await store.reject({ deviceId: '', nickname: '甲' }), false)
  assert.deepEqual(store.trust(), { allowed: {}, denied: {} })
})
