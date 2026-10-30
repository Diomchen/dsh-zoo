import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 本机身份与账本都放在这里，与 DSH 自己的目录并列、互不覆盖。
 * 用户删掉整个目录 = 忘掉所有邻居和记录，重新开始。
 */
export function dataDir (env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'local-pet')
}
