import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DATA_DIR_NAME,
  LEGACY_DATA_DIR_NAME,
  dataDir,
  legacyDataDir,
  prepareDataDir
} from '../src/paths.js'
import { apply } from '../index.js'

async function tempHome (t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-zoo-paths-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

async function exists (path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

test('数据目录叫 dsh-zoo；旧名字只在迁移路径里出现', () => {
  const env = { DSH_HOME: '/tmp/example-dsh-home' }
  assert.equal(DATA_DIR_NAME, 'dsh-zoo')
  assert.equal(LEGACY_DATA_DIR_NAME, 'local-pet')
  assert.equal(dataDir(env), join(env.DSH_HOME, 'dsh-zoo'))
  assert.equal(legacyDataDir(env), join(env.DSH_HOME, 'local-pet'))
})

test('只有旧目录：整体改名到新目录，内容一个不少', async (t) => {
  const home = await tempHome(t)
  const env = { DSH_HOME: home }
  const legacy = legacyDataDir(env)
  const target = dataDir(env)
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'identity.json'), '{"deviceId":"keep-me"}\n', 'utf8')

  const result = prepareDataDir(env)

  assert.equal(result.dir, target)
  assert.equal(result.migrated, true)
  assert.equal(result.fallback, false)
  assert.equal(await exists(legacy), false, '旧目录已经被整体改名')
  assert.equal(await readFile(join(target, 'identity.json'), 'utf8'), '{"deviceId":"keep-me"}\n')
})

test('新目录已经存在：用新目录，旧目录原样留着', async (t) => {
  const home = await tempHome(t)
  const env = { DSH_HOME: home }
  const legacy = legacyDataDir(env)
  const target = dataDir(env)
  await mkdir(legacy, { recursive: true })
  await mkdir(target, { recursive: true })
  await writeFile(join(legacy, 'identity.json'), 'old\n', 'utf8')
  await writeFile(join(target, 'identity.json'), 'new\n', 'utf8')

  const result = prepareDataDir(env)

  assert.equal(result.dir, target)
  assert.equal(result.migrated, false)
  assert.equal(result.fallback, false)
  assert.equal(await readFile(join(target, 'identity.json'), 'utf8'), 'new\n')
  assert.equal(await readFile(join(legacy, 'identity.json'), 'utf8'), 'old\n')
})

test('两个目录都不存在：返回新路径，不创建任何目录', async (t) => {
  const home = await tempHome(t)
  const env = { DSH_HOME: home }

  const result = prepareDataDir(env)

  assert.equal(result.dir, dataDir(env))
  assert.equal(result.migrated, false)
  assert.equal(result.fallback, false)
  assert.equal(await exists(dataDir(env)), false)
  assert.equal(await exists(legacyDataDir(env)), false)
})

test('改名失败：继续用旧目录，数据不丢，并带上原因', async (t) => {
  const home = await tempHome(t)
  const env = { DSH_HOME: home }
  const legacy = legacyDataDir(env)
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'peers.json'), '{"admitted":["a"]}\n', 'utf8')
  const denied = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })

  const result = prepareDataDir(env, {
    rename: () => { throw denied }
  })

  assert.equal(result.dir, legacy)
  assert.equal(result.migrated, false)
  assert.equal(result.fallback, true)
  assert.equal(result.error, denied)
  assert.equal(await readFile(join(legacy, 'peers.json'), 'utf8'), '{"admitted":["a"]}\n')
  assert.equal(await exists(dataDir(env)), false)
})

test('宿主启动时先迁移旧目录：换名字不换设备身份', async (t) => {
  const home = await tempHome(t)
  const env = { DSH_HOME: home }
  const legacy = legacyDataDir(env)
  await mkdir(legacy, { recursive: true })
  await writeFile(
    join(legacy, 'identity.json'),
    '{"deviceId":"11111111-1111-4111-8111-111111111111","nickname":"旧身份"}\n',
    'utf8'
  )

  const infos = []
  const effects = []
  apply({
    webServer: { register () { return () => {} } },
    effect (fn) { effects.push(fn) },
    logger: { info (line) { infos.push(line) }, warn () {} }
  }, {
    env,
    network: false,
    petBridge: false,
    desktop: false,
    skinServer: false
  })

  try {
    assert.equal(await exists(join(dataDir(env), 'identity.json')), true, '旧身份应该在新目录里')
    assert.equal(await exists(legacy), false, '旧目录应该已经被整体改名')
    assert.match(infos.join('\n'), /数据目录已迁移/)
  } finally {
    for (const effect of effects) {
      const dispose = effect()
      if (typeof dispose === 'function') dispose()
    }
  }
})
