# 71: 桌面白名单、归一化与 main 转发

**What to build:** 把新动作、季节形状、`withered` 阶段接进 `desktop/shared.js` 和
`desktop/main.js`；窗口收到的每个字段都先过严格校验。

**Blocked by:** 68

**Status:** ready-for-agent

## 动作

- [ ] `FARM_EVENT_ACTIONS = ['farm-event-claim']`
- [ ] `FARM_OMEN_ACTIONS = ['farm-omen-resolve']`
- [ ] 两者加进 `FARM_ACTIONS`；`CONTROL_ACTIONS` 通过 `...FARM_ACTIONS` 自动包含
- [ ] `main.js` 的 `DESKTOP_ACTIONS` 检查不变；转发时补 `expectedStart`（数字）与
      `choice`（`guard|feed`）
- [ ] `normalizeFarmAction`：
  - `farm-event-claim`：只留 `expectedStart`，必须是有限数字
  - `farm-omen-resolve`：只留 `choice`、`expectedStart`；choice 白名单

## 常量与形状

- [ ] `FARM_STAGES` 加 `'withered'`
- [ ] `FARM_LOG_KINDS` 加 `'wither','season','event','omen'`
- [ ] `normalizeFarmPlot`：接受 `stage:'withered'`，输出 `withered:true`；其余阶段 false
- [ ] `normalizeFarmLogEntry`：新 kind 允许无 `plotId`；`qty` / `crop` / `result` 可选并夹取
- [ ] `normalizeSeason(raw)`：
  - 必填 `id` 在四季内、`name` ≤8 字、`emoji` ≤8 字、`start/end/remainingMs` 数字
  - `calendar` 恰好 4 项，顺序固定；缺项用内置表补齐
  - `event`：`id`、`name`、`requirement.kind`（plant/harvest/sell/water）、`requirement.qty` 1–999、
    `progress` 0–999、`ready`/`claimed` 布尔、`reward.coins` 0–1e6、`reward.dew` 0–48
  - `omen` 可为 null；有值时校验 `id/name/text/resolved/choices`，`choices` ≤2，
    `choice.id` 在 `guard|feed`，`chance` 0–1，`cost` 0–99
- [ ] `normalizeFarmWindow` 增加 `season: normalizeSeason(raw.season)`；缺省为 null
- [ ] 老宿主没有 `season` 时，桌面隐藏季节 UI，不抛

## 验收

- [ ] 伪造 `season` 缺字段/多字段/错季节 → 被丢弃或夹取，不进入 DOM
- [ ] `farm-omen-resolve` 的 `choice:'hack'` 被拒；`expectedStart:'x'` 被拒
- [ ] `normalizeFarmPlot({stage:'withered'})` → `withered:true`
- [ ] `test/shared.test.js` 覆盖新动作与形状；`test/menu-actions` 之类不回归
- [ ] `node --check desktop/shared.js`、`node --check desktop/main.js` 通过
