import { createService } from './src/service.js'

export const name = 'local-pet'

/** 宿主半侧只需要 webserver：给本地浏览器开一个只读入口。 */
export const inject = ['webServer']

/**
 * 入口。整段包在 try/catch 里：插件坏掉时应该是一行日志，而不是让 DSH 起不来。
 */
export function apply (ctx) {
  let service
  try {
    service = createService(ctx)
  } catch (error) {
    warn(ctx, '初始化失败，客厅不会出现：' + describe(error))
    return
  }

  try {
    ctx.effect(() => () => service.dispose(), 'local-pet: lifecycle')
  } catch (error) {
    warn(ctx, '生命周期挂载失败：' + describe(error))
    service.dispose()
  }
}

function warn (ctx, message) {
  const line = '[dsh-local-pet] ' + message
  try {
    if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(line)
    else console.warn(line)
  } catch {
    // 日志本身也不能让插件崩掉
  }
}

function describe (error) {
  return error instanceof Error ? error.message : String(error)
}
