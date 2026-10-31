import { homedir } from 'node:os'
import { join } from 'node:path'

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
  return join(dshHome(env), 'local-pet')
}

/**
 * dsh-pet 的用户配置（JSONC）。它的接口未承诺，但路径是它的公开约定：
 * 名字取这里的第一只宠物，动作取它 `/state` 的 anim 叶子。
 */
export function dshPetConfigPath (env = process.env) {
  return join(dshHome(env), 'dsh-pet', 'main-config.jsonc')
}
