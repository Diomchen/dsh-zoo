# dsh-zoo 票 61/62 · Windows 一键验收（在 DESKTOP-699DN63 上跑）
#
# 前置：两个包已经由 cross-agent 推到这台机器：
#   dsh-zoo-verify-61-62.tar.gz        工作树快照（含 test/，12.7 MB）
#   dsh-zoo-harness-win-fix.tar.gz     真窗口回路的 Windows 补丁（4.6 KB）
# 找不到就自己搜：
#   Get-ChildItem -Path $env:USERPROFILE,C:\,D:\ -Filter dsh-zoo-verify-61-62.tar.gz -Recurse -ErrorAction SilentlyContinue
#
# 用法：powershell -ExecutionPolicy Bypass -File verify-windows.ps1 -Package "C:\path\to\dsh-zoo-verify-61-62.tar.gz" -Patch "C:\path\to\dsh-zoo-harness-win-fix.tar.gz"

param(
  [Parameter(Mandatory = $true)][string]$Package,
  [string]$Patch = '',
  [string]$WorkDir = 'C:\temp\dsh-zoo-verify'
)

$ErrorActionPreference = 'Stop'
$results = @()

function Step([string]$name, [scriptblock]$body) {
  Write-Host ''
  Write-Host ('=== ' + $name + ' ===') -ForegroundColor Cyan
  $code = 0
  try {
    & $body
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
  } catch {
    Write-Host ($_ | Out-String) -ForegroundColor Red
    $code = 1
  }
  $script:results += [pscustomobject]@{ step = $name; exit = $code }
  Write-Host ('--> exit ' + $code) -ForegroundColor ($(if ($code -eq 0) { 'Green' } else { 'Red' }))
}

Write-Host ('node: ' + (node -v))
Write-Host ('platform: ' + (node -p "process.platform + ' ' + process.arch"))

New-Item -ItemType Directory -Force $WorkDir | Out-Null
tar -xzf $Package -C $WorkDir
if ($Patch -ne '') { tar -xzf $Patch -C $WorkDir }
Set-Location $WorkDir

Step 'A 全部用例（应 708 全绿）' { node scripts/run-tests.mjs }
Step 'B 合同倒计时（4 个）' { node --test test/contract-countdown.test.js }
Step 'C 跨机时钟（1 个）' { node --test --test-name-pattern="时钟快 30 分钟" test/work-e2e.test.js }

$electron = Join-Path $env:USERPROFILE '.dsh\electron\electron.exe'
if (Test-Path $electron) {
  Step 'D 真窗口倒计时回路（4 个 PASS）' { node .scratch/dsh-zoo/debug-contract-clock/run.mjs }
} else {
  Write-Host '没有 electron.exe，跳过 D' -ForegroundColor Yellow
  $results += [pscustomobject]@{ step = 'D 真窗口回路'; exit = 'skipped' }
}

Write-Host ''
Write-Host '=== 汇总 ===' -ForegroundColor Cyan
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { $_.exit -ne 0 -and $_.exit -ne 'skipped' })
if ($failed.Count -eq 0) {
  Write-Host 'ALL GREEN' -ForegroundColor Green
  exit 0
}
Write-Host ('失败：' + ($failed.step -join ', ')) -ForegroundColor Red
exit 1
