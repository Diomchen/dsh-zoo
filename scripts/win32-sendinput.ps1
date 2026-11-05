<#
  真实 OS 左键，给 Windows 桌面冒烟用（ticket 30）。

  为什么不用 Electron 的 sendInputEvent：它走 Chromium 的输入管线，窗口只要「看起来」可交互
  就能收到——现场那个 bug 恰恰是「窗口说可交互、真实左键却没进渲染端」，只有真的经过 Windows
  输入队列的 SendInput 才算覆盖到。

  0.4.2 现场证明这个脚本自己也能骗人（脚本名写着 SendInput，实际调的是 mouse_event）；
  三处一起修好，缺一处都还是假通过：
    1. 走真正的 SendInput（INPUT + MOUSEEVENTF_LEFTDOWN/UP），不用 mouse_event 这个老垫片。
       mouse_event 在这台 Windows + Electron 透明置顶窗上没有稳定进入真实输入队列。
    2. SetProcessDPIAware()：调用方按 DIP × scaleFactor 传物理像素，PowerShell 进程默认不是
       per-monitor DPI aware，SetCursorPos 的坐标语义会与传入值不一致。
    3. 按下前先用一次小幅真实移动刷新渲染端 hover 心跳，再等主进程 300ms 兜底接管。
       move 与 drag 是两次独立进程调用，drag 进程启动 + 编译 C# 的时间足以让 hover 过期，
       窗口在 down 之前就回到点击穿透，busy 于是永远不会变 true。

  坐标都是物理像素；调用方负责把 Electron 的 DIP 乘上 scaleFactor。

  退出码：0 正常；2 SendInput 被系统吞掉（锁屏、UAC 安全桌面、被 UIPI 拦），
  冒烟据此报「脚本没把按键送进去」，而不是含糊地等一个永不出现的 busy。

  用法：
    -Mode move -X 100 -Y 200
    -Mode drag -X 100 -Y 200 -ToX 190 -ToY 200 -HoldMs 600
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('move', 'drag')][string]$Mode,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [int]$ToX = $X,
  [int]$ToY = $Y,
  [int]$HoldMs = 600
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace DshZoo {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
      public int dx;
      public int dy;
      public uint mouseData;
      public uint dwFlags;
      public uint time;
      public IntPtr dwExtraInfo;
    }
    // cbSize 必须等于真实结构体大小：x64 是 40，x86 是 28。用 Marshal.SizeOf 现算。
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
      public uint type;
      public MOUSEINPUT mi;
    }
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public static uint Mouse(uint flags) {
      INPUT[] inputs = new INPUT[1];
      inputs[0].type = 0; // INPUT_MOUSE
      inputs[0].mi.dwFlags = flags;
      return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
  }
}
'@

[DshZoo.Native]::SetProcessDPIAware() | Out-Null
[DshZoo.Native]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 150

# 用一次真实移动刷新渲染端 hover 心跳（它是指针事件驱动的，SetCursorPos 同一点不会产生事件）。
[DshZoo.Native]::SetCursorPos($X + 2, $Y) | Out-Null
Start-Sleep -Milliseconds 40
[DshZoo.Native]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 40
if ($Mode -eq 'move') { exit 0 }

# 主进程兜底是 300ms；留一点余量再按下，否则 down 落到还是穿透的窗口上。
Start-Sleep -Milliseconds 200

if ([DshZoo.Native]::Mouse(0x0002) -eq 0) {   # MOUSEEVENTF_LEFTDOWN
  Write-Error "SendInput LEFTDOWN 被系统吞掉（锁屏 / UAC 安全桌面 / 被拦？）错误码 $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  exit 2
}
Start-Sleep -Milliseconds 120

for ($i = 1; $i -le 8; $i++) {
  $x = [int]($X + ($ToX - $X) * $i / 8)
  $y = [int]($Y + ($ToY - $Y) * $i / 8)
  [DshZoo.Native]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 40
}

Start-Sleep -Milliseconds $HoldMs
if ([DshZoo.Native]::Mouse(0x0004) -eq 0) {   # MOUSEEVENTF_LEFTUP
  Write-Error "SendInput LEFTUP 被系统吞掉（按下已经发生过，键盘鼠标可能卡在按下态）"
  exit 2
}
