/**
 * 票 67：秋天来客「熊獾」的纯规则。
 *
 * 不碰存档、不碰窗口：只回答「这个选择成不成、扣多少、给什么」。
 * 概率复用农场的守卫值（主人在家 0.3、雇工 0.5、封顶 0.8），
 * 但来客不是偷菜：守卫成功 = 偷菜判定失败。
 */
import { stealSucceeds } from './farm-rules.js'

export const OMEN_ID = 'autumn-bearger'
export const OMEN_SEASON = 'autumn'
export const OMEN_NAME = '熊獾'
export const OMEN_EMOJI = '🐻'
export const OMEN_GUARD_REWARD = Object.freeze({ coins: 40, dew: 3 })
export const OMEN_FEED_COST = 3
export const OMEN_FEED_REWARD = Object.freeze({ coins: 0, dew: 2, seeds: Object.freeze({ rice: 1 }) })
export const OMEN_FAIL_LOSS = 3
export const OMEN_IGNORE_LOSS = 1

export const OMEN_CHOICES = Object.freeze([
  Object.freeze({
    id: 'guard',
    label: '守夜',
    detail: '按守卫成功率赌一把：成功得 40 硬币 + 3 露水，失败被搬走 3 个仓库作物。'
  }),
  Object.freeze({
    id: 'feed',
    label: '投喂',
    detail: `交出 ${OMEN_FEED_COST} 个仓库作物，换 1 颗稻种 + 2 露水，稳过。`
  })
])

export function omenFor (seasonId) {
  return seasonId === OMEN_SEASON
    ? {
        id: OMEN_ID,
        name: OMEN_NAME,
        emoji: OMEN_EMOJI,
        season: OMEN_SEASON,
        choices: OMEN_CHOICES
      }
    : null
}

export function freshOmen (season) {
  if (season?.id !== OMEN_SEASON) return null
  return {
    start: season.start,
    id: OMEN_ID,
    resolved: false,
    choice: null,
    result: null
  }
}

/**
 * 读档收敛：只接受「今年秋天、同一天、同 id」的来客；
 * 其余一律当作没来过，避免去年秋天的熊獾今年又冒出来。
 */
export function normalizeOmen (raw, season) {
  if (season?.id !== OMEN_SEASON || raw === null || typeof raw !== 'object') return null
  if (raw.start !== season.start || raw.id !== OMEN_ID) return null
  return {
    start: season.start,
    id: OMEN_ID,
    resolved: raw.resolved === true,
    choice: raw.choice === 'guard' || raw.choice === 'feed' ? raw.choice : null,
    result: raw.result !== null && typeof raw.result === 'object' ? { ...raw.result } : null
  }
}

/** 窗口视图；`canFeed` 由 service 按仓库数量补，规则层不知道农场库存。 */
export function omenView (omen) {
  if (omen === null || typeof omen !== 'object') return null
  const meta = omenFor(OMEN_SEASON)
  return {
    ...meta,
    resolved: omen.resolved === true,
    choice: omen.choice,
    result: omen.result === null || omen.result === undefined ? null : { ...omen.result },
    stakes: {
      guardReward: { ...OMEN_GUARD_REWARD },
      failLoss: OMEN_FAIL_LOSS,
      feedCost: OMEN_FEED_COST,
      feedReward: { ...OMEN_FEED_REWARD, seeds: { ...OMEN_FEED_REWARD.seeds } },
      ignoreLoss: OMEN_IGNORE_LOSS
    }
  }
}

/**
 * 结算一个选择。`guard` 是 0..0.8 的守卫值，`random` 可注入。
 * 投喂不掷骰：只要 service 已经扣掉 3 个作物，就稳过。
 */
export function resolveOmen (choice, { guard = 0, random = Math.random } = {}) {
  if (choice !== 'guard' && choice !== 'feed') return { ok: false, code: 'bad-choice' }

  if (choice === 'feed') {
    return {
      ok: true,
      choice,
      success: true,
      loss: 0,
      consume: OMEN_FEED_COST,
      reward: { ...OMEN_FEED_REWARD, seeds: { ...OMEN_FEED_REWARD.seeds } }
    }
  }

  const success = !stealSucceeds(guard, random)
  return {
    ok: true,
    choice,
    success,
    loss: success ? 0 : OMEN_FAIL_LOSS,
    consume: 0,
    reward: success
      ? { ...OMEN_GUARD_REWARD, seeds: {} }
      : { coins: 0, dew: 0, seeds: {} }
  }
}
