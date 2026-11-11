/**
 * 挂牌新鲜度：宿主侧（src/market.js 的 isFreshPeerDigest）与窗口侧
 * （desktop/farm-view.js 的 listingIsStale）必须是同一条语义：
 *
 *   「我多久没听到这一户了」按**本机收到行情的时间**算，不按邻居的墙上时钟。
 *
 * 以前的 bug：用报文里的 `at` 直接减本机 now。邻居表慢 90 秒，30 秒一包，
 * 就只剩 30 秒新鲜期；慢到 110 秒，每包到手 10 秒后就显示「行情过期」。
 * 两分钟本身没短——它等于 PEER_LOST_MS（心跳 2 秒，等于连续 60 拍没听到），
 * 错的是拿别人的表量自己的等待。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { isFreshPeerDigest } from '../src/market.js'

const require = createRequire(import.meta.url)
const view = require('../desktop/farm-view.js')

const NOW = 1_800_000_000_000
const TTL = 2 * 60 * 1000

test('邻居表慢 90 秒：刚收到的挂牌仍然新鲜（按 seenAt 算，不按 at）', () => {
  const digest = { at: NOW - 90_000, seenAt: NOW }
  assert.equal(isFreshPeerDigest(digest, NOW, TTL), true)
})

test('邻居表快 90 秒：也不会因为 at 在未来而永远新鲜；120 秒后照样过期', () => {
  const digest = { at: NOW + 90_000, seenAt: NOW }
  assert.equal(isFreshPeerDigest(digest, NOW, TTL), true)
  assert.equal(isFreshPeerDigest(digest, NOW + 119_000, TTL), true)
  assert.equal(isFreshPeerDigest(digest, NOW + 121_000, TTL), false)
})

test('120 秒没再收到这一户的行情：过期；等于 PEER_LOST_MS 的口径', () => {
  assert.equal(isFreshPeerDigest({ at: NOW, seenAt: NOW - 119_999 }, NOW, TTL), true)
  assert.equal(isFreshPeerDigest({ at: NOW, seenAt: NOW - 120_001 }, NOW, TTL), false)
})

test('老数据没有 seenAt：退回 at（保持旧行为，不把已有测试搞坏）', () => {
  assert.equal(isFreshPeerDigest({ at: NOW - 30_000 }, NOW, TTL), true)
  assert.equal(isFreshPeerDigest({ at: NOW - 121_000 }, NOW, TTL), false)
  assert.equal(isFreshPeerDigest(null, NOW, TTL), false)
})

test('窗口侧：expiresAt 是本机时间，未来可雇、过期立刻变灰', () => {
  assert.equal(view.listingIsStale({ expiresAt: NOW + 1_000, stale: false }, NOW), false)
  assert.equal(view.listingIsStale({ expiresAt: NOW - 1, stale: false }, NOW), true)
  // 老宿主没有 expiresAt：退回 push 时的 stale 快照。
  assert.equal(view.listingIsStale({ stale: true }, NOW), true)
  assert.equal(view.listingIsStale({ stale: false }, NOW), false)
  assert.equal(view.listingIsStale(null, NOW), false)
})

test('窗口侧：过期时间在当前时刻之后，整段可雇（不再依赖下一次 push）', () => {
  const listing = { expiresAt: NOW + 120_000, stale: false }
  assert.equal(view.listingIsStale(listing, NOW + 1), false)
  assert.equal(view.listingIsStale(listing, NOW + 119_999), false)
  assert.equal(view.listingIsStale(listing, NOW + 120_000), true)
})
