# 70: 农场窗口的季节 UI

**What to build:** 在 `desktop/farm.html` / `desktop/farm.js` 里加季节条、节日卡、来客卡、枯萎卡；
不新增 tab，不重做布局。

**Blocked by:** 68、69

**Status:** ready-for-agent

## 结构

- [ ] 顶栏下、tabs 上：`#season-bar` > `#season-calendar`（四格）+ `#season-remaining`
- [ ] `#page-farm` 内、`#visitor-banner` 上方：`#omen-card`、`#event-card`
- [ ] 枯萎卡沿用 `article.plot-card`，`data-stage="withered"`
- [ ] 不加 `data-tab`；农场 tab 仍是默认页

## 样式

- [ ] `.season-bar` / `.season-cell` / `.season-cell.today` / `.season-cell.past`
- [ ] `.season-warning`：最后 4 小时暖色
- [ ] `.event-card`：目标、进度条、奖励、领取按钮；完成后按钮高亮
- [ ] `.omen-card`：深色/琥珀色，两个按钮；结果态只显示结果
- [ ] `.plot-card[data-stage="withered"]`：灰褐、降低饱和、角标"枯萎"
- [ ] `body[data-season="spring|summer|autumn|winter"]` 只改强调色/背景渐变
- [ ] 窄窗（<420px）下季节四格仍一行；文字省略不换行

## 渲染

- [ ] `farm.js` 加 `season` 状态；`renderSeason()` / `renderEvent()` / `renderOmen()`；
      `render()` 调用；`onState` 更新；`onResult` 处理
- [ ] 领奖/来客按钮走 `submit`，带 `expectedStart` / `choice`
- [ ] 换季：`season.start` 变了 → toast「秋天到了 · 丰收祭」；`body.dataset.season` 更新
- [ ] 倒计时每秒刷新 `#season-remaining`；跨 4 小时阈值切换 warning
- [ ] 日志 `wither/season/event/omen` 中文文案
- [ ] 访客/看田模式隐藏 `#omen-card` 和 `#event-card`，只画地块

## 验收

- [ ] 窗口打开即见季节条；四格今天高亮
- [ ] 种满 8 块后节日卡变"领取"；点一下硬币/露水变化、toast
- [ ] 秋天来客卡出现；守夜/投喂各点一次，结果正确
- [ ] 枯萎地只能"重种"；重种后恢复正常生长
- [ ] `test/farm-ui-css.test.js` 静态断言所有新 id/选择器；`smoke:desktop` 通过
