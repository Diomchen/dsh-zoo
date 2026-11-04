import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadSkinSources, SKIN_FILE } from '../src/skin-sources.js'

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-skin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 按目录返回文件名；未登记的目录抛 ENOENT，和真实 readdir 一样。 */
function fakeReaddir (map) {
  return async (dir) => {
    if (!Object.prototype.hasOwnProperty.call(map, dir)) {
      const error = new Error('ENOENT: ' + dir)
      error.code = 'ENOENT'
      throw error
    }
    return map[dir]
  }
}

test('没配置 skin.json 时，dsh-pet 的素材目录自动成为一个源', async (t) => {
  const dir = await tempDir(t)
  const petDir = join(dir, 'pet-assets')
  const result = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => [petDir],
    readdir: fakeReaddir({ [petDir]: ['待机呼吸休闲.webm', '东张西望.webm'] })
  })

  assert.equal(result.sources.length, 1)
  const [source] = result.sources
  assert.equal(source.id, 'dsh-pet')
  assert.equal(source.size, 462)
  assert.equal(source.manifest.v, 1)
  assert.equal(source.manifest.id, 'dsh-pet')
  assert.equal(source.manifest.idle, '待机呼吸休闲')
  assert.deepEqual(Object.keys(source.actions).sort(), ['东张西望', '待机呼吸休闲'])
  assert.deepEqual(source.manifest.actions['东张西望'], { file: '东张西望.webm', loop: true })
})

test('skin.json 可以列多个源，动作 id 就是文件名去掉 .webm', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, SKIN_FILE), JSON.stringify({
    sources: [
      { id: 'corgi', name: '柯基', dir: '/skins/a', size: 220 },
      { id: 'cat', dir: '/skins/b' }
    ]
  }), 'utf8')

  const result = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => [],
    readdir: fakeReaddir({
      '/skins/a': ['idle.webm', 'walk.webm'],
      '/skins/b': ['sleep.webm']
    })
  })

  assert.deepEqual(result.sources.map((s) => s.id), ['corgi', 'cat'])
  assert.equal(result.sources[0].size, 220)
  // `name` 不再是皮的字段：身份证就是 id，清单里也照抄 id（ticket 33）。
  assert.equal(result.sources[0].name, undefined)
  assert.equal(result.sources[0].manifest.name, 'corgi')
  assert.equal(result.sources[1].size, 462)
  assert.deepEqual(Object.keys(result.sources[1].actions), ['sleep'])
  assert.equal(result.sources[0].manifest.idle, 'idle')
})

test('同名动作按目录优先级取第一个', async (t) => {
  const dir = await tempDir(t)
  const result = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => ['/skins/high', '/skins/low'],
    readdir: fakeReaddir({
      '/skins/high': ['东张西望.webm'],
      '/skins/low': ['东张西望.webm', '小憩.webm']
    })
  })

  const [source] = result.sources
  assert.equal(source.actions['东张西望'].dir, '/skins/high')
  assert.equal(source.actions['小憩'].dir, '/skins/low')
})

test('idle 优先「待机呼吸休闲」；没有就取排序后的第一个动作', async (t) => {
  const dir = await tempDir(t)

  const withIdle = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => ['/skins/x'],
    readdir: fakeReaddir({ '/skins/x': ['A.webm', '待机呼吸休闲.webm'] })
  })
  assert.equal(withIdle.sources[0].manifest.idle, '待机呼吸休闲')

  const withoutIdle = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => ['/skins/y'],
    readdir: fakeReaddir({ '/skins/y': ['B.webm', 'A.webm'] })
  })
  assert.equal(withoutIdle.sources[0].manifest.idle, 'A')
})

test('非法的源被跳过并记一条告警', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, SKIN_FILE), JSON.stringify({
    sources: [
      { id: '../evil', dir: '/skins/a' },
      { id: 'relative', dir: 'not/absolute' },
      { id: 'huge', dir: '/skins/c', size: 99999 }
    ]
  }), 'utf8')

  const result = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => [],
    readdir: fakeReaddir({ '/skins/a': ['idle.webm'] })
  })

  assert.equal(result.sources.length, 0)
  assert.equal(result.warnings.length, 3)
  assert.deepEqual(result.warnings.map((w) => w.code).sort(), ['bad-dir', 'bad-id', 'bad-size'])
})

test('目录不存在、或目录里没有合法 webm 的源被跳过', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, SKIN_FILE), JSON.stringify({
    sources: [
      { id: 'missing', dir: '/skins/missing' },
      { id: 'empty', dir: '/skins/empty' }
    ]
  }), 'utf8')

  const result = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => [],
    readdir: fakeReaddir({ '/skins/empty': ['readme.txt', '.hidden.webm'] })
  })

  assert.equal(result.sources.length, 0)
  assert.deepEqual(result.warnings.map((w) => w.code).sort(), ['empty-source', 'missing-dir'])
})

test('危险文件名与隐藏文件不进动作清单', async (t) => {
  const dir = await tempDir(t)
  const result = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => ['/skins/names'],
    readdir: fakeReaddir({
      '/skins/names': ['../evil.webm', '.hidden.webm', 'a.txt', '好.webm', 'a\\b.webm']
    })
  })

  assert.deepEqual(Object.keys(result.sources[0].actions), ['好'])
})

test('skin.json 坏掉时回落到自动 dsh-pet 源', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, SKIN_FILE), '{ not json', 'utf8')

  const result = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => ['/skins/pet'],
    readdir: fakeReaddir({ '/skins/pet': ['待机呼吸休闲.webm'] })
  })

  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].id, 'dsh-pet')
  assert.deepEqual(result.warnings.map((w) => w.code), ['bad-skin-file'])
})

test('显式空数组表示不要任何源，不自动补 dsh-pet', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, SKIN_FILE), JSON.stringify({ sources: [] }), 'utf8')

  const result = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => ['/skins/pet'],
    readdir: fakeReaddir({ '/skins/pet': ['待机呼吸休闲.webm'] })
  })

  assert.equal(result.sources.length, 0)
})

test('重复的源 id 只保留第一个', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, SKIN_FILE), JSON.stringify({
    sources: [
      { id: 'dup', dir: '/skins/a' },
      { id: 'dup', dir: '/skins/b' }
    ]
  }), 'utf8')

  const result = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => [],
    readdir: fakeReaddir({
      '/skins/a': ['idle.webm'],
      '/skins/b': ['idle.webm']
    })
  })

  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].dirs[0], '/skins/a')
  assert.deepEqual(result.warnings.map((w) => w.code), ['duplicate-id'])
})

test('~ 展开到 home', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, SKIN_FILE), JSON.stringify({
    sources: [{ id: 'home', dir: '~/skins/a' }]
  }), 'utf8')

  const result = await loadSkinSources({
    dataDir: dir,
    home: '/home/tester',
    resolveDshPetDirs: () => [],
    readdir: fakeReaddir({ '/home/tester/skins/a': ['idle.webm'] })
  })

  assert.equal(result.sources[0].dirs[0], '/home/tester/skins/a')
})

test('待机池过滤掉点击回应/拖拽/事件/文字类，只留日常动作', async () => {
  const { idlePoolOf } = await import('../src/skin-sources.js')
  const source = {
    actions: {
      写代码: {}, 吃西瓜: {}, 待机呼吸休闲: {},
      '点击回应-开心跃动': {}, 被鼠标拖拽悬空反馈: {},
      '余额-钱袋满溢': {}, '碎碎念-发呆碎碎念': {}, '工作状态-忙碌点按': {},
      '是啊，吃什么': {}, 深度思考碎碎念: {}
    }
  }
  assert.deepEqual(idlePoolOf(source), ['写代码', '吃西瓜', '待机呼吸休闲'].sort())
})

test('皮可以自己指定待机动作：别的素材包不叫「待机呼吸休闲」', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, SKIN_FILE), JSON.stringify({
    sources: [{ id: 'cat', dir: '/skins/cat', idle: '待机' }]
  }), 'utf8')

  const result = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => [],
    readdir: fakeReaddir({ '/skins/cat': ['待机.webm', '伸爪拍屏幕.webm', '追尾巴.webm'] })
  })

  assert.deepEqual(result.warnings, [])
  assert.equal(result.sources[0].idle, '待机')
  assert.equal(result.sources[0].manifest.idle, '待机')
})

test('待机动作声明了但目录里没有：告警一次，回落到字母序第一段', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, SKIN_FILE), JSON.stringify({
    sources: [{ id: 'cat', dir: '/skins/cat', idle: '不存在的动作' }]
  }), 'utf8')

  const result = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => [],
    readdir: fakeReaddir({ '/skins/cat': ['哈气.webm', '伸爪拍屏幕.webm'] })
  })

  assert.deepEqual(result.warnings.map((w) => w.code), ['bad-idle'])
  // 没有声明、也没有「待机呼吸休闲」时，仍是字母序第一段（码点序：伸 < 哈）。
  assert.equal(result.sources[0].idle, '伸爪拍屏幕')
})

test('一次性动作不进待机池，清单里也不再标 loop', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, SKIN_FILE), JSON.stringify({
    sources: [{ id: 'cat', dir: '/skins/cat', idle: '待机', once: ['喷火', '打滚晒太阳', '没有这段'] }]
  }), 'utf8')

  const result = await loadSkinSources({
    dataDir: dir,
    resolveDshPetDirs: () => [],
    readdir: fakeReaddir({
      '/skins/cat': ['待机.webm', '喷火.webm', '打滚晒太阳.webm', '东张西望.webm']
    })
  })

  const [source] = result.sources
  assert.deepEqual(result.warnings.map((w) => w.code), ['bad-once'])
  assert.deepEqual(source.once, ['喷火', '打滚晒太阳'])
  assert.equal(source.manifest.actions['喷火'].loop, false)
  assert.equal(source.manifest.actions['待机'].loop, true)

  const { idlePoolOf } = await import('../src/skin-sources.js')
  assert.deepEqual(idlePoolOf(source), ['东张西望', '待机'])
})
