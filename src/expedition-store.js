/**
 * 「出远门」的存档（票 112）：`<dataDir>/expedition.json`。
 *
 * 只做三件事：把规则层的纯迁移落到内存、把硬币变动交给农场、把结果原子地写回磁盘。
 * 文件里有 run / shelf / codex / upgrades / trips / logs 六块。114 起每到一段同时记一笔图鉴
 * （首次获得时间），图鉴与陈列架共用这份 codex，不需要再迁一次格式；117 的 trips 只记每条路线
 * 平安回家的趟数；116 起每趟结束再追一篇旅行日志（最多 30 篇）。
 *
 * 结束迁移只走一个记账点（`#recordTrip`）：同一笔结束要么「run/trips/logs 一起落盘」，
 * 要么写失败时一起回滚，不会出现趟数记上了、日志没记（或反过来）的半截状态。
 *
 * 钱与状态顺序（一律「落盘成功才算数」）：
 *   出发：先扣盘缠再写 run（写失败退款并回滚）；
 *   到点：先记账（硬币 + run + 图鉴 + 趟数）再写盘，写失败把硬币与 run 一起退回，
 *         下一拍重来——记不上就下次补，绝不会「钱已到、档没落」导致重启后重复入账；
 *   折返/走满：钱在到点时就已进农场，这里只落 run 的结束标记。
 * tick 与 step/back 同一套事务语义：任何一步写盘失败都整拍回滚，不留半截状态。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  LANTERN_PRICE,
  ROUTE_IDS,
  SHELF_BASE_SLOTS,
  SHELF_MAX_SLOTS,
  SHELF_SLOT_PRICE,
  advanceRun,
  appendTripLog,
  backRun,
  codexView,
  expireRun,
  isActiveRun,
  normalizeRun,
  normalizeTripLogs,
  recordSouvenir,
  recordTrip,
  resumeRun,
  routeOf,
  settledOf,
  souvenirOf,
  startRun,
  stepRun,
  tripLog,
  unlockStatus
} from './expedition.js'

export const EXPEDITION_FILE = 'expedition.json'
const VERSION = 1
/**
 * 临时文件名的自增尾巴（与 `season-store.js` 同一套写法）：`<dir>/.expedition.json.tmp-<pid>-<n>`。
 * 固定名 `.tmp` 会让两个进程同时写时互相踩：一边刚写一半，另一边 rename 走了。
 */
let tempCounter = 0

function initialShelf () {
  return { slots: SHELF_BASE_SLOTS, items: [] }
}

/**
 * `slots` = 已解锁的格数（8 起，最多 32）；`items` 按下标对格，`items[0]` 是第 1 格，
 * `null`/缺位表示空格。同一件特产最多出现一次（读档时保留第一次、后面的坏位清空）。
 * 末尾的空格会被剪掉，所以空架子稳定落成 `{ slots: 8, items: [] }`。
 */
function normalizeShelf (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return initialShelf()
  const slots = Number.isInteger(raw.slots) && raw.slots >= SHELF_BASE_SLOTS && raw.slots <= SHELF_MAX_SLOTS
    ? raw.slots
    : SHELF_BASE_SLOTS
  const items = []
  const seen = new Set()
  if (Array.isArray(raw.items)) {
    for (const entry of raw.items.slice(0, slots)) {
      const id = typeof entry === 'string' && souvenirOf(entry) !== null && !seen.has(entry) ? entry : null
      if (id !== null) seen.add(id)
      items.push(id)
    }
  }
  while (items.length > 0 && items[items.length - 1] === null) items.pop()
  return { slots, items }
}

function normalizeCodex (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const codex = {}
  for (const [id, firstSeenAt] of Object.entries(raw)) {
    if (id.length === 0 || id.length > 64) continue
    if (!Number.isFinite(firstSeenAt)) continue
    codex[id] = firstSeenAt
  }
  return codex
}

/** 已回家的趟数（票 117 的解锁进度）：只认四条已知路线与非负整数，坏数据当 0。 */
function normalizeTrips (raw) {
  const trips = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return trips
  for (const [id, count] of Object.entries(raw)) {
    if (!ROUTE_IDS.includes(id)) continue
    if (!Number.isInteger(count) || count <= 0) continue
    trips[id] = count
  }
  return trips
}

/** 空文件/坏文件/旧字段都收敛到这一份完整形状。 */
function normalizeState (raw) {
  return {
    version: VERSION,
    run: normalizeRun(raw?.run),
    shelf: normalizeShelf(raw?.shelf),
    codex: normalizeCodex(raw?.codex),
    upgrades: { lantern: raw?.upgrades?.lantern === true },
    trips: normalizeTrips(raw?.trips),
    logs: normalizeTripLogs(raw?.logs)
  }
}

function copyRun (run) {
  return run === null ? null : { ...run, loot: run.loot.map((item) => ({ ...item })) }
}

export class ExpeditionStore {
  #dir
  #log
  #farm
  #now
  #newRunId
  #state = normalizeState(null)
  #queue = Promise.resolve()
  #disposed = false

  constructor (dir, { log = null, farm = null, now = () => Date.now(), newRunId = randomUUID } = {}) {
    this.#dir = dir
    this.#log = log
    this.#farm = farm
    this.#now = typeof now === 'function' ? now : () => Date.now()
    this.#newRunId = typeof newRunId === 'function' ? newRunId : randomUUID
  }

  async init () {
    await mkdir(this.#dir, { recursive: true })
    const file = join(this.#dir, EXPEDITION_FILE)
    let raw = null
    let missing = false
    try {
      raw = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') missing = true
      else this.#log?.('出远门存档读取失败，按空存档继续：' + (error?.message ?? error))
    }
    const state = normalizeState(raw)
    this.#state = state
    // 关门期间到点的，读档时只推进一个节点；推进了也要写回磁盘。
    const beforeResume = { run: state.run, codex: state.codex, trips: state.trips, logs: state.logs }
    const { advanced: resumed, credited } = await this.#resume(this.#now())
    // 坏文件/缺文件/旧形状都在启动时修一次，别等下一拍才写。
    if (missing || raw === null || resumed || JSON.stringify(state) !== JSON.stringify(raw)) {
      if (!(await this.#persist()) && resumed) {
        // 读档那一拍写不回去：连同硬币一起撤掉，等下一拍 tick 重来，别让重启重复入账。
        this.#state.run = beforeResume.run
        this.#state.codex = beforeResume.codex
        this.#state.trips = beforeResume.trips
        this.#state.logs = beforeResume.logs
        if (credited > 0) await this.#refund(credited)
      }
    }
    return this
  }

  /** 只读快照：调用方拿到的对象改了也不会影响存档。`codexView` 是窗口直接渲染的 32 格。 */
  snapshot () {
    return {
      version: this.#state.version,
      run: copyRun(this.#state.run),
      shelf: normalizeShelf(this.#state.shelf),
      codex: { ...this.#state.codex },
      codexView: codexView(this.#state.codex),
      upgrades: { ...this.#state.upgrades },
      trips: { ...this.#state.trips },
      logs: this.#state.logs.map((entry) => ({ ...entry }))
    }
  }

  /** 这一趟是不是还在外面（决定 away 门控与窗口的「继续」）。 */
  active () {
    return isActiveRun(this.#state.run)
  }

  /**
   * 出发：`expedition-start` 的唯一落点。
   * 拒绝顺序是「已经在外面 → 没有这条路线 → 还没解锁 → 还没准备好 → 钱不够」，
   * 先在内存里判完再动钱——锁着的路线一分盘缠都不该扣。
   */
  start ({ routeId } = {}) {
    return this.#serial(async () => {
      if (this.#disposed) return { ok: false, error: 'starting' }
      if (isActiveRun(this.#state.run)) return { ok: false, error: 'already-away' }
      const route = routeOf(routeId)
      if (route === null) return { ok: false, error: 'no-route' }
      const unlocked = unlockStatus(route, {
        trips: this.#state.trips,
        codexOwned: codexView(this.#state.codex).owned
      })
      if (!unlocked.unlocked) return { ok: false, error: 'locked' }
      if (this.#farm === null || typeof this.#farm.spendCoins !== 'function') {
        return { ok: false, error: 'starting' }
      }
      const run = startRun({ routeId: route.id, runId: this.#newRunId(), now: this.#now() })
      if (run === null) return { ok: false, error: 'starting' }

      const paid = await this.#farm.spendCoins(route.fare)
      if (paid === null || typeof paid !== 'object' || paid.ok !== true) {
        return { ok: false, error: paid?.error === 'no-coin' ? 'not-enough-coins' : 'starting' }
      }

      const previous = this.#state.run
      this.#state.run = run
      if (await this.#persist()) return { ok: true, run: copyRun(run) }

      // 写不进去就把这一趟整个撤掉：盘缠退回，内存里也不留半个 run。
      this.#state.run = previous
      if (typeof this.#farm.addCoins === 'function') {
        try {
          await this.#farm.addCoins(route.fare)
        } catch (error) {
          this.#log?.('出远门出发失败后退款也失败：' + (error?.message ?? error))
        }
      }
      return { ok: false, error: 'save-failed' }
    })
  }

  /**
   * 提灯（票 118）：一次买断，10,000 枚。已经买过就原样返回，绝不再扣一次钱。
   * 先扣钱再落盘；写不进去就退款并把 upgrades 回滚——不能出现「钱花了、灯没了」。
   */
  buyLantern () {
    return this.#serial(async () => {
      if (this.#disposed) return { ok: false, error: 'starting' }
      if (this.#state.upgrades.lantern === true) {
        return { ok: true, already: true, upgrades: { ...this.#state.upgrades } }
      }
      if (this.#farm === null || typeof this.#farm.spendCoins !== 'function') {
        return { ok: false, error: 'starting' }
      }
      const paid = await this.#farm.spendCoins(LANTERN_PRICE)
      if (paid === null || typeof paid !== 'object' || paid.ok !== true) {
        return { ok: false, error: paid?.error === 'no-coin' ? 'not-enough-coins' : 'starting' }
      }

      const previous = this.#state.upgrades
      this.#state.upgrades = { ...previous, lantern: true }
      if (await this.#persist()) return { ok: true, already: false, upgrades: { ...this.#state.upgrades } }

      this.#state.upgrades = previous
      if (typeof this.#farm.addCoins === 'function') {
        try {
          await this.#farm.addCoins(LANTERN_PRICE)
        } catch (error) {
          this.#log?.('出远门买提灯失败后退款也失败：' + (error?.message ?? error))
        }
      }
      return { ok: false, error: 'save-failed' }
    })
  }

  /** 「继续走」：只有决策窗合法；翻车当场结算（硬币照给，盘缠不退）。 */
  step (now = this.#now()) {
    return this.#serial(async () => {
      if (this.#disposed) return { ok: false, error: 'starting' }
      const next = stepRun(this.#state.run, now)
      if (next === null) return { ok: false, error: 'not-walking' }
      const settled = next.ended === null ? null : settledOf(next)
      const previous = this.#state.run
      const previousLedger = { trips: this.#state.trips, logs: this.#state.logs }
      this.#state.run = next
      if (settled !== null) this.#recordTrip(previous, next, now)
      if (await this.#persist()) {
        return settled === null ? { ok: true, run: copyRun(next) } : { ok: true, run: copyRun(next), settled }
      }
      // 写不进去：run、趟数、日志一起退回，绝不能只落一半。
      this.#state.run = previous
      this.#state.trips = previousLedger.trips
      this.#state.logs = previousLedger.logs
      return { ok: false, error: 'save-failed' }
    })
  }

  /**
   * 「见好就收」：只标折返，不再加钱——每段的回币在 tick 掉战利品时就已经进农场了，
   * 结算只是把「带回了多少」报给窗口。重复加钱是最容易犯的错，这里刻意不碰农场。
   */
  back (now = this.#now()) {
    return this.#serial(async () => {
      if (this.#disposed) return { ok: false, error: 'starting' }
      const next = backRun(this.#state.run, now)
      if (next === null) return { ok: false, error: 'not-walking' }
      const settled = settledOf(next)
      const previous = this.#state.run
      const previousLedger = { trips: this.#state.trips, logs: this.#state.logs }
      this.#state.run = next
      this.#recordTrip(previous, next, now)
      if (await this.#persist()) return { ok: true, run: copyRun(next), settled }
      // 写不进去就留在决策窗，让玩家能再点一次，而不是内存说回家了、重启又在外头。
      this.#state.run = previous
      this.#state.trips = previousLedger.trips
      this.#state.logs = previousLedger.logs
      return { ok: false, error: 'save-failed' }
    })
  }

  /**
   * 秒级 tick：先看决策窗有没有超时（超时即自动折返），再推走路。
   * 到点走完一段，回币进农场、特产记进图鉴；走满最后一段直接 complete。
   *
   * 返回是否真的推进了（服务层据此决定要不要重推窗口）。
   *
   * 写法与 step/back 一致：先把这一拍的变更全记在内存里，落盘成功才算数；
   * 落盘失败就把 run / 图鉴 / 趟数 / 日志一起退回，已经进农场的硬币也用 `#refund` 收回来。
   * 否则「钱到了、档没落」，重启后同一段会再入账一次。
   */
  tick (now = this.#now()) {
    return this.#serial(async () => {
      if (this.#disposed) return false
      const expired = expireRun(this.#state.run, now)
      if (expired !== null) {
        const previous = this.#state.run
        const previousLedger = { trips: this.#state.trips, logs: this.#state.logs }
        this.#state.run = expired
        this.#recordTrip(previous, expired, now)
        if (await this.#persist()) return true
        // 写不进去就还留在决策窗：下一拍再超时一次，不会只落一半。
        this.#state.run = previous
        this.#state.trips = previousLedger.trips
        this.#state.logs = previousLedger.logs
        return false
      }
      const event = advanceRun(this.#state.run, now, Object.keys(this.#state.codex))
      if (event === null) return false
      const previous = this.#state.run
      const previousLedger = { trips: this.#state.trips, logs: this.#state.logs }
      const previousCodex = this.#state.codex
      let credited = 0
      if (event.coins > 0) {
        const landed = await this.#credit(event.coins)
        if (landed === null) return false
        credited = landed
      }
      this.#state.run = event.run
      if (event.souvenir !== null && event.souvenir !== undefined) {
        // 只记第一次见到的时刻；重复获得时 recordSouvenir 原样返回。
        this.#state.codex = recordSouvenir(this.#state.codex, event.souvenir, now)
      }
      if (event.run.ended !== null) this.#recordTrip(previous, event.run, now)
      if (await this.#persist()) return true
      // 写不进去：这一拍整个撤掉，硬币也退回农场，下一拍重来。
      this.#state.run = previous
      this.#state.codex = previousCodex
      this.#state.trips = previousLedger.trips
      this.#state.logs = previousLedger.logs
      if (credited > 0) await this.#refund(credited)
      return false
    })
  }

  /**
   * 陈列架：开格、摆件、挪格、取下。
   *
   * 三种请求共用一个动作（spec 的 `expedition-shelf`）：
   * - `{ slot }`：开第 slot 格；只能开下一格，扣 5,000，钱不够报 `not-enough-coins`；
   * - `{ slot, itemId }`：把一件特产放进已解锁的空格；
   * - `{ moveFrom, moveTo? }`：挪到另一空格；不给 moveTo 就是取下。移动永远不碰农场。
   *
   * 摆/挪/取都只动 `shelf.items`，所以「同一件不能出现在两格」在这里一次判死。
   * 落盘失败一律回滚内存；开格失败还要把 5,000 退回农场。
   */
  shelfAction ({ slot = null, itemId = null, moveFrom = null, moveTo = null } = {}) {
    return this.#serial(async () => {
      if (this.#disposed) return { ok: false, error: 'starting' }
      const slotGiven = slot !== null && slot !== undefined
      const itemGiven = itemId !== null && itemId !== undefined
      const fromGiven = moveFrom !== null && moveFrom !== undefined
      const toGiven = moveTo !== null && moveTo !== undefined
      const previous = normalizeShelf(this.#state.shelf)

      if (fromGiven || toGiven) {
        if (slotGiven || itemGiven) return { ok: false, error: 'locked' }
        if (!Number.isInteger(moveFrom) || moveFrom < 1 || moveFrom > previous.slots) {
          return { ok: false, error: 'locked' }
        }
        const items = previous.items.slice()
        const carried = items[moveFrom - 1]
        if (carried === undefined || carried === null) return { ok: false, error: 'locked' }
        if (toGiven) {
          if (!Number.isInteger(moveTo) || moveTo < 1 || moveTo > previous.slots || moveTo === moveFrom) {
            return { ok: false, error: 'locked' }
          }
          const target = items[moveTo - 1]
          if (target !== undefined && target !== null) return { ok: false, error: 'locked' }
          items[moveFrom - 1] = null
          items[moveTo - 1] = carried
        } else {
          items[moveFrom - 1] = null
        }
        this.#state.shelf = normalizeShelf({ slots: previous.slots, items })
        if (await this.#persist()) return { ok: true, shelf: normalizeShelf(this.#state.shelf) }
        this.#state.shelf = previous
        return { ok: false, error: 'save-failed' }
      }

      if (!slotGiven) return { ok: false, error: 'locked' }

      if (itemGiven) {
        if (!Number.isInteger(slot) || slot < 1 || slot > previous.slots) return { ok: false, error: 'locked' }
        if (typeof itemId !== 'string' || souvenirOf(itemId) === null) return { ok: false, error: 'locked' }
        if (previous.items.includes(itemId)) return { ok: false, error: 'locked' }
        const occupant = previous.items[slot - 1]
        if (occupant !== undefined && occupant !== null) return { ok: false, error: 'locked' }
        const items = previous.items.slice()
        while (items.length < slot) items.push(null)
        items[slot - 1] = itemId
        this.#state.shelf = normalizeShelf({ slots: previous.slots, items })
        if (await this.#persist()) return { ok: true, shelf: normalizeShelf(this.#state.shelf) }
        this.#state.shelf = previous
        return { ok: false, error: 'save-failed' }
      }

      // 开格：只能按顺序开下一格，不能跳格、不能超过 32。
      if (!Number.isInteger(slot) || slot !== previous.slots + 1 || slot > SHELF_MAX_SLOTS) {
        return { ok: false, error: 'locked' }
      }
      if (this.#farm === null || typeof this.#farm.spendCoins !== 'function') {
        return { ok: false, error: 'starting' }
      }
      const paid = await this.#farm.spendCoins(SHELF_SLOT_PRICE)
      if (paid === null || typeof paid !== 'object' || paid.ok !== true) {
        return { ok: false, error: paid?.error === 'no-coin' ? 'not-enough-coins' : 'starting' }
      }

      this.#state.shelf = { slots: previous.slots + 1, items: previous.items }
      if (await this.#persist()) return { ok: true, shelf: normalizeShelf(this.#state.shelf) }

      this.#state.shelf = previous
      if (typeof this.#farm.addCoins === 'function') {
        try {
          await this.#farm.addCoins(SHELF_SLOT_PRICE)
        } catch (error) {
          this.#log?.('出远门开格失败后退款也失败：' + (error?.message ?? error))
        }
      }
      return { ok: false, error: 'save-failed' }
    })
  }

  /**
   * 卸载：不再接收新动作，等队列里已经排上的那一拍落完盘再返回（与 `season-store.dispose` 同款）。
   * 所以调用方要 `await`——只丢掉引用的话，最后那一次写盘可能跟着进程一起没了。
   */
  async dispose () {
    this.#disposed = true
    await this.#queue.catch(() => {})
  }

  /**
   * 读档续走：最多推进一个节点，不补算离线期间错过的段数、不补掷。
   * 钱先记、记不上就原样留着（下一拍 tick 再补），避免「硬币没到账、run 却往前走了」。
   *
   * 返回 `{ advanced, credited }`：`credited` 是真实到账的数额，`init` 落盘失败时按它退钱。
   */
  async #resume (now) {
    const event = resumeRun(this.#state.run, now)
    if (event === null) return { advanced: false, credited: 0 }
    let credited = 0
    if (event.coins > 0) {
      const landed = await this.#credit(event.coins)
      if (landed === null) return { advanced: false, credited: 0 }
      credited = landed
    }
    const previous = this.#state.run
    this.#state.run = event.run
    if (event.souvenir !== null && event.souvenir !== undefined) {
      this.#state.codex = recordSouvenir(this.#state.codex, event.souvenir, now)
    }
    if (event.run.ended !== null) this.#recordTrip(previous, event.run, now)
    return { advanced: true, credited }
  }

  /**
   * 一趟结束的唯一记账点：117 的趟数与 116 的日志在这里一起落账，只由结束迁移调用一次。
   *
   * - 趟数只认 `complete`/`back`：翻车（`failed`）不算，**超时算**——超时的 `ended` 也是
   *   `back`（`reason: 'timeout'`），宠物自己走回来了，跟见好就收同一档。`recordTrip` 自己会过滤；
   * - 日志四种结局都写一篇（116），`before` 只用于翻车丢件清单。
   *
   * 两个账本都要么留在原处、要么一起前进；写盘失败由调用方按同一份旧引用一起回滚。
   */
  #recordTrip (before, run, now) {
    if (run === null || typeof run !== 'object' || run.ended === null) return false
    const entry = tripLog(run, { at: Number.isFinite(run.endedAt) ? run.endedAt : now, before })
    this.#state.trips = recordTrip(this.#state.trips, run)
    if (entry !== null) this.#state.logs = appendTripLog(this.#state.logs, entry)
    return entry !== null
  }

  /**
   * 记一笔硬币，返回**真实到账**的数额（农场会按上限截断，所以未必等于 `qty`）；
   * 农场没有口子或记不上时返回 `null`，调用方据此决定不推进这一拍。
   */
  async #credit (qty) {
    if (this.#farm === null || typeof this.#farm.addCoins !== 'function') return null
    const result = await this.#farm.addCoins(qty)
    if (result === null || typeof result !== 'object' || result.ok !== true) return null
    const landed = Number(result.qty)
    return Number.isFinite(landed) && landed > 0 ? Math.trunc(landed) : 0
  }

  /**
   * 把已经记进去的硬币收回来（落盘失败时的回滚）。农场只有 `spendCoins` 一个减法口子，
   * 钱刚记进去就在账上，正常必成功；真收不回来只能记日志——宁可多一次，也不能丢钱。
   */
  async #refund (qty) {
    if (this.#farm === null || typeof this.#farm.spendCoins !== 'function') return false
    try {
      const result = await this.#farm.spendCoins(qty)
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        this.#log?.('出远门结算回滚没能收回硬币，可能多记一次：' + qty)
        return false
      }
      return true
    } catch (error) {
      this.#log?.('出远门结算回滚退款失败：' + (error?.message ?? error))
      return false
    }
  }

  /** 串行化：start/step/back/tick 都可能 await 农场，不能让两个迁移交错。 */
  #serial (task) {
    const next = this.#queue.then(task, task)
    this.#queue = next.then(() => {}, () => {})
    return next
  }

  async #persist () {
    const file = join(this.#dir, EXPEDITION_FILE)
    const tmp = join(this.#dir, '.' + EXPEDITION_FILE + '.tmp-' + process.pid + '-' + tempCounter++)
    try {
      await writeFile(tmp, JSON.stringify(this.#state, null, 2) + '\n', 'utf8')
      await rename(tmp, file)
      return true
    } catch (error) {
      this.#log?.('出远门存档写入失败：' + (error?.message ?? error))
      return false
    }
  }
}

export async function createExpeditionStore (dir, options = {}) {
  return new ExpeditionStore(dir, options).init()
}
