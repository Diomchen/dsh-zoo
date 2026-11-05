# SPEC v4 · 带派：串门捎东西

> 承接 [ADR-0011](../../docs/adr/0011-bring-gift-on-visit.md)。
> v3 的发现、放行、串门、记录、桌面层、跨插件素材全部保留；本文只加「礼物」这一层。

## Problem Statement

串门到现在只交换三样轻东西：我是谁、我在干嘛、我说一句。用户要的是：**出门前给宠物带一件东西**
——一段文字、一张图片、一个文件——到了邻居家留下。

约束是硬的：UDP 单包 4 KiB（文件进不去）；桌面主窗不能打字、不能拖拽（`focusable:false`）；
入站访客没有 TTL（礼物不能做成一次性弹窗）；跨机文件已有先例是**拉取**（ADR-0008）。

## Solution

一次串门带一件礼物，两种形态：**字条**（内联在 `visit-request`，≤500 字）和**文件**
（≤16 MB，由接收方在访客抵达时向对方拉取，校验大小与 sha256）。到了对方家落进隔离目录，
桌面上贴着访客出现一张**礼物卡**；访客走了卡片收起，礼物留下。

发送端有一个**背包**：最多两件，先放的先带走；没送到的退回来。送达以对方的**回执**为准。

## 与 v3 的差别

**留**：UDP 发现、放行、心跳、串门状态机、`visits.json`、桌面层、`dshzoo://`、素材源。

**改**：

- `visit-request` 多一个可选字段 `gift`；新增报文类型 `gift-received`。
- 素材源从「只供素材」泛化成 `src/lan-server.js`，同一个端口上多一条礼物路由。
- 场景 `controls` 多一个 `gifts` 数组；helper 的 `dshzoo://` 多一个 `gifts/` 根。
- `visits.json` 的记录多一个可选 `gift` 字段；`/dsh-zoo/state` 多 `backpack` 与 `gifts`。
- `src/room.js` 多一份入站礼物状态（pending / receiving / received / failed / refused）；
  `src/service.js` 多一条拉取与回执链路；`src/backpack.js` 是新的。

**删**：无。

## 礼物（wire）

只出现在 `visit-request` 里，一个可选对象；一次串门最多一件：

```json
{ "v": 1, "type": "visit-request", "deviceId": "…", "visitId": "…", "nickname": "楼下的柯基",
  "gift": { "id": "…uuid…", "kind": "text", "text": "给你留了张便条…" } }

{ "v": 1, "type": "visit-request", "deviceId": "…", "visitId": "…", "nickname": "楼下的柯基",
  "gift": { "id": "…uuid…", "kind": "file", "name": "报价单.pdf", "size": 23194,
            "sha256": "sha256:…64hex…" } }
```

规则：

- `id` 是 UUID 形状（复用 `isVisitId`），是线路上的键、也是拉取路径的唯一键；
  **不是**落盘目录名（目录名见「存储与限额」，两者由 `receivedAt` 确定性关联）。
- `kind` 只能是 `text` / `file`；别的值整条 `gift` 丢弃。
- `text`：≤500 码点；清洗时**保留换行**，去掉其余控制字符与双向覆盖符，首尾空白裁掉。
- `name`：≤120 码点，清洗掉路径分隔符、控制字符与前导点；清洗后为空就用 `file`。
- `size`：整数，`1 … 16 MiB`。
- `sha256`：`sha256:` + 64 位小写十六进制。
- **礼物坏了不让串门失败**：`gift` 校验不过就整条丢掉，串门照常发生，接收方只是没卡片。
  （这与 `anim` 非法整包丢弃不同：一道便条不该把一次串门搞砸。）
- 编码后整包超过 4 KiB：丢掉 `gift` 重编一次，并在本机说一句「字条太长了，这次没带上」。
  实测最坏基准包 945 B，加 500 码点 emoji 字条约 3.0 KB —— 正常触不到，这是**防御路径**。
  重编必须留在**编码层**：`encodePacket` 超限是裸 `throw`（没有可判别的 code），
  调用方没法在 service 里安全地 catch 后猜原因。
- 旧版本收到 `gift` 直接忽略（白名单重建）；新版本收到旧报文就是没有礼物。

`gift-received`（接收方 → 发起方）：

```json
{ "v": 1, "type": "gift-received", "deviceId": "…", "visitId": "…", "giftId": "…uuid…" }
```

- 只在文件/字条**真的写进 `gifts/` 之后**发；发 3 次（间隔 400ms），任意一次送达即可（幂等）。
- 发起方收到才把背包里那件删掉；重复回执照旧忽略。

## 礼物源（HTTP，只读）

同一个服务、同一个端口（默认 `45873`，`DSH_ZOO_SKIN_PORT` 可覆盖）：

```
GET /dsh-zoo-gift/<giftId>   → 文件本体
```

- **只在 armed 期间可读**：发起方发出这次串门请求之后 5 分钟内，且该次串门没有结束。
  其他时间一律 `404`；不列目录、不认识任何别的路径。
- 只读**背包里登记过的那一个绝对路径**：报文里没有任何路径字段，路由也不拼用户输入。
- 响应 `200` + `Content-Type: application/octet-stream` + `Content-Length`；v1 不做 Range。
- 文件在发送之后被改动或删掉（大小或 sha256 不符）→ `410 gone`，不发字节。
- 超过 16 MiB → `413`。
- 串门结束（回家 / 送客 / 超时 / 失联）立即 unarm。

## 接收端流程

1. 收到 `visit-request`：按上面的规则校验 `gift`；建访客；卡片 `pending`。
2. **字条**：清洗 → 写 `gifts/<giftId>/note.txt` + `meta.json` → `received` → 回执。
3. **文件**：先做限额与限速判定（超了 → `refused`，不落盘、不回执）→ `receiving`
   → `GET http://<邻居地址>:<skinPort>/dsh-zoo-gift/<giftId>`（连接 5s / 总计 20s、≤16 MiB）
   → 校验 sha256 → 写临时文件再 rename → `received` → 回执。
   失败 → `failed`，原因只记 `timeout` / `refused` / `checksum` / `too-large` / `no-port` / `write`。
4. 对方没广告 `skinPort`：`no-port`，卡片直接说「对方没开素材端口，东西取不回来」。
5. 同一来源失败后冷却 60 秒（与 `src/skin-fetch.js` 一致），冷却期内不再重试。
6. 一个坏礼物只影响这一张卡片：串门、记录、其他访客照常。

## 背包（发送端）

`<dataDir>/backpack.json`（可手改、可删；删了就是空背包）：

```json
{ "version": 1, "items": [
  { "id": "…", "kind": "text", "text": "给你留了张便条", "at": 1700000000000, "state": "idle" },
  { "id": "…", "kind": "file", "path": "/Users/me/报价单.pdf", "name": "报价单.pdf",
    "at": 1700000000001, "state": "out", "visitId": "…" }
] }
```

- 最多 **2** 件；满了拒绝放进（`backpack-full`），不静默丢旧的。
- **先放的先带走**：出门时取 `at` 最小的那件。
- 文件件只存**路径**，不复制；`size` / `sha256` 在**发送那一刻**才算（用户可能改过文件）。
  文件不在了/读不了 → 这次不带，留在背包，本机说一句「那个文件找不到了」。
- `out` = 正在捎出（带 `visitId`），等回执；串门结束还没回执 → 回 `idle` + 一句「没送到」。
- 只有 `idle` 能撤掉；`out` 中不可撤（东西可能已经在对方磁盘上了）。
- 手动与自发**同一条规则**：取 `at` 最小的那件。想换就先在「带派」小窗里把不想带的撤掉，不另做选择器。

## 桌面卡片

场景 `controls` 多一个数组，渲染端只按它画、不自己判断：

```json
"gifts": [ { "deviceId": "…", "giftId": "…", "kind": "text", "text": "…",
             "status": "received" },
           { "deviceId": "…", "giftId": "…", "kind": "file", "name": "报价单.pdf",
             "size": 23194, "status": "received", "thumb": "dshzoo://gifts/<id>/<name>" } ]
```

- `status`：`pending`（刚到）/ `receiving`（取回中）/ `received`（收下了）/
  `failed`（没取到）/ `refused`（没收下）。
- `text` 只在 `received` 时给；卡片最多显示 8 行，超出省略——全文用「打开」看 `note.txt`。
- `thumb` 只给 `jpg` / `png` / `gif` / `webp` 且取回成功的文件；其余给文件图标。
- 卡片贴在访客旁边；矩形进 `overlay-rects`，其余部分照旧穿透。
- 动作（走既有 action 事件，宿主只认本地来路）：
  `gift-open` / `gift-reveal` / `gift-discard`，字条另有 `gift-copy`。
- **卡片跟着访客**：访客回家/被送客/失联 → 卡片收起。`gift-discard` 之后永不再出现。
- 入站串门结束时（送客 / 对方召回 / 失联 / 清场）若这件礼物一次都没打开过，
  冒一句：「「楼下的柯基」捎来的东西还在 gifts 里。」

### 跨进程字段要过的四道白名单

任何新字段（`gift` / `gifts[]` / `giftId`）都要**各自**过一遍，漏一处就是静默丢字段：

1. wire：`src/protocol.js`（编解码 + 解析）
2. 宿主：`src/desktop-pets.js` 的 `controlsFromSnapshot`
3. helper：`desktop/shared.js` 的 `emptyControls` / `normalizeControls` / 动作白名单
4. 渲染：`desktop/renderer.js` 的 `uiRects` / `requestAction`

`giftId` 还额外要过三处只转发 `deviceId` / `name` / `nickname` 的窄口：
`src/service.js` 的 `handleDesktopAction`、`desktop/preload.js`、`desktop/shared.js` 的动作归一化。

## 存储与限额

- 目录：`<dataDir>/gifts/<dir>/`，`dir` = `<yyyyMMdd>-<HHmmss>-<id 前 8 位>`（形如
  `20261103-153245-ab12cd`）——由 `receivedAt` 与 `id` 确定性推出，一眼能看出什么时候到的；
  `id` 本身仍是 UUID，拼路径前一律严格正则，绝不信报文里的字符串。
- `meta.json` 同时记 `id` 与 `dir`。宿主在内存里保留本次运行收到的礼物；重启后按 `meta.json`
  扫描 `gifts/`（≤200 个目录）来定位，不另建索引文件——卡片本来就跟着这一次串门走。
- `meta.json`：`{ version, id, from: { deviceId, nickname }, kind, name?, size?, sha256?, text?,
  receivedAt, opened }`。字条正文在这里留一份，`note.txt` 是给人看的那份。
- 单件 ≤16 MiB；`gifts/` 总量 ≤500 MiB 且 ≤200 件，超了按 `receivedAt` 删最旧（整目录删）。
- 同一邻居 ≤10 件/小时、≤50 件/天；超了 `refused`（原因 `rate`），不落盘、不回执。
- 「扔掉」= 有磁盘记录就立即删目录；没有记录（`pending` / `receiving` / `failed` / `refused`）
  只拉黑、不碰文件。两种情况都记进本次运行的黑名单，卡片立刻消失。
- 载入 `gifts/` 时清掉**没有有效 `meta.json` 且 mtime 超过 1 小时**的目录（拉取中断留下的
  `.part`）；刚写了一半的新目录不动。运行中的限额清理仍然不删陌生目录。

## 记录与状态出口

- `visits.json` 每条记录多一个可选字段：`gift: { kind: "text" | "file", name?: string }`
  ——**不记字条正文**。缺字段的旧文件照常读；字段非法就丢掉这一个字段，不丢整条记录。
- `GET /dsh-zoo/state` 多两项：

```json
"backpack": [ { "id": "…", "kind": "text", "text": "…", "at": 1700000000000, "state": "idle" } ],
"gifts":    [ { "id": "…", "from": { "deviceId": "…", "nickname": "…" }, "kind": "file",
                "name": "报价单.pdf", "size": 23194, "at": 1700000000000,
                "status": "received", "path": "/Users/me/.dsh/dsh-zoo/gifts/…/报价单.pdf" } ]
```

  `gifts` 只列最近 20 条，最新在前。

- `POST /dsh-zoo/action` 新增：

| action | 入参 | 说明 |
| --- | --- | --- |
| `bring` | `{ kind:"text", text }` 或 `{ kind:"file", path }` | 放进背包 |
| `unbring` | `{ giftId }` | 从背包撤掉（仅 `idle`） |
| `gift-open` | `{ giftId }` | 用系统程序打开（字条=note.txt，文件=本体） |
| `gift-reveal` | `{ giftId }` | 在文件夹里显示 |
| `gift-discard` | `{ giftId }` | 扔掉：有磁盘记录删目录，没有记录只拉黑（卡片一样立刻消失） |
| `gift-copy` | `{ giftId }` | 字条正文进剪贴板（宿主读 `note.txt` → `gift-copy` 命令 → helper 的 `clipboard.writeText`） |

  错误码：`bad-gift` / `too-large` / `backpack-full` / `no-such-file` / `gift-not-found` /
  `open-failed` / `gift-out`.

## 安全

- 礼物路由**不信任报文里的任何路径**；只读背包登记的本机绝对路径。
- 只连私网/回环地址（复用 `isPrivateAddress`）。
- 大小与 sha256 双校验；不符不落盘；先写临时文件再 rename，不产生半个文件。
- 文件名清洗：去路径分隔符、控制字符、前导点，≤120 码点，空则 `file`；
  目录已存在就加后缀，绝不覆盖已有礼物。
- **永不自动打开、永不执行**；卡片用 `textContent`，不渲染 HTML/Markdown。
- 连接 5s / 总计 20s 超时；单件 16 MiB；每来源失败后冷却 60s。
- 没装素材源的用户也会监听这个端口——它必须保持**只读、只按 id 白名单、不列目录**。

## 降级

| 情况 | 发送方看到 | 接收方看到 |
| --- | --- | --- |
| 对方版本旧 / 没开端口 | 串门结束时「没送到」，退回背包 | 无卡片（旧端忽略字段） |
| 文件太大 / 校验不过 / 超时 | 同上 | 卡片「没取到」+ 原因 |
| 超过限额或限速 | 「没送到」，退回背包 | 卡片「没收下」+ 原因 |
| 本机文件被删 / 改过 | 出门前「那个文件找不到了」 | 不变 |
| 礼包超 4 KiB | 本机「字条太长了，这次没带上」 | 无卡片，串门照常 |

## 测试决定

- **纯函数**：`gift` 编解码与白名单、长度边界、note 清洗（保留换行）、文件名清洗、
  4 KiB 溢出时丢 gift 不丢串门、`meta.json` 归一化、限额裁剪顺序。
- **单元**：背包读写（损坏 / 满 / 撤回 / 回执退包 / 源文件消失）；快照 → `controls.gifts` 映射；
  状态出口形状；`visits.json` 的 `gift` 字段向后兼容。
- **集成**：两个 service 实例 + fake peer——字条端到端（含记录）；文件端到端（含 sha256 不符、
  超时、410、413）；回执与退包；限额拒绝；不带 `gift` 的旧报文不受影响。
- **冒烟**：helper 截图里能看到礼物卡（字条 / 文件 / 图片三种），点「扔掉」后卡片消失。

## Out of Scope

- 文件夹、多选、URL/链接卡片、礼物历史界面。
- 「只把东西带过去、人不进门」、递给访客带回家、回礼确认。
- 单独的「不收礼物」开关。
- 礼物内容的端到端加密（局域网信任模型未变）。
- 大于 16 MB 的文件（请用别的工具）。
