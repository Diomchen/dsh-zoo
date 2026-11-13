/**
 * 票 72：季节窗口的纯模型（desktop/farm-view.js）。
 *
 * 只测窗口自己算的展示/可用性，不碰宿主：四季作物在缺季节时绝不能默认能种，
 * 枯萎地能重种、不能收，换季日历/节日/来客卡把宿主给的值拼成人话。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const view = require('../desktop/farm-view.js')

const HOUR = 60 * 60 * 1000

test('seedAvailability：当季四季作物可种可买，错季只能等，缺季节也不放行', () => {
  assert.deepEqual(view.seedAvailability('pea', 'spring'), {
    season: 'spring', plantable: true, buyable: true, reason: ''
  })
  assert.deepEqual(view.seedAvailability('pea', 'summer'), {
    season: 'spring', plantable: false, buyable: false, reason: '下季才有'
  })
  for (const seasonId of [null, undefined, '']) {
    const missing = view.seedAvailability('watermelon', seasonId)
    assert.equal(missing.plantable, false, 'season=' + String(seasonId))
    assert.equal(missing.buyable, false)
    assert.equal(missing.reason, '季节未知')
  }
  assert.equal(view.seedAvailability('tomato', null).plantable, true, '旧六种没有季节限制')
  assert.equal(view.seedAvailability('alien', 'spring').plantable, false)
})

test('seasonCalendar：四格、今天高亮、最后 4 小时提醒、下一季是第一个未来格', () => {
  const calendar = view.seasonCalendar({
    id: 'autumn',
    name: '秋',
    emoji: '🍂',
    remainingMs: 3 * HOUR,
    calendar: [
      { id: 'summer', name: '夏', emoji: '☀️', today: false, past: true, festival: '夜市' },
      { id: 'autumn', name: '秋', emoji: '🍂', today: true, past: false, festival: '丰收祭' },
      { id: 'winter', name: '冬', emoji: '❄️', today: false, past: false, festival: '围炉节' },
      { id: 'spring', name: '春', emoji: '🌱', today: false, past: false, festival: '播种节' }
    ]
  })
  assert.equal(calendar.cells.length, 4)
  assert.equal(calendar.remainingText, '3 小时')
  assert.equal(calendar.almost, true)
  assert.equal(calendar.next.id, 'winter')
  assert.equal(view.seasonCalendar(null).cells.length, 0)
})

test('eventCard：进度/奖励/能否领奖都拼成一句人话', () => {
  const ready = view.eventCard({
    id: 'autumn-harvest',
    name: '丰收祭',
    requirement: { kind: 'harvest', qty: 15 },
    progress: 15,
    claimed: false,
    reward: { coins: 50, dew: 4 }
  })
  assert.equal(ready.ready, true)
  assert.equal(ready.canClaim, true)
  assert.equal(ready.progressText, '收获 15/15')
  assert.equal(ready.rewardText, '+50 硬币 +4 露水')
  assert.equal(ready.statusText, '完成了，可以领奖')

  const claimed = view.eventCard({
    id: 'autumn-harvest', name: '丰收祭', requirement: { kind: 'harvest', qty: 15 },
    progress: 15, claimed: true, reward: { coins: 50, dew: 4 }
  })
  assert.equal(claimed.canClaim, false)
  assert.equal(claimed.statusText, '今天已经领过了')
  assert.equal(view.eventCard(null), null)
})

test('omenCard：仓库不够时投喂不可点，已结算时两个选择都不可点', () => {
  const card = view.omenCard({
    id: 'autumn-bearger',
    name: '熊獾',
    emoji: '🐻',
    resolved: false,
    canFeed: false,
    stakes: {
      guardReward: { coins: 40, dew: 3 },
      failLoss: 3,
      feedCost: 3,
      feedReward: { coins: 0, dew: 2, seeds: { rice: 1 } },
      ignoreLoss: 1
    }
  })
  assert.equal(card.actions[0].disabled, false)
  assert.equal(card.actions[1].disabled, true)
  assert.equal(card.actions[1].reason, '仓库作物不够 3 个')
  assert.match(card.guardText, /40 硬币/)
  assert.match(card.feedText, /1 颗稻种/)

  const done = view.omenCard({
    id: 'autumn-bearger', name: '熊獾', resolved: true, choice: 'guard', canFeed: true, stakes: {}
  })
  assert.equal(done.actions.every((entry) => entry.disabled), true)
})

test('plotCards：枯萎地显示枯萎、可点重种，没有收获/浇水按钮', () => {
  const [card] = view.plotCards({
    dew: 10,
    plots: [{ id: 'p1', crop: 'pea', stage: 'withered', mature: false, remainingMs: 0, withered: true }]
  }, {})
  assert.equal(card.stage, 'withered')
  assert.equal(card.badge, '枯萎了')
  assert.equal(card.cropName, '豌豆（枯萎）')
  assert.equal(card.openPlant, true)
  assert.equal(card.detailText, '换季枯了，点一下重种')
  assert.deepEqual(card.actions, [])
})

test('batchPlantTargets：枯萎地和空地都能补种，但错季四季种子不排进队列', () => {
  const spring = view.batchPlantTargets({
    season: { id: 'spring' },
    seeds: { pea: 2 },
    plots: [
      { id: 'p1', stage: 'withered', crop: 'rice' },
      { id: 'p2', stage: 'empty', crop: null }
    ]
  })
  assert.deepEqual(spring, [
    { plotId: 'p1', cropId: 'pea' },
    { plotId: 'p2', cropId: 'pea' }
  ])

  const summer = view.batchPlantTargets({
    season: { id: 'summer' },
    seeds: { pea: 1, tomato: 1 },
    plots: [{ id: 'p1', stage: 'empty', crop: null }]
  })
  assert.deepEqual(summer, [{ plotId: 'p1', cropId: 'tomato' }], '春天种子不能在夏天一键种')
})

test('tradeView：四季种子按 season 门控买，卖旧季收成不受限', () => {
  const summerFarm = { coins: 100, seeds: {}, crops: {}, season: { id: 'summer' } }
  const summer = view.tradeView(summerFarm, null, 'watermelon', 1)
  assert.equal(summer.buyable, true)
  assert.equal(summer.canBuy, true)
  assert.equal(summer.buyHint, '')

  const winter = view.tradeView({ coins: 100, seeds: {}, crops: {}, season: { id: 'winter' } }, null, 'watermelon', 1)
  assert.equal(winter.buyable, false)
  assert.equal(winter.canBuy, false)
  assert.equal(winter.buyHint, '下季才有')
  assert.equal(winter.canSell, false)

  const stocked = view.tradeView({ coins: 0, seeds: {}, crops: { watermelon: 2 }, season: { id: 'winter' } }, null, 'watermelon', 1)
  assert.equal(stocked.canSell, true, '仓库里的旧季西瓜仍然能卖')
  assert.equal(stocked.canBuy, false)

  const unknown = view.tradeView({ coins: 100, seeds: {}, crops: {} }, null, 'watermelon', 1)
  assert.equal(unknown.buyable, false)
  assert.equal(unknown.buyHint, '季节未知')
})
