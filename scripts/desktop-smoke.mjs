#!/usr/bin/env node
/**
 * 桌面 helper 的真机冒烟（只在 macOS + 本机有 Electron 时有意义；不进 npm test）。
 *
 * 覆盖 ticket 07 + 08 的验收：
 *   1. 宠物真的画出来：截图模式用 capturePage() 抓 PNG + 同名 .json，zlib 自己解 PNG，
 *      断言背景透明、每只宠物的媒体区/昵称条有像素、素材走 dshzoo://（source=video）；
 *   2. 点击穿透：渲染端悬停路径、主进程兜底（forward 失效）、主进程否决（光标真在外面）、
 *      渲染端冻结后 fail-closed；
 *   3. 输入租约：拖拽时把光标移到宠物矩形外，窗口仍保持可交互；pointerup 后立刻交还穿透；
 *      busy 心跳冻结后超过 BUSY_LEASE_MS 自动释放；
 *   4. 物理：渲染端 60fps 跑重力/反弹/边缘夹取，逐帧上报的矩形与主进程命中判定一致；
 *      拖拽跟手、松手有速度、几秒后速度衰减且不出界；
 *   5. 场景 v2：宿主删/加宠物、改动作，渲染端跟着增删，reset 会重新出生；
 *   6. 生命周期：quit / 崩溃重启 / dispose / 宿主被 SIGKILL 都不留进程。
 *
 * 断言约定：**等状态，不等事件**。helper 的 `hit` 只在点击穿透真的翻转时发一条
 * （desktop/main.js 的 setIgnore() 状态没变就直接 return），所以先落定、后挪光标的场合不会
 * 再有新事件——这类地方用 expectIgnoring()（事件优先、状态兜底），只等事件会假超时。
 *
 * Windows 上多一段真实左键（ticket 30）：scripts/win32-sendinput.ps1，真 SendInput + DPI 感知，
 * 会真的移动光标约 2 秒；那一段只在 process.platform === 'win32' 时跑。
 *
 * 抓图是这台机器上唯一能看到窗口的办法（没有屏幕录制权限）。设
 *   DSH_ZOO_SMOKE_NOTES=1 npm run smoke:desktop
 * 会把整窗（棋盘格合成）和宠物特写写进 .scratch/dsh-zoo/notes/。
 *
 * 只依赖 node:zlib，不装任何包。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

import shared from '../desktop/shared.js'
import { createDesktop, HELPER_MAIN } from '../src/desktop.js'
import { buildHelperArgs, helperEnv, resolveElectronBinary } from '../src/desktop-launch.js'
import { giftNotReceivedText, giftReceivedText } from '../src/gift-text.js'
import { resolveDshPetAssetDirs } from '../src/pet-assets.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT_DIR = join(tmpdir(), 'dsh-zoo-desktop-smoke-' + process.pid)
const NOTES_DIR = join(ROOT, '.scratch', 'dsh-zoo', 'notes')
/** ticket 25：礼物缩略图走 helper 的 dshzoo://gifts 根；冒烟自己造一个真目录 + 真 PNG。 */
const GIFTS_ROOT = join(OUT_DIR, 'gifts')
const GIFT_THUMB_DIR = '20261103-153245-ab12cd12'
const WRITE_NOTES = process.env.DSH_ZOO_SMOKE_NOTES === '1'
const ASSET_ROOTS = resolveDshPetAssetDirs({ env: process.env })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const spawned = []
let checks = 0

function pass (message) {
  checks += 1
  console.log('  ok  ' + message)
}

function info (message) {
  console.log('      ' + message)
}

async function run (name, fn) {
  console.log('\n# ' + name)
  const started = Date.now()
  const result = await fn()
  console.log('  (' + ((Date.now() - started) / 1000).toFixed(1) + 's)')
  return result
}

function assert (condition, message) {
  if (!condition) throw new Error('断言失败：' + message)
  pass(message)
}

// ---------------------------------------------------------------------------
// 极简 PNG 解码/编码（8-bit RGBA，非隔行）——为了不依赖任何 npm 包
// ---------------------------------------------------------------------------

function decodePng (buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('不是 PNG')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error('不支持的 PNG：bitDepth=' + bitDepth + ' colorType=' + colorType + ' interlace=' + interlace)
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(height * stride)
  let previous = Buffer.alloc(stride)
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]
    const line = raw.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride)
    const current = Buffer.alloc(stride)
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? current[index - channels] : 0
      const up = previous[index]
      const upperLeft = index >= channels ? previous[index - channels] : 0
      let value = line[index]
      if (filter === 1) value = (value + left) & 0xff
      else if (filter === 2) value = (value + up) & 0xff
      else if (filter === 3) value = (value + Math.floor((left + up) / 2)) & 0xff
      else if (filter === 4) {
        const p = left + up - upperLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upperLeft)
        const predictor = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upperLeft)
        value = (value + predictor) & 0xff
      } else if (filter !== 0) {
        throw new Error('未知 PNG filter ' + filter)
      }
      current[index] = value
    }
    current.copy(out, row * stride)
    previous = current
  }
  if (channels === 3) {
    const rgba = Buffer.alloc(width * height * 4)
    for (let index = 0; index < width * height; index += 1) {
      rgba[index * 4] = out[index * 3]
      rgba[index * 4 + 1] = out[index * 3 + 1]
      rgba[index * 4 + 2] = out[index * 3 + 2]
      rgba[index * 4 + 3] = 255
    }
    return { width, height, channels: 4, data: rgba }
  }
  return { width, height, channels: 4, data: out }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32 (buffer) {
  let c = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) c = CRC_TABLE[(c ^ buffer[index]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk (type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

function encodePng (image) {
  const { width, height, data } = image
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0
    data.copy(raw, row * (stride + 1) + 1, row * stride, row * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function pixelAt (image, x, y) {
  const index = (y * image.width + x) * 4
  return [image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3]]
}

function countOpaque (image, left, top, right, bottom, threshold = 0) {
  let count = 0
  const x0 = Math.max(0, Math.floor(left))
  const y0 = Math.max(0, Math.floor(top))
  const x1 = Math.min(image.width, Math.ceil(right))
  const y1 = Math.min(image.height, Math.ceil(bottom))
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] > threshold) count += 1
    }
  }
  return count
}

function countTransparent (image) {
  let transparent = 0
  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index] === 0) transparent += 1
  }
  return transparent
}

/** 棋盘格合成：让透明度在一张不透明的 PNG 里肉眼可辨。 */
function compositeOverCheckerboard (image, square = 64) {
  const out = Buffer.alloc(image.width * image.height * 4)
  const light = [237, 242, 248]
  const dark = [198, 208, 220]
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4
      const alpha = image.data[index + 3] / 255
      const background = (Math.floor(x / square) + Math.floor(y / square)) % 2 === 0 ? light : dark
      out[index] = Math.round(image.data[index] * alpha + background[0] * (1 - alpha))
      out[index + 1] = Math.round(image.data[index + 1] * alpha + background[1] * (1 - alpha))
      out[index + 2] = Math.round(image.data[index + 2] * alpha + background[2] * (1 - alpha))
      out[index + 3] = 255
    }
  }
  return { width: image.width, height: image.height, channels: 4, data: out }
}

/** 2×2/4×4 盒式降采样（先合成到不透明背景，避免透明像素被平均成灰边）。 */
function downscale (image, factor) {
  const width = Math.max(1, Math.floor(image.width / factor))
  const height = Math.max(1, Math.floor(image.height / factor))
  const out = Buffer.alloc(width * height * 4)
  const area = factor * factor
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = Math.min(image.width - 1, x * factor + dx)
          const sy = Math.min(image.height - 1, y * factor + dy)
          const index = (sy * image.width + sx) * 4
          r += image.data[index]
          g += image.data[index + 1]
          b += image.data[index + 2]
          a += image.data[index + 3]
        }
      }
      const index = (y * width + x) * 4
      out[index] = Math.round(r / area)
      out[index + 1] = Math.round(g / area)
      out[index + 2] = Math.round(b / area)
      out[index + 3] = Math.round(a / area)
    }
  }
  return { width, height, channels: 4, data: out }
}

function cropImage (image, left, top, width, height) {
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    image.data.copy(out, y * width * 4, ((top + y) * image.width + left) * 4, ((top + y) * image.width + left + width) * 4)
  }
  return { width, height, channels: 4, data: out }
}

// ---------------------------------------------------------------------------
// 截图断言
// ---------------------------------------------------------------------------

function verifyShot (pngPath, sidecarPath, expectedPets, options = {}) {
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'))
  const image = decodePng(readFileSync(pngPath))
  const bounds = sidecar.bounds
  const scaleX = image.width / bounds.width
  const scaleY = image.height / bounds.height
  const toPixel = (localX, localY) => [Math.round(localX * scaleX), Math.round(localY * scaleY)]

  assert(scaleX === scaleY, '截图像素与逻辑坐标同尺度（scale=' + scaleX + '）')
  assert(image.width === Math.round(bounds.width * scaleX) && image.height === Math.round(bounds.height * scaleY),
    '截图尺寸 = 窗口 bounds × scale（' + image.width + '×' + image.height + '）')
  assert(sidecar.scene.version === 3, 'sidecar 里是场景 v3（带 menu）')
  const pets = sidecar.renderer !== null && Array.isArray(sidecar.renderer.pets)
    ? sidecar.renderer.pets
    : sidecar.scene.items
  assert(pets.length === expectedPets, 'sidecar 里有 ' + expectedPets + ' 只宠物（实际 ' + pets.length + '）')

  const corner = pixelAt(image, 2, 2)
  assert(corner[3] === 0, '窗口背景是透明的（左上角 alpha=0）')
  const transparent = countTransparent(image)
  // 透明比例的下限必须跟着场景走：街/放行卡/宠物在工作区里占的面积是固定的，屏幕越小占比越大
  // （1280×672 上光「街 + 放行卡」就 >10%）。固定 90% 在小屏上会误判成「画满了整屏」。
  let occupied = 0
  const uiRects = sidecar.renderer !== null && Array.isArray(sidecar.renderer.uiRects)
    ? sidecar.renderer.uiRects
    : []
  for (const r of uiRects) occupied += r.width * r.height
  for (const pet of pets) occupied += pet.width * pet.height
  const budget = Math.min(0.9, (occupied / (bounds.width * bounds.height)) * 1.6 + 0.04)
  const transparentFraction = transparent / (image.width * image.height)
  assert(transparentFraction > 1 - budget,
    '整张图 >' + Math.round((1 - budget) * 100) + '% 像素透明（' +
    (transparentFraction * 100).toFixed(2) + '%，占用预算 ' + Math.round(budget * 100) + '%）')

  for (const pet of pets) {
    assert(pet.x >= 0 && pet.y >= 0 &&
      pet.x + pet.width <= bounds.width + 0.5 && pet.y + pet.height <= bounds.height + 0.5,
    '宠物 ' + pet.id + ' 在工作区内')
    const [px, py] = toPixel(pet.x, pet.y)
    const mediaWidth = Math.round(pet.width * scaleX)
    const mediaHeight = Math.round(Math.min(pet.width, pet.height) * scaleY)
    const mediaPixels = countOpaque(image, px, py, px + mediaWidth, py + mediaHeight, 0)
    assert(mediaPixels > mediaWidth * mediaHeight * 0.003,
      '宠物 ' + pet.id + ' 的媒体区有可见像素（' + mediaPixels + '）')
    const namePixels = countOpaque(image, px, py + mediaHeight, px + mediaWidth, py + Math.round(pet.height * scaleY), 0)
    assert(namePixels > 80, '宠物 ' + pet.id + ' 的昵称条画出来了（' + namePixels + ' px）')
  }

  const videos = pets.filter((pet) => pet.source === 'video')
  const svgs = pets.filter((pet) => pet.source === 'svg')
  if (options.source === 'svg') {
    assert(svgs.length === pets.length, '没有素材时所有宠物都退到内置 SVG 色块')
  } else if (options.source === 'video' || ASSET_ROOTS.length > 0) {
    assert(videos.length === pets.length,
      '所有宠物都通过 dshzoo:// 加载了 dsh-pet WebM（' + videos.map((pet) => pet.clip).join(', ') + '）')
  } else {
    info('没有找到 dsh-pet 素材：宠物退到内置 SVG 色块')
    assert(svgs.length === pets.length, '没有素材时全部退到 SVG')
  }
  return { image, sidecar, pets, scaleX, scaleY, bounds }
}

function writeNoteScreenshots (verified) {
  if (!WRITE_NOTES) return null
  mkdirSync(NOTES_DIR, { recursive: true })
  const composite = compositeOverCheckerboard(verified.image)
  const full = downscale(composite, 4)
  const fullPath = join(NOTES_DIR, '08-desktop-pets-composited.png')
  writeFileSync(fullPath, encodePng(full))

  // 宠物特写：自己的那只 + 四周 110 逻辑 px，能看清素材和昵称。
  const focus = verified.pets.find((pet) => pet.role === 'self') ?? verified.pets[0]
  const margin = 110
  const left = focus.x
  const top = focus.y
  const px = Math.max(0, Math.floor((left - margin) * verified.scaleX))
  const py = Math.max(0, Math.floor((top - margin) * verified.scaleY))
  const pw = Math.min(composite.width - px, Math.ceil((focus.width + margin * 2) * verified.scaleX))
  const ph = Math.min(composite.height - py, Math.ceil((focus.height + margin * 2) * verified.scaleY))
  const crop = downscale(cropImage(composite, px, py, pw, ph), 2)
  const cropPath = join(NOTES_DIR, '08-desktop-pets-crop-composited.png')
  writeFileSync(cropPath, encodePng(crop))
  return { fullPath, cropPath }
}

// ---------------------------------------------------------------------------
// 控件截图（ticket 11）：弹层按钮 + 放行卡 + 失败气泡
// ---------------------------------------------------------------------------

function rectCenterScreen (rect, workArea) {
  return {
    x: Math.round(workArea.x + rect.x + rect.width / 2),
    y: Math.round(workArea.y + rect.y + rect.height / 2)
  }
}

function overlapsRect (a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * 两个矩形之间那个“缝”里的一点（窗口局部坐标），用于验证弹层的桥接矩形。
 * 弹层可能被摆在宠物的右/左/上/下，这里按最近的一条边算；重叠则返回 null。
 */
function gapPointBetween (a, b) {
  const mid = (start, end) => (start + end) / 2
  if (a.x + a.width <= b.x) {
    return {
      x: mid(a.x + a.width, b.x),
      y: mid(Math.max(a.y, b.y), Math.min(a.y + a.height, b.y + b.height))
    }
  }
  if (b.x + b.width <= a.x) {
    return {
      x: mid(b.x + b.width, a.x),
      y: mid(Math.max(a.y, b.y), Math.min(a.y + a.height, b.y + b.height))
    }
  }
  if (a.y + a.height <= b.y) {
    return {
      x: mid(Math.max(a.x, b.x), Math.min(a.x + a.width, b.x + b.width)),
      y: mid(a.y + a.height, b.y)
    }
  }
  if (b.y + b.height <= a.y) {
    return {
      x: mid(Math.max(a.x, b.x), Math.min(a.x + a.width, b.x + b.width)),
      y: mid(b.y + b.height, a.y)
    }
  }
  return null
}

/** 控件区域必须真的有像素：不是“DOM 里存在”而是画出来了。 */
function assertControlPixels (verified, rects) {
  for (const rect of rects) {
    const [px, py] = [
      Math.round(rect.x * verified.scaleX),
      Math.round(rect.y * verified.scaleY)
    ]
    const pw = Math.max(1, Math.round(rect.width * verified.scaleX))
    const ph = Math.max(1, Math.round(rect.height * verified.scaleY))
    const pixels = countOpaque(verified.image, px, py, px + pw, py + ph, 8)
    assert(pixels > pw * ph * 0.25,
      '控件 ' + rect.id + ' 在截图里有可见像素（' + pixels + '/' + (pw * ph) + '）')
  }
}

/** 气泡截图笔记（ticket 26）：按自己那只宠物的位置裁一圈，把贴在它边上的气泡一起框进来。 */
function writeNoticeNote (verified, fileName) {
  if (!WRITE_NOTES) return null
  mkdirSync(NOTES_DIR, { recursive: true })
  const composite = compositeOverCheckerboard(verified.image)
  const pet = verified.pets.find((candidate) => candidate.role === 'self') ?? verified.pets[0]
  // 气泡固定在自己宠物的上方/右侧，给足余量；宠物贴在窗口边缘时按窗口夹取。
  const margin = { left: 40, top: 300, right: 760, bottom: 60 }
  const px = Math.max(0, Math.floor((pet.x - margin.left) * verified.scaleX))
  const py = Math.max(0, Math.floor((pet.y - margin.top) * verified.scaleY))
  const pw = Math.min(composite.width - px, Math.ceil((pet.width + margin.left + margin.right) * verified.scaleX))
  const ph = Math.min(composite.height - py, Math.ceil((pet.height + margin.top + margin.bottom) * verified.scaleY))
  const path = join(NOTES_DIR, fileName)
  writeFileSync(path, encodePng(downscale(cropImage(composite, px, py, pw, ph), 2)))
  return path
}

/** 礼物卡截图笔记（ticket 25）：合成到棋盘格上，再按卡片矩形裁一圈，方便直接看。 */
function writeGiftNote (verified, rect, fileName) {
  if (!WRITE_NOTES) return null
  mkdirSync(NOTES_DIR, { recursive: true })
  const composite = compositeOverCheckerboard(verified.image)
  const margin = 28
  const px = Math.max(0, Math.floor((rect.x - margin) * verified.scaleX))
  const py = Math.max(0, Math.floor((rect.y - margin) * verified.scaleY))
  const pw = Math.min(composite.width - px, Math.ceil((rect.width + margin * 2) * verified.scaleX))
  const ph = Math.min(composite.height - py, Math.ceil((rect.height + margin * 2) * verified.scaleY))
  const path = join(NOTES_DIR, fileName)
  writeFileSync(path, encodePng(downscale(cropImage(composite, px, py, pw, ph), 2)))
  return path
}

function writeControlNotes (verified, noticeVerified) {
  if (!WRITE_NOTES) return null
  mkdirSync(NOTES_DIR, { recursive: true })
  const composite = compositeOverCheckerboard(verified.image)
  const fullPath = join(NOTES_DIR, '11-desktop-controls-composited.png')
  writeFileSync(fullPath, encodePng(downscale(composite, 4)))

  const ui = Array.isArray(verified.sidecar.renderer?.uiRects) ? verified.sidecar.renderer.uiRects : []
  const self = verified.pets.find((pet) => pet.role === 'self') ?? verified.pets[0]
  const boxes = [{ x: self.x, y: self.y, width: self.width, height: self.height }, ...ui]
  const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) - 70)
  const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - 90)
  const right = Math.min(verified.bounds.width, Math.max(...boxes.map((box) => box.x + box.width)) + 70)
  const bottom = Math.min(verified.bounds.height, Math.max(...boxes.map((box) => box.y + box.height)) + 60)
  const crop = downscale(cropImage(
    composite,
    Math.floor(left * verified.scaleX),
    Math.floor(top * verified.scaleY),
    Math.ceil((right - left) * verified.scaleX),
    Math.ceil((bottom - top) * verified.scaleY)
  ), 2)
  const cropPath = join(NOTES_DIR, '11-desktop-controls-crop-composited.png')
  writeFileSync(cropPath, encodePng(crop))

  let noticePath = null
  if (noticeVerified !== null && noticeVerified !== undefined) {
    const noticeComposite = compositeOverCheckerboard(noticeVerified.image)
    const noticeSelf = noticeVerified.pets.find((pet) => pet.role === 'self') ?? noticeVerified.pets[0]
    const nLeft = Math.max(0, Math.floor(noticeSelf.x - 160))
    const nTop = Math.max(0, Math.floor(noticeSelf.y - 220))
    const nRight = Math.min(noticeVerified.bounds.width, Math.ceil(noticeSelf.x + noticeSelf.width + 380))
    const nBottom = Math.min(noticeVerified.bounds.height, Math.ceil(noticeSelf.y + noticeSelf.height + 80))
    const nCrop = downscale(cropImage(
      noticeComposite,
      Math.floor(nLeft * noticeVerified.scaleX),
      Math.floor(nTop * noticeVerified.scaleY),
      Math.ceil((nRight - nLeft) * noticeVerified.scaleX),
      Math.ceil((nBottom - nTop) * noticeVerified.scaleY)
    ), 2)
    noticePath = join(NOTES_DIR, '11-desktop-controls-notice-composited.png')
    writeFileSync(noticePath, encodePng(nCrop))
  }
  return { fullPath, cropPath, noticePath }
}

// ---------------------------------------------------------------------------
// 直接 stdio 客户端
// ---------------------------------------------------------------------------

function createHelperClient (log, extraArgs = [], clientOptions = {}) {
  const resolved = resolveElectronBinary({})
  assert(resolved.ok, '找到 Electron：' + resolved.path)
  // 某些受限环境（容器、被沙箱化的 CI）里 Chromium 的沙箱起不来，helper 会直接崩。
  // 这是**冒烟专用**的逃生开关，不影响产品里的 helper：默认仍然带沙箱。
  const noSandbox = process.env.DSH_ZOO_SMOKE_NO_SANDBOX === '1' ? ['--no-sandbox'] : []
  const args = buildHelperArgs({
    helperPath: HELPER_MAIN,
    hostPid: process.pid,
    debug: true,
    assetRoots: clientOptions.withAssets === false ? [] : ASSET_ROOTS
  }).concat(noSandbox, extraArgs)
  const child = spawn(resolved.path, args, {
    cwd: ROOT,
    env: helperEnv(process.env, process.pid),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  spawned.push(child)
  const events = []
  const stderr = []
  const parser = shared.createLineParser()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    for (const entry of parser.push(chunk)) {
      if (entry.type === 'oversize') continue
      if (entry.type !== 'line' || entry.line.trim() === '') continue
      const parsed = shared.parseLine(entry.line)
      if (!parsed.ok) {
        log('非 JSON stdout：' + entry.line.slice(0, 200))
        continue
      }
      const normalized = shared.normalizeHelperEvent(parsed.value)
      if (!normalized.ok) {
        log('非法事件：' + normalized.error + ' ' + entry.line.slice(0, 200))
        continue
      }
      events.push(normalized.event)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    const line = String(chunk).trim()
    if (line !== '') {
      stderr.push(line)
      log('helper stderr: ' + line.slice(0, 240))
    }
  })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))

  const send = (command) => child.stdin.write(JSON.stringify(command) + '\n')
  const mark = () => events.length
  const waitFrom = async (start, predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (let index = start; index < events.length; index += 1) {
        if (predicate(events[index])) return events[index]
      }
      await sleep(25)
    }
    throw new Error('等待超时：' + label)
  }
  const status = async () => {
    const start = mark()
    send({ type: 'status', id: 'smoke-status-' + Date.now() })
    const event = await waitFrom(start, (candidate) => candidate.type === 'status', 3000, 'status')
    return event.status
  }
  const rendererState = async () => {
    const start = mark()
    send({ type: 'debug-renderer', id: 'smoke-renderer-' + Date.now() })
    const event = await waitFrom(start, (candidate) => candidate.type === 'renderer-state', 3000, 'renderer-state')
    return event.state
  }
  const waitStatus = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      last = await status()
      if (predicate(last)) return last
      await sleep(60)
    }
    throw new Error('等待状态超时：' + label + '（最后 ' + JSON.stringify(last) + '）')
  }
  return { child, events, send, mark, waitFrom, status, waitStatus, rendererState, exited, stderr }
}

function screenCenter (pet, workArea) {
  return {
    x: workArea.x + pet.x + pet.width / 2,
    y: workArea.y + pet.y + pet.height / 2
  }
}

function hitMatchesPet (hit, pet, workArea, tolerance = 2) {
  if (hit.rect === null) return false
  return Math.abs(hit.rect.x - (workArea.x + pet.x)) <= tolerance &&
    Math.abs(hit.rect.y - (workArea.y + pet.y)) <= tolerance &&
    Math.abs(hit.rect.width - pet.width) <= tolerance &&
    Math.abs(hit.rect.height - pet.height) <= tolerance
}

async function leavePointer (client, point) {
  // 让渲染端也看见光标离开（合成 pointermove；不依赖 hit 事件——本来就穿透时不会发）。
  client.send({ type: 'debug-dispatch', phase: 'move', x: point.x, y: point.y })
  client.send({ type: 'pointer', x: point.x, y: point.y })
  return client.waitStatus((status) => status.ignoring === true, 2500, '恢复穿透')
}

/**
 * 把主进程光标挪到 point，等「窗口是否可交互」落到 expected。
 *
 * 为什么不只等 hit 事件：desktop/main.js 的 emitHit 只在 ignoring **真的翻转**时发一条
 * （setIgnore 看到状态没变就直接 return）。pointerup 之后主进程可能已经因为「光标下没有活矩形」
 * 翻转成穿透了，这时再挪光标不会有新事件——只等事件就会假超时。0.4.2 现场那次
 * 「等待超时：拖拽结束交还穿透」重跑即通过，就是这个竞态，不是产品缺陷。
 *
 * 事件能到就优先用事件（保留 reason 证据），到不了就退回状态断言（穿透状态本身就是事实）。
 */
async function expectIgnoring (client, point, expected, timeoutMs, label) {
  const start = client.mark()
  client.send({ type: 'pointer', x: point.x, y: point.y })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (let index = start; index < client.events.length; index += 1) {
      const event = client.events[index]
      if (event.type === 'hit' && event.interactive === expected) return { via: 'hit', event }
    }
    const status = await client.status()
    if (status.ignoring !== expected) return { via: 'status', status }
    await sleep(25)
  }
  throw new Error('等待超时：' + label)
}

// ---------------------------------------------------------------------------
// 1) 截图模式：自己画三只演示宠物，抓图后退出
// ---------------------------------------------------------------------------

async function verifyShotMode () {
  const pngPath = join(OUT_DIR, 'standalone.png')
  const client = createHelperClient((line) => info(line), [
    '--dsh-zoo-shot', pngPath,
    '--dsh-zoo-shot-delay', '1200'
  ])
  const exit = await Promise.race([client.exited, sleep(20000).then(() => null)])
  assert(exit !== null, '截图模式在 20s 内自己退出')
  assert(exit.code === 0 || exit.code === null, '截图模式退出码正常（' + JSON.stringify(exit) + '）')
  assert(existsSync(pngPath), 'shot 落盘：' + pngPath)
  assert(existsSync(pngPath + '.json'), 'shot sidecar 落盘：' + pngPath + '.json')
  const verified = verifyShot(pngPath, pngPath + '.json', 3, { source: ASSET_ROOTS.length > 0 ? 'video' : 'svg' })
  info('截图：' + pngPath + '（' + verified.image.width + '×' + verified.image.height + '）')
  if (ASSET_ROOTS.length > 0) info('素材根：' + ASSET_ROOTS.join(' | '))
  return { pngPath, sidecarPath: pngPath + '.json', verified }
}

async function verifySvgFallback () {
  const pngPath = join(OUT_DIR, 'no-assets.png')
  const client = createHelperClient((line) => info(line), [
    '--dsh-zoo-shot', pngPath,
    '--dsh-zoo-shot-delay', '200'
  ], { withAssets: false })
  const exit = await Promise.race([client.exited, sleep(20000).then(() => null)])
  assert(exit !== null, '无素材的截图模式也在 20s 内退出')
  assert(exit.code === 0 || exit.code === null, '无素材的截图模式退出码正常（' + JSON.stringify(exit) + '）')
  assert(existsSync(pngPath), '无素材 shot 落盘：' + pngPath)
  const verified = verifyShot(pngPath, pngPath + '.json', 3, { source: 'svg' })
  info('无素材降级截图：' + pngPath)
  return verified
}

// ---------------------------------------------------------------------------
// 2) 控件（ticket 11）：hover → 弹层 → 租约 → 按钮申请 → 失败气泡 → 放行卡 → 送客/召回
// ---------------------------------------------------------------------------

async function verifyControls () {
  const client = createHelperClient((line) => info(line))
  const readyMark = client.mark()
  const ready = await client.waitFrom(readyMark, (event) => event.type === 'ready', 15000, 'ready')
  const workArea = ready.workArea
  const visitorId = '33333333-3333-4333-8333-333333333333'
  const promptId = '44444444-4444-4444-8444-444444444444'
  const outside = { x: workArea.x + 8, y: workArea.y + 8 }

  // 冒烟只走合成输入：真实鼠标/焦点事件不能干扰租约用例。
  client.send({ type: 'debug-lock-input', locked: true })
  await sleep(150)

  const scene = shared.petScene([
    { id: 'self', role: 'self', label: '小蓝', anim: '东张西望', color: shared.PET_COLORS[0] },
    { id: 'visitor:' + visitorId, role: 'visitor', label: '阿蟹', anim: '螃蟹走路', color: shared.PET_COLORS[1] },
    { id: 'guest:demo', role: 'guest', label: '泡泡', anim: '原地小憩沉眠', color: shared.PET_COLORS[2] }
  ], workArea, {
    reset: true,
    controls: {
      visit: { enabled: true, reason: null },
      recall: { enabled: false, nickname: null },
      visitors: [{ deviceId: visitorId, label: '阿蟹' }],
      // 那条小街（ticket 21）：一户能去，一户刚掉线。
      street: [
        { deviceId: visitorId, label: '阿蟹', action: '在改那个 bug', canVisit: true, blockedReason: null },
        { deviceId: promptId, label: '泡泡', action: null, canVisit: false, blockedReason: 'peer-offline' }
      ],
      prompt: { deviceId: promptId, nickname: '泡泡' },
      notice: null
    }
  })
  client.send({ type: 'update', scene })
  await sleep(1800)

  let state = await client.rendererState()
  assert(state !== null && state.pets.length === 3, '控件场景里有 3 只宠物')
  assert(state.controls.prompt !== null && state.controls.prompt.nickname === '泡泡',
    '场景里的 prompt → 放行卡出现')
  assert(state.controls.popover === null, '没有悬停时弹层是关着的')
  let current = await client.status()
  assert(current.overlayRects >= 3, '放行卡的命中矩形已经单独上报（' + current.overlayRects + ' 块）')

  // 悬停自己的宠物：弹层出现，但**不拿输入租约**（A2：整窗不能被一个弹层按 12 秒）。
  let self = state.pets.find((pet) => pet.id === 'self')
  let center = screenCenter(self, workArea)
  let start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'move', x: center.x, y: center.y })
  const hoverHit = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '悬停自己')
  assert(hoverHit.itemId === 'self', '悬停命中自己的宠物')
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.controls.popover !== null
  }, 2500, '悬停后弹层出现')
  current = await client.status()
  assert(current.busy === false, '弹层不持有输入租约（A2）')
  assert(current.ignoring === false, '弹层打开时窗口可交互（靠命中矩形，不靠租约）')
  assert(current.overlayRects >= 6, '弹层+按钮+卡片都有独立命中矩形（' + current.overlayRects + ' 块）')

  state = await client.rendererState()
  const selfRect = { x: self.x, y: self.y, width: self.width, height: self.height }
  const popoverRect = state.uiRects.find((rect) => rect.id === 'ui:popover')
  const bridgeRect = state.uiRects.find((rect) => rect.id === 'ui:bridge:popover')
  const promptRect = state.uiRects.find((rect) => rect.id === 'ui:prompt')
  const visitButton = state.uiRects.find((rect) => rect.id === 'ui:btn:open-street')
  assert(Boolean(popoverRect), '弹层有命中矩形')
  assert(Boolean(bridgeRect), '宠物与弹层之间有桥接矩形（不靠租约也能跨过间隙）')
  assert(Boolean(promptRect), '放行卡有命中矩形')
  assert(Boolean(visitButton), '「串门」按钮有命中矩形')
  assert(!overlapsRect(popoverRect, selfRect), '弹层不遮挡宠物本体')
  assert(!overlapsRect(promptRect, selfRect), '放行卡不遮挡宠物本体')

  // 桥接矩形真的盖住了宠物与弹层之间的那几像素（纯几何，不动光标）。
  const gapPoint = gapPointBetween(selfRect, popoverRect)
  assert(gapPoint !== null, '能找到宠物与弹层之间的空隙')
  assert(shared.hitTestRects([bridgeRect], gapPoint) !== null, '桥接矩形覆盖宠物与弹层之间的空隙')
  assert(shared.hitTestRects([selfRect, popoverRect], gapPoint) === null, '这个点确实既不在宠物上也不在弹层上')

  // A2 的验收条件：弹层开着、光标既不在宠物上也不在弹层上 → 整个窗口必须恢复穿透。
  // 这里只动主进程光标（渲染端仍以为光标在宠物上），穿透只能来自“真实光标不在命中区”。
  start = client.mark()
  client.send({ type: 'pointer', x: outside.x, y: outside.y })
  const cleared = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === false, 3000, '弹层开着也恢复穿透')
  assert(cleared.reason === 'outside', '恢复穿透是因为真实光标不在命中区（reason=' + cleared.reason + '）')
  assert((await client.status()).busy === false, '穿透时也没有残留租约')
  state = await client.rendererState()
  assert(state.controls.popover !== null, '穿透不是“关掉弹层”：弹层仍然开着')

  // 光标移进宠物与弹层之间的缝隙：桥接矩形接管鼠标（不需要租约）。
  start = client.mark()
  client.send({ type: 'pointer', x: workArea.x + gapPoint.x, y: workArea.y + gapPoint.y })
  const gapHit = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '间隙命中')
  assert(['ui:bridge:popover', 'ui:popover'].includes(gapHit.itemId),
    '光标在间隙里时窗口接管鼠标（不靠租约，itemId=' + gapHit.itemId + '）')

  // 光标从缝隙回到宠物上：一直可交互（没有状态翻转，所以不会有新的 hit 事件）。
  client.send({ type: 'pointer', x: center.x, y: center.y })
  await sleep(150)
  assert((await client.status()).ignoring === false, '光标回到宠物上仍然可交互，弹层可以继续用')

  // 截图：弹层按钮 + 放行卡同框。
  mkdirSync(OUT_DIR, { recursive: true })
  const pngPath = join(OUT_DIR, 'controls.png')
  start = client.mark()
  client.send({ type: 'shot', id: 'shot-controls', path: pngPath })
  const shot = await client.waitFrom(start, (event) => event.type === 'shot' && event.id === 'shot-controls', 8000, '控件截图')
  assert(shot.width > 0 && existsSync(pngPath), '控件截图落盘：' + pngPath)
  const verified = verifyShot(pngPath, pngPath + '.json', 3)
  assertControlPixels(verified, [popoverRect, promptRect, visitButton])
  const sidecarUi = verified.sidecar.renderer?.uiRects ?? []
  assert(sidecarUi.some((rect) => rect.id === 'ui:btn:open-street'), '截图 sidecar 记录了按钮矩形')

  // 点「串门」：先弹出那条街，而不是替用户随机挑一位（ticket 21）。
  const visitPoint = rectCenterScreen(visitButton, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'click', x: visitPoint.x, y: visitPoint.y })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.uiRects.some((rect) => rect.id === 'ui:street')
  }, 3000, '邻居面板弹出')
  state = await client.rendererState()
  assert(state.controls.popover === null, '点「串门」后弹层收起，换成那条街')
  assert(state.controls.street.length === 2, '街上有两户（' + state.controls.street.length + '）')

  // 面板截图：这条街得真的被画出来，不是一片背景。
  const streetPng = join(OUT_DIR, 'street.png')
  start = client.mark()
  client.send({ type: 'shot', id: 'shot-street', path: streetPng })
  await client.waitFrom(start, (event) => event.type === 'shot' && event.id === 'shot-street', 8000, '邻居面板截图')
  const streetVerified = verifyShot(streetPng, streetPng + '.json', 3)
  const streetRect = state.uiRects.find((rect) => rect.id === 'ui:street')
  assert(Boolean(streetRect), '邻居面板有命中矩形')
  assertControlPixels(streetVerified, [streetRect])
  info('邻居面板截图：' + streetPng)

  // 点能去的那一户：请求带的就是这一户的 deviceId。
  const houseRect = state.uiRects.find((rect) => rect.id === 'ui:street:visit:' + visitorId)
  assert(Boolean(houseRect), '能去的那一户在面板里有自己的命中矩形')
  const housePoint = rectCenterScreen(houseRect, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'click', x: housePoint.x, y: housePoint.y })
  const action = await client.waitFrom(start, (event) => event.type === 'action', 3000, '串门申请')
  assert(action.action === 'visit', '点某一户 → 宿主收到 action=visit')
  assert(typeof action.id === 'string' && action.id !== '', 'action 带 id，宿主才能对上是哪一次点击')
  assert(action.deviceId === visitorId, '带的是这一户的 deviceId（' + action.deviceId + '）')

  // 失败必须冒泡：宿主回 ok:false + notice，渲染端在宠物旁边显示几秒。
  client.send({
    type: 'action-result',
    id: action.id,
    ok: false,
    notice: '还没有人放行你，宠物出不了门。'
  })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.controls.notice !== null && /还没有人放行你/.test(snapshot.controls.notice.text)
  }, 2500, '失败气泡出现')
  state = await client.rendererState()
  assert(state.controls.popover === null, '点完动作弹层关闭')
  assert(state.controls.streetOpen === false, '点完动作那条街也收起来')
  await waitUntil(async () => {
    const status = await client.status()
    return status.busy === false
  }, 2500, '点完动作后没有残留租约')

  // 保留一张失败气泡的截图（和放行卡同框，证明“不静默”）。
  const noticePng = join(OUT_DIR, 'controls-notice.png')
  start = client.mark()
  client.send({ type: 'shot', id: 'shot-notice', path: noticePng })
  await client.waitFrom(start, (event) => event.type === 'shot' && event.id === 'shot-notice', 8000, '失败气泡截图')
  const noticeVerified = verifyShot(noticePng, noticePng + '.json', 3)

  // 气泡在几秒后自己消失。
  await sleep(4600)
  state = await client.rendererState()
  assert(state.controls.notice === null, '失败气泡几秒后自动消失（不会永久糊在桌面上）')

  // 把两个光标都移开 → 恢复穿透；这是“控件关闭必须交还桌面”的底线。
  client.send({ type: 'pointer', x: outside.x, y: outside.y })
  client.send({ type: 'debug-dispatch', phase: 'move', x: outside.x, y: outside.y })
  await client.waitStatus((status) => status.ignoring === true, 3000, '关闭控件后恢复穿透')
  assert((await client.status()).busy === false, '关闭控件后没有残留租约')

  // 放行卡是常驻控件、不持有租约：只把主进程光标放到卡片上，也必须能接管鼠标。
  // 渲染端此刻完全没消息（光标在空白处），走的是 overlay 矩形 + 300ms 主进程兜底。
  state = await client.rendererState()
  const cardRect = state.uiRects.find((rect) => rect.id === 'ui:prompt')
  assert(Boolean(cardRect), '放行卡仍然可见（还没决定）')
  const cardPoint = rectCenterScreen(cardRect, workArea)
  start = client.mark()
  client.send({ type: 'pointer', x: cardPoint.x, y: cardPoint.y })
  const cardHit = await client.waitFrom(start,
    (event) => event.type === 'hit' && event.interactive === true, 3000, '放行卡命中')
  assert(cardHit.itemId === 'ui:prompt', '放行卡自身的矩形让窗口接管鼠标（itemId=' + cardHit.itemId + '）')
  assert((await client.status()).ignoring === false, '光标压在放行卡上时可交互（不靠租约）')
  start = client.mark()
  client.send({ type: 'pointer', x: outside.x, y: outside.y })
  await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === false, 3000, '离开放行卡恢复穿透')

  // 拖拽租约的 fail-closed：冻结 busy 续期后，主进程必须按 BUSY_LEASE_MS 收回。
  // （弹层不再持有租约，这条路径现在由拖拽负责——它也确实是唯一需要租约的地方。）
  state = await client.rendererState()
  self = state.pets.find((pet) => pet.id === 'self')
  center = screenCenter(self, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'move', x: center.x, y: center.y })
  await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '泄漏前悬停')
  client.send({ type: 'debug-dispatch', phase: 'down', x: center.x, y: center.y })
  await client.waitStatus((status) => status.busy === true, 2000, '再次持有租约')
  client.send({ type: 'pointer', x: outside.x, y: outside.y })
  client.send({ type: 'debug-freeze-busy', frozen: true })
  current = await client.waitStatus((status) => status.busy === false, shared.BUSY_LEASE_MS + 2500, '泄漏租约 fail-closed')
  assert(current.ignoring === true, '主进程按 BUSY_LEASE_MS 收回泄漏租约并恢复穿透')
  state = await client.rendererState()
  assert(state.dragging === 'self', '此时渲染端仍然在拖拽：桌面靠主进程收回租约恢复穿透')
  client.send({ type: 'debug-freeze-busy', frozen: false })
  client.send({ type: 'debug-dispatch', phase: 'up', x: outside.x, y: outside.y })
  await client.waitStatus((status) => status.busy === false && status.ignoring === true, 3500, '松开后回到穿透')
  assert((await client.rendererState()).dragging === null, '渲染端也收手了')

  // 硬上限：渲染端活着、心跳也一直在续，但一条租约连续持有超过 BUSY_MAX_MS 必须收回。
  // 用调试命令把 30s 缩短到 700ms；收回后 blocked 是粘滞的，悬停不能复活，只认 busy:false。
  state = await client.rendererState()
  self = state.pets.find((pet) => pet.id === 'self')
  center = screenCenter(self, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'move', x: center.x, y: center.y })
  await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '硬上限前悬停')
  client.send({ type: 'debug-dispatch', phase: 'down', x: center.x, y: center.y })
  await client.waitStatus((status) => status.busy === true, 2000, '硬上限前持有租约')
  client.send({ type: 'pointer', x: outside.x, y: outside.y })
  client.send({ type: 'debug-busy-max', ms: 700 })
  current = await client.waitStatus((status) => status.busyBlocked === true, 4000, '硬上限收回租约')
  assert(current.busy === false && current.ignoring === true,
    '租约连续持有超过硬上限 → 主进程收回并标记 blocked（busy=false, blocked=true）')
  state = await client.rendererState()
  assert(state.dragging === 'self', '硬上限收回时渲染端仍在拖拽：窗口仍恢复穿透')
  client.send({ type: 'debug-dispatch', phase: 'up', x: outside.x, y: outside.y })
  await client.waitStatus((status) => status.busyBlocked === false && status.ignoring === true, 3500,
    '显式放手清除 blocked')
  client.send({ type: 'debug-busy-max', ms: 0 })

  // 点击客人 → 弹层（送客）。
  state = await client.rendererState()
  const visitor = state.pets.find((pet) => pet.id === 'visitor:' + visitorId)
  const visitorPoint = screenCenter(visitor, workArea)
  client.send({ type: 'debug-dispatch', phase: 'click', x: visitorPoint.x, y: visitorPoint.y })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.controls.popover !== null && snapshot.controls.popover.petId === visitor.id
  }, 2500, '点击客人出现送客弹层')
  state = await client.rendererState()
  const sendButton = state.uiRects.find((rect) => rect.id === 'ui:btn:end-visit')
  assert(Boolean(sendButton), '「送客」按钮有命中矩形')
  const sendPoint = rectCenterScreen(sendButton, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'click', x: sendPoint.x, y: sendPoint.y })
  const sendAction = await client.waitFrom(start, (event) => event.type === 'action' && event.action === 'end-visit', 3000, '送客申请')
  assert(sendAction.deviceId === visitorId, '送客申请带上访客的 deviceId')
  client.send({ type: 'action-result', id: sendAction.id, ok: true })

  // 放行卡：接受 → action=admit，成功后卡片收起。
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.controls.prompt !== null
  }, 2000, '放行卡仍在')
  state = await client.rendererState()
  const admitButton = state.uiRects.find((rect) => rect.id === 'ui:btn:admit')
  assert(Boolean(admitButton), '「接受」按钮有命中矩形')
  const admitPoint = rectCenterScreen(admitButton, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'click', x: admitPoint.x, y: admitPoint.y })
  const admitAction = await client.waitFrom(start, (event) => event.type === 'action' && event.action === 'admit', 3000, '接受申请')
  assert(admitAction.deviceId === promptId, '接受申请带上放行卡的 deviceId')
  client.send({ type: 'action-result', id: admitAction.id, ok: true })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.controls.prompt === null
  }, 2500, '接受后放行卡收起')

  // 置灰的「串门」：必须有可读理由；点它只冒泡，不发 action（不静默、也不假装成功）。
  const disabledScene = {
    ...scene,
    reset: false,
    controls: {
      ...scene.controls,
      visit: { enabled: false, reason: '还没有人放行你，宠物出不了门。' }
    }
  }
  client.send({ type: 'update', scene: disabledScene })
  await sleep(300)
  state = await client.rendererState()
  self = state.pets.find((pet) => pet.id === 'self')
  center = screenCenter(self, workArea)
  client.send({ type: 'debug-dispatch', phase: 'move', x: center.x, y: center.y })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.controls.popover !== null && snapshot.controls.popover.disabled.includes('open-street')
  }, 2500, '置灰的串门按钮')
  state = await client.rendererState()
  const disabledButton = state.uiRects.find((rect) => rect.id === 'ui:btn:open-street')
  const actionsBefore = client.events.filter((event) => event.type === 'action').length
  const disabledPoint = rectCenterScreen(disabledButton, workArea)
  client.send({ type: 'debug-dispatch', phase: 'click', x: disabledPoint.x, y: disabledPoint.y })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.controls.notice !== null && /还没有人放行你/.test(snapshot.controls.notice.text)
  }, 2500, '点置灰按钮也有一句理由')
  assert(client.events.filter((event) => event.type === 'action').length === actionsBefore,
    '置灰按钮点击不会发 action（宿主不会收到一次假申请）')
  client.send({ type: 'debug-dispatch', phase: 'move', x: outside.x, y: outside.y })
  await client.waitStatus((status) => status.busy === false, 3000, '关掉置灰弹层并释放租约')

  // 改名（ticket 13）：弹层里的「改名」→ 主进程开一扇可聚焦的小窗；主窗约定一个字不动。
  client.send({ type: 'debug-dispatch', phase: 'move', x: center.x, y: center.y })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.controls.popover !== null
  }, 2500, '改名入口出现')
  state = await client.rendererState()
  const renameButton = state.uiRects.find((rect) => rect.id === 'ui:btn:rename')
  assert(Boolean(renameButton), '「改名」按钮有命中矩形')
  const renamePoint = rectCenterScreen(renameButton, workArea)
  client.send({ type: 'debug-dispatch', phase: 'click', x: renamePoint.x, y: renamePoint.y })
  current = await client.waitStatus((status) => status.renameOpen === true, 4000, '改名小窗打开')
  // 开着 ≠ 看得见：透明窗只建不显（ready-to-show 没到、层级被压住）时，用户看到的就是「点了没反应」。
  current = await client.waitStatus((status) => status.renameVisible === true, 4000, '改名小窗真的显示出来')
  assert(current.renameFocused === true, '改名小窗拿到焦点（要能直接打字）')
  assert(current.focusable === false, '改名小窗开着时，主窗仍然不可聚焦')
  // 现场回归：macOS 上打中文时输入法候选窗会抢走键盘焦点，改名小窗跟着消失。
  // 失焦不能成为关窗条件；Esc / 取消 / 保存才是。
  client.send({ type: 'debug-blur', window: 'rename' })
  await sleep(450)
  current = await client.status()
  assert(current.renameOpen === true, '失焦不关改名小窗（输入法候选窗会触发 blur）')
  client.send({ type: 'debug-rename', close: true })
  current = await client.waitStatus((status) => status.renameOpen === false, 4000, '改名小窗关闭')
  assert(current.renameVisible === false, '关掉之后小窗不可见')
  assert(current.focusable === false, '关掉小窗后主窗的焦点约定不变')
  client.send({ type: 'debug-dispatch', phase: 'move', x: outside.x, y: outside.y })
  await client.waitStatus((status) => status.busy === false, 3000, '改名后弹层收好、没有残留租约')

  // 自己出门：桌面没有 self → 常驻「召回」胶囊（否则召回按钮没有锚点）。
  const awayScene = shared.petScene([
    { id: 'visitor:' + visitorId, role: 'visitor', label: '阿蟹', anim: '螃蟹走路', color: shared.PET_COLORS[1] }
  ], workArea, {
    reset: true,
    controls: {
      visit: { enabled: false, reason: '宠物在「阿蟹」家，先召回再串门。' },
      recall: { enabled: true, nickname: '阿蟹' },
      visitors: [{ deviceId: visitorId, label: '阿蟹' }],
      prompt: null,
      notice: null
    }
  })
  client.send({ type: 'update', scene: awayScene })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.controls.recallChip !== null
  }, 2500, '出门后出现召回胶囊')
  state = await client.rendererState()
  const chip = state.uiRects.find((rect) => rect.id === 'ui:recall-chip')
  assert(Boolean(chip), '召回胶囊有命中矩形（没有 self 时也能点）')
  const chipPoint = rectCenterScreen(chip, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'click', x: chipPoint.x, y: chipPoint.y })
  const recallAction = await client.waitFrom(start, (event) => event.type === 'action' && event.action === 'recall', 3000, '召回申请')
  assert(typeof recallAction.id === 'string' && recallAction.id !== '', '召回申请带 id')
  client.send({ type: 'action-result', id: recallAction.id, ok: true })

  // 收尾：quit 自己退出。
  const exitPromise = client.exited
  client.send({ type: 'quit' })
  const exit = await Promise.race([exitPromise, sleep(4000).then(() => null)])
  assert(exit !== null, '控件用例结束后 helper 自己退出')
  assert(exit.code === 0 || exit.code === null, '控件用例退出码正常（' + JSON.stringify(exit) + '）')

  return { pngPath, sidecarPath: pngPath + '.json', verified, noticeVerified }
}

// ---------------------------------------------------------------------------
// 2) 交互模式：点击穿透 / 输入租约 / 物理 / 场景对账 / 截图
// ---------------------------------------------------------------------------

async function verifyHelper () {
  const client = createHelperClient((line) => info(line))
  const readyMark = client.mark()
  const ready = await client.waitFrom(readyMark, (event) => event.type === 'ready', 15000, 'ready')
  assert(ready.pid === client.child.pid, 'ready.pid 就是 helper 进程（' + ready.pid + '）')
  assert(ready.workArea.width > 0 && ready.workArea.height > 0,
    'ready 上报主屏工作区 ' + ready.workArea.width + '×' + ready.workArea.height)
  assert(Array.isArray(ready.displays) && ready.displays.length >= 1, 'ready 上报显示器列表')
  assert(ready.debug === true && ready.shotMode === false, 'debug 模式已生效')
  const workArea = ready.workArea

  // 场景来之前先看默认态：窗口只在有宠物/卡片时才可能接管鼠标。
  let current = await client.status()
  assert(current.sceneItems === 0 && current.ignoring === true,
    '窗口默认点击穿透（ignoring=true，场景为空）')

  const scene = shared.demoPetScene(workArea)
  client.send({ type: 'update', scene })
  await sleep(700)
  current = await client.status()
  assert(current.sceneItems === scene.items.length, 'stdin 的 update 被接受（sceneItems=' + current.sceneItems + '）')
  assert(current.visible === true, '窗口已显示')
  assert(current.focused === false, '窗口不抢焦点（focused=false）')
  assert(current.focusable === false, '窗口不可聚焦（focusable=false）')
  assert(current.alwaysOnTop === true, '窗口置顶（alwaysOnTop=true）')
  // Windows 上 setVisibleOnAllWorkspaces 是空操作（helper 里显式跳过），只在 macOS 断言 == true。
  assert(
    process.platform === 'win32' ? current.allWorkspaces === false : current.allWorkspaces === true,
    process.platform === 'win32'
      ? 'Windows 不调用 setVisibleOnAllWorkspaces（allWorkspaces=false）'
      : '窗口显示在所有工作区（allWorkspaces=true）')
  assert(current.bounds.width === workArea.width && current.bounds.height === workArea.height,
    '窗口尺寸等于工作区，不越界')
  // 冒烟只走合成 PointerEvent：锁住真实输入，环境里的鼠标/焦点事件不能干扰用例。
  client.send({ type: 'debug-lock-input', locked: true })
  await sleep(150)
  client.send({ type: 'debug-dispatch', phase: 'move', x: workArea.x + 8, y: workArea.y + 8 })
  await sleep(150)
  assert((await client.status()).ignoring === true, '锁住输入后窗口回到穿透（没有悬停）')
  current = await client.waitStatus((status) => status.rendererRects >= 3, 4000, '渲染端上报 3 个命中矩形')
  assert(current.rendererRectsAgeMs !== null && current.rendererRectsAgeMs < shared.RENDERER_RECT_MAX_AGE_MS,
    '命中矩形是新鲜的（' + current.rendererRectsAgeMs + 'ms）')

  // 等出生速度被地面摩擦吃掉：命中判定是在宠物静止时做的，避免测试和物理赛跑。
  await sleep(2600)
  let state = await client.rendererState()
  assert(state !== null && state.pets.length === 3, '渲染端有 3 只宠物')
  assert(state.pets.every((pet) => pet.x >= 0 && pet.y >= 0 &&
    pet.x + pet.width <= workArea.width + 0.5 && pet.y + pet.height <= workArea.height + 0.5),
  '所有宠物都在工作区内（出生后立即受重力/夹取约束）')
  if (ASSET_ROOTS.length > 0) {
    assert(state.pets.every((pet) => pet.source === 'video'),
      '宠物素材经 dshzoo:// 加载成功（' + state.pets.map((pet) => pet.clip).join(', ') + '）')
  }
  // ticket 28：`/dsh-zoo/desktop` 的 `helperStatus.media` 是现场唯一的素材探针。
  // 它以前只在「开始加载」时报一次 loading，loadeddata 之后从不回报，于是永远显示 loading——
  // 现场据此以为 live scene 没画出来。这里断言它跟得上真实状态（渲染端那三只已经是 video）。
  // `media` 是「最近一次上报」，三只宠物各自轮播，所以等它落到一段 video 上，别和轮播赛跑。
  const mediaStatus = (await client.waitStatus(
    (status) => status.media !== null && status.media.source === 'video',
    4000,
    'status.media 跟上 video'
  )).media
  assert(mediaStatus.readyState !== null && mediaStatus.readyState >= 2,
    'status.media 带得动诊断（readyState=' + mediaStatus.readyState + '）')
  assert(mediaStatus.visibility === 'visible',
    'status.media 报出文档可见性（' + mediaStatus.visibility + '，窗口 visible=' + (await client.status()).visible + '）')
  assert(state.pets.every((pet) => Number.isFinite(pet.vx) && Number.isFinite(pet.vy)), '速度是有限数')

  // 渲染端悬停路径（真实输入管线）：sendInputEvent 的合成 mousemove → 渲染端 hover → IPC。
  // 宠物可能刚出生还在动，重试几次拿新鲜位置；之后锁住真实输入，后续全用 debug-dispatch。
  const outside = { x: workArea.x + 8, y: workArea.y + 8 }
  // 真实输入管线单独验一次：解锁 → sendInputEvent mousemove → 命中；验完立刻重新锁上。
  client.send({ type: 'debug-lock-input', locked: false })
  await sleep(150)
  let hovered = null
  let hoveredPet = null
  let self = null
  let center = null
  let start = 0
  for (let attempt = 1; attempt <= 3 && hovered === null; attempt += 1) {
    state = await client.rendererState()
    hoveredPet = state.pets.find((pet) => pet.id === 'self')
    center = screenCenter(hoveredPet, workArea)
    start = client.mark()
    client.send({ type: 'debug-move', x: center.x, y: center.y })
    try {
      hovered = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 1500, '进入命中区')
    } catch {
      info('真实输入悬停第 ' + attempt + ' 次没中，重试')
      client.send({ type: 'pointer', x: outside.x, y: outside.y })
      await sleep(250)
      hovered = null
    }
  }
  assert(hovered !== null, '真实输入管线（sendInputEvent mousemove）能触发命中')
  assert(hovered.inside === true && hovered.itemId === 'self', '光标进命中区 → 命中 self（itemId=self）')
  assert(['hovering', 'main-fallback'].includes(hovered.reason), '渲染端路径接管鼠标（reason=' + hovered.reason + '）')
  assert(hitMatchesPet(hovered, hoveredPet, workArea), 'hit.rect 与渲染端上报的宠物矩形一致（屏幕 DIP）')

  // 重新锁住真实输入，用合成 PointerEvent 做确定性的悬停/穿透判定。
  client.send({ type: 'debug-lock-input', locked: true })
  await sleep(150)
  state = await client.rendererState()
  // 用 guest 做“主进程否决/兜底”：悬停 self 会弹控件并持有租约（ticket 11），
  // 而这里要验证的恰恰是“没有租约时，位置判定必须听真实光标的”。guest 悬停不弹控件。
  const hoverGuest = state.pets.find((pet) => pet.id === 'guest:demo-a')
  center = screenCenter(hoverGuest, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'move', x: center.x, y: center.y })
  const synthHover = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '合成悬停')
  assert(synthHover.itemId === hoverGuest.id, '合成 pointermove 也能命中 guest（' + synthHover.itemId + '）')
  assert((await client.status()).ignoring === false, '主进程真的调用了 setIgnoreMouseEvents(false)')

  // 主进程否决：渲染端还在说 inside，但真实光标在外面
  start = client.mark()
  client.send({ type: 'pointer', x: outside.x, y: outside.y })
  const vetoed = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === false, 2000, '主进程否决')
  assert(vetoed.reason === 'outside', '渲染端说 inside 也不能否决「真实光标在外面」')
  assert((await client.status()).ignoring === true, '恢复穿透')

  // 主进程兜底：先让渲染端真的看见光标离开，再只改主进程光标（渲染端完全没消息）
  client.send({ type: 'debug-dispatch', phase: 'move', x: outside.x, y: outside.y })
  await sleep(1300)
  center = screenCenter(hoverGuest, workArea)
  start = client.mark()
  client.send({ type: 'pointer', x: center.x, y: center.y })
  const fallback = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '兜底接管')
  assert(fallback.reason === 'main-fallback', '渲染端无消息时，停留 300ms 由主进程兜底接管')
  await leavePointer(client, outside)
  assert((await client.status()).ignoring === true, '兜底接管后移出命中区也恢复穿透')

  // 输入租约 + ui:drag（A3）：拖拽时宠物落后于光标，租约负责让位置判定让位；
  // 但租约**不能单独**让整窗可交互——光标必须压在一条活的命中矩形上。
  // 外部应用抢焦点会让 helper 收到 blur 并（正确地）收回租约；这是环境事件，不是被测行为，
  // 所以这里最多重试 3 次。
  let leaseHeld = false
  let dragPoint = null
  for (let attempt = 1; attempt <= 3 && !leaseHeld; attempt += 1) {
    state = await client.rendererState()
    self = state.pets.find((pet) => pet.id === 'self')
    center = screenCenter(self, workArea)
    start = client.mark()
    client.send({ type: 'debug-dispatch', phase: 'move', x: center.x, y: center.y })
    await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '拖拽前悬停')
    const before = self
    client.send({ type: 'debug-dispatch', phase: 'down', x: center.x, y: center.y })
    current = await client.waitStatus((status) => status.busy === true, 2000, '拖拽开始（busy=true）')
    assert(current.ignoring === false, '拖拽开始后窗口可交互')
    state = await client.rendererState()
    assert(state.dragging === 'self', '渲染端记录了拖拽中的宠物（dragging=self）')
    const grabbed = state.pets.find((pet) => pet.id === 'self')
    assert(Math.abs(grabbed.x - before.x) < 3 && Math.abs(grabbed.y - before.y) < 3,
      '刚按下时宠物还在原地（弹簧跟随，不瞬移）')

    // 把光标甩到右边 260px：弹簧跟随需要时间，此刻光标已经在宠物矩形外，
    // 但渲染端上报的 ui:drag（宠物 ∪ 光标周围 80px）必须把它盖住。
    dragPoint = { x: center.x + 260, y: center.y - 40 }
    client.send({ type: 'debug-dispatch', phase: 'move', x: dragPoint.x, y: dragPoint.y })
    await sleep(120)
    state = await client.rendererState()
    const lagging = state.pets.find((pet) => pet.id === 'self')
    const dragRects = state.uiRects.filter((rect) => rect.id === 'ui:drag')
    assert(dragRects.length === 1, '拖拽期间上报了一条跟随光标的 ui:drag 矩形')
    const localDragPoint = { x: dragPoint.x - workArea.x, y: dragPoint.y - workArea.y }
    assert(shared.hitTestRects(dragRects, localDragPoint) !== null, 'ui:drag 矩形盖住了光标')
    assert(shared.hitTestRects(
      [{ x: lagging.x, y: lagging.y, width: lagging.width, height: lagging.height }],
      localDragPoint
    ) === null, '光标确实在（落后的）宠物矩形外：靠租约 + ui:drag 接管鼠标')
    current = await client.status()
    if (current.busy === true && current.ignoring === false) {
      leaseHeld = true
    } else {
      info('输入租约被外部焦点变化打断（第 ' + attempt + ' 次），重试')
      client.send({ type: 'debug-dispatch', phase: 'up', x: dragPoint.x, y: dragPoint.y })
      await sleep(250)
      await leavePointer(client, outside)
    }
  }
  assert(leaseHeld, '光标在宠物矩形外、却压在 ui:drag 上时窗口保持可交互（输入租约生效）')

  // A3：租约还在续期，但主进程光标离开所有活矩形 → 必须恢复穿透。
  client.send({ type: 'pointer', x: outside.x, y: outside.y })
  current = await client.waitStatus((status) => status.ignoring === true, 3000, '租约不能单独占住桌面')
  assert(current.busy === true, '此时租约仍然新鲜：穿透不是因为租约过期，而是因为没有活矩形')
  state = await client.rendererState()
  assert(state.dragging === 'self', '渲染端还在拖拽，窗口依然恢复穿透（fail closed）')

  // 光标回到 ui:drag 上 → 立刻恢复可交互，拖拽没断。
  client.send({ type: 'pointer', x: dragPoint.x, y: dragPoint.y })
  await client.waitStatus((status) => status.ignoring === false, 3000, '回到拖拽矩形恢复可交互')
  assert((await client.rendererState()).dragging === 'self', '拖拽没有被打断')

  // pointerup → 释放租约；宠物不会因为光标在外面而弹飞
  client.send({ type: 'debug-dispatch', phase: 'up', x: dragPoint.x, y: dragPoint.y })
  current = await client.waitStatus((status) => status.busy === false, 2500, '拖拽结束释放租约')
  assert(current.busy === false, 'pointerup 立刻释放租约（不再靠租约兜底）')
  // 没有租约兜底之后，光标一移开就必须立刻回穿透。
  const released = await expectIgnoring(client, outside, false, 2500, '拖拽结束交还穿透')
  if (released.via === 'status') info('穿透在 mark 之前就已经落定（不会有新的 hit 事件），按状态判定')
  current = await client.status()
  assert(current.busy === false, 'pointerup 后 busy 释放')
  assert(current.ignoring === true, 'pointerup 后恢复穿透')
  state = await client.rendererState()
  assert(state.dragging === null, '渲染端拖拽状态已清空')
  self = state.pets.find((pet) => pet.id === 'self')
  // 松手位置比抓起来时高 40px，宠物会自然下落（vy ≠ 0 是重力，不是投掷）。
  assert(Math.abs(self.vx) < 30, '没有新轨迹就松手 → 不投掷（水平速度≈0）')

  // 拖拽跟手 + 投掷
  center = screenCenter(self, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'move', x: center.x, y: center.y })
  await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '投掷前悬停')
  client.send({ type: 'debug-dispatch', phase: 'down', x: center.x, y: center.y })
  await client.waitStatus((status) => status.busy === true, 2000, '投掷拖拽开始')
  const dragStart = (await client.rendererState()).pets.find((pet) => pet.id === 'self')
  await sleep(100)
  const midX = center.x + 140
  const midY = center.y - 70
  client.send({ type: 'debug-dispatch', phase: 'move', x: midX, y: midY })
  await sleep(80)
  const endX = center.x + 300
  const endY = center.y - 150
  client.send({ type: 'debug-dispatch', phase: 'move', x: endX, y: endY })
  await sleep(50)
  const following = (await client.rendererState()).pets.find((pet) => pet.id === 'self')
  assert(following.x > dragStart.x + 50, '拖拽时宠物朝光标方向跟随（' + dragStart.x.toFixed(0) + ' → ' + following.x.toFixed(0) + '）')
  client.send({ type: 'debug-dispatch', phase: 'up', x: endX, y: endY })
  await sleep(120)
  state = await client.rendererState()
  const thrown = state.pets.find((pet) => pet.id === 'self')
  const throwSpeed = Math.hypot(thrown.vx, thrown.vy)
  assert(throwSpeed > 100, '松手带上了释放速度（' + throwSpeed.toFixed(0) + ' px/s）')
  assert(state.pets.every((pet) => pet.x >= 0 && pet.y >= 0 &&
    pet.x + pet.width <= workArea.width + 0.5 && pet.y + pet.height <= workArea.height + 0.5),
  '投掷瞬间所有宠物仍在工作区内')
  await sleep(2500)
  state = await client.rendererState()
  const landed = state.pets.find((pet) => pet.id === 'self')
  assert(Math.hypot(landed.vx, landed.vy) < throwSpeed, '投掷速度随时间衰减（' + throwSpeed.toFixed(0) + ' → ' + Math.hypot(landed.vx, landed.vy).toFixed(0) + '）')
  assert(landed.y + landed.height <= workArea.height + 0.5, '落地后没有穿出工作区底边')

  // 移动中的命中矩形：主进程的命中判定跟着渲染端位置走
  state = await client.rendererState()
  const guest = state.pets.find((pet) => pet.id === 'guest:demo-a')
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'move', x: screenCenter(guest, workArea).x, y: screenCenter(guest, workArea).y })
  const movedHit = await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '移动后命中')
  assert(movedHit.itemId === guest.id, '移动后命中的是正确的那只（' + movedHit.itemId + '）')
  assert(hitMatchesPet(movedHit, guest, workArea), '命中矩形与渲染端当前位置一致')
  await leavePointer(client, outside)

  // 场景 v2：宿主删一只 → 渲染端立刻销毁；再加回来 → 重新出生
  const remaining = shared.petScene(scene.items
    .filter((item) => item.id !== 'guest:demo-b')
    .map((item) => ({ id: item.id, role: item.role, label: item.label, anim: item.anim, color: item.color })), workArea, { reset: true })
  client.send({ type: 'update', scene: remaining })
  await sleep(350)
  state = await client.rendererState()
  assert(state.pets.length === 2, '宿主删掉一只宠物后渲染端只剩 2 只（' + state.pets.map((pet) => pet.id).join(',') + '）')
  assert(state.pets.every((pet) => pet.id !== 'guest:demo-b'), '被删的宠物不再出现在渲染端')

  const restored = shared.petScene(scene.items.map((item) => ({
    id: item.id,
    role: item.role,
    label: item.label,
    anim: item.anim,
    color: item.color
  })), workArea, { reset: true })
  client.send({ type: 'update', scene: restored })
  await sleep(350)
  state = await client.rendererState()
  assert(state.pets.length === 3, '场景加回来 → 渲染端重新出生 3 只')
  assert(state.pets.every((pet) => pet.x >= 0 && pet.y >= 0 &&
    pet.x + pet.width <= workArea.width + 0.5 && pet.y + pet.height <= workArea.height + 0.5),
  'reset 后的宠物仍在工作区内')

  // 动作/昵称更新（宿主仍是动画/名字的权威）
  const renamed = shared.normalizeScene({
    ...restored,
    reset: false,
    items: restored.items.map((item) => item.id === 'self'
      ? { ...item, label: '小蓝二号', anim: '原地小憩沉眠' }
      : item)
  })
  client.send({ type: 'update', scene: renamed })
  await sleep(400)
  state = await client.rendererState()
  const renamedPet = state.pets.find((pet) => pet.id === 'self')
  assert(renamedPet.label === '小蓝二号' && renamedPet.anim === '原地小憩沉眠', '昵称/动作跟着宿主场景更新')
  assert(renamedPet.source === 'video' || renamedPet.source === 'loading', '动作更新后仍走 WebM 素材')

  // 渲染端冻结：hover 通道完全没消息时，主进程兜底也必须停（fail-closed）
  await sleep(2600)
  state = await client.rendererState()
  const freezeTarget = state.pets.find((pet) => pet.id === 'self')
  client.send({ type: 'debug-freeze-hover', frozen: true })
  client.send({ type: 'pointer', x: screenCenter(freezeTarget, workArea).x, y: screenCenter(freezeTarget, workArea).y })
  await sleep(900)
  current = await client.status()
  assert(current.ignoring === true, '渲染端冻结时，主进程兜底不会接管（依旧穿透）')
  client.send({ type: 'debug-freeze-hover', frozen: false })
  await leavePointer(client, outside)

  // 输入租约超时：busy 心跳不再续期时，超过 BUSY_LEASE_MS 自动收回
  state = await client.rendererState()
  self = state.pets.find((pet) => pet.id === 'self')
  center = screenCenter(self, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'move', x: center.x, y: center.y })
  await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, '超时前悬停')
  client.send({ type: 'debug-dispatch', phase: 'down', x: center.x, y: center.y })
  await client.waitStatus((status) => status.busy === true, 2000, '超时拖拽开始')
  client.send({ type: 'debug-freeze-busy', frozen: true })
  client.send({ type: 'pointer', x: outside.x, y: outside.y })
  // 光标先离开命中区（立刻穿透是 A3 的正确行为），再等租约自己过期。
  current = await client.waitStatus((status) => status.ignoring === true, 3000, '离开拖拽矩形恢复穿透')
  assert(current.busy === true, '这时租约还没过期：穿透来自“没有活矩形”，不是租约失效')
  current = await client.waitStatus((status) => status.busy === false, shared.BUSY_LEASE_MS + 2500, '租约超时释放')
  assert(current.ignoring === true, 'BUSY_LEASE_MS 内没有续期 → 租约自动释放（busy=false）')
  client.send({ type: 'debug-dispatch', phase: 'up', x: outside.x, y: outside.y })
  client.send({ type: 'debug-freeze-busy', frozen: false })
  await sleep(200)
  assert((await client.status()).ignoring === true, '渲染端也收手后仍是穿透（不残留输入租约）')

  // window blur 也要交还租约（真实环境里临时解锁输入，测完立刻锁回去）
  client.send({ type: 'debug-lock-input', locked: false })
  await sleep(150)
  state = await client.rendererState()
  self = state.pets.find((pet) => pet.id === 'self')
  center = screenCenter(self, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'move', x: center.x, y: center.y })
  await client.waitFrom(start, (event) => event.type === 'hit' && event.interactive === true, 3000, 'blur 前悬停')
  client.send({ type: 'debug-dispatch', phase: 'down', x: center.x, y: center.y })
  await client.waitStatus((status) => status.busy === true, 2000, 'blur 前拖拽')
  client.send({ type: 'pointer', x: outside.x, y: outside.y })
  client.send({ type: 'debug-dispatch', phase: 'blur', x: center.x, y: center.y })
  await sleep(250)
  current = await client.status()
  assert(current.busy === false && current.ignoring === true, 'window blur → 渲染端立刻交还输入租约并恢复穿透')
  client.send({ type: 'debug-lock-input', locked: true })
  await sleep(150)

  // 截图：宠物 + 昵称 + 透明背景
  mkdirSync(OUT_DIR, { recursive: true })
  const pngPath = join(OUT_DIR, 'helper.png')
  start = client.mark()
  client.send({ type: 'shot', id: 'shot-helper', path: pngPath })
  const shot = await client.waitFrom(start, (event) => event.type === 'shot', 8000, 'shot')
  assert(existsSync(pngPath), 'shot 落盘：' + pngPath)
  assert(shot.width > 0 && shot.height > 0, 'shot 返回像素尺寸 ' + shot.width + '×' + shot.height)
  const verified = verifyShot(pngPath, pngPath + '.json', 3)
  info('交互截图：' + pngPath)

  // ---------------------------------------------------------------------------
  // ticket 30：真实左键的到达（合成的 vs 走真实管线的 vs 真 OS 的）
  // ---------------------------------------------------------------------------
  client.send({ type: 'debug-lock-input', locked: false })
  await sleep(150)
  state = await client.rendererState()
  const trustPet = state.pets.find((pet) => pet.id === 'self')
  assert(trustPet !== undefined, '有 self 可以按')
  const trustPoint = screenCenter(trustPet, workArea)
  const trustBefore = (await client.status()).trustedInputs

  // 合成 pointerdown（executeJavaScript 造的事件，isTrusted=false）不该计数
  client.send({ type: 'debug-dispatch', phase: 'down', x: trustPoint.x, y: trustPoint.y })
  await sleep(120)
  assert((await client.status()).trustedInputs === trustBefore, '合成 pointerdown 不计入可信输入')
  client.send({ type: 'debug-dispatch', phase: 'up', x: trustPoint.x, y: trustPoint.y })
  await sleep(80)

  // sendInputEvent 走的是真实输入管线（isTrusted=true）→ 会计数
  client.send({ type: 'debug-input', action: 'down', x: trustPoint.x, y: trustPoint.y })
  await sleep(150)
  const trustAfter = (await client.status()).trustedInputs
  assert(trustAfter > trustBefore,
    '走真实输入管线的左键计入 trustedInputs（' + trustBefore + ' → ' + trustAfter + '）')
  client.send({ type: 'debug-input', action: 'up', x: trustPoint.x, y: trustPoint.y })
  await sleep(120)

  // 输入态卡住时的踢法：不重启，重放一次 setIgnoreMouseEvents(true → false)
  client.send({ type: 'debug-dispatch', phase: 'move', x: trustPoint.x, y: trustPoint.y })
  await client.waitStatus((status) => status.ignoring === false, 2000, '光标进命中区后窗口可交互')
  client.send({ type: 'debug-kick-input' })
  await sleep(250)
  const kicked = await client.status()
  assert(kicked.ignoring === false, 'kick 之后窗口仍然可交互（穿透状态被正确重放）')
  assert(kicked.rendererRects >= 1, 'kick 之后命中矩形还在')

  if (process.platform === 'win32') {
    // 真 OS 左键：SetCursorPos + SendInput 走 Windows 输入队列，不是 Electron 的
    // sendInputEvent。这是唯一能覆盖「窗口说可交互、左键却没进来」的路径。
    const primary = Array.isArray(ready.displays) ? ready.displays.find((display) => display.primary) : null
    const scale = primary !== null && Number.isFinite(primary.scaleFactor) && primary.scaleFactor > 0
      ? primary.scaleFactor
      : 1
    const home = (await client.rendererState()).pets.find((pet) => pet.id === 'self')
    assert(home !== undefined, 'Windows：有 self 可以按')
    const center = screenCenter(home, workArea)
    const px = Math.round(center.x * scale)
    const py = Math.round(center.y * scale)
    const script = join(ROOT, 'scripts', 'win32-sendinput.ps1')
    const runSendInput = (mode, extra = []) => spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Mode', mode, '-X', String(px), '-Y', String(py), ...extra
    ], { windowsHide: true, stdio: 'ignore' })

    // 子进程卡住不能把整条冒烟挂死：15s 兜底。退出码也要看——脚本自己失败时（锁屏、
    // UAC 安全桌面把 SendInput 吞掉，脚本 exit 2），只等 busy 的断言只会给一个含糊的超时。
    const runAndWait = (child) => Promise.race([
      new Promise((resolve) => child.once('exit', (code) => resolve({ code, timedOut: false }))),
      sleep(15000).then(() => ({ code: null, timedOut: true }))
    ])
    const moved = await runAndWait(runSendInput('move'))
    assert(moved.timedOut === false && moved.code === 0, '真实光标移动脚本正常退出（' + JSON.stringify(moved) + '）')
    await client.waitStatus((status) => status.hoverInside === true && status.ignoring === false,
      3000, '真实光标进入命中区')

    const beforeX = (await client.rendererState()).pets.find((pet) => pet.id === 'self').x
    const drag = runSendInput('drag', [
      '-ToX', String(px + Math.round(90 * scale)),
      '-ToY', String(py),
      '-HoldMs', '600'
    ])
    let busySeen = false
    const dragDeadline = Date.now() + 2500
    while (Date.now() < dragDeadline && !busySeen) {
      busySeen = (await client.status()).busy === true
      if (!busySeen) await sleep(40)
    }
    const dragged = await runAndWait(drag)
    await sleep(350)
    assert(dragged.timedOut === false && dragged.code === 0, '真实拖拽脚本正常退出（' + JSON.stringify(dragged) + '）')
    assert(busySeen, '真实左键按下进入拖拽（busy=true）')
    assert((await client.status()).busy === false, '松手后输入租约释放')
    const afterX = (await client.rendererState()).pets.find((pet) => pet.id === 'self').x
    assert(Math.abs(afterX - beforeX) > 20,
      '真实拖拽让宠物真的动了（' + Math.round(beforeX) + ' → ' + Math.round(afterX) + '）')
  } else {
    info('真实 OS 左键（SendInput）用例只在 Windows 上跑，这次跳过')
  }

  // quit：进程自己退出
  const exitPromise = client.exited
  client.send({ type: 'quit' })
  const exit = await Promise.race([exitPromise, sleep(4000).then(() => null)])
  assert(exit !== null, 'quit 命令让 helper 自己退出')
  assert(exit.code === 0 || exit.code === null, 'quit 退出码正常（' + JSON.stringify(exit) + '）')
  return { pngPath, sidecarPath: pngPath + '.json', verified }
}

// ---------------------------------------------------------------------------
// 3) manager：宿主侧生命周期 + 宠物场景
// ---------------------------------------------------------------------------

function pidAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil (predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(50)
  }
  throw new Error('等待超时：' + label)
}

// ---------------------------------------------------------------------------
// 2.5) 右键菜单（ticket 22）：只挂自己、级联、点一项就申请动作
// ---------------------------------------------------------------------------

async function verifyMenu () {
  const client = createHelperClient((line) => info(line))
  const readyMark = client.mark()
  const ready = await client.waitFrom(readyMark, (event) => event.type === 'ready', 15000, 'ready')
  const workArea = ready.workArea
  const visitorId = '55555555-5555-4555-8555-555555555555'

  client.send({ type: 'debug-lock-input', locked: true })
  await sleep(150)

  const scene = shared.petScene([
    { id: 'self', role: 'self', label: '小蓝', anim: '东张西望', color: shared.PET_COLORS[0] },
    { id: 'visitor:' + visitorId, role: 'visitor', label: '阿蟹', anim: '螃蟹走路', color: shared.PET_COLORS[1] }
  ], workArea, {
    reset: true,
    menu: {
      tools: [
        { id: 'open-site', label: '打开软件' },
        { id: 'bring', label: '带派' },
        { id: 'home', label: '回到初始位置' },
        { id: 'reload', label: '重载配置' }
      ],
      groups: [
        { label: '待机', actions: ['东张西望', '原地小憩沉眠'] },
        { label: '小动作', actions: ['悠闲哼歌', '写代码'] }
      ]
    }
  })
  client.send({ type: 'update', scene })
  await sleep(1500)

  let state = await client.rendererState()
  assert(state !== null && state.menu === null, '没人右键时菜单是关着的')

  const self = state.pets.find((pet) => pet.id === 'self')
  const center = screenCenter(self, workArea)
  client.send({ type: 'debug-dispatch', phase: 'context', x: center.x, y: center.y })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.menu !== null
  }, 3000, '右键后菜单出现')

  state = await client.rendererState()
  assert(state.menu.petId === 'self', '菜单挂在自己身上')
  assert(state.menu.panels.length === 1, '一级只有一个面板（' + state.menu.panels.length + '）')
  const rowLabels = state.menu.rows.map((row) => row.label)
  assert(rowLabels.includes('打开软件') && rowLabels.includes('回到初始位置') && rowLabels.includes('重载配置'),
    '一级有工具项三件套：' + rowLabels.join('/'))
  assert(rowLabels.includes('带派'), '一级有「带派」（' + rowLabels.join('/') + '）')
  assert(rowLabels.includes('动作'), '一级有「动作」')

  // 矩形是异步过 IPC 的：等主进程真的按新矩形翻成可交互，再看数量。
  await client.waitStatus((status) => status.ignoring === false, 3000, '菜单打开后可交互')
  const current = await client.status()
  assert(current.overlayRects >= 2, '菜单面板与桥接矩形都上报了（' + current.overlayRects + ' 块）')

  // 菜单开着时宠物停住（ADR-0010）：位置与速度都不该再变。
  const frozenBefore = (await client.rendererState()).pets.find((pet) => pet.id === 'self')
  await sleep(450)
  const frozenAfter = (await client.rendererState()).pets.find((pet) => pet.id === 'self')
  assert(frozenBefore.x === frozenAfter.x && frozenBefore.y === frozenAfter.y,
    '菜单开着时宠物停住（' + frozenBefore.x + ',' + frozenBefore.y + ' → ' + frozenAfter.x + ',' + frozenAfter.y + '）')

  // 人手真实的用法：右键之后把光标**移到菜单上**，停一会儿再点。
  // 菜单必须还在——这就是用户报的「一瞬间就消失」。
  const firstPanel = state.menu.panels[0]
  const selfRect = state.pets.find((pet) => pet.id === 'self')
  // 必须落在「菜单上、宠物外」：菜单是贴着指针开的，第一段会和宠物重叠。
  const intoMenu = {
    x: workArea.x + Math.max(selfRect.x + selfRect.width + 8, firstPanel.x + 12),
    y: workArea.y + firstPanel.y + 14
  }
  client.send({ type: 'debug-dispatch', phase: 'move', x: intoMenu.x, y: intoMenu.y })
  await sleep(800)
  const afterHover = await client.rendererState()
  assert(afterHover.menu !== null && afterHover.menu.panels.length === 1,
    '光标移到菜单上停 800ms，菜单仍然开着')

  // 用户真的要点的时候：光标停在菜单项上，持续 2 秒，窗口必须仍然接鼠标。
  // 这里量的是主进程的真实状态（ignoring），不是渲染端自己说"我在菜单上"。
  client.send({ type: 'debug-dispatch', phase: 'move', x: intoMenu.x, y: intoMenu.y })
  await sleep(2000)
  const hoverState = await client.status()
  assert(hoverState.ignoring === false,
    '光标停在菜单项上 2s，窗口仍然接鼠标（ignoring=' + hoverState.ignoring + '）')

  // 菜单开着时，光标回到宠物身上不该再弹左键弹层（两套入口会互相抢鼠标）。
  client.send({ type: 'debug-dispatch', phase: 'move', x: center.x, y: center.y })
  await sleep(400)
  state = await client.rendererState()
  assert(state.controls.popover === null, '菜单开着时不再弹悬停弹层')

  // 悬停「动作」→ 分类面板；悬停「小动作」→ 动作面板
  // 宠物会走：每次右键前都现取它的位置，别用几十毫秒前的那份。
  const petCenterNow = async () => {
    const snapshot = await client.rendererState()
    const self = snapshot.pets.find((pet) => pet.id === 'self')
    return screenCenter(self, workArea)
  }
  const openToGroup = async (groupLabel) => {
    // 菜单开着时，先移开让宽限把它收掉（右键 toggle 要命中宠物，而菜单正好盖在光标上）。
    if ((await client.rendererState()).menu !== null) {
      client.send({ type: 'debug-dispatch', phase: 'move', x: workArea.x + 4, y: workArea.y + 4 })
      await waitUntil(async () => (await client.rendererState()).menu === null, 3000, '移开收起旧菜单')
    }
    const selfCenter = await petCenterNow()
    client.send({ type: 'debug-dispatch', phase: 'context', x: selfCenter.x, y: selfCenter.y })
    await waitUntil(async () => {
      const snapshot = await client.rendererState()
      return snapshot.menu !== null && snapshot.menu.panels.length === 1
    }, 3000, '右键展开一级')
    let snapshot = await client.rendererState()
    const branch = snapshot.menu.rows.find((row) => row.kind === 'branch')
    const branchPoint = rectCenterScreen(branch, workArea)
    client.send({ type: 'debug-dispatch', phase: 'move', x: branchPoint.x, y: branchPoint.y })
    await waitUntil(async () => {
      const next = await client.rendererState()
      return next.menu !== null && next.menu.panels.length === 2
    }, 3000, '悬停「动作」展开分类')
    snapshot = await client.rendererState()
    const group = snapshot.menu.rows.find((row) => row.kind === 'group' && row.label === groupLabel)
    assert(Boolean(group), '分类面板里有「' + groupLabel + '」')
    const groupPoint = rectCenterScreen(group, workArea)
    client.send({ type: 'debug-dispatch', phase: 'move', x: groupPoint.x, y: groupPoint.y })
    await waitUntil(async () => {
      const next = await client.rendererState()
      return next.menu !== null && next.menu.panels.length === 3
    }, 3000, '悬停分类展开动作')
    return client.rendererState()
  }

  state = await openToGroup('小动作')
  assert(state.strayPopovers === 0, '菜单展开后没有残留的弹层 DOM（实际 ' + state.strayPopovers + '）')

  // 截图：三级菜单同框
  mkdirSync(OUT_DIR, { recursive: true })
  const pngPath = join(OUT_DIR, 'menu.png')
  let start = client.mark()
  client.send({ type: 'shot', id: 'shot-menu', path: pngPath })
  const shot = await client.waitFrom(start, (event) => event.type === 'shot' && event.id === 'shot-menu', 8000, '菜单截图')
  assert(shot.width > 0 && existsSync(pngPath), '菜单截图落盘：' + pngPath)
  const verified = verifyShot(pngPath, pngPath + '.json', 2, { allowSvg: false })
  const menuPanels = verified.sidecar.renderer?.menu?.panels ?? []
  assert(menuPanels.length === 3, '截图 sidecar 里有三级面板')
  assertControlPixels(verified, menuPanels.map((panel) => ({
    id: 'menu:' + panel.level,
    x: panel.x,
    y: panel.y,
    width: panel.width,
    height: panel.height
  })))
  info('菜单截图：' + pngPath)

  // 点一个动作名：菜单收起，助手把 play-anim 申请写给宿主。
  // 截图可能耗掉一段 12 秒上限（菜单自己收起是特性），所以这里**总是**重新展开一次：
  // 既重置超时，也拿到一份新的面板坐标。
  state = await openToGroup('小动作')
  const animRow = state.menu.rows.find((row) => row.kind === 'anim' && row.label === '写代码')
  assert(Boolean(animRow), '动作面板里有「写代码」')
  const animPoint = rectCenterScreen(animRow, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'click', x: animPoint.x, y: animPoint.y })
  let request
  try {
    request = await client.waitFrom(start, (event) => event.type === 'action' && event.action === 'play-anim', 3000, '点播申请')
  } catch (error) {
    const diag = await client.rendererState()
    console.error('[diag] click=' + JSON.stringify(diag?.lastMenuClick) +
      ' menu=' + JSON.stringify(diag?.menu) +
      ' pending=' + JSON.stringify(diag?.controls?.pending) +
      ' events=' + JSON.stringify(client.events.slice(-6).map((event) => event.type + ':' + (event.action ?? ''))))
    throw error
  }
  assert(request.name === '写代码', '点播申请带着动画名：' + request.name)
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.menu === null
  }, 2000, '点完收起菜单')

  // 「回到初始位置」：先把它拖走，再点菜单，应该回到出生点而不是原地。
  const dragFrom = await petCenterNow()
  client.send({ type: 'debug-dispatch', phase: 'down', x: dragFrom.x, y: dragFrom.y })
  await sleep(60)
  client.send({ type: 'debug-dispatch', phase: 'move', x: dragFrom.x + 320, y: dragFrom.y - 140 })
  await sleep(60)
  client.send({ type: 'debug-dispatch', phase: 'up', x: dragFrom.x + 320, y: dragFrom.y - 140 })
  await sleep(500)
  const dragged = (await client.rendererState()).pets.find((pet) => pet.id === 'self')
  assert(Math.abs(dragged.x - dragged.spawnX) > 40, '拖走之后它确实不在出生点上（' + dragged.x + ' vs ' + dragged.spawnX + '）')

  const beforeHome = await petCenterNow()
  client.send({ type: 'debug-dispatch', phase: 'context', x: beforeHome.x, y: beforeHome.y })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.menu !== null
  }, 3000, '为「回到初始位置」展开菜单')
  state = await client.rendererState()
  const homeRow = state.menu.rows.find((row) => row.kind === 'tool' && row.label === '回到初始位置')
  assert(Boolean(homeRow), '菜单里有「回到初始位置」')
  const homePoint = rectCenterScreen(homeRow, workArea)
  client.send({ type: 'debug-dispatch', phase: 'click', x: homePoint.x, y: homePoint.y })
  await waitUntil(async () => (await client.rendererState()).menu === null, 2000, '点完收起菜单')
  const homed = (await client.rendererState()).pets.find((pet) => pet.id === 'self')
  assert(Math.abs(homed.x - homed.spawnX) <= 2 && Math.abs(homed.y - homed.spawnY) <= 2,
    '「回到初始位置」把这一只放回出生点（' + homed.x + ',' + homed.y + ' → ' + homed.spawnX + ',' + homed.spawnY + '）')

  // 「带派」（ticket 24）：点一级工具项只发一个空动作，开窗是宿主的事。
  const bringCenter = await petCenterNow()
  client.send({ type: 'debug-dispatch', phase: 'context', x: bringCenter.x, y: bringCenter.y })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.menu !== null
  }, 3000, '为「带派」展开菜单')
  state = await client.rendererState()
  const bringRow = state.menu.rows.find((row) => row.kind === 'tool' && row.label === '带派')
  assert(Boolean(bringRow), '菜单里有「带派」')
  const bringPoint = rectCenterScreen(bringRow, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'click', x: bringPoint.x, y: bringPoint.y })
  const bringRequest = await client.waitFrom(
    start,
    (event) => event.type === 'action' && event.action === 'bring',
    3000,
    '「带派」申请'
  )
  assert(bringRequest.deviceId === null, '「带派」不夹带邻居身份')
  assert(bringRequest.gift === undefined, '右键「带派」只请求开窗，不带礼物')
  await waitUntil(async () => (await client.rendererState()).menu === null, 2000, '点完收起菜单')

  // 右键访客：不出菜单（也不吞鼠标）
  state = await client.rendererState()
  const visitor = state.pets.find((pet) => pet.id.startsWith('visitor:'))
  const visitorCenter = screenCenter(visitor, workArea)
  client.send({ type: 'debug-dispatch', phase: 'context', x: visitorCenter.x, y: visitorCenter.y })
  await sleep(400)
  state = await client.rendererState()
  assert(state.menu === null, '访客身上不弹菜单')

  client.send({ type: 'quit' })
  await client.exited
  pass('右键菜单：只挂自己 / 三级级联 / 点一项就申请点播 / 访客不弹')
  return { pngPath }
}

// ---------------------------------------------------------------------------
// 3) 邻居面板的稳定性：人多时面板不许自己动，点谁就是谁
// ---------------------------------------------------------------------------

/**
 * 这是 bug 的回归用例：邻居一多，每来一轮心跳宿主就会按 lastSeen 重排一次，
 * 面板跟着重建 → 房子在光标底下挪位置，点空或者点到隔壁。
 *
 * 断言的是用户看得见的两件事：面板开着时同一户的位置不动；点下去收到的 deviceId 是那一户。
 */
async function verifyStreetStability () {
  const client = createHelperClient((line) => info(line))
  const readyMark = client.mark()
  const ready = await client.waitFrom(readyMark, (event) => event.type === 'ready', 15000, 'ready')
  const workArea = ready.workArea
  client.send({ type: 'debug-lock-input', locked: true })
  await sleep(150)

  const ids = Array.from({ length: 6 }, (_, index) =>
    '77777777-7777-4777-8777-' + String(index).padStart(12, '0'))

  const streetRows = (order) => order.map((index) => ({
    deviceId: ids[index],
    label: '邻居' + index,
    action: '在改那个 bug',
    canVisit: true,
    blockedReason: null
  }))

  const sceneWith = (order) => shared.petScene([
    { id: 'self', role: 'self', label: '小蓝', anim: '东张西望', color: shared.PET_COLORS[0] }
  ], workArea, {
    reset: false,
    controls: {
      visit: { enabled: true, reason: null },
      recall: { enabled: false, nickname: null },
      visitors: [],
      street: streetRows(order),
      prompt: null,
      notice: null
    }
  })

  client.send({ type: 'update', scene: sceneWith([0, 1, 2, 3, 4, 5]) })
  await sleep(1800)

  let state = await client.rendererState()
  const self = state.pets.find((pet) => pet.id === 'self')
  const selfCenter = screenCenter(self, workArea)
  client.send({ type: 'debug-dispatch', phase: 'move', x: selfCenter.x, y: selfCenter.y })
  await waitUntil(async () => (await client.rendererState()).controls.popover !== null, 3000, '悬停后弹层出现')

  state = await client.rendererState()
  const visitButton = state.uiRects.find((rect) => rect.id === 'ui:btn:open-street')
  assert(Boolean(visitButton), '「串门」按钮有命中矩形')
  const visitPoint = rectCenterScreen(visitButton, workArea)
  client.send({ type: 'debug-dispatch', phase: 'click', x: visitPoint.x, y: visitPoint.y })
  await waitUntil(async () => (await client.rendererState()).controls.streetOpen === true, 3000, '面板打开')

  // 光标停在面板里，免得面板因为“离开”自己关掉。
  state = await client.rendererState()
  const panelRect = state.uiRects.find((rect) => rect.id === 'ui:street')
  assert(Boolean(panelRect), '面板有命中矩形')
  const panelPoint = rectCenterScreen(panelRect, workArea)
  client.send({ type: 'debug-dispatch', phase: 'move', x: panelPoint.x, y: panelPoint.y })
  await sleep(120)

  const rectOf = (snapshot, deviceId) =>
    snapshot.uiRects.find((rect) => rect.id === 'ui:street:visit:' + deviceId)

  state = await client.rendererState()
  const before = new Map(ids.map((id) => [id, rectOf(state, id)]))
  assert(ids.every((id) => before.get(id) !== undefined), '六户人家都在面板里')
  const panelBefore = panelRect

  // 心跳让 lastSeen 变，宿主每一轮都重排一次——这正是人多时发生的事。
  // 每一轮都要查：面板开着的时候，同一户的位置不许动。
  const drifted = []
  for (let round = 1; round <= 8; round += 1) {
    client.send({ type: 'update', scene: sceneWith(round % 2 === 0 ? [0, 1, 2, 3, 4, 5] : [5, 4, 3, 2, 1, 0]) })
    await sleep(260)
    const now = await client.rendererState()
    const movedIds = ids.filter((id) => {
      const first = before.get(id)
      const rect = rectOf(now, id)
      return rect === undefined || first.x !== rect.x || first.y !== rect.y
    })
    const panel = now.uiRects.find((rect) => rect.id === 'ui:street')
    const panelMoved = panel === undefined || panel.x !== panelBefore.x || panel.y !== panelBefore.y
    if (movedIds.length > 0 || panelMoved) {
      drifted.push('第' + round + '轮：' + (movedIds.length > 0 ? movedIds.length + '户' : '') +
        (panelMoved ? '面板' : ''))
    }
  }
  assert(drifted.length === 0,
    '面板开着时邻居的位置不该因为别人的心跳而移动（' + drifted.join('；') + '）')

  // 点最上面那一户：收到的必须就是它。
  const target = before.get(ids[0])
  const point = rectCenterScreen(target, workArea)
  const start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'click', x: point.x, y: point.y })
  const action = await client.waitFrom(start, (event) => event.type === 'action', 3000, '串门申请')
  assert(action.deviceId === ids[0],
    '点谁就是谁（点了 ' + ids[0] + '，收到 ' + action.deviceId + '）')
  client.send({ type: 'action-result', id: action.id, ok: true })

  // 另一半症状：点击正好赶上一轮刷新。更新和点击挤在一起，click 既不能丢也不能错。
  client.send({ type: 'debug-dispatch', phase: 'move', x: selfCenter.x, y: selfCenter.y })
  await waitUntil(async () => (await client.rendererState()).controls.popover !== null, 3000, '再次打开弹层')
  state = await client.rendererState()
  const visitAgain = state.uiRects.find((rect) => rect.id === 'ui:btn:open-street')
  client.send({ type: 'debug-dispatch', phase: 'click', x: rectCenterScreen(visitAgain, workArea).x,
    y: rectCenterScreen(visitAgain, workArea).y })
  await waitUntil(async () => (await client.rendererState()).controls.streetOpen === true, 3000, '面板再次打开')

  state = await client.rendererState()
  const again = state.uiRects.find((rect) => rect.id === 'ui:street:visit:' + ids[0])
  assert(Boolean(again), '重开的面板里仍能找到最上面那一户')
  const midPoint = rectCenterScreen(again, workArea)
  client.send({ type: 'update', scene: sceneWith([5, 4, 3, 2, 1, 0]) })
  const inflightStart = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'click', x: midPoint.x, y: midPoint.y })
  const inflight = await client.waitFrom(inflightStart, (event) => event.type === 'action', 3000, '抢在刷新里点击')
  assert(inflight.deviceId === ids[0],
    '刷新和点击挤在一起也不能点错（点了 ' + ids[0] + '，收到 ' + inflight.deviceId + '）')
  client.send({ type: 'action-result', id: inflight.id, ok: true })

  client.send({ type: 'quit' })
  return null
}

// ---------------------------------------------------------------------------
// 礼物卡（ticket 23）：字条卡片 / 复制 / 扔掉
// ---------------------------------------------------------------------------

async function verifyGifts () {
  // 缩略图要真的是一张图：先写进 gifts 根，再让渲染端通过 dshzoo://gifts/<目录>/<文件> 读它。
  const giftDir = join(GIFTS_ROOT, GIFT_THUMB_DIR)
  mkdirSync(giftDir, { recursive: true })
  const thumbFile = join(giftDir, '照片.png')
  const thumbImage = { width: 96, height: 64, data: Buffer.alloc(96 * 64 * 4) }
  for (let y = 0; y < thumbImage.height; y += 1) {
    for (let x = 0; x < thumbImage.width; x += 1) {
      const index = (y * thumbImage.width + x) * 4
      thumbImage.data[index] = 60 + Math.round((x / thumbImage.width) * 160)
      thumbImage.data[index + 1] = 120
      thumbImage.data[index + 2] = 200
      thumbImage.data[index + 3] = 255
    }
  }
  writeFileSync(thumbFile, encodePng(thumbImage))

  const client = createHelperClient((line) => info(line), ['--dsh-zoo-gifts', GIFTS_ROOT])
  const readyMark = client.mark()
  const ready = await client.waitFrom(readyMark, (event) => event.type === 'ready', 15000, 'ready')
  const workArea = ready.workArea
  const visitorId = '55555555-5555-4555-8555-555555555555'
  const giftId = '66666666-6666-4666-8666-666666666666'
  const outside = { x: workArea.x + 8, y: workArea.y + 8 }
  const giftText = '第一行：到你家门口了\n第二行：带了张便条\n第三行：记得看'

  // 冒烟只走合成输入：真实鼠标/焦点事件不能干扰点击。
  client.send({ type: 'debug-lock-input', locked: true })
  await sleep(150)

  const textGift = {
    deviceId: visitorId,
    giftId,
    kind: 'text',
    status: 'received',
    title: '「阿蟹」捎来一张字条',
    text: giftText
  }
  const sceneWithGift = (gift = textGift) => shared.petScene([
    { id: 'self', role: 'self', label: '小蓝', anim: '东张西望', color: shared.PET_COLORS[0] },
    { id: 'visitor:' + visitorId, role: 'visitor', label: '阿蟹', anim: '螃蟹走路', color: shared.PET_COLORS[1] }
  ], workArea, {
    reset: true,
    controls: {
      visit: { enabled: false, reason: null },
      recall: { enabled: false, nickname: null },
      visitors: [{ deviceId: visitorId, label: '阿蟹' }],
      street: [],
      prompt: null,
      notice: null,
      gifts: [gift]
    }
  })

  client.send({ type: 'update', scene: sceneWithGift() })
  await sleep(1800)

  let state = await client.rendererState()
  assert(state.controls.gifts.length === 1, '场景里的一张礼物卡被画出来')
  assert(state.controls.gifts[0].giftId === giftId, '卡片带着 giftId（' + state.controls.gifts[0].giftId + '）')
  assert(state.controls.gifts[0].title === '「阿蟹」捎来一张字条', '标题来自宿主')
  assert(state.controls.gifts[0].text === giftText, '正文保留换行、没有被折成一行')
  const cardRect = state.uiRects.find((rect) => rect.id === 'ui:gift:' + giftId)
  const copyRect = state.uiRects.find((rect) => rect.id === 'ui:gift-btn:gift-copy:' + giftId)
  const discardRect = state.uiRects.find((rect) => rect.id === 'ui:gift-btn:gift-discard:' + giftId)
  assert(Boolean(cardRect), '礼物卡有独立命中矩形')
  assert(Boolean(copyRect) && Boolean(discardRect), '礼物卡按钮的矩形带 giftId（两张卡不撞名）')
  assert(Boolean(state.uiRects.find((rect) => rect.id === 'ui:gift-bridge:' + giftId)), '卡片与访客之间有桥接矩形')
  const current = await client.status()
  assert(current.overlayRects >= 6, '礼物卡 + 按钮 + 桥接都进了 overlay-rects（' + current.overlayRects + ' 块）')

  // 截图：卡片真的被画出来（不是只有矩形）。
  mkdirSync(OUT_DIR, { recursive: true })
  const pngPath = join(OUT_DIR, 'gift-card.png')
  let start = client.mark()
  client.send({ type: 'shot', id: 'shot-gift', path: pngPath })
  const shot = await client.waitFrom(start, (event) => event.type === 'shot' && event.id === 'shot-gift', 8000, '礼物卡截图')
  assert(shot.width > 0 && existsSync(pngPath), '礼物卡截图落盘：' + pngPath)
  const verified = verifyShot(pngPath, pngPath + '.json', 2)
  assertControlPixels(verified, [cardRect, copyRect, discardRect])

  // 点「复制」：请求只带 giftId；宿主回 ok + 一句人话，渲染端要冒泡。
  const copyPoint = rectCenterScreen(copyRect, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'click', x: copyPoint.x, y: copyPoint.y })
  const copyAction = await client.waitFrom(start, (event) => event.type === 'action', 3000, '复制申请')
  assert(copyAction.action === 'gift-copy', '点「复制」→ 宿主收到 gift-copy')
  assert(copyAction.giftId === giftId, '礼物动作带 giftId（' + copyAction.giftId + '）')
  assert(typeof copyAction.id === 'string' && copyAction.id !== '', 'action 带 id，宿主才能对上是哪一次点击')
  client.send({ type: 'action-result', id: copyAction.id, ok: true, notice: '字条已经复制到剪贴板。' })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.controls.notice !== null && /复制到剪贴板/.test(snapshot.controls.notice.text)
  }, 2500, '复制成功的气泡')
  state = await client.rendererState()
  assert(state.controls.gifts.length === 1, '复制之后卡片还在')

  // 点「扔掉」：宿主 ok 之后场景里不再有这件礼物 → 卡片与矩形一起收起。
  const discardPoint = rectCenterScreen(discardRect, workArea)
  start = client.mark()
  client.send({ type: 'debug-dispatch', phase: 'click', x: discardPoint.x, y: discardPoint.y })
  const discardAction = await client.waitFrom(start, (event) => event.type === 'action', 3000, '扔掉申请')
  assert(discardAction.action === 'gift-discard', '点「扔掉」→ 宿主收到 gift-discard')
  assert(discardAction.giftId === giftId, '扔掉带的是这一张卡的 giftId')
  client.send({ type: 'action-result', id: discardAction.id, ok: true })
  const withoutGift = sceneWithGift()
  withoutGift.controls.gifts = []
  client.send({ type: 'update', scene: withoutGift })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.controls.gifts.length === 0 &&
      !snapshot.uiRects.some((rect) => rect.id.startsWith('ui:gift:'))
  }, 2500, '扔掉后卡片消失')
  state = await client.rendererState()
  assert(state.controls.gifts.length === 0, '扔掉之后卡片从场景里消失')
  assert(!state.uiRects.some((rect) => rect.id.startsWith('ui:gift')), '礼物卡的所有命中矩形都撤掉了')

  // -----------------------------------------------------------------------
  // ticket 25：文件卡片 + 图片缩略图。
  // 缩略图是 dshzoo://gifts（CSP img-src 必须放行），用 rendererState 的
  // thumb.loaded 证明图片真的解码成功；截图侧再确认卡片画出来了。
  // -----------------------------------------------------------------------
  const imageGiftId = '77777777-7777-4777-8777-777777777777'
  const imageGift = {
    deviceId: visitorId,
    giftId: imageGiftId,
    kind: 'file',
    status: 'received',
    title: '「阿蟹」捎来一个文件',
    name: '照片.png',
    size: 2048,
    thumb: 'dshzoo://gifts/' + GIFT_THUMB_DIR + '/' + encodeURIComponent('照片.png')
  }
  client.send({ type: 'update', scene: sceneWithGift(imageGift) })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    const card = snapshot.controls.gifts[0]
    return card?.kind === 'file' && card.thumb?.loaded === true
  }, 3000, '图片缩略图解码成功')
  // 宠物刚被 reset 重新出生，卡片跟着访客移动；等物理稳定再取矩形/截图，否则矩形会过期。
  await sleep(1800)
  state = await client.rendererState()
  assert(state.controls.gifts[0].kind === 'file', '文件卡片画出来了（kind=file）')
  assert(state.controls.gifts[0].name === '照片.png', '卡片带文件名（' + state.controls.gifts[0].name + '）')
  assert(state.controls.gifts[0].size === 2048, '卡片带文件大小')
  assert(state.controls.gifts[0].thumb !== null && state.controls.gifts[0].thumb.loaded === true,
    'dshzoo://gifts 的缩略图真的解码了（CSP + 协议都通）')
  assert(state.controls.gifts[0].copyVisible === false, '文件卡片不显示「复制」')
  const imageCardRect = state.uiRects.find((rect) => rect.id === 'ui:gift:' + imageGiftId)
  assert(Boolean(imageCardRect), '文件卡片有独立命中矩形')
  const imagePath = join(OUT_DIR, 'gift-image.png')
  start = client.mark()
  client.send({ type: 'shot', id: 'shot-gift-image', path: imagePath })
  const imageShotEvent = await client.waitFrom(start, (event) => event.type === 'shot' && event.id === 'shot-gift-image', 8000, '图片礼物卡截图')
  assert(imageShotEvent.width > 0 && existsSync(imagePath), '图片礼物卡截图落盘：' + imagePath)
  const imageVerified = verifyShot(imagePath, imagePath + '.json', 2)
  assertControlPixels(imageVerified, [imageCardRect])

  // 非图片文件：没有 thumb，渲染端画文件图标 + 文件名 + 大小。
  const fileGiftId = '88888888-8888-4888-8888-888888888888'
  const fileGift = {
    deviceId: visitorId,
    giftId: fileGiftId,
    kind: 'file',
    status: 'received',
    title: '「阿蟹」捎来一个文件',
    name: '报价单.pdf',
    size: 23194
  }
  client.send({ type: 'update', scene: sceneWithGift(fileGift) })
  await waitUntil(async () => {
    const snapshot = await client.rendererState()
    return snapshot.controls.gifts[0]?.giftId === fileGiftId && snapshot.controls.gifts[0]?.thumb === null
  }, 3000, '非图片文件卡片（没有缩略图）')
  await sleep(1800)
  state = await client.rendererState()
  assert(state.controls.gifts[0].name === '报价单.pdf', '非图片文件卡片显示文件名')
  const fileCardRect = state.uiRects.find((rect) => rect.id === 'ui:gift:' + fileGiftId)
  assert(Boolean(fileCardRect), '非图片文件卡片有命中矩形')
  const filePath = join(OUT_DIR, 'gift-file.png')
  start = client.mark()
  client.send({ type: 'shot', id: 'shot-gift-file', path: filePath })
  const fileShotEvent = await client.waitFrom(start, (event) => event.type === 'shot' && event.id === 'shot-gift-file', 8000, '文件礼物卡截图')
  assert(fileShotEvent.width > 0 && existsSync(filePath), '文件礼物卡截图落盘：' + filePath)
  const fileVerified = verifyShot(filePath, filePath + '.json', 2)
  assertControlPixels(fileVerified, [fileCardRect])

  // 截图存进仓库的 notes 目录（25- 前缀，棋盘格合成 + 卡片特写），方便人工复核。
  const noteCard = writeGiftNote(verified, cardRect, '25-gift-card.png')
  const noteImage = writeGiftNote(imageVerified, imageCardRect, '25-gift-image.png')
  const noteFile = writeGiftNote(fileVerified, fileCardRect, '25-gift-file.png')
  if (noteImage !== null) info('截图笔记：' + noteImage + ' / ' + noteFile)

  // 送达到没送达的两句气泡（ticket 26）：宿主给 `controls.notice`，渲染端只负责冒泡。
  // 文案直接用 `src/gift-text.js` 的真身，别在这里重写一遍中文——两处各写一句迟早不一样。
  const noticeShots = []
  for (const [suffix, text] of [
    ['received', giftReceivedText('阿蟹')],
    ['not-received', giftNotReceivedText()]
  ]) {
    client.send({
      type: 'update',
      scene: shared.petScene([
        { id: 'self', role: 'self', label: '小蓝', anim: '东张西望', color: shared.PET_COLORS[0] }
      ], workArea, {
        reset: false,
        controls: {
          visit: { enabled: true, reason: null },
          recall: { enabled: false, nickname: null },
          visitors: [],
          street: [],
          prompt: null,
          gifts: [],
          notice: { text, at: Date.now() }
        }
      })
    })
    await sleep(700)
    const noticeState = await client.rendererState()
    assert(noticeState.controls.notice !== null && noticeState.controls.notice.text === text,
      '礼物气泡进到渲染端（' + suffix + '）')
    const noticePath = join(OUT_DIR, 'gift-notice-' + suffix + '.png')
    const noticeMark = client.mark()
    client.send({ type: 'shot', id: 'shot-gift-notice-' + suffix, path: noticePath })
    const noticeShot = await client.waitFrom(
      noticeMark,
      (event) => event.type === 'shot' && event.id === 'shot-gift-notice-' + suffix,
      8000,
      '礼物气泡截图 ' + suffix
    )
    assert(noticeShot.width > 0 && existsSync(noticePath), '礼物气泡截图落盘：' + noticePath)
    const note = writeNoticeNote(verifyShot(noticePath, noticePath + '.json', 1), '26-gift-notice-' + suffix + '.png')
    if (note !== null) noticeShots.push(note)
  }

  // 光标移开 → 恢复穿透（没关掉的控件不该把整窗一直按着）。
  client.send({ type: 'pointer', x: outside.x, y: outside.y })
  await waitUntil(async () => (await client.status()).ignoring === true, 3000, '礼物卡收起后恢复穿透')

  return {
    pngPath,
    sidecarPath: pngPath + '.json',
    verified,
    imagePath,
    filePath,
    imageVerified,
    fileVerified,
    noteCard,
    noteImage,
    noteFile
  }
}

// ---------------------------------------------------------------------------
// 2.5) 「带派」小窗（ticket 24）：真窗口打开 + 背包列表 + 截图
// ---------------------------------------------------------------------------

async function verifyBringWindow () {
  const client = createHelperClient((line) => info(line))
  const readyMark = client.mark()
  const ready = await client.waitFrom(readyMark, (event) => event.type === 'ready', 15000, 'ready')
  assert(ready.workArea.width > 0, '带派小窗用例拿到工作区')

  client.send({
    type: 'update',
    scene: shared.petScene([
      { id: 'self', role: 'self', label: '小蓝', anim: '东张西望', color: shared.PET_COLORS[0] }
    ], ready.workArea)
  })
  await sleep(800)

  const idleFile = '99999999-9999-4999-8999-999999999998'
  // 宿主交下来的背包快照：一件能撤的文件 → 截图里能看到列表、可用的撤掉按钮与可用的提交按钮。
  client.send({
    type: 'bring-window',
    open: true,
    items: [
      { id: idleFile, kind: 'file', name: '报价单.pdf', state: 'idle' }
    ]
  })
  await client.waitStatus((status) => status.bringOpen === true, 5000, '「带派」小窗打开')
  await sleep(900)

  // 和改名窗同一条：字条要能打中文，输入法候选窗触发的 blur 不能关窗。
  client.send({ type: 'debug-blur', window: 'bring' })
  await sleep(450)
  const afterBlur = await client.status()
  assert(afterBlur.bringOpen === true, '失焦不关「带派」小窗（输入法候选窗会触发 blur）')

  const pngPath = join(OUT_DIR, 'bring.png')
  const start = client.mark()
  client.send({ type: 'shot', id: 'smoke-bring-shot', path: pngPath, window: 'bring' })
  const shot = await client.waitFrom(start, (event) => event.type === 'shot', 6000, '「带派」小窗截图')
  assert(shot.width > 0 && shot.height > 0, '「带派」小窗有真实尺寸（' + shot.width + '×' + shot.height + '）')
  assert(existsSync(pngPath), '「带派」小窗截图落盘：' + pngPath)

  const image = decodePng(readFileSync(pngPath))
  assert(image.width >= 300 && image.height >= 300, '截图尺寸与窗口一致（' + image.width + '×' + image.height + '）')
  let visible = 0
  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index] > 16) visible += 1
  }
  assert(visible > image.width * image.height * 0.2,
    '小窗里画出了可见内容（' + visible + '/' + (image.width * image.height) + ' px）')

  let notePath = null
  if (WRITE_NOTES) {
    mkdirSync(NOTES_DIR, { recursive: true })
    const composite = compositeOverCheckerboard(image)
    notePath = join(NOTES_DIR, '12-bring-window-composited.png')
    writeFileSync(notePath, encodePng(composite))
    info('带派小窗截图笔记：' + notePath)
  }

  // 撤掉：点列表里的「撤掉」，helper 必须报一条带 giftId 的 unbring 申请。
  const removeMark = client.mark()
  client.send({ type: 'debug-gift-remove', id: 'smoke-bring-remove' })
  let removeRequest
  try {
    removeRequest = await client.waitFrom(
      removeMark,
      (event) => event.type === 'action' && event.action === 'unbring',
      5000,
      '「撤掉」申请'
    )
  } catch (error) {
    console.error('[diag] events=' + JSON.stringify(client.events.slice(-8)))
    throw error
  }
  assert(removeRequest.giftId === idleFile, '「撤掉」带的是那一条的 giftId（' + removeRequest.giftId + '）')
  client.send({ type: 'action-result', id: removeRequest.id, ok: true })

  // 小窗 → 主进程 → 宿主：在真渲染进程里填字条并点提交，helper 必须报一条 action 申请。
  const submitText = '从窗口里放进来的字条'
  const actionMark = client.mark()
  client.send({ type: 'debug-gift-submit', id: 'smoke-bring-submit', text: submitText })
  const action = await client.waitFrom(
    actionMark,
    (event) => event.type === 'action' && event.action === 'bring',
    5000,
    '「带派」小窗提交为一次 action 申请'
  )
  assert(typeof action.id === 'string' && action.id !== '', '提交申请带 action id')
  assert(
    JSON.stringify(action.gift) === JSON.stringify({ kind: 'text', text: submitText }),
    '申请里带的就是窗口里写的那段字条（' + JSON.stringify(action.gift) + '）'
  )
  assert(action.deviceId === null, '带派申请不夹带邻居身份')

  // 宿主答复成功：主进程应该把这扇窗关掉（“放进背包”成功即收窗）。
  const closeMark = client.mark()
  client.send({ type: 'action-result', id: action.id, ok: true })
  await client.waitStatus((status) => status.bringOpen === false, 4000, '提交成功后小窗关闭')
  assert(closeMark > 0, '关窗走的是 action-result（先记了事件起点）')

  client.send({ type: 'quit' })
  const exit = await Promise.race([client.exited, sleep(10000).then(() => null)])
  assert(exit !== null, '带派小窗用例结束后 helper 自己退出')
  return { pngPath, notePath }
}

async function verifyManager () {
  const infos = []
  const warns = []
  const manager = createDesktop({
    desktopHost: true,
    platform: process.platform,
    debug: true,
    assetRoots: ASSET_ROOTS,
    log: { info: (line) => { infos.push(line); info(line) }, warn: (line) => { warns.push(line); info(line) } }
  })
  try {
    const started = manager.start()
    assert(started.ok === true, 'manager 启动 helper（pid ' + started.pid + '）')
    await waitUntil(() => manager.status().ready, 15000, 'manager ready')
    const workArea = manager.status().workArea
    assert(workArea.width > 0, 'manager 收到 ready 工作区')
    assert(manager.status().assetRoots.length === ASSET_ROOTS.length, 'manager 把素材目录传给了 helper')
    const scene = shared.petScene([
      { id: 'self', role: 'self', label: '小蓝', anim: '东张西望', color: shared.PET_COLORS[0] },
      { id: 'guest:manager', role: 'guest', label: '阿蟹', anim: '螃蟹走路', color: shared.PET_COLORS[1] }
    ], workArea)
    assert(manager.update(scene) === true, 'manager 把宠物场景写进 stdin')
    await sleep(1400)
    const status = await manager.requestStatus()
    assert(status.ok === true && status.status.sceneItems === 2, 'helper 应用了宠物场景（sceneItems=2）')
    const pngPath = join(OUT_DIR, 'manager.png')
    const shot = await manager.shot(pngPath)
    assert(shot.ok === true && existsSync(pngPath), 'manager 的 shot 命令落盘（' + shot.width + '×' + shot.height + '）')
    verifyShot(pngPath, pngPath + '.json', 2)

    const firstPid = manager.pid
    process.kill(firstPid, 'SIGKILL')
    await waitUntil(() => manager.status().pid !== null && manager.status().pid !== firstPid, 8000, '崩溃后重启')
    assert(warns.some((line) => /退出/.test(line) && /重启/.test(line)), '宿主为 helper 崩溃打了一行日志')
    assert(manager.status().restarts === 1, '重启计数 = 1')
    await waitUntil(() => manager.status().ready, 10000, '重启后 ready')
    // 强制整包对账：即使场景没变也让渲染端重新出生（helper 重启后宿主可以这么做）
    assert(manager.resync({ ...scene, reset: false }) === true, 'manager.resync 能强制整包对账')
    await sleep(500)
    const status2 = await manager.requestStatus()
    assert(status2.ok === true && status2.status.sceneItems === 2, '重启后场景生效')

    const secondPid = manager.pid
    manager.dispose()
    await waitUntil(() => !pidAlive(secondPid), 5000, 'dispose 后 helper 消失')
    assert(manager.status().running === false, 'dispose 后 manager 不再报告运行')
    assert(!pidAlive(firstPid) && !pidAlive(secondPid), '两个 helper 进程都已离开')
  } finally {
    manager.dispose()
  }

  // 不可用：只打一行、不 spawn
  const unavailableInfos = []
  const unavailable = createDesktop({
    desktopHost: false,
    log: { info: (line) => unavailableInfos.push(line), warn: (line) => unavailableInfos.push(line) }
  })
  const unavailableResult = unavailable.start()
  assert(unavailableResult.reason === 'not-desktop-host', 'web profile / 非桌面宿主 → not-desktop-host')
  assert(unavailableInfos.length === 1, '降级只打一行日志')
  unavailable.dispose()

  const missingWarns = []
  const missing = createDesktop({
    desktopHost: true,
    platform: process.platform,
    env: { DSH_HOME: '/nonexistent-dsh-home-for-smoke' },
    exists: () => false,
    log: { info: () => {}, warn: (line) => missingWarns.push(line) }
  })
  const missingResult = missing.start()
  assert(missingResult.reason === 'electron-missing', 'Electron 缺失 → electron-missing')
  assert(missingWarns.length === 1, 'Electron 缺失只打一行日志')
  missing.dispose()
}

// ---------------------------------------------------------------------------
// 4) 宿主被 SIGKILL：helper 必须自己发现并退出
// ---------------------------------------------------------------------------

async function verifyHostKill () {
  const hostScript = join(OUT_DIR, 'host-child.mjs')
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(hostScript, `
import { createDesktop } from ${JSON.stringify(new URL('../src/desktop.js', import.meta.url).href)}
const manager = createDesktop({
  desktopHost: true,
  platform: process.platform,
  assetRoots: ${JSON.stringify(ASSET_ROOTS)},
  log: { info() {}, warn() {} }
})
const started = manager.start()
process.stdout.write(JSON.stringify(started) + '\\n')
setInterval(() => {}, 1000)
`, 'utf8')
  const host = spawn(process.execPath, [hostScript], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  spawned.push(host)
  let stdout = ''
  host.stdout.setEncoding('utf8')
  host.stdout.on('data', (chunk) => { stdout += chunk })
  let stderr = ''
  host.stderr.setEncoding('utf8')
  host.stderr.on('data', (chunk) => { stderr += chunk })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !stdout.includes('\n')) await sleep(50)
  const line = stdout.split('\n').find((candidate) => candidate.includes('"pid"'))
  assert(Boolean(line), '宿主子进程拉起了 helper')
  const started = JSON.parse(line)
  const helperPid = started.pid
  assert(pidAlive(helperPid), 'helper 在跑（pid ' + helperPid + '）')

  process.kill(host.pid, 'SIGKILL')
  const gone = await waitUntil(() => !pidAlive(helperPid), 10000, '宿主被杀后 helper 自行退出')
  assert(gone, '宿主被 SIGKILL 后，helper 在 10s 内自行退出（host-liveness / 管道断开）')
  if (stderr.trim() !== '') info('宿主子进程 stderr：' + stderr.trim().slice(0, 500))
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function cleanup () {
  for (const child of spawned) {
    try {
      if (child.exitCode === null) child.kill('SIGKILL')
    } catch {
      // ignore
    }
  }
}

/**
 * 只跑某一段（排查用）：`DSH_ZOO_SMOKE_ONLY=controls`。
 * 默认什么都不设就跑全部；跳过任何一段都会在输出里写明，不许静默变成“全绿”。
 */
const ONLY = typeof process.env.DSH_ZOO_SMOKE_ONLY === 'string' && process.env.DSH_ZOO_SMOKE_ONLY.trim() !== ''
  ? process.env.DSH_ZOO_SMOKE_ONLY.trim()
  : null

function wants (name) {
  if (ONLY === null) return true
  const skip = ONLY !== name
  if (skip) console.log('# 跳过：' + name + '（DSH_ZOO_SMOKE_ONLY=' + ONLY + '）')
  return !skip
}

let exitCode = 0
let shot = null
try {
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  console.log('Electron: ' + (resolveElectronBinary({}).path ?? '未找到'))
  console.log('dsh-pet 素材: ' + (ASSET_ROOTS.length > 0 ? ASSET_ROOTS.join(' | ') : '未找到（将退化为 SVG 色块）'))
  console.log('输出目录: ' + OUT_DIR)
  if (WRITE_NOTES) console.log('截图笔记: ' + NOTES_DIR)
  const standalone = wants('shot') ? await run('截图模式：三只演示宠物 + 透明背景 + 真实素材', verifyShotMode) : null
  if (wants('svg')) await run('降级：没有 dsh-pet 素材时退到内置 SVG 色块', verifySvgFallback)
  if (wants('helper')) await run('helper：点击穿透 / 输入租约 / 物理 / 场景 v2 / 截图 / quit', verifyHelper)
  const controls = wants('controls') ? await run('控件：悬停弹层 / 点击穿透（A2）/ 租约 fail-closed（A3）/ 街道面板 / 串门申请 / 失败气泡 / 放行卡 / 送客 / 召回', verifyControls) : null
  if (wants('menu')) await run('右键菜单：只挂自己 / 三级级联 / 点一项就申请点播 / 访客不弹', verifyMenu)
  if (wants('street')) await run('街道：人多时面板不跳、点谁就是谁', verifyStreetStability)
  const gifts = wants('gift') ? await run('礼物卡：字条卡片 / 复制 / 扔掉 / 命中矩形', verifyGifts) : null
  const bring = wants('bring') ? await run('带派小窗：真窗口打开 / 背包列表 / 截图 / 退出', verifyBringWindow) : null
  if (wants('manager')) await run('manager：ready / update / resync / shot / 崩溃重启 / dispose', verifyManager)
  if (wants('kill')) await run('生命周期：宿主被 SIGKILL 后 helper 自行退出', verifyHostKill)
  const notes = standalone === null ? null : writeNoteScreenshots(standalone.verified)
  const controlNotes = controls === null ? null : writeControlNotes(controls.verified, controls.noticeVerified)
  if (notes !== null) {
    console.log('\n截图笔记：')
    console.log('  整窗（棋盘格合成）: ' + notes.fullPath)
    console.log('  宠物特写（棋盘格合成）: ' + notes.cropPath)
  }
  if (controlNotes !== null) {
    console.log('  控件整窗（棋盘格合成）: ' + controlNotes.fullPath)
    console.log('  控件特写（棋盘格合成）: ' + controlNotes.cropPath)
    console.log('  失败气泡特写（棋盘格合成）: ' + controlNotes.noticePath)
  }
  console.log('\n通过（' + checks + ' 项断言' + (ONLY === null ? '，全部段落' : '，只跑了 ' + ONLY) + '）。')
  console.log('交互截图：' + join(OUT_DIR, 'helper.png'))
  if (controls !== null) console.log('控件截图：' + controls.pngPath)
  if (gifts !== null) {
    console.log('礼物卡截图：' + gifts.pngPath)
    console.log('图片礼物卡截图：' + gifts.imagePath)
    console.log('文件礼物卡截图：' + gifts.filePath)
  }
  if (bring !== null) {
    console.log('带派小窗截图：' + bring.pngPath)
    if (bring.notePath !== null) console.log('  带派小窗（棋盘格合成）: ' + bring.notePath)
  }
  if (standalone !== null) console.log('截图模式输出：' + standalone.pngPath)
} catch (error) {
  exitCode = 1
  console.error('\n冒烟失败：' + (error instanceof Error ? error.message : String(error)))
  if (error instanceof Error && error.stack) console.error(error.stack)
  console.error('辅助日志目录：' + OUT_DIR)
} finally {
  cleanup()
}
process.exit(exitCode)
