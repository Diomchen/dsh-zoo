#!/usr/bin/env node
// 客厅预览器：不启动 DSH，把客厅单独跑起来看一眼。
//
//   node scripts/preview.mjs                # 起在 45999，浏览器打开
//   node scripts/preview.mjs --shot out.png # 用无头 Chrome 截一张图
//
// 它用**真的** client.js、真的 React、真的 dsh-pet 素材，只把宿主快照换成假数据。
// 用来回答「这块东西到底长什么样」，不用等 DSH 重启、不用等第二台机器。
//
// React 的 UMD 构建只在第一次运行时下载到 .cache/（gitignore 里），仓库里不塞第三方代码。

import http from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, '.cache')
const PORT = Number(argument('port') ?? 45999)
const WEBM = join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-pet/assets/webm')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const REACT = { name: 'react.production.min.js', url: 'https://unpkg.com/react@18.3.1/umd/react.production.min.js' }
const REACT_DOM = { name: 'react-dom.production.min.js', url: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js' }

await ensureCache()
const server = http.createServer(handle)
server.listen(PORT, '127.0.0.1', async () => {
  const url = 'http://127.0.0.1:' + PORT + '/'
  console.log('[预览] ' + url)
  const shot = argument('shot')
  if (typeof shot === 'string') await screenshot(url, shot)
})

async function handle (req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  try {
    if (url.pathname === '/') return send(res, 'text/html; charset=utf-8', PAGE)
    if (url.pathname === '/client.js') return send(res, 'text/javascript; charset=utf-8', await readFile(join(ROOT, 'client.js')))
    if (url.pathname === '/react.js') return send(res, 'text/javascript; charset=utf-8', await readFile(join(CACHE, REACT.name)))
    if (url.pathname === '/react-dom.js') return send(res, 'text/javascript; charset=utf-8', await readFile(join(CACHE, REACT_DOM.name)))
    if (url.pathname === '/local-pet/state') return send(res, 'application/json; charset=utf-8', JSON.stringify(snapshot()))
    const thumb = url.pathname.match(/^\/dsh-pet-7340\/thumb\/main\/(.+)$/)
    if (thumb) return send(res, 'video/webm', await readFile(join(WEBM, decodeURIComponent(thumb[1]))))
    res.writeHead(404).end('not found')
  } catch {
    res.writeHead(404).end('not found')
  }
}

function send (res, type, body) {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

/** 每次请求都按“现在”算时间戳，否则放着不动灯就全过期了。 */
function snapshot () {
  const now = Date.now()
  return {
    version: 1,
    self: {
      deviceId: 'self',
      nickname: '我',
      pet: { name: '蓝毛小女仆', anim: null },
      bridge: { ok: true, reason: null },
      out: null
    },
    neighbors: [
      { deviceId: 'n1', nickname: '隔壁的小鲸鱼', status: 'allowed', lastSeen: now, port: 45871 },
      { deviceId: 'n2', nickname: '楼下的柯基', status: 'allowed', lastSeen: now, port: 45871 },
      { deviceId: 'n3', nickname: '三楼的仓鼠', status: 'allowed', lastSeen: now, port: 45871 }
    ],
    guests: [
      { deviceId: 'n1', nickname: '隔壁的小鲸鱼', anim: null, since: now, expiresAt: now + 30000 },
      { deviceId: 'n2', nickname: '楼下的柯基', anim: null, since: now, expiresAt: now + 30000 }
    ],
    visitors: [
      { deviceId: 'n3', nickname: '三楼的仓鼠', anim: null, visitId: 'v1', since: now, endsAt: now + 60000 }
    ],
    visits: [
      { direction: 'out', nickname: '隔壁的小鲸鱼', startedAt: now - 3600e3, durationMs: 60000 },
      { direction: 'in', nickname: '楼下的柯基', startedAt: now - 7200e3, durationMs: 42000 }
    ],
    notices: [{ text: '「三楼的仓鼠」没有回应，等了一会儿，宠物先留在家里了。', at: now }],
    prompt: null,
    acceptVisits: true
  }
}

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>客厅预览</title>
<style>
  html,body{margin:0;height:100%;background:#f6f7f9;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  .fake-app{position:absolute;inset:0;padding:24px;color:#b9c0ca;font-size:13px}
  .fake-app h1{font-size:15px;color:#6b7480;font-weight:600}
  .fake-app p{max-width:420px;line-height:1.6}
</style></head>
<body>
<div class="fake-app"><h1>DSH 主界面（占位）</h1>
<p>客厅浮在右下角，不挡这块区域。这张预览用真的 client.js、真的 React、真的 dsh-pet 素材，
只把宿主快照换成了假数据。</p></div>
<div id="root"></div>
<script src="./react.js"></script>
<script src="./react-dom.js"></script>
<script>window.__ModuleLoader__ = { load (options) { window.__plugin = options } }</script>
<script src="./client.js"></script>
<script>
  const plugin = window.__plugin.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  let Room = null
  plugin.apply({ slots: {
    inject (key, factory) { for (const registration of factory()) Room = registration },
    register (options, component) { return component }
  } })
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Room))
</script>
</body></html>`

async function ensureCache () {
  await mkdir(CACHE, { recursive: true })
  for (const asset of [REACT, REACT_DOM]) {
    const path = join(CACHE, asset.name)
    if (existsSync(path)) continue
    console.log('[预览] 第一次运行，下载 ' + asset.name + ' …')
    const res = await fetch(asset.url)
    if (!res.ok) throw new Error('下载失败：' + asset.url + ' → ' + res.status)
    const body = Buffer.from(await res.arrayBuffer())
    await writeFile(path, body)
    console.log('[预览] 已缓存 ' + asset.name + ' (' + Math.round(body.length / 1024) + ' KB, sha ' + createHash('sha256').update(body).digest('hex').slice(0, 8) + ')')
  }
}

function screenshot (url, out) {
  return new Promise((resolveShot, rejectShot) => {
    execFile(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--incognito',
      '--window-size=1200,800', '--virtual-time-budget=6000',
      '--screenshot=' + resolve(out), url
    ], (error) => {
      if (error) return rejectShot(error)
      console.log('[预览] 截图：' + resolve(out))
      resolveShot()
    })
  }).finally(() => {
    server.close()
    setTimeout(() => process.exit(0), 100)
  })
}

function argument (key) {
  const index = process.argv.indexOf('--' + key)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : true
}
