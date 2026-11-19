/**
 * 「出远门」的存档（票 112）：`<dataDir>/expedition.json`。
 *
 * 只做三件事：把规则层的纯迁移落到内存、把硬币变动交给农场、把结果原子地写回磁盘。
 * 文件里有 run / shelf / codex / upgrades 四块。114 起每到一段同时记一笔图鉴（首次获得时间），
 * 图鉴与陈列架共用这份 codex，不需要再迁一次格式。
 *
 * 钱与状态顺序：
 *   出发：先扣盘缠再写 run（写失败退款并回滚）；
 *   到点：先记回币再写 run（记不上就下一拍重试，不会重复掉币）；
 *   折返/走满：钱在到点时就已进农场，这里只落 run 的结束标记。
 * 这样任何一步失败都不会出现「硬币已回、run 还在外面」的重复结算。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  LANTERN_PRICE,
  advanceRun,
  backRun,
  codexView,
  expireRun,
  isActiveRun,
  normalizeRun,
  recordSouvenir,
  resumeRun,
  routeOf,
  settledOf,
  startRun,
  stepRun
} from './expedition.js'

export const EXPEDITION_FILE = 'expedition.json'
const VERSION = 1

function initialShelf () {
  return { slots: 8, items: [] }
}

function normalizeShelf (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return initialShelf()
  const slots = Number.isInteger(raw.slots) && raw.slots > 0 && raw.slots <= 64 ? raw.slots : 8
  const items = Array.isArray(raw.items) ? JSON.parse(JSON.stringify(raw.items.slice(0, slots))) : []
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

/** 空文件/坏文件/旧字段都收敛到这一份完整形状。 */
function normalizeState (raw) {
  return {
    version: VERSION,
    run: normalizeRun(raw?.run),
    shelf: normalizeShelf(raw?.shelf),
    codex: normalizeCodex(raw?.codex),
    upgrades: { lantern: raw?.upgrades?.lantern === true }
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
    const resumed = await this.#resume(this.#now())
    // 坏文件/缺文件/旧形状都在启动时修一次，别等下一拍才写。
    if (missing || raw === null || resumed || JSON.stringify(state) !== JSON.stringify(raw)) {
      await this.#persist()
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
      upgrades: { ...this.#state.upgrades }
    }
  }

  /** 这一趟是不是还在外面（决定 away 门控与窗口的「继续」）。 */
  active () {
    return isActiveRun(this.#state.run)
  }

  /**
   * 出发：`expedition-start` 的唯一落点。
   * 拒绝顺序是「已经在外面 → 没有这条路线 → 还没准备好 → 钱不够」，先在内存里判完再动钱。
   */
  start ({ routeId } = {}) {
    return this.#serial(async () => {
      if (this.#disposed) return { ok: false, error: 'starting' }
      if (isActiveRun(this.#state.run)) return { ok: false, error: 'already-away' }
      const route = routeOf(routeId)
      if (route === null) return { ok: false, error: 'no-route' }
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
      this.#state.run = next
      if (await this.#persist()) {
        return settled === null ? { ok: true, run: copyRun(next) } : { ok: true, run: copyRun(next), settled }
      }
      this.#state.run = previous
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
      this.#state.run = next
      if (await this.#persist()) return { ok: true, run: copyRun(next), settled }
      // 写不进去就留在决策窗，让玩家能再点一次，而不是内存说回家了、重启又在外头。
      this.#state.run = previous
      return { ok: false, error: 'save-failed' }
    })
  }

  /**
   * 秒级 tick：先看决策窗有没有超时（超时即自动折返），再推走路。
   * 到点走完一段，回币进农场、特产记进图鉴；走满最后一段直接 complete。
   *
   * 返回是否真的推进了（服务层据此决定要不要重推窗口）。
   */
  tick (now = this.#now()) {
    return this.#serial(async () => {
      if (this.#disposed) return false
      const expired = expireRun(this.#state.run, now)
      if (expired !== null) {
        this.#state.run = expired
        await this.#persist()
        return true
      }
      const event = advanceRun(this.#state.run, now)
      if (event === null) return false
      if (event.coins > 0) {
        const credited = await this.#credit(event.coins)
        if (!credited) return false
      }
      this.#state.run = event.run
      if (event.souvenir !== null && event.souvenir !== undefined) {
        // 只记第一次见到的时刻；重复获得时 recordSouvenir 原样返回。
        this.#state.codex = recordSouvenir(this.#state.codex, event.souvenir, now)
      }
      await this.#persist()
      return true
    })
  }

  dispose () {
    this.#disposed = true
  }

  /**
   * 读档续走：最多推进一个节点，不补算离线期间错过的段数、不补掷。
   * 钱先记、记不上就原样留着（下一拍 tick 再补），避免「硬币没到账、run 却往前走了」。
   */
  async #resume (now) {
    const event = resumeRun(this.#state.run, now)
    if (event === null) return false
    if (event.coins > 0) {
      const credited = await this.#credit(event.coins)
      if (!credited) return false
    }
    this.#state.run = event.run
    if (event.souvenir !== null && event.souvenir !== undefined) {
      this.#state.codex = recordSouvenir(this.#state.codex, event.souvenir, now)
    }
    return true
  }

  async #credit (qty) {
    if (this.#farm === null || typeof this.#farm.addCoins !== 'function') return false
    const result = await this.#farm.addCoins(qty)
    return result !== null && typeof result === 'object' && result.ok === true
  }

  /** 串行化：start/step/back/tick 都可能 await 农场，不能让两个迁移交错。 */
  #serial (task) {
    const next = this.#queue.then(task, task)
    this.#queue = next.then(() => {}, () => {})
    return next
  }

  async #persist () {
    const file = join(this.#dir, EXPEDITION_FILE)
    const tmp = file + '.tmp'
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
