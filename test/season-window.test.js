/**
 * 票 72：季节窗口/状态出口与静态 UI 契约。
 *
 * 这里只走 `/dsh-zoo/state`（本地主人视角）和源码静态断言；真正开窗的 Electron
 * 冒烟在 `scripts/desktop-smoke.mjs`，不在单测里起窗口。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createService } from '../src/service.js'
import { seasonAt } from '../src/season-rules.js'

const AUTUMN = new Date(2026, 10, 17, 12, 0, 0).getTime()
const WINTER = new Date(2026, 10, 18, 12, 0, 0).getTime()

function fakeCtx () {
  const routes = []
  return {
    ctx: {
      webServer: {
        register (options) {
          routes.push(options)
          return () => {}
        }
      },
      logger: { info () {}, warn () {} }
    },
    routes
  }
}

async function makeService (t, now) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-season-window-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktop: false,
    petBridge: false,
    farmNow: () => now
  })
  service.routes = routes
  t.after(() => service.dispose())
  await service.ready
  return service
}

async function getState (service) {
  const route = service.routes.find((candidate) => candidate.path === '/dsh-zoo/state')
  assert.ok(route, '应该注册 /dsh-zoo/state')
  const res = {
    statusCode: 0,
    headers: {},
    setHeader (key, value) { this.headers[key] = value },
    end (payload) { this.payload = payload }
  }
  const req = {
    method: 'GET',
    _listeners: {},
    on (event, fn) {
      this._listeners[event] = fn
      return this
    },
    destroy () {}
  }
  await route.handler(req, res)
  return JSON.parse(res.payload)
}

test('state.farm.season：秋天有日历、节日和熊獾，形状与 SPEC v8 一致', async (t) => {
  const service = await makeService(t, AUTUMN)
  const state = await getState(service)
  const season = state.farm.season
  assert.ok(season, 'state.farm 应该带 season')
  assert.equal(season.id, 'autumn')
  assert.equal(season.name, '秋')
  assert.equal(season.start, seasonAt(AUTUMN).start)
  assert.equal(season.end, seasonAt(AUTUMN).end)
  assert.ok(season.remainingMs > 0 && season.remainingMs <= 24 * 60 * 60 * 1000)
  assert.equal(season.calendar.length, 4)
  assert.equal(season.calendar.find((cell) => cell.today).id, 'autumn')
  assert.equal(season.event.id, 'autumn-harvest')
  assert.deepEqual(season.event.reward, { coins: 50, dew: 4 })
  assert.equal(season.omen.id, 'autumn-bearger')
  assert.equal(season.omen.resolved, false)
  assert.equal(season.omen.stakes.failLoss, 3)
  assert.equal(season.omen.canFeed, false)
})

test('state.farm.season：冬天没有熊獾，节日换成围炉节', async (t) => {
  const service = await makeService(t, WINTER)
  const state = await getState(service)
  const season = state.farm.season
  assert.equal(season.id, 'winter')
  assert.equal(season.omen, null)
  assert.equal(season.event.id, 'winter-hearth')
  assert.equal(season.calendar.find((cell) => cell.today).id, 'winter')
})

test('窗口骨架：季节条、日历、节日卡、来客卡、枯萎卡都在', async () => {
  const html = await readFile(new URL('../desktop/farm.html', import.meta.url), 'utf8')
  for (const id of ['season-bar', 'season-calendar', 'season-cards', 'event-card', 'omen-card']) {
    assert.match(html, new RegExp(`id="${id}"`), `farm.html 应该有 #${id}`)
  }
  assert.match(html, /data-stage='withered'/, 'farm.html 应该有枯萎卡样式')
  assert.match(html, /body\[data-season=/, 'farm.html 应该有季节主题选择器')
  for (const season of ['spring', 'summer', 'autumn', 'winter']) {
    assert.match(html, new RegExp(`body\\[data-season='${season}'\\] \\.season-bar`), `缺少 ${season} 季节主题`)
  }
})

test('窗口渲染：季节/来客只在主人模式画，动作窄口只发两个新 action', async () => {
  const js = await readFile(new URL('../desktop/farm.js', import.meta.url), 'utf8')
  assert.match(js, /function currentSeason \(\)/)
  assert.match(js, /mode === 'owner'/)
  assert.match(js, /seasonBarEl\.hidden = false/)
  assert.match(js, /farm-event-claim/)
  assert.match(js, /farm-omen-resolve/)
  assert.match(js, /choice: action === 'omen-guard' \? 'guard' : 'feed'/)
  assert.match(js, /expectedStart: season\.start/)
})

test('窗口桥：节日/来客的乐观锁和二选一必须过 preload', async () => {
  const preload = await readFile(new URL('../desktop/farm-preload.js', import.meta.url), 'utf8')
  assert.match(preload, /expectedStart: action\.expectedStart/, 'preload 必须把节日/来客的 expectedStart 带下去')
  assert.match(preload, /choice: action\.choice/, 'preload 必须把来客的 guard/feed 带下去')
  const service = await readFile(new URL('../src/service.js', import.meta.url), 'utf8')
  assert.match(service, /expectedStart: event\.expectedStart/, '桌面动作入口必须把 expectedStart 交给宿主')
  assert.match(service, /choice: event\.choice/, '桌面动作入口必须把 guard/feed 交给宿主')
})

test('共享白名单：event/omen 动作在 FARM_ACTIONS 里，且只接受窄参数', async () => {
  const shared = (await import('../desktop/shared.js')).default
  assert.ok(shared.FARM_EVENT_ACTIONS.includes('farm-event-claim'))
  assert.ok(shared.FARM_OMEN_ACTIONS.includes('farm-omen-resolve'))
  assert.ok(shared.FARM_ACTIONS.includes('farm-event-claim'))
  assert.ok(shared.FARM_ACTIONS.includes('farm-omen-resolve'))
  assert.deepEqual(
    shared.normalizeFarmAction({ action: 'farm-event-claim', expectedStart: 123 }),
    { action: 'farm-event-claim', expectedStart: 123 }
  )
  assert.deepEqual(
    shared.normalizeFarmAction({ action: 'farm-omen-resolve', choice: 'feed', expectedStart: 123 }),
    { action: 'farm-omen-resolve', choice: 'feed', expectedStart: 123 }
  )
})
