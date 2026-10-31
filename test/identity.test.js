import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  IDENTITY_FILE,
  createIdentity,
  defaultNickname
} from '../src/identity.js'
import { isDeviceId } from '../src/protocol.js'

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-identity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('昵称默认取宠物名，否则主机名，最后兜底', () => {
  assert.equal(defaultNickname({ petName: '蓝毛小女仆', hostname: 'mac' }), '蓝毛小女仆')
  assert.equal(defaultNickname({ petName: null, hostname: 'mac' }), 'mac')
  assert.equal(defaultNickname({ petName: '  ', hostname: '' }), '我')
  assert.equal(defaultNickname({ petName: '喵'.repeat(40), hostname: 'mac' }).length, 32)
})

test('deviceId 持久化，重启后还是同一台机器', async (t) => {
  const dir = await tempDir(t)
  const first = await createIdentity(dir, { defaultNickname: '蓝毛小女仆' })
  assert.equal(isDeviceId(first.deviceId), true)
  assert.equal(first.nickname, '蓝毛小女仆')
  assert.equal(first.persisted, true)

  const raw = JSON.parse(await readFile(join(dir, IDENTITY_FILE), 'utf8'))
  assert.deepEqual(raw, { deviceId: first.deviceId, nickname: '蓝毛小女仆' })

  const second = await createIdentity(dir, { defaultNickname: '别的主机名' })
  assert.equal(second.deviceId, first.deviceId)
  assert.equal(second.nickname, '蓝毛小女仆')
})

test('改昵称先落盘再改内存，非法昵称不生效', async (t) => {
  const dir = await tempDir(t)
  const identity = await createIdentity(dir, { defaultNickname: '旧名字' })

  assert.equal(await identity.rename('  新 名字  '), '新 名字')
  assert.equal(identity.nickname, '新 名字')
  assert.equal(JSON.parse(await readFile(join(dir, IDENTITY_FILE), 'utf8')).nickname, '新 名字')

  assert.equal(await identity.rename('\u0000\u0007'), null)
  assert.equal(identity.nickname, '新 名字')
})

test('损坏或字段非法的身份文件会重新生成，但不丢可读昵称', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, IDENTITY_FILE), '{ not json', 'utf8')
  const broken = await createIdentity(dir, { defaultNickname: '主机名' })
  assert.equal(isDeviceId(broken.deviceId), true)
  assert.equal(broken.nickname, '主机名')

  await writeFile(join(dir, IDENTITY_FILE), JSON.stringify({ deviceId: 'not-a-uuid', nickname: '保留的名字' }), 'utf8')
  const partial = await createIdentity(dir, { defaultNickname: '主机名' })
  assert.equal(isDeviceId(partial.deviceId), true)
  assert.equal(partial.nickname, '保留的名字')
  assert.notEqual(partial.deviceId, 'not-a-uuid')
})

test('目录写不进去时仍然给可用的内存身份，插件不崩', async (t) => {
  const dir = await tempDir(t)
  const blocker = join(dir, 'a-file')
  await writeFile(blocker, 'x', 'utf8')
  const warnings = []
  const identity = await createIdentity(join(blocker, 'nested'), {
    defaultNickname: '主机名',
    log: { warn: (line) => warnings.push(line) }
  })
  assert.equal(isDeviceId(identity.deviceId), true)
  assert.equal(identity.nickname, '主机名')
  assert.equal(identity.persisted, false)
  assert.ok(warnings.length >= 1)
  assert.ok(warnings.some((line) => /身份文件写不进去/.test(line)))
})
