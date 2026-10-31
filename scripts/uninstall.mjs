#!/usr/bin/env node
// install.mjs 的逆操作：摘掉 bundles 登记、依赖条目和 node_modules 链接。
// 不动任何用户数据（<DSH_HOME>/local-pet/ 原样留着，想彻底清干净自己删那个目录）。

import { rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PKG = 'dsh-local-pet'

const args = parseArgs(process.argv.slice(2))
const home = args.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profile = args.profile ?? 'desktop'
const profileDir = join(home, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', PKG)

main().catch((error) => {
  console.error('[uninstall] 失败：' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})

async function main () {
  if (!existsSync(manifestPath)) throw new Error('找不到 profile 清单：' + manifestPath)

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  delete manifest.dependencies?.[PKG]
  const bundles = manifest.dsh?.profile?.bundles ?? []
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  manifest.dsh.profile.bundles = bundles.filter((name) => name !== PKG)

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  await rm(linkPath, { force: true }).catch(() => {})

  console.log('[uninstall] 已从 ' + profileDir + ' 摘掉 ' + PKG)
  console.log('[uninstall] 用户数据仍在：' + join(home, 'local-pet') + '（想清空就删掉它）')
  console.log('[uninstall] 重启 DSH 生效。')
}

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}
