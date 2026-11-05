# dsh-zoo

[![CI](https://github.com/Diomchen/dsh-zoo/actions/workflows/ci.yml/badge.svg)](https://github.com/Diomchen/dsh-zoo/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Diomchen/dsh-zoo?display_name=tag&sort=semver)](https://github.com/Diomchen/dsh-zoo/releases/latest)

把同一局域网里的 DSH 宠物连起来：自己的宠物活在桌面上，邻居的宠物会来串门，你的宠物也会出门。

dsh-zoo 负责**发现、放行、串门、桌面画布、礼物和记录**；宠物的名字、动作和外观来自 `dsh-pet`。

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
| 右键菜单 | 打开软件、回到初始位置、重载配置、扫描外观、动作、外观。 |
| 带派（捎东西） | 出门前捎一张字条或一个文件；背包、送达回执、礼物卡都已落地。 |
| 串门记录 | 双方各留一条记录，保留最近 200 条。 |
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
| `GET /dsh-zoo/state` | 邻居、访客、开关、背包、礼物和桌面诊断 |
| `POST /dsh-zoo/action` | 放行、串门、改名、换皮、礼物等本机动作 |
| `POST /dsh-zoo/self-state` | 其他本机插件上报“我现在在干嘛” |
| `GET /dsh-zoo/desktop` | 桌面 helper 的实时状态 |

常用动作：

| 分组 | action |
| --- | --- |
| 放行 | `admit` / `reject` / `dismiss` |
| 串门 | `visit` / `recall` / `end-visit` |
| 开关 | `accept-visits` / `auto-visits` |
| 名字与外观 | `rename` / `use-skin` |
| 动作与桌面 | `play-anim` / `reload` / `open-site` |
| 带派 | `bring` / `unbring` / `gift-open` / `gift-reveal` / `gift-discard` / `gift-copy` |

每个 action 的 body、返回值和错误码见 [`docs/protocol.md`](docs/protocol.md)。
`state` 里最常看的是 `neighbors`、`prompt`、`visitors`、`skin`、`backpack` 和 `gifts`。

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

## 与 dsh-pet 的关系

- `dsh-pet` 提供宠物本体：名字、动作、外观和桌宠窗口；`dsh-zoo` 只做联机、串门和画布。
- 名字只有一份：源头是 `dsh-pet` 的 `pets[].name`，`dsh-zoo` 只是镜像；没装 `dsh-pet` 时
  回落到主机名或「我」，以 `identity.json` 为准。桌面上的「改名」装了 `dsh-pet` 就写回它
  （写不进去整体失败，不会只改一半），没装则写 `identity.json`。
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
| 改名后数据像丢了 | 看日志有没有「旧数据目录改名失败」；数据可能还在 `~/.dsh/local-pet/` |

`/dsh-zoo/desktop` 里最常看的三项是 `ignoring`、`trustedInputs` 和 `busy`：`trustedInputs` 不增长，
说明真实左键没进渲染端；涨了但 `busy` 不立，问题在渲染端。

## 开发

```sh
npm test              # node --test，零依赖
npm run check         # 语法检查 + 全部测试
npm run smoke:desktop # 真 Electron 冒烟，不进 npm test
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

- 桌面层只支持 macOS / Windows，只保证主屏；没有键盘输入，宠物之间也没有物理碰撞。
- 外观只认 WebM；GIF、Spine、Live2D 会退回通用小人；素材缓存上限 200 MiB。
- 礼物：单件 ≤16 MiB、字条 ≤500 字、一次串门只带一件、背包最多 2 件；不自动打开。
- 0.3.x 及更早版本不认礼物字段：串门照常，但礼物会显示「没送到」并退回背包。
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
