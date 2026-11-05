import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { stripBom } from './json-text.js'
import { DSH_PET_ROUTE, stripJsonComments } from './pet-bridge.js'

/**
 * 把新名字写进 dsh-pet（ADR-0007）。
 *
 * 只做一件事：读成品配置 → 只改桥接那只宠物的 `name` → 把它写回去。
 * `PUT /dsh-pet-7340/config` 收的是**用户层**（扁平的 `{ pets, ... }`，不是 GET 那种
 * 按条目聚合的 `{ main: {...} }`），响应才是聚合。所以这里 GET 拿聚合、取 `main`
 * 那一层的整段 pets、改完把 `{ pets }` 传回去——其余顶层字段（physics / font /
 * whisperPrompt / memes…）由 dsh-pet 自己从磁盘透传保留，我们不碰。
 *
 * 失败语义是**原子**的：返回 `ok:false` 时磁盘上什么都没动。名字只有一份，
 * 不能在错误路径上制造“本地叫 A、dsh-pet 叫 B”的分叉。
 *
 * 接口缺席的兜底（ADR-0007 修订）：`GET /config` 拿到 **404** 说明 dsh-pet 根本没
 * 挂进这个 DSH（DSH 对未注册路由回 404），而不是“它正在忙”。这种机器上它的配置文件
 * 仍然是名字的真相，用户也仍然要能改名——所以退到直接改那份文件（见 writePetNameFile）。
 * 只有 404 走这条：超时、连接被拒、5xx 都还当“dsh-pet 在但不可用”，保持原来的整体失败，
 * 免得在它正写配置的时候两边互相覆盖。
 */
export const CONFIG_TIMEOUT_MS = 2000

/**
 * 找到“用户层”那一条。dsh-pet 的成品配置形如 `{ main: {...}, <pet-pack>: {...} }`，
 * 只有 `main` 是可以回写的用户层（桥接的那只宠物就来自 `main-config.jsonc`）。
 *
 * 指定了 petId 却不在 `main` 里 → 返回 null（调用方回 `dsh-pet-no-pet`）。**绝不**退到别的
 * 条目：那会把一只 pet-pack 的 `pets` 当成用户层 PUT 回去，等于把整只宠物抄进 `main`。
 */
export function pickUserEntry (aggregate, petId) {
  if (aggregate === null || typeof aggregate !== 'object' || Array.isArray(aggregate)) return null
  const main = aggregate.main
  if (!isEntryWithPets(main)) return null
  if (typeof petId === 'string' && petId !== '' && indexOfPet(main.pets, petId) < 0) return null
  return main
}

/** 指定了 id 但找不到就返回 -1：宁可失败，也不要改错一只宠物。 */
export function indexOfPet (pets, petId) {
  if (!Array.isArray(pets) || pets.length === 0) return -1
  if (typeof petId !== 'string' || petId === '') return 0
  return pets.findIndex((pet) => pet !== null && typeof pet === 'object' && pet.id === petId)
}

export async function writePetName ({
  origin,
  petId = null,
  name,
  configPath = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = CONFIG_TIMEOUT_MS
} = {}) {
  if (typeof origin !== 'string' || origin === '' || typeof fetchImpl !== 'function') {
    return { ok: false, error: 'dsh-pet-unreachable' }
  }
  if (typeof name !== 'string' || name === '') return { ok: false, error: 'bad-nickname' }

  const url = origin.replace(/\/+$/, '') + DSH_PET_ROUTE + '/config'

  let aggregate
  try {
    const response = await fetchOnce(fetchImpl, url, { method: 'GET' }, timeoutMs)
    // 404 = 这个 DSH 里没有 dsh-pet 的 /config 路由。它的配置文件还在，所以名字的真相
    // 还在那儿——直接改文件，别让“插件没启用”变成“永远改不了名”。
    if (response.status === 404 && typeof configPath === 'string' && configPath !== '') {
      return await writePetNameFile({ configPath, petId, name })
    }
    if (!response.ok) return { ok: false, error: 'dsh-pet-unreachable', status: response.status }
    aggregate = await response.json()
  } catch {
    return { ok: false, error: 'dsh-pet-unreachable' }
  }

  const entry = pickUserEntry(aggregate, petId)
  if (entry === null) return { ok: false, error: 'dsh-pet-no-pet' }
  const index = indexOfPet(entry.pets, petId)
  if (index < 0) return { ok: false, error: 'dsh-pet-no-pet' }

  const pets = entry.pets.map((pet, at) => (at === index ? { ...pet, name } : pet))
  try {
    const response = await fetchOnce(
      fetchImpl,
      url,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pets })
      },
      timeoutMs
    )
    // 400 = 字段不合法；409 = dsh-pet 的“用户配置损坏，要不要重建”预检。
    // 两种都不能带 ?force=1 硬闯：那会把用户手写的字段静默抹掉。
    if (!response.ok) return { ok: false, error: 'dsh-pet-write-failed', status: response.status }
  } catch {
    return { ok: false, error: 'dsh-pet-write-failed' }
  }

  const written = entry.pets[index]
  return { ok: true, name, id: typeof written?.id === 'string' ? written.id : null }
}

/**
 * 直写 dsh-pet 的用户配置（只在它的 `/config` 路由不存在时走）。
 *
 * 磁盘上的 `main-config.jsonc` **就是** PUT 的 body 形状：没有 `{ main: ... }` 那层
 * 聚合，顶层是 `pets` + 全局字段。所以这里读它、只换目标那只是 `name`、整份写回去，
 * 别的顶层与宠物字段一个都不动（比 dsh-pet 自己的 PUT 更保守——它按白名单重建宠物）。
 *
 * 两条已知取舍，都写进 ADR-0007 的修订里：
 *   - 注释会丢：dsh-pet 自己的 PUT 也是 `JSON.stringify` 重写，同样不留注释；
 *   - 这时候 dsh-pet 没挂载，所以不存在“它同时在写”的竞争；反过来只要它的接口在，
 *     就绝不走这条路。
 */
export async function writePetNameFile ({ configPath, petId = null, name } = {}) {
  if (typeof configPath !== 'string' || configPath === '') {
    return { ok: false, error: 'dsh-pet-unreachable' }
  }
  if (typeof name !== 'string' || name === '') return { ok: false, error: 'bad-nickname' }

  let text
  try {
    text = await readFile(configPath, 'utf8')
  } catch (error) {
    // 文件不在 = 没有用户层可写；存在但读不出来（权限/是目录）= 写了也不可信
    return { ok: false, error: error?.code === 'ENOENT' ? 'dsh-pet-no-pet' : 'dsh-pet-write-failed' }
  }

  let config
  try {
    config = JSON.parse(stripJsonComments(stripBom(text)))
  } catch {
    return { ok: false, error: 'dsh-pet-write-failed' }
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, error: 'dsh-pet-write-failed' }
  }

  const index = indexOfPet(config.pets, petId)
  if (index < 0) return { ok: false, error: 'dsh-pet-no-pet' }

  const pets = config.pets.map((pet, at) => (at === index ? { ...pet, name } : pet))
  try {
    await writeJsonAtomically(configPath, JSON.stringify({ ...config, pets }, null, 2) + '\n')
  } catch {
    return { ok: false, error: 'dsh-pet-write-failed' }
  }

  const written = pets[index]
  return { ok: true, name, id: typeof written?.id === 'string' ? written.id : null, via: 'file' }
}

/** 同目录临时文件 + rename：崩在中间也不会留下半份配置；权限跟着原文件走。 */
async function writeJsonAtomically (file, body) {
  let mode = 0o600
  try {
    const info = await stat(file)
    if (Number.isInteger(info.mode)) mode = (info.mode & 0o777) || 0o600
  } catch {
    // 读不到原权限就按 0600 建：配置里有 API key 一类的字段
  }
  const temp = join(dirname(file), '.' + basename(file) + '.' + process.pid + '-' + Date.now().toString(36) + '.tmp')
  try {
    await writeFile(temp, body, { encoding: 'utf8', mode })
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

function isEntryWithPets (entry) {
  return entry !== null && typeof entry === 'object' && Array.isArray(entry.pets) && entry.pets.length > 0
}

async function fetchOnce (fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await fetchImpl(url, { ...init, cache: 'no-store', signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
