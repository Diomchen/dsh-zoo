/**
 * 桌面 helper 与宿主共用的纯逻辑：stdio 行协议、场景 v3、宠物物理、命中判定、点击穿透的安全裁定。
 *
 * 为什么是 UMD（同时给三种运行环境用）：
 *   - Electron 主进程（desktop/main.js，CJS）—— require('./shared.js')；
 *   - 宿主（src/desktop.js，ESM）—— `import shared from '../desktop/shared.js'`（Node 按最近的
 *     desktop/package.json 把它当 CJS，默认导出即 module.exports）；
 *   - 渲染页（desktop/renderer.js，普通 <script>）—— 挂到 globalThis.DshZooShared。
 * 一份实现、一份测试，避免「主进程的命中判定」和「渲染端的物理/命中」各写一套然后漂移。
 *
 * 坐标约定：
 *   - 场景里的矩形一律是**窗口局部 DIP**（CSS 像素），渲染端直接拿 clientX/clientY 比；
 *   - 主进程拿 screen.getCursorScreenPoint()（屏幕 DIP）减去 win.getBounds() 左上角再比，两者同尺度；
 *   - 窗口 = 所有显示器工作区的并集，因此窗口局部坐标是整张虚拟桌面的局部坐标；
 *     每块屏在其中的位置由场景的 `floors` 给出（物理地面按屏算）。
 *
 * 场景 v2 的分工（ticket 08）：
 *   - 宿主只决定「有谁、叫什么、在播什么」（items 的 id/role/label/anim/color）以及
 *     「能点哪些控件、为什么不能点」（controls，ticket 11），位置只在**新宠物出生**时用
 *     item 的 x/y 作种子；
 *   - 渲染端在本地模拟位置与速度，逐帧把自己的命中矩形报给主进程（ipc `dsh-zoo:rects`）；
 *     弹层/放行卡/召回胶囊的命中矩形走另一条 `dsh-zoo:overlay-rects`；
 *   - 主进程不猜渲染端的位置：命中判定只用渲染端最近上报的矩形（过期就 fail-closed 回穿透）；
 *   - `reset: true` 让渲染端把每只宠物按 item 的 x/y 重新出生一次，用于 helper 重启/强制对账。
 *
 * 安全约定（这一层是点击穿透的「否决权」所在，见 ADR-0005）：
 *   `shouldBeInteractive()` 只在以下两种情况下返回 true：
 *     a) 渲染端拿着输入租约（`busy`，最近 `BUSY_LEASE_MS` 内有心跳，且没有超过 `BUSY_MAX_MS`
 *        的连续持有上限）**并且**光标确实压在一条活的命中矩形上——拖拽时宠物会落后于光标，
 *        所以渲染端会上报一条跟随光标的 `ui:drag` 矩形；租约本身不能单独把整窗变成可交互
 *        （渲染端报一个超大矩形也不行，`normalizeRects` 会拒绝）；
 *     b) 主进程按真实光标位置算出在渲染端上报的命中矩形内，并且渲染端最近 `maxAgeMs` 内确认过
 *        inside（心跳，不是一次性事件）；渲染端完全没消息时按停留时长兜底。
 *   租约总会过期：渲染端崩了/卡了/失联，最多 BUSY_LEASE_MS 后自动恢复穿透；硬上限保证
 *   一个活着但关不掉弹层的渲染端也不能永久占住桌面。
 */

;(function (root, factory) {
  'use strict'
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.DshZooShared = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  /**
   * 单行上限。这条管道只有宿主 ↔ helper 两个进程，没有网络输入；但一条 `update`
   * 要装下整个场景（`MAX_SCENE_ITEMS` 只宠物 + 控件名单），256 位访客时约 70 KiB，
   * 所以留到 256 KiB：仍然是一个硬上限，不会被坏写入撑爆内存。
   */
  const MAX_LINE_LENGTH = 256 * 1024
  /**
   * 场景里最多几个 item。产品上“不设同屏上限”（SPEC v2 / ADR-0006），但一条消息
   * 必须有界：256 位访客已经远超过一个局域网的合理规模。超出时宿主会给一条提示，
   * 不会静默丢掉宠物（见 src/desktop-pets.js 的 droppedVisitors）。
   */
  const MAX_SCENE_ITEMS = 256
  /**
   * 渲染端上报的命中矩形：单边超过这个数只可能是算错了。直接**拒绝**而不是夹小——
   * 夹小会留下一个仍然很大的可交互区，等于没 fail closed。
   */
  const MAX_HIT_RECT_SIZE = 1024
  /** 一条 IPC 最多接受几个命中矩形；与场景上限同量级，控件另有独立通道。 */
  const MAX_HIT_RECTS = 256
  const MAX_ID_LENGTH = 64
  const MAX_LABEL_LENGTH = 40
  const MAX_ANIM_LENGTH = 64
  const MAX_PATH_LENGTH = 1024
  const MAX_ERROR_LENGTH = 500
  const MAX_NOTICE_LENGTH = 200
  /** 素材诊断（ipc `dsh-zoo:media`）：同样来自渲染端，按不可信输入裁。 */
  const MAX_MEDIA_FAILED = 16
  /** 街上最多几户。与 src/street.js 的 MAX_STREET 同一个数：跨进程各自守自己的边界。 */
  const MAX_STREET_ITEMS = 16
  /** 街上「去不了」的三种理由；与 src/street.js 的 blockedReason 同一套词。 */
  const STREET_REASONS = new Set(['not-admitted', 'not-mutual', 'peer-offline'])
  const MAX_REASON_LENGTH = 80
  const MAX_DISPLAYS = 8
  const MAX_COORD = 1e6
  const MAX_ITEM_SIZE = 10000

  /**
   * 右键菜单（ticket 22）。菜单内容由宿主下发，渲染端只画。
   *
   * 一级 = 工具项 + 动作；「动作」下面是分类，分类下面是动画名。
   * 工具项是**固定集合**：渲染端只认这几个 id，不认识的直接丢——宿主不该借菜单下发任意命令。
   */
  const MAX_MENU_TOOLS = 8
  const MAX_MENU_GROUPS = 24
  const MAX_MENU_ACTIONS = 256
  const MENU_TOOL_IDS = ['open-site', 'bring', 'farm', 'home', 'reload', 'scan-skins']

  /** 渲染端「我还在命中区里」的心跳间隔；主进程允许的最大陈旧时间。 */
  const HOVER_HEARTBEAT_MS = 350
  const HOVER_CONFIRM_MAX_AGE_MS = 1200
  /** 主进程按真实光标位置兜底轮询的间隔。 */
  const POINTER_POLL_MS = 100
  /**
   * 渲染端通道完全没消息时，主进程在光标停留多久后自行接管鼠标。
   *
   * 为什么需要它：macOS 上 `forward: true` 依赖 Electron 的鼠标转发钩子，而 helper 是
   * 不抢焦点的后台应用——钩子失效/被系统拦掉时渲染端一个 mousemove 都收不到（本机实测：
   * 光标停在命中区里，渲染端零事件）。没有这条兜底，宠物就永远点不到。
   *
   * 为什么安全：主进程每一拍都按**真实光标位置**复核，光标离开命中矩形 100ms 内必然恢复穿透；
   * 这条兜底最多让「光标正压在宠物上」的那块小矩形暂时接管鼠标，且移动即释放。
   */
  const MAIN_FALLBACK_DWELL_MS = 300

  /**
   * 渲染端上报的命中矩形 / 输入租约的保鲜期。
   *
   * 渲染端在宠物移动时约 30Hz 上报矩形，静止时每 300ms 一次心跳；主进程只认这个窗口内的。
   * 过期 = 渲染端卡死/失联 → 没有命中区、没有租约，整窗回到穿透（fail-closed）。
   */
  const RENDERER_RECT_MAX_AGE_MS = 900
  /** 场景刚更新、渲染端还没上报矩形时的兜底：只用出生矩形，最多这么久。 */
  const SCENE_RECT_FALLBACK_MS = 800
  /** 拖拽/弹层输入租约：渲染端每 BUSY_HEARTBEAT_MS 续一次，主进程超过 BUSY_LEASE_MS 没收到就释放。 */
  const BUSY_HEARTBEAT_MS = 300
  const BUSY_LEASE_MS = 1200
  /**
   * 一条租约连续持有的硬上限。渲染端还活着、却因为 bug 一直续租（例如弹层关不掉）时，
   * 这是主进程最后的 fail-closed 出口：到点收回租约并要求渲染端先显式放手/重新悬停。
   */
  const BUSY_MAX_MS = 30000

  const DEFAULT_COLOR = '#3b74d8'
  const ITEM_KINDS = ['pet', 'card']
  // ticket 44：worker 是「别人家的宠物在我家打工」，与 guest/visitor 都不是一回事。
  const PET_ROLES = ['self', 'guest', 'visitor', 'worker']
  /** 宠物角标的固定枚举（跨进程传输，不能用自由文本）。 */
  const PET_BADGES = ['work']
  const SCENE_VERSION = 3
  /**
   * 农场小窗能提交的动作。地块四条（ticket 40）只带 plotId（种地再带 cropId）；
   * 交易所两条（ticket 41）只带 cropId + qty。数量/价格全由宿主算。
   * 声明必须在 CONTROL_ACTIONS 之前（后者会展开它）。
   */
  const FARM_VISIT_ACTIONS = ['farm-steal', 'farm-help']
  const FARM_PLOT_ACTIONS = [
    'farm-plant',
    'farm-harvest',
    'farm-water',
    'farm-fertilize',
    // ticket 43：访客偷/帮也是地块动作；只带 plotId，visitId/requestId 由宿主生成。
    ...FARM_VISIT_ACTIONS
  ]
  const FARM_MARKET_ACTIONS = ['farm-buy-seed', 'farm-sell-crop']
  /**
   * 雇佣页的四条动作（ticket 44）。字段同样窄：
   *   hire          { deviceId, hours }                    （2–8 小时）
   *   recall-worker { contractId }
   *   end-contract  { contractId }
   *   hire-listing  { enabled, wagePerHour, minHours, maxHours }
   * 总价/手续费/硬币全由宿主算，窗口一概不传。
   */
  const FARM_HIRE_ACTIONS = ['hire', 'recall-worker', 'end-contract', 'hire-listing']
  /**
   * 窗口端倒计时到 0 时请宿主确认成熟（ticket 47.1）。窗口不自己标 mature：
   * 本地时钟可能比宿主早/晚几毫秒，标早了收获会被宿主回 not-mature。
   */
  const FARM_REFRESH_ACTIONS = ['farm-refresh']
  const FARM_ACTIONS = FARM_PLOT_ACTIONS.concat(FARM_MARKET_ACTIONS, FARM_HIRE_ACTIONS, FARM_REFRESH_ACTIONS)
  /**
   * 桌面控件能请求的宿主动作白名单。渲染端只能申请，状态仍由宿主快照回灌。
   * `rename` 是唯一带正文的动作：它把输入框里的新名字交给宿主，由宿主再决定写到哪
   * （装了 dsh-pet 就写它的配置，见 ADR-0007）。
   */
  const CONTROL_ACTIONS = [
    'visit',
    'recall',
    'end-visit',
    'admit',
    'reject',
    'dismiss',
    'rename',
    // ticket 23：礼物卡上的四个动作。渲染端只发 giftId，路径与磁盘操作全在宿主。
    'gift-open',
    'gift-reveal',
    'gift-copy',
    'gift-discard',
    // ticket 24：右键「带派」只发一个空动作，由宿主开小窗；unbring 才带 giftId。
    'bring',
    'unbring',
    // ticket 40/41：农场七条动作。地块只带 plotId（种地再带 cropId），交易所只带 cropId + qty。
    ...FARM_ACTIONS
  ]
  /** 这几个动作必须带 giftId；其余动作带了也会被丢掉。`bring` 例外：它带的是待放物品。 */
  const GIFT_ACTIONS = ['gift-open', 'gift-reveal', 'gift-copy', 'gift-discard', 'unbring']
  /** 菜单项的动作（ticket 22 / 24 / 32 / 40）：点播 / 重载 / 打开软件 / 带派 / 换皮 / 农场。同样只是一次「申请」。 */
  const MENU_ACTION_IDS = ['play-anim', 'reload', 'open-site', 'bring', 'use-skin', 'scan-skins', 'farm-open']
  /** 几张皮的 id 上限与宿主一致：短标识符，不是路径。 */
  const MAX_SKIN_CHOICES = 16
  const SKIN_ID_RE = /^[A-Za-z0-9_-]{1,32}$/
  /** helper → 宿主能报的全部动作：控件 + 菜单。 */
  const DESKTOP_ACTIONS = CONTROL_ACTIONS.concat(MENU_ACTION_IDS)
  /** 改名正文的长度上限：宿主会按 32 码点再截一次，这里只防止 helper 内存里堆大字符串。 */
  const MAX_ACTION_TEXT = 64
  /**
   * 名字的产品上限（码点）。必须与 `src/protocol.js` 的 `MAX_NICKNAME` 一致：
   * 显示得比广播长，就等于又造出两个名字（ADR-0007）。
   */
  const MAX_NAME_LENGTH = 32
  /**
   * 礼物/背包上限为什么在 shared.js 里再抄一遍：
   *
   * `desktop/shared.js` 是**普通 script**——渲染端用 `<script>` 加载、主进程直接读，
   * 不能 import `src/protocol.js` 那套 ESM；helper 又是另一个进程，必须自己守边界。
   * 所以这几个数与宿主同源，但两侧的失败策略刻意不同，改的时候别只改一边：
   *
   *   - 字条超 500 码点：宿主 `sanitizeNote` 与背包 `normalizeBringInput` **丢弃**
   *     （这次不带/不收）；渲染端 `normalizeNoteText` 只**截断**——已经收到的卡片
   *     不能因为显示层超限而整张消失。
   *   - 文件名超 120 码点：宿主 `sanitizeGiftName` **截断**（名字只给人看）；
   *     渲染端 `normalizeGiftName` 返回 null、**丢掉整张卡**（文件卡没有名字就画不出来）。
   *   - 文件 >16 MiB：宿主 `normalizeGift` **丢弃**这件礼物；渲染端同样丢卡
   *     （卡片要显示大小，缺了就没有意义）。
   *   - 背包 >2 件：宿主 `backpack.add` 拒绝并回 `backpack-full`；渲染端只画宿主下发的
   *     前两件，多出来的不显示（列表本身有界，不做静默替换）。
   */
  const MAX_GIFT_TEXT_LENGTH = 500
  /** 背包上限（件），与 `src/backpack.js` 的 `MAX_BACKPACK_ITEMS` 同一个数。 */
  const MAX_BACKPACK_ITEMS = 2
  /** 单件文件礼物上限，与 `src/protocol.js` 的 `MAX_GIFT_BYTES` 同一个数。 */
  const MAX_GIFT_FILE_BYTES = 16 * 1024 * 1024
  /** 文件礼物名字上限（码点），与 `src/protocol.js` 的 `MAX_GIFT_NAME` 同一个数。 */
  const MAX_GIFT_NAME_LENGTH = 120
  /** 一次场景最多几件礼物（≤ 访客数）；上限只为让一条消息有界，不表达产品限额。 */
  const MAX_GIFT_ITEMS = 64
  /** 礼物的状态词表，与 `src/gift-text.js` 的 `GIFT_STATUSES` 同源；认不出的整张卡丢弃。 */
  const GIFT_STATUSES = ['pending', 'receiving', 'received', 'failed', 'refused']

  /**
   * 农场（ticket 40）。下面的数字与 `src/farm-rules.js` / `src/farm.js` 同源，但这一层是
   * **普通 script**（渲染页 `<script>` 加载、主进程 require），不能 import 宿主的 ESM；
   * 所以按 `desktop/shared.js` 的老规矩再守一次边界，改的时候两边一起改：
   *   - 宿主现在发 4 块地（p1–p4，与 `src/farm.js` 的 PLOT_IDS 一致），但窗口/helper
   *     边界不写死 4：上限留到 20，未来宿主多发几块，卡片和标题自动跟上（ticket 47）；
   *   - 三种作物，与 SPEC v5 的作物表一致；
   *   - 硬币/种子/作物/露水/合同/日志的硬上限与 SPEC v5「货币、仓库与限额」一致。
   */
  const MAX_FARM_PLOTS = 20
  const CROP_IDS = ['tomato', 'carrot', 'pumpkin']
  const FARM_STAGES = ['empty', 'growing', 'mature']
  const FARM_LOG_KINDS = ['plant', 'harvest', 'steal', 'help', 'hire', 'settle']
  const MAX_FARM_COINS = 1000000
  const MAX_FARM_STACK = 999
  const MAX_FARM_DEW = 48
  const MAX_FARM_CONTRACTS = 20
  const MAX_FARM_LOG = 50
  /**
   * 交易所（ticket 41）的窄口：底价表与 `src/farm-rules.js` 同源；
   * 价格夹在 [base×0.5, base×2]，成交历史最多 50 条进窗口。
   */
  const CROP_BASE_PRICE = { tomato: 5, carrot: 6, pumpkin: 30 }
  const MAX_FARM_MARKET_HISTORY = 50
  const MARKET_SIDES = ['buy', 'sell']
  const MARKET_MIN_QTY = 1
  const MARKET_MAX_QTY = 99
  const MARKET_FLOOR_RATIO = 0.5
  const MARKET_CEIL_RATIO = 2
  /** 局域网指数混价（ticket 42）：与宿主 src/market.js 同一组权重。 */
  const MARKET_LOCAL_WEIGHT = 0.85
  const MARKET_INDEX_WEIGHT = 0.15
  /** `remainingMs` 只用来画倒计时；一行 JSON 推到几百年后没有意义。 */
  const MAX_FARM_REMAINING_MS = 30 * 24 * 60 * 60 * 1000
  /** 雇佣（ticket 44）：与 src/contracts-rules.js 同源，改的时候两边一起改。 */
  const HIRE_WAGE_MIN = 1
  const HIRE_WAGE_MAX = 100
  const HIRE_HOURS_MIN = 2
  const HIRE_HOURS_MAX = 8
  const HIRE_FEE_RATE = 0.05
  /** 守卫上限 0.8：与宿主 src/farm-rules.js 的 MAX_GUARD 同源（drift 测试会读）。 */
  const MAX_FARM_GUARD = 0.8
  const MAX_CONTRACT_EARNED = HIRE_HOURS_MAX * HIRE_WAGE_MAX
  const CONTRACT_STATUSES = ['pending', 'active', 'ended', 'cancelled']
  const HIRE_REASONS = ['ready', 'off', 'visiting', 'working']
  /** 地块 id 的形状：宿主现在发 p1–p4；窗口按 pN 通用，未来 20 块不用改这里。 */
  const PLOT_ID_RE = /^[a-z0-9_-]{1,16}$/

  /** 宠物色板：self 固定第一格，访客按 deviceId 散列到其余颜色。 */
  const PET_COLORS = ['#3b74d8', '#2f8f5b', '#a8542f', '#7a4fd8', '#c2913b', '#2f8fa8', '#b04a86', '#5b7f2f']
  /** dsh-pet 不上报随机待机动作；没有动作时轮播这几段真实存在的素材。 */
  const IDLE_CLIPS = ['东张西望', '原地漂浮踏步', '原地小憩沉眠']
  /** 本机素材池的上限：场景一条消息装得下，也防止宿主误传一个超大数组。 */
  const MAX_IDLE_POOL = 128
  /** 远端素材只接受 helper 的 cache 协议 URL；本机素材仍走 `dshzoo://asset/<名字>`。 */
  const CACHE_ASSET_RE = /^dshzoo:\/\/cache\/[0-9a-f]{64}\.webm$/
  /** 语义标签是固定小表：不认识的动作靠它画一个通用表情。 */
  const SEMANTIC_VALUES = ['working', 'eating', 'sleeping', 'idle', 'other']
  /** 通用小人头顶的短标记；空串表示不画。 */
  const SEMANTIC_BADGES = Object.freeze({
    working: '...',
    eating: 'yum',
    sleeping: 'z',
    idle: '',
    other: '?'
  })

  /**
   * 物理参数。数值不是物理常量，只是「看起来像桌宠」的调参结果：
   * 重力够大、落地有可见反弹、地面摩擦让滑行很快停下、弹簧拖拽跟手但不硬贴。
   */
  const PHYSICS = Object.freeze({
    GRAVITY: 2600,
    BOUNCE: 0.52,
    WALL_BOUNCE: 0.4,
    /** 1/s 的指数衰减系数（不是每帧固定减多少，避免帧率影响手感）。 */
    GROUND_FRICTION: 4.2,
    AIR_FRICTION: 0.22,
    DRAG_STIFFNESS: 120,
    DRAG_DAMPING: 22,
    MAX_THROW_SPEED: 2400,
    /** 落地速度低于它就不再弹，避免在 ground 附近无限抖动。 */
    REST_SPEED: 120,
    /** 单帧最大步长：切后台回来时 dt 可能很大，钳住它物理才稳定。 */
    MAX_DT: 1 / 30,
    /** 宠物脚底离工作区底边的留白：昵称条不贴屏幕/ Dock 边，看起来才像"站在桌面上"。 */
    FLOOR_MARGIN: 8,
    /** 拖拽轨迹窗口（ms）：松手速度只取最近这么久的样本。 */
    THROW_TRAIL_MS: 140
  })

  function isFiniteNumber (value) {
    return typeof value === 'number' && Number.isFinite(value)
  }

  function clampNumber (value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  function normalizeId (value) {
    if (typeof value !== 'string') return null
    const id = value.trim()
    if (id === '' || id.length > MAX_ID_LENGTH) return null
    // id 只用来做键和日志，限制成可安全打印的字符集。
    return /^[A-Za-z0-9._:-]+$/.test(id) ? id : null
  }

  function isAbsolutePath (value) {
    return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
  }

  /**
   * 本机素材目录（ticket 33）：宿主把「当前那张皮」的目录随场景下发，
   * helper 只认绝对路径、最多 8 个。空数组/null = 这次场景没说，沿用启动参数。
   */
  function normalizeAssetRoots (value) {
    if (!Array.isArray(value)) return null
    const roots = []
    for (const candidate of value) {
      if (roots.length >= 8) break
      if (typeof candidate !== 'string') continue
      const root = candidate.trim()
      // 绝对路径的三种写法：POSIX `/`、盘符 `C:\` / `C:/`、UNC `\\server\share`。
      // 只认 `/` 会让整套换皮在 Windows 上静默失效（宿主发下去、helper 全丢掉）。
      if (root === '' || !isAbsolutePath(root)) continue
      if (/[\u0000-\u001f\u007f]/.test(root)) continue
      if (roots.includes(root)) continue
      roots.push(root)
    }
    // 一个可用的根都没有 = 这次没说（不是"把根清空"）：helper 要能沿用启动参数。
    return roots.length === 0 ? null : roots
  }

  /** 素材源 id：短标识符，形状与宿主 `src/protocol.js` 的 normalizeSkinId 一致。 */
  function normalizeSkinId (value) {
    if (typeof value !== 'string') return null
    // 与宿主一致：不 trim。带空白的 id 在两边都不是同一个 id。
    return SKIN_ID_RE.test(value) ? value : null
  }

  /**
   * 礼物 id 是 wire 上的 UUID（与 visitId/deviceId 同一种形状）。这里不复用 `normalizeId`：
   * 那个入口还给动画名/诊断 id 用，宽松得多；礼物 id 会被拼进宿主侧的目录查找，必须严格。
   */
  /** 合同/device id：与宿主协议层同一种 UUID 形状，统一小写。 */
  function normalizeUuid (value) {
    if (typeof value !== 'string') return null
    const id = value.trim()
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? id.toLowerCase()
      : null
  }

  function normalizeGiftId (value) {
    if (typeof value !== 'string') return null
    const id = value.trim()
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? id.toLowerCase()
      : null
  }

  /**
   * 文件礼物的名字（ticket 25）：与 `src/protocol.js` 的 `sanitizeGiftName` 同一口径——
   * 去掉路径分隔符、控制字符、双向覆盖符与前导点；超长/为空就丢掉这张卡。
   * 这个名字只用来显示，不参与拼路径；但跨进程边界各自守一次，别让宿主的新版本带坏 helper。
   */
  function normalizeGiftName (value) {
    if (typeof value !== 'string') return null
    if (typeof value.isWellFormed === 'function' && !value.isWellFormed()) return null
    const clean = value
      .replace(/[\\/]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
      .trim()
      .replace(/^\.+/, '')
      .trim()
    if (clean === '') return null
    const chars = Array.from(clean)
    return chars.length > MAX_GIFT_NAME_LENGTH ? null : clean
  }

  /** 文件大小：正整数且 ≤16 MiB；别的值整张卡丢掉（卡片要显示大小，缺了就没意义）。 */
  function normalizeGiftSize (value) {
    return Number.isInteger(value) && value > 0 && value <= MAX_GIFT_FILE_BYTES ? value : null
  }

  /**
   * 缩略图地址只接受宿主生成的 `dshzoo://gifts/<目录>/<文件名>`（目录名是固定形状，
   * 文件名是 encodeURIComponent 过的）。渲染端拿不到别的 URL，也不许自己拼。
   */
  function normalizeGiftThumb (value) {
    if (typeof value !== 'string' || value.length > 2048) return null
    return /^dshzoo:\/\/gifts\/\d{8}-\d{6}-[0-9a-f]{8}(?:-\d+)?\/[^\u0000-\u001f/\\]{1,1024}$/.test(value)
      ? value
      : null
  }

  function normalizeToken (value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'string') return null
    const token = value.trim()
    return token === '' || token.length > MAX_ID_LENGTH ? null : token
  }

  function normalizeText (value, fallback, maxLength) {
    if (typeof value !== 'string') return fallback
    // eslint-disable-next-line no-control-regex
    const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    if (text === '') return fallback
    return text.length > maxLength ? text.slice(0, maxLength) : text
  }

  /**
   * 字条正文（ticket 23）：与 `normalizeText` 相反，**保留换行**——便条的多行是内容本身。
   * 去掉其余控制字符与双向覆盖符，首尾裁掉，按码点夹到 500。
   *
   * 这里用“截断”而不是宿主的“超限丢弃”：宿主已经按 500 校验过，渲染端再超只可能是
   * 坏数据/手改场景，截断能让卡片继续画出来，不会把整张卡丢掉。
   */
  function normalizeNoteText (value, maxLength = MAX_GIFT_TEXT_LENGTH) {
    if (typeof value !== 'string') return null
    if (typeof value.isWellFormed === 'function' && !value.isWellFormed()) return null
    // eslint-disable-next-line no-control-regex
    const text = value
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
      .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
      .trim()
    if (text === '') return null
    const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : MAX_GIFT_TEXT_LENGTH
    const chars = Array.from(text)
    return chars.length > limit ? chars.slice(0, limit).join('') : text
  }

  function normalizeLabel (value, fallback) {
    return normalizeText(value, fallback, MAX_LABEL_LENGTH)
  }

  /**
   * 背包里的字条正文（ticket 24）：和卡片一样保留换行，但**超 500 码点返回 null**，
   * 不学 `normalizeNoteText` 的截断——「带派」小窗里少一个字都算替用户改稿。
   */
  function normalizeBackpackText (value) {
    if (typeof value !== 'string') return null
    // 先按同一套清洗（给一个足够大的上限）再数码点；超过 500 就是错误。
    const text = normalizeNoteText(value, MAX_GIFT_TEXT_LENGTH * 8)
    if (text === null || Array.from(text).length > MAX_GIFT_TEXT_LENGTH) return null
    return text
  }

  /**
   * 「带派」小窗提交的物品（ticket 24）：`{kind:'text',text}` 或 `{kind:'file',path}`。
   * 文件路径只来自主进程的 `dialog.showOpenDialog`；宿主还会再 stat 一次。
   */
  function normalizeBringGift (value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    if (value.kind === 'text') {
      const text = normalizeBackpackText(value.text)
      return text === null ? null : { kind: 'text', text }
    }
    if (value.kind === 'file') {
      const path = normalizePath(value.path)
      return path === null ? null : { kind: 'file', path }
    }
    return null
  }

  /** 背包小窗里的一条：只带 id/kind/显示文案/state，**绝不带路径**（路径只活在宿主）。 */
  function normalizeBringWindowItem (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const id = normalizeGiftId(raw.id)
    if (id === null) return null
    const state = raw.state === 'out' ? 'out' : 'idle'
    if (raw.kind === 'text') {
      const text = normalizeNoteText(raw.text)
      if (text === null) return null
      return { id, kind: 'text', text, state }
    }
    if (raw.kind === 'file') {
      const name = normalizeText(raw.name, 'file', MAX_GIFT_NAME_LENGTH)
      return { id, kind: 'file', name, state }
    }
    return null
  }

  /**
   * 宿主 → helper 的「带派」小窗状态（ticket 24）。`open:true` = 打开/聚焦这扇窗；
   * `open:false` = 只刷新已开着的窗（撤掉一件之后）。上限由 shared 自己定，
   * 不信任宿主传来的数字。
   */
  function normalizeBringWindow (raw) {
    const items = []
    if (Array.isArray(raw.items)) {
      for (const candidate of raw.items) {
        if (items.length >= MAX_BACKPACK_ITEMS) break
        const item = normalizeBringWindowItem(candidate)
        if (item !== null) items.push(item)
      }
    }
    return {
      open: raw.open === true,
      items,
      count: items.length,
      maxItems: MAX_BACKPACK_ITEMS,
      maxTextLength: MAX_GIFT_TEXT_LENGTH,
      maxFileBytes: MAX_GIFT_FILE_BYTES
    }
  }

  // -------------------------------------------------------------------------
  // 农场（ticket 40/46）：只服务农场小窗；桌面场景不再有农场摘要。
  // -------------------------------------------------------------------------

  function normalizePlotId (value) {
    if (typeof value !== 'string') return null
    const id = value.trim().toLowerCase()
    return PLOT_ID_RE.test(id) ? id : null
  }

  function normalizeCropId (value) {
    if (typeof value !== 'string') return null
    const id = value.trim().toLowerCase()
    return CROP_IDS.includes(id) ? id : null
  }

  /** 种子/作物仓库：三种作物永远都有键，坏值按 0；上限 999。 */
  function normalizeFarmStacks (value) {
    const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    const stacks = {}
    for (const id of CROP_IDS) {
      const count = Number(source[id])
      stacks[id] = Number.isFinite(count)
        ? Math.min(MAX_FARM_STACK, Math.max(0, Math.floor(count)))
        : 0
    }
    return stacks
  }

  function normalizeFarmWorker (value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const nickname = normalizeLabel(value.nickname, null)
    return nickname === null ? null : { nickname }
  }

  /**
   * 一块地（只服务农场小窗）。
   *
   * 输入来自宿主算好的 `stage/mature/remainingMs`（`src/farm-rules.js` 推的），这里只做
   * 二次校验；`crop === null` 优先判空，其余以 `mature` 为准（`stage` 只是显示用的派生值）。
   */
  function normalizeFarmPlot (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const id = normalizePlotId(raw.id)
    if (id === null) return null
    const crop = normalizeCropId(raw.crop)
    if (crop === null) {
      return { id, crop: null, stage: 'empty', mature: false, remainingMs: 0, waterings: 0, fertilized: false }
    }

    const growMs = Number(raw.growMs)
    const grownMs = Number(raw.grownMs)
    const stage = FARM_STAGES.includes(raw.stage) && raw.stage !== 'empty' ? raw.stage : null
    let mature = raw.mature === true
    if (mature !== true) {
      if (stage === 'mature') mature = true
      else if (Number.isFinite(growMs) && growMs > 0 && Number.isFinite(grownMs)) mature = grownMs >= growMs
    }
    const summary = { id, crop, stage: mature ? 'mature' : 'growing', mature }

    // 宿主给 remainingMs 就信它（窗口倒计时以那一份为准）；没给就从生长进度推。
    let remaining = Number(raw.remainingMs)
    if (!Number.isFinite(remaining) || remaining < 0) {
      remaining = Number.isFinite(growMs) && Number.isFinite(grownMs) ? growMs - grownMs : 0
    }
    const waterings = Number(raw.waterings)
    return {
      ...summary,
      remainingMs: mature ? 0 : Math.min(MAX_FARM_REMAINING_MS, Math.max(0, Math.floor(remaining))),
      waterings: Number.isFinite(waterings) && waterings >= 1 ? 1 : 0,
      fertilized: raw.fertilized === true
    }
  }

  function normalizeFarmLogEntry (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const at = Number(raw.at)
    if (!Number.isFinite(at) || at <= 0) return null
    if (typeof raw.kind !== 'string' || !FARM_LOG_KINDS.includes(raw.kind)) return null
    const crop = raw.crop === undefined || raw.crop === null ? null : normalizeCropId(raw.crop)
    if (raw.crop !== undefined && raw.crop !== null && crop === null) return null
    const qtyValue = Number(raw.qty)
    const qty = Number.isFinite(qtyValue) ? Math.min(MAX_FARM_STACK, Math.max(0, Math.floor(qtyValue))) : 0
    // ticket 43：偷/帮日志带「谁」（昵称，≤32 码点）；没有就不是一条访客日志。
    // 先按 UTF-16 上限取一段，再按码点夹取，避免在 emoji 代理对中间切断。
    const whoText = raw.who === undefined || raw.who === null ? null : normalizeText(raw.who, null, 128)
    const who = whoText === null ? null : Array.from(whoText).slice(0, 32).join('')
    // ticket 44/45：hire/settle 日志带工资与结算数（显示用，不参与任何计算）。
    const wage = Number(raw.wage)
    const earned = Number(raw.earned)
    const hours = Number(raw.hours)
    return {
      at: Math.floor(at),
      kind: raw.kind,
      ...(crop === null ? {} : { crop }),
      qty,
      ...(who === null ? {} : { who }),
      ...(Number.isFinite(wage) ? { wage: Math.min(MAX_FARM_COINS, Math.max(0, Math.floor(wage))) } : {}),
      ...(Number.isFinite(earned) ? { earned: Math.min(MAX_FARM_COINS, Math.max(0, Math.floor(earned))) } : {}),
      ...(Number.isFinite(hours) ? { hours: Math.min(HIRE_HOURS_MAX, Math.max(0, Math.floor(hours))) } : {})
    }
  }

  /**
   * 驮包（ticket 43/44，只显示）：作物「在驮包里」到串门结束，工资在合同结算前显示。
   * 只重建白名单字段；坏条目只丢自己。**不**参与任何记账（宿主已经算过仓库/硬币）。
   */
  function normalizeFarmCarried (raw) {
    if (!Array.isArray(raw)) return []
    const out = []
    for (const candidate of raw) {
      if (out.length >= 8) break
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const kind = candidate.kind === 'crop' ? 'crop' : candidate.kind === 'wage' ? 'wage' : null
      if (kind === null) continue
      const at = Number(candidate.at)
      const until = Number(candidate.until)
      const amount = Number(candidate.amount)
      if (kind === 'crop') {
        const crop = normalizeCropId(candidate.crop)
        const qty = Number(candidate.qty)
        if (crop === null || !Number.isFinite(qty) || qty <= 0) continue
        out.push({
          kind,
          crop,
          qty: Math.min(MAX_FARM_STACK, Math.floor(qty)),
          ...(Number.isFinite(at) && at > 0 ? { at: Math.floor(at) } : {}),
          ...(Number.isFinite(until) && until > 0 ? { until: Math.floor(until) } : {})
        })
        continue
      }
      if (!Number.isFinite(amount) || amount < 0) continue
      const contractId = normalizeUuid(candidate.contractId)
      out.push({
        kind,
        amount: Math.min(MAX_FARM_COINS, Math.floor(amount)),
        ...(contractId === null ? {} : { contractId }),
        ...(Number.isFinite(at) && at > 0 ? { at: Math.floor(at) } : {}),
        ...(Number.isFinite(until) && until > 0 ? { until: Math.floor(until) } : {})
      })
    }
    return out
  }

  /**
   * 农场小窗的完整视图归一化（`farm-window` 命令）。
   *
   * 桌面场景里没有农场摘要（ticket 46：地块条已删）：`controls` 是每帧比较的契约，
   * 日志/仓库只会让签名狂变；农场数据只走 `farm-window`，窗口不读 `/state`。
   */
  function normalizeFarm (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const plots = []
    const seen = new Set()
    if (Array.isArray(raw.plots)) {
      for (const candidate of raw.plots) {
        if (plots.length >= MAX_FARM_PLOTS) break
        const plot = normalizeFarmPlot(candidate)
        if (plot === null || seen.has(plot.id)) continue
        seen.add(plot.id)
        plots.push(plot)
      }
    }
    const coins = Number(raw.coins)
    const dew = Number(raw.dew)
    const contracts = Number(raw.contractCount)
    const farm = {
      plots,
      coins: Number.isFinite(coins) ? Math.min(MAX_FARM_COINS, Math.max(0, Math.floor(coins))) : 0,
      dew: Number.isFinite(dew) ? Math.min(MAX_FARM_DEW, Math.max(0, Math.floor(dew))) : 0,
      worker: normalizeFarmWorker(raw.worker),
      contractCount: Number.isFinite(contracts)
        ? Math.min(MAX_FARM_CONTRACTS, Math.max(0, Math.floor(contracts)))
        : 0
    }

    const log = []
    if (Array.isArray(raw.log)) {
      for (const candidate of raw.log) {
        if (log.length >= MAX_FARM_LOG) break
        const entry = normalizeFarmLogEntry(candidate)
        if (entry !== null) log.push(entry)
      }
    }
    const hire = normalizeFarmHire(raw.hire)
    const guard = Number(raw.guard)
    return {
      ...farm,
      seeds: normalizeFarmStacks(raw.seeds),
      crops: normalizeFarmStacks(raw.crops),
      ...(hire === null ? {} : { hire }),
      ...(Number.isFinite(guard) ? { guard: Math.min(MAX_FARM_GUARD, Math.max(0, guard)) } : {}),
      log,
      carried: normalizeFarmCarried(raw.carried)
    }
  }

  /** 小窗的挂牌（只有完整视图才有）。 */
  function normalizeFarmHire (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const wage = Number(raw.wagePerHour)
    const minHours = Number(raw.minHours)
    const maxHours = Number(raw.maxHours)
    if (!Number.isFinite(wage) || !Number.isFinite(minHours) || !Number.isFinite(maxHours)) return null
    return {
      enabled: raw.enabled === true,
      wagePerHour: Math.min(HIRE_WAGE_MAX, Math.max(HIRE_WAGE_MIN, Math.floor(wage))),
      minHours: Math.min(HIRE_HOURS_MAX, Math.max(HIRE_HOURS_MIN, Math.floor(minHours))),
      maxHours: Math.min(HIRE_HOURS_MAX, Math.max(HIRE_HOURS_MIN, Math.floor(maxHours)))
    }
  }

  /**
   * 合同（ticket 44）：窗口只画宿主给的公开字段；坏条目只丢自己。
   * WAL/charged/refunded 这些内部字段永远不过 IPC。
   */
  function normalizeContracts (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { outgoing: [], incoming: [], listings: [], pendingHire: false, now: 0, feeRate: HIRE_FEE_RATE }
    }
    const record = (candidate, side) => {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null
      const id = normalizeUuid(candidate.id)
      if (id === null) return null
      const status = CONTRACT_STATUSES.includes(candidate.status) ? candidate.status : null
      if (status === null) return null
      const hours = Number(candidate.hours)
      const wagePerHour = Number(candidate.wagePerHour)
      const wage = Number(candidate.wage)
      const fee = Number(candidate.fee)
      if (![hours, wagePerHour, wage, fee].every(Number.isFinite)) return null
      const name = side === 'outgoing'
        ? normalizeLabel(candidate.workerNickname, '邻居')
        : normalizeLabel(candidate.employerNickname, '邻居')
      const remaining = Number(candidate.remainingMs)
      const earned = Number(candidate.earned)
      return {
        id,
        ...(side === 'outgoing'
          ? { workerNickname: name }
          : { employerNickname: name }),
        hours: Math.min(HIRE_HOURS_MAX, Math.max(HIRE_HOURS_MIN, Math.floor(hours))),
        wagePerHour: Math.min(HIRE_WAGE_MAX, Math.max(HIRE_WAGE_MIN, Math.floor(wagePerHour))),
        wage: Math.max(0, Math.floor(wage)),
        fee: Math.max(0, Math.floor(fee)),
        status,
        earned: Number.isFinite(earned) ? Math.max(0, Math.floor(earned)) : 0,
        remainingMs: Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 0,
        endedAt: Number.isFinite(Number(candidate.endedAt)) ? Math.floor(Number(candidate.endedAt)) : null,
        settled: candidate.settled === true
      }
    }
    const outgoing = []
    const incoming = []
    if (Array.isArray(raw.outgoing)) {
      for (const candidate of raw.outgoing) {
        if (outgoing.length >= MAX_FARM_CONTRACTS) break
        const entry = record(candidate, 'outgoing')
        if (entry !== null) outgoing.push(entry)
      }
    }
    if (Array.isArray(raw.incoming)) {
      for (const candidate of raw.incoming) {
        if (incoming.length >= MAX_FARM_CONTRACTS) break
        const entry = record(candidate, 'incoming')
        if (entry !== null) incoming.push(entry)
      }
    }
    const listings = []
    if (Array.isArray(raw.listings)) {
      for (const candidate of raw.listings) {
        if (listings.length >= MAX_FARM_CONTRACTS) break
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
        const deviceId = normalizeUuid(candidate.deviceId)
        if (deviceId === null || listings.some((entry) => entry.deviceId === deviceId)) continue
        const wage = Number(candidate.wagePerHour)
        const minHours = Number(candidate.minHours)
        const maxHours = Number(candidate.maxHours)
        if (![wage, minHours, maxHours].every(Number.isFinite)) continue
        listings.push({
          deviceId,
          nickname: normalizeLabel(candidate.nickname, '邻居'),
          enabled: candidate.enabled === true,
          available: candidate.available === true,
          reason: HIRE_REASONS.includes(candidate.reason) ? candidate.reason : null,
          wagePerHour: Math.min(HIRE_WAGE_MAX, Math.max(HIRE_WAGE_MIN, Math.floor(wage))),
          minHours: Math.min(HIRE_HOURS_MAX, Math.max(HIRE_HOURS_MIN, Math.floor(minHours))),
          maxHours: Math.min(HIRE_HOURS_MAX, Math.max(HIRE_HOURS_MIN, Math.floor(maxHours))),
          guard: Number.isFinite(Number(candidate.guard)) ? Math.min(MAX_FARM_GUARD, Math.max(0, Number(candidate.guard))) : 0,
          stale: candidate.stale === true
        })
      }
    }
    const now = Number(raw.now)
    return {
      outgoing,
      incoming,
      listings,
      pendingHire: raw.pendingHire === true,
      now: Number.isFinite(now) ? Math.floor(now) : 0,
      feeRate: HIRE_FEE_RATE
    }
  }

  /** 交易所数量：1–99 的整数；字符串数字也认（input.value 常见）。 */
  function normalizeTradeQty (value) {
    const num = Number(value)
    if (!Number.isFinite(num) || !Number.isInteger(num)) return null
    return num >= MARKET_MIN_QTY && num <= MARKET_MAX_QTY ? num : null
  }

  /**
   * 交易所的一行价目。`indexPrice` 只在指数新鲜时传进来：
   * bid 与宿主同一条公式 `round((0.85×price + 0.15×index) × 0.9)`，窗口画的就是成交价。
   * 宿主多传的 `bid` 一律不信——helper 自己按白名单字段算。
   */
  function normalizeMarketPrice (raw, cropId, indexPrice = null) {
    const base = CROP_BASE_PRICE[cropId]
    const rawPrice = raw === null || typeof raw !== 'object' || Array.isArray(raw)
      ? Number.NaN
      : Number(raw.price)
    const price = Number.isFinite(rawPrice)
      ? Math.min(base * MARKET_CEIL_RATIO, Math.max(base * MARKET_FLOOR_RATIO, rawPrice))
      : base
    const volume = raw === null || typeof raw !== 'object' || Array.isArray(raw)
      ? Number.NaN
      : Number(raw.volume24h)
    const at = raw === null || typeof raw !== 'object' || Array.isArray(raw)
      ? Number.NaN
      : Number(raw.at)
    const remote = Number(indexPrice)
    const effective = Number.isFinite(remote) && remote > 0
      ? MARKET_LOCAL_WEIGHT * price + MARKET_INDEX_WEIGHT * remote
      : price
    return {
      base,
      price,
      bid: Math.round(effective * 0.9),
      volume24h: Number.isFinite(volume) ? Math.min(MAX_FARM_STACK * 1000, Math.max(0, Math.floor(volume))) : 0,
      at: Number.isFinite(at) && at > 0 ? Math.floor(at) : 0
    }
  }

  function normalizeMarketHistoryEntry (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const cropId = normalizeCropId(raw.crop)
    if (cropId === null || !MARKET_SIDES.includes(raw.side)) return null
    const qty = normalizeTradeQty(raw.qty)
    if (qty === null) return null
    const price = Number(raw.price)
    const at = Number(raw.at)
    if (!Number.isFinite(price) || price < 0) return null
    if (!Number.isFinite(at) || at <= 0) return null
    return { crop: cropId, side: raw.side, qty, price, at: Math.floor(at) }
  }

  /**
   * 交易所页视图（ticket 41/42）。只信价格/成交量/历史/指数这几类字段：
   *   - 未知作物、坏成交、超长历史、坏指数一律丢掉，不整份失败；
   *   - `bid` 在这里按 `price + 新鲜 index` 重算，宿主多传一个 `bid` 也不会让窗口画错价；
   *   - index 条目多一个 `stale`：宿主按自己的时钟判过期，窗口只负责画灰。
   */
  function normalizeMarket (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const index = {}
    if (raw.index !== null && typeof raw.index === 'object' && !Array.isArray(raw.index)) {
      for (const cropId of CROP_IDS) {
        const entry = raw.index[cropId]
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const price = Number(entry.price)
        const at = Number(entry.at)
        const samples = Number(entry.samples)
        if (!Number.isFinite(price) || price < 0) continue
        if (!Number.isFinite(at) || at <= 0) continue
        const base = CROP_BASE_PRICE[cropId]
        index[cropId] = {
          price: Math.min(base * MARKET_CEIL_RATIO, Math.max(base * MARKET_FLOOR_RATIO, price)),
          at: Math.floor(at),
          samples: Number.isFinite(samples) ? Math.max(0, Math.floor(samples)) : 0,
          stale: entry.stale === true
        }
      }
    }
    const prices = {}
    for (const cropId of CROP_IDS) {
      const indexEntry = index[cropId]
      prices[cropId] = normalizeMarketPrice(
        raw.prices?.[cropId],
        cropId,
        indexEntry !== undefined && indexEntry.stale !== true ? indexEntry.price : null
      )
    }
    const history = []
    if (Array.isArray(raw.history)) {
      for (const candidate of raw.history) {
        if (history.length >= MAX_FARM_MARKET_HISTORY) break
        const entry = normalizeMarketHistoryEntry(candidate)
        if (entry !== null) history.push(entry)
      }
    }
    return { prices, index, history }
  }

  /**
   * 访客模式（ticket 43）：宿主推来的主人家快照。窗口不联网，只画这一份。
   * 只重建白名单字段：`stolenByMe` / `helpedByMe` 是布尔；绝不接受 stolenBy/helpedBy 数组
   * （那会把别的访客 deviceId 带进 helper）。坏地块只丢那一块。
   */
  const FARM_VISIT_STATES = ['loading', 'ready', 'error', 'ended']
  const MAX_VISIT_LIMIT = 99
  const MAX_VISIT_GUARD = MAX_FARM_GUARD

  function normalizeFarmVisitPlot (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const id = normalizePlotId(raw.id)
    if (id === null || !/^p\d{1,3}$/.test(id)) return null
    const crop = raw.crop === null || raw.crop === undefined ? null : normalizeCropId(raw.crop)
    if (raw.crop !== null && raw.crop !== undefined && crop === null) return null
    const stage = crop === null ? 'empty' : (raw.stage === 'mature' || raw.mature === true ? 'mature' : 'growing')
    const remaining = Number(raw.remainingMs)
    return {
      id,
      crop,
      stage,
      mature: stage === 'mature',
      remainingMs: stage === 'mature' || !Number.isFinite(remaining)
        ? 0
        : Math.min(MAX_FARM_REMAINING_MS, Math.max(0, Math.floor(remaining))),
      stolenByMe: raw.stolenByMe === true,
      helpedByMe: raw.helpedByMe === true
    }
  }

  function normalizeVisitLimit (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const value = (key) => {
      const num = Number(raw[key])
      return Number.isFinite(num) ? Math.min(MAX_VISIT_LIMIT, Math.max(0, Math.floor(num))) : 0
    }
    return {
      perVisit: value('perVisit'),
      usedInVisit: value('usedInVisit'),
      perFarm: value('perFarm'),
      usedOnFarm: value('usedOnFarm'),
      perDay: value('perDay'),
      usedToday: value('usedToday')
    }
  }

  function normalizeFarmVisit (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const state = FARM_VISIT_STATES.includes(raw.state) ? raw.state : 'error'
    const guardValue = Number(raw.guard)
    const plots = []
    const seen = new Set()
    if (Array.isArray(raw.plots)) {
      for (const candidate of raw.plots) {
        if (plots.length >= MAX_FARM_PLOTS) break
        const plot = normalizeFarmVisitPlot(candidate)
        if (plot === null || seen.has(plot.id)) continue
        seen.add(plot.id)
        plots.push(plot)
      }
    }
    const at = Number(raw.at)
    const error = typeof raw.error === 'string' && /^[a-z0-9-]{1,32}$/.test(raw.error) ? raw.error : null
    return {
      state,
      nickname: normalizeText(raw.nickname, null, 32),
      guard: Number.isFinite(guardValue) ? Math.min(MAX_VISIT_GUARD, Math.max(0, guardValue)) : 0,
      plots,
      limits: {
        steal: normalizeVisitLimit(raw.limits?.steal),
        help: normalizeVisitLimit(raw.limits?.help)
      },
      error,
      at: Number.isFinite(at) && at > 0 ? Math.floor(at) : 0
    }
  }

  /**
   * 宿主 → helper 的 `farm-window` 命令体：打开/刷新/关闭 + 完整农场视图 + 可选访客块。
   * `open:true` 打开或聚焦；`open:false` 只刷新已开着的窗；`close:true` 明确关窗
   * （ticket 46：再点一次「农场」或 `farm-close` 动作，不能和“刷新”混在一起）。
   */
  function normalizeFarmWindow (raw) {
    const plotId = normalizePlotId(raw.plotId)
    const visit = normalizeFarmVisit(raw.visit)
    return {
      open: raw.open === true,
      ...(raw.close === true ? { close: true } : {}),
      mode: raw.mode === 'visitor' ? 'visitor' : 'owner',
      farm: normalizeFarm(raw.farm),
      market: normalizeMarket(raw.market),
      // ticket 44：雇工页的合同/挂牌由宿主 push，窗口永远不自己发请求。
      contracts: normalizeContracts(raw.contracts),
      ...(visit === null ? {} : { visit }),
      ...(plotId === null ? {} : { plotId })
    }
  }

  /** 农场小窗提交（`dsh-zoo:farm-submit`）的唯一白名单：坏形状整条拒绝，不半截猜测。 */
  function normalizeFarmAction (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : ''
    if (!FARM_ACTIONS.includes(action)) return null
    if (FARM_MARKET_ACTIONS.includes(action)) {
      const cropId = normalizeCropId(raw.cropId)
      const qty = normalizeTradeQty(raw.qty)
      if (cropId === null || qty === null) return null
      return { action, cropId, qty }
    }
    if (action === 'hire') {
      const deviceId = normalizeUuid(raw.deviceId)
      const hours = Number(raw.hours)
      if (deviceId === null) return null
      if (!Number.isInteger(hours) || hours < HIRE_HOURS_MIN || hours > HIRE_HOURS_MAX) return null
      return { action, deviceId, hours }
    }
    if (action === 'recall-worker' || action === 'end-contract') {
      const contractId = normalizeUuid(raw.contractId)
      return contractId === null ? null : { action, contractId }
    }
    if (action === 'hire-listing') {
      const wagePerHour = Number(raw.wagePerHour)
      const minHours = Number(raw.minHours)
      const maxHours = Number(raw.maxHours)
      if (typeof raw.enabled !== 'boolean') return null
      if (!Number.isInteger(wagePerHour) || wagePerHour < HIRE_WAGE_MIN || wagePerHour > HIRE_WAGE_MAX) return null
      if (!Number.isInteger(minHours) || !Number.isInteger(maxHours)) return null
      if (minHours < HIRE_HOURS_MIN || maxHours > HIRE_HOURS_MAX || minHours > maxHours) return null
      return { action, enabled: raw.enabled, wagePerHour, minHours, maxHours }
    }
    // 到点确认没有地块字段：只请宿主重推一份当前 farm-window。
    if (action === 'farm-refresh') return { action }
    const plotId = normalizePlotId(raw.plotId)
    if (plotId === null) return null
    // 偷/帮只可能是 p1..p4（访客没有别的可点）；在主进程那一层就挡住 p9。
    if (FARM_VISIT_ACTIONS.includes(action) && !/^p[1-4]$/.test(plotId)) return null
    if (action === 'farm-plant') {
      const cropId = normalizeCropId(raw.cropId)
      return cropId === null ? null : { action, plotId, cropId }
    }
    // 偷/帮与主人四条一样只带 plotId；visitId 与 requestId 由宿主生成，渲染端不传。
    return { action, plotId }
  }

  /** 动画名会拼进 `dshzoo://asset/<name>.webm`：和宿主协议层同一套字符约束。 */
  function normalizeAnim (value) {
    if (typeof value !== 'string') return null
    const name = value.trim()
    if (name === '' || name.length > MAX_ANIM_LENGTH) return null
    if (name === '.' || name === '..') return null
    if (/[\\/\u0000-\u001f\u007f]/.test(name)) return null
    return name
  }

  function normalizeRole (value) {
    return PET_ROLES.includes(value) ? value : null
  }

  /** 角标只认固定枚举；认不出就不画（绝不把任意字符串送进场景）。 */
  function normalizeBadge (value) {
    return PET_BADGES.includes(value) ? value : null
  }

  function normalizeSemantic (value) {
    return typeof value === 'string' && SEMANTIC_VALUES.includes(value) ? value : null
  }

  /** helper 只认自己的 cache 协议：不是这个形状的 URL 一律丢掉，不让场景变成任意地址。 */
  function normalizeAssetUrl (value) {
    return typeof value === 'string' && CACHE_ASSET_RE.test(value) ? value : null
  }

  /**
   * 交给系统浏览器/应用去打开的地址（ticket 22 的「打开软件」）。
   * 只认 http/https：`file:` 之类会让一个菜单项变成任意本地文件的入口。
   */
  function normalizeHttpUrl (value) {
    if (typeof value !== 'string') return null
    const text = value.trim()
    if (text === '' || text.length > MAX_PATH_LENGTH) return null
    try {
      const url = new URL(text)
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
    } catch {
      return null
    }
  }

  function semanticBadge (value) {
    return Object.prototype.hasOwnProperty.call(SEMANTIC_BADGES, value) ? SEMANTIC_BADGES[value] : ''
  }

  /** 本机待机池：只收安全动画名、去重、保持宿主给的顺序；空/非法返回 null。 */
  function normalizeIdlePool (value) {
    if (!Array.isArray(value)) return null
    const pool = []
    for (const item of value) {
      const name = normalizeAnim(item)
      if (name === null || pool.includes(name)) continue
      pool.push(name)
      if (pool.length >= MAX_IDLE_POOL) break
    }
    return pool.length === 0 ? null : pool
  }

  /**
   * 从待机池里挑下一段。返回 `{ clip, next }`。
   *
   * 传了 `random` 就随机起点（避开刚播过的 `avoid`），不传则从 `start` 顺序走——
   * 顺序模式只用于测试/可复现，桌面上永远传 `Math.random`。
   * `next` 仍然前进一格，保证即使调用方忘了传 random 也不会卡在同一段。
   */
  function pickIdleClip (pool, start, failed, random, avoid) {
    if (!Array.isArray(pool) || pool.length === 0) return { clip: null, next: 0 }
    const from = Number.isInteger(start) && start >= 0 ? start % pool.length : 0
    const randomStart = typeof random === 'function'
      ? Math.floor(Math.abs(Number(random()) || 0) * pool.length) % pool.length
      : from
    const skipped = pool.length > 1 && typeof avoid === 'string' ? avoid : null

    const usable = (clip) => !(failed !== null && failed !== undefined &&
      typeof failed.has === 'function' && failed.has(clip))

    for (let offset = 0; offset < pool.length; offset += 1) {
      const index = (randomStart + offset) % pool.length
      const clip = pool[index]
      if (clip === skipped || !usable(clip)) continue
      return { clip, next: (index + 1) % pool.length }
    }
    // 全被 avoid/failed 排除（例如池子只有一段）：退回第一个可用的，宁可重复也不黑屏。
    for (let offset = 0; offset < pool.length; offset += 1) {
      const index = (randomStart + offset) % pool.length
      const clip = pool[index]
      if (!usable(clip)) continue
      return { clip, next: (index + 1) % pool.length }
    }
    return { clip: null, next: from }
  }

  function normalizeColor (value) {
    return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : DEFAULT_COLOR
  }

  function normalizePath (value) {
    if (typeof value !== 'string') return null
    const path = value.trim()
    if (path === '' || path.length > MAX_PATH_LENGTH) return null
    if (path.includes('\u0000')) return null
    // 只写绝对路径：helper 的 cwd 由宿主决定，相对路径落在哪里没有意义。
    return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : null
  }

  /** 矩形：有限数、正尺寸；溢出值夹到 ±MAX_COORD，坏矩形返回 null。 */
  function normalizeRect (raw) {
    if (raw === null || typeof raw !== 'object') return null
    const x = Number(raw.x)
    const y = Number(raw.y)
    const width = Number(raw.width)
    const height = Number(raw.height)
    if (![x, y, width, height].every(Number.isFinite)) return null
    if (width <= 0 || height <= 0) return null
    return {
      x: clampNumber(x, -MAX_COORD, MAX_COORD),
      y: clampNumber(y, -MAX_COORD, MAX_COORD),
      width: clampNumber(width, 0.001, MAX_ITEM_SIZE),
      height: clampNumber(height, 0.001, MAX_ITEM_SIZE)
    }
  }

  function normalizeItem (raw) {
    if (raw === null || typeof raw !== 'object') return null
    const id = normalizeId(raw.id)
    if (id === null) return null
    if (!ITEM_KINDS.includes(raw.kind)) return null
    const rect = normalizeRect(raw)
    if (rect === null) return null
    const isPet = raw.kind === 'pet'
    const src = isPet ? normalizeAssetUrl(raw.src) : null
    const fallback = isPet ? normalizeSemantic(raw.fallback) : null
    const idlePool = isPet ? normalizeIdlePool(raw.idlePool) : null
    const badge = isPet ? normalizeBadge(raw.badge) : null
    return {
      id,
      kind: raw.kind,
      role: isPet ? normalizeRole(raw.role) : null,
      anim: isPet ? normalizeAnim(raw.anim) : null,
      ...(badge === null ? {} : { badge }),
      // 只有真的用得上时才带这两个字段：旧场景形状保持不变，测试/日志不无故多两个 null。
      ...(src === null ? {} : { src }),
      ...(fallback === null ? {} : { fallback }),
      ...(idlePool === null ? {} : { idlePool }),
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      label: normalizeLabel(raw.label, raw.kind),
      color: normalizeColor(raw.color)
    }
  }

  /**
   * 场景是宿主 → helper 的唯一绘制输入。
   *
   * v2 在 v1 的矩形/颜色/标签上加了 `role`（self/guest/visitor）与 `anim`（dsh-pet 素材名），
   * 以及整包的 `reset`（渲染端重新出生所有宠物）。未知字段、未知 kind、重复 id 一律丢掉；
   * items 数量有上限，保证一条消息不会超行。
   */
  /**
   * 桌面控件（ticket 11）的宿主 → 渲染端状态。它描述「能点哪些按钮」以及按钮为什么置灰，
   * 不描述宠物的位置/物理；动作本身仍然只是**申请**，结果和场景由宿主回灌。
   *
   * control 的字段刻意保持扁平：
   *   visit    { enabled, reason }        串门按钮（reason 只在置灰时出现，必须是给人看的一句话）
   *   recall   { enabled, nickname }      召回入口（自己出门时桌面没有 self，需要常驻小胶囊）
   *   visitors [{ deviceId, label }]      可以送客的访客（item id 是 visitor:<deviceId>）
   *   street   [{ deviceId, label, action, canVisit, blockedReason }]  邻居面板那一排房子（ticket 21）
   *   gifts    [{ deviceId, giftId, kind, status, title, text?, statusText? }]  贴着访客的礼物卡（ticket 23）
   *   prompt   { deviceId, nickname }     放行卡队首；null 表示没有待决定的新邻居
   *   notice   { text, at }               最近一条人话提示（异步失败也靠它冒泡）
   */
  function emptyControls () {
    return {
      visit: { enabled: false, reason: null },
      recall: { enabled: false, nickname: null },
      visitors: [],
      street: [],
      gifts: [],
      prompt: null,
      notice: null
    }
  }

  function normalizeControls (raw) {
    const controls = emptyControls()
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return controls

    const visit = raw.visit
    if (visit !== null && typeof visit === 'object' && !Array.isArray(visit)) {
      controls.visit.enabled = visit.enabled === true
      controls.visit.reason = controls.visit.enabled
        ? null
        : normalizeText(visit.reason, null, MAX_REASON_LENGTH)
    }

    const recall = raw.recall
    if (recall !== null && typeof recall === 'object' && !Array.isArray(recall)) {
      controls.recall.enabled = recall.enabled === true
      controls.recall.nickname = controls.recall.enabled
        ? normalizeLabel(recall.nickname, '邻居')
        : null
    }

    const seenVisitors = new Set()
    if (Array.isArray(raw.visitors)) {
      for (const candidate of raw.visitors) {
        if (controls.visitors.length >= MAX_SCENE_ITEMS) break
        if (candidate === null || typeof candidate !== 'object') continue
        const deviceId = normalizeId(candidate.deviceId)
        if (deviceId === null || seenVisitors.has(deviceId)) continue
        seenVisitors.add(deviceId)
        controls.visitors.push({ deviceId, label: normalizeLabel(candidate.label, '邻居') })
      }
    }

    const seenStreet = new Set()
    if (Array.isArray(raw.street)) {
      for (const candidate of raw.street) {
        if (controls.street.length >= MAX_STREET_ITEMS) break
        if (candidate === null || typeof candidate !== 'object') continue
        const deviceId = normalizeId(candidate.deviceId)
        if (deviceId === null || seenStreet.has(deviceId)) continue
        seenStreet.add(deviceId)
        controls.street.push({
          deviceId,
          label: normalizeLabel(candidate.label, '邻居'),
          action: normalizeLabel(candidate.action, null),
          canVisit: candidate.canVisit === true,
          // 认不出的理由不猜：房子照样画，只是点不了（渲染端统一按“现在去不了”处理）。
          blockedReason: STREET_REASONS.has(candidate.blockedReason) ? candidate.blockedReason : null
        })
      }
    }

    // 礼物卡（ticket 23 / 25）：宿主已经按 visitor 算好标题/正文/大小/状态，这里只做形状校验。
    // 一张坏卡只丢它自己；deviceId/giftId 认不出来就没法落回访客身上，整张丢。
    const seenGifts = new Set()
    if (Array.isArray(raw.gifts)) {
      for (const candidate of raw.gifts) {
        if (controls.gifts.length >= MAX_GIFT_ITEMS) break
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
        const deviceId = normalizeId(candidate.deviceId)
        const giftId = normalizeGiftId(candidate.giftId)
        const kind = candidate.kind === 'text' || candidate.kind === 'file' ? candidate.kind : null
        if (deviceId === null || giftId === null || kind === null) continue
        if (seenGifts.has(giftId)) continue
        const status = typeof candidate.status === 'string' && GIFT_STATUSES.includes(candidate.status)
          ? candidate.status
          : null
        if (status === null) continue
        const title = normalizeText(candidate.title, '捎来一件东西', MAX_LABEL_LENGTH * 3)
        // received 不需要解释（正文/文件本身就是内容）；别的状态才画一行“怎么了”。
        const statusText = status === 'received'
          ? null
          : normalizeText(candidate.statusText, null, MAX_REASON_LENGTH * 2)
        if (kind === 'file') {
          const name = normalizeGiftName(candidate.name)
          const size = normalizeGiftSize(candidate.size)
          // 文件名/大小缺一个就画不出文件卡，整张丢掉（宁可没有，也不画一张半截的卡）。
          if (name === null || size === null) continue
          // 缩略图只在真的收下时才给；pending/receiving 时宿主即使误发也不画。
          const thumb = status === 'received' ? normalizeGiftThumb(candidate.thumb) : null
          seenGifts.add(giftId)
          controls.gifts.push({
            deviceId,
            giftId,
            kind: 'file',
            status,
            title,
            name,
            size,
            ...(thumb === null ? {} : { thumb }),
            ...(statusText === null ? {} : { statusText })
          })
          continue
        }
        seenGifts.add(giftId)
        // 正文只在该收到时出现；别的状态下即便宿主误发也不画。
        const text = status === 'received' ? normalizeNoteText(candidate.text) : null
        controls.gifts.push({
          deviceId,
          giftId,
          kind: 'text',
          status,
          title,
          ...(text === null ? {} : { text }),
          ...(statusText === null ? {} : { statusText })
        })
      }
    }

    const prompt = raw.prompt
    if (prompt !== null && typeof prompt === 'object' && !Array.isArray(prompt)) {
      const deviceId = normalizeId(prompt.deviceId)
      if (deviceId !== null) {
        controls.prompt = { deviceId, nickname: normalizeLabel(prompt.nickname, '邻居') }
      }
    }

    const notice = raw.notice
    if (notice !== null && typeof notice === 'object' && !Array.isArray(notice)) {
      const text = normalizeText(notice.text, null, MAX_NOTICE_LENGTH)
      const at = Number(notice.at)
      if (text !== null && Number.isFinite(at) && at >= 0) {
        controls.notice = { text, at: clampNumber(at, 0, Number.MAX_SAFE_INTEGER) }
      }
    }

    return controls
  }

  /**
   * 右键菜单（ticket 22）的宿主 → 渲染端状态。
   *
   * 形状刻意扁平，渲染端不做任何"拼菜单"的判断：
   *   tools  [{ id, label, hint? }]                 一级工具项，id ∈ MENU_TOOL_IDS
   *   groups [{ label, actions: [动画名] }]          「动作」下的分类；空分类不出现
   *   skins  [{ id, label }]                        「外观」的候选（ticket 32）；当前那张打勾
   *   activeSkin  string|null                       当前那张皮的 id
   *   actionsLocal  true（可缺省）                   「动作」来自当前这张皮，点了在本机播；
   *                                                 缺省 = dsh-pet 的动作，走 `/anim` 点播
   *
   * 菜单是高频交互入口：一条坏数据只能丢自己，绝不能让整份菜单消失。
   */
  function emptyMenu () {
    return { tools: [], groups: [], skins: [], activeSkin: null }
  }

  function normalizeMenu (raw) {
    const menu = emptyMenu()
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return menu

    const seenTools = new Set()
    if (Array.isArray(raw.tools)) {
      for (const candidate of raw.tools) {
        if (menu.tools.length >= MAX_MENU_TOOLS) break
        if (candidate === null || typeof candidate !== 'object') continue
        const id = typeof candidate.id === 'string' && MENU_TOOL_IDS.includes(candidate.id)
          ? candidate.id
          : null
        if (id === null || seenTools.has(id)) continue
        const label = normalizeText(candidate.label, null, MAX_LABEL_LENGTH)
        if (label === null) continue
        seenTools.add(id)
        const hint = normalizeText(candidate.hint, null, MAX_LABEL_LENGTH)
        menu.tools.push({ id, label, ...(hint === null ? {} : { hint }) })
      }
    }

    const seenGroups = new Set()
    if (Array.isArray(raw.groups)) {
      for (const candidate of raw.groups) {
        if (menu.groups.length >= MAX_MENU_GROUPS) break
        if (candidate === null || typeof candidate !== 'object') continue
        const label = normalizeText(candidate.label, null, MAX_LABEL_LENGTH)
        if (label === null || seenGroups.has(label)) continue
        const actions = []
        const seen = new Set()
        if (Array.isArray(candidate.actions)) {
          for (const name of candidate.actions) {
            if (actions.length >= MAX_MENU_ACTIONS) break
            const anim = normalizeAnim(name)
            if (anim === null || seen.has(anim)) continue
            seen.add(anim)
            actions.push(anim)
          }
        }
        // 空分类不画：dsh-pet 的配置里就有没配动作的档位（事件、转向…），留一排空箭头更糟。
        if (actions.length === 0) continue
        seenGroups.add(label)
        menu.groups.push({ label, actions })
      }
    }

    const seenSkins = new Set()
    if (Array.isArray(raw.skins)) {
      for (const candidate of raw.skins) {
        if (menu.skins.length >= MAX_SKIN_CHOICES) break
        if (candidate === null || typeof candidate !== 'object') continue
        const id = normalizeSkinId(candidate.id)
        if (id === null || seenSkins.has(id)) continue
        const label = normalizeText(candidate.label, null, MAX_LABEL_LENGTH)
        if (label === null) continue
        seenSkins.add(id)
        menu.skins.push({ id, label })
      }
    }
    // 当前那张皮：只认真的在候选里的 id，否则当作"没有当前项"。
    const active = normalizeSkinId(raw.activeSkin)
    menu.activeSkin = active !== null && seenSkins.has(active) ? active : null

    // 动作的来源跟着皮走：只有宿主明说「这些动作在当前皮里」才置真。
    // 缺省不写这个字段，老场景/老宿主的形状一个字不变。
    if (raw.actionsLocal === true) menu.actionsLocal = true

    return menu
  }

  /**
   * 把一块面板（菜单一级 / 子菜单）摆到锚点旁边：贴右翻左、贴下翻上，再夹进工作区。
   *
   * 锚点是一块矩形：一级菜单用"指针处 1×1"，子菜单用"父项那一条"。
   * 返回的是窗口局部坐标，渲染端只负责写 style。
   */
  function placeMenu (anchor, size, area, options = {}) {
    const box = normalizeArea(area)
    const margin = clampNumber(options.margin ?? 8, 0, 64)
    const gap = clampNumber(options.gap ?? 2, 0, 32)
    const width = Math.max(1, Math.min(Math.round(size?.width ?? 0), box.width))
    const height = Math.max(1, Math.min(Math.round(size?.height ?? 0), box.height))
    const anchorX = Number.isFinite(anchor?.x) ? anchor.x : 0
    const anchorY = Number.isFinite(anchor?.y) ? anchor.y : 0
    const anchorW = Number.isFinite(anchor?.width) ? anchor.width : 0
    const maxX = Math.max(margin, box.width - width - margin)
    const maxY = Math.max(margin, box.height - height - margin)

    // 先试贴在锚点右侧；放不下就翻到左侧（子菜单就是这样一层层展开的）。
    let x = anchorX + anchorW + gap
    if (x + width > box.width - margin) x = anchorX - width - gap
    // 纵向默认对齐锚点顶部；底部放不下就往上顶。
    let y = anchorY
    if (y + height > box.height - margin) y = anchorY + (anchor?.height ?? 0) - height
    if (y < margin) y = box.height - height - margin
    return {
      x: clampNumber(x, margin, maxX),
      y: clampNumber(y, margin, maxY),
      width,
      height
    }
  }

  function normalizeScene (raw) {
    const items = []
    if (raw !== null && typeof raw === 'object' && Array.isArray(raw.items)) {
      const seen = new Set()
      for (const candidate of raw.items) {
        if (items.length >= MAX_SCENE_ITEMS) break
        const item = normalizeItem(candidate)
        if (item === null || seen.has(item.id)) continue
        seen.add(item.id)
        items.push(item)
      }
    }
    return {
      version: SCENE_VERSION,
      reset: raw !== null && typeof raw === 'object' && raw.reset === true,
      items,
      controls: normalizeControls(raw !== null && typeof raw === 'object' ? raw.controls : null),
      // v3：右键菜单的内容。旧场景没有这个字段 → 空菜单，渲染端不弹。
      menu: normalizeMenu(raw !== null && typeof raw === 'object' ? raw.menu : null),
      // ticket 33：当前那张皮的素材目录。缺省 null = 没变，helper 沿用已有的根。
      assetRoots: normalizeAssetRoots(raw !== null && typeof raw === 'object' ? raw.assetRoots : null),
      // 多屏：每块屏在窗口局部坐标里的矩形。空数组 = 老宿主，物理退回整张桌面。
      floors: normalizeFloors(raw !== null && typeof raw === 'object' ? raw.floors : null)
    }
  }

  function emptyScene () {
    return {
      version: SCENE_VERSION,
      reset: false,
      items: [],
      controls: emptyControls(),
      menu: emptyMenu(),
      assetRoots: null,
      floors: []
    }
  }

  function normalizeArea (area) {
    const width = Number(area?.width)
    const height = Number(area?.height)
    return {
      width: Number.isFinite(width) && width > 0 ? Math.min(width, MAX_ITEM_SIZE) : 1440,
      height: Number.isFinite(height) && height > 0 ? Math.min(height, MAX_ITEM_SIZE) : 900
    }
  }

  function hashString (value) {
    const text = typeof value === 'string' ? value : String(value ?? '')
    let hash = 2166136261
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
  }

  function colorForPet (seed) {
    return PET_COLORS[hashString(seed) % PET_COLORS.length]
  }

  /**
   * 新宠物的初始横向速度：由 id 决定，所以同一只宠物每次出生都朝同一边、速度一样
   * （截图/冒烟可复现，但每只又各不相同）。竖向永远从 0 开始，由重力接管。
   */
  function initialVelocity (id) {
    const hash = hashString(id)
    const direction = (hash & 1) === 0 ? 1 : -1
    const speed = 48 + (hash % 93)
    return { vx: direction * speed, vy: 0 }
  }

  /**
   * 宿主 → helper 的宠物场景。位置只作为**出生点**：已经在场上的宠物由渲染端保留自己的
   * 位置/速度，宿主改 x/y 不会让它瞬移（要瞬移就带 reset:true）。
   *
   * 纯函数，不读时钟/随机数：同一份 pets + workArea 永远得到同一份场景。
   *
   * @param {Array<{id:string,role?:string,label?:string,anim?:string|null,color?:string,src?:string,fallback?:string}>} pets
   * @param {{x?:number,y?:number,width:number,height:number}} workArea
   * @param {{size?:number,reset?:boolean,controls?:object}} [options]
   */
  /**
   * 皮给的尺寸是**相对比例**（ticket 35 / ADR-0013 §决定 7）：`462` 为 1.0。
   * 462 是 `src/skin-sources.js` 的 `DEFAULT_SIZE`，这里是普通 script，只能各写一份。
   */
  const SKIN_BASE_SIZE = 462
  const SKIN_SCALE_MIN = 0.5
  const SKIN_SCALE_MAX = 2

  /** 逐只的显示比例：没给 `size`（访客 / 老场景）就是 1.0。 */
  function scaleFactorOf (size) {
    if (!Number.isInteger(size) || size <= 0) return 1
    return clampNumber(size / SKIN_BASE_SIZE, SKIN_SCALE_MIN, SKIN_SCALE_MAX)
  }

  function petScene (pets, workArea, options = {}) {
    const area = normalizeArea(workArea)
    /**
     * 出生区域：默认就是整个桌面（单屏时与旧行为逐像素相同）。
     * 多屏时宿主传「主屏在本窗口里的矩形」：宠物生在主屏上，而不是整张虚拟桌面的正中
     * ——否则两块屏并排时会正好骑在接缝上。尺寸也按这块区域算，不随屏幕数量变大。
     */
    const home = clipRectToArea(options.homeArea, { x: 0, y: 0, width: area.width, height: area.height }) ??
      { x: 0, y: 0, width: area.width, height: area.height }
    const list = []
    if (Array.isArray(pets)) {
      const seen = new Set()
      for (const raw of pets) {
        if (list.length >= MAX_SCENE_ITEMS) break
        if (raw === null || typeof raw !== 'object') continue
        const id = normalizeId(raw.id)
        if (id === null || seen.has(id)) continue
        seen.add(id)
        const role = normalizeRole(raw.role) ?? 'guest'
        const badge = normalizeBadge(raw.badge)
        const idlePool = normalizeIdlePool(raw.idlePool)
        // 访客自己的素材（ticket 17）：宿主把拉到的 cache URL 放在 pets 里，
        // 这里必须原样带下去，否则渲染端看不到 src，只能拿本机同名动作顶替。
        const src = normalizeAssetUrl(raw.src)
        // 语义标签给不认识这张皮的桌面画通用表情；与 src 同一条路。
        const fallback = normalizeSemantic(raw.fallback)
        list.push({
          id,
          role,
          label: normalizeLabel(raw.label, role === 'self' ? '我' : '邻居'),
          anim: normalizeAnim(raw.anim),
          ...(badge === null ? {} : { badge }),
          ...(idlePool === null ? {} : { idlePool }),
          ...(src === null ? {} : { src }),
          ...(fallback === null ? {} : { fallback }),
          // 皮自带的尺寸（ticket 35）：只有本机那只带，访客没有皮。
          ...(Number.isInteger(raw.size) && raw.size > 0 ? { size: raw.size } : {}),
          color: normalizeColor(raw.color)
        })
      }
    }

    const sizeOption = Number(options.size)
    const base = Math.round(Math.min(home.width, home.height) * 0.12)
    const baseSize = Number.isFinite(sizeOption) && sizeOption >= 16
      ? Math.round(sizeOption)
      : base
    const margin = clampNumber(Math.round(Math.min(home.width, home.height) * 0.035), 8, 48)
    const count = list.length

    // 每只自己的包围盒（ticket 35）：基准尺寸 × 这张皮的比例。两只都是 462 时与旧行为逐像素相同。
    const boxes = list.map((pet) => {
      const size = clampNumber(
        Math.round(baseSize * scaleFactorOf(pet.size)),
        16,
        Math.max(16, Math.min(Math.floor(area.width), Math.floor(area.height)))
      )
      let labelHeight = clampNumber(Math.round(size * 0.22), 14, 32)
      if (size + labelHeight > area.height) labelHeight = Math.max(0, Math.floor(area.height - size))
      return {
        width: Math.max(1, size),
        height: Math.max(1, Math.min(area.height, size + labelHeight))
      }
    })

    // 按累加宽度排（票 35 §布局）：全部一样宽时，下面的公式与旧的 `margin + span*i/(n-1)` 等价。
    const totalWidth = boxes.reduce((sum, box) => sum + box.width, 0)
    const gap = count <= 1 ? 0 : Math.max(0, (home.width - margin * 2 - totalWidth) / (count - 1))
    let cursor = home.x + margin

    const items = list.map((pet, index) => {
      const box = boxes[index]
      const x = count <= 1
        ? home.x + Math.round((home.width - box.width) / 2)
        : Math.round(clampNumber(cursor, home.x, home.x + Math.max(0, home.width - box.width)))
      cursor += box.width + gap
      return {
        id: pet.id,
        kind: 'pet',
        role: pet.role,
        anim: pet.anim,
        ...(pet.badge === undefined ? {} : { badge: pet.badge }),
        ...(pet.idlePool === undefined ? {} : { idlePool: pet.idlePool }),
        ...(pet.src === undefined ? {} : { src: pet.src }),
        ...(pet.fallback === undefined ? {} : { fallback: pet.fallback }),
        x,
        // 出生点贴**主屏**的底边（home 就是主屏；单屏时 home == 整块工作区）。
        // 用整张并集的底边会让矮屏上的宠物一出生就掉到屏幕外。
        y: groundY({ height: box.height }, area, home.y + home.height),
        width: box.width,
        height: box.height,
        label: pet.label,
        color: pet.color
      }
    })
    return {
      version: SCENE_VERSION,
      reset: options.reset === true,
      items,
      controls: normalizeControls(options.controls),
      menu: normalizeMenu(options.menu),
      assetRoots: normalizeAssetRoots(options.assetRoots),
      floors: normalizeFloors(options.floors)
    }
  }

  /** 截图/冒烟用的固定演示场景：自己的 + 两位访客，走真实素材。 */
  function demoPetScene (workArea) {
    return petScene([
      { id: 'self', role: 'self', label: '小蓝', anim: '东张西望', color: PET_COLORS[0] },
      { id: 'guest:demo-a', role: 'guest', label: '阿蟹', anim: '原地小憩沉眠', color: PET_COLORS[1] },
      { id: 'guest:demo-b', role: 'guest', label: '泡泡', anim: '螃蟹走路', color: PET_COLORS[2] }
    ], workArea, { reset: true })
  }

  /** 求矩形与工作区的交集；没有交集返回 null。 */
  function clipRectToArea (rect, area) {
    const source = normalizeRect(rect)
    const box = normalizeRect(area)
    if (source === null || box === null) return null
    const left = Math.max(source.x, box.x)
    const top = Math.max(source.y, box.y)
    const right = Math.min(source.x + source.width, box.x + box.width)
    const bottom = Math.min(source.y + source.height, box.y + box.height)
    if (!(right > left) || !(bottom > top)) return null
    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  /**
   * 渲染端上报的命中矩形。id 只用于诊断和「场景里删掉的宠物立刻撤销命中区」，
   * 没有 id 的矩形也接受（更保守的将来）。
   *
   * 这是**不可信输入**：渲染端可以报一个 10000×10000 的矩形，命中判定会照单全收，
   * 等于把整块屏幕变成可交互区。所以：
   *   - 单边超过 `MAX_HIT_RECT_SIZE` 的矩形直接丢掉（夹小没有意义，那仍然很大）；
   *   - 传了 `area`（窗口/工作区）时，矩形裁到工作区里，裁完为空的丢掉；
   *   - 数量上限 `MAX_HIT_RECTS`，超出的忽略。
   * 所有失败方向都是“少一块命中区”，永远不会“多一块”。
   *
   * @param {Array<object>} raw
   * @param {{area?:object}} [options]
   */
  function normalizeRects (raw, options = {}) {
    const rects = []
    if (!Array.isArray(raw)) return rects
    const area = options !== null && typeof options === 'object' && options.area !== undefined
      ? normalizeRect(options.area)
      : null
    for (const candidate of raw) {
      if (rects.length >= MAX_HIT_RECTS) break
      if (candidate === null || typeof candidate !== 'object') continue
      const rect = normalizeRect(candidate)
      if (rect === null) continue
      if (rect.width > MAX_HIT_RECT_SIZE || rect.height > MAX_HIT_RECT_SIZE) continue
      const clipped = area === null ? rect : clipRectToArea(rect, area)
      if (clipped === null) continue
      rects.push({ id: normalizeId(candidate.id), ...clipped })
    }
    return rects
  }

  /**
   * 场景里的 `floors`：每块显示器的**工作区**换算到窗口局部坐标后的矩形。
   *
   * 宿主从 `ready.displays` 算出来随场景下发；渲染端先用 `walkBands()` 合成地面带，
   * 再用 `bandAt()` 找宠物脚下那条带。多屏高度不一致时，这是宠物不掉进矮屏下方黑区的
   * 唯一依据——整张并集的下边界只对“所有屏一样高”成立。
   *
   * 不可信输入：形状不合法、数量超限都直接丢；空数组 = 老宿主，物理退回整张桌面。
   */
  function normalizeFloors (raw) {
    const floors = []
    if (!Array.isArray(raw)) return floors
    for (const candidate of raw) {
      if (floors.length >= MAX_DISPLAYS) break
      const floor = normalizeRect(candidate)
      if (floor !== null) floors.push(floor)
    }
    return floors
  }

  /**
   * 一条可以连续行走的“地面带”。
   *
   * 同一底边（±1 DIP）且水平相邻/重叠的屏合成一条：两块同高的屏可以自由来回走。
   * 底边不同（分辨率/任务栏/摆放不同）就是两条独立的带——宠物只能在自己那条带上走，
   * 不会走进矮屏下方那块没有显示器的黑区。拖拽不受这个限制。
   */
  function normalizeBands (raw) {
    const bands = []
    if (!Array.isArray(raw)) return bands
    for (const candidate of raw) {
      if (bands.length >= MAX_DISPLAYS) break
      if (candidate === null || typeof candidate !== 'object') continue
      const x = Number(candidate.x)
      const width = Number(candidate.width)
      const bottom = Number(candidate.bottom)
      if (![x, width, bottom].every(Number.isFinite) || width <= 0) continue
      bands.push({
        x: clampNumber(x, -MAX_COORD, MAX_COORD),
        width: clampNumber(width, 0.001, MAX_ITEM_SIZE),
        bottom: clampNumber(bottom, -MAX_COORD, MAX_COORD)
      })
    }
    return bands
  }

  /**
   * 把显示器的 floors 合成地面带：底边相同且水平相邻的屏连成一条。
   * 返回 `[{ x, width, bottom }]`（窗口局部 DIP，按底边从高到低排列）。
   */
  function walkBands (floors) {
    const entries = normalizeFloors(floors)
      .map((floor) => ({ left: floor.x, right: floor.x + floor.width, bottom: floor.y + floor.height }))
      .sort((left, right) => (left.bottom - right.bottom) || (left.left - right.left))
    const bands = []
    for (const entry of entries) {
      let band = null
      for (const candidate of bands) {
        if (Math.abs(candidate.bottom - entry.bottom) > 1) continue
        if (entry.left > candidate.right + 1 || entry.right < candidate.left - 1) continue
        band = candidate
        break
      }
      if (band === null) {
        bands.push({ left: entry.left, right: entry.right, bottom: entry.bottom })
      } else {
        band.left = Math.min(band.left, entry.left)
        band.right = Math.max(band.right, entry.right)
      }
    }
    // 合并可能让两条带变得相邻/重叠（≤8 条，直接收敛）。
    let merged = true
    while (merged) {
      merged = false
      for (let index = 0; index < bands.length && !merged; index += 1) {
        for (let other = index + 1; other < bands.length; other += 1) {
          if (Math.abs(bands[index].bottom - bands[other].bottom) > 1) continue
          if (bands[index].left > bands[other].right + 1 || bands[other].left > bands[index].right + 1) continue
          bands[index].left = Math.min(bands[index].left, bands[other].left)
          bands[index].right = Math.max(bands[index].right, bands[other].right)
          bands.splice(other, 1)
          merged = true
          break
        }
      }
    }
    return bands.map((band) => ({ x: band.left, width: band.right - band.left, bottom: band.bottom }))
  }

  /**
   * 点属于哪条地面带。先看水平方向落在哪条带里，再取竖直方向最近的那条——
   * 这样被拖到矮屏下方的黑区松手时，会回到**脚下那块屏**，而不是旁边更近的高屏。
   * 水平方向在空洞里（或超出所有带）时退回 2D 最近。
   */
  function bandAt (bands, point) {
    const list = normalizeBands(bands)
    const target = normalizePoint(point)
    if (target === null || list.length === 0) return null
    let best = null
    let bestDistance = Infinity
    for (const band of list) {
      if (target.x < band.x || target.x >= band.x + band.width) continue
      const distance = Math.abs(target.y - band.bottom)
      if (distance < bestDistance) {
        best = band
        bestDistance = distance
      }
    }
    if (best !== null) return best
    for (const band of list) {
      const dx = Math.max(band.x - target.x, 0, target.x - (band.x + band.width))
      const dy = target.y - band.bottom
      const distance = dx * dx + dy * dy
      if (distance < bestDistance) {
        best = band
        bestDistance = distance
      }
    }
    return best
  }

  /**
   * 走一步，但只允许在这条地面带里走：
   *   - x 夹在带的左右边界（走到屏边就停下，不会跨进矮屏下方的黑区）；
   *   - y 贴这条带的底边（被拖进空洞后松手/热插拔也会被拉回带上）。
   * 拖拽不走这里：`dragBody` 用整张桌面，才能跨屏。
   */
  function stepOnBand (body, workArea, dt, band) {
    const area = normalizeArea(workArea)
    if (band === null || typeof band !== 'object') return stepBody(body, area, dt)
    const next = stepBody(body, area, dt, band.bottom)
    let x = next.x
    let vx = next.vx
    if (x < band.x) {
      x = band.x
      if (vx < 0) vx = -vx * PHYSICS.WALL_BOUNCE
    } else if (x + next.width > band.x + band.width) {
      x = Math.max(band.x, band.x + band.width - next.width)
      if (vx > 0) vx = -vx * PHYSICS.WALL_BOUNCE
    }
    return snapBodyToFloor({ ...next, x, vx }, area, band.bottom)
  }

  /** 出生/松手/热插拔：把身体整体挪进一条地面带（x、y 都夹），保证它在可见的屏上。 */
  function confineBodyToBand (body, workArea, band) {
    const area = normalizeArea(workArea)
    const current = createBody(body, area)
    if (band === null || typeof band !== 'object') return current
    const x = clampNumber(current.x, band.x, Math.max(band.x, band.x + band.width - current.width))
    return snapBodyToFloor({ ...current, x }, area, band.bottom)
  }

  /**
   * 渲染端上报的素材诊断（ipc `dsh-zoo:media`）→ 主进程 `helperStatus.media` 的那一条。
   *
   * 现场只有这一个探针能回答「宠物到底画出来没有」，所以它必须跟着**每一次**状态变化走：
   * 开始加载报 `loading`，`loadeddata` 报 `video`，降级报 `pending` / `svg`。
   * 以前只在开始加载时报一次，`video` 永远不回报，于是状态里长期停在 `loading`——
   * 看起来像素材坏了，其实只是探针不会说「好了」。
   *
   * `readyState` / `visibility` 是给「为什么没画出来」用的：文件读不出来时 `readyState`
   * 卡在 0，窗口被遮挡/隐藏时 `visibility` 是 `hidden`。渲染端不可信，字符串一律走
   * `normalizeToken`（空、超长、控制字符都判无效），不截断——截断会把脏数据洗成看起来合法的名字。
   *
   * 这是**唯一**一处收这个形状的地方：preload 原样转交、主进程与宿主都调它。
   * 各写一份白名单就会像 ticket 28 一样：加了字段，其中一处悄悄削掉。
   *
   * @param {unknown} raw
   * @param {number} [at] 上报时刻；主进程收 ipc 时传 `Date.now()`，宿主侧用上报里带的那个
   * @returns {{clip:string|number|null,source:string|null,readyState:number|null,visibility:string|null,failed:string[],at:number|null}|null}
   */
  function normalizeMediaReport (raw, at) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const failed = []
    if (Array.isArray(raw.failed)) {
      for (const item of raw.failed.slice(-MAX_MEDIA_FAILED)) {
        if (typeof item !== 'string') continue
        const name = normalizeToken(item)
        if (name !== null) failed.push(name)
      }
    }
    const readyState = Number.isInteger(raw.readyState) && raw.readyState >= 0 && raw.readyState <= 4
      ? raw.readyState
      : null
    const visibility = raw.visibility === 'visible' || raw.visibility === 'hidden' || raw.visibility === 'prerender'
      ? raw.visibility
      : null
    return {
      clip: normalizeToken(raw.clip),
      source: normalizeToken(raw.source),
      readyState,
      visibility,
      failed,
      at: Number.isFinite(at) ? at : (isFiniteNumber(raw.at) ? raw.at : null)
    }
  }

  /**
   * 渲染端上报的「可信输入」（ipc `dsh-zoo:input`，ticket 30）。
   *
   * 现场出现过「窗口显示可交互、右键能开菜单，真实左键却进不了渲染端」。`ignoring=false`
   * 只说明我们把 `WS_EX_TRANSPARENT` 摘了，`busy=false` 只说明租约没立起来——中间没有任何
   * 东西能证明「点击真的到过渲染端」。这个计数器就是那个东西：只有 `isTrusted` 的按下才报。
   *
   * @param {unknown} raw
   * @returns {{type:'down'|'up'}|null}
   */
  function normalizeInputReport (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (raw.type !== 'down' && raw.type !== 'up') return null
    return { type: raw.type }
  }

  /** 编码一行；超长返回 null，调用方必须放弃发送（而不是把管道写坏）。 */
  function encodeMessage (message) {
    if (message === null || typeof message !== 'object') return null
    let line
    try {
      line = JSON.stringify(message)
    } catch {
      return null
    }
    if (typeof line !== 'string' || line.length > MAX_LINE_LENGTH) return null
    return line + '\n'
  }

  function parseLine (line) {
    if (typeof line !== 'string') return { ok: false, error: 'not-string' }
    const trimmed = line.trim()
    if (trimmed === '') return { ok: false, error: 'empty' }
    let value
    try {
      value = JSON.parse(trimmed)
    } catch {
      return { ok: false, error: 'bad-json' }
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'not-object' }
    }
    return { ok: true, value }
  }

  /**
   * 按 \n 切行，行上限硬约束。超长行不解析、不缓存，丢弃到下一个换行符为止；
   * 返回的条目只有 { type:'line' } 与 { type:'oversize' } 两种，超过上限只报一次。
   */
  function createLineParser (options = {}) {
    const maxLength = Number.isFinite(options.maxLineLength) && options.maxLineLength > 0
      ? options.maxLineLength
      : MAX_LINE_LENGTH
    let buffered = ''
    let discardingTail = false

    return {
      push (chunk) {
        const out = []
        buffered += String(chunk)
        let index
        while ((index = buffered.indexOf('\n')) !== -1) {
          const raw = buffered.slice(0, index)
          buffered = buffered.slice(index + 1)
          if (discardingTail) {
            // 这是超长行的尾巴：已经报过一次 oversize，这里静默吞掉。
            discardingTail = false
            continue
          }
          if (raw.length > maxLength) {
            out.push({ type: 'oversize' })
            continue
          }
          out.push({ type: 'line', line: raw.endsWith('\r') ? raw.slice(0, -1) : raw })
        }
        if (discardingTail) {
          // 这一整段都没有换行：仍然是那条超长行的尾巴，直接丢掉，别把内存撑爆。
          buffered = ''
        } else if (buffered.length > maxLength) {
          discardingTail = true
          buffered = ''
          out.push({ type: 'oversize' })
        }
        return out
      },
      reset () {
        buffered = ''
        discardingTail = false
      },
      pending () {
        return buffered.length
      }
    }
  }

  function normalizePoint (raw) {
    if (raw === null || typeof raw !== 'object') return null
    const x = Number(raw.x)
    const y = Number(raw.y)
    if (![x, y].every(Number.isFinite)) return null
    return { x: clampNumber(x, -MAX_COORD, MAX_COORD), y: clampNumber(y, -MAX_COORD, MAX_COORD) }
  }

  function normalizeDisplay (raw, index) {
    if (raw === null || typeof raw !== 'object') return null
    const id = Number(raw.id)
    const bounds = normalizeRect(raw.bounds)
    const workArea = normalizeRect(raw.workArea)
    if (!Number.isFinite(id) || bounds === null || workArea === null) return null
    return {
      id,
      index,
      bounds,
      workArea,
      scaleFactor: Number.isFinite(Number(raw.scaleFactor)) && Number(raw.scaleFactor) > 0
        ? Number(raw.scaleFactor)
        : 1,
      primary: raw.primary === true
    }
  }

  /** 宿主 → helper 的命令白名单。未知 type / 缺字段一律 not-ok，helper 只记调试信息。 */
  function normalizeHostCommand (raw, { debug = true } = {}) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'not-object' }
    }
    const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
    const id = normalizeToken(raw.id)
    // 调试/冒烟命令只在显式 debug 模式可解析；普通运行的 helper 连白名单都进不来。
    // 默认 true 只给既有单测用；helper 的 main 会显式传 `{debug: debugEnabled}`。
    if (debug !== true && type.startsWith('debug-')) {
      return { ok: false, error: 'debug-disabled' }
    }
    switch (type) {
      case 'show':
      case 'hide':
      case 'quit':
        return { ok: true, command: { type, id } }
      case 'ping':
      case 'status':
        return { ok: true, command: { type, id } }
      case 'update':
        if (raw.scene === null || typeof raw.scene !== 'object' || Array.isArray(raw.scene)) {
          return { ok: false, error: 'bad-scene' }
        }
        return { ok: true, command: { type, id, scene: normalizeScene(raw.scene) } }
      case 'action-result': {
        if (id === null || typeof raw.id !== 'string') return { ok: false, error: 'bad-id' }
        return {
          ok: true,
          command: {
            type,
            id,
            ok: raw.ok === true,
            notice: normalizeText(raw.notice, null, MAX_NOTICE_LENGTH),
            error: normalizeLabel(raw.error, null)
          }
        }
      }
      case 'open-url': {
        const url = normalizeHttpUrl(raw.url)
        if (url === null) return { ok: false, error: 'bad-url' }
        return { ok: true, command: { type, id, url } }
      }
      /**
       * 礼物卡的系统动作（ticket 23）：路径只由宿主给，渲染端连字符串都拿不到。
       * 三个带路径的命令共用 `normalizePath`（必须是绝对路径）；`gift-copy` 只带正文。
       */
      case 'gift-open':
      case 'gift-reveal':
      case 'gift-discard': {
        const path = normalizePath(raw.path)
        if (path === null) return { ok: false, error: 'bad-path' }
        return { ok: true, command: { type, id, path } }
      }
      case 'gift-copy': {
        const text = normalizeNoteText(raw.text)
        if (text === null) return { ok: false, error: 'bad-text' }
        return { ok: true, command: { type, id, text } }
      }
      /**
       * 「带派」小窗（ticket 24）：宿主把背包内容 + 限额交给 helper。
       * `open:true` 打开/聚焦；`open:false` 只刷新已开着的窗（撤掉一件之后）。
       * 路径不在这个命令里：窗口只发 giftId，删除由宿主查背包。
       */
      case 'bring-window':
        return { ok: true, command: { type, id, ...normalizeBringWindow(raw) } }
      /**
       * 农场小窗（ticket 40）：`open:true` 打开/聚焦，`open:false` 只刷新已经开着的那扇。
       * 内容和「带派」一样由宿主算好：窗口不读盘、不联网，连 `/state` 都拿不到。
       */
      case 'farm-window':
        return { ok: true, command: { type, id, ...normalizeFarmWindow(raw) } }
      case 'shot': {
        const path = normalizePath(raw.path)
        if (path === null) return { ok: false, error: 'bad-path' }
        // 冒烟可以点名抓小窗；主窗仍是默认目标。
        const window = raw.window === 'bring' ? 'bring' : raw.window === 'farm' ? 'farm' : null
        return { ok: true, command: { type, id, path, ...(window === null ? {} : { window }) } }
      }
      case 'pointer': {
        if (raw.clear === true) return { ok: true, command: { type, id, point: null } }
        const point = normalizePoint(raw)
        if (point === null) return { ok: false, error: 'bad-point' }
        return { ok: true, command: { type, id, point } }
      }
      case 'debug-move': {
        const point = normalizePoint(raw)
        if (point === null) return { ok: false, error: 'bad-point' }
        return { ok: true, command: { type, id, point } }
      }
      case 'debug-input': {
        const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : ''
        if (!['move', 'down', 'up'].includes(action)) return { ok: false, error: 'bad-action' }
        const point = normalizePoint(raw)
        if (point === null) return { ok: false, error: 'bad-point' }
        return { ok: true, command: { type, id, point, action } }
      }
      case 'debug-renderer':
        return { ok: true, command: { type, id } }
      case 'debug-rename':
        // 冒烟用：开/关改名小窗（它没有渲染端可点击的关闭按钮，测试只能从这里关）。
        return { ok: true, command: { type, id, close: raw.close === true } }
      case 'debug-blur': {
        // 冒烟用：模拟输入法候选窗/别的窗口抢走小窗焦点。小窗都**不**该因此关掉
        // （现场：打中文时小窗消失；农场窗也一样）。
        const window = raw.window === 'bring' ? 'bring' : raw.window === 'farm' ? 'farm' : 'rename'
        return { ok: true, command: { type, id, window } }
      }
      case 'debug-farm-submit': {
        // 冒烟用：在农场小窗里提交一次动作，走和用户点击一模一样的 preload → IPC。
        const farmAction = normalizeFarmAction(raw)
        if (farmAction === null) return { ok: false, error: 'bad-farm-action' }
        return { ok: true, command: { type, id, ...farmAction } }
      }
      case 'debug-farm-tab': {
        // 冒烟用：切到农场小窗的某个页签（农场 / 交易所 / 雇工 / 记录）。
        const tab = raw.tab === 'market' || raw.tab === 'hire' || raw.tab === 'log'
          ? raw.tab
          : 'farm'
        return { ok: true, command: { type, id, tab } }
      }
      case 'debug-farm-plant-open':
      case 'debug-farm-plant-close':
        // 冒烟用（ticket 47）：点空地卡打开播种弹窗 / 点 × 关上，走窗口的真实点击。
        return { ok: true, command: { type, id } }
      case 'debug-farm-batch': {
        // 冒烟用（ticket 47）：点「一键播种 / 一键收割」，验批量队列真的发动作。
        const kind = raw.kind === 'plant' ? 'plant' : 'harvest'
        return { ok: true, command: { type, id, kind } }
      }
      case 'debug-farm-close': {
        // 冒烟用：像用户一样关窗（点 × 或按 Esc），验小窗自己的关闭路径。
        const via = raw.via === 'escape' ? 'escape' : 'button'
        return { ok: true, command: { type, id, via } }
      }
      case 'debug-farm-read':
        // 冒烟用：读农场小窗里每张卡的 stage / countdown 文本，验多地块倒计时。
        return { ok: true, command: { type, id } }
      case 'debug-farm-block': {
        // 冒烟用：阻塞渲染进程 N 毫秒，模拟 setInterval 被延迟/后台节流。
        const ms = Math.min(15000, Math.max(0, Math.floor(Number(raw.ms) || 0)))
        return { ok: true, command: { type, id, ms } }
      }
      case 'debug-gift-submit':
        // 冒烟用：把一段字条填进「带派」小窗并提交——验窗口 → 主进程 → 宿主那条回路。
        if (typeof raw.text !== 'string') return { ok: false, error: 'bad-text' }
        return { ok: true, command: { type, id, text: raw.text.slice(0, MAX_GIFT_TEXT_LENGTH * 2) } }
      case 'debug-gift-remove':
        // 冒烟用：点背包列表里第一个可撤的「撤掉」（out 中的按钮是禁用的）。
        return { ok: true, command: { type, id } }
      case 'debug-dispatch': {
        const phase = typeof raw.phase === 'string' ? raw.phase.trim().toLowerCase() : ''
        if (!['down', 'move', 'up', 'click', 'context', 'blur'].includes(phase)) return { ok: false, error: 'bad-phase' }
        const point = normalizePoint(raw)
        if (point === null) return { ok: false, error: 'bad-point' }
        return { ok: true, command: { type, id, point, phase } }
      }
      case 'debug-freeze-hover':
        return { ok: true, command: { type, id, frozen: raw.frozen !== false } }
      case 'debug-freeze-busy':
        return { ok: true, command: { type, id, frozen: raw.frozen !== false } }
      case 'debug-busy-max': {
        const ms = Number(raw.ms)
        // 0 = 恢复默认；其余允许 200ms..60s，方便冒烟在几秒内验证硬上限。
        if (!Number.isFinite(ms) || ms < 0 || ms > 60000) return { ok: false, error: 'bad-ms' }
        return { ok: true, command: { type, id, ms: ms >= 200 ? Math.round(ms) : 0 } }
      }
      case 'debug-lock-input':
        return { ok: true, command: { type, id, locked: raw.locked !== false } }
      case 'debug-kick-input':
        // 不重启地重放一次「穿透 → 可交互」；只有 helper 是 debug 模式才认（见 desktop/main.js）。
        return { ok: true, command: { type, id } }
      default:
        return { ok: false, error: 'unknown-type' }
    }
  }

  function normalizeStatus (raw) {
    const bounds = normalizeRect(raw.bounds)
    const pointer = normalizePoint(raw.pointer)
    return {
      ignoring: raw.ignoring !== false,
      sceneItems: Number.isInteger(raw.sceneItems) && raw.sceneItems >= 0 ? raw.sceneItems : 0,
      media: normalizeMediaReport(raw.media),
      mediaHistory: Array.isArray(raw.mediaHistory)
        ? raw.mediaHistory.slice(-20)
            .map((entry) => normalizeMediaReport(entry))
            .filter((entry) => entry !== null)
        : [],
      hoverInside: raw.hoverInside === true,
      lastHoverAgeMs: isFiniteNumber(raw.lastHoverAgeMs) && raw.lastHoverAgeMs >= 0
        ? raw.lastHoverAgeMs
        : null,
      insideForMs: isFiniteNumber(raw.insideForMs) && raw.insideForMs >= 0
        ? raw.insideForMs
        : null,
      hoverFrozen: raw.hoverFrozen === true,
      busy: raw.busy === true,
      busyAgeMs: isFiniteNumber(raw.busyAgeMs) && raw.busyAgeMs >= 0 ? raw.busyAgeMs : null,
      busyHeldMs: isFiniteNumber(raw.busyHeldMs) && raw.busyHeldMs >= 0 ? raw.busyHeldMs : null,
      busyBlocked: raw.busyBlocked === true,
      // ticket 30：可信左键到了几次、最后一次多久之前——「可交互但点不进来」就看这两个数。
      trustedInputs: Number.isInteger(raw.trustedInputs) && raw.trustedInputs >= 0 ? raw.trustedInputs : 0,
      lastTrustedInputAgeMs: isFiniteNumber(raw.lastTrustedInputAgeMs) && raw.lastTrustedInputAgeMs >= 0
        ? raw.lastTrustedInputAgeMs
        : null,
      busyCapMs: isFiniteNumber(raw.busyCapMs) && raw.busyCapMs >= 0 ? raw.busyCapMs : null,
      busyFrozen: raw.busyFrozen === true,
      rendererRects: Number.isInteger(raw.rendererRects) && raw.rendererRects >= 0 ? raw.rendererRects : 0,
      rendererRectsAgeMs: isFiniteNumber(raw.rendererRectsAgeMs) && raw.rendererRectsAgeMs >= 0
        ? raw.rendererRectsAgeMs
        : null,
      overlayRects: Number.isInteger(raw.overlayRects) && raw.overlayRects >= 0 ? raw.overlayRects : 0,
      overlayRectsAgeMs: isFiniteNumber(raw.overlayRectsAgeMs) && raw.overlayRectsAgeMs >= 0
        ? raw.overlayRectsAgeMs
        : null,
      visible: raw.visible === true,
      focused: raw.focused === true,
      focusable: raw.focusable === true,
      renameOpen: raw.renameOpen === true,
      // 开着 ≠ 看得见：冒烟用它区分「窗建出来了」和「窗真的显示在屏幕上」。
      renameVisible: raw.renameVisible === true,
      renameFocused: raw.renameFocused === true,
      bringOpen: raw.bringOpen === true,
      // ticket 40：农场小窗的打开/可见/焦点；冒烟靠这三个数等窗口真的出来。
      farmOpen: raw.farmOpen === true,
      farmVisible: raw.farmVisible === true,
      farmFocused: raw.farmFocused === true,
      alwaysOnTop: raw.alwaysOnTop === true,
      allWorkspaces: raw.allWorkspaces === true,
      bounds,
      pointer,
      debug: raw.debug === true
    }
  }

  /** helper → 宿主的事件白名单。未知字段忽略，坏事件整条丢弃。 */
  function normalizeHelperEvent (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'not-object' }
    }
    const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
    const id = normalizeToken(raw.id)
    switch (type) {
      case 'ready': {
        const workArea = normalizeRect(raw.workArea)
        if (workArea === null) return { ok: false, error: 'bad-work-area' }
        const displays = []
        if (Array.isArray(raw.displays)) {
          for (const candidate of raw.displays) {
            if (displays.length >= MAX_DISPLAYS) break
            const display = normalizeDisplay(candidate, displays.length)
            if (display !== null) displays.push(display)
          }
        }
        return {
          ok: true,
          event: {
            type,
            id,
            pid: Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null,
            workArea,
            displays,
            debug: raw.debug === true,
            shotMode: raw.shotMode === true
          }
        }
      }
      case 'hit': {
        const point = normalizePoint(raw.point)
        const rect = normalizeRect(raw.rect)
        return {
          ok: true,
          event: {
            type,
            id,
            inside: raw.inside === true,
            interactive: raw.interactive === true,
            itemId: normalizeId(raw.itemId),
            point,
            rect,
            reason: normalizeLabel(raw.reason, '')
          }
        }
      }
      case 'shot': {
        const path = normalizePath(raw.path)
        if (path === null) return { ok: false, error: 'bad-path' }
        return {
          ok: true,
          event: {
            type,
            id,
            path,
            width: Number.isInteger(raw.width) && raw.width > 0 ? raw.width : 0,
            height: Number.isInteger(raw.height) && raw.height > 0 ? raw.height : 0,
            bytes: Number.isInteger(raw.bytes) && raw.bytes >= 0 ? raw.bytes : 0
          }
        }
      }
      case 'renderer-state':
        return {
          ok: true,
          event: {
            type,
            id,
            state: raw.state !== null && typeof raw.state === 'object' && !Array.isArray(raw.state)
              ? raw.state
              : null
          }
        }
      case 'error':
        return {
          ok: true,
          event: {
            type,
            id,
            code: normalizeLabel(raw.code, 'helper-error'),
            message: normalizeText(raw.message, 'unknown error', MAX_ERROR_LENGTH)
          }
        }
      case 'farm-read': {
        // 冒烟用（ticket 47.1）：农场小窗里每张卡的 stage / countdown 文本。
        const plots = []
        if (Array.isArray(raw.plots)) {
          for (const candidate of raw.plots.slice(0, 20)) {
            if (candidate === null || typeof candidate !== 'object') continue
            plots.push({
              id: normalizeToken(candidate.id),
              stage: normalizeLabel(candidate.stage, ''),
              text: normalizeLabel(candidate.text, '')
            })
          }
        }
        return { ok: true, event: { type, id, plots } }
      }
      case 'farm-block':
        // 冒烟用（ticket 47.1）：渲染进程阻塞结束。
        return { ok: true, event: { type, id, ok: raw.ok === true } }
      case 'farm-window-state':
        // ticket 46：小窗真的开了/关了。宿主用它切换右键「农场」的开/关语义；
        // 用户点 ×/Esc 关窗也走这一条，所以不能只靠宿主自己的“我发过 open”。
        return {
          ok: true,
          event: {
            type,
            id,
            open: raw.open === true
          }
        }
      case 'action': {
        const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : ''
        if (!DESKTOP_ACTIONS.includes(action)) return { ok: false, error: 'bad-action' }
        if (id === null) return { ok: false, error: 'bad-id' }
        const needsDevice = action === 'end-visit' || action === 'admit' || action === 'reject' || action === 'dismiss'
        // `visit` 是「可能带对象」：邻居面板点某一户就带 deviceId；不带则由宿主随机挑。
        const deviceId = needsDevice || action === 'visit' ? normalizeId(raw.deviceId) : null
        if (needsDevice && deviceId === null) return { ok: false, error: 'bad-device-id' }
        // 礼物动作只带 giftId（UUID），路径永远不出渲染端。
        const needsGift = GIFT_ACTIONS.includes(action)
        const giftId = needsGift ? normalizeGiftId(raw.giftId) : null
        if (needsGift && giftId === null) return { ok: false, error: 'bad-gift' }
        // 「带派」小窗的提交（ticket 24）：只有 bring 带物品正文；菜单上的 bring 不带，
        // 那一条由宿主用来打开小窗。字段不合法的提交整条拒绝，不做半截猜测。
        let gift = null
        if (action === 'bring' && raw.gift !== undefined && raw.gift !== null) {
          gift = normalizeBringGift(raw.gift)
          if (gift === null) return { ok: false, error: 'bad-gift' }
        }
        // 只有改名带正文：清洗交给宿主（那里有 normalizeNickname），这里只做长度兜底，
        // 免得渲染端一个粘贴把一行 JSON 撑成几兆。
        const nickname = action === 'rename' && typeof raw.nickname === 'string'
          ? raw.nickname.slice(0, MAX_ACTION_TEXT)
          : null
        // 点播带动画名；名字必须是安全的动画名，否则整条事件丢掉（宿主还得再校验一遍）。
        const name = action === 'play-anim' ? normalizeAnim(raw.name) : null
        if (action === 'play-anim' && name === null) return { ok: false, error: 'bad-name' }
        // 换皮只带素材源 id（ticket 32）：注册表在宿主那边，这里只守形状。
        const skinId = action === 'use-skin' ? normalizeSkinId(raw.skinId) : null
        if (action === 'use-skin' && skinId === null) return { ok: false, error: 'bad-skin-id' }
        // 雇佣（ticket 44）：四个动作的字段与窗口提交共用同一条白名单。
        if (FARM_HIRE_ACTIONS.includes(action)) {
          const normalized = normalizeFarmAction(raw)
          if (normalized === null) return { ok: false, error: 'bad-farm-action' }
          return {
            ok: true,
            event: {
              type,
              id,
              ...normalized,
              deviceId: normalized.deviceId ?? null,
              nickname
            }
          }
        }
        // 农场（ticket 40）：`farm-open` 可带 plotId（点某块地开窗），四个地块动作必须带；
        // 种地还必须有 cropId。这里少一条，到了 store 就只剩一句 bad-plot，没有线索。
        // 交易所（ticket 41）：不碰地块，只带 cropId + qty（1–99）。
        const needsPlot = FARM_PLOT_ACTIONS.includes(action)
        const isMarketAction = FARM_MARKET_ACTIONS.includes(action)
        const plotId = needsPlot || action === 'farm-open' ? normalizePlotId(raw.plotId) : null
        if (needsPlot && plotId === null) return { ok: false, error: 'bad-plot' }
        const cropId = action === 'farm-plant' || isMarketAction ? normalizeCropId(raw.cropId) : null
        if ((action === 'farm-plant' || isMarketAction) && cropId === null) {
          return { ok: false, error: 'bad-crop' }
        }
        const qty = isMarketAction ? normalizeTradeQty(raw.qty) : null
        if (isMarketAction && qty === null) return { ok: false, error: 'bad-qty' }
        return {
          ok: true,
          event: {
            type,
            id,
            action,
            deviceId,
            nickname,
            ...(name === null ? {} : { name }),
            ...(skinId === null ? {} : { skinId }),
            ...(giftId === null ? {} : { giftId }),
            ...(gift === null ? {} : { gift }),
            ...(plotId === null ? {} : { plotId }),
            ...(cropId === null ? {} : { cropId }),
            ...(qty === null ? {} : { qty })
          }
        }
      }
      case 'pong':
        return { ok: true, event: { type, id } }
      case 'status':
        return { ok: true, event: { type, id, status: normalizeStatus(raw) } }
      default:
        return { ok: false, error: 'unknown-type' }
    }
  }

  function rectContains (rect, point) {
    if (rect === null || typeof rect !== 'object' || point === null || typeof point !== 'object') {
      return false
    }
    return point.x >= rect.x &&
      point.x < rect.x + rect.width &&
      point.y >= rect.y &&
      point.y < rect.y + rect.height
  }

  function hitTestRects (rects, point) {
    if (!Array.isArray(rects) || point === null || typeof point !== 'object') return null
    for (let i = rects.length - 1; i >= 0; i -= 1) {
      if (rectContains(rects[i], point)) return rects[i]
    }
    return null
  }

  /** 场景 items 本身就是命中区：宠物、卡片都按自己的矩形接指针。 */
  function hitTestScene (scene, point) {
    if (scene === null || typeof scene !== 'object' || !Array.isArray(scene.items)) return null
    for (let i = scene.items.length - 1; i >= 0; i -= 1) {
      const item = scene.items[i]
      if (rectContains(item, point)) return item
    }
    return null
  }

  function rectsOfScene (scene) {
    if (scene === null || typeof scene !== 'object' || !Array.isArray(scene.items)) return []
    return scene.items.map((item) => ({
      id: item.id,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height
    }))
  }

  function unionRect (rects) {
    if (!Array.isArray(rects) || rects.length === 0) return null
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const rect of rects) {
      if (rect === null || typeof rect !== 'object') continue
      if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue
      left = Math.min(left, rect.x)
      top = Math.min(top, rect.y)
      right = Math.max(right, rect.x + rect.width)
      bottom = Math.max(bottom, rect.y + rect.height)
    }
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null
    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  /**
   * 桌面表面 = 所有显示器工作区的并集（DIP，屏幕坐标）。
   *
   * 为什么是一扇铺满并集的窗，而不是每屏一扇：跨屏拖动依赖指针捕获，而指针捕获不能跨窗口
   * ——光标一离开 A 窗，pointermove/pointerup 就断了。铺满整张虚拟桌面后，拖动全程都在
   * 同一扇窗里，坐标只是窗口局部的连续值。单屏时并集就是那块屏的工作区，行为不变。
   *
   * 拿不到任何显示器（受限环境、screen 抛错）时返回 null，调用方退回主屏工作区。
   *
   * @param {Array<{workArea?:object}>} displays `screen.getAllDisplays()` 的结果
   * @returns {{x:number,y:number,width:number,height:number}|null}
   */
  function desktopArea (displays) {
    if (!Array.isArray(displays)) return null
    const areas = []
    for (const display of displays) {
      const area = display !== null && typeof display === 'object' ? normalizeRect(display.workArea) : null
      if (area !== null) areas.push(area)
    }
    return unionRect(areas)
  }

  function toLocalPoint (screenPoint, bounds) {
    const point = normalizePoint(screenPoint)
    const area = normalizeRect(bounds)
    if (point === null || area === null) return null
    return { x: point.x - area.x, y: point.y - area.y }
  }

  function toScreenPoint (localPoint, bounds) {
    const point = normalizePoint(localPoint)
    const area = normalizeRect(bounds)
    if (point === null || area === null) return null
    return { x: point.x + area.x, y: point.y + area.y }
  }

  // -------------------------------------------------------------------------
  // 宠物物理（纯函数）
  // -------------------------------------------------------------------------

  /**
   * 把任意输入整理成一个合法身体：尺寸不超过工作区，位置永远在工作区内（贴地不算穿地）。
   * 所有物理函数都从这里开始，因此「出界/NaN」不可能被传播出去。
   *
   * `floorBottom` 是宠物所在那块屏的底边（窗口局部 DIP，见 `floors`）。多屏高度不一致时，
   * 地面不能取整张并集的下边界，否则矮屏上的宠物会掉到屏幕外。省略 = 老行为（整个工作区）。
   */
  function createBody (raw, workArea, floorBottom) {
    const area = normalizeArea(workArea)
    const source = raw !== null && typeof raw === 'object' ? raw : {}
    const width = clampNumber(isFiniteNumber(source.width) ? source.width : 64, 1, area.width)
    const height = clampNumber(isFiniteNumber(source.height) ? source.height : 64, 1, area.height)
    const x = clampNumber(isFiniteNumber(source.x) ? source.x : 0, 0, area.width - width)
    const y = clampNumber(
      isFiniteNumber(source.y) ? source.y : 0,
      0,
      groundY({ height, y: isFiniteNumber(source.y) ? source.y : 0 }, area, floorBottom)
    )
    return {
      x,
      y,
      width,
      height,
      vx: isFiniteNumber(source.vx) ? clampNumber(source.vx, -PHYSICS.MAX_THROW_SPEED, PHYSICS.MAX_THROW_SPEED) : 0,
      vy: isFiniteNumber(source.vy) ? clampNumber(source.vy, -PHYSICS.MAX_THROW_SPEED, PHYSICS.MAX_THROW_SPEED) : 0
    }
  }

  /**
   * 地面：身体左上角的 y。`floorBottom` 给了就贴那块屏的底边，否则贴整个工作区的底边。
   * 宠物已经在屏下方（脚底 > 屏底）时不往上夹：它可能被拖到两块屏之间的空洞里，
   * 这一帧先自由落体到整张桌面的地面，别在半空中瞬移。
   */
  function groundY (body, workArea, floorBottom) {
    const area = normalizeArea(workArea)
    const source = body !== null && typeof body === 'object' ? body : {}
    const height = clampNumber(isFiniteNumber(source.height) ? source.height : 0, 0, area.height)
    const y = isFiniteNumber(source.y) ? source.y : null
    const feet = y === null ? null : y + height
    const bottom = isFiniteNumber(floorBottom) && (feet === null || feet <= floorBottom + 0.5)
      ? clampNumber(floorBottom, 0, area.height)
      : area.height
    const margin = Math.min(PHYSICS.FLOOR_MARGIN, Math.max(0, bottom - height))
    return Math.max(0, bottom - height - margin)
  }

  function stepBody (body, workArea, dt, floorBottom) {
    const area = normalizeArea(workArea)
    const step = clampNumber(isFiniteNumber(dt) ? dt : 0, 0, PHYSICS.MAX_DT)
    const current = createBody(body, area, floorBottom)
    if (step <= 0) return current
    let { x, y, width, height, vx, vy } = current
    const ground = groundY(current, area, floorBottom)
    vy += PHYSICS.GRAVITY * step
    x += vx * step
    y += vy * step

    if (y >= ground - 0.5) {
      y = ground
      if (vy > 0) vy = vy < PHYSICS.REST_SPEED ? 0 : -vy * PHYSICS.BOUNCE
      vx *= Math.exp(-PHYSICS.GROUND_FRICTION * step)
    } else {
      vy = Math.max(vy, -PHYSICS.MAX_THROW_SPEED)
      vx *= Math.exp(-PHYSICS.AIR_FRICTION * step)
    }

    if (y < 0) {
      y = 0
      if (vy < 0) vy = -vy * PHYSICS.WALL_BOUNCE
    }
    if (x < 0) {
      x = 0
      if (vx < 0) vx = -vx * PHYSICS.WALL_BOUNCE
    } else if (x > area.width - width) {
      x = area.width - width
      if (vx > 0) vx = -vx * PHYSICS.WALL_BOUNCE
    }
    if (Math.abs(vx) < 0.5) vx = 0
    return createBody({ x, y, width, height, vx, vy }, area, floorBottom)
  }

  function stepBodies (bodies, workArea, dt, floorBottom) {
    if (!Array.isArray(bodies)) return []
    return bodies.map((body) => stepBody(body, workArea, dt, floorBottom))
  }

  /**
   * 把身体放回某块屏的地面：脚底低于屏底就抬上去（出生/松手时用）。
   *
   * 与 `groundY` 的“不向上夹”相反——拖动可以把宠物丢进屏与屏之间的空洞，
   * 松手时应该让它出现在最近那块屏的底边上，而不是悬在看不见的地方。
   */
  function snapBodyToFloor (body, workArea, floorBottom) {
    const area = normalizeArea(workArea)
    const current = createBody(body, area)
    if (!isFiniteNumber(floorBottom)) return current
    const bottom = clampNumber(floorBottom, 0, area.height)
    const margin = Math.min(PHYSICS.FLOOR_MARGIN, Math.max(0, bottom - current.height))
    const ground = Math.max(0, bottom - current.height - margin)
    if (current.y <= ground + 0.5) return current
    return { ...current, y: ground, vy: current.vy > 0 ? 0 : current.vy }
  }

  /**
   * 拖拽：弹簧跟随目标（不是硬贴）。目标点已经被夹在工作区里，所以拖到屏幕边缘时
   * 宠物会停在边上，不会被拖出工作区。松手后的初速度由 throwVelocityFromTrail 提供。
   * 拖拽期间**不传** `floorBottom`：目标可以跨到另一块屏，松手时再按落点选地面。
   */
  function dragBody (body, target, workArea, dt, floorBottom) {
    const area = normalizeArea(workArea)
    const step = clampNumber(isFiniteNumber(dt) ? dt : 0, 0, PHYSICS.MAX_DT)
    const current = createBody(body, area)
    const point = target !== null && typeof target === 'object' ? target : current
    const targetX = clampNumber(isFiniteNumber(point.x) ? point.x : current.x, 0, area.width - current.width)
    const targetY = clampNumber(isFiniteNumber(point.y) ? point.y : current.y, 0, groundY(current, area, floorBottom))
    if (step <= 0) return current
    let { x, y, vx, vy } = current
    vx += ((targetX - x) * PHYSICS.DRAG_STIFFNESS - vx * PHYSICS.DRAG_DAMPING) * step
    vy += ((targetY - y) * PHYSICS.DRAG_STIFFNESS - vy * PHYSICS.DRAG_DAMPING) * step
    x += vx * step
    y += vy * step
    return createBody({ x, y, width: current.width, height: current.height, vx, vy }, area, floorBottom)
  }

  /**
   * 松手投掷：速度来自最近 140ms 的指针轨迹。超过最大速度就按比例缩到上限，
   * 避免一甩就飞出屏幕（虽然位置仍会被夹住，但视觉上会像瞬移）。
   */
  function throwVelocityFromTrail (trail, now, maxSpeed = PHYSICS.MAX_THROW_SPEED) {
    const limit = isFiniteNumber(maxSpeed) && maxSpeed > 0 ? maxSpeed : PHYSICS.MAX_THROW_SPEED
    if (!Array.isArray(trail) || trail.length < 2) return { vx: 0, vy: 0 }
    const at = isFiniteNumber(now) ? now : 0
    const samples = trail
      .filter((sample) => sample !== null && typeof sample === 'object' &&
        isFiniteNumber(sample.t) && isFiniteNumber(sample.x) && isFiniteNumber(sample.y) &&
        sample.t <= at + 50 && at - sample.t <= PHYSICS.THROW_TRAIL_MS * 1.5)
      .sort((left, right) => left.t - right.t)
    if (samples.length < 2) return { vx: 0, vy: 0 }
    const last = samples[samples.length - 1]
    // 光标停住超过一帧半再松手：这是一次「放下」，不是投掷。
    if (at - last.t > 100) return { vx: 0, vy: 0 }
    let first = samples[0]
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      if (last.t - samples[index].t <= PHYSICS.THROW_TRAIL_MS) {
        first = samples[index]
      } else {
        break
      }
    }
    const seconds = (last.t - first.t) / 1000
    if (!(seconds > 0.002)) return { vx: 0, vy: 0 }
    let vx = (last.x - first.x) / seconds
    let vy = (last.y - first.y) / seconds
    const speed = Math.hypot(vx, vy)
    if (!Number.isFinite(speed)) return { vx: 0, vy: 0 }
    if (speed > limit) {
      vx = (vx / speed) * limit
      vy = (vy / speed) * limit
    }
    return { vx, vy }
  }

  function throwBody (body, velocity, workArea, floorBottom) {
    const area = normalizeArea(workArea)
    const current = createBody(body, area, floorBottom)
    const source = velocity !== null && typeof velocity === 'object' ? velocity : {}
    let vx = isFiniteNumber(source.vx) ? source.vx : 0
    let vy = isFiniteNumber(source.vy) ? source.vy : 0
    const speed = Math.hypot(vx, vy)
    if (!Number.isFinite(speed)) {
      vx = 0
      vy = 0
    } else if (speed > PHYSICS.MAX_THROW_SPEED) {
      vx = (vx / speed) * PHYSICS.MAX_THROW_SPEED
      vy = (vy / speed) * PHYSICS.MAX_THROW_SPEED
    }
    return createBody({ ...current, vx, vy }, area, floorBottom)
  }

  /**
   * 工作区变了（分辨率/缩放/显示器热插拔）：把每只宠物重新夹进新工作区。
   * 只夹取，不重置速度；已经落到新地面以下的按落地处理并清掉向下速度。
   * `floorBottom` 可选：多屏时调用方按宠物所在的那块屏传，否则按整张并集。
   */
  function resizeBodies (bodies, workArea, floorBottom) {
    if (!Array.isArray(bodies)) return []
    const area = normalizeArea(workArea)
    return bodies.map((body) => {
      const source = body !== null && typeof body === 'object' ? body : {}
      const next = createBody(source, area, floorBottom)
      const ground = groundY(next, area, floorBottom)
      if (isFiniteNumber(source.y) && source.y > ground + 0.5) {
        next.y = ground
        if (next.vy > 0) next.vy = 0
      }
      return next
    })
  }

  function bodyRect (body) {
    const source = body !== null && typeof body === 'object' ? body : {}
    const x = isFiniteNumber(source.x) ? source.x : 0
    const y = isFiniteNumber(source.y) ? source.y : 0
    const width = isFiniteNumber(source.width) && source.width > 0 ? source.width : 1
    const height = isFiniteNumber(source.height) && source.height > 0 ? source.height : 1
    return { x, y, width, height }
  }

  /**
   * helper 该不该直接从 fd 0 读宿主输入，而不是用 `process.stdin`。
   *
   * **Windows + Electron 的 GUI 子系统没有控制台**：主进程里的 `process.stdin` 是个一启动
   * 就已经 EOF 的空壳（`fd` 是 `undefined`）。照旧挂监听的话，`end` 立刻到 → helper 自己
   * `shutdown(0)` → 窗口在 `loadFile` 还没完成时被销毁，只报一句 `ERR_FAILED (-2)`，
   * 看起来像"页面加载失败"。宿主确实把 pipe 挂在 fd 0 上，所以这种情况改成直接开 fd 0。
   *
   * 其它平台，以及 stdin 真有 fd 的场合，一律保持 `process.stdin`（不改变既有行为）。
   */
  function shouldReadStdinDirectly (platform, stdinFd) {
    return platform === 'win32' && typeof stdinFd !== 'number'
  }

  /**
   * 点击穿透的唯一裁定（主进程直接照做）。
   *
   * 优先级：
   *   0. busy 租约新鲜且没有超过连续持有上限：拖拽/弹层期间，位置判定不参与；
   *   1. 光标在命中矩形内 + 渲染端最近 maxAgeMs 内确认过 inside（正常路径）；
   *   2. 光标在命中矩形内 + 渲染端完全没消息但停留满 fallbackDwellMs（macOS 兜底）；
   *   3. 其余一律穿透。
   *
   * `rects` 优先于 `scene`：主进程传入渲染端上报的实时矩形（宠物 + 控件），测试/旧调用方可以继续传 scene。
   * 矩形为空永远是 false，busy 过期或超过 busyMaxMs 也永远不再翻案。
   *
   * @returns {{interactive:boolean, reason:'busy-lease'|'no-scene'|'outside'|'waiting-for-confirmation'|'stale-renderer-confirmation'|'hovering'|'main-fallback'}}
   */

  function shouldBeInteractive (options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now()
    const busyAt = Number.isFinite(options.busyAt) ? options.busyAt : 0
    const lease = Number.isFinite(options.busyLeaseMs) && options.busyLeaseMs > 0
      ? options.busyLeaseMs
      : BUSY_LEASE_MS
    const busySince = Number.isFinite(options.busySince) && options.busySince > 0
      ? options.busySince
      : busyAt
    const busyMax = Number.isFinite(options.busyMaxMs) && options.busyMaxMs > 0
      ? options.busyMaxMs
      : BUSY_MAX_MS
    const leaseFresh = busyAt > 0 && now - busyAt <= lease && now - busyAt >= 0
    const underCap = busySince <= 0 || now - busySince <= busyMax

    let rects
    if (Array.isArray(options.rects)) {
      rects = options.rects
    } else if (options.scene !== null && typeof options.scene === 'object' && Array.isArray(options.scene.items)) {
      rects = rectsOfScene(options.scene)
    } else {
      rects = []
    }
    if (rects.length === 0) return { interactive: false, reason: 'no-scene' }

    const point = normalizePoint(options.point)
    const hit = point !== null && hitTestRects(rects, point) !== null
    // 输入租约可以让“位置判定”让位给拖拽，但不能单独把整窗变成可交互：
    // 光标必须确实压在某个**活的**命中矩形上（拖拽时渲染端会上报一条跟随光标的
    // `ui:drag` 矩形）。没有活矩形 = 一律 fail closed 回穿透。
    if (options.busy === true && leaseFresh && underCap && hit) {
      return { interactive: true, reason: 'busy-lease' }
    }
    if (!hit) {
      return { interactive: false, reason: 'outside' }
    }
    const lastHoverAt = Number.isFinite(options.lastHoverAt) ? options.lastHoverAt : 0
    const maxAge = Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
      ? options.maxAgeMs
      : HOVER_CONFIRM_MAX_AGE_MS
    if (lastHoverAt > 0 && now - lastHoverAt <= maxAge) {
      return { interactive: true, reason: 'hovering' }
    }
    const insideSince = Number.isFinite(options.insideSince) ? options.insideSince : 0
    const dwell = Number.isFinite(options.fallbackDwellMs) && options.fallbackDwellMs >= 0
      ? options.fallbackDwellMs
      : MAIN_FALLBACK_DWELL_MS
    if (options.allowMainFallback !== false && insideSince > 0 && now - insideSince >= dwell) {
      return { interactive: true, reason: 'main-fallback' }
    }
    return {
      interactive: false,
      reason: lastHoverAt > 0 ? 'stale-renderer-confirmation' : 'waiting-for-confirmation'
    }
  }

  return {
    MAX_LINE_LENGTH,
    MAX_SCENE_ITEMS,
    MAX_HIT_RECT_SIZE,
    MAX_HIT_RECTS,
    MAX_ID_LENGTH,
    MAX_LABEL_LENGTH,
    MAX_ANIM_LENGTH,
    MAX_PATH_LENGTH,
    MAX_ERROR_LENGTH,
    MAX_NOTICE_LENGTH,
    MAX_REASON_LENGTH,
    MAX_DISPLAYS,
    HOVER_HEARTBEAT_MS,
    HOVER_CONFIRM_MAX_AGE_MS,
    POINTER_POLL_MS,
    MAIN_FALLBACK_DWELL_MS,
    RENDERER_RECT_MAX_AGE_MS,
    SCENE_RECT_FALLBACK_MS,
    BUSY_HEARTBEAT_MS,
    BUSY_LEASE_MS,
    BUSY_MAX_MS,
    DEFAULT_COLOR,
    ITEM_KINDS,
    PET_ROLES,
    PET_BADGES,
    SCENE_VERSION,
    CONTROL_ACTIONS,
    GIFT_ACTIONS,
    FARM_ACTIONS,
    FARM_PLOT_ACTIONS,
    FARM_MARKET_ACTIONS,
    FARM_VISIT_ACTIONS,
    FARM_HIRE_ACTIONS,
    HIRE_WAGE_MIN,
    HIRE_WAGE_MAX,
    HIRE_HOURS_MIN,
    HIRE_HOURS_MAX,
    HIRE_FEE_RATE,
    MAX_CONTRACT_EARNED,
    CONTRACT_STATUSES,
    HIRE_REASONS,
    GIFT_STATUSES,
    MENU_ACTION_IDS,
    DESKTOP_ACTIONS,
    MENU_TOOL_IDS,
    MAX_FARM_PLOTS,
    CROP_IDS,
    CROP_BASE_PRICE,
    MAX_FARM_COINS,
    MAX_FARM_STACK,
    MAX_FARM_DEW,
    MAX_FARM_CONTRACTS,
    MAX_FARM_GUARD,
    MAX_FARM_LOG,
    MAX_FARM_MARKET_HISTORY,
    MARKET_MIN_QTY,
    MARKET_MAX_QTY,
    normalizeFarm,
    normalizeFarmWindow,
    normalizeFarmAction,
    normalizeFarmHire,
    normalizeContracts,
    normalizeBadge,
    normalizeMarket,
    normalizeTradeQty,
    normalizePlotId,
    normalizeCropId,
    MAX_ACTION_TEXT,
    MAX_NAME_LENGTH,
    MAX_GIFT_TEXT_LENGTH,
    MAX_GIFT_ITEMS,
    MAX_BACKPACK_ITEMS,
    MAX_GIFT_FILE_BYTES,
    MAX_GIFT_NAME_LENGTH,
    PET_COLORS,
    IDLE_CLIPS,
    PHYSICS,
    isFiniteNumber,
    clampNumber,
    normalizeId,
    normalizeGiftId,
    normalizeSkinId,
    normalizeAssetRoots,
    normalizeGiftName,
    normalizeGiftSize,
    normalizeGiftThumb,
    normalizeLabel,
    normalizeNoteText,
    normalizeBackpackText,
    normalizeBringGift,
    normalizeBringWindowItem,
    normalizeBringWindow,
    normalizeAnim,
    normalizeRole,
    normalizeSemantic,
    normalizeAssetUrl,
    normalizeHttpUrl,
    normalizeIdlePool,
    pickIdleClip,
    semanticBadge,
    normalizeRect,
    normalizePoint,
    normalizeRects,
    normalizeMediaReport,
    normalizeInputReport,
    clipRectToArea,
    desktopArea,
    normalizeFloors,
    normalizeBands,
    walkBands,
    bandAt,
    normalizeScene,
    normalizeControls,
    normalizeMenu,
    placeMenu,
    normalizeHostCommand,
    normalizeHelperEvent,
    emptyScene,
    emptyControls,
    emptyMenu,
    encodeMessage,
    parseLine,
    createLineParser,
    rectContains,
    hitTestRects,
    hitTestScene,
    rectsOfScene,
    unionRect,
    toLocalPoint,
    toScreenPoint,
    shouldReadStdinDirectly,
    shouldBeInteractive,
    hashString,
    colorForPet,
    initialVelocity,
    petScene,
    demoPetScene,
    createBody,
    groundY,
    snapBodyToFloor,
    stepBody,
    stepBodies,
    stepOnBand,
    confineBodyToBand,
    dragBody,
    throwVelocityFromTrail,
    throwBody,
    resizeBodies,
    bodyRect
  }
})
