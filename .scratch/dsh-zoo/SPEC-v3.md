# SPEC v3 · 宠物自带外观与状态

> 承接 [ADR-0008](../../docs/adr/0008-pet-brings-its-own-look-and-state.md)。
> v2 的发现、放行、串门、记录、桌面层全部保留；本文只加「跨插件」这一层。

## Problem Statement

v2 只认 dsh-pet 的素材目录。邻居换一个桌宠插件，他的宠物来串门时，本机没有同名素材，
只能画成色块。为每个新插件往 dsh-zoo 里打包一套素材不可持续，而且永远慢一步。

用户要的边界：**dsh-zoo 只提供联机**。外观、动作、行为、监控本机 DSH 都是宠物插件自己的事。

## Solution

宠物来串门时自带三样行李：**外观包**（清单 + WebM）、**当前动作**、**一句话**。
dsh-zoo 只做四件事：收、存、画、检查。

- 对方在本机起一个只读的**素材源**，端口随 beacon 广播。
- 本机按需拉清单和当前动作，校验后缓存；helper 永远只读本地文件，不联网。
- 认不出外观就画**通用小人**（名字 + 颜色 + 中性待机 + 语义表情）。
- 旧版本收到新字段直接忽略；新版本缺字段退回 `anim` 和老行为。

## 与 v2 的差别

**留**：UDP 发现、放行、心跳、串门状态机、`visits.json`、桌面层、`dshzoo://`。

**改**：

- `src/pet-assets.js` 从「找 dsh-pet」变成「素材源注册表」：本机可以有多个源，每个源给一份清单。
- 心跳 / 串门报文多几个可选字段：`skin`、`action`、`semantic`、`say`。
- 场景快照里每只宠物多一个 `skin`（远端来源）或 `fallback`（通用小人）。
- helper 的 `dshzoo://` 多一个 `cache/` 根，指向宿主的素材缓存目录。

**删**：无。

## 行李清单

### manifest（对方的素材源提供）

```json
{
  "v": 1,
  "id": "corgi",
  "name": "楼下的柯基",
  "size": 220,
  "idle": "idle",
  "actions": {
    "idle":  { "file": "idle.webm",  "loop": true },
    "sleep": { "file": "sleep.webm", "loop": true, "semantic": "sleeping" },
    "code":  { "file": "code.webm",  "loop": true, "semantic": "working" }
  },
  "hash": "sha256:..."
}
```

- `idle`：待机动作的 id，必须存在于 `actions`；缺省时取排序后的第一个动作。
  dsh-pet 的待机动作叫 `待机呼吸休闲`，没有叫 `idle` 的文件，所以这个字段是必要的。
- `name`：外观包的名字；宠物自己的名字仍走 `nickname`，不要在这里重复。
- `size`：基准宽度（px），用于缩放到桌面上的实际大小；缺省 462（dsh-pet 的基准），新插件建议 220 左右。
- `actions` 至少有一个动作；键是动作 id（自由字符串，≤64，安全字符），值是文件 + 是否循环 + 可选语义。
- `file` 是素材源里的相对文件名，只允许安全名 + `.webm`。
- `hash` 可选；给了就校验整个 manifest 的规范化 JSON。
- 没有 manifest 的旧邻居：走 L0，只按 `anim` 名字找本机素材。

### 状态

本机宠物插件 → dsh-zoo（`127.0.0.1`）：

```http
POST /dsh-zoo/self-state
{ "action": "code", "semantic": "working", "say": "在写代码", "facing": "left" }
```

- `action` 自由字符串，≤64，安全字符；缺省 = 未知。
- `semantic`：`working` / `eating` / `sleeping` / `idle` / `other`；缺省 `other`。
- `say`：≤80 字，纯文本；默认 8 秒后过期。
- `facing`：`left` / `right`，可选。
- 与 dsh-pet 的 `/state` 轮询并存：两者都写同一个「本机宠物状态」，后到的覆盖；dsh-pet 轮询只在没有插件推送时生效（推送后 30 秒内不轮询覆盖）。

## 协议扩展（v 仍为 1）

新增字段全部可选，按类型固定：

```json
{ "v": 1, "type": "beacon", "deviceId": "...", "nickname": "...", "port": 45871,
  "skinPort": 45873, "skinId": "dsh-pet" }

{ "v": 1, "type": "heartbeat", "deviceId": "...", "anim": "东张西望",
  "action": "东张西望", "semantic": "other", "say": { "text": "在发呆", "until": 1700000000000 } }
```

- `skinPort`：素材源端口；没有就不带。
- `skinId`：素材源 id；缺省用 `deviceId`。
- `action` / `semantic`：优先于 `anim`；`anim` 仍然发，旧端只读它。
- `say`：`{ text, until }`；`until` 最多 `now + 30s`，过期不显示。
- 旧端解析：未知字段丢弃，行为不变。
- 新端解析：缺 `skinPort` → 本机素材；缺 `action` → 用 `anim`；缺 `say` → 不显示。

## 素材源

- 绑定 `0.0.0.0:<skinPort>`，默认 `45873`；`DSH_ZOO_SKIN_PORT` 可覆盖；被占就 +1 重试（最多 10 个）。
- 路由（只读）：
  - `GET /dsh-zoo-skin/manifest` → manifest JSON。
  - `GET /dsh-zoo-skin/asset/<name>` → WebM，支持 Range。
  - 其他一律 404，不列目录。
- 本机素材源配置：`<dataDir>/skin.json`：

```json
{
  "sources": [
    { "id": "dsh-pet", "dir": "~/.dsh/profiles/desktop/node_modules/dsh-pet/assets/webm", "size": 462 }
  ]
}
```

- 没配置时自动把 dsh-pet 的素材目录作为 `dsh-pet` 源（L0 照旧）。
- 动作 id = 文件名去掉 `.webm`；manifest 的 `idle` 取 `待机呼吸休闲`，没有就用第一段。

## 接收端

宿主负责解析，helper 不联网：

1. 本机某个源有同名动作 → 用本机文件。
2. 缓存命中（源 + 动作 + hash）→ 用缓存。
3. 远端拉：manifest（TTL 10 分钟）→ 动作文件 → `<dataDir>/skin-cache/<sha256>.webm`。
   扁平内容寻址：同一个 hash 跨来源共享，helper 的 `dshzoo://cache/<sha256>.webm` 直接对得上。
4. 都失败 → 场景给 `fallback`，渲染端画通用小人。

限制：单请求 2 秒超时；单文件 ≤8 MB；manifest ≤256 KB；缓存总量 ≤200 MB（LRU）。
helper 的协议根增加 `dshzoo://cache/<sha256>.webm`。

## 安全

- 只连私网地址（`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`127/8`），其他一律拒绝。
- 只接受 `video/webm`，校验 EBML 魔数 `1A 45 DF A3`。
- 有 hash 必须校验；没 hash 的文件不落盘（直接拒绝）。
- 文本转义、限长、不渲染 HTML/Markdown。
- 每来源限速：manifest 1 次/分钟，素材 20 次/分钟。
- 一个源坏了只影响它自己的访客；不影响串门、记录、其他访客。

## 降级

| 对方给了什么 | 桌面显示什么 |
| --- | --- |
| 清单 + 素材 | 完整宠物，按动作播 |
| 只有动作名 | 本机同名素材；没有就通用小人 |
| 动作名都没有 | 通用小人（名字 + 颜色 + 中性待机） |
| 素材坏 / 超限 / 非 WebM | 通用小人，拒收该文件 |
| 对方中途离线 | 现有规则：2 分钟失联清场，缓存保留 |

## 测试决定

- 纯函数：manifest 校验、动作解析优先级（`action` > `anim` > fallback）、缓存键、私网判定、文本清洗、hash 校验。
- 单元：素材源路由只回白名单文件；Range 与 `dshzoo://` 一致；限速。
- 集成：两个 service 实例 + fake peer，A 提供 skin，B 拉到并出现在场景；坏包/超时/非 WebM 各自降级。
- 冒烟：helper 截图里同时出现远端素材宠物和通用小人。

## Out of Scope

- GIF / Spine / Live2D 等通用动画格式（不认就通用小人）。
- 跨端监控、远程控制、替对方安装插件。
- 公网 / NAT / 跨网段。
- 串门时推送视频本体（只拉）。
- 插件注册素材的 HTTP API（先配置文件；后续再加）。
