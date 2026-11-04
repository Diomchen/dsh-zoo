<#
  真实 OS 左键，给桌面冒烟用（ticket 30）。

  为什么不用 Electron 的 sendInputEvent：它走的是 Chromium 的输入管线，窗口只要「看起来」
  可交互就能收到——现场那个 bug 恰恰是「窗口说可交互、真实左键却没进渲染端」，只有真的
  经过 Windows 输入队列的 SetCursorPos + mouse_event 才能覆盖。

  用法：
    -Mode move -X 100 -Y 200
    -Mode drag -X 100 -Y 200 -ToX 190 -ToY 200 -HoldMs 600

  坐标是物理像素；调用方负责把 Electron 的 DIP 乘上 scaleFactor。
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('move', 'drag')][string]$Mode,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [int]$ToX = $X,
  [int]$ToY = $Y,
  [int]$HoldMs = 600
)

Add-Type -Namespace LocalPet -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, System.UIntPtr dwExtraInfo);
'@

[LocalPet.Native]::SetCursorPos($X, $Y) | Out-Null
if ($Mode -eq 'move') { exit 0 }

# 先让窗口跟着 hover 翻转成可交互（真机上这一步可能要几十毫秒到几百毫秒）。
Start-Sleep -Milliseconds 250

[LocalPet.Native]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)   # MOUSEEVENTF_LEFTDOWN
Start-Sleep -Milliseconds 120

for ($i = 1; $i -le 8; $i++) {
  $x = [int]($X + ($ToX - $X) * $i / 8)
  $y = [int]($Y + ($ToY - $Y) * $i / 8)
  [LocalPet.Native]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 40
}

Start-Sleep -Milliseconds $HoldMs
[LocalPet.Native]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)   # MOUSEEVENTF_LEFTUP
