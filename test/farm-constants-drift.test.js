/**
 * 票 45：跨进程常量防漂移。
 *
 * 桌面 helper 是普通 script（不是 ESM），不能 import 宿主的常量，所以只能各写一份。
 * 这份测试直接读 `desktop/farm.js` / `desktop/farm-view.js` / `desktop/shared.js`
 * 的源码，把同一组数字与宿主真值逐项比对：雇佣范围、手续费、作物显示表、守卫上限、
 * 仓库/日志上限。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  HIRE_REASONS,
  MAX_CONTRACT_HOURS,
  MAX_CONTRACT_WAGE,
  MIN_CONTRACT_HOURS,
  MIN_CONTRACT_WAGE,
  WORK_FEE_RATE
} from '../src/contracts-rules.js'
import {
  SHELF_BASE_SLOTS,
  SHELF_MAX_SLOTS,
  SHELF_SLOT_PRICE,
  TRIP_LOG_BODY_MAX,
  TRIP_LOG_TITLE_MAX
} from '../src/expedition.js'
import {
  MAX_COINS,
  MAX_FARM_LOG,
  MAX_STACK
} from '../src/farm.js'
import { CROPS, MAX_DEW, MAX_GUARD, MAX_PLOTS, PLOT_UNLOCK_RESERVE, START_PLOTS } from '../src/farm-rules.js'
import {
  HIRE_GUARD_MAX,
  HIRE_HOURS_MAX,
  HIRE_HOURS_MIN,
  HIRE_REASONS as PROTOCOL_HIRE_REASONS,
  HIRE_WAGE_MAX,
  HIRE_WAGE_MIN
} from '../src/protocol.js'
import {
  BOARD_TIMEFRAMES,
  LEGACY_MAX_LEVERAGE,
  MAX_LEVERAGE,
  MAX_MARGIN,
  TRADING_STOP_LEVELS
} from '../src/trading-rules.js'
import shared from '../desktop/shared.js'

const FARM_JS = new URL('../desktop/farm.js', import.meta.url)
const SHARED_JS = new URL('../desktop/shared.js', import.meta.url)
const EXPEDITION_VIEW_JS = new URL('../desktop/expedition-view.js', import.meta.url)
const require = createRequire(import.meta.url)
// desktop/ 是 CommonJS：ticket 47 把作物显示表放进纯视图层，Node 与渲染页共用同一份。
const farmView = require('../desktop/farm-view.js')
const boardView = require('../desktop/trading-view.js')

function numberConstant (source, name) {
  const match = source.match(new RegExp('(?:const\\s+)?' + name + '\\s*=\\s*([0-9.]+)'))
  assert.ok(match, '应该能在桌面源码里找到 ' + name)
  return Number(match[1])
}

test('宿主内部的雇佣常量只有一份真相（contracts-rules → farm/protocol）', async () => {
  assert.equal(HIRE_WAGE_MIN, MIN_CONTRACT_WAGE)
  assert.equal(HIRE_WAGE_MAX, MAX_CONTRACT_WAGE)
  assert.equal(HIRE_HOURS_MIN, MIN_CONTRACT_HOURS)
  assert.equal(HIRE_HOURS_MAX, MAX_CONTRACT_HOURS)
  assert.equal(HIRE_GUARD_MAX, MAX_GUARD)
  assert.deepEqual(PROTOCOL_HIRE_REASONS, HIRE_REASONS)
  // farm.js 保留旧名字，但值是同一组。
  const farm = await import('../src/farm.js')
  assert.equal(farm.MIN_WAGE, MIN_CONTRACT_WAGE)
  assert.equal(farm.MAX_WAGE, MAX_CONTRACT_WAGE)
  assert.equal(farm.MIN_HIRE_HOURS, MIN_CONTRACT_HOURS)
  assert.equal(farm.MAX_HIRE_HOURS, MAX_CONTRACT_HOURS)
})

test('desktop/farm.js 的雇佣常量与宿主一致', async () => {
  const source = await readFile(FARM_JS, 'utf8')
  assert.equal(numberConstant(source, 'HIRE_WAGE_MIN'), MIN_CONTRACT_WAGE)
  assert.equal(numberConstant(source, 'HIRE_WAGE_MAX'), MAX_CONTRACT_WAGE)
  assert.equal(numberConstant(source, 'HIRE_HOURS_MIN'), MIN_CONTRACT_HOURS)
  assert.equal(numberConstant(source, 'HIRE_HOURS_MAX'), MAX_CONTRACT_HOURS)
  assert.equal(numberConstant(source, 'HIRE_FEE_RATE'), WORK_FEE_RATE)
})

test('desktop/farm-view.js 的作物显示表与宿主一致（名称/emoji/价格/生长/产量）', () => {
  assert.deepEqual(farmView.CROP_IDS, Object.keys(CROPS))
  for (const cropId of Object.keys(CROPS)) {
    const meta = farmView.CROP_META[cropId]
    assert.ok(meta, 'farm-view 应该有 ' + cropId)
    assert.equal(meta.name, CROPS[cropId].name, cropId + ' 名称')
    assert.equal(meta.seedPrice, CROPS[cropId].seedPrice, cropId + ' 种子价')
    assert.equal(meta.base, CROPS[cropId].base, cropId + ' 底价')
    assert.equal(meta.growMs, CROPS[cropId].growMs, cropId + ' 生长时长')
    assert.equal(meta.yield, CROPS[cropId].yield, cropId + ' 产量')
  }
})

test('解锁的种子钱在窗口与宿主两边同源（ticket 48）', () => {
  assert.equal(farmView.UNLOCK_RESERVE, PLOT_UNLOCK_RESERVE)
  assert.equal(PLOT_UNLOCK_RESERVE, 6)
})

test('desktop/shared.js 的常量与宿主一致（含守卫 0.8 与底价表）', async () => {
  const source = await readFile(SHARED_JS, 'utf8')
  assert.equal(numberConstant(source, 'HIRE_WAGE_MIN'), MIN_CONTRACT_WAGE)
  assert.equal(numberConstant(source, 'HIRE_WAGE_MAX'), MAX_CONTRACT_WAGE)
  assert.equal(numberConstant(source, 'HIRE_HOURS_MIN'), MIN_CONTRACT_HOURS)
  assert.equal(numberConstant(source, 'HIRE_HOURS_MAX'), MAX_CONTRACT_HOURS)
  assert.equal(numberConstant(source, 'HIRE_FEE_RATE'), WORK_FEE_RATE)
  assert.equal(numberConstant(source, 'MAX_FARM_GUARD'), MAX_GUARD)
  assert.equal(numberConstant(source, 'MAX_FARM_LOG'), MAX_FARM_LOG)
  assert.equal(numberConstant(source, 'MAX_FARM_PLOTS'), MAX_PLOTS)
  assert.equal(numberConstant(source, 'MIN_FARM_PLOTS'), START_PLOTS)
  assert.equal(numberConstant(source, 'MAX_FARM_COINS'), MAX_COINS)
  assert.equal(numberConstant(source, 'MAX_FARM_STACK'), MAX_STACK)
  assert.equal(numberConstant(source, 'MAX_FARM_DEW'), MAX_DEW)

  const baseMatch = source.match(/const CROP_BASE_PRICE = \{([^}]*)\}/)
  assert.ok(baseMatch, 'desktop/shared.js 应该有 CROP_BASE_PRICE')
  for (const cropId of Object.keys(CROPS)) {
    const found = baseMatch[1].match(new RegExp(cropId + ':\\s*(\\d+)'))
    assert.ok(found, 'CROP_BASE_PRICE 缺 ' + cropId)
    assert.equal(Number(found[1]), CROPS[cropId].base, cropId + ' 底价')
  }

  const reasonsMatch = source.match(/const HIRE_REASONS = \[([^\]]*)\]/)
  assert.ok(reasonsMatch, 'desktop/shared.js 应该有 HIRE_REASONS')
  const reasons = reasonsMatch[1].split(',').map((part) => part.trim().replace(/^'|'$/g, ''))
  assert.deepEqual(reasons, HIRE_REASONS)
})

test('票 58：每种作物都有包内自带的 SVG，路径与 id 一一对应', async () => {
  for (const cropId of Object.keys(CROPS)) {
    const meta = farmView.CROP_META[cropId]
    assert.equal(meta.art, 'crops/' + cropId + '.svg', cropId + ' 的图路径')
    assert.equal(typeof meta.emoji, 'string', cropId + ' 要留 emoji 兜底')
    assert.ok(meta.emoji.length > 0, cropId + ' 的 emoji 不能是空串')

    // 文件必须真在包里：`desktop/` 整个目录随 npm 包发布，图不能指向打包外的绝对路径。
    const svg = await readFile(new URL('../desktop/' + meta.art, import.meta.url), 'utf8')
    assert.match(svg, /^<svg[\s>]/, cropId + ' 不是 SVG')
    assert.match(svg, /viewBox="0 0 100 100"/, cropId + ' 的 viewBox 要统一成 100×100')
    assert.equal(svg.includes('<script'), false, cropId + ' 的图里不该有脚本')
  }
})

test('票 83：盘口单笔保证金上限与农场硬币上限同值', () => {
  // 「全下」把保证金从固定档位换成任意整数金额，上限必须和钱包同一把尺子：
  // 超过钱包的申请先被 no-coin 挡掉，这个数只防离谱输入（见 MAX_MARGIN 的注释）。
  assert.equal(MAX_MARGIN, MAX_COINS)
})

test('票 84：helper 的周期白名单与宿主的周期清单同源', () => {
  // helper 是 CommonJS 小脚本，不能 import 宿主规则：靠这条断言防漂移。
  // 加周期要同时改 `src/trading-rules.js` 的 BOARD_TIMEFRAMES 与
  // `desktop/shared.js` 的 BOARD_TIMEFRAME_IDS，这条断言盯着两边。
  assert.deepEqual(shared.BOARD_TIMEFRAME_IDS, BOARD_TIMEFRAMES.map(({ id }) => id))
})

test('票 81/评审 P2：helper 与窗口的盘口杠杆/止损档与宿主同源', () => {
  // 杠杆上限与止损四档各写一份（helper/渲染页不是 ESM），靠这两条断言防漂移。
  // 杠杆白名单现在是 1×/5×/20×/100×；helper 的上限对齐「读得回来的形状」LEGACY_MAX_LEVERAGE，
  // 也等于下单白名单的最大值。
  assert.equal(shared.BOARD_MAX_LEVERAGE, LEGACY_MAX_LEVERAGE)
  assert.equal(MAX_LEVERAGE, 100)
  assert.deepEqual(shared.BOARD_STOP_LEVELS, TRADING_STOP_LEVELS)
  // 窗口的循环按钮吃的是同一组档位；下一步永远在这四个值里转。
  assert.deepEqual(boardView.stopLevels(), TRADING_STOP_LEVELS)
  for (const level of TRADING_STOP_LEVELS) {
    assert.equal(boardView.nextStopLevel(level), TRADING_STOP_LEVELS[
      (TRADING_STOP_LEVELS.indexOf(level) + 1) % TRADING_STOP_LEVELS.length
    ])
  }
})

test('票 120/评审 B2：陈列架 8 / 32 / 5000 在 desktop 只有一份，窗口引用它', async () => {
  // 三处各写一份（shared.js、expedition-view.js、farm.js 内联 32）就是票 115/120 的口径漂移源。
  // 收敛后桌面侧只有 `desktop/shared.js` 写数字：expedition-view.js 从它拿，farm.js 用宿主
  // 随窗下发的 `expeditionCodexOwned.total`。这条断言盯着「别再抄回去」。
  const sharedSource = await readFile(SHARED_JS, 'utf8')
  assert.equal(numberConstant(sharedSource, 'SHELF_BASE_SLOTS'), SHELF_BASE_SLOTS)
  assert.equal(numberConstant(sharedSource, 'EXPEDITION_SHELF_MAX'), SHELF_MAX_SLOTS)
  assert.equal(numberConstant(sharedSource, 'EXPEDITION_SHELF_PRICE'), SHELF_SLOT_PRICE)
  assert.equal(numberConstant(sharedSource, 'TRIP_LOG_TITLE_MAX'), TRIP_LOG_TITLE_MAX)
  assert.equal(numberConstant(sharedSource, 'TRIP_LOG_BODY_MAX'), TRIP_LOG_BODY_MAX)

  // 导出的值就是源码里那两个常量（helper 与渲染页都从 module.exports 拿）。
  assert.equal(shared.SHELF_BASE_SLOTS, SHELF_BASE_SLOTS)
  assert.equal(shared.EXPEDITION_SHELF_MAX, SHELF_MAX_SLOTS)
  assert.equal(shared.EXPEDITION_SHELF_PRICE, SHELF_SLOT_PRICE)
  assert.equal(shared.TRIP_LOG_TITLE_MAX, TRIP_LOG_TITLE_MAX)
  assert.equal(shared.TRIP_LOG_BODY_MAX, TRIP_LOG_BODY_MAX)

  // expedition-view.js 不再自己写 32 / 5000，而是从 shared 拿同一份。
  const viewSource = await readFile(EXPEDITION_VIEW_JS, 'utf8')
  assert.equal(/SHELF_MAX_SLOTS\s*=\s*32/.test(viewSource), false, 'expedition-view 别再写一份 32')
  assert.equal(/SHELF_SLOT_PRICE\s*=\s*5000/.test(viewSource), false, 'expedition-view 别再写一份 5000')
  assert.match(viewSource, /shared\.EXPEDITION_SHELF_MAX/)
  assert.match(viewSource, /shared\.EXPEDITION_SHELF_PRICE/)
  const view = require('../desktop/expedition-view.js')
  assert.equal(view.SHELF_MAX_SLOTS, shared.EXPEDITION_SHELF_MAX)
  assert.equal(view.SHELF_SLOT_PRICE, shared.EXPEDITION_SHELF_PRICE)
  assert.equal(view.shelfCells({ slots: 8, items: [] }).length, SHELF_MAX_SLOTS)
  assert.equal(view.shelfCells({ slots: 8, items: [] })[SHELF_BASE_SLOTS].price, SHELF_SLOT_PRICE)

  // farm.js 的顶栏计数上限跟宿主下发的 total 走，不写字面 32。
  const farmSource = await readFile(FARM_JS, 'utf8')
  assert.equal(/Math\.min\(\s*32/.test(farmSource), false, 'farm.js 别再内联 32')
  assert.match(farmSource, /expeditionCodexOwned/)
})
