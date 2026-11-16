# 77 · 铲除地块

**Status:** ready-for-agent

## Problem

种错季节、想换作物，或冬天地块冻住又不想付解冻费时，地块没有低成本的退出方式；
只能等成熟，或者让四季作物换季枯萎。

## Solution

- 新增 `farm-clear`（桌面 `farm-clear`，只带 `plotId`），把生长中或冻住的作物清成空地。
- 免费，不退种子、不产作物；记一条 `clear` 日志。
- 成熟返回 `plot-mature`，枯萎返回 `withered`，空地返回 `plot-empty`。
- 窗口第一次点显示“确认铲除？”，4 秒内再点才发请求；只在主人视图出现。
- 同步 README、CONTEXT、desktop README、ADR-0025、release 1.6.1。

## Acceptance

- 生长中铲除后地块为空、种子/硬币/露水不变，日志为 `clear`。
- 冻住的地可直接铲除，不扣 2 露水 + 5 硬币。
- 成熟/枯萎/空地分别返回 `plot-mature` / `withered` / `plot-empty`。
- 窗口只给生长中和冻住的地显示铲除；两段点击生效。
- `npm run check` 全绿。
