/**
 * 票 104：盘口消息面（`src/board-news.js`）的确定性、密度、文案与数值接口。
 *
 * 这一层是纯函数：同一 `(salt, crop, marketDay)` 在任何机器上必须是同一张表；
 * `newsStepAt()` 必须等于该分钟所有事件 `jump` 之和；`newsVolMultAt()` 只在风暴窗口 >1。
 * 不碰磁盘/网络，也不依赖本机时区（市场日固定 UTC+8）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NEWS_SALT,
  NEWS_SCHEDULE_MINUTES,
  calendarForDay,
  marketDayIndexOfAt,
  marketDayStartOf,
  newsForBar,
  newsForRange,
  newsForWindow,
  newsStepAt,
  newsVolMultAt,
  compactNewsEvent,
  newsTemplateSnapshot,
  resetNewsCache
} from '../src/board-news.js'
import { CROP_IDS, applyCropCatalog, resetCropCatalog } from '../src/farm-rules.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const NOW = Date.UTC(2026, 10, 18, 5, 37, 25)
const DAY = marketDayIndexOfAt(NOW)
const DAY_START = marketDayStartOf(DAY)

function eventsOfDay (crop, day = DAY) {
  const start = marketDayStartOf(day)
  return newsForRange({ crop, from: start, to: start + DAY_MS })
}

function chars (text) {
  return Array.from(text).length
}

test('票 104：同一作物同一市场日的事件表确定；换作物/换日就换表', () => {
  resetNewsCache()
  const first = eventsOfDay('tomato')
  const second = eventsOfDay('tomato')
  assert.deepEqual(first, second)
  assert.ok(first.length >= 3, '一天至少有几条消息')
  assert.ok(first.some((event) => event.scope !== 'all'), '有作物自己的消息')

  const carrot = eventsOfDay('carrot')
  const tomatoIds = new Set(first.map((event) => event.id))
  assert.ok(carrot.some((event) => !tomatoIds.has(event.id)), '不同作物不是同一张表')

  const tomorrow = eventsOfDay('tomato', DAY + 1)
  assert.notDeepEqual(tomorrow.map((event) => event.id), first.map((event) => event.id))
})

test('票 104：密度、文案长度与数值范围', () => {
  resetNewsCache()
  const templates = newsTemplateSnapshot()
  assert.ok(templates.length >= 30, '内容库至少 30 条模板')
  for (const template of templates) {
    assert.ok(typeof template.title === 'string' && template.title !== '')
    assert.ok(typeof template.body === 'string' && template.body !== '')
    assert.ok(typeof template.source === 'string' && template.source !== '')
  }

  const counts = []
  for (let day = DAY; day < DAY + 14; day += 1) {
    for (const crop of ['tomato', 'carrot', 'pumpkin']) {
      const events = eventsOfDay(crop, day)
      counts.push(events.length)
      for (const event of events) {
        assert.ok(chars(event.title) <= 28, '标题超长：' + event.title + ' (' + chars(event.title) + ')')
        assert.ok(chars(event.body) <= 90, '正文超长：' + event.body)
        assert.doesNotMatch(event.title, /\{\w+\}/, '标题还有未替换占位符：' + event.title)
        assert.doesNotMatch(event.body, /\{\w+\}/, '正文还有未替换占位符：' + event.body)
        assert.ok(['up', 'down', 'vol'].includes(event.tone), 'bad tone ' + event.tone)
        assert.ok(['micro', 'flash', 'headline', 'blackswan', 'storm', 'calendar', 'followup'].includes(event.kind))
        assert.ok(Number.isFinite(event.jump) && Math.abs(event.jump) <= 0.06, 'jump 越界：' + event.jump)
        assert.ok(Number.isFinite(event.storm) && event.storm >= 1 && event.storm <= 2.2)
        assert.ok(event.at >= marketDayStartOf(day) && event.at < marketDayStartOf(day) + DAY_MS)
        assert.ok(typeof event.id === 'string' && event.id !== '')
      }
    }
  }
  const average = counts.reduce((sum, value) => sum + value, 0) / counts.length
  assert.ok(average >= 3 && average <= 12, '每作物每天事件密度异常：' + average.toFixed(2))
  assert.ok(counts.every((value) => value >= 3), '有作物一天没有任何消息')
})

test('票 104：newsStepAt 等于该分钟所有事件 jump 之和；风暴只放大波动', () => {
  resetNewsCache()
  const crop = 'tomato'
  const events = eventsOfDay(crop)
  const byMinute = new Map()
  for (const event of events) {
    const minute = Math.floor(event.at / MINUTE_MS)
    byMinute.set(minute, (byMinute.get(minute) ?? 0) + event.jump)
  }
  for (const [minute, expected] of byMinute) {
    assert.ok(Math.abs(newsStepAt({ crop, minute }) - expected) < 1e-12, '第 ' + minute + ' 分钟的阶跃对不上')
  }

  const storms = events.filter((event) => event.storm > 1)
  for (const storm of storms) {
    const minute = Math.floor(storm.at / MINUTE_MS)
    assert.ok(newsVolMultAt({ crop, minute }) > 1, '风暴事件期间波动乘子应 >1')
  }
  // 找一个所有风暴窗口都没覆盖的分钟：乘子必须是 1。
  const quiet = []
  for (let minute = 0; minute < 1440; minute += 1) {
    const absolute = Math.floor(DAY_START / MINUTE_MS) + minute
    if (events.some((event) => event.storm > 1 &&
      absolute >= Math.floor(event.at / MINUTE_MS) &&
      absolute < Math.floor(event.at / MINUTE_MS) + event.duration)) continue
    quiet.push(absolute)
    if (quiet.length >= 5) break
  }
  for (const minute of quiet) assert.equal(newsVolMultAt({ crop, minute }), 1)
})

test('票 104：全市场事件按主作物 1.0、其他作物 0.5 传导', () => {
  resetNewsCache()
  const tomato = eventsOfDay('tomato')
  const global = tomato.find((event) => event.scope === 'all' && event.jump !== 0)
  assert.ok(global, '样本日应有一条全市场跳价事件')
  const otherCrop = CROP_IDS.find((crop) => crop !== global.primaryCrop && crop !== 'tomato') ?? 'carrot'
  const primary = eventsOfDay(global.primaryCrop).find((event) => event.id === global.id)
  const other = eventsOfDay(otherCrop).find((event) => event.id === global.id)
  assert.ok(primary && other, '同一全市场事件应出现在主作物和其他作物上')
  assert.equal(other.jump, primary.jump / 2, '非主作物按 0.5 传导')
})

test('票 104：日历每天 5 条，预告在公布前 10 分钟，公布时跳价', () => {
  resetNewsCache()
  const rows = calendarForDay({ now: NOW })
  assert.equal(rows.length, 5)
  assert.deepEqual(rows.map((row) => row.at), rows.map((row) => row.at).sort((a, b) => a - b))
  for (const row of rows) {
    const minute = Math.floor((row.at - DAY_START) / MINUTE_MS)
    assert.ok(NEWS_SCHEDULE_MINUTES.includes(minute), '日程时刻不在白名单：' + minute)
    assert.ok(chars(row.title) <= 28)
    assert.ok(row.cropName !== '')
  }
  const crop = rows[0].crop
  const events = eventsOfDay(crop)
  const result = events.find((event) => event.kind === 'calendar' && event.jump !== 0)
  assert.ok(result, '日程结果应有跳价')
  const teaser = events.find((event) => event.id === result.id + ':teaser')
  assert.ok(teaser, '日程应有预告')
  assert.equal(teaser.jump, 0)
  assert.equal(teaser.at, result.at - 10 * MINUTE_MS)
  assert.equal(teaser.kind, 'calendar')
})

test('票 104：传闻/证实是两次独立跳跃，方向大致 50/50', () => {
  resetNewsCache()
  let same = 0
  let opposite = 0
  for (let day = DAY; day < DAY + 120; day += 1) {
    const events = eventsOfDay('tomato', day)
    const byId = new Map(events.map((event) => [event.id, event]))
    for (const follow of events.filter((event) => event.kind === 'followup')) {
      const first = byId.get(follow.storyId)
      if (first === undefined) continue
      assert.ok(follow.at > first.at)
      assert.notEqual(follow.jump, 0)
      if (Math.sign(follow.jump) === Math.sign(first.jump)) same += 1
      else opposite += 1
    }
  }
  assert.ok(same + opposite > 10, '样本应有足够多的后续事件')
  const ratio = same / (same + opposite)
  assert.ok(ratio > 0.3 && ratio < 0.7, '证实/辟谣方向不该一边倒：' + ratio.toFixed(2))
})

test('票 104：bar/window 的裁剪与偏移；动态作物有通用文案', () => {
  resetNewsCache()
  const events = eventsOfDay('tomato')
  const event = events.find((entry) => entry.jump !== 0)
  const start = Math.floor(event.at / (15 * MINUTE_MS)) * 15 * MINUTE_MS
  const bar = newsForBar({ crop: 'tomato', start, end: start + 15 * MINUTE_MS, limit: 2 })
  assert.ok(bar.length >= 1 && bar.length <= 2)
  for (const entry of bar) {
    const lite = compactNewsEvent(entry, start)
    assert.ok(lite.off >= 0 && lite.off <= 14)
    assert.ok(chars(lite.title) <= 28)
  }
  const window = newsForWindow({ crop: 'tomato', now: NOW, limit: 5 })
  assert.ok(window.length <= 5)
  for (let index = 1; index < window.length; index += 1) {
    assert.ok(window[index - 1].at >= window[index].at, '窗口消息应按时间倒序')
  }

  applyCropCatalog([{ id: 'dragonfruit', name: '火龙果', growMs: 60 * MINUTE_MS, seedPrice: 20, yield: 3, base: 12 }])
  try {
    resetNewsCache()
    const exotic = eventsOfDay('dragonfruit')
    assert.ok(exotic.length >= 3, '新作物也应有消息')
    assert.ok(exotic.some((entry) => entry.title.includes('火龙果') || entry.title.includes('作物')),
      '新作物应有可读文案')
  } finally {
    resetCropCatalog()
    resetNewsCache()
  }
})

test('票 104：salt 与模板快照稳定（改题材才升 salt）', () => {
  assert.equal(NEWS_SALT, 'board-news-v1')
  const snapshot = newsTemplateSnapshot()
  assert.ok(snapshot.some((entry) => entry.id === 'headline-frost'))
  assert.ok(snapshot.some((entry) => entry.id === 'storm-maintenance'))
  assert.ok(snapshot.some((entry) => entry.id === 'calendar-high'))
})
