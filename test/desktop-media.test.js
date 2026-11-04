import assert from 'node:assert/strict'
import test from 'node:test'

import shared from '../desktop/shared.js'

/**
 * 渲染端每次换素材都会把当前状态报给主进程，主进程原样塞进 `/local-pet/desktop` 的
 * `helperStatus.media`。这个字段是现场判断「宠物到底有没有画出来」的唯一探针，
 * 所以它必须跟着真实状态走（ticket 28），而且渲染端是不可信输入（ticket 07 的同一条规矩）。
 */

test('media 上报：认得的字段照收，用来诊断「为什么没画出来」', () => {
  const entry = shared.normalizeMediaReport({
    clip: '螃蟹走路',
    source: 'video',
    readyState: 4,
    visibility: 'visible',
    failed: ['东张西望']
  }, 1234)

  assert.deepEqual(entry, {
    clip: '螃蟹走路',
    source: 'video',
    readyState: 4,
    visibility: 'visible',
    failed: ['东张西望'],
    at: 1234
  })
})

test('media 上报：空串、超长、坏类型都判无效，不把脏数据洗成看起来合法的名字', () => {
  const entry = shared.normalizeMediaReport({
    clip: 'x'.repeat(200),
    source: '   ',
    readyState: 9,
    visibility: 'minimized',
    failed: [1, 'ok', null, 'z'.repeat(200), '']
  }, 1)

  assert.equal(entry.clip, null, '超长片段名整条判无效（不截断）')
  assert.equal(entry.source, null, '空白 source 不是合法值')
  assert.equal(entry.readyState, null, 'readyState 只认 0–4')
  assert.equal(entry.visibility, null, 'visibility 只认文档真会报的那几个值')
  assert.deepEqual(entry.failed, ['ok'])
})

test('media 上报：at 用调用方给的时刻；宿主侧缺了就留 null，不当成「现在」', () => {
  assert.equal(shared.normalizeMediaReport({ clip: 'a' }, 99).at, 99, '主进程收到 ipc 的时刻')
  assert.equal(shared.normalizeMediaReport({ clip: 'a', at: 42 }).at, 42, '宿主读 helper 上报里带的')
  assert.equal(shared.normalizeMediaReport({ clip: 'a' }).at, null)
})

test('media 上报：failed 只留最近 16 条', () => {
  const failed = Array.from({ length: 30 }, (_, index) => 'clip-' + index)
  const entry = shared.normalizeMediaReport({ clip: 'a', source: 'loading', failed }, 1)

  assert.equal(entry.failed.length, 16)
  assert.equal(entry.failed[0], 'clip-14')
  assert.equal(entry.failed[15], 'clip-29')
})

test('media 上报：不是对象就当没报（null），别在状态里塞一条空记录', () => {
  assert.equal(shared.normalizeMediaReport(null), null)
  assert.equal(shared.normalizeMediaReport('loading'), null)
  assert.equal(shared.normalizeMediaReport([]), null)
})

test('status 事件：诊断字段穿过宿主的事件白名单，不会被削成三件套', () => {
  const parsed = shared.normalizeHelperEvent({
    type: 'status',
    id: 7,
    ignoring: true,
    media: {
      clip: '螃蟹走路',
      source: 'video',
      readyState: 4,
      visibility: 'visible',
      failed: [],
      at: 1793764498237
    }
  })

  assert.equal(parsed.ok, true)
  assert.equal(parsed.event.status.media.source, 'video')
  assert.equal(parsed.event.status.media.readyState, 4)
  assert.equal(parsed.event.status.media.visibility, 'visible')
})
