import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 本机数据目录名；改名后是 dsh-zoo。 */
export const DATA_DIR_NAME = 'dsh-zoo'
/** 改名前的数据目录名；只在首次启动时整体改名一次。 */
export const LEGACY_DATA_DIR_NAME = 'local-pet'

/**
 * 本机身份与账本都放在这里，与 DSH 自己的目录并列、互不覆盖。
 * 用户删掉整个目录 = 忘掉所有邻居和记录，重新开始。
 */
export function dshHome (env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
}

export function dataDir (env = process.env) {
  return join(dshHome(env), DATA_DIR_NAME)
}

/** 旧名字的数据目录：只用于一次性迁移和「迁移失败时继续用旧数据」。 */
export function legacyDataDir (env = process.env) {
  return join(dshHome(env), LEGACY_DATA_DIR_NAME)
}

/**
 * 让数据目录就位：旧目录整体改名到新名字。
 *
 * 三条规则：
 * - 新目录已经存在 → 用它，旧目录原样不动（可能是用户自己留的备份）；
 * - 只有旧目录 → 一次 rename；成功后新目录就位；
 * - rename 失败（权限、跨设备、Windows 上被占用）→ **继续用旧目录**。
 *   宁可目录名不对，也不能让身份、放行名单、串门记录和礼物消失。
 *
 * 同步执行：只在宿主启动时调用一次，一次 rename 不值得把 createService 变成 async。
 */
export function prepareDataDir (env = process.env, options = {}) {
  const target = dataDir(env)
  const legacy = legacyDataDir(env)
  const exists = typeof options.exists === 'function' ? options.exists : existsSync
  const rename = typeof options.rename === 'function' ? options.rename : renameSync

  if (exists(target)) return { dir: target, migrated: false, fallback: false }
  if (!exists(legacy)) return { dir: target, migrated: false, fallback: false }
  try {
    rename(legacy, target)
    return { dir: target, migrated: true, fallback: false }
  } catch (error) {
    return { dir: legacy, migrated: false, fallback: true, error }
  }
}

/**
 * dsh-pet 的用户配置（JSONC）。它的接口未承诺，但路径是它的公开约定：
 * 名字取这里的第一只宠物，动作取它 `/state` 的 anim 叶子。
 */
export function dshPetConfigPath (env = process.env) {
  return join(dshHome(env), 'dsh-pet', 'main-config.jsonc')
}
