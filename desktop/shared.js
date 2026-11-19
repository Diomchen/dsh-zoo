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
  const MAX_MENU_TOOLS = 9
  const MAX_MENU_GROUPS = 24
  const MAX_MENU_ACTIONS = 256
  // 票 79：`trading` = 右键「盘口」；票 112：`expedition` = 右键「出远门」。
  const MENU_TOOL_IDS = ['open-site', 'bring', 'farm', 'trading', 'futures', 'expedition', 'home', 'reload', 'scan-skins']
  /**
   * 右键工具项 → 宿主动作申请（评审 P2）：渲染端以前用一条 `id === 'reload' || …` 的
   * 手写链，多一个工具就要改两处。现在只有这一张表，`runMenuTool` 直接查它。
   * `home` 不在这里：它只在本机把宠物挪回出生点，不发任何申请。
   * 键集合 = `MENU_TOOL_IDS` 去掉 home，`test/desktop-menu.test.js` 盯着。
   */
  const MENU_TOOL_REQUESTS = Object.freeze({
    'open-site': 'open-site',
    bring: 'bring',
    farm: 'farm-open',
    trading: 'trading-open',
    futures: 'futures-window',
    expedition: 'expedition-open',
    reload: 'reload',
    'scan-skins': 'scan-skins'
  })

  /** 渲染端「我还在命中区里」的心跳间隔；主进程允许的最大陈旧时间。 */
  const HOVER_HEARTBEAT_MS = 350
  const HOVER_CONFIRM_MAX_AGE_MS = 1200
  /**
   * 渲染端上报的本地指针（CSS 坐标）的保鲜期：心跳 350ms 一拍，留四拍余量。
   * 混合 DPI 下主进程按这份坐标裁定命中（票 93），过期就退回 OS 光标。
   */
  const HOVER_POINT_MAX_AGE_MS = 1500
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
const OVERLAY_RECT_MAX_AGE_MS = 3000
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

  /**
   * 「我们声称可交互」需要周期性重新落到 native 层（票 76）。
   *
   * 现场：Windows 上 `setIgnoreMouseEvents(false)` 偶发不生效，而 `setIgnore()` 看到状态
   * 没变就直接 return —— 主进程认为窗口可交互、OS 却仍然把左键给下层，一直卡到一次真正的
   * `true → false` 翻转或 helper 重启（票 30 现场靠「重载配置」恢复的就是这条）。主进程每隔
   * 这么久把**同一个值**重放一次：语义不变，只是让 native 层重新落一遍。
   */
  const INTERACTIVE_REASSERT_MS = 2000
  /**
   * 丢 down 自愈的冷却（票 76）。
   *
   * 渲染端一发现「只有 up、没有 down」就报一次（那说明左键在窗口/系统层被吞了）；主进程据此
   * 重放一次穿透→可交互。冷却避免合成输入、边界按下把重放抖成循环。
   */
  const LOST_DOWN_HEAL_COOLDOWN_MS = 1000

  const DEFAULT_COLOR = '#3b74d8'
  const ITEM_KINDS = ['pet', 'card']
  // ticket 44：worker 是「别人家的宠物在我家打工」，与 guest/visitor 都不是一回事。
  const PET_ROLES = ['self', 'guest', 'visitor', 'worker']
  /** 宠物角标的固定枚举（跨进程传输，不能用自由文本）。 */
  const PET_BADGES = ['work', 'steal']
  /**
   * 宠物「不在家」的三种状态（ticket 57）。与 `src/away-text.js` 的 AWAY_MODES 同源
   * （渲染端不能 import Node 模块，只能抄一份；`test/away-desktop.test.js` 有相等性断言）。
   */
  const AWAY_MODES = ['visiting', 'raiding', 'working']
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
    // 票 77：生长中/冻住的作物可以提前铲除，清出地块重种。
    'farm-clear',
    // 票 75：冻住的地要花露水+硬币生火解冻。
    'farm-thaw',
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
   * 窗口自己的两条「重画」动作，语义必须分开：
   *   - `farm-refresh`（ticket 47.1）：倒计时到 0 时请宿主确认成熟。窗口不自己标 mature
   *     （本地时钟可能比宿主早/晚几毫秒，标早了收获会被宿主回 not-mature）。它**保持当前模式**：
   *     看田期间宿主会重新拉一份邻居的公开视图，绝不把窗口打回主人视图。
   *   - `farm-own`：点「我的农场」那颗圆片，显式离开只读视图。这是切回自己农场的唯一出口。
   *     以前它挤在 `farm-refresh` 里，于是「到点确认」和「切回我家」共用一条申请——
   *     邻居的作物一熟（或自家作物一熟），看田窗口就被踢回自己农场。
   */
  const FARM_REFRESH_ACTIONS = ['farm-refresh', 'farm-own']
  /**
   * 票 79：农场窗头部的「盘口」按钮。它只是**开窗申请**（和右键「盘口」同一个宿主入口），
   * 所以挂进 FARM_ACTIONS 走同一条 `farm-submit` → action-result 回路，不带任何字段。
   */
  const BOARD_OPEN_ACTIONS = ['trading-open']
  /**
   * 盘口小窗能提交的动作（票 79 / 票 81 / 票 83）。字段窄到不能再窄：
   *   trading-open-position  { side, margin, leverage, cropId }
   *   trading-close-position { positionId }
   *   trading-set-stop       { positionId, level }（票 81：持仓卡上的止损循环）
   *   trading-place-order    { side, margin, leverage, cropId, target }（票 83：到价挂单）
   *   trading-cancel-order   { orderId }（票 83：撤单）
   *   trading-refresh        无字段（倒计时到 0 时请宿主结这一根并重推一拍）
   *   trading-charts         { cropId }（票 90：切到没缓存的作物时按需拉这一种的四个周期）
   * 价格、硬币、盈亏、成交价全由宿主算，窗口一概不传。
   */
  const BOARD_SUBMIT_ACTIONS = [
    'trading-open-position',
    'trading-close-position',
    'trading-set-stop',
    'trading-place-order',
    'trading-cancel-order',
    'trading-refresh',
    'trading-charts'
  ]
  const BOARD_SIDES = ['long', 'short']
  const BOARD_REASONS = ['close', 'settle', 'liquidate', 'stop']
  /**
   * 盘口杠杆的形状上限（票 81 / 评审 P2）：与 `src/trading-rules.js` 的 `MAX_LEVERAGE` 同值。
   * 这一层只守形状（读盘/白名单），1×/5×/20×/50×/100× 的产品白名单由宿主按 `TRADING_LEVERAGES` 校验；
   * `test/farm-constants-drift.test.js` 有 drift 断言盯着两个数相等。
   */
  const BOARD_MAX_LEVERAGE = 100
  /**
   * 止损档位（票 81）：0 = 关，其余是「亏掉保证金的这个比例就平仓」。
   * 窗口的按钮循环「关 → −25% → −50% → −100% → 关」，宿主的 store（票 80）
   * 按同一组数校验；两边各留一份，靠 `test/board-window.test.js` 的 drift 断言对齐。
   */
  const BOARD_STOP_LEVELS = [0, 0.25, 0.5, 1]
  /**
   * 一包最多画多少手/多少笔/多少根：窗口只滚一屏，不用把整份历史搬过去。
   * 持仓/挂单放到 200（评审 P1）：宿主按最新在前下发，200 条足够覆盖正常玩家的全部
   * 未平仓位；真超了由 `positionsTotal`/`ordersTotal` 告诉窗口「显示最近 200」。
   */
  const BOARD_MAX_PRICE = 1000000000
  const BOARD_MAX_POSITIONS = 200
  const BOARD_MAX_ORDERS = 200
  const BOARD_MAX_HISTORY = 50
  /**
   * 盘口白名单的长度上限（票 88 / ADR-0031）：作物清单跟随宿主运行时目录，
   * 可能远多于内置十种（目录上限 64）。8 会正好削掉第 9/10 种作物；
   * 32 与 `src/crop-catalog.js` 的目录量级同阶，够用又不至于让坏包无限大。
   * `limits` 里还有保证金/杠杆两列（各 3 档），同一把尺子一起放宽不会损失校验。
   */
  const BOARD_MAX_LIMITS = 32
  const BOARD_MAX_CHARTS = 32
  /** 宿主给 24 根 + 当前一根；留一点余量，换根数时不必两边同改。 */
  const BOARD_MAX_BARS = 40
  const BOARD_MAX_TICK = 15
  /** 票 105：一根 K 线最多带几条 lite 消息；窗口顶层最多多少条全文/日程。 */
  const BOARD_MAX_NEWS_PER_BAR = 2
  const BOARD_MAX_NEWS_ITEMS = 20
  const BOARD_MAX_NEWS_CALENDAR = 8
  const BOARD_MAX_NEWS_TITLE = 60
  const BOARD_MAX_NEWS_BODY = 160
  const BOARD_MAX_NEWS_SOURCE = 40
  const BOARD_MAX_NEWS_COUNT = 80
  /**
   * 盘口 K 线周期（票 84）：与 `src/trading-rules.js` 的 `BOARD_TIMEFRAMES` 同源，
   * `test/farm-constants-drift.test.js` 有 drift 断言盯着两边。
   * 这一层只放行白名单里的四个 id（多一个都不认），所以「最多 4 个周期」是它的天然上限。
   */
  const BOARD_TIMEFRAME_IDS = ['15m', '1h', '1d', '1w']
  /**
   * 票 82：真人周榜。一屏最多 32 行、每行最多 8 条持仓（与报文上限一致），
   * 情绪计数最多是「行 × 持仓」——这三个数只做形状夹取，不是产品规则。
   * 分数/收益率的范围与宿主 `src/protocol.js` 的 MAX_WEEK_PNL / MAX_WEEK_PNL_PCT 同源。
   */
  const BOARD_MAX_LEAGUE_ROWS = 32
  const BOARD_MAX_LEAGUE_POSITIONS = 8
  const BOARD_MAX_LEAGUE_COUNT = BOARD_MAX_LEAGUE_ROWS * BOARD_MAX_LEAGUE_POSITIONS
  /** 旧版本邻居的可见计数：与 `src/protocol.js` 的 MAX_NEIGHBORS（64）同量级，只做形状夹取。 */
  const BOARD_MAX_WATCHERS = 64
  const BOARD_MAX_WEEK_PNL = 1000000
  const BOARD_MAX_WEEK_PNL_PCT = 1000
  /**
   * 地块解锁（ticket 48）：只带可选的 `expectedUnlocked`（窗口看到的已解锁数）。
   * 价格与下一块地在哪全由宿主算；窗口不传钱、不传地块 id。
   */
  const FARM_LAND_ACTIONS = ['farm-unlock']
  /**
   * 票 52/53：在家看田、派它去偷。两条都带 `deviceId`（看谁/去谁家），
   * `farm-raid` 还可以带 `plots`（最多 50 个 pN）；不带就让主人那边挑。
   */
  const FARM_LOOK_ACTIONS = ['farm-look', 'farm-raid']
  /**
   * 票 70/71：今日节日领奖与秋天来客结算。两条都带 `expectedStart`（窗口看到的
   * 当日 0 点），宿主拿它挡「过了午夜还在点昨天的按钮」；来客再加一个二选一。
   */
  const FARM_EVENT_ACTIONS = ['farm-event-claim']
  const FARM_OMEN_ACTIONS = ['farm-omen-resolve']
  /**
   * **必须带对象**的动作：没有 `deviceId` 这条申请就没有意义，宁可整条拒掉。
   *
   * 只写一份、两边都用（`desktop/main.js` 的 IPC 窄口 + 这里的 helper 事件窄口）。
   * 票 54 加 `farm-look` / `farm-raid` 时只改了 main.js 那一份，宿主这一份照旧只认
   * 四个旧动作，于是 `deviceId` 在 helper → 宿主这一跳被削成 null：宿主回
   * `bad-device-id`，桌面上就是「这位邻居已经不在桌面上了」——每一位邻居都这样。
   * `visit` 不在这里：它是「可以带对象」，不带就由宿主随机挑一位。
   */
  const DEVICE_ACTIONS = ['end-visit', 'admit', 'reject', 'dismiss', ...FARM_LOOK_ACTIONS]
  // 只拼**动作名**数组：这里以前误把 `normalizeFarmLook` / `normalizeNeighborChips`
  // 两个函数也 concat 进来，还重复拼了一次 FARM_LOOK_ACTIONS。`.includes()` 看不出来，
  // 但白名单里混进函数是定时炸弹（序列化/遍历时就爆）。
  const FARM_ACTIONS = FARM_PLOT_ACTIONS.concat(
    FARM_MARKET_ACTIONS,
    FARM_HIRE_ACTIONS,
    FARM_REFRESH_ACTIONS,
    FARM_LAND_ACTIONS,
    FARM_LOOK_ACTIONS,
    FARM_EVENT_ACTIONS,
    FARM_OMEN_ACTIONS,
    // 票 79：农场窗头部的「盘口」按钮（无字段，只是开窗申请）。
    BOARD_OPEN_ACTIONS
  )
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
    // ticket 79：红包卡上只有一个动作——拆开。内容和记账全在宿主，渲染端只发 giftId。
    'gift-claim',
    // ticket 24：右键「带派」只发一个空动作，由宿主开小窗；unbring 才带 giftId。
    'bring',
    'unbring',
    // ticket 40/41：农场七条动作。地块只带 plotId（种地再带 cropId），交易所只带 cropId + qty。
    ...FARM_ACTIONS
  ]
  /** 这几个动作必须带 giftId；其余动作带了也会被丢掉。`bring` 例外：它带的是待放物品。 */
  const GIFT_ACTIONS = ['gift-open', 'gift-reveal', 'gift-copy', 'gift-discard', 'gift-claim', 'unbring']
  /** 菜单项的动作（ticket 22 / 24 / 32 / 40）：点播 / 重载 / 打开软件 / 带派 / 换皮 / 农场。同样只是一次「申请」。 */
  const MENU_ACTION_IDS = [
    'play-anim', 'reload', 'open-site', 'bring', 'use-skin', 'scan-skins', 'farm-open',
    // 票 52/53：右键邻居看田、从看田窗派它去偷（都只带 deviceId）。
    'farm-look', 'farm-raid',
    // 票 79：右键「盘口」只发一个空动作，开/关与整份视图都在宿主。
    ...BOARD_OPEN_ACTIONS,
    // 票 93：右键「期货」同理——空动作，宿主开窗并推整份视图。
    'futures-window',
    // 票 112：右键「出远门」——开/关由宿主按真实窗口状态决定。
    'expedition-open'
  ]
  /** 几张皮的 id 上限与宿主一致：短标识符，不是路径。 */
  const MAX_SKIN_CHOICES = 16
  const SKIN_ID_RE = /^[A-Za-z0-9_-]{1,32}$/
  /** helper → 宿主能报的全部动作：控件 + 菜单 + 盘口小窗的提交（三条不同的 IPC 入口）。 */
  /**
   * 期货小窗的提交白名单（票 93）：和盘口同一套纪律——窗口只报意图，
   * 价格、张数、成交价、余额全由宿主算。`futures-refresh` 是倒计时归零时
   * 请宿主结这一根并重推一拍，不带字段。
   */
  const FUTURES_SUBMIT_ACTIONS = [
    'futures-deposit',
    'futures-withdraw',
    'futures-open',
    'futures-close',
    'futures-place',
    'futures-cancel',
    'futures-convert',
    'futures-convert-all',
    'futures-mode',
    'futures-account-mode',
    // 1.12.0：暂停 / 继续只作用于自己这本账。
    'futures-pause',
    'futures-rollback',
    'futures-refresh'
  ]
  /**
   * 期货杠杆白名单（票 93）：1×/3×/10×/20×，与 `src/futures-rules.js` 的
   * `FUTURES_LEVERAGES` 同值；`test/futures-window.test.js` 有 drift 断言。
   */
  const FUTURES_LEVERAGES = [1, 3, 10, 20]
  /** 保证金形状上限：与宿主的 `MAX_MARGIN` 同值（整数币，1..1,000,000）。 */
  const FUTURES_MAX_MARGIN = 1000000
  /** `/state` 与窗口最多画多少手/多少笔：与账本的视图上限同值。 */
  const FUTURES_MAX_POSITIONS = 20
  const FUTURES_MAX_TRADES = 20
  /** 「我的挂单」最多 8 条：一屏画得下，也压住整包体积。 */
  const FUTURES_MAX_ORDERS = 8
  /** 交易阶段只认这三个值（票 96）：别的新词一律当没下发。 */
  const FUTURES_SESSION_KINDS = ['trading', 'expired', 'weekend']
  /** 成交类型白名单（票 96/98）：开/平/交割/转现货/强平/切档。 */
  const FUTURES_TRADE_KINDS = ['open', 'close', 'delivery', 'convert', 'liquidation', 'mode']
  /** 市场闸门（票 98）：关 / 影子 / 真钱。1.10.0 起 shadow 只是历史值，实际按账户档位走。 */
  const FUTURES_MODES = ['off', 'shadow', 'live']
  /** 1.10.0：账户自己的档位——纸面还是真钱，每个账户自己选。 */
  const FUTURES_ACCOUNT_MODES = ['shadow', 'live']
  /**
   * 出远门小窗的提交白名单（票 112）：窗口只报意图——`start` 带路线，`step`/`back`
   * 什么都不带，`refresh` 只请宿主补一拍。钱与段数全在宿主算。
   */
  const EXPEDITION_SUBMIT_ACTIONS = [
    'expedition-start',
    'expedition-step',
    'expedition-back',
    'expedition-refresh',
    'expedition-shelf'
  ]
  /** 出远门的三个阶段 + 两种结局；窗口只画这几个词。 */
  const EXPEDITION_PHASES = ['walking', 'deciding']
  const EXPEDITION_ENDED = ['back', 'complete', 'failed']
  /** 陈列架（票 115）：窗口按 32 格画，开格价与宿主同一个数。 */
  const EXPEDITION_SHELF_MAX = 32
  const EXPEDITION_SHELF_PRICE = 5000

  const DESKTOP_ACTIONS = CONTROL_ACTIONS.concat(
    MENU_ACTION_IDS,
    BOARD_SUBMIT_ACTIONS,
    FUTURES_SUBMIT_ACTIONS,
    EXPEDITION_SUBMIT_ACTIONS
  )
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
  /** 红包上限（票 79），与 `src/protocol.js` 的 `PACKET_LIMITS` 同一套数。 */
  const MAX_PACKET_COINS = 200
  const MAX_PACKET_STACK = 20
  const MAX_PACKET_KINDS = 5
  const MAX_PACKET_NOTE = 60
  /** 一次场景最多几件礼物（≤ 访客数）；上限只为让一条消息有界，不表达产品限额。 */
  const MAX_GIFT_ITEMS = 64
  /** 礼物的状态词表，与 `src/gift-text.js` 的 `GIFT_STATUSES` 同源；认不出的整张卡丢弃。 */
  const GIFT_STATUSES = ['pending', 'receiving', 'received', 'failed', 'refused']

  /**
   * 农场（ticket 40）。下面的数字与 `src/farm-rules.js` / `src/farm.js` 同源，但这一层是
   * **普通 script**（渲染页 `<script>` 加载、主进程 require），不能 import 宿主的 ESM；
   * 所以按 `desktop/shared.js` 的老规矩再守一次边界，改的时候两边一起改：
   *   - 宿主开局 4 块地（p1–p4），最多解锁到 50 块（ticket 48）；窗口/helper
   *     边界不写死 4：卡片和标题完全跟 `farm.plots` 走；
   *   - 六种作物，与 SPEC v5 的作物表一致（票 58 由三种扩到六种）；
   *   - 硬币/种子/作物/露水/合同/日志的硬上限与 SPEC v5「货币、仓库与限额」一致。
   */
  const MAX_FARM_PLOTS = 50
  /** 起始地块数：与宿主 `START_PLOTS` 同源；窗口不接受 1–3 这种宿主永远发不出的状态。 */
  const MIN_FARM_PLOTS = 4
  /**
   * 票 59：窗口认哪些作物、底价多少，都由宿主随 `farm-window` 下发的 `crops` 决定。
   * 这两份是可变的默认值：内置六种打底，`applyCropCatalog()` 原地换内容，
   * 所有 `for (const id of CROP_IDS)` 在调用时读到的是最新那份。
   */
  const CROP_IDS = ['pea', 'tomato', 'strawberry', 'radish', 'carrot', 'rice', 'corn', 'watermelon', 'pumpkin', 'grape']
  const FARM_STAGES = ['empty', 'growing', 'mature', 'withered', 'frozen']
  // 票 79 补：`packet` 是红包记录（收到/拆开/送出/退回）——漏在这张白名单里，
  // 宿主写进 farm.log 的红包条目会在下发桌面时被整条丢掉，记录页就永远看不见。
  const FARM_LOG_KINDS = ['plant', 'harvest', 'clear', 'steal', 'help', 'hire', 'settle', 'unlock', 'season', 'event', 'wither', 'freeze', 'thaw', 'omen', 'packet']
  const MAX_FARM_COINS = 1000000
  const MAX_FARM_STACK = 999
  const MAX_FARM_DEW = 48
  const MAX_FARM_CONTRACTS = 20
  const MAX_FARM_LOG = 200
  /** 红包记录那一份的上限，与 `src/farm.js` 的 `MAX_PACKET_LOG` 同值。 */
  const MAX_FARM_PACKETS = 50
  /**
   * 交易所（ticket 41）的窄口：底价表与 `src/farm-rules.js` 同源；
   * 价格夹在 [base×0.5, base×2]，成交历史最多 50 条进窗口。
   */
  const CROP_BASE_PRICE = { pea: 6, tomato: 5, strawberry: 7, radish: 8, carrot: 6, rice: 10, corn: 9, watermelon: 24, pumpkin: 30, grape: 24 }
  /** 目录上限：与 `src/crop-catalog.js` 的 MAX_CROPS 同源（drift 测试会读）。 */
  const MAX_FARM_CROPS = 64
  const MAX_CROP_NAME = 16
  const MAX_FARM_GROW_MS = 30 * 24 * 60 * 60 * 1000

  /**
   * 用宿主下发的目录换掉上面两份（票 59）。
   * 只认 `{ id, name, base }` 这一层——窗口不需要产量/生长时长以外的字段，
   * 但底价必须跟着走，否则新作物在交易所行里会被 `normalizeMarketPrice` 判成坏的。
   */
  /**
   * 作物图只认两种 URL：包里的相对路径，或 helper 的 `dshzoo://crops/<16 位哈希>.<svg|png>`。
   * 宿主已经校验过，窗口这边再挡一次——IPC 上的东西一律当不可信输入。
   */
  function normalizeCropArt (value) {
    if (typeof value !== 'string') return null
    if (/^crops\/[a-z0-9_-]{2,24}\.(?:svg|png)$/.test(value)) return value
    if (/^dshzoo:\/\/crops\/[0-9a-f]{16}\.(?:svg|png)$/.test(value)) return value
    return null
  }

  function applyCropCatalog (list) {
    if (!Array.isArray(list) || list.length === 0) return null
    const entries = []
    const ids = []
    const bases = {}
    for (const raw of list.slice(0, MAX_FARM_CROPS)) {
      if (raw === null || typeof raw !== 'object') continue
      const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : ''
      const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_CROP_NAME) : ''
      if (id === '' || name === '') continue
      const base = Number(raw.base)
      if (!Number.isFinite(base) || base <= 0) continue
      const entry = {
        id,
        name,
        base: Math.min(MAX_FARM_COINS, Math.max(1, Math.floor(base))),
        ...(normalizeCropArt(raw.art) === null ? {} : { art: normalizeCropArt(raw.art) }),
        seedPrice: Math.min(MAX_FARM_COINS, Math.max(0, Math.floor(Number(raw.seedPrice) || 0))),
        growMs: Math.min(MAX_FARM_GROW_MS, Math.max(0, Math.floor(Number(raw.growMs) || 0))),
        yield: Math.min(999, Math.max(0, Math.floor(Number(raw.yield) || 0)))
      }
      entries.push(entry)
      ids.push(id)
      bases[id] = entry.base
    }
    if (ids.length === 0) return null
    CROP_IDS.length = 0
    CROP_IDS.push(...ids)
    for (const id of Object.keys(CROP_BASE_PRICE)) delete CROP_BASE_PRICE[id]
    Object.assign(CROP_BASE_PRICE, bases)
    return entries
  }
  const MAX_FARM_MARKET_HISTORY = 50
  const MARKET_SIDES = ['buy', 'sell']
  const MARKET_MIN_QTY = 1
  const MARKET_MAX_QTY = 99
  const MARKET_FLOOR_RATIO = 0.5
  const MARKET_CEIL_RATIO = 2
  /** 局域网指数权重（ticket 42 / 股市感）：与宿主 src/market.js 同一组档位。 */
  const MARKET_INDEX_WEIGHT_TIERS = [0, 0.45, 0.65, 0.75]
  const MARKET_INDEX_WEIGHT_MAX = 0.85
  const MARKET_CROP_BETA = Object.freeze({
    pea: 0.8,
    tomato: 0.8,
    strawberry: 0.8,
    radish: 0.9,
    carrot: 1,
    rice: 1,
    corn: 1.1,
    pumpkin: 1.3,
    watermelon: 1.4,
    grape: 1.4
  })
  /** 指数涨跌幅上限 ±12%，和宿主同源。 */
  const MARKET_MOMENTUM_MAX = 0.12
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
  /** 地块 id 的形状：宿主开局 p1–p4、最多 p1–p50；窗口按 pN 通用。 */
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
  /**
   * 红包内容（票 79）：`{coins, crops, seeds}`。
   *
   * 这一层只守形状和上限，**不查农场余额**——有没有那么多硬币/作物是宿主的事，
   * 这里多判一次只会让两边规则各漂一套。
   */
  function normalizePacketContents (value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const coins = Number.isInteger(value.coins) && value.coins >= 0 ? Math.min(value.coins, MAX_PACKET_COINS) : 0
    const stacks = (raw, max) => {
      const out = {}
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
      let kinds = 0
      for (const [id, qty] of Object.entries(raw)) {
        if (kinds >= max) break
        if (!/^[a-z][a-z0-9_-]{1,23}$/.test(id)) continue
        if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_PACKET_STACK) continue
        out[id] = qty
        kinds += 1
      }
      return out
    }
    const crops = stacks(value.crops, MAX_PACKET_KINDS)
    const seeds = stacks(value.seeds, MAX_PACKET_KINDS)
    if (coins === 0 && Object.keys(crops).length === 0 && Object.keys(seeds).length === 0) return null
    return { coins, crops, seeds }
  }

  /** 红包的祝福语：和字条共用清洗，但上限只有 60 个字。 */
  function normalizePacketNote (value) {
    if (value === undefined || value === null) return ''
    // 祝福语是选填的：字条那边空文本算非法，红包这边空白要当「没写」。
    // 否则用户不写祝福语时 normalizeNoteText 返回 null，整只红包被判成坏礼物。
    if (typeof value === 'string' && value.trim() === '') return ''
    const text = normalizeNoteText(value, MAX_PACKET_NOTE)
    return text === null ? null : text
  }

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
    if (value.kind === 'packet') {
      const packet = normalizePacketContents(value.packet)
      if (packet === null) return null
      const note = normalizePacketNote(value.note)
      if (note === null) return null
      return { kind: 'packet', packet, ...(note === '' ? {} : { note }) }
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
    if (raw.kind === 'packet') {
      const packet = normalizePacketContents(raw.packet)
      if (packet === null) return null
      const note = normalizePacketNote(raw.note)
      if (note === null) return null
      // 显示文案由宿主算好（含作物名），这里只做长度兜底；缺了就按形状拼一句。
      const text = normalizeText(raw.text, '红包', MAX_LABEL_LENGTH * 3)
      return { id, kind: 'packet', packet, text, ...(note === '' ? {} : { note }), state }
    }
    return null
  }

  /**
   * 红包编辑页的底数（票 79）：上限、今天还能寄几只、仓库/种子袋里现有的作物。
   * 上限一律用 shared 自己的常量——宿主发什么都不放大可寄数量。
   */
  function normalizePacketSetup (raw) {
    const rows = (list) => {
      const out = []
      if (!Array.isArray(list)) return out
      for (const row of list) {
        if (out.length >= CROP_IDS.length) break
        if (row === null || typeof row !== 'object') continue
        if (!/^[a-z][a-z0-9_-]{1,23}$/.test(String(row.id ?? ''))) continue
        const have = Number(row.have)
        if (!Number.isInteger(have) || have <= 0) continue
        out.push({
          id: row.id,
          name: normalizeText(row.name, row.id, MAX_LABEL_LENGTH),
          have: Math.min(have, MAX_FARM_STACK)
        })
      }
      return out
    }
    const coins = Number(raw.coins)
    const left = Number(raw.left)
    return {
      limits: {
        maxCoins: MAX_PACKET_COINS,
        maxPerCrop: MAX_PACKET_STACK,
        maxKinds: MAX_PACKET_KINDS,
        maxNoteChars: MAX_PACKET_NOTE
      },
      left: Number.isInteger(left) ? clampNumber(left, 0, 3) : 0,
      coins: Number.isInteger(coins) ? clampNumber(coins, 0, MAX_FARM_COINS) : 0,
      crops: rows(raw.crops),
      seeds: rows(raw.seeds)
    }
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
    const packet = raw.packet !== null && typeof raw.packet === 'object' && !Array.isArray(raw.packet)
      ? normalizePacketSetup(raw.packet)
      : null
    return {
      open: raw.open === true,
      items,
      count: items.length,
      maxItems: MAX_BACKPACK_ITEMS,
      maxTextLength: MAX_GIFT_TEXT_LENGTH,
      maxFileBytes: MAX_GIFT_FILE_BYTES,
      ...(packet === null ? {} : { packet })
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
    const frozen = raw.frozen === true || raw.stage === 'frozen'
    if (frozen) {
      return {
        id,
        crop,
        stage: 'frozen',
        mature: false,
        remainingMs: 0,
        waterings: 0,
        fertilized: raw.fertilized === true,
        frozen: true
      }
    }
    const withered = raw.withered === true || raw.stage === 'withered'
    if (withered) {
      return {
        id,
        crop,
        stage: 'withered',
        mature: false,
        remainingMs: 0,
        waterings: 0,
        fertilized: raw.fertilized === true,
        withered: true
      }
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
    // ticket 48：unlock 日志带 plot（第几块地）与 cost（解锁花了多少硬币）。
    const cost = Number(raw.cost)
    const plot = Number(raw.plot)
    const coins = Number(raw.coins)
    const dew = Number(raw.dew)
    const choice = raw.choice === 'guard' || raw.choice === 'feed' || raw.choice === 'ignore' ? raw.choice : null
    const name = normalizeText(raw.name, '', 24)
    const wither = Number(raw.wither)
    const freeze = Number(raw.freeze)
    // 票 79 补：红包记录带方向（谁给谁）、步骤（收到/拆开/送出/退回）和里面装了什么。
    // 内容和昵称一样都是网络来的字：只留可显示的字，长度夹到 60 码点。
    const packetEvent = raw.event === 'arrived' || raw.event === 'claimed' ||
      raw.event === 'sent' || raw.event === 'returned'
      ? raw.event
      : null
    const event = raw.kind === 'packet' ? packetEvent : null
    const direction = raw.direction === 'in' || raw.direction === 'out' ? raw.direction : null
    const text = raw.kind === 'packet' ? normalizeText(raw.text, '', 240) : ''
    return {
      at: Math.floor(at),
      kind: raw.kind,
      ...(crop === null ? {} : { crop }),
      qty,
      ...(who === null ? {} : { who }),
      ...(name === '' ? {} : { name }),
      ...(choice === null ? {} : { choice }),
      ...(typeof raw.success === 'boolean' ? { success: raw.success } : {}),
      ...(Number.isFinite(coins) ? { coins: Math.min(MAX_FARM_COINS, Math.max(0, Math.floor(coins))) } : {}),
      ...(Number.isFinite(dew) ? { dew: Math.min(MAX_FARM_DEW, Math.max(0, Math.floor(dew))) } : {}),
      ...(Number.isFinite(wage) ? { wage: Math.min(MAX_FARM_COINS, Math.max(0, Math.floor(wage))) } : {}),
      ...(Number.isFinite(earned) ? { earned: Math.min(MAX_FARM_COINS, Math.max(0, Math.floor(earned))) } : {}),
      ...(Number.isFinite(hours) ? { hours: Math.min(HIRE_HOURS_MAX, Math.max(0, Math.floor(hours))) } : {}),
      ...(Number.isFinite(cost) ? { cost: Math.min(MAX_FARM_COINS, Math.max(0, Math.floor(cost))) } : {}),
      ...(Number.isFinite(wither) ? { wither: Math.min(MAX_FARM_PLOTS, Math.max(0, Math.floor(wither))) } : {}),
      ...(Number.isFinite(freeze) ? { freeze: Math.min(MAX_FARM_PLOTS, Math.max(0, Math.floor(freeze))) } : {}),
      ...(Number.isFinite(plot) ? { plot: Math.min(MAX_FARM_PLOTS, Math.max(1, Math.floor(plot))) } : {}),
      ...(event === null ? {} : { event }),
      ...(direction === null ? {} : { direction }),
      ...(text === '' ? {} : { text: Array.from(text).slice(0, 60).join('') })
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
  const SEASON_IDS = ['spring', 'summer', 'autumn', 'winter']
  const SEASON_EVENT_KINDS = ['plant', 'harvest', 'sell', 'water']

  function normalizeSeasonReward (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const coins = Number(raw.coins)
    const dew = Number(raw.dew)
    const seeds = {}
    if (raw.seeds !== null && typeof raw.seeds === 'object' && !Array.isArray(raw.seeds)) {
      for (const [crop, qty] of Object.entries(raw.seeds)) {
        const cropId = normalizeCropId(crop)
        const count = Number(qty)
        if (cropId === null || !Number.isFinite(count) || count <= 0) continue
        seeds[cropId] = Math.min(MAX_FARM_STACK, Math.floor(count))
      }
    }
    return {
      coins: Number.isFinite(coins) ? Math.min(MAX_FARM_COINS, Math.max(0, Math.floor(coins))) : 0,
      dew: Number.isFinite(dew) ? Math.min(MAX_FARM_DEW, Math.max(0, Math.floor(dew))) : 0,
      ...(Object.keys(seeds).length === 0 ? {} : { seeds })
    }
  }

  function normalizeSeasonEvent (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const requirement = raw.requirement !== null && typeof raw.requirement === 'object' ? raw.requirement : {}
    const kind = SEASON_EVENT_KINDS.includes(requirement.kind) ? requirement.kind : null
    if (kind === null) return null
    const qty = Math.min(999, Math.max(1, Math.floor(Number(requirement.qty) || 1)))
    const progress = Math.min(qty, Math.max(0, Math.floor(Number(raw.progress) || 0)))
    return {
      id: typeof raw.id === 'string' ? raw.id.slice(0, 32) : '',
      name: normalizeText(raw.name, '今日节日', 16),
      requirement: { kind, qty },
      progress,
      ready: progress >= qty,
      claimed: raw.claimed === true,
      reward: normalizeSeasonReward(raw.reward) ?? { coins: 0, dew: 0 }
    }
  }

  function normalizeSeasonCost (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { crops: 0, dew: 0, coins: 0 }
    const number = (value, max) => Number.isFinite(Number(value))
      ? Math.min(max, Math.max(0, Math.floor(Number(value))))
      : 0
    return {
      crops: number(raw.crops, MAX_FARM_STACK),
      dew: number(raw.dew, MAX_FARM_DEW),
      coins: number(raw.coins, MAX_FARM_COINS),
      witherPlots: number(raw.witherPlots, MAX_FARM_PLOTS),
      freezePlots: number(raw.freezePlots, MAX_FARM_PLOTS)
    }
  }

  function normalizeSeasonOmen (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const stakes = raw.stakes !== null && typeof raw.stakes === 'object' ? raw.stakes : {}
    const guardReward = normalizeSeasonReward(stakes.guardReward) ?? { coins: 0, dew: 0 }
    const feedReward = normalizeSeasonReward(stakes.feedReward) ?? { coins: 0, dew: 0 }
    const number = (value, max) => Number.isFinite(Number(value))
      ? Math.min(max, Math.max(0, Math.floor(Number(value))))
      : 0
    const choice = raw.choice === 'guard' || raw.choice === 'feed' ? raw.choice : null
    const choices = []
    if (Array.isArray(raw.choices)) {
      for (const candidate of raw.choices.slice(0, 2)) {
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
        if (candidate.id !== 'guard' && candidate.id !== 'feed') continue
        choices.push({
          id: candidate.id,
          label: normalizeText(candidate.label, candidate.id === 'guard' ? '守卫' : '安抚', 8),
          detail: normalizeText(candidate.detail, '', 120),
          cost: normalizeSeasonCost(candidate.cost),
          affordable: candidate.affordable !== false,
          ...(typeof candidate.reason === 'string' && candidate.reason !== ''
            ? { reason: normalizeText(candidate.reason, '', 60) }
            : {})
        })
      }
    }
    const start = Number(raw.start)
    const end = Number(raw.end)
    const day = Number(raw.day)
    const remaining = Number(raw.remainingMs)
    return {
      id: typeof raw.id === 'string' ? raw.id.slice(0, 32) : '',
      name: normalizeText(raw.name, '来客', 16),
      emoji: typeof raw.emoji === 'string' ? Array.from(raw.emoji).slice(0, 2).join('') : '🐻',
      tag: normalizeText(raw.tag, '季候来客', 12),
      season: SEASON_IDS.includes(raw.season) ? raw.season : null,
      start: Number.isFinite(start) ? Math.max(0, Math.floor(start)) : 0,
      end: Number.isFinite(end) ? Math.max(0, Math.floor(end)) : 0,
      day: Number.isFinite(day) ? Math.max(0, Math.floor(day)) : 0,
      remainingMs: Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 0,
      active: raw.active === true,
      resolved: raw.resolved === true,
      choice,
      // 处理过之后卡片只显示一句结论，这句话要靠 result 拼；丢掉它就只能写“已处理”。
      result: raw.result !== null && typeof raw.result === 'object' && !Array.isArray(raw.result)
        ? {
            success: raw.result.success === true,
            ignored: raw.result.ignored === true,
            loss: {
              crops: number(raw.result.loss?.crops, MAX_FARM_STACK),
              witherPlots: number(raw.result.loss?.witherPlots, MAX_FARM_PLOTS),
              freezePlots: number(raw.result.loss?.freezePlots, MAX_FARM_PLOTS)
            },
            reward: normalizeSeasonReward(raw.result.reward) ?? { coins: 0, dew: 0 }
          }
        : null,
      choices,
      canFeed: raw.canFeed === true,
      guardBase: Number.isFinite(Number(raw.guardBase)) ? Math.min(1, Math.max(0, Number(raw.guardBase))) : 0,
      guardPets: Number.isFinite(Number(raw.guardPets)) ? Math.min(2, Math.max(0, Math.floor(Number(raw.guardPets)))) : 0,
      guardOptions: Array.isArray(raw.guardOptions)
        ? raw.guardOptions.slice(0, 3).map((option) => ({
          guards: Number.isInteger(Number(option?.guards)) ? Math.min(2, Math.max(0, Number(option.guards))) : 0,
          chance: Number.isFinite(Number(option?.chance)) ? Math.min(1, Math.max(0, Number(option.chance))) : 0,
          cost: Number.isFinite(Number(option?.cost)) ? Math.min(MAX_FARM_COINS, Math.max(0, Math.floor(Number(option.cost)))) : 0,
          affordable: option?.affordable === true,
          ...(typeof option?.reason === 'string' && option.reason !== ''
            ? { reason: normalizeText(option.reason, '', 40) }
            : {})
        }))
        : [],
      stakes: {
        guardReward,
        failLoss: number(stakes.failLoss, MAX_FARM_STACK),
        failWither: number(stakes.failWither, MAX_FARM_PLOTS),
        failFreeze: number(stakes.failFreeze, MAX_FARM_PLOTS),
        failMatureOnly: stakes.failMatureOnly === true,
        feedCost: normalizeSeasonCost(stakes.feedCost),
        feedReward,
        ignoreLoss: normalizeSeasonCost(stakes.ignoreLoss)
      }
    }
  }

  /** 票 70/71：季节块只收宿主算好的展示值；日历最多 4 格，节日/来客形状不对就丢。 */
  function normalizeSeason (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (!SEASON_IDS.includes(raw.id)) return null
    const start = Number(raw.start)
    const end = Number(raw.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start) return null
    const calendar = []
    if (Array.isArray(raw.calendar)) {
      for (const candidate of raw.calendar.slice(0, 4)) {
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
        if (!SEASON_IDS.includes(candidate.id)) continue
        calendar.push({
          id: candidate.id,
          name: normalizeText(candidate.name, '', 4),
          emoji: typeof candidate.emoji === 'string' ? Array.from(candidate.emoji).slice(0, 2).join('') : '',
          today: candidate.today === true,
          past: candidate.past === true,
          festival: normalizeText(candidate.festival, '', 8)
        })
      }
    }
    const remaining = Number(raw.remainingMs)
    const event = normalizeSeasonEvent(raw.event)
    const omen = normalizeSeasonOmen(raw.omen)
    return {
      id: raw.id,
      name: normalizeText(raw.name, '', 8),
      emoji: typeof raw.emoji === 'string' ? Array.from(raw.emoji).slice(0, 2).join('') : '',
      start: Math.floor(start),
      end: Math.floor(end),
      remainingMs: Number.isFinite(remaining)
        ? Math.min(24 * 60 * 60 * 1000, Math.max(0, Math.floor(remaining)))
        : Math.max(0, Math.floor(end - Date.now())),
      calendar,
      event,
      omen
    }
  }

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
    // 票 79 补：红包单独攒的一份。流水一分钟两条，红包会被挤出去；这一份只收红包。
    const packets = []
    if (Array.isArray(raw.packets)) {
      for (const candidate of raw.packets) {
        if (packets.length >= MAX_FARM_PACKETS) break
        const entry = normalizeFarmLogEntry(candidate)
        if (entry === null || entry.kind !== 'packet') continue
        packets.push(entry)
      }
    }
    const hire = normalizeFarmHire(raw.hire)
    const season = normalizeSeason(raw.season)
    const guard = Number(raw.guard)
    const unlocked = typeof raw.unlocked === 'number' && Number.isFinite(raw.unlocked)
      ? Math.min(MAX_FARM_PLOTS, Math.max(MIN_FARM_PLOTS, Math.floor(raw.unlocked)))
      : null
    const maxPlots = typeof raw.maxPlots === 'number' && Number.isFinite(raw.maxPlots)
      ? Math.min(MAX_FARM_PLOTS, Math.max(MIN_FARM_PLOTS, Math.floor(raw.maxPlots)))
      : null
    const nextCost = typeof raw.nextCost === 'number' && Number.isFinite(raw.nextCost)
      ? Math.min(MAX_FARM_COINS, Math.max(0, Math.floor(raw.nextCost)))
      : null
    const unlockLadder = Array.isArray(raw.unlockLadder)
      ? raw.unlockLadder
        .slice(0, 6)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.min(MAX_FARM_COINS, Math.floor(value)))
      : []
    return {
      ...farm,
      ...(unlocked === null ? {} : { unlocked }),
      ...(maxPlots === null ? {} : { maxPlots }),
      ...(nextCost === null ? {} : { nextCost }),
      ...(unlockLadder.length === 0 ? {} : { unlockLadder }),
      seeds: normalizeFarmStacks(raw.seeds),
      crops: normalizeFarmStacks(raw.crops),
      ...(season === null ? {} : { season }),
      ...(hire === null ? {} : { hire }),
      ...(Number.isFinite(guard) ? { guard: Math.min(MAX_FARM_GUARD, Math.max(0, guard)) } : {}),
      log,
      ...(packets.length === 0 ? {} : { packets }),
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
          stale: candidate.stale === true,
          // 窗口自己走秒用：宿主按**本机收到行情**的时刻 + peerLostMs 算好。
          // 0 / 缺失 = 老宿主，窗口退回 stale 快照。
          expiresAt: Number.isFinite(Number(candidate.expiresAt)) && Number(candidate.expiresAt) > 0
            ? Math.floor(Number(candidate.expiresAt))
            : 0
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

  /** 与宿主 host 的 marketIndexWeight 同源：新鲜邻居数分档 × 作物 beta，封顶 85%。 */
  function marketIndexWeight (samples, cropId) {
    const count = Number(samples)
    const tier = Number.isFinite(count) ? Math.min(3, Math.max(0, Math.floor(count))) : 0
    const beta = Number(MARKET_CROP_BETA[cropId])
    const factor = Number.isFinite(beta) && beta > 0 ? beta : 1
    return Math.min(MARKET_INDEX_WEIGHT_MAX, MARKET_INDEX_WEIGHT_TIERS[tier] * factor)
  }

  /**
   * 交易所的一行价目。`indexPrice` 只在指数新鲜时传进来：
   * bid 与宿主同一条公式 `round(((1-w)×price + w×index)×0.9)`，
   * `w` 由 `indexEntry.samples` 与作物 beta 决定。宿主多传的 `bid` 一律不信。
   */
  function normalizeMarketPrice (raw, cropId, indexPrice = null, indexSamples = 0) {
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
    const weight = marketIndexWeight(indexSamples, cropId)
    const effective = Number.isFinite(remote) && remote > 0 && weight > 0
      ? (1 - weight) * price + weight * remote
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
        const rawMomentum = Number(entry.momentum)
        index[cropId] = {
          price: Math.min(base * MARKET_CEIL_RATIO, Math.max(base * MARKET_FLOOR_RATIO, price)),
          at: Math.floor(at),
          samples: Number.isFinite(samples) ? Math.max(0, Math.floor(samples)) : 0,
          weight: marketIndexWeight(Number.isFinite(samples) ? samples : 0, cropId),
          momentum: Number.isFinite(rawMomentum)
            ? Math.min(MARKET_MOMENTUM_MAX, Math.max(-MARKET_MOMENTUM_MAX, rawMomentum))
            : 0,
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
        indexEntry !== undefined && indexEntry.stale !== true ? indexEntry.price : null,
        indexEntry?.samples ?? 0
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

  /**
   * 票 52：只读查看邻居农场的画面。白名单只认请求者自己看得到的字段——
   * 主人的仓库/硬币/种子从来不下发，这里也就不会漏画。
   */
  function normalizeFarmLook (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const deviceId = normalizeUuid(raw.deviceId)
    if (deviceId === null) return null
    const guard = Number(raw.guard)
    const int = (value) => {
      const num = Number(value)
      return Number.isFinite(num) ? Math.min(50, Math.max(0, Math.floor(num))) : 0
    }
    const plots = []
    for (const candidate of Array.isArray(raw.plots) ? raw.plots : []) {
      if (plots.length >= MAX_FARM_PLOTS) break
      const plot = normalizeFarmVisitPlot(candidate)
      if (plot === null) continue
      plots.push(plot)
    }
    const query = raw.quotas !== null && typeof raw.quotas === 'object' ? raw.quotas : {}
    const nickname = typeof raw.host?.nickname === 'string'
      ? raw.host.nickname.trim().slice(0, 32)
      : '邻居'
    return {
      deviceId,
      nickname: nickname === '' ? '邻居' : nickname,
      guard: Number.isFinite(guard) ? Math.min(1, Math.max(0, guard)) : 0,
      plots,
      quotas: { perTrip: int(query.perTrip), perTripLeft: int(query.perTripLeft) }
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
  /** 票 55：窗口里的邻居切换器。只认 uuid + 昵称 + 两个能力位，别的字段进不来。 */
  function normalizeNeighborChips (raw) {
    const chips = []
    for (const candidate of Array.isArray(raw) ? raw : []) {
      if (chips.length >= 8) break
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const deviceId = normalizeUuid(candidate.deviceId)
      if (deviceId === null) continue
      if (chips.some((chip) => chip.deviceId === deviceId)) continue
      const nickname = typeof candidate.nickname === 'string' ? candidate.nickname.trim().slice(0, 32) : ''
      const ripe = Number(candidate.ripePlots)
      const guard = Number(candidate.guard)
      chips.push({
        deviceId,
        nickname: nickname === '' ? '邻居' : nickname,
        ...(candidate.canRaid === true ? { canRaid: true } : {}),
        // 票 56：排序与副标题要的三样（宿主算，窗口只画）。
        ...(Number.isFinite(ripe) ? { ripePlots: Math.min(50, Math.max(0, Math.floor(ripe))) } : {}),
        ...(Number.isFinite(guard) ? { guard: Math.min(1, Math.max(0, guard)) } : {}),
        ...(candidate.old === true ? { old: true } : {})
      })
    }
    return chips
  }

  function normalizeFarmWindow (raw) {
    // 票 59：目录必须先换、再校验——`normalizeCropId` 是按当前目录判的，
    // 顺序反了的话这一包里的新作物会被当成未知 id 丢掉（地块变空地、种子清零）。
    const crops = applyCropCatalog(raw.crops)
    const plotId = normalizePlotId(raw.plotId)
    const visit = normalizeFarmVisit(raw.visit)
    const look = normalizeFarmLook(raw.look)
    return {
      open: raw.open === true,
      ...(raw.close === true ? { close: true } : {}),
      mode: look !== null ? 'look' : raw.mode === 'visitor' ? 'visitor' : 'owner',
      // 票 59：窗口按这份目录画新作物；老宿主没这一项 = 只有内置六种。
      ...(crops === null ? {} : { crops }),
      neighbors: normalizeNeighborChips(raw.neighbors),
      farm: normalizeFarm(raw.farm),
      market: normalizeMarket(raw.market),
      // ticket 44：雇工页的合同/挂牌由宿主 push，窗口永远不自己发请求。
      contracts: normalizeContracts(raw.contracts),
      ...(visit === null ? {} : { visit }),
      ...(look === null ? {} : { look }),
      ...(plotId === null ? {} : { plotId })
    }
  }

  /**
   * 盘口小窗（票 79）的**宿主 → helper** 白名单。
   *
   * 窗口是 sandboxed 的 file:// 页面，只认这一份形状：多一个字段都进不去，
   * 数字要么是有限数、要么是 null（null 在视图层画成「—」）。
   * 业务白名单（50/100、1×）不在这里抄一遍——那是宿主的 `trading-rules.js`，
   * 这一层只管**形状**；抄两份迟早漂移（§9.3 的教训）。
   */
  function normalizeBoardNumber (value, min, max) {
    const num = Number(value)
    if (!Number.isFinite(num)) return null
    return Math.min(max, Math.max(min, num))
  }

  function normalizeBoardInt (value, min, max) {
    const num = normalizeBoardNumber(value, min, max)
    return num === null ? null : Math.round(num)
  }

  function strictBoardInt (value, min, max) {
    const num = Number(value)
    if (!Number.isInteger(num) || num < min || num > max) return null
    return num
  }

  /**
   * 盘口作物 id（票 88 / ADR-0031）：先认 helper 当前目录（`CROP_IDS`），
   * 再放行**和目录同一形状**的新 id。
   *
   * 为什么不用 `normalizeCropId()`：盘口清单跟随宿主运行时目录，LAN 同步来的新作物
   * 可能还没经过农场窗的 `applyCropCatalog()`；而盘口 payload 本身就是宿主的权威清单，
   * 只认内置目录会把新作物的图/持仓/hint 全削掉（§9.4 的老坑）。形状校验保留
   * （与 `src/crop-catalog.js` 的 `CROP_ID_RE` 同源），不是任意字符串都能当作物。
   */
  const BOARD_CROP_ID_RE = /^[a-z][a-z0-9_-]{1,23}$/
  function normalizeBoardCropId (value) {
    if (typeof value !== 'string') return null
    const id = value.trim().toLowerCase()
    if (id === '') return null
    return CROP_IDS.includes(id) || BOARD_CROP_ID_RE.test(id) ? id : null
  }

  function normalizeBoardPosition (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const id = normalizeId(raw.id)
    const crop = normalizeBoardCropId(raw.crop)
    const side = BOARD_SIDES.includes(raw.side) ? raw.side : null
    if (id === null || crop === null || side === null) return null
    const margin = normalizeBoardInt(raw.margin, 0, MAX_FARM_COINS)
    const leverage = normalizeBoardInt(raw.leverage, 1, BOARD_MAX_LEVERAGE)
    const entry = normalizeBoardNumber(raw.entry, 0, BOARD_MAX_PRICE)
    if (margin === null || leverage === null || entry === null) return null
    return {
      id,
      crop,
      side,
      margin,
      leverage,
      entry,
      mark: normalizeBoardNumber(raw.mark, 0, BOARD_MAX_PRICE),
      pnl: normalizeBoardNumber(raw.pnl, -BOARD_MAX_PRICE, BOARD_MAX_PRICE),
      // 票 81：强平价（1× 是 null → 窗口显示「—」）与止损档位（0 = 关）。
      // `null` 必须原样留下：它的意思是「这一手没有强平价」，不是 0。
      // 认不出的档位退成「关」：宁可少一道自动平仓，也不替玩家猜一档。
      liquidation: raw.liquidation === null || raw.liquidation === undefined
        ? null
        : normalizeBoardNumber(raw.liquidation, 0, BOARD_MAX_PRICE),
      stopLoss: BOARD_STOP_LEVELS.includes(raw.stopLoss) ? raw.stopLoss : 0,
      openedAt: normalizeBoardInt(raw.openedAt, 0, Number.MAX_SAFE_INTEGER),
      slot: normalizeBoardInt(raw.slot, 0, Number.MAX_SAFE_INTEGER),
      // 结算中的仓位只能看不能点平仓（钱已经走了一半，宿主会回 settling）。
      ...(raw.settling === true ? { settling: true } : {})
    }
  }

  function normalizeBoardHistory (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const id = normalizeId(raw.id)
    const crop = normalizeBoardCropId(raw.crop)
    const side = BOARD_SIDES.includes(raw.side) ? raw.side : null
    if (id === null || crop === null || side === null) return null
    if (!BOARD_REASONS.includes(raw.reason)) return null
    const entry = normalizeBoardNumber(raw.entry, 0, BOARD_MAX_PRICE)
    const exit = normalizeBoardNumber(raw.exit, 0, BOARD_MAX_PRICE)
    const pnl = normalizeBoardNumber(raw.pnl, -BOARD_MAX_PRICE, BOARD_MAX_PRICE)
    const at = normalizeBoardInt(raw.at, 0, Number.MAX_SAFE_INTEGER)
    if (entry === null || exit === null || pnl === null || at === null) return null
    return {
      id,
      crop,
      side,
      margin: normalizeBoardInt(raw.margin, 0, MAX_FARM_COINS) ?? 0,
      leverage: normalizeBoardInt(raw.leverage, 1, BOARD_MAX_LEVERAGE) ?? 1,
      entry,
      exit,
      pnl,
      reason: raw.reason,
      at
    }
  }

  /**
   * 到价挂单（票 83）：`{ id, crop, side, target, margin, leverage, placedAt, slot, remainingMs }`。
   * 保证金/方向/杠杆只是形状校验（50/250/全下与 1×/5×/20× 由宿主再判一次）；
   * `remainingMs` 是「距本根收盘」的展示值，窗口每秒本地递减，不拿它算钱。
   */
  function normalizeBoardOrder (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const id = normalizeId(raw.id)
    const crop = normalizeBoardCropId(raw.crop)
    const side = BOARD_SIDES.includes(raw.side) ? raw.side : null
    if (id === null || crop === null || side === null) return null
    const target = normalizeBoardNumber(raw.target, 0, BOARD_MAX_PRICE)
    const margin = strictBoardInt(raw.margin, 1, MAX_FARM_COINS)
    const leverage = normalizeBoardInt(raw.leverage, 1, BOARD_MAX_LEVERAGE)
    const placedAt = normalizeBoardInt(raw.placedAt, 0, Number.MAX_SAFE_INTEGER)
    const slot = normalizeBoardInt(raw.slot, 0, Number.MAX_SAFE_INTEGER)
    if (target === null || target <= 0 || margin === null || leverage === null ||
      placedAt === null || slot === null) {
      return null
    }
    return {
      id,
      crop,
      side,
      target,
      margin,
      leverage,
      placedAt,
      slot,
      remainingMs: normalizeBoardInt(raw.remainingMs, 0, 24 * 60 * 60 * 1000) ?? 0
    }
  }

  function normalizeBoardOrders (raw) {
    const orders = []
    for (const candidate of Array.isArray(raw) ? raw : []) {
      if (orders.length >= BOARD_MAX_ORDERS) break
      const order = normalizeBoardOrder(candidate)
      if (order !== null) orders.push(order)
    }
    return orders
  }

  function normalizeBoardLimits (raw) {
    const margins = []
    for (const candidate of Array.isArray(raw.margins) ? raw.margins : []) {
      if (margins.length >= BOARD_MAX_LIMITS) break
      const margin = strictBoardInt(candidate, 1, MAX_FARM_COINS)
      if (margin !== null && !margins.includes(margin)) margins.push(margin)
    }
    const leverages = []
    for (const candidate of Array.isArray(raw.leverages) ? raw.leverages : []) {
      if (leverages.length >= BOARD_MAX_LIMITS) break
      const leverage = strictBoardInt(candidate, 1, BOARD_MAX_LEVERAGE)
      if (leverage !== null && !leverages.includes(leverage)) leverages.push(leverage)
    }
    const crops = []
    for (const candidate of Array.isArray(raw.crops) ? raw.crops : []) {
      if (crops.length >= BOARD_MAX_LIMITS) break
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const id = normalizeBoardCropId(candidate.id)
      if (id === null || crops.some((crop) => crop.id === id)) continue
      crops.push({ id, name: normalizeLabel(candidate.name, id) })
    }
    // 票 84：周期页签的清单由宿主下发（`src/trading-rules.js` 是唯一来源），
    // 窗口不硬编码。只认白名单里的 id，顺序跟着宿主走。
    const timeframes = []
    for (const candidate of Array.isArray(raw.timeframes) ? raw.timeframes : []) {
      if (timeframes.length >= BOARD_TIMEFRAME_IDS.length) break
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
      if (!BOARD_TIMEFRAME_IDS.includes(id) || timeframes.some((entry) => entry.id === id)) continue
      timeframes.push({ id, label: normalizeLabel(candidate.label, id) })
    }
    return {
      margins,
      leverages,
      crops,
      timeframes,
      historyLimit: normalizeBoardInt(raw.historyLimit, 0, BOARD_MAX_HISTORY) ?? BOARD_MAX_HISTORY,
      // 票 83：宿主是否支持「全下」。旧宿主没有这个字段 → false（窗口不画那颗按钮）。
      allIn: raw.allIn === true,
      // 票 83：到价目标价带的比例（宿主 `PRICE_FLOOR_RATIO` / `PRICE_CEIL_RATIO`）。
      // 窗口只画提示，不拿它算钱；比例坏了就是 null，窗口不显示价格带（宿主照样会拒坏目标价）。
      targetRatio: normalizeBoardTargetRatio(raw.targetRatio)
    }
  }

  /** `{ floor, ceil }`：两个有限正数、floor < ceil，否则整块当没有。 */
  function normalizeBoardTargetRatio (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const floor = normalizeBoardNumber(raw.floor, 0, 100)
    const ceil = normalizeBoardNumber(raw.ceil, 0, 100)
    if (floor === null || ceil === null || floor <= 0 || ceil <= floor) return null
    return { floor, ceil }
  }

  /**
   * 一根 K 线：开高低收都是价格；slot 只当横轴的键。坏一根丢一根，图少一根不影响别的。
   *
   * 票 88 的紧凑形（宿主为省 IPC 带宽改成数组）：`[slot, start, end, open, high, low, close]`；
   * 老宿主仍然发对象形，两种都认。窗口拿到的**永远是对象**，视图层不用知道传输形状。
   */
  const BOARD_BAR_INDEX = Object.freeze({
    slot: 0,
    start: 1,
    end: 2,
    open: 3,
    high: 4,
    low: 5,
    close: 6
  })
  function boardBarFields (raw) {
    if (!Array.isArray(raw)) {
      return raw !== null && typeof raw === 'object' ? raw : null
    }
    if (raw.length < 7) return null
    return {
      slot: raw[BOARD_BAR_INDEX.slot],
      start: raw[BOARD_BAR_INDEX.start],
      end: raw[BOARD_BAR_INDEX.end],
      open: raw[BOARD_BAR_INDEX.open],
      high: raw[BOARD_BAR_INDEX.high],
      low: raw[BOARD_BAR_INDEX.low],
      close: raw[BOARD_BAR_INDEX.close],
      // 票 105：第 8 项是可选的 lite 消息数组；老宿主没有这一项就是 []。
      news: raw[7]
    }
  }
  /**
   * 一根 K 线上的 lite 消息（票 105）：id/时间/第几分钟/方向/影响/标题/稀有度/种类。
   * 坏一条丢一条，不整根丢；老宿主没有 news 就是空数组。
   */
  function normalizeBoardNewsItem (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const id = normalizeText(raw.id, null, MAX_ID_LENGTH)
    const at = normalizeBoardInt(raw.at, 0, Number.MAX_SAFE_INTEGER)
    const title = normalizeText(raw.title, null, BOARD_MAX_NEWS_TITLE)
    if (id === null || at === null || title === null) return null
    const tone = raw.tone === 'up' || raw.tone === 'down' || raw.tone === 'vol' ? raw.tone : 'vol'
    const off = normalizeBoardInt(raw.off, 0, BOARD_MAX_TICK) ?? 0
    const mag = normalizeBoardNumber(raw.mag, -1, 1) ?? 0
    const rarity = normalizeBoardInt(raw.rarity, 0, 3) ?? 0
    const kind = normalizeText(raw.kind, '', 16)
    return { id, at, off, tone, mag, title, rarity, kind }
  }

  function normalizeBoardBarNews (raw) {
    const news = []
    for (const candidate of Array.isArray(raw) ? raw : []) {
      if (news.length >= BOARD_MAX_NEWS_PER_BAR) break
      const item = normalizeBoardNewsItem(candidate)
      if (item !== null) news.push(item)
    }
    return news
  }

  /** 票 107：资金流事件（窗口只读）；坏一条丢一条。 */
  function normalizeBoardFlowEvent (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const at = normalizeBoardInt(raw.at, 0, Number.MAX_SAFE_INTEGER)
    const notional = normalizeBoardInt(raw.notional, 0, 10_000_000)
    const impact = normalizeBoardNumber(raw.impact, -1, 1)
    if (at === null || notional === null || impact === null) return null
    const deviceId = normalizeText(raw.deviceId, '', 64)
    const name = normalizeText(raw.name, '邻居', 24)
    const action = raw.action === 'open' || raw.action === 'close' ? raw.action : null
    const side = raw.side === 'long' || raw.side === 'short' ? raw.side : null
    if (action === null || side === null) return null
    const reason = ['manual', 'settle', 'liquidate', 'stop'].includes(raw.reason) ? raw.reason : 'manual'
    const source = ['board', 'futures', 'farm'].includes(raw.source) ? raw.source : 'board'
    const id = normalizeText(raw.id, '', 128)
    return { id, at, deviceId, name, action, side, reason, notional, impact, source }
  }

  /** 票 107：资金流块 `{ level, net, events }`；老宿主没有就返回空块。 */
  function normalizeBoardFlow (raw) {
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const events = []
    for (const candidate of Array.isArray(source.events) ? source.events : []) {
      if (events.length >= BOARD_MAX_NEWS_ITEMS) break
      const event = normalizeBoardFlowEvent(candidate)
      if (event !== null) events.push(event)
    }
    return {
      level: normalizeBoardNumber(source.level, -1, 1) ?? 0,
      net: normalizeBoardNumber(source.net, -1, 1) ?? 0,
      events
    }
  }

  /** 窗口顶层的消息全文 + 今日日程（票 105）。老宿主没有这一块时是空表。 */
  function normalizeBoardNews (raw) {
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const items = []
    for (const candidate of Array.isArray(source.items) ? source.items : []) {
      if (items.length >= BOARD_MAX_NEWS_ITEMS) break
      const item = normalizeBoardNewsItem(candidate)
      if (item === null) continue
      const crop = normalizeBoardCropId(candidate.crop)
      const body = normalizeText(candidate.body, null, BOARD_MAX_NEWS_BODY)
      const sourceText = normalizeText(candidate.source, null, BOARD_MAX_NEWS_SOURCE)
      items.push({ ...item, crop, body, source: sourceText })
    }
    const calendar = []
    for (const candidate of Array.isArray(source.calendar) ? source.calendar : []) {
      if (calendar.length >= BOARD_MAX_NEWS_CALENDAR) break
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const at = normalizeBoardInt(candidate.at, 0, Number.MAX_SAFE_INTEGER)
      const title = normalizeText(candidate.title, null, BOARD_MAX_NEWS_TITLE)
      if (at === null || title === null) continue
      calendar.push({
        at,
        crop: normalizeBoardCropId(candidate.crop),
        cropName: normalizeText(candidate.cropName, '', BOARD_MAX_NEWS_SOURCE),
        title,
        tone: candidate.tone === 'up' || candidate.tone === 'down' || candidate.tone === 'vol' ? candidate.tone : 'vol',
        mag: normalizeBoardNumber(candidate.mag, -1, 1) ?? 0,
        countdownMs: normalizeBoardInt(candidate.countdownMs, 0, 24 * 60 * 60 * 1000) ?? 0,
        done: candidate.done === true
      })
    }
    return { items: items.slice(0, BOARD_MAX_NEWS_COUNT), calendar }
  }

  function normalizeBoardBar (raw) {
    const fields = boardBarFields(raw)
    if (fields === null) return null
    const slot = normalizeBoardInt(fields.slot, 0, Number.MAX_SAFE_INTEGER)
    const open = normalizeBoardNumber(fields.open, 0, BOARD_MAX_PRICE)
    const high = normalizeBoardNumber(fields.high, 0, BOARD_MAX_PRICE)
    const low = normalizeBoardNumber(fields.low, 0, BOARD_MAX_PRICE)
    const close = normalizeBoardNumber(fields.close, 0, BOARD_MAX_PRICE)
    if (slot === null || open === null || high === null || low === null || close === null) return null
    // 票 84：`start`/`end` 是这一根的真实毫秒边界（窗口的时间标签靠它）。
    // 老宿主没有这两个字段时保留 null，不因为少一个标签就把整根丢掉。
    const news = normalizeBoardBarNews(fields.news)
    return {
      slot,
      start: normalizeBoardInt(fields.start, 0, Number.MAX_SAFE_INTEGER),
      end: normalizeBoardInt(fields.end, 0, Number.MAX_SAFE_INTEGER),
      open,
      high,
      low,
      close,
      // 没有消息就不带这个键：老测试/老窗口看到的仍是原来的 7 字段形状。
      ...(news.length === 0 ? {} : { news })
    }
  }

  /** 当前形成中的一根（票 81）：`price` 是现价，`tick` 是已经走了几分钟。 */
  function normalizeBoardCurrentBar (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const slot = normalizeBoardInt(raw.slot, 0, Number.MAX_SAFE_INTEGER)
    const open = normalizeBoardNumber(raw.open, 0, BOARD_MAX_PRICE)
    const high = normalizeBoardNumber(raw.high, 0, BOARD_MAX_PRICE)
    const low = normalizeBoardNumber(raw.low, 0, BOARD_MAX_PRICE)
    const price = normalizeBoardNumber(raw.price, 0, BOARD_MAX_PRICE)
    if (slot === null || open === null || high === null || low === null || price === null) return null
    return {
      slot,
      start: normalizeBoardInt(raw.start, 0, Number.MAX_SAFE_INTEGER),
      end: normalizeBoardInt(raw.end, 0, Number.MAX_SAFE_INTEGER),
      open,
      high,
      low,
      price,
      // 票 84：粗周期没有「本根第几分钟」，宿主发 null 时必须原样留着（别被 ?? 0 改成 0）。
      tick: raw.tick === null ? null : (normalizeBoardNumber(raw.tick, 0, BOARD_MAX_TICK) ?? 0),
      remainingMs: normalizeBoardInt(raw.remainingMs, 0, 24 * 60 * 60 * 1000) ?? 0,
      ...(normalizeBoardBarNews(raw.news).length === 0 ? {} : { news: normalizeBoardBarNews(raw.news) })
    }
  }

  /** 一张图：底价 + 最近若干整根 + 当前一根。坏成空图（窗口画空态），不整窗失败。 */
  function normalizeBoardChart (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const base = normalizeBoardNumber(raw.base, 0, BOARD_MAX_PRICE)
    if (base === null) return null
    const bars = []
    for (const candidate of Array.isArray(raw.bars) ? raw.bars : []) {
      if (bars.length >= BOARD_MAX_BARS) break
      const bar = normalizeBoardBar(candidate)
      if (bar !== null) bars.push(bar)
    }
    return { base, bars, current: normalizeBoardCurrentBar(raw.current) }
  }

  /**
   * `charts: { tomato: {…}, … }`：键必须是盘口作物 id（目录里的 + 同形新作物，
   * 见 `normalizeBoardCropId()`），多余的键丢掉；最多 `BOARD_MAX_CHARTS` 张。
   */
  function normalizeBoardCharts (raw) {
    const charts = {}
    let count = 0
    for (const key of Object.keys(raw)) {
      if (count >= BOARD_MAX_CHARTS) break
      const crop = normalizeBoardCropId(key)
      if (crop === null) continue
      const chart = normalizeBoardChart(raw[key])
      if (chart === null) continue
      charts[crop] = chart
      count += 1
    }
    return charts
  }

  /**
   * `timeframes: { '15m'|'1h'|'1d'|'1w': { tomato, carrot, pumpkin } }`（票 84）。
   *
   * 只按白名单顺序走四个 id：多余的周期、坏块直接丢，窗口退回 15 分画空态而不是崩。
   * 每个周期内部复用 `normalizeBoardCharts()`——作物与根数上限跟 `charts` 同一把尺子，
   * 不另写一套（§9.4 的老坑：宿主发了、白名单没放行，窗口永远收不到）。
   */
  function normalizeBoardTimeframes (raw) {
    const timeframes = {}
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return timeframes
    for (const id of BOARD_TIMEFRAME_IDS) {
      const block = raw[id]
      if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
      timeframes[id] = normalizeBoardCharts(block)
    }
    return timeframes
  }

  /** `hint: { tomato: { direction, confidence }, … }`：方向只有三种，置信度必须 0–1。 */
  function normalizeBoardHints (raw) {
    const hints = {}
    let count = 0
    for (const key of Object.keys(raw)) {
      if (count >= BOARD_MAX_CHARTS) break
      const crop = normalizeBoardCropId(key)
      if (crop === null) continue
      const entry = raw[key]
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const direction = entry.direction === 'up' || entry.direction === 'down'
        ? entry.direction
        : entry.direction === 'flat' ? 'flat' : null
      const confidence = normalizeBoardNumber(entry.confidence, 0, 1)
      if (direction === null || confidence === null) continue
      hints[crop] = { direction, confidence }
      count += 1
    }
    return hints
  }

  /** 榜上一条持仓（票 82）：只有作物/方向/杠杆——保证金与入场价根本不在报文里。 */
  function normalizeBoardLeaguePosition (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const crop = normalizeBoardCropId(raw.crop)
    const side = BOARD_SIDES.includes(raw.side) ? raw.side : null
    const leverage = strictBoardInt(raw.leverage, 1, BOARD_MAX_LEVERAGE)
    if (crop === null || side === null || leverage === null) return null
    return { crop, side, leverage }
  }

  /**
   * 榜上一行。`weekPnl` 是排序键（宿主已按它排好），`weekPnlPct` 是可选比率
   * （0.035 = +3.5%），缺省就是 null（窗口画「—」）。`me` 是本机那一行，窗口高亮它。
   */
  function normalizeBoardLeagueRow (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const deviceId = normalizeUuid(raw.deviceId)
    const weekPnl = normalizeBoardNumber(raw.weekPnl, -BOARD_MAX_WEEK_PNL, BOARD_MAX_WEEK_PNL)
    if (deviceId === null || weekPnl === null) return null
    const positions = []
    for (const candidate of Array.isArray(raw.positions) ? raw.positions : []) {
      if (positions.length >= BOARD_MAX_LEAGUE_POSITIONS) break
      const position = normalizeBoardLeaguePosition(candidate)
      if (position === null) continue
      positions.push(position)
    }
    return {
      deviceId,
      nickname: normalizeLabel(raw.nickname, '邻居'),
      weekPnl,
      weekPnlPct: raw.weekPnlPct === null || raw.weekPnlPct === undefined
        ? null
        : normalizeBoardNumber(raw.weekPnlPct, -BOARD_MAX_WEEK_PNL_PCT, BOARD_MAX_WEEK_PNL_PCT),
      positions,
      me: raw.me === true
    }
  }

  /**
   * `league: { rows, sentiment, self }`（票 82）。坏行只丢自己、重复 deviceId 只留第一条；
   * 整块缺失/坏形状就是空榜 → 窗口画「还没有邻居上线」。
   */
  function normalizeBoardLeague (raw) {
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const rows = []
    const seen = new Set()
    for (const candidate of Array.isArray(source.rows) ? source.rows : []) {
      if (rows.length >= BOARD_MAX_LEAGUE_ROWS) break
      const row = normalizeBoardLeagueRow(candidate)
      if (row === null || seen.has(row.deviceId)) continue
      seen.add(row.deviceId)
      rows.push(row)
    }
    const counts = source.sentiment !== null && typeof source.sentiment === 'object' &&
      !Array.isArray(source.sentiment)
      ? source.sentiment
      : {}
    const own = source.self !== null && typeof source.self === 'object' && !Array.isArray(source.self)
      ? source.self
      : {}
    // 旧版本邻居（评审 P1）：有人在线、但一条周报都没发时，窗口要画「旧版本」而不是
    // 「还没有邻居上线」。这两个数只是展示用的计数，坏了归零。
    const watchers = source.watchers !== null && typeof source.watchers === 'object' &&
      !Array.isArray(source.watchers)
      ? source.watchers
      : {}
    return {
      rows,
      sentiment: {
        long: normalizeBoardInt(counts.long, 0, BOARD_MAX_LEAGUE_COUNT) ?? 0,
        short: normalizeBoardInt(counts.short, 0, BOARD_MAX_LEAGUE_COUNT) ?? 0,
        flat: normalizeBoardInt(counts.flat, 0, BOARD_MAX_LEAGUE_COUNT) ?? 0
      },
      self: {
        weekPnl: normalizeBoardNumber(own.weekPnl, -BOARD_MAX_WEEK_PNL, BOARD_MAX_WEEK_PNL) ?? 0,
        weekPnlPct: own.weekPnlPct === null || own.weekPnlPct === undefined
          ? null
          : normalizeBoardNumber(own.weekPnlPct, -BOARD_MAX_WEEK_PNL_PCT, BOARD_MAX_WEEK_PNL_PCT)
      },
      watchers: {
        online: normalizeBoardInt(watchers.online, 0, BOARD_MAX_WATCHERS) ?? 0,
        reported: normalizeBoardInt(watchers.reported, 0, BOARD_MAX_WATCHERS) ?? 0
      }
    }
  }

  /** 整份盘口视图；坏到不成形状就返回 null（窗口画空态，不崩）。 */
  function normalizeBoardView (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const coinsRaw = raw.coins !== null && typeof raw.coins === 'object' && !Array.isArray(raw.coins)
      ? raw.coins
      : {}
    const weekRaw = raw.week !== null && typeof raw.week === 'object' && !Array.isArray(raw.week)
      ? raw.week
      : {}
    const limitsRaw = raw.limits !== null && typeof raw.limits === 'object' && !Array.isArray(raw.limits)
      ? raw.limits
      : {}
    const barRaw = raw.bar !== null && typeof raw.bar === 'object' && !Array.isArray(raw.bar)
      ? raw.bar
      : null
    const rawPositions = Array.isArray(raw.positions) ? raw.positions : []
    const positions = []
    for (const candidate of rawPositions) {
      if (positions.length >= BOARD_MAX_POSITIONS) break
      const position = normalizeBoardPosition(candidate)
      if (position !== null) positions.push(position)
    }
    const history = []
    for (const candidate of Array.isArray(raw.history) ? raw.history : []) {
      if (history.length >= BOARD_MAX_HISTORY) break
      const entry = normalizeBoardHistory(candidate)
      if (entry !== null) history.push(entry)
    }
    // 票 88：四个周期的图只归一化一次。
    const timeframes = normalizeBoardTimeframes(
      raw.timeframes !== null && typeof raw.timeframes === 'object' && !Array.isArray(raw.timeframes)
        ? raw.timeframes
        : {}
    )
    // 老宿主（票 81 的包）仍可能直接发 `charts`；新宿主不再重复下发（票 90）。
    const charts = raw.charts !== null && typeof raw.charts === 'object' && !Array.isArray(raw.charts)
      ? normalizeBoardCharts(raw.charts)
      : {}
    return {
      coins: {
        available: normalizeBoardInt(coinsRaw.available, 0, MAX_FARM_COINS) ?? 0,
        locked: normalizeBoardInt(coinsRaw.locked, 0, MAX_FARM_COINS) ?? 0,
        total: normalizeBoardInt(coinsRaw.total, 0, MAX_FARM_COINS) ?? 0
      },
      week: {
        start: normalizeBoardInt(weekRaw.start, 0, Number.MAX_SAFE_INTEGER) ?? 0,
        // pnl 是已实现（落盘、榜也用）；unrealized 与 total 是票 81 的展示口径
        // （顶部的「本周盈亏」= 已实现 + 未实现），收益率用 total / base。
        pnl: normalizeBoardInt(weekRaw.pnl, -MAX_FARM_COINS, MAX_FARM_COINS) ?? 0,
        base: normalizeBoardInt(weekRaw.base, 0, MAX_FARM_COINS) ?? 0,
        unrealized: normalizeBoardInt(weekRaw.unrealized, -MAX_FARM_COINS, MAX_FARM_COINS) ?? 0,
        total: normalizeBoardInt(weekRaw.total, -MAX_FARM_COINS, MAX_FARM_COINS) ?? 0
      },
      limits: normalizeBoardLimits(limitsRaw),
      // 票 81：老宿主（票 81 的包）把 15 分图放在 `charts` 里，仍然照收。
      // 票 90：新宿主只发 `timeframes`，这里**不再**把 `timeframes['15m']` 复制成
      // `charts`——同一份图序列化两遍，正是 308 KiB 卡住 IPC 的那一半体积。
      // 视图对没有 `timeframes` 的老包仍会回退读 `charts`（`timeframeChartsOf()`）。
      charts,
      // 票 84：四个周期的 K 线。老宿主没有这一块时是空对象，窗口退回 `charts`（15 分）。
      timeframes,
      hint: normalizeBoardHints(
        raw.hint !== null && typeof raw.hint === 'object' && !Array.isArray(raw.hint)
          ? raw.hint
          : {}
      ),
      // 票 105：消息全文 + 今日日程；老宿主没有就是空表，空表也不带这个键。
      ...(() => {
        const news = normalizeBoardNews(raw.news)
        return news.items.length === 0 && news.calendar.length === 0 ? {} : { news }
      })(),
      // 票 107：资金流块；老宿主/没有流水时不带这个键。
      ...(raw.flow !== null && typeof raw.flow === 'object' && !Array.isArray(raw.flow)
        ? { flow: normalizeBoardFlow(raw.flow) }
        : {}),
      bar: barRaw === null
        ? null
        : {
          crop: normalizeBoardCropId(barRaw.crop),
          slot: normalizeBoardInt(barRaw.slot, 0, Number.MAX_SAFE_INTEGER),
          start: normalizeBoardInt(barRaw.start, 0, Number.MAX_SAFE_INTEGER),
          end: normalizeBoardInt(barRaw.end, 0, Number.MAX_SAFE_INTEGER),
          remainingMs: normalizeBoardInt(barRaw.remainingMs, 0, 24 * 60 * 60 * 1000),
          open: normalizeBoardNumber(barRaw.open, 0, BOARD_MAX_PRICE),
          price: normalizeBoardNumber(barRaw.price, 0, BOARD_MAX_PRICE)
        },
      positions,
      // 总数是账本里的真实条数（评审 P1）：宿主没给就退回这次收到的条数；
      // 窗口用「持仓 N · 显示最近 200」说明截断，而不是假装只有画出来的这些。
      positionsTotal: normalizeBoardInt(raw.positionsTotal, 0, Number.MAX_SAFE_INTEGER) ??
        rawPositions.length,
      history,
      // 票 83：到价挂单（宿主已经按形状校验过；这里再白名单一遍，防止窗口收到多余字段）。
      // §9.4 的老坑：这一行要是继续硬编码 []，宿主发了、窗口永远收不到。
      orders: normalizeBoardOrders(raw.orders),
      ordersTotal: normalizeBoardInt(raw.ordersTotal, 0, Number.MAX_SAFE_INTEGER) ??
        (Array.isArray(raw.orders) ? raw.orders.length : 0),
      // 票 82：真人周榜 + LAN 情绪。老宿主没有这一块时是空榜（窗口画「还没有邻居上线」）。
      league: normalizeBoardLeague(raw.league)
    }
  }

  /** `board-window` 命令：和农场窗一样，刷新（open:false）与关窗（close:true）必须分开。 */
  function normalizeBoardWindow (raw) {
    return {
      open: raw.open === true,
      ...(raw.close === true ? { close: true } : {}),
      state: normalizeBoardView(raw.state)
    }
  }

  /** 盘口小窗提交（`dsh-zoo:board-submit`）的唯一白名单：坏形状整条拒绝，不半截猜测。 */
  function normalizeBoardAction (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : ''
    if (!BOARD_SUBMIT_ACTIONS.includes(action)) return null
    if (action === 'trading-refresh') return { action }
    // 按需拉图（票 90）：窗口只报要看哪一种作物；四个周期的图由宿主算好回执。
    if (action === 'trading-charts') {
      const cropId = normalizeBoardCropId(raw.cropId)
      return cropId === null ? null : { action, cropId }
    }
    if (action === 'trading-close-position') {
      const positionId = normalizeUuid(raw.positionId)
      return positionId === null ? null : { action, positionId }
    }
    // 止损循环（票 81）：窗口只报「哪一手 + 下一档」；档位必须正好是四个之一。
    if (action === 'trading-set-stop') {
      const positionId = normalizeUuid(raw.positionId)
      if (positionId === null) return null
      const level = Number(raw.level)
      if (!BOARD_STOP_LEVELS.includes(level)) return null
      return { action, positionId, level }
    }
    // 撤单（票 83）：只认 UUID；坏 id 整条拒绝，不做半截猜测。
    if (action === 'trading-cancel-order') {
      const orderId = normalizeUuid(raw.orderId)
      return orderId === null ? null : { action, orderId }
    }
    // 到价挂单（票 83）：形状合法即可，目标价是否落在价格带、保证金够不够，
    // 由宿主按 `trading-rules` 再判一次（并回人话）。
    if (action === 'trading-place-order') {
      const side = BOARD_SIDES.includes(raw.side) ? raw.side : null
      const margin = strictBoardInt(raw.margin, 1, MAX_FARM_COINS)
      const leverage = strictBoardInt(raw.leverage, 1, BOARD_MAX_LEVERAGE)
      // 盘口作物走 `normalizeBoardCropId()`（票 88）：目录里新增的作物也能下单；
      // 宿主照样按 `isBoardCrop()` 再判一次，这一层只守形状。
      const cropId = normalizeBoardCropId(raw.cropId)
      const target = Number(raw.target)
      if (side === null || margin === null || leverage === null || cropId === null) return null
      if (!Number.isFinite(target) || target <= 0 || target > BOARD_MAX_PRICE) return null
      return { action, side, margin, leverage, cropId, target }
    }
    // 开仓：形状合法即可；保证金/杠杆白名单由宿主按 trading-rules 再判一次（并回人话）。
    const side = BOARD_SIDES.includes(raw.side) ? raw.side : null
    const margin = strictBoardInt(raw.margin, 1, MAX_FARM_COINS)
    const leverage = strictBoardInt(raw.leverage, 1, BOARD_MAX_LEVERAGE)
    // 与到价挂单同一把尺子：新增作物能在盘口开仓，未知作物仍由宿主拒掉。
    const cropId = normalizeBoardCropId(raw.cropId)
    if (side === null || margin === null || leverage === null || cropId === null) return null
    return { action, side, margin, leverage, cropId }
  }

  /**
   * 期货小窗（票 93）的视图：宿主算好整份推过来，窗口只画。
   * 这一层只守形状与体量（数组截断、数字归一），不算任何钱。
   */
  function normalizeFuturesView (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const num = (value, fallback = null) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
    const text = (value) => (typeof value === 'string' ? value.slice(0, 64) : null)
    // 兜底字段（保险基金 / 欠账 / 强平次数）：负数与坏值都按 0，不让窗口画出负基金。
    const nonNegative = (value) => {
      const result = num(value)
      return result === null || result < 0 ? 0 : result
    }

    const quotes = {}
    if (raw.quotes !== null && typeof raw.quotes === 'object' && !Array.isArray(raw.quotes)) {
      for (const [cropId, quote] of Object.entries(raw.quotes)) {
        if (Object.keys(quotes).length >= BOARD_MAX_LIMITS) break
        if (quote === null || typeof quote !== 'object' || Array.isArray(quote)) continue
        const contract = quote.contract !== null && typeof quote.contract === 'object'
          ? { id: text(quote.contract.id) ?? '', openAt: num(quote.contract.openAt, 0), expireAt: num(quote.contract.expireAt, 0) }
          : null
        quotes[cropId] = { contract, fair: num(quote.fair), bid: num(quote.bid), ask: num(quote.ask) }
      }
    }

    const positions = Array.isArray(raw.positions)
      ? raw.positions.slice(0, FUTURES_MAX_POSITIONS).filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item)).map((item) => ({
        id: text(item.id),
        crop: text(item.crop),
        contract: text(item.contract) ?? '—',
        side: item.side === 'short' ? 'short' : 'long',
        lots: num(item.lots, 0),
        entry: num(item.entry, 0),
        margin: num(item.margin, 0),
        leverage: num(item.leverage, 1),
        unrealized: num(item.unrealized, 0)
      }))
      : []

    const trades = Array.isArray(raw.trades)
      ? raw.trades.slice(0, FUTURES_MAX_TRADES).filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item)).map((item) => ({
        at: num(item.at, 0),
        crop: text(item.crop),
        contract: text(item.contract) ?? '—',
        side: item.side === 'short' ? 'short' : 'long',
        lots: num(item.lots, 0),
        price: num(item.price, 0),
        fee: num(item.fee, 0),
        kind: FUTURES_TRADE_KINDS.includes(item.kind) ? item.kind : 'open'
      }))
      : []

    // 自己的挂单（票 95）：坏条目整条丢——半条挂单会让「剩余/冻结」对不上账。
    const orders = []
    if (Array.isArray(raw.orders)) {
      for (const item of raw.orders.slice(0, FUTURES_MAX_ORDERS)) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
        const id = text(item.id)
        const side = item.side === 'short' ? 'short' : item.side === 'long' ? 'long' : null
        const price = num(item.price)
        const lots = num(item.lots)
        const lotsLeft = num(item.lotsLeft)
        const leverage = num(item.leverage)
        const marginFrozen = num(item.marginFrozen)
        if (id === null || id === '' || side === null) continue
        if (price === null || price <= 0 || !Number.isInteger(lots) || lots < 1) continue
        if (!Number.isInteger(lotsLeft) || lotsLeft < 0 || lotsLeft > lots) continue
        if (leverage === null || leverage <= 0 || marginFrozen === null || marginFrozen < 0) continue
        orders.push({
          id,
          crop: text(item.crop),
          contract: text(item.contract) ?? '—',
          side,
          price,
          lots,
          lotsLeft,
          leverage,
          marginFrozen,
          at: num(item.at)
        })
      }
    }

    // 交易阶段（票 96）：`text` 只留 60 字，渲染层整行贴出去。
    const sessionRaw = raw.session
    const session = sessionRaw !== null && typeof sessionRaw === 'object' && !Array.isArray(sessionRaw) &&
      FUTURES_SESSION_KINDS.includes(sessionRaw.kind)
      ? {
          kind: sessionRaw.kind,
          text: typeof sessionRaw.text === 'string' ? sessionRaw.text.slice(0, 60) : ''
        }
      : null

    // 到期日交割窗口（票 96）：四根收盘价必须都是数字、顺序照抄；坏窗口整块丢。
    let delivery = null
    if (raw.delivery !== null && typeof raw.delivery === 'object' && !Array.isArray(raw.delivery)) {
      const closes = Array.isArray(raw.delivery.closes)
        ? raw.delivery.closes.map((value) => num(value)).filter((value) => value !== null).slice(0, 4)
        : []
      const price = num(raw.delivery.price)
      const contract = text(raw.delivery.contract)
      if (contract !== null && contract !== '' && price !== null && price > 0 && closes.length > 0) {
        delivery = { contract, closes, price, at: num(raw.delivery.at) }
      }
    }

    const crops = Array.isArray(raw.crops)
      ? raw.crops.slice(0, BOARD_MAX_LIMITS).filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item)).map((item) => ({
        id: text(item.id) ?? '',
        label: text(item.label) ?? text(item.id) ?? '',
        index: num(item.index)
      }))
      : []

    const limitsRaw = raw.limits !== null && typeof raw.limits === 'object' ? raw.limits : {}
    const leverages = Array.isArray(limitsRaw.leverages)
      ? limitsRaw.leverages.filter((item) => FUTURES_LEVERAGES.includes(item)).slice(0, FUTURES_LEVERAGES.length)
      : FUTURES_LEVERAGES.slice()

    return {
      ready: raw.ready === true,
      epoch: text(raw.epoch) ?? '',
      balance: num(raw.balance, 0),
      marginUsed: num(raw.marginUsed, 0),
      equity: num(raw.equity, 0),
      closed: num(raw.closed, 0),
      // 票 98 / 1.10.0：市场闸门（off/开市）与**本账户自己的档位**（真钱/纸面）。
      // 这两个字段以前被窗口的白名单漏掉，导致徽章永远画成「真钱」、限额行永远空着。
      mode: FUTURES_MODES.includes(raw.mode) ? raw.mode : null,
      accountMode: FUTURES_ACCOUNT_MODES.includes(raw.accountMode) ? raw.accountMode : 'shadow',
      disabled: raw.disabled === true,
      // 1.12.0：这个账户自己按的暂停（房主按下去也停不了别人，所以只看自己）。
      paused: raw.paused === true,
      // 1.12.8：房主认没认这个档位。没认时窗口要直说，不能只让人看见「点了没反应」。
      accountConfirmed: raw.accountConfirmed === true,
      pending: nonNegative(raw.pending),
      dayCap: num(raw.dayCap),
      dayNotional: nonNegative(raw.dayNotional),
      positionCap: num(raw.positionCap),
      // peer 视角：房主还没回执时窗口要能说清「等对端」。
      role: raw.role === 'peer' ? 'peer' : 'host',
      hostId: text(raw.hostId),
      peer: raw.peer !== null && typeof raw.peer === 'object' && !Array.isArray(raw.peer)
        ? { ready: raw.peer.ready === true, text: text(raw.peer.text) ?? '' }
        : null,
      positionCount: num(raw.positionCount, positions.length),
      positions,
      orders,
      trades,
      session,
      delivery,
      // 票 96 的兜底账：宿主还没下发时窗口画 0，不画「—」。
      insurance: nonNegative(raw.insurance),
      shortfall: nonNegative(raw.shortfall),
      // 1.12.4：做市商净盈亏，允许为负（负 = 系统净付出），所以走 `num` 而不是 `nonNegative`。
      house: num(raw.house, 0),
      liquidationCount: nonNegative(raw.liquidationCount),
      week: raw.week !== null && typeof raw.week === 'object'
        ? { start: num(raw.week.start, 0), pnl: num(raw.week.pnl, 0) }
        : { start: 0, pnl: 0 },
      quotes,
      crops,
      limits: {
        leverages: leverages.length > 0 ? leverages : FUTURES_LEVERAGES.slice(),
        lotSize: num(limitsRaw.lotSize, 100),
        takerFeeRate: num(limitsRaw.takerFeeRate, 0.001),
        spreadRate: num(limitsRaw.spreadRate, 0.002)
      },
      now: num(raw.now, 0),
      slotEnd: num(raw.slotEnd, 0)
    }
  }

  /** `futures-window` 命令：与盘口同形——`open:true` 打开/聚焦，`open:false` 刷新，`close:true` 关窗。 */
  function normalizeFuturesWindow (raw) {
    return {
      open: raw.open === true,
      ...(raw.close === true ? { close: true } : {}),
      state: normalizeFuturesView(raw.state)
    }
  }

  /** 期货小窗提交（`dsh-zoo:futures-submit`）的白名单：坏形状整条拒绝。 */
  function normalizeFuturesAction (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : ''
    if (!FUTURES_SUBMIT_ACTIONS.includes(action)) return null
    if (action === 'futures-refresh') return { action }
    // 票 98：房主切档与回滚。`futures-rollback` 不带字段；`futures-mode` 只认三个档位。
    if (action === 'futures-rollback') return { action }
    if (action === 'futures-mode') {
      const mode = FUTURES_MODES.includes(raw.mode) ? raw.mode : null
      return mode === null ? null : { action, mode }
    }
    // 1.10.0：切自己的档位（房主关市时才不给切）。
    if (action === 'futures-account-mode') {
      const accountMode = FUTURES_ACCOUNT_MODES.includes(raw.accountMode) ? raw.accountMode : null
      return accountMode === null ? null : { action, accountMode }
    }
    // 1.12.0：暂停 / 继续自己的账（只认布尔，缺字段按「继续」）。
    if (action === 'futures-pause') {
      return typeof raw.paused === 'boolean' ? { action, paused: raw.paused } : null
    }
    if (action === 'futures-deposit' || action === 'futures-withdraw') {
      const coins = strictBoardInt(raw.coins, 1, MAX_FARM_COINS)
      return coins === null ? null : { action, coins }
    }
    if (action === 'futures-close') {
      const positionId = normalizeUuid(raw.positionId)
      return positionId === null ? null : { action, positionId }
    }
    if (action === 'futures-cancel') {
      const orderId = normalizeUuid(raw.orderId)
      return orderId === null ? null : { action, orderId }
    }
    if (action === 'futures-place') {
      const side = BOARD_SIDES.includes(raw.side) ? raw.side : null
      const lots = strictBoardInt(raw.lots, 1, 100000)
      const leverage = FUTURES_LEVERAGES.includes(raw.leverage) ? raw.leverage : null
      const cropId = normalizeBoardCropId(raw.cropId)
      if (side === null || lots === null || leverage === null || cropId === null) return null
      // 限价按分记（价格原生的两位小数），不接受 0、负数、NaN 和超大数。
      const price = Number(raw.price)
      if (!Number.isFinite(price) || price <= 0 || price > FUTURES_MAX_MARGIN) return null
      return { action, side, lots, leverage, cropId, price: Math.round(price * 100) / 100 }
    }
    if (action === 'futures-convert') {
      const positionId = normalizeUuid(raw.positionId)
      const lots = strictBoardInt(raw.lots, 1, 100000)
      if (positionId === null || lots === null) return null
      return { action, positionId, lots }
    }
    // 票 109：一次把持仓全部转成现货。窗口只报「哪几笔、各多少张」，价格与钱都由宿主算。
    if (action === 'futures-convert-all') {
      const list = Array.isArray(raw.positions) ? raw.positions : null
      if (list === null || list.length === 0 || list.length > 8) return null
      const positions = []
      for (const item of list) {
        const id = normalizeUuid(item?.id)
        const lots = strictBoardInt(item?.lots, 1, 100000)
        if (id === null || lots === null) return null
        positions.push({ id, lots })
      }
      return { action, positions }
    }
    const side = BOARD_SIDES.includes(raw.side) ? raw.side : null
    const margin = strictBoardInt(raw.margin, 1, FUTURES_MAX_MARGIN)
    const leverage = FUTURES_LEVERAGES.includes(raw.leverage) ? raw.leverage : null
    const cropId = normalizeBoardCropId(raw.cropId)
    if (side === null || margin === null || leverage === null || cropId === null) return null
    return { action, side, margin, leverage, cropId }
  }

  /** 特产 SVG 只允许 `souvenirs/<小写 id>.svg`：坏路径一律当缺图，窗口回退 emoji。 */
  function normalizeSouvenirArt (value) {
    const text = normalizeLabel(value, '')
    return /^souvenirs\/[a-z0-9-]+\.svg$/.test(text) ? text : ''
  }

  /**
   * 图鉴的 32 格视图（票 114）：宿主已经把目录展开好，这里只做白名单清洗。
   * 顺序原样保留，所以窗口画出来始终是 4 条路线 × 8 件的固定位置。
   */
  function normalizeExpeditionCodexView (raw) {
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const slots = Array.isArray(source.slots)
      ? source.slots
        .slice(0, 32)
        .filter((slot) => slot !== null && typeof slot === 'object' && !Array.isArray(slot))
        .map((slot) => {
          const id = normalizeLabel(slot.id, '')
          if (id === '') return null
          const firstSeenAt = typeof slot.firstSeenAt === 'number' && Number.isFinite(slot.firstSeenAt) ? slot.firstSeenAt : null
          const owned = firstSeenAt !== null
          const name = normalizeLabel(slot.name, '')
          return {
            id,
            name,
            emoji: normalizeLabel(slot.emoji, ''),
            rarity: normalizeLabel(slot.rarity, ''),
            rarityLabel: normalizeLabel(slot.rarityLabel, ''),
            routeId: normalizeLabel(slot.routeId, ''),
            routeName: normalizeLabel(slot.routeName, ''),
            owned,
            firstSeenAt,
            art: normalizeSouvenirArt(slot.art),
            label: owned ? normalizeLabel(slot.label, name) : '???'
          }
        })
        .filter((slot) => slot !== null)
      : []
    return {
      total: slots.length,
      owned: slots.filter((slot) => slot.owned).length,
      slots
    }
  }

  /**
   * 出远门整份视图（票 112）：`/state.expedition` 与小窗推的是同一份。
   * 坏字段一律降级——窗口宁可画「还没出门」，也不要因为一个 undefined 白屏。
   */
  function normalizeExpeditionView (raw) {
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    /** 数字归一：坏值按 0，负数按 0（段数/回币/盘缠都不该为负）。 */
    const num = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
    const nonNegative = (value) => {
      const result = num(value, 0)
      return result < 0 ? 0 : result
    }
    let run = null
    if (source.run !== null && typeof source.run === 'object' && !Array.isArray(source.run)) {
      const phase = EXPEDITION_PHASES.includes(source.run.phase) ? source.run.phase : null
      const ended = EXPEDITION_ENDED.includes(source.run.ended) ? source.run.ended : null
      const loot = Array.isArray(source.run.loot)
        ? source.run.loot
          .slice(0, 32)
          .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
          .map((item) => {
            if (item.kind === 'souvenir') {
              const id = normalizeLabel(item.id, '')
              return id === '' ? null : { kind: 'souvenir', id }
            }
            return { kind: 'coin', qty: nonNegative(item.qty) }
          })
          .filter((item) => item !== null)
        : []
      const id = normalizeLabel(source.run.id, '')
      const routeId = normalizeLabel(source.run.routeId, '')
      if (id !== '' && routeId !== '') {
        run = {
          id,
          routeId,
          routeName: normalizeLabel(source.run.routeName, ''),
          phase,
          leg: nonNegative(source.run.leg),
          totalLegs: nonNegative(source.run.totalLegs),
          until: num(source.run.until, 0),
          loot,
          startedAt: num(source.run.startedAt, 0),
          ended,
          endedAt: num(source.run.endedAt, 0),
          danger: normalizeLabel(source.run.danger, '')
        }
      }
    }
    const routes = Array.isArray(source.routes)
      ? source.routes
        .slice(0, 8)
        .filter((route) => route !== null && typeof route === 'object' && !Array.isArray(route))
        .map((route) => ({
          id: normalizeLabel(route.id, ''),
          name: normalizeLabel(route.name, ''),
          fare: nonNegative(route.fare),
          minLegs: nonNegative(route.minLegs),
          maxLegs: nonNegative(route.maxLegs),
          coinBase: nonNegative(route.coinBase)
        }))
        .filter((route) => route.id !== '')
      : []
    const codex = {}
    if (source.codex !== null && typeof source.codex === 'object' && !Array.isArray(source.codex)) {
      for (const [id, firstSeenAt] of Object.entries(source.codex).slice(0, 64)) {
        const key = normalizeLabel(id, '')
        if (key !== '' && typeof firstSeenAt === 'number' && Number.isFinite(firstSeenAt)) codex[key] = firstSeenAt
      }
    }
    return {
      ready: source.ready === true,
      version: nonNegative(source.version),
      run,
      coins: nonNegative(source.coins),
      now: num(source.now, 0),
      away: ['visiting', 'working', 'expedition'].includes(source.away) ? source.away : null,
      routes,
      // 112 不画提灯，但形状留着：118 加窗口时不用再改协议。
      shelf: normalizeExpeditionShelf(source.shelf),
      codex,
      codexView: normalizeExpeditionCodexView(source.codexView),
      upgrades: { lantern: source.upgrades?.lantern === true }
    }
  }

  /**
   * 陈列架（票 115）：`items[i]` 对第 i+1 格。窗口只读，不在这里判「能不能开」；
   * 但坏 id、重复件与超长数组必须先清掉，免得渲染端画出两个同样的特产。
   */
  function normalizeExpeditionShelf (raw) {
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const slots = Number.isInteger(source.slots) && source.slots >= 8 && source.slots <= EXPEDITION_SHELF_MAX
      ? source.slots
      : 8
    const items = []
    if (Array.isArray(source.items)) {
      const seen = new Set()
      for (const entry of source.items.slice(0, slots)) {
        const id = typeof entry === 'string' ? entry.trim() : ''
        if (!/^[a-z0-9-]+$/.test(id) || seen.has(id)) {
          items.push(null)
          continue
        }
        seen.add(id)
        items.push(id)
      }
      while (items.length > 0 && items[items.length - 1] === null) items.pop()
    }
    return {
      slots,
      unlocked: slots,
      maxSlots: EXPEDITION_SHELF_MAX,
      slotPrice: typeof source.slotPrice === 'number' && Number.isFinite(source.slotPrice) && source.slotPrice > 0
        ? Math.round(source.slotPrice)
        : EXPEDITION_SHELF_PRICE,
      items
    }
  }

  /** `expedition-window` 命令：与期货同形——开/聚焦、刷新、`close:true` 关窗。 */
  function normalizeExpeditionWindow (raw) {
    return {
      open: raw.open === true,
      ...(raw.close === true ? { close: true } : {}),
      state: normalizeExpeditionView(raw.state)
    }
  }

  /** 陈列架动作的合法格号：1..32。 */
  function normalizeShelfSlot (value) {
    return Number.isInteger(value) && value >= 1 && value <= EXPEDITION_SHELF_MAX ? value : null
  }

  /**
   * 出远门小窗提交的白名单：只认五个动作，`start` 必须带路线 id。
   * `expedition-shelf` 的字段在这里逐一拷贝——落到 helper 的农场窄口会被整条削掉。
   */
  function normalizeExpeditionAction (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : ''
    if (!EXPEDITION_SUBMIT_ACTIONS.includes(action)) return null
    if (action === 'expedition-shelf') {
      const out = { action }
      let touched = false
      if (raw.slot !== undefined && raw.slot !== null) {
        const slot = normalizeShelfSlot(raw.slot)
        if (slot === null) return null
        out.slot = slot
        touched = true
      }
      if (raw.itemId !== undefined && raw.itemId !== null) {
        const itemId = normalizeLabel(raw.itemId, '')
        if (!/^[a-z0-9-]+$/.test(itemId)) return null
        out.itemId = itemId
        touched = true
      }
      if (raw.moveFrom !== undefined && raw.moveFrom !== null) {
        const moveFrom = normalizeShelfSlot(raw.moveFrom)
        if (moveFrom === null) return null
        out.moveFrom = moveFrom
        touched = true
      }
      if (raw.moveTo !== undefined && raw.moveTo !== null) {
        const moveTo = normalizeShelfSlot(raw.moveTo)
        if (moveTo === null) return null
        out.moveTo = moveTo
        touched = true
      }
      if (!touched) return null
      const moving = out.moveFrom !== undefined || out.moveTo !== undefined
      if (moving && (out.moveFrom === undefined || out.slot !== undefined || out.itemId !== undefined)) return null
      if (out.itemId !== undefined && out.slot === undefined) return null
      return out
    }
    if (action !== 'expedition-start') return { action }
    const routeId = normalizeLabel(raw.routeId, '')
    return routeId === '' ? null : { action, routeId }
  }

  /** 农场小窗提交（`dsh-zoo:farm-submit`）的唯一白名单：坏形状整条拒绝，不半截猜测。 */  /** `farm-raid` 的可选地块：没给 = null（让主人挑），给了就必须是合法的 pN 数组。 */
  function normalizeRaidPlots (raw) {
    if (raw === undefined || raw === null) return null
    if (!Array.isArray(raw)) return false
    const out = []
    for (const entry of raw) {
      // 和主人侧同一个上限：p1–p50，`normalizePlotId` 太松（它会放 pX 过门）。
      if (typeof entry !== 'string') return false
      const plotId = entry.trim().toLowerCase()
      if (!/^p(?:[1-9]|[1-4][0-9]|50)$/.test(plotId)) return false
      if (!out.includes(plotId)) out.push(plotId)
      if (out.length > 50) return false
    }
    return out.length === 0 ? null : out
  }

  function normalizeFarmAction (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : ''
    if (!FARM_ACTIONS.includes(action)) return null
    if (FARM_EVENT_ACTIONS.includes(action) || FARM_OMEN_ACTIONS.includes(action)) {
      const expectedStart = Number(raw.expectedStart)
      if (!Number.isFinite(expectedStart) || expectedStart <= 0) return null
      if (action === 'farm-event-claim') return { action, expectedStart: Math.floor(expectedStart) }
      const choice = raw.choice === 'guard' || raw.choice === 'feed' ? raw.choice : null
      if (choice === null) return null
      const guards = raw.guards === undefined || raw.guards === null ? 0 : Number(raw.guards)
      if (!Number.isInteger(guards) || guards < 0 || guards > 2) return null
      if (choice === 'feed' && guards !== 0) return null
      return { action, choice, guards, expectedStart: Math.floor(expectedStart) }
    }
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
    // 票 52/53：看田与派它去偷。只认 UUID 与 pN 数组，其余一律不传。
    if (FARM_LOOK_ACTIONS.includes(action)) {
      const deviceId = normalizeUuid(raw.deviceId)
      if (deviceId === null) return null
      if (action === 'farm-look') return { action, deviceId }
      const plots = normalizeRaidPlots(raw.plots)
      if (plots === false) return null
      return plots === null ? { action, deviceId } : { action, deviceId, plots }
    }
    // 重推当前视图 / 切回我的农场：不带其它字段，宿主按自己记得的模式重画。
    if (action === 'farm-refresh' || action === 'farm-own') return { action }
    // 票 79：农场窗的「盘口」按钮只是开窗申请，不带字段。
    if (BOARD_OPEN_ACTIONS.includes(action)) return { action }
    // 票 93：右键「期货」与农场窗的「期货」按钮同样是开窗申请。
    if (action === 'futures-window') return { action }
    // 解锁只带可选的 expectedUnlocked；没带就让宿主直接买下一块（HTTP/脚本）。
    if (action === 'farm-unlock') {
      if (raw.expectedUnlocked === undefined || raw.expectedUnlocked === null) return { action }
      const expected = Number(raw.expectedUnlocked)
      if (!Number.isInteger(expected) || expected < MIN_FARM_PLOTS || expected > MAX_FARM_PLOTS) return null
      return { action, expectedUnlocked: expected }
    }
    const plotId = normalizePlotId(raw.plotId)
    if (plotId === null) return null
    // 偷/帮只可能是主人已解锁的地块（窗口只画这些）；这里先挡住 p51+。
    if (FARM_VISIT_ACTIONS.includes(action) && !/^p(?:[1-9]|[1-4][0-9]|50)$/.test(plotId)) return null
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
   *   recall   { enabled, mode, text, title, contractId }
   *                                       「宠物不在家」的常驻胶囊（ticket 11/57）。三种不在家都算：
   *                                       visiting（串门）/ raiding（去偷）/ working（在外打工）；
   *                                       text/title 是宿主算好的人话，contractId 只给打工
   *                                       （叫它回家 = recall-worker）
   *   visitors [{ deviceId, label }]      可以送客的访客（item id 是 visitor:<deviceId>）
   *   street   [{ deviceId, label, action, canVisit, blockedReason }]  邻居面板那一排房子（ticket 21）
   *   gifts    [{ deviceId, giftId, kind, status, title, text?, statusText? }]  贴着访客的礼物卡（ticket 23）
   *   prompt   { deviceId, nickname }     放行卡队首；null 表示没有待决定的新邻居
   *   notice   { text, at }               最近一条人话提示（异步失败也靠它冒泡）
   */
  function emptyControls () {
    return {
      visit: { enabled: false, reason: null },
      recall: { enabled: false, mode: null, text: null, title: null, contractId: null },
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
      // 不在家（ticket 57）：mode 决定按钮是「召回」还是「叫它回家」，渲染端不猜；
      // 文案由宿主算好（away-text.js），这里只守形状与长度。
      if (recall.enabled === true) {
        controls.recall.enabled = true
        controls.recall.mode = AWAY_MODES.includes(recall.mode) ? recall.mode : null
        controls.recall.text = normalizeText(recall.text, null, MAX_REASON_LENGTH)
        controls.recall.title = normalizeText(recall.title, null, MAX_REASON_LENGTH)
        controls.recall.contractId = normalizeUuid(recall.contractId)
      }
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
        const kind = candidate.kind === 'text' || candidate.kind === 'file' || candidate.kind === 'packet'
          ? candidate.kind
          : null
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
        // 红包卡（票 79）：内容只在未拆时展示；状态文字由宿主给（已拆/已退回…）。
        if (kind === 'packet') {
          const packet = normalizePacketContents(candidate.packet)
          if (packet === null) {
            seenGifts.delete(giftId)
            continue
          }
          const note = normalizePacketNote(candidate.note) ?? ''
          const expiresAt = Number(candidate.expiresAt)
          const text = normalizeText(candidate.text, '红包', MAX_LABEL_LENGTH * 3)
          controls.gifts.push({
            deviceId,
            giftId,
            kind: 'packet',
            status,
            title,
            text,
            packet,
            ...(note === '' ? {} : { note }),
            ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {}),
            ...(statusText === null ? {} : { statusText })
          })
          continue
        }
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
      const top = Number(candidate.top)
      bands.push({
        x: clampNumber(x, -MAX_COORD, MAX_COORD),
        width: clampNumber(width, 0.001, MAX_ITEM_SIZE),
        bottom: clampNumber(bottom, -MAX_COORD, MAX_COORD),
        // 票 95：带的上边界（这块屏的顶边）。扔上去撞到屏幕顶就弹回来，不会飞进没有显示器的空区。
        top: Number.isFinite(top) ? clampNumber(top, -MAX_COORD, MAX_COORD) : null
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
      .map((floor) => ({ left: floor.x, right: floor.x + floor.width, top: floor.y, bottom: floor.y + floor.height }))
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
        bands.push({ left: entry.left, right: entry.right, top: entry.top, bottom: entry.bottom })
      } else {
        band.left = Math.min(band.left, entry.left)
        band.right = Math.max(band.right, entry.right)
        band.top = Math.min(band.top, entry.top)
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
          bands[index].top = Math.min(bands[index].top, bands[other].top)
          bands.splice(other, 1)
          merged = true
          break
        }
      }
    }
    return bands.map((band) => ({ x: band.left, width: band.right - band.left, top: band.top, bottom: band.bottom }))
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
    // 票 95：撞到这块屏的顶边就弹回来。整张桌面的上边界在混合 DPI 下可能落在小屏上方
    // 没有显示器的区域，只按窗口顶夹会让宠物飞到看不见的地方。
    let y = next.y
    let vy = next.vy
    if (isFiniteNumber(band.top) && y < band.top) {
      y = band.top
      if (vy < 0) vy = -vy * PHYSICS.WALL_BOUNCE
    }
    return snapBodyToFloor({ ...next, x, vx, y, vy }, area, band.bottom)
  }

  /** 出生/松手/热插拔：把身体整体挪进一条地面带（x、y 都夹），保证它在可见的屏上。 */
  function confineBodyToBand (body, workArea, band) {
    const area = normalizeArea(workArea)
    const current = createBody(body, area)
    if (band === null || typeof band !== 'object') return current
    const x = clampNumber(current.x, band.x, Math.max(band.x, band.x + band.width - current.width))
    // 票 95：高度也夹到这块屏的顶边，扔到屏幕上方空区的宠物落回来时不会悬在那里。
    const y = isFiniteNumber(band.top) ? Math.max(current.y, band.top) : current.y
    return snapBodyToFloor({ ...current, x, y }, area, band.bottom)
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
   * 渲染端上报的「可信输入」（ipc `dsh-zoo:input`，ticket 30 / 76）。
   *
   * 现场出现过「窗口显示可交互、右键能开菜单，真实左键却进不了渲染端」。`ignoring=false`
   * 只说明我们把 `WS_EX_TRANSPARENT` 摘了，`busy=false` 只说明租约没立起来——中间没有任何
   * 东西能证明「点击真的到过渲染端」。这个计数器就是那个东西：只有 `isTrusted` 的按下才报。
   *
   * `lost-down` 不是计数（票 76）：渲染端收到 `pointerup` 却从没收到对应的
   * `pointerdown` —— 左键在窗口/系统层被吞掉的现场信号。主进程据此重放一次
   * 「穿透 → 可交互」，不重启 helper 也能把卡住的输入态解开。
   *
   * @param {unknown} raw
   * @returns {{type:'down'|'up'|'lost-down'}|null}
   */
  function normalizeInputReport (raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (raw.type !== 'down' && raw.type !== 'up' && raw.type !== 'lost-down') return null
    return { type: raw.type }
  }

  /**
   * HWND 层收到的鼠标消息计数（票 76，只有 Windows 会填）。
   *
   * 为什么还要这一层：DOM 侧的 `pointerdown` 说明「Chromium 把事件派发到了页面」，
   * 但「OS 到底有没有把左键消息投给这个窗口」只能看 WndProc。两个数一起看才能分开
   * 「窗口没拿到」和「拿到了但 Chromium 吞了」。
   *
   * @param {unknown} raw
   * @returns {{leftDown:number,leftUp:number,rightDown:number,rightUp:number}}
   */
  function normalizeWindowMessages (raw) {
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0)
    return {
      leftDown: count(source.leftDown),
      leftUp: count(source.leftUp),
      rightDown: count(source.rightDown),
      rightUp: count(source.rightUp)
    }
  }

  /** 编码一行；超长返回 null，调用方必须放弃发送（而不是把管道写坏）。 */
  function encodeMessage (message) {
    const encoded = encodeMessageDetail(message)
    return encoded.ok === true ? encoded.line : null
  }

  /**
   * 一行 JSON 的 UTF-8 字节数。渲染页里没有 `Buffer`，而诊断要说「多少 KiB」；
   * 只在编码失败时算一次，不在每帧的热路径上。
   */
  function utf8ByteLength (text) {
    let bytes = 0
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code < 0x80) bytes += 1
      else if (code < 0x800) bytes += 2
      else if (code >= 0xd800 && code <= 0xdbff) {
        // 代理对 = 4 字节；落单的代理只在坏字符串里出现，按 3 字节算，不抛。
        bytes += 4
        index += 1
      } else bytes += 3
    }
    return bytes
  }

  /**
   * 编码一行并说明结果（票 90）：宿主要能分清「数据太大」和「形状/白名单被拒」，
   * 才能留一条带尺寸的诊断，而不是把健康的桌面层误报成没在运行。
   *
   * 成功 `{ ok:true, line, bytes }`；失败 `{ ok:false, reason, bytes, limit }`，
   * reason 是 `not-object` / `bad-json` / `size`。`MAX_LINE_LENGTH` 仍按**字符数**判
   * （老口径不改），`bytes` 只是给人看的 UTF-8 尺寸。
   */
  function encodeMessageDetail (message) {
    if (message === null || typeof message !== 'object') {
      return { ok: false, reason: 'not-object', bytes: 0, limit: MAX_LINE_LENGTH }
    }
    let line
    try {
      line = JSON.stringify(message)
    } catch {
      return { ok: false, reason: 'bad-json', bytes: 0, limit: MAX_LINE_LENGTH }
    }
    if (typeof line !== 'string') {
      return { ok: false, reason: 'bad-json', bytes: 0, limit: MAX_LINE_LENGTH }
    }
    const bytes = utf8ByteLength(line + '\n')
    if (line.length > MAX_LINE_LENGTH) {
      return { ok: false, reason: 'size', bytes, limit: MAX_LINE_LENGTH }
    }
    return { ok: true, line: line + '\n', bytes }
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
        const command = {
          type,
          id,
          ok: raw.ok === true,
          notice: normalizeText(raw.notice, null, MAX_NOTICE_LENGTH),
          error: normalizeLabel(raw.error, null)
        }
        // 票 90：盘口按需拉图的回执要带图（`trading-charts`）。只有动作名、作物与图
        // 都过得了盘口白名单才带上——半截图会让窗口一直停在「加载中」。
        const action = normalizeLabel(raw.action, null)
        if (action !== null) command.action = action
        if (action === 'trading-charts' && raw.ok === true) {
          const crop = normalizeBoardCropId(raw.crop)
          const timeframes = normalizeBoardTimeframes(raw.timeframes)
          if (crop !== null && Object.keys(timeframes).length > 0) {
            command.crop = crop
            command.timeframes = timeframes
            const hints = normalizeBoardHints(raw.hint)
            if (Object.keys(hints).length > 0) command.hint = hints
            // 票 105：按需拉图时把这一种作物的消息面一起带回来。
            const news = normalizeBoardNews(raw.news)
            if (news.items.length > 0 || news.calendar.length > 0) command.news = news
            if (raw.flow !== null && typeof raw.flow === 'object' && !Array.isArray(raw.flow)) {
              command.flow = normalizeBoardFlow(raw.flow)
            }
          }
        }
        return { ok: true, command }
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
      /**
       * 盘口小窗（票 79）：`open:true` 打开/聚焦，`open:false` 只刷新已经开着的那扇，
       * `close:true` 才是关窗。内容和农场窗一样由宿主算好：窗口不读盘、不联网。
       */
      case 'board-window':
        return { ok: true, command: { type, id, ...normalizeBoardWindow(raw) } }
      /**
       * 期货小窗（票 93）：与盘口同形——`open:true` 打开/聚焦，`open:false` 只刷新，
       * `close:true` 才是关窗。
       */
      case 'futures-window':
        return { ok: true, command: { type, id, ...normalizeFuturesWindow(raw) } }
      /**
       * 出远门小窗（票 112）：与期货同形——`open:true` 打开/聚焦，`open:false` 刷新，
       * `close:true` 关窗。段数、回币与结算全在宿主，窗口只拿只读视图。
       */
      case 'expedition-window':
        return { ok: true, command: { type, id, ...normalizeExpeditionWindow(raw) } }
      case 'shot': {
        const path = normalizePath(raw.path)
        if (path === null) return { ok: false, error: 'bad-path' }
        // 冒烟可以点名抓小窗；主窗仍是默认目标。
        const window = raw.window === 'bring'
          ? 'bring'
          : raw.window === 'farm'
            ? 'farm'
            : raw.window === 'board'
              ? 'board'
              : raw.window === 'futures'
                ? 'futures'
                : raw.window === 'expedition'
                  ? 'expedition'
                  : null
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
        const window = raw.window === 'bring'
          ? 'bring'
          : raw.window === 'farm'
            ? 'farm'
            : raw.window === 'board'
              ? 'board'
              : 'rename'
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
        // 冒烟用（ticket 47/49）：点「一键种满 / 一键收割」，验批量队列真的发动作。
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
      case 'debug-farm-season':
        // 冒烟用：读来客卡的状态（有没有下拉框/按钮、结论那句话）。
        return { ok: true, command: { type, id } }
      case 'debug-farm-spark':
        // 冒烟用：真发一次 mouseenter，读成交价曲线的悬停气泡。
        return {
          ok: true,
          command: {
            type,
            id,
            index: Math.max(-1, Math.min(9, Math.floor(Number(raw.index) || 0)))
          }
        }
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
      // 票 76：丢 down 的次数与自愈重放次数；窗口层与 native 层各自一份计数，现场能分开读。
      lostDowns: Number.isInteger(raw.lostDowns) && raw.lostDowns >= 0 ? raw.lostDowns : 0,
      lastLostDownAgeMs: isFiniteNumber(raw.lastLostDownAgeMs) && raw.lastLostDownAgeMs >= 0
        ? raw.lastLostDownAgeMs
        : null,
      reasserts: Number.isInteger(raw.reasserts) && raw.reasserts >= 0 ? raw.reasserts : 0,
      windowMessages: normalizeWindowMessages(raw.windowMessages),
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
      // 票 79：盘口小窗同样分「开着 / 看得见 / 拿到焦点」。
      boardOpen: raw.boardOpen === true,
      boardVisible: raw.boardVisible === true,
      boardFocused: raw.boardFocused === true,
      // 票 93：期货小窗同一套三个数。
      futuresOpen: raw.futuresOpen === true,
      futuresVisible: raw.futuresVisible === true,
      futuresFocused: raw.futuresFocused === true,
      alwaysOnTop: raw.alwaysOnTop === true,
      allWorkspaces: raw.allWorkspaces === true,
      bounds,
      pointer,
      // 票 93：这次命中判定用的是谁的坐标（渲染端 CSS 指针 / OS 光标），以及渲染端那一路的原值。
      // 混合 DPI 现场只靠 `pointer` 一个数是看不出「差在哪一侧」的。
      pointerSource: raw.pointerSource === 'renderer' || raw.pointerSource === 'os' ? raw.pointerSource : null,
      hoverPoint: normalizePoint(raw.hoverPoint),
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
            // 票 94：混合 DPI 时 helper 已经把「每块屏在窗口 CSS 坐标里的矩形」算好；
            // 宿主优先用这份，缺了才按 DIP 现算。
            floors: normalizeFloors(raw.floors),
            homeArea: normalizeRect(raw.homeArea),
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
          for (const candidate of raw.plots.slice(0, 50)) {
            if (candidate === null || typeof candidate !== 'object') continue
            plots.push({
              id: normalizeToken(candidate.id),
              stage: normalizeLabel(candidate.stage, ''),
              text: normalizeLabel(candidate.text, ''),
              // ticket 49：锁定卡没有 plotId，用 locked + badge 让冒烟能断言。
              locked: candidate.locked === true,
              badge: normalizeLabel(candidate.badge, '')
            })
          }
        }
        return { ok: true, event: { type, id, plots } }
      }
      case 'farm-season': {
        // 冒烟用：来客卡处理后只剩结论，下拉框/按钮数量应为 0。
        return {
          ok: true,
          event: {
            type,
            id,
            hidden: raw.hidden === true,
            done: normalizeText(raw.done, '', 80),
            selects: Math.max(0, Math.floor(Number(raw.selects) || 0)),
            buttons: Math.max(0, Math.floor(Number(raw.buttons) || 0))
          }
        }
      }
      case 'farm-spark': {
        // 冒烟用：成交价曲线的悬停结果（气泡文本/是否显示/是否贴着点）。
        return {
          ok: true,
          event: {
            type,
            id,
            dots: Math.max(0, Math.floor(Number(raw.dots) || 0)),
            tips: Math.max(0, Math.floor(Number(raw.tips) || 0)),
            connected: raw.connected === true,
            tip: normalizeLabel(raw.tip, ''),
            show: raw.show === true,
            note: normalizeLabel(raw.note, ''),
            near: raw.near === true,
            inside: raw.inside === true
          }
        }
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
      case 'board-window-state':
        // 票 79：盘口小窗同一套语义——×/Esc 关窗后，右键「盘口」必须能重新打开。
        return { ok: true, event: { type, id, open: raw.open === true } }
      case 'futures-window-state':
        // 票 93：期货小窗同理——关窗后右键「期货」必须能重新打开。
        return { ok: true, event: { type, id, open: raw.open === true } }
      case 'expedition-window-state':
        // 票 112：出远门小窗同理——×/Esc 关窗后，右键「出远门」必须能重新打开。
        return { ok: true, event: { type, id, open: raw.open === true } }
      case 'action': {
        const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : ''
        if (!DESKTOP_ACTIONS.includes(action)) return { ok: false, error: 'bad-action' }
        if (id === null) return { ok: false, error: 'bad-id' }
        // 谁必须有对象写在 DEVICE_ACTIONS 里：main.js 和这里共用同一份，免得再漂一次。
        const needsDevice = DEVICE_ACTIONS.includes(action)
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
        // 盘口小窗（票 79–83）：这几条动作走自己的白名单。落到下面农场那一段窄口，
        // side/margin/target/orderId 会被整条削掉——窗口看起来只是「点了没反应」。
        // 这里和 `normalizeBoardAction` 是**同一份**校验，不另抄一份字段表。
        if (BOARD_SUBMIT_ACTIONS.includes(action)) {
          const normalized = normalizeBoardAction(raw)
          if (normalized === null) return { ok: false, error: 'bad-board-action' }
          return { ok: true, event: { type, id, ...normalized } }
        }
        // 期货小窗（票 93）：同一份白名单校验，落到农场窄口会把 side/margin/leverage 削掉。
        if (FUTURES_SUBMIT_ACTIONS.includes(action)) {
          const normalized = normalizeFuturesAction(raw)
          if (normalized === null) return { ok: false, error: 'bad-futures-action' }
          return { ok: true, event: { type, id, ...normalized } }
        }
        // 出远门小窗（票 112）：只认四个动作；start 的 routeId 必须过白名单。
        if (EXPEDITION_SUBMIT_ACTIONS.includes(action)) {
          const normalized = normalizeExpeditionAction(raw)
          if (normalized === null) return { ok: false, error: 'bad-expedition-action' }
          return { ok: true, event: { type, id, ...normalized } }
        }
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
        // 节日领奖 / 秋天来客（票 70）：helper 回到宿主的这一跳也要保留
        // expectedStart 和 choice。这里曾按普通农场动作落到下面的窄口，
        // 两个字段被整条丢掉，宿主只剩一句 bad-choice。
        if (FARM_EVENT_ACTIONS.includes(action) || FARM_OMEN_ACTIONS.includes(action)) {
          const normalized = normalizeFarmAction(raw)
          if (normalized === null) return { ok: false, error: 'bad-farm-action' }
          return {
            ok: true,
            event: {
              type,
              id,
              ...normalized,
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

  /**
   * 把「每块屏的真实物理工作区」换算成窗口 CSS 坐标里的矩形（票 94）。
   *
   * 为什么不能直接用显示器的 DIP 矩形：窗口铺满虚拟桌面时只按**一块**屏的缩放渲染，
   * 而各显示器在 DIP 空间里的位置是按各自缩放折出来的。两块屏缩放不同（125% + 150%）
   * 时，`显示器.workArea - 窗口.bounds` 推出来的矩形和渲染端真实的 CSS 区域差一截：
   * 小屏那块会整体偏到屏幕左上方，宠物走到那块「地」上就出了显示器，抓不回来。
   *
   * 这里换成物理坐标做减法：窗口自己的物理矩形（`screen.dipToScreenRect(win, bounds)`）
   * 和各屏的真实物理工作区（helper 用一次性的小窗口探出来）都在同一个物理空间里，
   * 除以窗口缩放就是 CSS 坐标。物理矩形缺失时返回空，调用方回退旧算法。
   *
   * @param {object} options
   * @param {{x:number,y:number,width:number,height:number}|null} options.windowPhysical
   * @param {number} options.windowScale 物理像素 / CSS 像素（= 物理宽 / bounds 宽）
   * @param {Array<{physicalWorkArea?:object, primary?:boolean}>} options.displays
   * @param {{x:number,y:number,width:number,height:number}|null} options.area 窗口 CSS 矩形
   * @returns {{floors:{x:number,y:number,width:number,height:number}[], homeArea:{x:number,y:number,width:number,height:number}|null}}
   */
  function floorsFromPhysical (options = {}) {
    const window = normalizeRect(options.windowPhysical)
    const scale = Number(options.windowScale)
    if (window === null || !Number.isFinite(scale) || scale <= 0) return { floors: [], homeArea: null }
    const surface = normalizeRect(options.area)
    const floors = []
    let homeArea = null
    for (const display of Array.isArray(options.displays) ? options.displays : []) {
      if (display === null || typeof display !== 'object') continue
      const physical = normalizeRect(display.physicalWorkArea)
      if (physical === null) continue
      const local = normalizeRect({
        x: (physical.x - window.x) / scale,
        y: (physical.y - window.y) / scale,
        width: physical.width / scale,
        height: physical.height / scale
      })
      if (local === null) continue
      const clipped = surface === null ? local : clipRectToArea(local, surface)
      if (clipped === null) continue
      floors.push(clipped)
      if (display.primary === true && homeArea === null) homeArea = clipped
    }
    return { floors, homeArea }
  }

  function toScreenPoint (localPoint, bounds) {
    const point = normalizePoint(localPoint)
    const area = normalizeRect(bounds)
    if (point === null || area === null) return null
    return { x: point.x + area.x, y: point.y + area.y }
  }

  /**
   * 命中判定用哪个「窗口本地坐标」（票 93）。
   *
   * 窗口铺满整张虚拟桌面时，`screen.getCursorScreenPoint()` 给的是**光标所在那块屏**的缩放折算后的
   * 屏幕坐标，而窗口自己只按**一块**屏的缩放渲染。两块屏缩放不同（例如 125% + 150%）时，
   * 「光标屏幕坐标 − 窗口 bounds」推出的本地坐标和渲染端真实的 CSS 坐标会差一截：渲染端知道
   * 光标就在宠物身上，主进程却判定「在外面」，窗口永远停在穿透，点哪儿都掉到下层窗口。
   *
   * 所以缩放不一致时以渲染端上报的指针为准（pointermove 的 CSS 坐标，和命中矩形同一套坐标系）；
   * 缩放一致时保持原行为，主进程仍按 OS 光标独立复核，渲染端卡死时照样 fail-closed。
   * 渲染端指针过期、越界、形状不对一律不用，退回 OS 光标。
   *
   * @param {object} [options]
   * @param {{x:number,y:number}|null} [options.osPoint] OS 光标换算出的窗口本地坐标
   * @param {{x:number,y:number}|null} [options.rendererPoint] 渲染端上报的本地指针（CSS 坐标）
   * @param {number} [options.rendererAt] 渲染端上报时刻（毫秒时间戳）
   * @param {number} [options.now] 当前时刻，测试可注入
   * @param {number} [options.maxAgeMs] 渲染端指针的保鲜期
   * @param {boolean} [options.preferRenderer] 是否优先采信渲染端指针（混合 DPI 时为真）
   * @param {{x:number,y:number,width:number,height:number}|null} [options.area] 窗口本地矩形，越界即弃
   * @returns {{point:{x:number,y:number}|null, source:'renderer'|'os'|null}}
   */
  function chooseLocalPoint (options = {}) {
    const now = isFiniteNumber(options.now) ? options.now : Date.now()
    const maxAge = isFiniteNumber(options.maxAgeMs) && options.maxAgeMs >= 0
      ? options.maxAgeMs
      : HOVER_POINT_MAX_AGE_MS
    const os = normalizePoint(options.osPoint)
    const renderer = freshLocalPoint(options.rendererPoint, options.rendererAt, now, maxAge, options.area)
    if (options.preferRenderer === true && renderer !== null) return { point: renderer, source: 'renderer' }
    if (os !== null) return { point: os, source: 'os' }
    if (renderer !== null) return { point: renderer, source: 'renderer' }
    return { point: null, source: null }
  }

  /** 渲染端上报的本地指针：要新鲜、要落在窗口里；任一条不满足就当没有。 */
  function freshLocalPoint (raw, at, now, maxAgeMs, area) {
    const point = normalizePoint(raw)
    if (point === null) return null
    const stamp = Number(at)
    if (!Number.isFinite(stamp) || stamp <= 0) return null
    const age = now - stamp
    if (!(age >= 0) || age > maxAgeMs) return null
    const rect = normalizeRect(area)
    if (rect !== null) {
      if (point.x < rect.x || point.y < rect.y) return null
      if (point.x > rect.x + rect.width || point.y > rect.y + rect.height) return null
    }
    return point
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

  /**
   * 「可交互」要不要再向 native 层重放一次（票 76）。
   *
   * 只在 `ignoring === false` 时重放：穿透态本来就是「什么都不接」，重放没有意义。
   * `lastAt === 0`（还没重放过）时第一拍就重放——把「刚翻成可交互」也压实一次。
   * 时钟回拨（`now < lastAt`）按到点处理，宁可多重放一次也不要把窗口卡在假可交互。
   *
   * @param {{ignoring?:boolean, now?:number, lastAt?:number, intervalMs?:number}} options
   * @returns {boolean}
   */
  function shouldReassert (options = {}) {
    if (options.ignoring !== false) return false
    if (!Number.isFinite(options.now)) return false
    const interval = Number.isFinite(options.intervalMs) && options.intervalMs > 0
      ? options.intervalMs
      : INTERACTIVE_REASSERT_MS
    const lastAt = Number.isFinite(options.lastAt) && options.lastAt > 0 ? options.lastAt : 0
    if (lastAt === 0) return true
    return options.now - lastAt >= interval || options.now < lastAt
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
    HOVER_POINT_MAX_AGE_MS,
    POINTER_POLL_MS,
    MAIN_FALLBACK_DWELL_MS,
    RENDERER_RECT_MAX_AGE_MS,
    OVERLAY_RECT_MAX_AGE_MS,
    SCENE_RECT_FALLBACK_MS,
    BUSY_HEARTBEAT_MS,
    BUSY_LEASE_MS,
    BUSY_MAX_MS,
    INTERACTIVE_REASSERT_MS,
    LOST_DOWN_HEAL_COOLDOWN_MS,
    DEFAULT_COLOR,
    ITEM_KINDS,
    PET_ROLES,
    PET_BADGES,
    AWAY_MODES,
    SCENE_VERSION,
    CONTROL_ACTIONS,
    GIFT_ACTIONS,
    FARM_ACTIONS,
    BOARD_OPEN_ACTIONS,
    BOARD_SUBMIT_ACTIONS,
    BOARD_SIDES,
    BOARD_STOP_LEVELS,
    BOARD_MAX_LEVERAGE,
    BOARD_TIMEFRAME_IDS,
    normalizeBoardOrders,
    FARM_PLOT_ACTIONS,
    FARM_MARKET_ACTIONS,
    FARM_LAND_ACTIONS,
    FARM_LOOK_ACTIONS,
    FARM_EVENT_ACTIONS,
    FARM_OMEN_ACTIONS,
    DEVICE_ACTIONS,
    normalizeFarmLook,
    normalizeNeighborChips,
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
    MENU_TOOL_REQUESTS,
    MAX_FARM_PLOTS,
    MIN_FARM_PLOTS,
    CROP_IDS,
    CROP_BASE_PRICE,
    FARM_STAGES,
    FARM_LOG_KINDS,
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
    normalizeFarmPlot,
    normalizeFarmLogEntry,
    normalizeFarmWindow,
    normalizeBoardWindow,
    normalizeBoardView,
    normalizeBoardAction,
    normalizeFuturesAction,
    normalizeFuturesWindow,
    normalizeFuturesView,
    normalizeExpeditionAction,
    normalizeExpeditionWindow,
    normalizeExpeditionView,
    EXPEDITION_SUBMIT_ACTIONS,
    FUTURES_SUBMIT_ACTIONS,
    FUTURES_LEVERAGES,
    normalizeSeason,
    applyCropCatalog,
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
    // 宿主投影（src/desktop-pets.js）与渲染端用同一份形状判断：卡片上的红包和
    // 点「拆开」时提交的红包必须是同一种东西，否则一边认一边不认。
    normalizePacketContents,
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
    floorsFromPhysical,
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
    encodeMessageDetail,
    utf8ByteLength,
    parseLine,
    createLineParser,
    rectContains,
    hitTestRects,
    hitTestScene,
    rectsOfScene,
    unionRect,
    toLocalPoint,
    toScreenPoint,
    chooseLocalPoint,
    shouldReadStdinDirectly,
    shouldBeInteractive,
    shouldReassert,
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
