/**
 * 一次性调试台（不入库）：用真 Electron + 真 desktop/farm.html + 真 farm-preload.js
 * 驱动 desktop/farm.js，观察「雇工页」合同倒计时在 阻塞 / 切页 之后是否按真实时间走。
 *
 * 只冒充主进程（把 farm-state 推给窗口）与宿主（不下发新快照）。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')

const { writeFileSync } = require('node:fs')
const ROOT = process.env.DSH_ZOO_ROOT || process.cwd()
/**
 * Windows 上 Electron 是 GUI 子系统程序，主进程的 stdout 常常传不回父进程的管道。
 * 所以同一份 JSON 也写文件（run.mjs 那边优先读文件、再退回 stdout）。
 */
const TRACE_OUT = process.env.DSH_ZOO_TRACE_OUT || ''
function emit (payload) {
  const line = '@@DATA@@' + JSON.stringify(payload) + '\n'
  if (TRACE_OUT !== '') {
    try {
      writeFileSync(TRACE_OUT, JSON.stringify(payload), 'utf8')
    } catch {
      // 写不进去就当没有，stdout 那条还在
    }
  }
  process.stdout.write(line)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const CONTRACT_ID = '11111111-1111-4111-8111-111111111111'

function stateFor (remainingMs) {
  return {
    farm: {
      unlocked: 4,
      maxPlots: 50,
      nextCost: 60,
      unlockLadder: [60, 65, 75, 80, 90],
      plots: [
        { id: 'p1', crop: 'tomato', stage: 'growing', mature: false, remainingMs: 60 * 60 * 1000, waterings: 0, fertilized: false },
        { id: 'p2', crop: 'carrot', stage: 'growing', mature: false, remainingMs: 60 * 60 * 1000, waterings: 0, fertilized: false }
      ],
      seeds: { tomato: 2, carrot: 0, pumpkin: 0 },
      crops: { tomato: 0, carrot: 0, pumpkin: 0 },
      coins: 30,
      dew: 5,
      worker: null,
      contractCount: 1,
      hire: { enabled: true, wagePerHour: 10, minHours: 2, maxHours: 8 },
      guard: 0.8,
      log: [],
      carried: []
    },
    market: { prices: {}, index: {}, history: [] },
    crops: null,
    contracts: {
      outgoing: [{
        id: CONTRACT_ID,
        workerNickname: '阿蟹',
        hours: 2,
        wagePerHour: 10,
        wage: 20,
        fee: 1,
        status: 'active',
        earned: 0,
        remainingMs,
        settled: false
      }],
      incoming: [],
      listings: [],
      pendingHire: false
    },
    mode: 'owner',
    visit: null,
    look: null,
    neighbors: [],
    plotId: null
  }
}

async function readContractText (win) {
  return win.webContents.executeJavaScript(
    '(() => { const el = document.querySelector("[data-contract-meta]");' +
    ' return el === null ? null : el.textContent })()',
    true
  )
}

async function clickTab (win, name) {
  await win.webContents.executeJavaScript(
    '(() => { const el = document.querySelector(\'.tab[data-tab="' + name + '"]\');' +
    ' if (el === null) return false; el.click(); return true })()',
    true
  )
}

async function blockRenderer (win, ms) {
  return win.webContents.executeJavaScript(
    '(() => { const end = Date.now() + ' + ms + '; while (Date.now() < end) {} return true })()',
    true
  )
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 420,
    height: 620,
    show: false,
    webPreferences: {
      preload: join(ROOT, 'desktop/farm-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  const ready = new Promise((resolve) => ipcMain.once('dsh-zoo:farm-ready', () => resolve()))
  const submits = []
  ipcMain.on('dsh-zoo:farm-submit', (_event, action) => submits.push(action))
  await win.loadFile(join(ROOT, 'desktop/farm.html'))
  await ready

  const trace = []
  const mark = async (label) => {
    const text = await readContractText(win)
    trace.push({ label, at: Date.now(), text })
    return text
  }

  // 1) 推一份 90 秒剩余的快照（时间格式分辨率为 1 秒，信号最细）
  win.webContents.send('dsh-zoo:farm-state', stateFor(90000))
  await sleep(500)
  await clickTab(win, 'hire')
  await sleep(300)
  await mark('t0')

  // 2) 正常走 3 秒
  await sleep(3000)
  await mark('after-3s')

  // 3) 阻塞渲染进程 5 秒：模拟 interval 被后台节流/渲染忙延迟
  await blockRenderer(win, 5000)
  await sleep(150)
  await mark('after-block-5s')

  // 4) 切到农场页 3 秒再切回来：模拟「用户去别的页看了一眼」
  await clickTab(win, 'farm')
  await sleep(3000)
  await clickTab(win, 'hire')
  await sleep(150)
  await mark('after-tab-away-3s')

  // 5) 不做任何事，再看一次（确认切页后没有把用户拽回旧值）
  await sleep(1000)
  await mark('after-tab-back-1s')

  emit({ trace, submits })
  app.exit(0)
}).catch((error) => {
  emit({ error: String(error?.stack ?? error) })
  app.exit(1)
})
