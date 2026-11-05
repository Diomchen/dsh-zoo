#!/usr/bin/env node
// 把本插件装进某个 DSH profile。
//
// 为什么手写而不是走 pnpm：这条机器上没有 pnpm 在 PATH 上，而这里要做的其实只有两件事——
// 在 node_modules 里放一个指向本仓库的符号链接（pnpm 的 link: 依赖也是这么干的），
// 以及把这个包名登记进 profile 的 bundles 层栈。
//
// 用法：node scripts/install.mjs [--profile desktop] [--home <DSH_HOME>] [--dry-run]
//
// 安全：改 profile 的 package.json 之前先写一份 .bak；任何一步失败都会回滚并报错。
// 卸载：node scripts/uninstall.mjs（同一个 profile 参数）。

import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = 'dsh-zoo'
/** 改名前的包名：装新包时顺手摘掉，避免 DSH 同时加载两份、画两只桌宠。 */
const LEGACY_PKGS = ['dsh-local-pet']
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = parseArgs(process.argv.slice(2))
const home = args.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profile = args.profile ?? 'desktop'
const profileDir = join(home, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', PKG)

main().catch((error) => {
  console.error('[install] 失败：' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})

async function main () {
  if (!existsSync(manifestPath)) {
    throw new Error(`找不到 profile 清单：${manifestPath}（用 --profile 指定另一个 profile）`)
  }

  const raw = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(raw)
  const before = { deps: { ...(manifest.dependencies ?? {}) }, bundles: [...(manifest.dsh?.profile?.bundles ?? [])] }

  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dependencies[PKG] = 'link:' + REPO
  const removedDeps = []
  for (const legacy of LEGACY_PKGS) {
    if (Object.prototype.hasOwnProperty.call(manifest.dependencies, legacy)) {
      delete manifest.dependencies[legacy]
      removedDeps.push(legacy)
    }
  }
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = (manifest.dsh.profile.bundles ?? []).filter((name) => !LEGACY_PKGS.includes(name))
  if (!bundles.includes(PKG)) bundles.push(PKG)
  manifest.dsh.profile.bundles = bundles

  console.log(`[install] profile : ${profileDir}`)
  console.log(`[install] 依赖     : ${PKG} -> link:${REPO}`)
  if (removedDeps.length > 0) console.log(`[install] 旧名字   : 摘掉 ${removedDeps.join(', ')}${args['dry-run'] ? '（dry-run 只是展示）' : ''}`)
  console.log(`[install] bundles  : ${bundles.join(' → ')}`)

  if (args['dry-run']) {
    console.log(JSON.stringify({ before, after: manifest.dsh.profile.bundles }, null, 2))
    console.log('[install] dry-run，什么都没改')
    return
  }

  const backup = manifestPath + '.bak'
  await copyFile(manifestPath, backup)
  try {
    await mkdir(dirname(linkPath), { recursive: true })
    await rm(linkPath, { force: true, recursive: false })
    // Windows 上建目录符号链接需要开发者模式/管理员；junction 不需要，效果一样是「指向本仓库」。
    await symlink(REPO, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    for (const legacy of LEGACY_PKGS) {
      // 旧版本可能是 pnpm 装的真实目录，也可能是 link: 的符号链接；两种都摘掉。
      await rm(join(profileDir, 'node_modules', legacy), { force: true, recursive: true }).catch(() => {})
    }
  } catch (error) {
    await writeFile(manifestPath, raw, 'utf8')
    await rm(linkPath, { force: true }).catch(() => {})
    throw error
  }

  console.log('[install] 装好了。')
  console.log('[install] 下一步：重启 DSH（新插件的宿主半边需要重新加载），然后打开 GUI 看右下角。')
  console.log(`[install] 反悔：node scripts/uninstall.mjs --profile ${profile}${args.home ? ' --home ' + args.home : ''}`)
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
