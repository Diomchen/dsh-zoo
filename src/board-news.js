/**
 * 盘口消息面（SPEC v12 / 票 104）：确定性事件表、文本模板、日程与数值阶跃。
 *
 * 这一层和 `trading-rules.js` 同一条纪律：**纯函数**，不读时钟、不碰磁盘、不联网。
 * 事件只由 `(NEWS_SALT, 作物, 市场日)` 决定；同一套代码在任何机器上得到同一张表。
 * 文本只用于展示，价格只认事件里的 `jump`/`storm` 两个数——改文案不会改图，
 * 改数值/密度才需要升 `PRICE_SALT`（见 ADR-0035）。
 *
 * 市场日固定按 UTC+8 算，不用本机时区：否则不同时区的机器会算出不同的消息表。
 * `boardPrice()` 只需要 `newsStepAt()` / `newsVolMultAt()` 两个入口，不直接读事件对象。
 */

import { CROP_IDS, CROPS } from './farm-rules.js'

export const NEWS_SALT = 'board-news-v1'
/** 市场时间固定 UTC+8；消息日程、时段、市场日都用它。 */
export const MARKET_TZ_OFFSET_MS = 8 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DAY_MINUTES = 24 * 60
/** 一条事件最多显示多少字（展示口径，不是价格口径）。 */
export const NEWS_MAX_TITLE = 28
export const NEWS_MAX_BODY = 90
/** 一个月最多缓存多少天的账本；盘口只看 24 根（1 天）到 1 周（7 天），留足余量。 */
const MAX_LEDGER_CACHE = 256
/** 每天 5 个固定日程（市场时间）：09:30 / 12:00 / 15:00 / 20:00 / 22:30。 */
export const NEWS_SCHEDULE_MINUTES = Object.freeze([570, 720, 900, 1200, 1350])
/** 事件稀有度：0 微讯 / 1 快讯 / 2 头条 / 3 黑天鹅。 */
export const NEWS_RARITY = Object.freeze({ micro: 0, flash: 1, headline: 2, blackswan: 3, storm: 1, calendar: 1, followup: 1 })
/** 行情引擎只关心这两种事件：跳价的、放大波动的。 */
const TONE_SIGNS = Object.freeze({ up: 1, down: -1, vol: 0 })

const REGIONS = Object.freeze(['青禾镇', '南坡村', '云溪农场', '柳湾乡', '望星坡'])
const PERSONS = Object.freeze(['老王', '阿黄', '李婶', '小赵', '张叔'])
const SOURCES = Object.freeze(['镇农技站', '县里的小道消息', '交易所公告', '天气台', '村口广播'])

/**
 * 内容库。每条模板只描述「哪一类消息、往哪个方向、大概多大」；
 * 具体作物/产地/数量在生成时用散列填进去，所以新作物也能复用。
 *
 * `kind` 决定稀有度与展示样式；`scope:'all'` 是全市场事件（主作物 1.0，其他作物 0.5）。
 * `mag` 是**对数价格阶跃的绝对值**（0.012 = 约 1.2%），`tone:'vol'` 时忽略。
 */
const TEMPLATES = Object.freeze([
  // ---------------------------------------------------------------- 微讯（0.1–0.4%）
  {
    id: 'micro-rain',
    kind: 'micro',
    tone: 'up',
    scope: 'crop',
    weight: 2,
    mag: [0.0015, 0.004],
    title: '连阴雨推迟采摘，{crop}到货少了一点',
    body: '收购商说今天只收到平时七成；雨停之前，价格大概会硬一点。',
    source: '村口广播'
  },
  {
    id: 'micro-truck',
    kind: 'micro',
    tone: 'down',
    scope: 'crop',
    weight: 2,
    mag: [0.0015, 0.004],
    title: '冷链车在{region}抛锚，一车{crop}晚到半天',
    body: '司机说修好要两小时；收货的人等不及，先压了压价。',
    source: '县里的小道消息'
  },
  {
    id: 'micro-trader',
    kind: 'micro',
    tone: 'up',
    scope: 'crop',
    weight: 2,
    mag: [0.0015, 0.004],
    title: '收购商在{region}转了一圈，说要加价收{crop}',
    body: '没人知道他说的是真是假，但旁边几户已经开始惜售了。',
    source: '镇农技站'
  },
  {
    id: 'micro-cat',
    kind: 'micro',
    tone: 'up',
    scope: 'crop',
    weight: 1,
    mag: [0.001, 0.003],
    title: '一只猫踩了交易所键盘，下了一笔{crop}买单',
    body: '交易所表示不承担责任；猫已被请出机房。',
    source: '交易所公告'
  },
  {
    id: 'micro-steal',
    kind: 'micro',
    tone: 'up',
    scope: 'crop',
    weight: 1,
    mag: [0.001, 0.004],
    title: '隔壁{person}半夜偷了{qty}个{crop}，盘口出现神秘买单',
    body: '失主说算了；但{crop}的买盘确实厚了一点。',
    source: '村口广播'
  },
  {
    id: 'micro-snack',
    kind: 'micro',
    tone: 'up',
    scope: 'crop',
    weight: 2,
    mag: [0.0015, 0.004],
    title: '小卖部新出{crop}饼，排队的人不少',
    body: '老板说一天能卖两锅；原料采购量跟着涨了一点。',
    source: '村口广播'
  },
  {
    id: 'micro-bus',
    kind: 'micro',
    tone: 'down',
    scope: 'crop',
    weight: 1,
    mag: [0.0015, 0.004],
    title: '进城的班车坏了，{crop}今天没人收',
    body: '几户人家把货又拉了回去；路边堆着一筐一筐的。',
    source: '县里的小道消息'
  },
  {
    id: 'micro-frost',
    kind: 'micro',
    tone: 'down',
    scope: 'crop',
    weight: 2,
    mag: [0.0015, 0.004],
    title: '夜里风大，{region}两处棚膜被掀开',
    body: '早起看苗还好，但种植户心里都紧了一下。',
    source: '天气台'
  },
  {
    id: 'micro-school',
    kind: 'micro',
    tone: 'up',
    scope: 'crop',
    weight: 1,
    mag: [0.001, 0.003],
    title: '镇小学食堂加了一道{crop}汤，孩子们说好喝',
    body: '校长说下周还做；食堂采购单上多了一行。',
    source: '村口广播'
  },
  {
    id: 'micro-rumor',
    kind: 'micro',
    tone: 'down',
    scope: 'crop',
    weight: 1,
    mag: [0.0015, 0.004],
    title: '有人说外地{crop}要降价，谁也拿不出截图',
    body: '消息在群里转了两圈；收货的人趁机把价往下压了压。',
    source: '县里的小道消息'
  },

  // ---------------------------------------------------------------- 快讯（0.4–1.2%）
  {
    id: 'flash-rain',
    kind: 'flash',
    tone: 'up',
    scope: 'crop',
    weight: 2,
    mag: [0.005, 0.011],
    title: '连阴雨，{crop}采摘推迟三天',
    body: '镇农技站说烂根的风险不大，但短期到货肯定少。',
    source: '天气台'
  },
  {
    id: 'flash-pest',
    kind: 'flash',
    tone: 'down',
    scope: 'crop',
    weight: 2,
    mag: [0.005, 0.012],
    title: '蚜虫冒头，{region}三成大棚中招',
    body: '农技站发了药，但这一茬的卖相已经受影响。',
    source: '镇农技站'
  },
  {
    id: 'flash-export',
    kind: 'flash',
    tone: 'down',
    scope: 'crop',
    weight: 2,
    mag: [0.006, 0.013],
    title: '出口配额收紧，收购商开始压价',
    body: '做外贸的几家都在观望；本地{crop}的收购价先软了。',
    source: '交易所公告'
  },
  {
    id: 'flash-subsidy',
    kind: 'flash',
    tone: 'up',
    scope: 'crop',
    weight: 1,
    mag: [0.005, 0.011],
    title: '农业补贴到账，种植户开始惜售',
    body: '手里有钱就不急着卖；收不上货的人只能加价。',
    source: '镇农技站'
  },
  {
    id: 'flash-chef',
    kind: 'flash',
    tone: 'up',
    scope: 'crop',
    weight: 2,
    mag: [0.006, 0.013],
    title: '网红店「{crop}炒蛋」卖断货',
    body: '老板说一天用掉八百斤；二道贩子开始加价收货。',
    source: '村口广播'
  },
  {
    id: 'flash-road',
    kind: 'flash',
    tone: 'up',
    scope: 'crop',
    weight: 1,
    mag: [0.004, 0.010],
    title: '高速封路，冷链车改走山路，运费涨三成',
    body: '到货时间推迟；远一点的客户开始提前下单。',
    source: '县里的小道消息'
  },
  {
    id: 'flash-lab',
    kind: 'flash',
    tone: 'down',
    scope: 'crop',
    weight: 1,
    mag: [0.004, 0.010],
    title: '农科院发布抗病新品种，可惜明年才能种',
    body: '远水解不了近渴；今天的{crop}盘面先跌为敬。',
    source: '镇农技站'
  },
  {
    id: 'flash-cold',
    kind: 'flash',
    tone: 'up',
    scope: 'crop',
    weight: 2,
    mag: [0.005, 0.012],
    title: '寒潮预警，{crop}产区连夜盖膜',
    body: '种植户说能保多少保多少；短期供应还是会紧。',
    source: '天气台'
  },
  {
    id: 'flash-festival',
    kind: 'flash',
    tone: 'up',
    scope: 'crop',
    weight: 1,
    mag: [0.005, 0.013],
    title: '县里要办{crop}节，采购商提前备货',
    body: '摊位还没搭好，订货电话先打爆了。',
    source: '村口广播'
  },
  {
    id: 'flash-badbatch',
    kind: 'flash',
    tone: 'down',
    scope: 'crop',
    weight: 1,
    mag: [0.006, 0.014],
    title: '一批{crop}检出农残，市场暂停收货',
    body: '涉事的三户已经复检；别的种植户也跟着被压价。',
    source: '交易所公告'
  },
  {
    id: 'flash-ufo',
    kind: 'flash',
    tone: 'up',
    scope: 'crop',
    weight: 1,
    mag: [0.003, 0.008],
    title: 'UFO 在{crop}地上空停留 3 分钟，村民拍到了模糊视频',
    body: '专家说大概率是无人机；但今晚的{crop}确实多卖了几筐。',
    source: '县里的小道消息'
  },

  // ---------------------------------------------------------------- 头条（1.2–2.5%）
  {
    id: 'headline-frost',
    kind: 'headline',
    tone: 'up',
    scope: 'crop',
    weight: 2,
    mag: [0.013, 0.022],
    followUp: true,
    title: '霜冻蓝色预警：{crop}产区今夜最低 −3℃',
    body: '镇农技站建议抢早收；收购商已经开始加价。',
    source: '天气台'
  },
  {
    id: 'headline-pest',
    kind: 'headline',
    tone: 'down',
    scope: 'crop',
    weight: 2,
    mag: [0.013, 0.024],
    title: '蚜虫爆发，{region}三成大棚中招',
    body: '农技站说这一茬的产量要下调；收购商压价压得很直接。',
    source: '镇农技站'
  },
  {
    id: 'headline-export',
    kind: 'headline',
    tone: 'down',
    scope: 'crop',
    weight: 2,
    mag: [0.014, 0.025],
    followUp: true,
    title: '出口配额收紧，收购商开始压价',
    body: '做外贸的几家已经停了收货；本地{crop}的报价一上午改了三回。',
    source: '交易所公告'
  },
  {
    id: 'headline-chef',
    kind: 'headline',
    tone: 'up',
    scope: 'crop',
    weight: 2,
    mag: [0.012, 0.022],
    title: '网红店「{crop}炒蛋」卖断货，一天用掉 800 斤',
    body: '老板说下周还要加量；二道贩子已经守在村口。',
    source: '村口广播'
  },
  {
    id: 'headline-fire',
    kind: 'headline',
    tone: 'down',
    scope: 'crop',
    weight: 1,
    mag: [0.015, 0.025],
    title: '冷库起火，三车{crop}熏坏',
    body: '消防说没有人员伤亡；但这一批货全完了，赔付还要扯皮。',
    source: '县里的小道消息'
  },
  {
    id: 'headline-festival',
    kind: 'headline',
    tone: 'up',
    scope: 'crop',
    weight: 1,
    mag: [0.012, 0.022],
    title: '镇里宣布明天办{crop}节，预计游客两万人',
    body: '摊位费和采购量一起涨；小贩们已经开始囤货。',
    source: '村口广播'
  },
  {
    id: 'headline-liquidate',
    kind: 'headline',
    tone: 'down',
    scope: 'crop',
    weight: 1,
    mag: [0.010, 0.020],
    title: '某大户 5× 被强平，强平单砸穿买盘',
    body: '盘口一瞬间少了两档买价；旁边的人说“看着都疼”。',
    source: '交易所公告'
  },
  {
    id: 'headline-ban',
    kind: 'headline',
    tone: 'down',
    scope: 'crop',
    weight: 1,
    mag: [0.014, 0.024],
    title: '外地检出病害，本镇{crop}暂停外运',
    body: '检疫站在路口设了卡；货车排了半里地。',
    source: '交易所公告'
  },
  {
    id: 'headline-award',
    kind: 'headline',
    tone: 'up',
    scope: 'crop',
    weight: 1,
    mag: [0.010, 0.020],
    title: '{crop}拿了农博会金奖，订单排到下月',
    body: '合作社说先保老客户；新客户只能排队。',
    source: '村口广播'
  },
  {
    id: 'headline-typhoon',
    kind: 'headline',
    tone: 'up',
    scope: 'crop',
    weight: 1,
    mag: [0.015, 0.025],
    title: '台风外围扫过{region}，{crop}大棚成片倒伏',
    body: '镇里在统计损失；收购商已经开始抢剩下的货。',
    source: '天气台'
  },

  // ---------------------------------------------------------------- 黑天鹅（3–6%）
  {
    id: 'blackswan-coldwave',
    kind: 'blackswan',
    tone: 'up',
    scope: 'crop',
    weight: 1,
    mag: [0.032, 0.052],
    storm: [1.5, 1.9],
    duration: [40, 90],
    title: '十年最冷寒潮，{crop}产区大面积冻伤',
    body: '镇里连夜调膜、生火；能救回多少还没人敢说。',
    source: '天气台'
  },
  {
    id: 'blackswan-disease',
    kind: 'blackswan',
    tone: 'down',
    scope: 'crop',
    weight: 1,
    mag: [0.032, 0.055],
    storm: [1.5, 1.9],
    duration: [40, 90],
    title: '不明病害蔓延，{crop}主产区封棚',
    body: '农技站封了三个村；外面的车一律不准进。',
    source: '镇农技站'
  },
  {
    id: 'blackswan-buyer',
    kind: 'blackswan',
    tone: 'up',
    scope: 'crop',
    weight: 1,
    mag: [0.030, 0.050],
    storm: [1.4, 1.7],
    duration: [30, 60],
    title: '连锁超市包下全镇{crop}，价格直接翻倍',
    body: '合同签到明年；小收购商当场傻眼。',
    source: '交易所公告'
  },
  {
    id: 'blackswan-ban',
    kind: 'blackswan',
    tone: 'down',
    scope: 'crop',
    weight: 1,
    mag: [0.032, 0.055],
    storm: [1.4, 1.8],
    duration: [40, 80],
    title: '出口全面禁令，{crop}堆在码头没人要',
    body: '冷库爆满；有人开始把货往饲料厂送。',
    source: '交易所公告'
  },
  {
    id: 'blackswan-meteor',
    kind: 'blackswan',
    tone: 'up',
    scope: 'crop',
    weight: 1,
    mag: [0.030, 0.050],
    storm: [1.5, 2.0],
    duration: [30, 60],
    title: '陨石落在{region}的{crop}地，砸出一个大坑',
    body: '专家说样本很值钱；但这一季的收成肯定没了。',
    source: '县里的小道消息'
  },

  // ---------------------------------------------------------------- 风暴（只放大波动，不改方向）
  {
    id: 'storm-maintenance',
    kind: 'storm',
    tone: 'vol',
    scope: 'crop',
    weight: 2,
    mag: [0, 0],
    storm: [1.6, 2.2],
    duration: [15, 45],
    title: '交易所系统维护，{crop}盘口波动可能放大',
    body: '挂单和撤单都会慢半拍；别在插针的时候追。',
    source: '交易所公告'
  },
  {
    id: 'storm-rumor',
    kind: 'storm',
    tone: 'vol',
    scope: 'crop',
    weight: 2,
    mag: [0, 0],
    storm: [1.6, 2.2],
    duration: [20, 50],
    title: '市场传闻四起，谁也说不清{crop}明天什么价',
    body: '群里每隔十分钟就换一个说法；先别急着下重手。',
    source: '县里的小道消息'
  },
  {
    id: 'storm-ufo',
    kind: 'storm',
    tone: 'vol',
    scope: 'crop',
    weight: 1,
    mag: [0, 0],
    storm: [1.5, 2.0],
    duration: [15, 35],
    title: 'UFO 在{crop}地上空盘旋，村里人全出来看',
    body: '没人知道那是什么；交易的人也变得神经兮兮。',
    source: '村口广播'
  },

  // ---------------------------------------------------------------- 全市场（主作物 1.0，其他作物 0.5）
  {
    id: 'global-rain',
    kind: 'headline',
    tone: 'up',
    scope: 'all',
    weight: 2,
    mag: [0.010, 0.020],
    title: '全镇暴雨，{crop}产区受灾最重',
    body: '排水沟全满了；别的作物也跟着紧张，收货车进不来。',
    source: '天气台'
  },
  {
    id: 'global-coin',
    kind: 'flash',
    tone: 'down',
    scope: 'all',
    weight: 2,
    mag: [0.006, 0.014],
    title: '硬币流动性收紧，收购商都没现金',
    body: '好几种作物同时被压价；谁手里有现金谁说了算。',
    source: '交易所公告'
  },
  {
    id: 'global-festival',
    kind: 'headline',
    tone: 'up',
    scope: 'all',
    weight: 1,
    mag: [0.010, 0.018],
    title: '镇上办丰收节，所有作物采购量一起涨',
    body: '摊位从街头摆到街尾；连平时没人要的尾货都卖掉了。',
    source: '村口广播'
  },
  {
    id: 'global-cold',
    kind: 'headline',
    tone: 'down',
    scope: 'all',
    weight: 1,
    mag: [0.010, 0.020],
    title: '寒潮过境，全镇大棚受损',
    body: '几个村的棚膜都被掀了；镇里在发应急补贴。',
    source: '天气台'
  },
  {
    id: 'global-ufo',
    kind: 'storm',
    tone: 'vol',
    scope: 'all',
    weight: 1,
    mag: [0, 0],
    storm: [1.5, 2.0],
    duration: [20, 45],
    title: '不明飞行物在镇上空盘旋，所有盘口都在抖',
    body: '有人说是无人机，有人说是外星人；交易量突然大了。',
    source: '县里的小道消息'
  }
])

/** 日程的两张结果模板：高产 → 跌，低产 → 涨。 */
const CALENDAR_TEMPLATES = Object.freeze([
  {
    id: 'calendar-high',
    kind: 'calendar',
    tone: 'down',
    scope: 'crop',
    mag: [0.008, 0.020],
    title: '产量报告：{crop}比预期高 {pct}%，收购价应声回落',
    body: '农业部说今年雨水好；收购商当场把报价往下调。',
    source: '交易所公告'
  },
  {
    id: 'calendar-low',
    kind: 'calendar',
    tone: 'up',
    scope: 'crop',
    mag: [0.008, 0.020],
    title: '产量报告：{crop}比预期低 {pct}%，收购价走高',
    body: '农业部下调了预估；手里有货的人开始惜售。',
    source: '交易所公告'
  }
])

/** 事件种类权重：微讯多、头条少、黑天鹅更少、风暴偶尔。 */
const KIND_WEIGHTS = Object.freeze([
  ['micro', 55],
  ['flash', 25],
  ['headline', 14],
  ['blackswan', 3],
  ['storm', 3]
])

const LEDGER_CACHE = new Map()
const GLOBAL_CACHE = new Map()
const CALENDAR_CACHE = new Map()

function hash32 (text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 散列到 [0,1)；和平常一样过一道雪崩，避免末位字符只差常数。 */
function unitHash (text) {
  let hash = hash32(text)
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return (hash >>> 0) / 4294967296
}

function pickWeighted (items, key) {
  const total = items.reduce((sum, item) => sum + (item.weight ?? 1), 0)
  if (total <= 0) return items[0] ?? null
  let roll = unitHash(key) * total
  for (const item of items) {
    roll -= item.weight ?? 1
    if (roll < 0) return item
  }
  return items[items.length - 1]
}

function pick (items, key) {
  if (!Array.isArray(items) || items.length === 0) return null
  return items[Math.floor(unitHash(key) * items.length) % items.length]
}

function rangeOf (range, key) {
  const [min, max] = Array.isArray(range) ? range : [0, 0]
  return min + unitHash(key) * (max - min)
}

/** 标题/正文按**码点**截断，超长补省略号；模板本身都在限内，这里是防动态作物名太长。 */
function truncate (text, max) {
  const chars = Array.from(String(text ?? ''))
  return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('') + '…'
}

function fillText (template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => {
    const value = vars[key]
    return value === undefined || value === null ? match : String(value)
  })
}

function cropName (crop) {
  return CROPS[crop]?.name ?? (typeof crop === 'string' && crop !== '' ? crop : '作物')
}

function cropList () {
  return CROP_IDS.length > 0 ? CROP_IDS : ['tomato']
}

function variablesFor (crop, seed) {
  return {
    crop: cropName(crop),
    region: pick(REGIONS, seed + ':region') ?? REGIONS[0],
    person: pick(PERSONS, seed + ':person') ?? PERSONS[0],
    qty: String(8 + Math.floor(unitHash(seed + ':qty') * 80)),
    pct: String(4 + Math.floor(unitHash(seed + ':pct') * 15))
  }
}

function templatesOfKind (kind) {
  return TEMPLATES.filter((template) => template.kind === kind && template.scope !== 'all')
}

function globalTemplates () {
  return TEMPLATES.filter((template) => template.scope === 'all')
}

function pickTemplate (kind, key, used) {
  let list = templatesOfKind(kind)
  if (list.length === 0) list = TEMPLATES.filter((template) => template.scope !== 'all')
  const fresh = list.filter((template) => !used.has(template.id))
  const pool = fresh.length > 0 ? fresh : list
  const template = pickWeighted(pool, key)
  if (template !== null) used.add(template.id)
  return template
}

function pickKind (key) {
  const total = KIND_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = unitHash(key) * total
  for (const [kind, weight] of KIND_WEIGHTS) {
    roll -= weight
    if (roll < 0) return kind
  }
  return 'micro'
}

/** 把一条模板实例化成事件；`scope:'all'` 的事件在账本里会按作物再乘 beta。 */
function makeEvent ({
  id,
  scope,
  kind,
  template,
  crop,
  primaryCrop = crop,
  dayIndex,
  dayStart,
  minute,
  seed,
  storyId = null,
  jumpOverride = null,
  titleOverride = null,
  bodyOverride = null
}) {
  const vars = variablesFor(primaryCrop, seed)
  const tone = template.tone ?? 'vol'
  const sign = TONE_SIGNS[tone] ?? 0
  const mag = jumpOverride === null
    ? (tone === 'vol' ? 0 : rangeOf(template.mag, seed + ':mag'))
    : Math.abs(jumpOverride)
  const jump = jumpOverride === null ? sign * mag : jumpOverride
  const storm = template.storm === undefined ? 1 : rangeOf(template.storm, seed + ':storm')
  const duration = template.duration === undefined ? 0 : Math.round(rangeOf(template.duration, seed + ':duration'))
  const at = dayStart + minute * MINUTE_MS
  return {
    id,
    storyId: storyId ?? id,
    scope,
    crop: primaryCrop,
    primaryCrop,
    dayIndex,
    at,
    minute,
    kind,
    tone,
    jump,
    storm,
    duration,
    title: truncate(titleOverride ?? fillText(template.title, vars), NEWS_MAX_TITLE),
    body: truncate(bodyOverride ?? fillText(template.body, vars), NEWS_MAX_BODY),
    source: template.source ?? (pick(SOURCES, seed + ':source') ?? SOURCES[0]),
    rarity: NEWS_RARITY[kind] ?? 1,
    followUp: template.followUp === true
  }
}

/**
 * 一天里这个作物的随机事件（3–6 条）。同一天同一模板只用一次；
 * 头条有 50% 概率在 5–20 分钟后接一条「证实/辟谣」。
 */
function cropEventsForDay (crop, dayIndex) {
  const dayStart = dayIndex * DAY_MS - MARKET_TZ_OFFSET_MS
  const seed = NEWS_SALT + ':crop:' + crop + ':' + dayIndex
  const count = 3 + Math.floor(unitHash(seed + ':count') * 4)
  const used = new Set()
  const events = []
  for (let index = 0; index < count; index += 1) {
    const key = seed + ':' + index
    const kind = pickKind(key + ':kind')
    const template = pickTemplate(kind, key + ':template', used)
    if (template === null) continue
    const minute = Math.floor(unitHash(key + ':minute') * DAY_MINUTES)
    const event = makeEvent({
      id: 'crop:' + crop + ':' + dayIndex + ':' + index,
      scope: 'crop',
      kind: template.kind,
      template,
      crop,
      dayIndex,
      dayStart,
      minute,
      seed
    })
    events.push(event)
    if (template.followUp === true && unitHash(key + ':follow') < 0.5) {
      const followMinute = minute + 5 + Math.floor(unitHash(key + ':followMinute') * 16)
      if (followMinute < DAY_MINUTES && Math.abs(event.jump) > 0) {
        const same = unitHash(key + ':followSame') < 0.5
        const sign = same ? Math.sign(event.jump) : -Math.sign(event.jump)
        const followMag = Math.abs(event.jump) * (0.4 + unitHash(key + ':followMag') * 0.3)
        const followTitle = sign > 0
          ? '后续：' + cropName(crop) + '消息得到证实，盘面继续发酵'
          : '辟谣：' + cropName(crop) + '相关消息不实，盘面回吐'
        const follow = makeEvent({
          id: event.id + ':follow',
          storyId: event.id,
          scope: 'crop',
          kind: 'followup',
          template: {
            title: followTitle,
            body: sign > 0
              ? '交易所公告：请以官方信息为准；买盘又厚了一点。'
              : '镇农技站：网传消息夸大；刚才追进去的人开始平仓。',
            source: '交易所公告'
          },
          crop,
          dayIndex,
          dayStart,
          minute: followMinute,
          seed: key + ':follow',
          jumpOverride: sign * followMag
        })
        follow.tone = sign > 0 ? 'up' : 'down'
        events.push(follow)
        event.followUp = true
        event.body = truncate(event.body + ' 10 分钟后有官方回应。', NEWS_MAX_BODY)
      }
    }
  }
  return events
}

/** 全市场事件：2–3 条/天；只生成一次，所有作物共用，按 beta 传导。 */
function globalEventsForDay (dayIndex) {
  const cached = GLOBAL_CACHE.get(dayIndex)
  if (cached !== undefined) return cached
  const dayStart = dayIndex * DAY_MS - MARKET_TZ_OFFSET_MS
  const seed = NEWS_SALT + ':global:' + dayIndex
  const count = 2 + Math.floor(unitHash(seed + ':count') * 2)
  const used = new Set()
  const events = []
  for (let index = 0; index < count; index += 1) {
    const key = seed + ':' + index
    const template = pickWeighted(globalTemplates().filter((item) => !used.has(item.id)).length > 0
      ? globalTemplates().filter((item) => !used.has(item.id))
      : globalTemplates(), key)
    if (template === null) continue
    used.add(template.id)
    const minute = Math.floor(unitHash(key + ':minute') * DAY_MINUTES)
    const primaryCrop = pick(cropList(), key + ':crop') ?? 'tomato'
    events.push(makeEvent({
      id: 'global:' + dayIndex + ':' + index,
      scope: 'all',
      kind: template.kind,
      template,
      crop: primaryCrop,
      primaryCrop,
      dayIndex,
      dayStart,
      minute,
      seed
    }))
  }
  if (GLOBAL_CACHE.size >= MAX_LEDGER_CACHE) {
    const first = GLOBAL_CACHE.keys().next().value
    GLOBAL_CACHE.delete(first)
  }
  GLOBAL_CACHE.set(dayIndex, events)
  return events
}

/** 每天 5 个日程：预告（0 跳价）+ 结果（跳价）；结果只属于被抽中的作物。 */
function calendarEventsForDay (dayIndex) {
  const cached = CALENDAR_CACHE.get(dayIndex)
  if (cached !== undefined) return cached
  const dayStart = dayIndex * DAY_MS - MARKET_TZ_OFFSET_MS
  const seed = NEWS_SALT + ':calendar:' + dayIndex
  const events = []
  for (let index = 0; index < NEWS_SCHEDULE_MINUTES.length; index += 1) {
    const minute = NEWS_SCHEDULE_MINUTES[index]
    const key = seed + ':' + index
    const crop = pick(cropList(), key + ':crop') ?? 'tomato'
    const template = unitHash(key + ':high') < 0.5 ? CALENDAR_TEMPLATES[0] : CALENDAR_TEMPLATES[1]
    const event = makeEvent({
      id: 'calendar:' + dayIndex + ':' + index,
      scope: 'crop',
      kind: 'calendar',
      template,
      crop,
      dayIndex,
      dayStart,
      minute,
      seed: key + ':result'
    })
    const teaserMinute = minute - 10
    if (teaserMinute >= 0) {
      const teaser = makeEvent({
        id: event.id + ':teaser',
        storyId: event.id,
        scope: 'crop',
        kind: 'calendar',
        template,
        crop,
        dayIndex,
        dayStart,
        minute: teaserMinute,
        seed: key + ':teaser',
        jumpOverride: 0,
        titleOverride: '10 分钟后：农业部发布' + cropName(crop) + '产量报告',
        bodyOverride: '方向未知，市场屏息以待；先别急着下重手。'
      })
      teaser.rarity = 0
      teaser.tone = 'vol'
      teaser.followUp = false
      events.push(teaser)
    }
    events.push(event)
  }
  if (CALENDAR_CACHE.size >= MAX_LEDGER_CACHE) {
    const first = CALENDAR_CACHE.keys().next().value
    CALENDAR_CACHE.delete(first)
  }
  CALENDAR_CACHE.set(dayIndex, events)
  return events
}

/**
 * 某作物某市场日的账本：事件列表 + 每分钟跳价 + 每分钟波动乘子。
 * `steps[m]` 是第 m 分钟所有事件的 jump 之和；`vol[m]` 默认 1，风暴事件期间取最大 storm。
 */
function buildLedger (crop, dayIndex) {
  const events = []
  for (const event of cropEventsForDay(crop, dayIndex)) events.push(event)
  for (const event of globalEventsForDay(dayIndex)) {
    const beta = event.primaryCrop === crop ? 1 : 0.5
    events.push({ ...event, crop, jump: event.jump * beta })
  }
  for (const event of calendarEventsForDay(dayIndex)) {
    if (event.crop === crop) events.push(event)
  }
  events.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
  const steps = new Float64Array(DAY_MINUTES)
  const vol = new Float64Array(DAY_MINUTES)
  vol.fill(1)
  for (const event of events) {
    if (Number.isFinite(event.jump) && event.jump !== 0 && event.minute >= 0 && event.minute < DAY_MINUTES) {
      steps[event.minute] += event.jump
    }
    if (Number.isFinite(event.storm) && event.storm > 1 && event.duration > 0) {
      const end = Math.min(DAY_MINUTES, event.minute + event.duration)
      for (let minute = Math.max(0, event.minute); minute < end; minute += 1) {
        if (event.storm > vol[minute]) vol[minute] = event.storm
      }
    }
  }
  return {
    crop,
    dayIndex,
    dayStart: dayIndex * DAY_MS - MARKET_TZ_OFFSET_MS,
    events,
    steps,
    vol
  }
}

function ledgerOf (crop, dayIndex) {
  const key = crop + ':' + dayIndex
  const cached = LEDGER_CACHE.get(key)
  if (cached !== undefined) return cached
  const ledger = buildLedger(crop, dayIndex)
  if (LEDGER_CACHE.size >= MAX_LEDGER_CACHE) {
    const first = LEDGER_CACHE.keys().next().value
    LEDGER_CACHE.delete(first)
  }
  LEDGER_CACHE.set(key, ledger)
  return ledger
}

/** 绝对分钟 → 市场日序号；消息日程与账本都用它。 */
export function marketDayIndexOfMinute (minute) {
  return Math.floor((minute * MINUTE_MS + MARKET_TZ_OFFSET_MS) / DAY_MS)
}

/** 绝对毫秒 → 市场日序号。 */
export function marketDayIndexOfAt (at) {
  return Math.floor((at + MARKET_TZ_OFFSET_MS) / DAY_MS)
}

/** 第 `dayIndex` 个市场日的 00:00（毫秒）。 */
export function marketDayStartOf (dayIndex) {
  return dayIndex * DAY_MS - MARKET_TZ_OFFSET_MS
}

function normalizeMinute (minute) {
  const value = Number(minute)
  return Number.isFinite(value) ? Math.floor(value) : null
}

/** 第 `minute` 分钟（绝对分钟）的确定性跳价；没有事件就是 0。 */
export function newsStepAt ({ crop, minute } = {}) {
  if (typeof crop !== 'string' || crop === '') return 0
  const value = normalizeMinute(minute)
  if (value === null) return 0
  const dayIndex = marketDayIndexOfMinute(value)
  const dayStart = marketDayStartOf(dayIndex)
  const offset = value - Math.floor(dayStart / MINUTE_MS)
  if (offset < 0 || offset >= DAY_MINUTES) return 0
  return ledgerOf(crop, dayIndex).steps[offset]
}

/** 第 `minute` 分钟的波动乘子（风暴事件期间 1.5–2.2，否则 1）。 */
export function newsVolMultAt ({ crop, minute } = {}) {
  if (typeof crop !== 'string' || crop === '') return 1
  const value = normalizeMinute(minute)
  if (value === null) return 1
  const dayIndex = marketDayIndexOfMinute(value)
  const dayStart = marketDayStartOf(dayIndex)
  const offset = value - Math.floor(dayStart / MINUTE_MS)
  if (offset < 0 || offset >= DAY_MINUTES) return 1
  return ledgerOf(crop, dayIndex).vol[offset]
}

/**
 * 盘口窗口要的消息：最近 24 小时 + 未来 1 小时（预告），最多 `limit` 条。
 * 包含正文/来源；bar 上的 lite 事件只带标题，详情卡用这里的全文。
 */
export function newsForWindow ({ crop, now, limit = 20 } = {}) {
  if (typeof crop !== 'string' || crop === '') return []
  const stamp = Number(now)
  if (!Number.isFinite(stamp)) return []
  const items = newsForRange({ crop, from: stamp - 24 * 60 * MINUTE_MS, to: stamp + 60 * MINUTE_MS })
  items.sort((left, right) => right.at - left.at || right.id.localeCompare(left.id))
  return items.slice(0, Math.max(1, Math.min(40, limit)))
}

/**
 * 某作物在 `[from, to)` 里的事件（按时间正序）。供 K 线标记、窗口消息和测试用。
 * 坏参数返回空数组，不抛。
 */
export function newsForRange ({ crop, from, to } = {}) {
  if (typeof crop !== 'string' || crop === '') return []
  const start = Number(from)
  const end = Number(to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
  const firstDay = marketDayIndexOfAt(start)
  const lastDay = marketDayIndexOfAt(end - 1)
  const events = []
  for (let dayIndex = firstDay; dayIndex <= lastDay; dayIndex += 1) {
    for (const event of ledgerOf(crop, dayIndex).events) {
      if (event.at >= start && event.at < end) events.push(event)
    }
  }
  events.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
  return events
}

/**
 * 一根 K 线要带的 lite 事件：按 |jump| 取最重要的 `limit` 条，再按时间正序。
 * 没有 jump 的日程预告也算（它本身是玩家要看的消息），但风暴/微讯不抢头条的位置。
 */
export function newsForBar ({ crop, start, end, limit = 2 } = {}) {
  const events = newsForRange({ crop, from: start, to: end })
  if (events.length === 0) return []
  const picked = events
    .map((event) => ({
      event,
      weight: Math.abs(event.jump) + (event.kind === 'calendar' ? 0.004 : 0) + (event.rarity * 0.001)
    }))
    .sort((left, right) => right.weight - left.weight || left.event.at - right.event.at)
    .slice(0, Math.max(1, Math.min(4, limit)))
    .map((entry) => entry.event)
  picked.sort((left, right) => left.at - right.at)
  return picked
}

/** 给 bar 用的紧凑事件：标题/来源都裁过，正文不带（详情卡从 newsForWindow 查全文）。 */
export function compactNewsEvent (event, start) {
  if (event === null || typeof event !== 'object') return null
  return {
    id: event.id,
    at: event.at,
    off: Math.max(0, Math.min(14, Math.floor((event.at - start) / MINUTE_MS))),
    tone: event.tone,
    mag: event.jump,
    title: truncate(event.title, NEWS_MAX_TITLE),
    rarity: event.rarity,
    kind: event.kind
  }
}

/**
 * 今日 5 条日程（结果事件，不裁剪）：给详情卡的「今日日程」。
 * `at` 是公布时刻；窗口自己按本机时钟算倒计时。
 */
export function calendarForDay ({ crop = null, now } = {}) {
  const stamp = Number(now)
  if (!Number.isFinite(stamp)) return []
  const dayIndex = marketDayIndexOfAt(stamp)
  const rows = []
  for (const event of calendarEventsForDay(dayIndex)) {
    // 只返回结果事件；预告仍在 news.items 里给快讯条，不占「今日日程」的 5 行。
    if (event.kind !== 'calendar' || event.id.endsWith(':teaser')) continue
    if (crop !== null && crop !== undefined && event.crop !== crop) continue
    rows.push({
      id: event.id,
      at: event.at,
      minute: event.minute,
      crop: event.crop,
      cropName: cropName(event.crop),
      title: event.title,
      source: event.source,
      mag: event.jump,
      tone: event.tone
    })
  }
  rows.sort((left, right) => left.at - right.at)
  return rows
}

/** 事件模板的只读快照：测试用来查覆盖率与文案长度。 */
export function newsTemplateSnapshot () {
  return TEMPLATES.map((template) => ({
    id: template.id,
    kind: template.kind,
    tone: template.tone,
    scope: template.scope,
    title: template.title,
    body: template.body,
    source: template.source
  }))
}

/** 测试/诊断用：清缓存，避免用例之间互相污染。 */
export function resetNewsCache () {
  LEDGER_CACHE.clear()
  GLOBAL_CACHE.clear()
  CALENDAR_CACHE.clear()
}
