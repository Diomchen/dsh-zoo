# 64: 四种四季作物与种子店

**What to build:** 在 `BUILTIN_CROPS` 里加豌豆、西瓜、稻米、白萝卜；四季作物只能当季种、
当季买种子；旧六种数值和手感一字不改。

**Blocked by:** 63

**Status:** ready-for-agent

## 数值

| id | 名字 | 季 | 生长 | 种子 | 产量 | 基价 |
|---|---|---|---|---|---|---|
| `pea` | 豌豆 | 春 | 25 分钟 | 6 | 3 | 4 |
| `watermelon` | 西瓜 | 夏 | 6 小时 | 30 | 8 | 10 |
| `rice` | 稻米 | 秋 | 3 小时 | 18 | 10 | 4 |
| `radish` | 白萝卜 | 冬 | 90 分钟 | 10 | 6 | 4 |

## 范围

- [ ] `src/farm-rules.js`：`BUILTIN_CROPS` 增加四条；`CROP_IDS` 变成 10 个；
      旧六条字段和数值不动
- [ ] `src/season-rules.js`：`cropSeason` 认这四张脸；运行时目录里的自定义作物不算四季作物
- [ ] `src/farm.js` 的 `plant`：四季作物在错误季节返回 `out-of-season`；旧六种不受影响
- [ ] `src/farm.js` 的 `buySeed`：四季种子在错误季节返回 `out-of-season`；
      卖作物不受季节限制
- [ ] `src/service.js` 的 `cropCatalogView()`：每条加可选 `season`，值来自 `cropSeason(id)`
- [ ] `src/farm-text.js`：`out-of-season` 的中文文案（"这个季节种不了它" / "下季才有"）
- [ ] `desktop/crops/{pea,watermelon,rice,radish}.svg`：四张 64×64 左右的简笔图，
      和现有六张同一风格；文件可被 `<img>` 加载
- [ ] `desktop/farm-view.js` 的 `BUILTIN_META` 加四条的 `name/emoji/art/seedPrice/base/growMs/yield`

## 兼容

- 运行时目录（ADR-0019）仍可加作物；自定义作物一律中性，没有季节限制。
- 老存档里的旧六种照常长；不因为新增四种改 `MAX_CROPS`（仍 64）。
- 市场深度、解锁曲线、堆叠上限都不改；新作物自动进入 `stacks()`。

## 验收

- [ ] 春天能种豌豆、不能种西瓜/稻/萝卜；夏天反过来；四季各一条用例
- [ ] 春天能买豌豆种子、不能买西瓜种子；卖西瓜（库存）仍然可以
- [ ] 旧六种在任何季节都能种，生长时间与 v1.4.1 完全一致
- [ ] 农场窗口的种子袋/市场出现四种新作物，图能显示
- [ ] `npm test` 里旧的"六种作物"断言全部更新为十种，且没有漏改
