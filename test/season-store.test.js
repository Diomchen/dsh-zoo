/**
 * 票 65：`season.json` 的节日进度、领奖与跨日重置。
 *
 * 用真 tmpdir 和注入时钟；不 sleep，不碰 service/网络。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SEASON_FILE,
  SEASON_VERSION,
  createSeasonStore,
  normalizeSeasonFile
} from '../src/season-store.js'
import { seasonAt } from '../src/season-rules.js'

const AUTUMN_NOON = new Date(2026, 10, 13, 12, 0, 0).getTime()
const AUTUMN_END = new Date(2026, 10, 13, 23, 59, 0).getTime()
const WINTER_START = new Date(2026, 10, 14, 0, 0, 1).getTime()

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-season-store-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function clockAt (start) {
  let value = start
  return {
    now: () => value,
    set (next) { value = next },
    advance (ms) { value += ms }
  }
}

test('懒创建：没有 season.json 也能 view，第一次 init 就写盘', async (t) => {
  const dir = await tempDir(t)
  const store = await createSeasonStore(dir, { now: () => AUTUMN_NOON })
  const view = store.view()
  assert.equal(view.id, 'autumn')
  assert.equal(view.name, '秋')
  assert.equal(view.event.id, 'autumn-harvest')
  assert.equal(view.event.requirement.kind, 'harvest')
  assert.equal(view.event.requirement.qty, 15)
  assert.equal(view.event.progress, 0)
  assert.equal(view.event.ready, false)
  assert.equal(view.event.claimed, false)
  assert.deepEqual(view.event.reward, { coins: 50, dew: 4 })
  assert.equal(view.calendar.length, 4)
  assert.equal(view.calendar.find((cell) => cell.today).id, 'autumn')
  assert.equal(view.omen.id, 'autumn-bearger')
  assert.equal(view.omen.resolved, false)
  assert.equal(view.omen.choices.length, 2)

  const file = JSON.parse(await readFile(join(dir, SEASON_FILE), 'utf8'))
  assert.equal(file.version, SEASON_VERSION)
  assert.equal(file.event.id, 'autumn-harvest')
  assert.equal(file.event.start, view.start)
  assert.equal(file.omen.id, 'autumn-bearger')
})

test('进度：note 只累加对应 kind，到目标 ready；重复 note 不领奖', async (t) => {
  const dir = await tempDir(t)
  const store = await createSeasonStore(dir, { now: () => AUTUMN_NOON })

  await store.note('harvest', 3)
  await store.note('harvest', 3)
  await store.note('harvest', 3)
  let view = store.view()
  assert.equal(view.event.progress, 9)
  assert.equal(view.event.ready, false)

  await store.note('plant', 8) // 秋天节日只认 harvest，别的 kind 不计
  view = store.view()
  assert.equal(view.event.progress, 9)

  await store.note('harvest', 6)
  view = store.view()
  assert.equal(view.event.progress, 15)
  assert.equal(view.event.ready, true)
  assert.equal(view.event.claimed, false)

  const claimed = await store.claim()
  assert.equal(claimed.ok, true)
  assert.deepEqual(claimed.reward, { coins: 50, dew: 4 })
  assert.equal(claimed.event.claimed, true)
  assert.equal((await store.claim()).code, 'event-claimed')

  const file = JSON.parse(await readFile(join(dir, SEASON_FILE), 'utf8'))
  assert.equal(file.event.claimed, true)
})

test('未完成不能领；进度夹在 0..999', async (t) => {
  const dir = await tempDir(t)
  const store = await createSeasonStore(dir, { now: () => AUTUMN_NOON })
  assert.equal((await store.claim()).code, 'event-not-ready')

  await store.note('harvest', 5000)
  assert.equal(store.view().event.progress, 999)
  assert.equal(store.view().event.ready, true)
})

test('跨本地 00:00：换节日、进度归零、claimed 归 false，settle 报告 changed', async (t) => {
  const dir = await tempDir(t)
  const clock = clockAt(AUTUMN_NOON)
  const store = await createSeasonStore(dir, { now: clock.now })
  await store.note('harvest', 15)
  await store.claim()
  assert.equal(store.view().event.claimed, true)

  clock.set(WINTER_START)
  const settled = await store.settle()
  assert.equal(settled.changed, true)
  assert.equal(settled.eventReset, true)

  const view = store.view()
  assert.equal(view.id, 'winter')
  assert.equal(view.event.id, 'winter-hearth')
  assert.equal(view.event.requirement.kind, 'water')
  assert.equal(view.event.progress, 0)
  assert.equal(view.event.claimed, false)
  assert.equal(view.event.ready, false)

  // 旧节日的进度不会漏进新节日。
  await store.note('harvest', 15)
  assert.equal(store.view().event.progress, 0)
})

test('来客：秋天出现，只能结算一次；结算结果落盘', async (t) => {
  const dir = await tempDir(t)
  const store = await createSeasonStore(dir, { now: () => AUTUMN_NOON })
  assert.equal(store.view().omen.resolved, false)

  const resolved = await store.resolveOmen('feed', { random: () => 0 })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.outcome.success, true)
  assert.equal(store.view().omen.resolved, true)
  assert.equal(store.view().omen.choice, 'feed')
  assert.equal((await store.resolveOmen('guard')).code, 'omen-resolved')

  const file = JSON.parse(await readFile(join(dir, SEASON_FILE), 'utf8'))
  assert.equal(file.omen.resolved, true)
  assert.equal(file.omen.choice, 'feed')
})

test('来客：换季未处理时 settle 报告，并把卡片清掉', async (t) => {
  const dir = await tempDir(t)
  const clock = clockAt(AUTUMN_NOON)
  const store = await createSeasonStore(dir, { now: clock.now })
  assert.equal(store.view().omen.id, 'autumn-bearger')

  clock.set(WINTER_START)
  const settled = await store.settle()
  assert.equal(settled.unresolvedOmen.id, 'autumn-bearger')
  assert.equal(store.view().omen, null)
  assert.equal(store.snapshot().omen, null)
})

test('坏 JSON / 缺字段：丢弃重建，不影响目录里的其它文件', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, SEASON_FILE), '{not json', 'utf8')
  await writeFile(join(dir, 'farm.json'), '{"keep":true}', 'utf8')

  const store = await createSeasonStore(dir, { now: () => AUTUMN_NOON })
  assert.equal(store.view().event.id, 'autumn-harvest')
  assert.equal(store.view().event.progress, 0)

  const farm = await readFile(join(dir, 'farm.json'), 'utf8')
  assert.equal(farm, '{"keep":true}', 'season.json 损坏不碰 farm.json')
})

test('normalizeSeasonFile：错 start / 错 id / 坏 progress 整块重建', () => {
  const season = normalizeSeasonFile({ version: SEASON_VERSION, event: { start: 1, id: 'spring-sow', progress: { plant: 4 }, claimed: true }, omen: null }, AUTUMN_NOON)
  assert.equal(season.event.id, 'autumn-harvest')
  assert.equal(season.event.progress.harvest, 0)
  assert.equal(season.event.claimed, false)

  const start = seasonAt(AUTUMN_NOON).start
  const good = normalizeSeasonFile({
    version: SEASON_VERSION,
    event: { start, id: 'autumn-harvest', progress: { plant: 0, harvest: 7, sell: 0, water: 0 }, claimed: false },
    omen: null
  }, AUTUMN_NOON)
  assert.equal(good.event.progress.harvest, 7)
})
