#!/usr/bin/env node
// 单机双宠物：一台机器上起两只真宠物，把偷菜和雇工真的走一遍（票 50）。
//
// 用法：
//   npm run two-pets
//   npm run two-pets -- --lucky   # 守卫那一掷固定成「没被抓」，只看链路不掷骰子
//
// 它会打印两个 baseUrl（可以直接 curl），然后等你的命令：
//   admit            互相放行（雇工必须先放行：mayTalkTo）
//   visit            A 去 B 家串门（偷菜只在串门期间有入口）
//   plant p4 tomato  B 在 p4 种一株（开局只有 2 颗番茄种子；p1/p2 已经是熟的）
//   look             在家看 B 家的农场（不用放行、不用串门）
//   raid [p1 p2]     派 A 去偷 B：不带地块就让它把能偷的都偷了
//   steal p1         串门期间偷 B 家 p1（老流程，仍在）
//   listing 10 2 8   B 挂牌：时薪 10、2–8 小时
//   hire 2           A 雇 B 两个小时（工资 + 5% 手续费，预付）
//   contracts        两边的合同
//   state            两边四件最该看的事：出没出门 / 访客 / 守卫 / 硬币
//   recall           A 回家
//   ?                帮助
//   q                退出
//
// 为什么不用第二台机器：两只都跑在这一个进程里，各自一份临时数据目录、一条回环 UDP、
// 一条真 HTTP。`scripts/lib/pet.mjs` 把引导藏起来了，这里只管下命令。
//
// 想验的细节（成熟度、守卫概率、每日上限）不属于这个脚本——那些由
// `test/farm-visit-e2e.test.js` / `test/work-e2e.test.js` 覆盖。

import { createInterface } from 'node:readline'

import { CROPS } from '../src/farm-rules.js'
import { startPair, until } from './lib/pet.mjs'

// B 的 p1/p2 开局就熟：偷菜不用真等 30 分钟。
// 为什么不在运行中拨时钟：行情的 `at` 也走农场钟（`src/service.js:265`），而雇工的心跳/
// 摘要新鲜度用的是真实钟；一拨就会让「挂牌」被判成过期样本，hire 永远 worker-unavailable。
const args = parseArgs(process.argv.slice(2))
const lucky = args.lucky === true

const pair = await startPair({
  b: {
    mature: { p1: 'tomato', p2: 'carrot' },
    // 守卫是真的 30%：demo 想稳定看到成功路径时才用 --lucky 固定这一掷。
    ...(lucky ? { farmRandom: () => 1 } : {})
  }
})
const { a, b } = pair

await until(async () => {
  const [sa, sb] = await Promise.all([a.state(), b.state()])
  return sa.neighbors.some((n) => n.deviceId === b.deviceId) &&
    sb.neighbors.some((n) => n.deviceId === a.deviceId)
}, { label: '两只宠物互相发现', timeoutMs: 10000 })

console.log('[双宠物] A「小蓝」 ' + a.baseUrl)
console.log('[双宠物] B「小黄」 ' + b.baseUrl)
console.log('[双宠物] 两条都是真的 /dsh-zoo/state 与 /dsh-zoo/action，可以直接 curl：')
console.log('          curl -s ' + a.baseUrl + '/dsh-zoo/state | jq .farm')
console.log('[双宠物] 先 `admit`，再 `visit`，然后 `steal p1`；另一条是 `listing 10 2 8` + `hire 2`。按 ? 看全部命令。')

startInput()

function startInput () {
  // 有 TTY 就真的像 REPL；没有就照读管道（`printf 'admit\nq\n' | npm run two-pets` 也能用）。
  const interactive = process.stdin.isTTY === true
  const rl = createInterface({ input: process.stdin, prompt: interactive ? '> ' : '' })
  if (interactive) rl.prompt()

  // 一条一条排好队跑：管道进来的一整批行是同步到的，不排队就会互相抢，`q` 还会抢在别人前面退出。
  let queue = Promise.resolve()
  rl.on('line', (line) => {
    const [command, ...rest] = line.trim().split(/\s+/)
    queue = queue.then(async () => {
      try {
        await run(command ?? '', rest)
      } catch (error) {
        console.error('[双宠物] 出错了：' + (error instanceof Error ? error.message : String(error)))
      }
      if (command !== 'q' && interactive) rl.prompt()
    })
  })
  rl.on('close', () => {
    queue = queue.then(() => shutdown())
  })
}

async function run (command, rest) {
  if (command === '' || command === '?') return help()
  if (command === 'q' || command === 'quit') return shutdown()

  if (command === 'admit') {
    const out = await a.action('admit', { deviceId: b.deviceId })
    const back = await b.action('admit', { deviceId: a.deviceId })
    return console.log('[双宠物] 互相放行：' + verdict(out) + ' / ' + verdict(back))
  }

  if (command === 'plant') {
    const [plotId, cropId] = rest
    if (plotId === undefined || cropId === undefined) return console.log('[双宠物] 用法：plant p1 tomato')
    const result = await b.action('farm-plant', { plotId, cropId })
    const growMs = CROPS[cropId]?.growMs
    return console.log('[双宠物] B 种下：' + verdict(result) +
      (growMs === undefined ? '' : '（' + cropId + ' 要长 ' + Math.round(growMs / 60 / 1000) + ' 分钟才熟）'))
  }

  if (command === 'visit') {
    const result = await a.action('visit', { deviceId: b.deviceId })
    if (result.body.ok !== true) return console.log('[双宠物] 出不了门：' + verdict(result))
    await until(async () => (await a.state()).self.out?.phase === 'active', {
      label: 'A 抵达 B 家',
      timeoutMs: 10000
    })
    return console.log('[双宠物] A 到 B 家了。现在 `steal p1` 才有意义——偷菜是访客的动作。')
  }

  if (command === 'recall') {
    return console.log('[双宠物] ' + verdict(await a.action('recall')))
  }

  if (command === 'look') {
    const looked = await a.action('farm-look', { deviceId: b.deviceId })
    if (looked.body.ok !== true) return console.log('[双宠物] 看田失败：' + verdict(looked))
    const view = looked.body.view
    const mature = view.plots.filter((plot) => plot.mature).length
    return console.log('[双宠物] 「' + view.host.nickname + '」的农场：' + view.plots.length +
      ' 块地，熟的 ' + mature + ' 块 · 守卫 ' + Math.round(view.guard * 100) + '%' +
      ' · 这趟还剩 ' + view.quotas.perTripLeft + ' 次')
  }

  if (command === 'raid') {
    const plots = rest.filter((id) => /^p\d+$/.test(id))
    const raid = await a.action('farm-raid', {
      deviceId: b.deviceId,
      ...(plots.length === 0 ? {} : { plots })
    })
    if (raid.body.ok !== true) return console.log('[双宠物] 派不出去：' + verdict(raid))
    // 等这一趟收尾（默认亮 8 秒），好让它停在"你刚好看见它回来"的那一刻。
    await until(async () => (await a.state()).self.out === null, { label: 'A 偷完回家', timeoutMs: 15000 })
    const mine = await a.state()
    return console.log('[双宠物] 这一趟回来了：' + JSON.stringify(mine.farm.crops) +
      ' · 记录 ' + JSON.stringify(mine.visits[0] ?? null))
  }

  if (command === 'steal') {
    const plotId = rest[0]
    if (plotId === undefined) return console.log('[双宠物] 用法：steal p1')
    const result = await a.action('farm-steal', { plotId })
    if (result.body?.error === 'guard') {
      return console.log('[双宠物] 失败：守卫抓住了（30%）。换一块熟地再试（steal p2），' +
        '或者用 --lucky 起（不掷这一骰）。')
    }
    return console.log('[双宠物] ' + verdict(result))
  }

  if (command === 'listing') {
    const [wage, min, max] = rest.map(Number)
    const result = await b.action('hire-listing', {
      enabled: true,
      wagePerHour: wage,
      minHours: min,
      maxHours: max
    })
    return console.log('[双宠物] B 挂牌：' + verdict(result) +
      (result.body.ok === true ? '（已广播一次行情；回环上丢了的话，下一拍 5 秒内补上）' : ''))
  }

  if (command === 'hire') {
    const hours = Number(rest[0])
    // 挂牌是一次 UDP 广播，可能被回环限速吃掉：`worker-unavailable` 等下一拍再试。
    const result = await until(async () => {
      const attempt = await a.action('hire', { deviceId: b.deviceId, hours })
      return attempt.body.ok === true || attempt.body.error !== 'worker-unavailable' ? attempt : false
    }, { label: 'A 收到 B 的挂牌', timeoutMs: 8000 })
    return console.log('[双宠物] A 雇 B：' + verdict(result))
  }

  if (command === 'contracts') {
    const [sa, sb] = await Promise.all([a.state(), b.state()])
    console.log('[双宠物] A（雇主）outgoing：' + JSON.stringify(sa.contracts.outgoing))
    console.log('[双宠物] B（雇工）incoming：' + JSON.stringify(sb.contracts.incoming))
    return
  }

  if (command === 'state') {
    const [sa, sb] = await Promise.all([a.state(), b.state()])
    return console.log(summary('A', sa) + '\n' + summary('B', sb))
  }

  console.log('[双宠物] 不认识的命令，按 ? 看帮助。')
}

function summary (label, state) {
  const out = state.self.out
  const where = out === null ? '在家' : '在「' + out.nickname + '」家（' + out.phase + '）'
  const working = state.self.work === null ? '' : ' · 在外打工'
  return '[双宠物] ' + label + '：' + where + working +
    ' · 访客 ' + state.visitors.length +
    ' · 雇工 ' + (state.worker === null ? '无' : state.worker.nickname ?? '有') +
    ' · 守卫 ' + Math.round(state.farm.guard * 100) + '%' +
    ' · 硬币 ' + state.farm.coins
}

function verdict (result) {
  if (result.body === null) return 'HTTP ' + result.status
  if (result.body.ok === true) {
    const detail = ['crop', 'qty', 'plot', 'contractId', 'mode']
      .filter((key) => result.body[key] !== undefined)
      .map((key) => key + '=' + (typeof result.body[key] === 'object'
        ? JSON.stringify(result.body[key])
        : result.body[key]))
      .join(' ')
    return '成功' + (detail === '' ? '' : '（' + detail + '）')
  }
  return '失败：' + (result.body.error ?? 'HTTP ' + result.status)
}

function help () {
  console.log([
    '[双宠物] admit            互相放行（雇工必须先放行）',
    '[双宠物] plant p4 tomato  B 在 p4 种番茄（p1/p2 开局是熟的）',
    '[双宠物] visit            A 去 B 家串门（偷菜只在串门期间有入口）',
    '[双宠物] look             在家看 B 家的农场',
    '[双宠物] raid [p1 p2]     派 A 去偷 B（不带地块 = 能偷的都偷）',
    '[双宠物] steal p1         串门期间偷 B 家 p1',
    '[双宠物] help p4          帮还在长的地浇水（先 plant p4 carrot）',
    '[双宠物] listing 10 2 8   B 挂牌：时薪 10、2–8 小时',
    '[双宠物] hire 2           A 雇 B 两个小时',
    '[双宠物] contracts        两边的合同',
    '[双宠物] state            两边摘要',
    '[双宠物] recall           A 回家',
    '[双宠物] q                退出'
  ].join('\n'))
}

function parseArgs (argv) {
  const out = {}
  for (const token of argv) {
    if (token.startsWith('--')) out[token.slice(2)] = true
  }
  return out
}

async function shutdown () {
  await pair.close()
  console.log('[双宠物] 走了（临时目录已删干净）。')
  process.exit(0)
}
