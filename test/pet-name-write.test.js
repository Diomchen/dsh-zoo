import assert from 'node:assert/strict'
import test from 'node:test'

import { indexOfPet, pickUserEntry, writePetName } from '../src/pet-name-write.js'

const ORIGIN = 'http://127.0.0.1:61543'

function pet (id, name, extra = {}) {
  return {
    id,
    name,
    size: 462,
    balanceEnabled: true,
    display: 'desktop',
    position: { corner: 'top-right', marginX: 24, marginY: 100 },
    ...extra
  }
}

function stubFetch (handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const call = { url, method: init.method ?? 'GET', body: init.body ?? null }
    calls.push(call)
    const reply = await handler(call)
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.json
    }
  }
  impl.calls = calls
  return impl
}

test('只改目标那只宠物的名字，其余字段原样带回去', async () => {
  const config = { main: { pets: [pet('main', '蓝毛小女仆'), pet('second', '二号')] } }
  const fetchImpl = stubFetch((call) => {
    if (call.method === 'GET') return { status: 200, json: config }
    return { status: 200, json: { main: { pets: JSON.parse(call.body).pets } } }
  })

  const result = await writePetName({
    origin: ORIGIN,
    petId: 'second',
    name: '新名字',
    fetchImpl
  })

  assert.deepEqual(result, { ok: true, name: '新名字', id: 'second' })
  assert.equal(fetchImpl.calls.length, 2)
  const [get, put] = fetchImpl.calls
  assert.equal(get.method, 'GET')
  assert.equal(get.url, ORIGIN + '/dsh-pet-7340/config')
  assert.equal(put.method, 'PUT')
  assert.equal(put.url, ORIGIN + '/dsh-pet-7340/config')

  // PUT 的是**用户层**（扁平 { pets }），不是 GET 那种按条目聚合的形状
  const body = JSON.parse(put.body)
  assert.deepEqual(Object.keys(body), ['pets'])
  assert.deepEqual(body.pets.map((entry) => entry.name), ['蓝毛小女仆', '新名字'])
  assert.equal(body.pets[1].size, 462)
})

test('petId 找不到就不写：宁可失败，也不改错一只', async () => {
  const fetchImpl = stubFetch(() => ({ status: 200, json: { main: { pets: [pet('main', '蓝毛小女仆')] } } }))
  const result = await writePetName({ origin: ORIGIN, petId: 'ghost', name: '新名字', fetchImpl })

  assert.deepEqual(result, { ok: false, error: 'dsh-pet-no-pet' })
  assert.equal(fetchImpl.calls.length, 1, '只发过 GET')
})

test('PUT 不成功：把 dsh-pet 的状态码带回去，调用方据此判失败', async () => {
  const fetchImpl = stubFetch((call) => {
    if (call.method === 'GET') return { status: 200, json: { main: { pets: [pet('main', '蓝毛小女仆')] } } }
    return { status: 409, json: { error: 'user config is unparsable', needConfirm: true } }
  })

  const result = await writePetName({ origin: ORIGIN, petId: 'main', name: '新名字', fetchImpl })
  assert.deepEqual(result, { ok: false, error: 'dsh-pet-write-failed', status: 409 })
})

test('没有 origin 或者读不到配置：dsh-pet-unreachable，一个请求都不发', async () => {
  const fetchImpl = stubFetch(() => ({ status: 200, json: {} }))
  for (const origin of [null, '', undefined]) {
    assert.deepEqual(
      await writePetName({ origin, petId: 'main', name: '新名字', fetchImpl }),
      { ok: false, error: 'dsh-pet-unreachable' }
    )
  }
  assert.equal(fetchImpl.calls.length, 0)

  const notFound = stubFetch(() => ({ status: 404, json: null }))
  assert.deepEqual(
    await writePetName({ origin: ORIGIN, petId: 'main', name: '新名字', fetchImpl: notFound }),
    { ok: false, error: 'dsh-pet-unreachable', status: 404 }
  )
})

test('只认 main 这一层；桥接的 id 不在 main 里就失败，绝不退到别的条目', () => {
  const withMain = { main: { pets: [pet('main', '一号')] }, pack: { pets: [pet('pack', '二号')] } }
  assert.equal(pickUserEntry(withMain, 'main').pets[0].id, 'main')
  assert.equal(pickUserEntry(withMain, null).pets[0].id, 'main')
  // main 里没有这只 → null（否则会把 pack 的整份 pets 当用户层写回去）
  assert.equal(pickUserEntry(withMain, 'pack'), null)

  const onlyPack = { pack: { pets: [pet('pack', '二号')] } }
  assert.equal(pickUserEntry(onlyPack, 'pack'), null)
  assert.equal(pickUserEntry(onlyPack, null), null)
  assert.equal(pickUserEntry(null, 'main'), null)
  assert.equal(pickUserEntry({ main: { pets: [] } }, 'main'), null)
})

test('没指定 petId 时改第一只', () => {
  assert.equal(indexOfPet([pet('a', 'A'), pet('b', 'B')], null), 0)
  assert.equal(indexOfPet([pet('a', 'A'), pet('b', 'B')], 'b'), 1)
  assert.equal(indexOfPet([], 'a'), -1)
  assert.equal(indexOfPet([pet('a', 'A')], 'ghost'), -1)
})
