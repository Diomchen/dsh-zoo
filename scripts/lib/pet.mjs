/**
 * 单机双宠物（票 50）。
 *
 * 一台机器上起**两只真宠物**：两个临时数据目录、两条回环 UDP、两条真 HTTP。
 * 它们互相发现、互相放行、互相串门——于是偷菜、帮忙、挂牌、雇佣、结算全都能在本机
 * 手动走一遍，不用第二台机器、不改协议、不写假邻居的农场状态机。
 *
 * 深度在哪：把「怎么把一个 service 立在回环上」这件事整个藏起来。调用方只看见
 *   - `deviceId` / `baseUrl`（可以直接 curl）
 *   - `action(name, body)` → 真 `POST /dsh-zoo/action`
 *   - `state()` → 真 `GET /dsh-zoo/state`
 * 端口、目录、路由表、`targetPort` 的对偶关系、收尾，一件都不外露。
 *
 * 为什么不是「假邻居 + 假农场」：那等于把成熟度、守卫、上限、工资结算在第二处重写，
 * 协议一改就漂；而且「偷成功」只能证明宿主对，不证明规则对。这里两侧都是真代码。
 *
 * 为什么接口就是产品自己的 HTTP：`src/service.js:434-500` 已经注册了四条
 * `{ kind: 'exact', path, handler }` 路由，挂到 `node:http` 上就是一个 exact 匹配的
 * 分发器。于是 harness 不新增任何协议面——`action()` 和用户 `curl` 的是同一条路。
 */
import { createSocket } from 'node:dgram'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FARM_FILE, initialFarmState } from '../../src/farm.js'
import { CROPS } from '../../src/farm-rules.js'
import { createService } from '../../src/service.js'

/** 一次 `action()` 的上限：`farm-steal` 会等 UDP 结果（最长 ~1.8 秒），留足余量。 */
const ACTION_TIMEOUT_MS = 15000
const STATE_TIMEOUT_MS = 5000

/**
 * 起一对宠物。**顺序启动**，不是并发。
 *
 * 第一只的 beacon 会发给一个还没人监听的端口（丢掉），第二只的 beacon 才落在第一只耳朵里；
 * 第一只回 `beacon-ack`，第二只从此知道该往哪儿发心跳，两只就都认识对方了。
 * 反过来并发启动会让两只的首次 beacon 同时落在空端口上，白等 60 秒。
 */
export async function startPair (options = {}) {
  const ports = await Promise.all([freeUdpPort(), freeUdpPort()])
  const [portA, portB] = ports
  if (portA === portB) return startPair(options) // 极小概率撞同一个号，重来一次

  const dirA = await mkdtemp(join(tmpdir(), 'dsh-zoo-pair-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'dsh-zoo-pair-b-'))
  const pets = []

  try {
    const a = await startOne({ dir: dirA, port: portA, peerPort: portB, overrides: options.a })
    pets.push(a)
    const b = await startOne({ dir: dirB, port: portB, peerPort: portA, overrides: options.b })
    pets.push(b)

    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await Promise.all(pets.map((pet) => pet.close()))
    }
    return { a: a.view, b: b.view, close }
  } catch (error) {
    await Promise.all(pets.map((pet) => pet.close()))
    await Promise.all([removeDir(dirA), removeDir(dirB)])
    throw error
  }
}

/**
 * 轮询到一个条件成立为止。测试和 CLI 都需要「等两只认识」「等合同 active」这类等待，
 * 让每个调用方自己手搓 timeout 循环是重复的噪音。
 *
 * 谓词抛错不算失败（刚启动时 HTTP 还没热），只记下最后一次错误放进超时文案。
 */
export async function until (predicate, { timeoutMs = 8000, intervalMs = 50, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  for (;;) {
    try {
      const value = await predicate()
      if (value) return value
      lastError = null
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      throw new Error('等了 ' + timeoutMs + 'ms 还没满足：' + label +
        (lastError === null ? '' : '（最后一次错误：' + lastError.message + '）'))
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

async function startOne ({ dir, port, peerPort, overrides = {} }) {
  // `mature` 是场景布置，不是 service 选项：哪些地块一开始就熟了（`{ p1: 'tomato' }`）。
  // 不这么给的话，每个想偷一次的人都要手抄一份 farm.json（version/coins/dew/plot 形状）。
  const { mature, ...serviceOptions } = overrides
  if (mature !== undefined) await writeFile(join(dir, FARM_FILE), JSON.stringify(seedFarm(mature)), 'utf8')

  const routes = []
  const ctx = {
    webServer: {
      register (registration) {
        routes.push(registration)
        return () => {}
      }
    },
    logger: { info () {}, warn () {} }
  }

  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    port,
    // LAN 端口让内核给（0 = 临时端口）：默认 45873 会让同进程里先后起的多只宠物互相抢口，
    // 收尾没赶上的话，后来的请求会打到上一只**已经 dispose** 的服务器上（那边 farm 是 null，回 404）。
    skinPort: 0,
    // 发广播/收广播都走回环；对端端口是**另一只**的 UDP 端口（票 50 的 D4）。
    targetPort: peerPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    // 回环上两只共用 127.0.0.1 的 20 包/10 秒限速：广播放稀（60 秒），心跳 3 秒。
    // 首次被发现不靠广播：第二只的第一条 beacon 落在第一只耳朵里，之后靠 ack + 心跳。
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 3000,
    // 挂牌只在「改了」和「满 30 秒」时广播，丢一包就得等半分钟（`失败不重试`）。
    // 回环上丢包是常态（限速），所以把周期调短：丢一包 5 秒内自然补上。
    marketDigestMs: 5000,
    tickIntervalMs: 50,
    desktop: false,
    petBridge: false,
    ...serviceOptions
  })

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find((candidate) => candidate.kind === 'exact' && candidate.path === path)
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    void route.handler(request, response)
  })

  try {
    await listen(server)
  } catch (error) {
    service.dispose()
    throw error
  }

  const baseUrl = 'http://127.0.0.1:' + server.address().port

  async function state () {
    return (await requestJson(baseUrl, '/dsh-zoo/state', { timeoutMs: STATE_TIMEOUT_MS })).body
  }

  async function action (name, body = {}) {
    return requestJson(baseUrl, '/dsh-zoo/action', { method: 'POST', body: { action: name, ...body } })
  }

  // deviceId 只从状态出口读：身份是 service 建的，harness 不另生成一份。
  const deviceId = (await untilState(state)).self.deviceId

  const close = async () => {
    // 兜底：service 自己也会用 fetch（取邻居素材/农场快照），空闲连接不掐掉
    // `server.close()` 会一直等到对端超时。
    server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve()))
    try {
      await service.dispose()
    } catch {
      // 已经关了
    }
    await removeDir(dir)
  }

  return {
    view: { deviceId, baseUrl, port, action, state },
    close
  }
}

async function untilState (state) {
  return until(async () => {
    const view = await state()
    return typeof view?.self?.deviceId === 'string' && view.self.deviceId !== '' ? view : false
  }, { label: 'service 起来并给出 deviceId' })
}

/**
 * 一次 HTTP 往返，回 `{ status, body }`。
 *
 * 用 `node:http` 而不是 `fetch`：全局 fetch 走 undici 的连接池，空闲的 keep-alive socket
 * 会让进程在测试跑完之后还挂 4 秒；`agent: false` 每条请求一条连接，用完就关。
 */
function requestJson (baseUrl, path, { method = 'GET', body = null, timeoutMs = ACTION_TIMEOUT_MS } = {}) {
  const url = new URL(path, baseUrl)
  const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8')
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method,
      agent: false,
      headers: payload === null
        ? {}
        : { 'content-type': 'application/json', 'content-length': payload.length }
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          resolve({ status: response.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) })
        } catch (error) {
          reject(new Error('回的不是 JSON：' + text.slice(0, 200)))
        }
      })
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('请求超时：' + path)))
    request.on('error', reject)
    if (payload !== null) request.write(payload)
    request.end()
  })
}

/** 一份合法的 farm.json：初始农场，`mature` 里点名的地块已经熟透。 */
function seedFarm (mature) {
  const state = initialFarmState()
  for (const [id, crop] of Object.entries(mature ?? {})) {
    const plot = state.plots.find((candidate) => candidate.id === id)
    if (plot === undefined || CROPS[crop] === undefined) continue
    const growMs = CROPS[crop].growMs
    Object.assign(plot, { crop, plantedAt: Date.now() - growMs, grownMs: growMs, growMs })
  }
  return state
}

function listen (server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function freeUdpPort () {
  const socket = createSocket('udp4')
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address()
      socket.close(() => resolve(port))
    })
  })
}

async function removeDir (dir) {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  } catch {
    // 收尾失败不该让一次成功的跑挂掉
  }
}
