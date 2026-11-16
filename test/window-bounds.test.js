/**
 * 票 85：盘口窗位置恢复/夹取（ADR-0029）的纯函数测试。
 *
 * 覆盖验收里的三种情况：保存点在屏里就原样用；离屏/负坐标/坏文件回落居中；
 * 多屏时夹进保存点所在的那块屏，而不是主屏。读/写用注入的 fs 或临时目录，不起 Electron。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const {
  BOARD_POSITION_FILE,
  clampToWorkArea,
  centerInArea,
  isInsideArea,
  normalizePoint,
  pickBounds,
  readPosition,
  writePosition
} = require('../desktop/window-bounds.js')

const BOARD = { width: 760, height: 700 }
/** 主屏：菜单栏占 25px，和 macOS 的 workArea 形状一致。 */
const PRIMARY = { x: 0, y: 25, width: 1512, height: 957 }
/** 右侧副屏：从主屏右边缘开始，略矮。 */
const SECONDARY = { x: 1512, y: 0, width: 1440, height: 900 }
const AREAS = [PRIMARY, SECONDARY]
/** 多屏并集：包含菜单栏上沿和屏幕之间的空隙，不能当成“真实工作区”。 */
const UNION = { x: 0, y: 0, width: 2952, height: 982 }

test('票 85：保存点还在屏里 → 原样恢复（不居中）', () => {
  assert.equal(BOARD_POSITION_FILE, 'board-window.json')
  assert.deepEqual(
    pickBounds({ saved: { x: 300, y: 200 }, areas: AREAS, area: PRIMARY, ...BOARD }),
    { x: 300, y: 200 }
  )
  // 窗口尺寸仍放得下时，贴边 8px 也不动。
  assert.deepEqual(
    pickBounds({ saved: { x: 8, y: 33 }, areas: AREAS, area: PRIMARY, ...BOARD }),
    { x: 8, y: 33 }
  )
})

test('票 85：保存点在屏里但窗口会越界 → 夹进这块屏', () => {
  // 左上角还在主屏里（1510 ≤ 1512），但 760×700 的窗口会伸出去：夹到右下留 8px。
  assert.deepEqual(
    pickBounds({ saved: { x: 1510, y: 900 }, areas: AREAS, area: PRIMARY, ...BOARD }),
    { x: 1512 - 760 - 8, y: 25 + 957 - 700 - 8 }
  )
})

test('票 85：离屏 / 负坐标 / 坏形状 → 回落今天的居中位置', () => {
  const centered = centerInArea(PRIMARY, BOARD)
  for (const saved of [
    null,
    undefined,
    { x: -400, y: 120 },
    { x: 99999, y: 120 },
    { x: 300, y: -200 },
    { x: '300', y: 200 },
    { x: Number.NaN, y: 200 },
    [300, 200]
  ]) {
    assert.deepEqual(
      pickBounds({ saved, areas: AREAS, area: PRIMARY, ...BOARD }),
      centered,
      '保存点 ' + JSON.stringify(saved) + ' 应回落居中'
    )
  }
})

test('票 85：居中回落的公式和票 79 的 boardBounds() 完全一致', () => {
  // 旧公式：round(max(start+8, min(居中, start+span-size-8)))，逐轴算。
  const legacy = (start, span, size) => Math.round(Math.max(
    start + 8,
    Math.min(start + (span - size) / 2, start + span - size - 8)
  ))
  for (const area of [
    { x: 0, y: 0, width: 1512, height: 982 },
    { x: 0, y: 25, width: 1512, height: 957 },
    { x: -1440, y: 0, width: 1440, height: 900 },
    { x: 0, y: 0, width: 800, height: 720 }
  ]) {
    assert.deepEqual(centerInArea(area, BOARD), {
      x: legacy(area.x, area.width, BOARD.width),
      y: legacy(area.y, area.height, BOARD.height)
    })
  }
})

test('票 85：多屏时按最近的那块屏夹取，不把副屏上的窗口拉回主屏', () => {
  // 保存点在副屏里 → 原样恢复（若误用主屏会被夹到 x=744）。
  assert.deepEqual(
    pickBounds({ saved: { x: 1600, y: 100 }, areas: AREAS, area: PRIMARY, ...BOARD }),
    { x: 1600, y: 100 }
  )
  // 副屏右边缘：夹进副屏（1512+1440-760-8），不是主屏。
  assert.deepEqual(
    pickBounds({ saved: { x: 2947, y: 100 }, areas: AREAS, area: PRIMARY, ...BOARD }),
    { x: 1512 + 1440 - 760 - 8, y: 100 }
  )
  // 保存点所在的显示器被拔掉 → 回落主屏居中。
  assert.deepEqual(
    pickBounds({ saved: { x: 5000, y: 200 }, areas: [PRIMARY], area: PRIMARY, ...BOARD }),
    centerInArea(PRIMARY, BOARD)
  )
  // 接缝 x=1512 同时属于两块屏：副屏只需挪 8px 边距，主屏要挪 768px → 跟副屏。
  assert.deepEqual(
    pickBounds({ saved: { x: 1512, y: 100 }, areas: AREAS, area: UNION, ...BOARD }),
    { x: 1512 + 8, y: 100 }
  )
  // 多屏并集包含主屏菜单栏上沿（y 0..25）和屏幕间空隙：保存点落在那里不算“在屏里”，
  // 否则会把窗口放到菜单栏底下。
  assert.deepEqual(
    pickBounds({ saved: { x: 300, y: 10 }, areas: AREAS, area: UNION, ...BOARD }),
    centerInArea(UNION, BOARD)
  )
  // 只给一块 area、不给 areas 也能工作（旧宿主/单屏）。
  assert.deepEqual(
    pickBounds({ saved: { x: 120, y: 80 }, area: PRIMARY, ...BOARD }),
    { x: 120, y: 80 }
  )
})

test('票 85：是否在屏里 / 过小工作区都按几何算', () => {
  assert.equal(isInsideArea({ x: 10, y: 30 }, PRIMARY), true)
  assert.equal(isInsideArea({ x: 0, y: 0 }, PRIMARY), false, '主屏 y=25 以上是菜单栏')
  assert.equal(isInsideArea({ x: 1512, y: 100 }, PRIMARY), true, '贴右边缘仍算在屏里')
  assert.equal(isInsideArea({ x: -1, y: 100 }, PRIMARY), false)

  // 窗口比工作区还大：只能贴左上角留边距，不能算出负坐标/NaN。
  assert.deepEqual(
    clampToWorkArea({ x: 500, y: 500 }, { x: 0, y: 0, width: 300, height: 300 }, BOARD),
    { x: 8, y: 8 }
  )
  assert.deepEqual(clampToWorkArea({ x: 1, y: 2 }, { x: 0, y: 0, width: 0, height: 100 }, BOARD), { x: 0, y: 0 })
})

test('票 85：normalizePoint 拒绝 JSON 里的坏形状', () => {
  assert.deepEqual(normalizePoint({ x: 1, y: 2 }), { x: 1, y: 2 })
  for (const bad of [null, undefined, 'x', [1, 2], { x: '1', y: 2 }, { x: 1 }, { x: Number.NaN, y: 2 }]) {
    assert.equal(normalizePoint(bad), null, JSON.stringify(bad))
  }
})

test('票 85：位置文件读/写（真实临时目录）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-board-bounds-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const file = join(dir, 'nested', BOARD_POSITION_FILE)

  assert.equal(readPosition(file), null, '缺文件')
  assert.equal(writePosition(file, { x: 120, y: 80 }), true)
  assert.deepEqual(readPosition(file), { x: 120, y: 80 })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { x: 120, y: 80 })

  await writeFile(file, '{ 这不是 JSON', 'utf8')
  assert.equal(readPosition(file), null, '坏文件回落居中')

  await writeFile(file, JSON.stringify({ x: '120', y: 80 }), 'utf8')
  assert.equal(readPosition(file), null, '坏形状回落居中')

  await writeFile(file, JSON.stringify({ x: 120, y: 80 }), 'utf8')
  assert.equal(writePosition(file, { x: Number.NaN, y: 80 }), false, '坏位置不写')
  assert.deepEqual(readPosition(file), { x: 120, y: 80 }, '坏位置不覆盖旧值')
})

test('票 85：位置文件读写可注入 fs（主进程之外也能测）', () => {
  const calls = []
  const fakeFs = {
    readFileSync (file, encoding) {
      calls.push(['read', file, encoding])
      return '{"x":12,"y":34}'
    },
    mkdirSync (dir, options) {
      calls.push(['mkdir', dir, options])
    },
    writeFileSync (file, data) {
      calls.push(['write', file, data])
    }
  }
  const file = join(tmpdir(), 'dsh-zoo-fake', BOARD_POSITION_FILE)

  assert.deepEqual(readPosition(file, fakeFs), { x: 12, y: 34 })
  assert.equal(writePosition(file, { x: 1, y: 2 }, fakeFs), true)
  assert.deepEqual(calls[0], ['read', file, 'utf8'])
  assert.deepEqual(calls[1], ['mkdir', dirname(file), { recursive: true }])
  assert.equal(calls[2][0], 'write')
  assert.equal(calls[2][1], file)
  assert.deepEqual(JSON.parse(calls[2][2]), { x: 1, y: 2 })
})
