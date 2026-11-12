# 请在这台 Windows 上验证（dsh-zoo 票 61 + 62）

这是 macOS 那台机器的工作树快照（含 `test/`，安装包 tgz 里是没有 `test/` 的）。
目标：确认「雇佣时间不准/倒流」已修好，并且测试只剩一档、全绿。

## 0. 环境信息（先回给我）

```powershell
node -v
node -p "process.platform + ' ' + process.arch"
Test-Path "$env:USERPROFILE\.dsh\electron\electron.exe"
```

## 1. 全部用例（应该 708 个，全绿，约 10 秒）

```powershell
cd <解包目录>
npm test
```

只贴最后 12 行和 `# fail` 那几行即可。

## 2. 新用例（4 个，专门抓这次的「时间不准 + 倒流」）

```powershell
node --test test/contract-countdown.test.js
```

## 3. 跨机时钟用例（合同锚点只用本机钟）

```powershell
node --test --test-name-pattern="时钟快 30 分钟" test/work-e2e.test.js
```

## 4. 真窗口倒计时回路（真 Electron + 真 desktop/farm.js，最接近用户看到的东西）

需要 `%USERPROFILE%\.dsh\electron\electron.exe` 存在（上面第 0 步已经查过）。

```powershell
node .scratch/dsh-zoo/debug-contract-clock/run.mjs
```

期望输出（每条都是 PASS）：

```
PASS 空闲 3 秒，倒计时走了 2s（应 ≈3s）
PASS 阻塞 5 秒，倒计时走了 6s（应 ≥4s；只走 1s 就是 setInterval 逐拍递减）
PASS 切走 3 秒再回来，倒计时走了 4s（应 ≥3s；负数=倒流，0=时间停住）
PASS 整段 11s，倒计时一共走了 12s（应 ≈11s）
```

如果报「找不到 Electron」，跳过这一步并说明。

## 回报格式

每一步贴：`exit code` + stdout 尾部（20 行以内）。任何一步红，把完整报错和断言文本贴出来，
不要自己改代码。
