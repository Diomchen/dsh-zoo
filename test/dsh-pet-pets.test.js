import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { discoverPetPacks } from '../src/dsh-pet-pets.js'

/** 一个假 pet 目录：文件系统全注入，不落盘。 */
function fakeFs ({ files = {}, dirs = [], clips = {}, listings = {} } = {}) {
  const readdir = async (dir) => {
    if (Object.prototype.hasOwnProperty.call(listings, dir)) return listings[dir]
    if (Object.prototype.hasOwnProperty.call(clips, dir)) return clips[dir]
    const error = new Error('ENOENT: ' + dir)
    error.code = 'ENOENT'
    throw error
  }
  const readFile = async (path) => {
    if (!Object.prototype.hasOwnProperty.call(files, path)) {
      const error = new Error('ENOENT: ' + path)
      error.code = 'ENOENT'
      throw error
    }
    return files[path]
  }
  const isDirectory = (path) => dirs.includes(path)
  return { readdir, readFile, isDirectory }
}

const PET_DIR = join('/home/u/.dsh/dsh-pet/pet')
const CAT_DIR = join(PET_DIR, 'maodie-animation')
const petFile = (...parts) => join(PET_DIR, ...parts)

function config (overrides = {}) {
  return JSON.stringify({
    pets: [{ id: 'maodie', name: '橘猫', size: 400, display: 'desktop', ...overrides }],
    animations: { idle: ['待机', '睡觉'] }
  })
}

test('扫描宠物包：config 给 id / size / idle，目录给 dirs', async () => {
  const fs = fakeFs({
    files: { [petFile('maodie-config.json')]: config() },
    listings: { [PET_DIR]: ['maodie-config.json', 'maodie-animation'] },
    dirs: [CAT_DIR],
    clips: { [CAT_DIR]: ['待机.webm', '踩奶.webm'] }
  })

  const result = await discoverPetPacks({ petDir: PET_DIR, ...fs })

  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.packs, [{
    id: 'maodie',
    prefix: 'maodie',
    dirs: [CAT_DIR],
    size: 400,
    idle: '待机'
  }])
})

test('扫描宠物包：主人把它关掉了（display:none）就不该被拽回来', async () => {
  const fs = fakeFs({
    files: { [petFile('maodie-config.json')]: config({ display: 'none' }) },
    listings: { [PET_DIR]: ['maodie-config.json', 'maodie-animation'] },
    dirs: [CAT_DIR],
    clips: { [CAT_DIR]: ['待机.webm'] }
  })

  const result = await discoverPetPacks({ petDir: PET_DIR, ...fs })
  assert.deepEqual(result.packs, [])
  assert.deepEqual(result.warnings, [])
})

test('扫描宠物包：坏配置、缺动画目录、空目录都只跳过自己', async () => {
  const fs = fakeFs({
    files: {
      [petFile('broken-config.json')]: '{ not json',
      [petFile('nodir-config.json')]: config({ id: 'nodir' }),
      [petFile('empty-config.json')]: config({ id: 'empty' })
    },
    listings: {
      [PET_DIR]: ['broken-config.json', 'nodir-config.json', 'empty-config.json'],
      [petFile('empty-animation')]: ['readme.txt']
    },
    dirs: [petFile('empty-animation')],
    clips: { [petFile('empty-animation')]: ['readme.txt'] }
  })

  const result = await discoverPetPacks({ petDir: PET_DIR, ...fs })

  assert.deepEqual(result.packs, [])
  // 按目录前缀排序扫：broken → empty（目录在但没 webm）→ nodir（根本没有动画目录）
  assert.deepEqual(result.warnings.map((w) => w.code), ['bad-config', 'empty-animation', 'no-animation'])
})

test('扫描宠物包：jsonc 带注释也认；id 不合法就退回目录前缀', async () => {
  const dir = petFile('weird-animation')
  const fs = fakeFs({
    files: {
      [petFile('weird-config.jsonc')]: '{\n  // 猫\n  "pets": [{ "id": "../etc", "size": 300 }],\n  "animations": { "idle": ["待机"] }\n}'
    },
    listings: { [PET_DIR]: ['weird-config.jsonc'] },
    dirs: [dir],
    clips: { [dir]: ['待机.webm'] }
  })

  const result = await discoverPetPacks({ petDir: PET_DIR, ...fs })

  assert.equal(result.packs.length, 1)
  assert.equal(result.packs[0].id, 'weird', '非法 id 退回目录前缀')
  assert.equal(result.packs[0].size, 300)
})

test('扫描宠物包：目录不存在不算错误', async () => {
  const fs = fakeFs({})
  const result = await discoverPetPacks({ petDir: PET_DIR, ...fs })
  assert.deepEqual(result, { packs: [], warnings: [] })
})

test('扫描宠物包：BOM 也要读得出来（Windows 的编辑器会写）', async () => {
  const fs = fakeFs({
    files: { [petFile('maodie-config.json')]: '\uFEFF' + config() },
    listings: { [PET_DIR]: ['maodie-config.json'] },
    dirs: [CAT_DIR],
    clips: { [CAT_DIR]: ['待机.webm'] }
  })

  const result = await discoverPetPacks({ petDir: PET_DIR, ...fs })
  assert.equal(result.packs.length, 1)
  assert.equal(result.packs[0].id, 'maodie')
})
