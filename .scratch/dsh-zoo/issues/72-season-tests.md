# 72: 季节测试：规则、存储、农场、窗口、e2e

**What to build:** 按 SPEC v8 的 Testing Decisions 补齐测试；所有时间用注入的 `farmNow`，
所有随机用注入的 `farmRandom`，不 sleep、不碰网络。

**Blocked by:** 63–71

**Status:** ready-for-agent（仅剩真机 desktop smoke 手工复验）

## 新文件

- [x] `test/season-rules.test.js`
  - 锚点 2026-10-26 春；10-27 夏；10-28 秋；10-29 冬；10-30 春
  - 2026-11-13 秋；11-13 23:59 的 `remainingMs`；11-14 00:00 冬
  - 跨月/跨年/闰年；`seasonSegments` 跨午夜分成两段
  - `cropSeason` 四种；旧六种 null；`seasonGrowthFactor` 1.1 / 1
- [x] `test/season-store.test.js`
  - 懒创建；损坏回退；`note` 累加；`claim` 一次；跨日重置；`settle` 返回 changed
- [x] `test/season-omens.test.js`
  - 守夜成功/失败；投喂；不足 3 个；忽略；`random` 固定
- [x] `test/farm-season.test.js`
  - 错季拒种；当季 +10%；换季枯萎 B；成熟保留；旧六种不枯；枯萎地操作拒绝；覆盖重种；
    离线跨午夜只补 12 小时
- [x] `test/season-window.test.js`
  - `seasonView` 形状；`farm-window`/`/state` 带 season；日历 today/past；节日 ready/claimed；
    来客卡只给 owner；look/visitor 不带
- [x] `test/season-e2e.test.js`
  - 单 service（季节是本地时钟，不做 LAN 同步）：种/收/卖/浇 → 计数 → 领奖 → 账对
  - 秋·熊獾守夜成功/失败、投喂、重复 resolve、跨季未处理
  - 重启后 `season.json` 不重复领/不重复结算

## 更新

- [x] 旧的“六种作物”计数、种子袋、市场行、`MAX_FARM_CROPS` 断言改成十种
- [x] `test/farm-window.test.js`：静态断言 `#season-bar`、`#season-calendar`、`#event-card`、
      `#omen-card`、`data-stage="withered"`
- [x] 季节主题/枯萎卡/窄窗一行由 `test/season-window.test.js` 的静态契约覆盖；
      `test/farm-ui-css.test.js` 保留原有农场窗口 CSS 契约
- [x] `test/season-shared.test.js`（代替 `shared.test.js`）：`FARM_STAGES`、`FARM_LOG_KINDS`、
      `normalizeSeason`、新动作
- [x] 不新增任何开 socket 的用例；不恢复票 62 删掉的网络档

## 验收

- [x] `npm test` 全绿，用例数比 v1.4.1 增加但不出现长时间挂起
- [x] `npm run check` 全绿
- [ ] `node scripts/desktop-smoke.mjs` 手工通过（窗口能开、季节条能画）
- [x] 测试里没有 `setTimeout` 等真实时间；没有对 `Date.now` 的直接依赖

## 验证记录（2026-11-13）

- 8 个季节测试文件：62/62 pass。
- 全量 `npm test`（新增两条重启用例前）：773 tests / 772 pass / 0 fail / 1 skip；
- 全量 `npm test`（新增两条重启用例后）：775 tests / 774 pass / 0 fail / 1 skip；
- `node scripts/desktop-smoke.mjs` 连续两次分别卡在
  `真实光标进入命中区` 与 `光标进命中区后窗口可交互`，日志显示
  `hoverInside:false`、`ignoring:true`，失败点与季节代码无关；需在可交互桌面上手工复验。
