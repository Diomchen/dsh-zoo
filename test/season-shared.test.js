/**
 * 票 72：桌面窄口（desktop/shared.js）的季节归一化。
 *
 * 窗口只认宿主发来的窄形状：坏季节块整块丢掉，枯萎地块只保留布尔，
 * 节日/来客动作必须带 `expectedStart`，来客还必须有二选一。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import shared from '../desktop/shared.js'

const validSeason = () => ({
  id: 'autumn',
  name: '秋',
  emoji: '🍂',
  start: 1000,
  end: 2000,
  remainingMs: 500,
  calendar: [
    { id: 'summer', name: '夏', emoji: '☀️', today: false, past: true, festival: '夜市' },
    { id: 'autumn', name: '秋', emoji: '🍂', today: true, past: false, festival: '丰收祭' },
    { id: 'winter', name: '冬', emoji: '❄️', today: false, past: false, festival: '围炉节' },
    { id: 'spring', name: '春', emoji: '🌱', today: false, past: false, festival: '播种节' }
  ],
  event: {
    id: 'autumn-harvest',
    name: '丰收祭',
    requirement: { kind: 'harvest', qty: 15 },
    progress: 15,
    claimed: false,
    reward: { coins: 50, dew: 4 }
  },
  omen: {
    id: 'autumn-bearger',
    name: '熊獾',
    emoji: '🐻',
    resolved: false,
    choice: null,
    canFeed: true,
    stakes: {
      guardReward: { coins: 40, dew: 3 },
      failLoss: 3,
      feedCost: 3,
      feedReward: { coins: 0, dew: 2, seeds: { rice: 1 } },
      ignoreLoss: 1
    }
  }
})

test('normalizeSeason：季节、四格日历、节日与来客的窄形状', () => {
  const season = shared.normalizeSeason(validSeason())
  assert.equal(season.id, 'autumn')
  assert.equal(season.calendar.length, 4)
  assert.equal(season.calendar[1].today, true)
  assert.equal(season.calendar[1].festival, '丰收祭')
  assert.equal(season.event.ready, true)
  assert.deepEqual(season.event.reward, { coins: 50, dew: 4 })
  assert.equal(season.omen.canFeed, true)
  assert.deepEqual(season.omen.stakes.feedReward, { coins: 0, dew: 2, seeds: { rice: 1 } })
})

test('normalizeSeason：坏 id / 坏时间整块丢掉；日历最多四格；坏节日丢掉', () => {
  assert.equal(shared.normalizeSeason({ ...validSeason(), id: 'monsoon' }), null)
  assert.equal(shared.normalizeSeason({ ...validSeason(), start: 2000 }), null)
  assert.equal(shared.normalizeSeason(null), null)

  const long = validSeason()
  long.calendar = [...long.calendar, { id: 'spring', name: '春', emoji: '🌱', today: false }]
  assert.equal(shared.normalizeSeason(long).calendar.length, 4)

  const badEvent = validSeason()
  badEvent.event.requirement.kind = 'dance'
  assert.equal(shared.normalizeSeason(badEvent).event, null)
})

test('normalizeFarmPlot：枯萎只认布尔或 stage，并且不再有成熟/倒计时', () => {
  const byStage = shared.normalizeFarmPlot({ id: 'p1', crop: 'pea', stage: 'withered' })
  assert.equal(byStage.stage, 'withered')
  assert.equal(byStage.withered, true)
  assert.equal(byStage.mature, false)
  assert.equal(byStage.remainingMs, 0)

  const byFlag = shared.normalizeFarmPlot({ id: 'p2', crop: 'rice', stage: 'growing', withered: true, remainingMs: 5000 })
  assert.equal(byFlag.stage, 'withered')
  assert.equal(byFlag.withered, true)

  const normal = shared.normalizeFarmPlot({ id: 'p3', crop: 'tomato', stage: 'growing', grownMs: 0, growMs: 1000, remainingMs: 1000 })
  assert.equal(normal.stage, 'growing')
  assert.equal(normal.withered, undefined)
})

test('normalizeFarm 带上 season，且日志里的 omen 字段不被削掉', () => {
  const farm = shared.normalizeFarm({
    plots: [{ id: 'p1', crop: null, stage: 'empty' }],
    coins: 30,
    seeds: {},
    crops: {},
    log: [{ at: 1000, kind: 'omen', choice: 'guard', success: false, qty: 3 }],
    season: validSeason()
  })
  assert.equal(farm.season.id, 'autumn')
  assert.equal(farm.season.omen.id, 'autumn-bearger')
  assert.equal(farm.log[0].kind, 'omen')
  assert.equal(farm.log[0].choice, 'guard')
  assert.equal(farm.log[0].success, false)
})

test('normalizeFarmAction：节日/来客必须带 expectedStart，来客还必须有 guard/feed', () => {
  assert.deepEqual(shared.normalizeFarmAction({ action: 'farm-event-claim', expectedStart: 1000 }), {
    action: 'farm-event-claim', expectedStart: 1000
  })
  assert.deepEqual(shared.normalizeFarmAction({ action: 'farm-omen-resolve', choice: 'feed', expectedStart: 1000 }), {
    action: 'farm-omen-resolve', choice: 'feed', expectedStart: 1000
  })
  assert.equal(shared.normalizeFarmAction({ action: 'farm-event-claim' }), null)
  assert.equal(shared.normalizeFarmAction({ action: 'farm-event-claim', expectedStart: 0 }), null)
  assert.equal(shared.normalizeFarmAction({ action: 'farm-omen-resolve', expectedStart: 1000 }), null)
  assert.equal(shared.normalizeFarmAction({ action: 'farm-omen-resolve', choice: 'run', expectedStart: 1000 }), null)
})

test('normalizeHelperEvent：helper 回宿主的 action 不能把 choice/expectedStart 削掉', () => {
  const claim = shared.normalizeHelperEvent({
    type: 'action', id: 'farm-1-1', action: 'farm-event-claim', expectedStart: 1000
  })
  assert.equal(claim.ok, true)
  assert.equal(claim.event.expectedStart, 1000)
  assert.equal(claim.event.choice, undefined)

  const omen = shared.normalizeHelperEvent({
    type: 'action', id: 'farm-2-2', action: 'farm-omen-resolve', choice: 'guard', expectedStart: 1000
  })
  assert.equal(omen.ok, true)
  assert.equal(omen.event.choice, 'guard')
  assert.equal(omen.event.expectedStart, 1000)
})

test('白名单/阶段/日志种类把季节新增项都收进来', () => {
  for (const action of ['farm-event-claim', 'farm-omen-resolve']) {
    assert.equal(shared.FARM_ACTIONS.includes(action), true, action)
    assert.equal(shared.DESKTOP_ACTIONS.includes(action), true, action)
  }
  assert.equal(shared.FARM_STAGES.includes('withered'), true)
  for (const kind of ['season', 'event', 'wither', 'omen']) {
    assert.equal(shared.FARM_LOG_KINDS.includes(kind), true, kind)
  }
})
