# 73: 文档、ADR 与 1.5.0 发布

**What to build:** 把季节层的决策写成 ADR，更新玩家文档和术语表，版本升到 1.5.0；
不改 LAN 协议文档（季节是本地规则）。

**Blocked by:** 72

**Status:** done

## ADR

- [x] `docs/adr/0020-season-clock.md`：1 天 1 季、4 天一轮、本地 00:00、锚点 2026-10-26；
      为什么不存季节、为什么不用启动时间
- [x] `docs/adr/0021-seasonal-crops-and-withering.md`：四种四季作物、当季 +10%、
      方案 B（未熟枯萎/成熟保留/旧六种安全）；为什么只打四季作物
- [x] `docs/adr/0022-seasonal-omen.md`：卡片式来客、不做实时 boss、秋·熊獾、
      中惩罚（失败 3 个/忽略 1 个仓库作物）、每 4 天一次
- [x] ADR 之间互相引用，并回指 SPEC v8

> 三份 ADR 已在规划阶段落好；本票只做玩家文档、版本号和发布说明。

## 文档

- [x] `README.md` 农场章节加"四季 / 节日 / 季候来客"三小节；快速开始不变
- [x] `README.md` 已知限制加：季节按本地时钟；改系统时间会改季节；只有秋·熊獾
- [x] `CONTEXT.md` 加术语：季节、季相、当季、四季作物、枯萎、节日、季候来客、守夜、投喂
- [x] `desktop/README.md` 加窗口结构：`#season-bar`、`#event-card`、`#omen-card`、枯萎卡
- [x] `docs/release.md` 或 release notes 写 1.5.0：新增什么、没改什么、怎么回退
- [x] `package.json` 版本 1.4.1 → 1.5.0
- [x] 不修改 `docs/protocol.md`；如果发现必须改协议，停下来回到 SPEC 重新评估

## 验收

- [x] 三份 ADR 的"Decision / Consequences"完整，不是复述 SPEC
- [x] README 的新章节能让没玩过的人知道：今天什么季、能种什么、节日怎么领、熊獾怎么选
- [x] `npm run check` 全绿；`npm pack --dry-run` 包含新 `src/season-*.js` 和 `desktop/crops/*.svg`
- [x] 版本号、release note、SPEC 状态一致（SPEC v8 可标 done）
