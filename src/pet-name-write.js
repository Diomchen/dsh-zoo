import { DSH_PET_ROUTE } from './pet-bridge.js'

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
