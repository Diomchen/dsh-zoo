<p align="center">
  <img src="assets/logo.png" alt="dsh-zoo" width="220">
</p>

# dsh-zoo

[![CI](https://github.com/Diomchen/dsh-zoo/actions/workflows/ci.yml/badge.svg)](https://github.com/Diomchen/dsh-zoo/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Diomchen/dsh-zoo?display_name=tag&sort=semver)](https://github.com/Diomchen/dsh-zoo/releases/latest)

把同一局域网里的 DSH 宠物连起来：自己的宠物活在桌面上，邻居的宠物会来串门，你的宠物也会出门。

dsh-zoo 负责**发现、放行、串门、桌面画布、礼物、记录和农场**；宠物的名字、动作和外观来自 `dsh-pet`。

> **v1.1**：农场是新的一层——种、收、偷、帮忙、雇工和本机交易所。
> 旧版本的邻居照常串门、送礼、留记录，只是看不到农场；偷菜/帮忙/雇佣需要双方都是 v1.1。

> 桌面层支持 **macOS / Windows**。Linux 或 web profile 没有桌面宠物，但发现、放行、串门照常工作。

## 快速开始

**要求**

- DSH Desktop（web profile 也可以，只是没有桌面层）
- `dsh-pet`（提供宠物、动作和素材；不装也能跑，只是显示通用小人）
- Node.js ≥ 22.12
- Electron 运行时（装过 `dsh-pet` 后通常已有；没有则不会显示桌面宠物）

**安装**

```sh
git clone https://github.com/Diomchen/dsh-zoo.git
cd dsh-zoo
node scripts/install.mjs            # 装进 ~/.dsh/profiles/desktop
node scripts/install.mjs --dry-run  # 先看会改什么
node scripts/install.mjs --profile web
```

装完**重启 DSH**。确认接口是否正常：

```sh
curl -s http://127.0.0.1:<DSH端口>/dsh-zoo/state | jq '.neighbors'
```

`<DSH端口>` 是 DSH GUI 地址里的那个本地端口。

**卸载**

```sh
node scripts/uninstall.mjs
```

用户数据在 `~/.dsh/dsh-zoo/`，卸载不会删除。

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 桌面宠物 | 全屏透明、置顶、默认点击穿透；有重力，可拖拽，松手按轨迹投掷。 |
| 邻居发现 | 同一网段 UDP 广播，自动找到邻居；第一次见面先放行。 |
| 串门 | 手动或自动去邻居家；访客常驻，支持送客、召回和 30 分钟上限。 |
| 邻居面板 | 点「串门」先看到一条小街：谁在线、在干嘛、能不能去。 |
| 右键菜单 | 打开软件、带派、农场、回到初始位置、重载配置、扫描外观、动作、外观。 |
| 带派（捎东西） | 出门前捎一张字条或一个文件；背包、送达回执、礼物卡都已落地。 |
| 串门记录 | 双方各留一条记录，保留最近 200 条。 |
| 农场 | 4 块地、3 种作物；离线也长，待机攒露水。 |
| 交易所 | 本机做市，买种子、卖作物；邻居行情汇总成局域网指数。 |
| 偷菜与帮忙 | 去邻居家偷成熟作物，或给生长中的地浇水；有守卫和每日上限。 |
| 雇工 | 挂牌出租宠物看家；合同 2–8 小时，预付工资，按实际时长结算。 |
| 多外观 | 用 `skin.json` 注册素材源；换皮不动名字、身份和记录。 |

## 桌面上的操作

| 操作 | 结果 |
| --- | --- |
| 悬停自己 | 弹出「串门 / 召回 / 改名」 |
| 右键自己 | 打开软件 / 回到初始位置 / 重载配置 / 扫描外观 / 动作 / 外观 |
| 点「串门」 | 打开邻居小街，点哪户就去哪家；去不了的会说明原因 |
| 点访客 | 送客 |
| 拖拽宠物 | 抓起来，松手投掷 |
| 点礼物卡 | 打开 / 在文件夹里显示 / 复制（字条）/ 扔掉 |
| 右键「农场」 | 打开卡片农场小窗（农场 / 交易所 / 雇工 / 记录）；再点一次关闭，窗口的 × / Esc 也关闭 |

右键菜单里的「重载配置」会重读 `settings.json` 和 `skin.json`，并重建桌面，不会占用崩溃退避次数。
菜单只挂自己的宠物：访客和空白桌面都不会弹。

## 配置

### 数据目录

默认是 `~/.dsh/dsh-zoo/`（跟随 `DSH_HOME`）：

| 路径 | 内容 |
| --- | --- |
| `identity.json` | 本机 `deviceId` 和昵称镜像 |
| `peers.json` | 放行 / 拒绝名单，只按 `deviceId` 认 |
| `settings.json` | 入站串门、自动出门两个开关 |
| `visits.json` | 串门记录，最多 200 条 |
| `farm.json` | 农场：地块、仓库、硬币、露水、挂牌和农场日志 |
| `market.json` | 本机交易所：价格、成交历史、局域网指数 |
| `contracts.json` | 雇佣合同（`outgoing` 我是雇主 / `incoming` 我是雇工） |
| `backpack.json` | 待捎礼物，最多 2 件 |
| `gifts/` | 收到的礼物，每件一个目录 |
| `skin.json` | 本机素材源注册表 |
| `skin-cache/` | 远端素材缓存，上限 200 MiB |

文件都可以手改。`settings.json` / `skin.json` 改完点「重载配置」生效；`identity.json` /
`peers.json` 需要重启 DSH。

### 两个开关

`settings.json`：

```json
{ "version": 1, "acceptVisits": true, "autoVisits": false }
```

- `acceptVisits`：默认开。关掉后只拒绝入站串门，发现、心跳和手动串门不受影响。
- `autoVisits`：默认关。打开后还要同时满足：最近 10 分钟有活动、距上次出门 ≥15 分钟、
  存在在线且互相放行的邻居；满足才随机挑一位出门。
- 也可以用 HTTP `accept-visits` / `auto-visits` 改，立即生效并落盘。

### 外观（skin.json）

想用其他宠物包的外观，把它的动作目录写进来：

```json
{
  "sources": [
    {
      "id": "maodie-pet",
      "dirs": ["C:\\Users\\me\\.dsh\\dsh-pet\\pet\\maodie-animation"],
      "size": 693,
      "idle": "待机",
      "once": ["喷火"]
    }
  ]
}
```

- `id` 是这张皮的身份证，也是邻居看到的 `skinId`；`dirs` 是动作目录，每个动作一段 WebM。
- `size` 是相对 462 的比例（默认 1.0，范围 0.5–2）；`idle` 和 `once` 可选。
- 文件一旦存在，就**取代**自动注册的 `dsh-pet` 源；两张以上皮时右键菜单会出现「外观」。
- 改完点「重载配置」生效；文件带 UTF-8 BOM 也认。

### 端口与环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_ZOO_PORT` | `45871/udp` | 发现、心跳、串门共用同一条 socket |
| `DSH_ZOO_SKIN_PORT` | `45873/tcp` | 素材源和文件礼物共用 |
| `DSH_ZOO_DESKTOP` | 开启 | 设为 `0` / `false` / `off` 关闭桌面层 |
| `DSH_ZOO_ELECTRON` | 自动查找 | 指定 Electron 可执行文件 |

同一网段的所有机器要用同一个 UDP 端口。macOS 首次监听会问“允许传入连接”；Windows 首次会弹
Defender 防火墙，需要给**专用网络**放行。文件礼物还要求对方的 TCP 素材端口可达。

## 本机 HTTP API

所有路由都挂在 DSH 自己的本地端口上：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /dsh-zoo/state` | 邻居、访客、开关、背包、礼物、农场、交易所和合同 |
| `POST /dsh-zoo/action` | 放行、串门、改名、换皮、礼物、农场、买卖、雇佣等本机动作 |
| `POST /dsh-zoo/self-state` | 其他本机插件上报“我现在在干嘛” |
| `GET /dsh-zoo/desktop` | 桌面 helper 的实时状态 |
| `GET /dsh-zoo-farm/<visitId>` | 局域网只读：访客在串门期间拉主人的农场快照（素材端口 45873） |

常用动作：

| 分组 | action |
| --- | --- |
| 放行 | `admit` / `reject` / `dismiss` |
| 串门 | `visit` / `recall` / `end-visit` |
| 开关 | `accept-visits` / `auto-visits` |
| 名字与外观 | `rename` / `use-skin` |
| 动作与桌面 | `play-anim` / `reload` / `open-site` |
| 带派 | `bring` / `unbring` / `gift-open` / `gift-reveal` / `gift-discard` / `gift-copy` |
| 农场 | `plant` / `harvest` / `water` / `fertilize`（桌面同义 `farm-*`） |
| 交易所 | `buy-seed` / `sell-crop`（桌面同义 `farm-buy-seed` / `farm-sell-crop`） |
| 雇佣 | `hire` / `hire-listing` / `recall-worker` / `end-contract` |
| 访客农场 | `farm-steal` / `farm-help`（串门期间；`visitId` 可省略） |
| 农场小窗 | `farm-open`（`plotId` 可选） |

每个 action 的 body、返回值和错误码见 [`docs/protocol.md`](docs/protocol.md)。
`state` 里最常看的是 `neighbors`、`prompt`、`visitors`、`skin`、`backpack`、`gifts`、
`farm`、`market` 和 `contracts`。

```sh
# 查看邻居和待放行队列
curl -s http://127.0.0.1:<DSH端口>/dsh-zoo/state | jq '.neighbors, .prompt'

# 放行一位邻居
curl -s -X POST http://127.0.0.1:<DSH端口>/dsh-zoo/action \
  -H 'content-type: application/json' \
  -d '{"action":"admit","deviceId":"<邻居 UUID>"}'

# 让别的本机插件上报自己的状态
curl -s -X POST http://127.0.0.1:<DSH端口>/dsh-zoo/self-state \
  -H 'content-type: application/json' \
  -d '{"action":"写代码","semantic":"working","say":"在写代码"}'
```

`self-state` 的 `action` 自由命名（≤64 字），`semantic` 只能是
`working` / `eating` / `sleeping` / `idle` / `other`，`say` 最多 80 字。

## 带派：串门捎东西

右键自己 →「带派」，放一张字条或一个文件；也可以用 `bring` 动作直接放进背包。
到了邻居家东西留下，访客旁边出现礼物卡。**收到对方回执才算送到**，否则串门结束时退回背包。

礼物卡跟着这一次访客走：访客离开卡片收起，礼物本身留在 `gifts/`。卡片正文按纯文本渲染，
不解析 HTML/Markdown。

| 项 | 限制 |
| --- | --- |
| 字条 | ≤500 字 |
| 文件 | ≤16 MiB |
| 背包 | 最多 2 件，先放的先带走 |
| 收件箱 | 总量 ≤500 MiB、≤200 件 |
| 频率 | 同一邻居 ≤10 件/小时、≤50 件/天 |

礼物永远不会自动打开或执行；打开、显示、复制、扔掉都只在用户点卡片时发生。
细节与完整动作见 [`docs/protocol.md`](docs/protocol.md)。

## 农场：种、收、偷、雇、交易所

农场属于**身份**：换皮、改名都不动它。初始农场是 4 块空地、30 硬币、2 颗小番茄种子、
0 露水；第一次打开就能直接种。完整操作在农场小窗里（页签：农场 / 交易所 / 雇工 /
记录）；桌面上没有地块条，右键「农场」唤醒，再点一次或 ×/Esc 关闭。
小窗是奶白底、祖母绿/琥珀点缀的卡片农场：顶部有「我的农场 / X/Y 已种植」、硬币/露水胶囊
和 ×；地块卡分空地（点一下开播种弹窗）、生长中（倒计时 + 进度 + 浇水/施肥）、成熟
（轻微弹跳 + 收获/施肥）；农场页还有「一键播种 / 一键收割」，底部常驻种子背包和收获仓库。
地块网格按宿主下发的 `farm.plots` 自适应（当前仍是 4 块；布局没有写死 4，未来多发几块
不用改窗口）。记录页给最近 50 条农场日志（种/收/偷/帮/雇/结算）；
偷来的作物和未结算的工资显示在窗口顶部的「驮包」里，只显示、不重复记账。

### 作物

| 作物 | id | 生长 | 种子价 | 产量 | 交易所底价 |
| --- | --- | --- | --- | --- | --- |
| 小番茄 | `tomato` | 30 分钟 | 6 | 3 | 5 |
| 胡萝卜 | `carrot` | 2 小时 | 14 | 5 | 6 |
| 南瓜 | `pumpkin` | 8 小时 | 36 | 3 | 30 |

初始种子只有小番茄；其他种子去交易所买。

### 怎么玩

- **种 / 收**：右键「农场」打开小窗；点空地卡片弹出播种底部弹窗，选种子种下；成熟后
  点「收获」。也可以「一键播种」（第一个空地 + 第一份有库存的种子）或「一键收割」
  （所有成熟地块顺序收获）。产量 = 表里的产量 + 施肥 1 − 被偷数量（最低 0）。
  不枯萎、不生病。
- **浇水 / 施肥**：每株各一次。浇水花 1 露水，+10% 生长；施肥花 5 露水，收获 +1。
  露水不够会明确报 `no-dew`。
- **待机 / 露水**：DSH 开着、10 分钟没做农场动作算待机；每 10 分钟 +1 露水，
  每天最多挣 48、余额也封顶 48，本地午夜重置。任何一次种/收/浇/施肥/买卖/雇佣都会重置计时。
- **离线生长**：关掉 DSH 作物仍按真实时间长；一次最多补 12 小时，回来接着长。
- **交易所**：交易所页买种子（固定价）、卖作物（按本机 `bid`）。卖多了价跌，
  每 10 分钟向底价回归 3%；价格永远夹在底价的 0.5–2 倍。买种子不影响作物价。
- **行情**：每 30 秒（或价格/挂牌变化时）向放行邻居广播一次本机价格与挂牌；
  各家取新鲜样本的中位数混成局域网指数，成交仍在本机。
- **偷菜 / 帮忙**：串门时打开农场窗进入访客视图。成熟的地可以偷 1 个；
  生长中的地可以帮一次（花 1 露水、+10% 生长、得 1 硬币）。偷菜成功会让主人收获少 1；
  被抓只是这次白跑。两种互动都有每日上限和每块地每轮一次的限制。
- **雇工**：雇工页保存自己的挂牌（开关 / 时薪 / 可雇时段）。邻居的挂牌随行情摘要过来，
  选宠物和时长就能雇。工资 + 5% 手续费预付；雇工出现在雇主的桌面上（带「打工」角标），
  雇主守卫 0.3 + 0.5 = 0.8 封顶。合同期内雇工不能串门、不能被别人雇，**自家农场没人看**。
  主人可以召回，雇主可以提前结束，按实际服务时长结算；手续费不退。
- **没有桌面层**：HTTP 动作和 `/dsh-zoo/state` 照常可用，只是没有农场窗，也没有雇工宠物。

### 限额

| 项 | 上限 |
| --- | --- |
| 地块 | 4 块（`p1`–`p4`） |
| 作物 | 3 种 |
| 硬币 | 1,000,000 |
| 每种种子 / 作物 | 999 |
| 露水 | 每天最多挣 48，余额上限 48 |
| 离线生长 | 一次最多补 12 小时 |
| 农场日志 | 文件 50 条；`/state.farm.log` 20 条；窗口记录页 50 条 |
| 驮包 | 只显示：偷来的作物到本次串门结束；工资到合同结算 |
| 行情历史 | 文件 200 笔；`/state.market.history` 50 笔 |
| 合同 | 每侧 20 条（未结算的不淘汰） |
| 偷菜 | 同一访客对同一农场 3 次/天；同一农场 5 次/天；同一访客 10 次/天；每块地每轮 1 次 |
| 帮忙 | 同一访客对同一农场 3 次/天；同一访客 5 次/天；每块地每轮 1 次；每次 1 露水、+1 硬币 |
| 行情广播 | 每个 peer 30 秒最多 1 条；只认 2 分钟内、价格在 `[base×0.5, base×2]` 的样本 |
| 买卖 | 单次 1–99 个；每分钟最多 10 笔（买 + 卖共用） |
| 价格 | 夹在 `base×0.5`–`base×2`；`bid = round(effective × 0.9)`；每 10 分钟回归 3% |
| 幂等缓存 | `farm-action` 按 `${deviceId}:${requestId}` 留最近 200 条 / 10 分钟；`work-*` ack 留 200 条 / 10 分钟 |
| 雇佣 | 时薪 1–100，时长 2–8 小时，手续费 `ceil(工资 × 5%)`、最低 1 |
| 守卫 | 主人在家 0.3 + 雇工 0.5，相加封顶 0.8；宠物串门/打工时自家为 0 |
| 农场快照 | HTTP 响应 ≤64 KiB；访客宿主 2 秒超时，失败按地址冷却 60 秒 |

### 数据文件与降级

农场三个文件和 `visits.json` / `backpack.json` 同一套路：带 `version: 1`、可手改、可删；
损坏时按默认值运行并只告警一次；写入串行 + 临时文件 rename。删掉 `farm.json` 就是重新开局。

| 文件 | 内容 |
| --- | --- |
| `farm.json` | 硬币、种子、作物、露水、4 块地、挂牌、访客计数、农场日志 |
| `market.json` | 三种作物的 `base/price/volume24h/at`、最近 200 笔成交、局域网指数 |
| `contracts.json` | `outgoing`（我是雇主）与 `incoming`（我是雇工）两份合同列表 |

| 情况 | 看到 |
| --- | --- |
| 旧版本邻居 | 串门、礼物、记录照常；没有农场入口，不能偷/帮/雇；行情忽略 |
| 没有桌面层 | HTTP 动作与 `state` 可用；没有农场窗，也没有雇工宠物 |
| 对方离线 | 不能去/偷/帮/雇；行情过期；合同按最后心跳结束 |
| 对方没开局域网端口 | 串门照常；农场快照取不到，不能偷/帮；雇工不可用 |
| 没有种子 / 硬币 / 露水 | 明确错误码 + 一句人话 |
| 合同一方离线 | 合同结束，按最后心跳结算；重连后按 `contractId` 幂等补发 |

### 验收：两台机器或假邻居

两台机器都装 v1.1、同一 UDP 端口、互相放行，然后走一遍：

1. A 种一块地并等成熟；B 串门到 A，打开农场窗，偷一次、帮另一块地。
   A 的 `/state.farm.log` 应出现「谁偷了 / 谁帮了」，A 的地块 `stolenBy` / `helpedBy` 各多一位。
2. A 在雇工页打开挂牌；B 在雇工页看到 A 的挂牌并雇佣。
   A 的桌面上出现带「打工」角标的宠物，`/state.farm.guard` 变成 0.8。
3. B 雇主提前结束（或 A 召回），等合同从 active 走到 ended/settled；
   两边 `/state.contracts` 的 `earned` / `settled` 一致，重复操作不会重复加钱。
4. 用一台旧版本机器串门：串门、礼物、记录照常；农场入口不出现，脚本不会崩。

```sh
# 看农场、交易所和合同
curl -s http://127.0.0.1:<DSH端口>/dsh-zoo/state | jq '.farm, .market, .contracts'

# 用假邻居验发现、放行、串门、召回、记录
npm run fake-peer -- --name 楼下的柯基 --auto-visit 5
```

`scripts/fake-peer.mjs` 目前只实现发现 / 串门 / 礼物（它是一颗真 UDP socket，但没有
农场仓库和合同状态机），所以偷/帮/雇/结算没有做成脚本化的假邻居验收；这几条由
`test/farm-*-e2e.test.js`、`test/work-*-e2e.test.js` 里的两个 service + fake peer 覆盖。
两台真机的手工步骤就是上面这四步。

## 与 dsh-pet 的关系

- `dsh-pet` 提供宠物本体：名字、动作、外观和桌宠窗口；`dsh-zoo` 只做联机、串门和画布。
- 名字只有一份：源头是 `dsh-pet` 的 `pets[].name`，`dsh-zoo` 只是镜像；没装 `dsh-pet` 时
  回落到主机名或「我」，以 `identity.json` 为准。桌面上的「改名」装了 `dsh-pet` 就写回它
  （写不进去整体失败，不会只改一半），没装则写 `identity.json`。
- **装了但没启用**（`main-config.jsonc` 还在、profile 的 `dsh.profile.bundles` 里没有 `dsh-pet`）：
  它的 `/dsh-pet-7340/config` 路由不存在，`dsh-zoo` 会退到直接读写那份配置文件，名字仍然只有一份。
  代价是 JSONC 注释会丢（`dsh-pet` 自己的 `PUT /config` 同样会丢）。
- **两个插件同时开桌面层会画两只宠物**：两个透明窗口重叠时，看到的那只和拖到的那只可能不是同一只。
  只留一个：关掉 `dsh-pet` 的桌面窗，或用 `{"desktop": false}` / `DSH_ZOO_DESKTOP=0` 关掉这一层。
- 访客不需要本机装 `dsh-pet`：对方有素材源就拉远端素材，没有就退回本机同名素材或通用小人。

## 升级与改名

项目已从 `dsh-local-pet` 改名为 `dsh-zoo`（[ADR-0014](docs/adr/0014-rename-to-dsh-zoo.md)）：

- 首次启动会把 `~/.dsh/local-pet/` 整体改名为 `~/.dsh/dsh-zoo/`；改名失败就继续用旧目录，数据不丢。
- 局域网旧路由 `/local-pet-skin/*`、`/local-pet-gift/*` 仍然接受，新旧版本邻居可以混跑。
- 本机旧接口 `/local-pet/*` 不再提供，脚本要改成 `/dsh-zoo/*`。
- `node scripts/install.mjs` 会顺手摘掉 profile 里旧的 `dsh-local-pet` 依赖和 bundles 条目。

<details>
<summary>从 0.4.0 及更早版本升级</summary>

0.4.1 起 helper 的工作目录挪到了系统临时目录（[ADR-0012](docs/adr/0012-helper-cwd-outside-package.md)）。
已经在跑的旧 helper 改不了自己的 cwd，Windows 上直接替换包可能 `ERR_PNPM_EPERM`。
先退出 DSH，再：

```sh
node scripts/stop-helper.mjs --dry-run
node scripts/stop-helper.mjs
```

</details>

## 排错

| 症状 | 先做什么 |
| --- | --- |
| 桌面窗挡住点击或位置怪 | `settings.json` 里设 `{"desktop": false}`，或 `DSH_ZOO_DESKTOP=0`；只关桌面层，网络照常 |
| 宠物看得见但拖不动 | 先确认是否同时装了 `dsh-pet`（两个透明层）；再看 `/dsh-zoo/desktop` 的 `helperStatus` |
| 看不到邻居 | 同一网段？UDP 45871 被占或被防火墙挡？macOS 允许传入连接？跑 `npm run fake-peer` 排除本机问题 |
| 文件礼物取不到 | 对方 TCP 45873 不可达；串门本身仍成功，礼物会在串门结束时退回背包 |
| 点了「改名」没有任何反应 | 桌面层跑的还是旧进程：`ps` 看 helper 的启动时间，比 `desktop/` 里文件的修改时间早就是它；重装 + 重启 DSH |
| 改名报「dsh-pet 没有响应」 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<端口>/dsh-pet-7340/config`：404 = 这个 profile 没启用 dsh-pet（新版会退到直写配置文件），连不上才是它真的不可用 |
| 改名后数据像丢了 | 看日志有没有「旧数据目录改名失败」；数据可能还在 `~/.dsh/local-pet/` |

`/dsh-zoo/desktop` 里最常看的三项是 `ignoring`、`trustedInputs` 和 `busy`：`trustedInputs` 不增长，
说明真实左键没进渲染端；涨了但 `busy` 不立，问题在渲染端。

## 开发

```sh
npm test              # node --test，零依赖
npm run check         # 语法检查 + 全部测试
npm run smoke:desktop # 真 Electron 冒烟，不进 npm test
DSH_ZOO_SMOKE_ONLY=farm DSH_ZOO_SMOKE_NOTES=1 npm run smoke:desktop  # 只跑农场段并写截图
npm run fake-peer     # 在本机模拟一位邻居
npm pack              # → dsh-zoo-<version>.tgz
```

```sh
npm run fake-peer -- --name 楼下的柯基 --auto-visit 5
npm run fake-peer -- --gift $'给你留了张便条\n第二行'
```

| 路径 | 是什么 |
| --- | --- |
| `index.js` | 宿主入口，`cordis.patch.yml` 挂载 |
| `src/` | 宿主逻辑：纯状态机 + 薄 I/O 外壳 |
| `desktop/` | Electron helper：全屏透明窗、点击穿透、场景渲染 |
| `scripts/` | 安装、卸载、冒烟、假邻居 |
| `test/` | `node:test`，零依赖 |
| `docs/` | 协议文档和 ADR |

真 Electron 冒烟的截图写在 `.scratch/dsh-zoo/notes/`；`DSH_ZOO_SMOKE_NOTES=1` 会额外保存整窗和特写。

## 已知限制

- 桌面层只支持 macOS / Windows；多屏时一扇窗铺满所有屏的并集，可以跨屏拖动；走路只在同一高度的
  相邻屏之间（高度不同时停在屏边，不会掉进黑边）；没有键盘输入，宠物之间也没有物理碰撞。
- 外观只认 WebM；GIF、Spine、Live2D 会退回通用小人；素材缓存上限 200 MiB。
- 礼物：单件 ≤16 MiB、字条 ≤500 字、一次串门只带一件、背包最多 2 件；不自动打开。
- 0.3.x 及更早版本不认礼物字段：串门照常，但礼物会显示「没送到」并退回背包。
- 农场 v1.1：固定 4 块地、3 种作物、一个雇工位；没有土地升级、狗/篱笆、装饰、天气、虫害。
  小窗布局与计数按 `farm.plots` 自适应（helper 边界留到 20 块），但当前宿主仍只发 4 块，
  扩地属于后续玩法。访客不能在主人的交易所成交，硬币和作物只有被宠物驮着才跨机；
  没有跨机账本。
- 农场小窗的记录页给最近 50 条日志；`/state.farm.log` 仍只给最近 20 条。驮包是只显示的
  「在途」标记，作物/硬币的账在宿主那本账里只记一次。
- 旧版本邻居看不到农场：串门、礼物、记录照常，但偷/帮/雇/行情需要双方都是 v1.1。
- 一次场景最多 256 只；访客没有 TTL，靠对方心跳判断失联。放行提示最多同时排 8 位，
  心跳影子表最多 8 位。
- 只支持 IPv4 局域网，不支持跨网段、NAT 穿透或中继。

## 文档

- 协议、动作、错误码与敌意输入边界：[`docs/protocol.md`](docs/protocol.md)
- 桌面 helper、点击穿透、场景 v3、素材协议：[`desktop/README.md`](desktop/README.md)
- 领域词汇：[`CONTEXT.md`](CONTEXT.md)
- 决策记录：[`docs/adr/`](docs/adr/)
- 发布与上架 dsh-market：[`docs/release.md`](docs/release.md)
- 开发笔记与验收截图：[`.scratch/dsh-zoo/`](.scratch/dsh-zoo/)

## 许可证

MIT
