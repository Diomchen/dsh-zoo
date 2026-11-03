import { readFile } from 'node:fs/promises'

import { MAX_NICKNAME, isSafeAnimationName, sanitizeLabel } from './protocol.js'

/**
 * dsh-pet 适配层。它很薄，因为 dsh-pet 的 HTTP 接口是**未承诺接口**：
 * - 只读 `/state`，不写它的配置；
 * - 唯一写口是 `/anim` 点播（ADR-0009）——桌面右键菜单的「动作」必须落到本体，
 *   否则影子会在下一个 `/state` tick 被回落，邻居也会看到假动作；
 * - 只借 `/thumb/main/<动画名>.webm` 的素材路由（客户端用）；
 * - 任何失败都降级成一行说明，绝不让客厅白屏。
 *
 * 已知限制：dsh-pet 不上报随机待机动画。`/state` 里只有**被点播过**的
 * `pets.<id>.anim` 叶子，所以这里的影子只能镜像“被命令过的动作”，
 * 其余时间客户端自己轮播内置待机片段。不要试图从播放进度猜待机动作。
 */
export const DSH_PET_ROUTE = '/dsh-pet-7340'
export const STATE_POLL_MS = 1000
export const CONFIG_TTL_MS = 30000

/** 剥掉 JSONC 的行注释与块注释；字符串里的 `//` 不会被误删。 */
export function stripJsonComments (source) {
  if (typeof source !== 'string') return ''
  let out = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    const next = source[i + 1]

    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      continue
    }

    if (char === '/' && next === '/') {
      i += 2
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i += 1
      if (i < source.length) out += source[i]
      continue
    }

    if (char === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n'
        i += 1
      }
      i += 1
      continue
    }

    out += char
  }

  return out
}

/** 取配置里的第一只宠物：name 用于显示，id 用于和 /state 对齐。 */
export function firstPetConfig (config) {
  const pets = Array.isArray(config?.pets) ? config.pets : []
  for (const pet of pets) {
    if (pet === null || typeof pet !== 'object' || Array.isArray(pet)) continue
    const id = typeof pet.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(pet.id) ? pet.id : null
    // 名字与线路上的昵称共用一个上限（32 码点）：否则会出现“桌上写着 40 字、邻居看到 32 字”，
    // 又变回两个名字。空名按 dsh-pet 自己的规则回落成宠物 id（ADR-0007）。
    const name = sanitizeLabel(pet.name, MAX_NICKNAME) ?? id
    return { name, id }
  }
  return { name: null, id: null }
}

/** 读取 dsh-pet 的用户配置。文件不存在/损坏都只是“没有名字”，不抛。 */
export async function readPetConfig (configPath) {
  if (typeof configPath !== 'string' || configPath === '') {
    return { exists: false, name: null, id: null }
  }
  let text
  try {
    text = await readFile(configPath, 'utf8')
  } catch (error) {
    // 不存在 = 没装 dsh-pet；存在但读不出来（权限/是目录）= 装了但桥接不可用
    return { exists: error?.code !== 'ENOENT', name: null, id: null }
  }
  try {
    const parsed = JSON.parse(stripJsonComments(text))
    return { exists: true, ...firstPetConfig(parsed) }
  } catch {
    return { exists: true, name: null, id: null }
  }
}

/**
 * 从 `/state` 里取第一只宠物（优先与配置里的 id 对齐）的 anim 叶子。
 * 只读 `pets.<id>.anim.data.name`；`url` 形式是用户自定义素材，回落到待机。
 * 返回值里的 anim 已过安全动画名校验，客户端可以直接拼进 URL。
 */
export function extractPetState (state, { preferredId } = {}) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return { present: false, anim: null }
  }
  const pets = state.pets
  if (pets === null || typeof pets !== 'object' || Array.isArray(pets)) {
    return { present: false, anim: null }
  }
  const ids = Object.keys(pets)
  if (ids.length === 0) return { present: false, anim: null }
  const id = typeof preferredId === 'string' && Object.prototype.hasOwnProperty.call(pets, preferredId)
    ? preferredId
    : ids[0]
  const pet = pets[id]
  const leaf = pet !== null && typeof pet === 'object' && pet.anim !== null && typeof pet.anim === 'object'
    ? pet.anim
    : null
  const data = leaf !== null && leaf.data !== null && typeof leaf.data === 'object' ? leaf.data : null
  const anim = data !== null && isSafeAnimationName(data.name) ? data.name.trim() : null
  return { present: true, anim }
}

/**
 * 轮询 dsh-pet。`getOrigin` 每次现取，因为 DSH 的 webServer 可能在插件
 * apply 之后才绑定端口（dsh-pet 自己也是这么重试的）。
 */
export function createPetBridge ({
  getOrigin,
  configPath,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = STATE_POLL_MS,
  timeoutMs = 1500,
  configTtlMs = CONFIG_TTL_MS,
  onChange,
  log,
  now = () => Date.now()
} = {}) {
  let disposed = false
  let timer = null
  let configCache = null
  let lastSignature = null
  const warningReasons = new Set()

  async function config () {
    const at = now()
    if (configCache !== null && at - configCache.at < configTtlMs) return configCache.value
    const value = await readPetConfig(configPath)
    configCache = { at, value }
    return value
  }

  function origin () {
    try {
      const value = getOrigin?.()
      if (typeof value !== 'string' || value === '') return null
      return value.replace(/\/+$/, '')
    } catch {
      return null
    }
  }

  async function fetchState (base) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    timeout.unref?.()
    try {
      return await fetchImpl(base + DSH_PET_ROUTE + '/state', {
        method: 'GET',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: controller.signal
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  async function pollOnce () {
    if (disposed) return null
    const petConfig = await config()
    const base = origin()
    let result

    if (base === null) {
      result = failure('starting', petFromConfig(petConfig, null))
    } else {
      let response = null
      try {
        response = await fetchState(base)
      } catch {
        response = null
      }

      if (response === null || !response.ok) {
        result = failure(
          petConfig.exists ? 'unreachable' : 'not-installed',
          petFromConfig(petConfig, null)
        )
      } else {
        let state = null
        try {
          state = await response.json()
        } catch {
          state = null
        }
        if (state === null) {
          result = failure(
            petConfig.exists ? 'unreachable' : 'not-installed',
            petFromConfig(petConfig, null)
          )
        } else {
          const extracted = extractPetState(state, { preferredId: petConfig.id })
          // 关键：/state 的 pets 叶子只在被写过时存在。配置里有名字就说明
          // “这只宠物存在”，没有 anim 叶子只代表它现在没被点播过（待机）。
          const pet = extracted.present
            ? { name: petConfig.name, anim: extracted.anim }
            : petFromConfig(petConfig, null)
          result = pet === null
            ? failure('no-pet', null)
            : { bridge: { ok: true, reason: null }, pet }
        }
      }
    }

    if (disposed) return null
    emit(result)
    return result
  }

  function failure (reason, pet) {
    if (reason !== 'starting' && !warningReasons.has(reason)) {
      warningReasons.add(reason)
      try {
        log?.warn?.(bridgeMessage(reason))
      } catch {
        // 日志失败不影响轮询
      }
    }
    return { bridge: { ok: false, reason }, pet }
  }

  function emit (result) {
    const signature = JSON.stringify(result)
    if (signature === lastSignature) return
    lastSignature = signature
    try {
      onChange?.(result)
    } catch {
      // 客厅状态坏了不能把轮询循环搞崩
    }
  }

  function schedule () {
    if (disposed || timer !== null) return
    const interval = Number.isFinite(pollIntervalMs) && pollIntervalMs >= 200 ? pollIntervalMs : STATE_POLL_MS
    timer = setTimeout(async () => {
      timer = null
      try {
        await pollOnce()
      } catch {
        // pollOnce 自己已经处理了所有预期错误
      }
      schedule()
    }, interval)
    timer.unref?.()
  }

  async function start () {
    const first = await pollOnce()
    if (!disposed) schedule()
    return first
  }

  /**
   * 配置可能刚被我们（或者用户）改过：清掉 30 秒 TTL，立刻重读一次。
   * 改名之后用它，桌面标签不用等下一拍。
   */
  async function refresh () {
    configCache = null
    return pollOnce()
  }

  function dispose () {
    disposed = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /**
   * 点播一段动作（[ADR-0009](../../docs/adr/0009-anim-playback-write-port.md)）：唯一的写口。
   *
   * 走的正是 dsh-pet 自己右键菜单「动作」那条路（`POST /anim?pet=<id>` + `{name}`），
   * 所以效果与它本体完全一致，`/state` 也会把这一句回灌给影子。
   *
   * 返回 `{ ok:true }` 或 `{ ok:false, reason, message? }`，**绝不抛**：
   *   unreachable  够不着它的 HTTP 口（没装/没起/超时）
   *   no-pet       配置里没有宠物，没地方点播
   *   rejected     它自己拒了（名字不在它的动画集合里、正被拖拽占用…），message 是它的原话
   * 调用方（桌面菜单）拿到 false 就降级成本机播一次。
   */
  async function playAnim (name, { facing } = {}) {
    if (disposed) return { ok: false, reason: 'unreachable' }
    const anim = typeof name === 'string' ? name.trim() : ''
    if (anim === '') return { ok: false, reason: 'rejected', message: '动画名是空的' }
    const base = origin()
    if (base === null) return { ok: false, reason: 'unreachable' }
    const petConfig = await config()
    const petId = typeof petConfig?.id === 'string' && petConfig.id !== '' ? petConfig.id : null
    if (petId === null) return { ok: false, reason: 'no-pet' }

    const body = { name: anim }
    if (facing === 'left' || facing === 'right') body.facing = facing
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    timeout.unref?.()
    try {
      const response = await fetchImpl(
        // `surface` 是 dsh-pet 的必填参数（issue #122）：声明"我要哪一端的宠物"。
        // local-pet 不是它的渲染端，只是镜像 /state，所以这里明说 `any`——
        // 只要那只宠物显示在任意一端就受理；display:none 会被它自己拒掉。
        base + DSH_PET_ROUTE + '/anim?pet=' + encodeURIComponent(petId) + '&surface=any',
        {
          method: 'POST',
          cache: 'no-store',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        }
      )
      if (!response.ok) return { ok: false, reason: 'unreachable' }
      let result = null
      try {
        result = await response.json()
      } catch {
        result = null
      }
      if (result !== null && typeof result === 'object' && result.ok === true) return { ok: true }
      return {
        ok: false,
        reason: 'rejected',
        message: typeof result?.message === 'string' ? result.message : null,
        code: typeof result?.reason === 'string' ? result.reason : null
      }
    } catch {
      return { ok: false, reason: 'unreachable' }
    } finally {
      clearTimeout(timeout)
    }
  }

  return { start, pollOnce, refresh, playAnim, dispose }
}

function petFromConfig (petConfig, anim) {
  if (petConfig.name === null && anim === null) return null
  return { name: petConfig.name, anim }
}

function bridgeMessage (reason) {
  if (reason === 'not-installed') return '没找到 dsh-pet，客厅只显示一行说明（邻居灯仍然可用）'
  if (reason === 'unreachable') return 'dsh-pet 没有响应，客厅先降级成一行说明'
  if (reason === 'no-pet') return 'dsh-pet 里还没有宠物，客厅先显示一行说明'
  return 'dsh-pet 桥接失败，客厅先降级成一行说明'
}
