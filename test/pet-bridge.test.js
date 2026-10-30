import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createPetBridge,
  extractPetState,
  firstPetConfig,
  readPetConfig,
  stripJsonComments
} from '../src/pet-bridge.js'

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-bridge-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function listen (server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return `http://127.0.0.1:${server.address().port}`
}

function close (server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('JSONC 注释被剥掉，但字符串里的 // 保留', () => {
  const source = `{
    // 这是注释
    "pets": [
      { "id": "main", "name": "蓝毛小女仆" } /* 块注释 */
    ],
    "note": "http://example.com/a//b"
  }`
  const parsed = JSON.parse(stripJsonComments(source))
  assert.equal(parsed.pets[0].name, '蓝毛小女仆')
  assert.equal(parsed.note, 'http://example.com/a//b')
  assert.equal(stripJsonComments('{"a":"x"} // tail'), '{"a":"x"} ')
})

test('配置取第一只宠物，坏文件只是没有名字', async (t) => {
  const dir = await tempDir(t)
  const good = join(dir, 'good.jsonc')
  await writeFile(good, `{// hi\n"pets":[{"id":"main","name":" 蓝毛小女仆 "}]}`, 'utf8')
  assert.deepEqual(await readPetConfig(good), {
    exists: true,
    name: '蓝毛小女仆',
    id: 'main'
  })

  const broken = join(dir, 'broken.jsonc')
  await writeFile(broken, '{ nope', 'utf8')
  assert.deepEqual(await readPetConfig(broken), { exists: true, name: null, id: null })

  assert.deepEqual(await readPetConfig(join(dir, 'missing.jsonc')), {
    exists: false,
    name: null,
    id: null
  })
  assert.deepEqual(firstPetConfig({ pets: [null, { id: '../bad', name: 42 }] }), {
    name: null,
    id: null
  })
})

test('从 /state 只读 anim.data.name，并优先对齐配置里的 pet id', () => {
  const state = {
    counter: 3,
    pets: {
      other: { anim: { counter: 1, data: { name: '写代码', playbackId: 9 } } },
      main: { anim: { counter: 2, data: { name: '东张西望', playbackId: 10 } } }
    }
  }
  assert.deepEqual(extractPetState(state, { preferredId: 'main' }), {
    present: true,
    anim: '东张西望'
  })
  assert.deepEqual(extractPetState(state), { present: true, anim: '写代码' })

  assert.deepEqual(extractPetState({ pets: { main: { say: { data: {} } } } }), {
    present: true,
    anim: null
  })
  assert.deepEqual(extractPetState({ pets: { main: { anim: { data: { url: 'https://x/a.webm' } } } } }), {
    present: true,
    anim: null
  })
  assert.deepEqual(extractPetState({ pets: { main: { anim: { data: { name: '../evil' } } } } }), {
    present: true,
    anim: null
  })
  assert.deepEqual(extractPetState({ pets: {} }), { present: false, anim: null })
  assert.deepEqual(extractPetState(null), { present: false, anim: null })
})

test('轮询成功时给出 {name, anim}，失败时降级且不抛', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'main-config.jsonc')
  await writeFile(configPath, '{"pets":[{"id":"main","name":"蓝毛小女仆"}]}', 'utf8')

  let mode = 'ok'
  const server = createServer((req, res) => {
    if (req.url !== '/dsh-pet-7340/state') {
      res.statusCode = 404
      res.end('not found')
      return
    }
    if (mode === 'fail') {
      res.statusCode = 500
      res.end('boom')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      counter: 4,
      pets: { main: { anim: { counter: 3, data: { name: '写代码', playbackId: 7 } } } }
    }))
  })
  const origin = await listen(server)
  t.after(() => close(server))

  const updates = []
  const bridge = createPetBridge({
    getOrigin: () => origin,
    configPath,
    pollIntervalMs: 60000,
    onChange: (update) => updates.push(update)
  })
  t.after(() => bridge.dispose())

  assert.deepEqual(await bridge.pollOnce(), {
    bridge: { ok: true, reason: null },
    pet: { name: '蓝毛小女仆', anim: '写代码' }
  })

  mode = 'fail'
  assert.deepEqual(await bridge.pollOnce(), {
    bridge: { ok: false, reason: 'unreachable' },
    pet: { name: '蓝毛小女仆', anim: null }
  })
  assert.equal(updates.length, 2)
})

test('origin 未就绪、无 pets 叶子、未安装、无宠物时都只降级', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'main-config.jsonc')
  await writeFile(configPath, '{"pets":[{"id":"main","name":"蓝毛小女仆"}]}', 'utf8')

  const starting = createPetBridge({
    getOrigin: () => null,
    configPath,
    pollIntervalMs: 60000
  })
  t.after(() => starting.dispose())
  assert.deepEqual(await starting.pollOnce(), {
    bridge: { ok: false, reason: 'starting' },
    pet: { name: '蓝毛小女仆', anim: null }
  })

  // 实际 dsh-pet 在没人点播动画时就是 pets:{}；配置里有名字 = 宠物存在，应该显示待机。
  const server = createServer((req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ counter: 1, pets: {} }))
  })
  const origin = await listen(server)
  t.after(() => close(server))

  const idlePet = createPetBridge({
    getOrigin: () => origin,
    configPath,
    pollIntervalMs: 60000
  })
  t.after(() => idlePet.dispose())
  assert.deepEqual(await idlePet.pollOnce(), {
    bridge: { ok: true, reason: null },
    pet: { name: '蓝毛小女仆', anim: null }
  })

  const noConfig = createPetBridge({
    getOrigin: () => origin,
    configPath: join(dir, 'missing.jsonc'),
    pollIntervalMs: 60000
  })
  t.after(() => noConfig.dispose())
  assert.deepEqual(await noConfig.pollOnce(), {
    bridge: { ok: false, reason: 'no-pet' },
    pet: null
  })

  const missingServer = createServer((req, res) => {
    res.statusCode = 404
    res.end('missing')
  })
  const missingOrigin = await listen(missingServer)
  t.after(() => close(missingServer))
  const missing = createPetBridge({
    getOrigin: () => missingOrigin,
    configPath: join(dir, 'missing.jsonc'),
    pollIntervalMs: 60000
  })
  t.after(() => missing.dispose())
  assert.deepEqual(await missing.pollOnce(), {
    bridge: { ok: false, reason: 'not-installed' },
    pet: null
  })
})

test('有宠物但配置里没有名字时，name 为 null 而不是伪造', async (t) => {
  const dir = await tempDir(t)
  const server = createServer((req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      counter: 1,
      pets: { main: { anim: { data: { name: '原地小憩沉眠' } } } }
    }))
  })
  const origin = await listen(server)
  t.after(() => close(server))

  const bridge = createPetBridge({
    getOrigin: () => origin,
    configPath: join(dir, 'missing.jsonc'),
    pollIntervalMs: 60000
  })
  t.after(() => bridge.dispose())
  assert.deepEqual(await bridge.pollOnce(), {
    bridge: { ok: true, reason: null },
    pet: { name: null, anim: '原地小憩沉眠' }
  })
})
