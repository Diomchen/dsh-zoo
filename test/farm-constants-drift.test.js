/**
 * 票 45：跨进程常量防漂移。
 *
 * 桌面 helper 是普通 script（不是 ESM），不能 import 宿主的常量，所以只能各写一份。
 * 这份测试直接读 `desktop/farm.js` / `desktop/shared.js` 的源码，把同一组数字与
 * 宿主真值逐项比对：雇佣范围、手续费、作物底价、守卫上限、仓库/日志上限。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
  MAX_COINS,
  MAX_FARM_LOG,
  MAX_STACK
} from '../src/farm.js'
import { CROPS, MAX_DEW, MAX_GUARD } from '../src/farm-rules.js'
import {
  HIRE_GUARD_MAX,
  HIRE_HOURS_MAX,
  HIRE_HOURS_MIN,
  HIRE_REASONS as PROTOCOL_HIRE_REASONS,
  HIRE_WAGE_MAX,
  HIRE_WAGE_MIN
} from '../src/protocol.js'

const FARM_JS = new URL('../desktop/farm.js', import.meta.url)
const SHARED_JS = new URL('../desktop/shared.js', import.meta.url)

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

test('desktop/farm.js 的雇佣/作物常量与宿主一致', async () => {
  const source = await readFile(FARM_JS, 'utf8')
  assert.equal(numberConstant(source, 'HIRE_WAGE_MIN'), MIN_CONTRACT_WAGE)
  assert.equal(numberConstant(source, 'HIRE_WAGE_MAX'), MAX_CONTRACT_WAGE)
  assert.equal(numberConstant(source, 'HIRE_HOURS_MIN'), MIN_CONTRACT_HOURS)
  assert.equal(numberConstant(source, 'HIRE_HOURS_MAX'), MAX_CONTRACT_HOURS)
  assert.equal(numberConstant(source, 'HIRE_FEE_RATE'), WORK_FEE_RATE)

  for (const cropId of Object.keys(CROPS)) {
    const pattern = new RegExp(cropId +
      ": \\{ name: '[^']*', emoji: '[^']*', seedPrice: (\\d+), base: (\\d+) \\}")
    const match = source.match(pattern)
    assert.ok(match, 'desktop/farm.js 应该有 ' + cropId + ' 的种子价/底价')
    assert.equal(Number(match[1]), CROPS[cropId].seedPrice, cropId + ' 种子价')
    assert.equal(Number(match[2]), CROPS[cropId].base, cropId + ' 底价')
  }
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
