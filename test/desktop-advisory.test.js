import assert from 'node:assert/strict'
import test from 'node:test'

import { dualLayerAdvisory } from '../src/desktop-advisory.js'

/**
 * dsh-pet 与 dsh-local-pet 同时画桌面宠物时，两个透明置顶层可能重叠：看到的是下面那只、
 * 拖到的是上面那只（ticket 31）。宿主已经知道 dsh-pet 可不可达，所以能给一条提示——
 * 但只在「确实两层都在画」时给，否则只是噪音。
 */

const up = { ok: true, reason: null }
const pet = { name: '鱼姐', anim: '东张西望' }

test('两层都在画 → 给提示', () => {
  const advisory = dualLayerAdvisory({ desktopRunning: true, bridge: up, pet })

  assert.equal(advisory.code, 'dual-desktop-layer')
  assert.match(advisory.note, /dsh-pet/)
  assert.match(advisory.note, /只留一个|关掉/)
})

test('本机桌面层没跑（web profile / 关了桌面）→ 不提示', () => {
  assert.equal(dualLayerAdvisory({ desktopRunning: false, bridge: up, pet }), null)
})

test('dsh-pet 不可达（没装 / 没响应）→ 不提示', () => {
  assert.equal(dualLayerAdvisory({ desktopRunning: true, bridge: { ok: false, reason: 'unreachable' }, pet }), null)
  assert.equal(dualLayerAdvisory({ desktopRunning: true, bridge: null, pet }), null)
})

test('dsh-pet 可达但还没有宠物 → 它什么都没画，不提示', () => {
  assert.equal(dualLayerAdvisory({ desktopRunning: true, bridge: up, pet: null }), null)
})

test('输入形状不对只当「没有」→ 不提示，不抛', () => {
  assert.equal(dualLayerAdvisory(), null)
  assert.equal(dualLayerAdvisory({ desktopRunning: true, bridge: 'ok', pet }), null)
  assert.equal(dualLayerAdvisory({ desktopRunning: true, bridge: up, pet: '鱼姐' }), null)
})
