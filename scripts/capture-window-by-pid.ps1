# 按进程 PID 精确截取某个 Zotero 实例的窗口。
#
# 为什么需要它：用户自己的 Zotero 和开发实例都是 zotero.exe，
# 按进程名找窗口会抓到用户那一个。这里按 PID 精确定位。
#
# 用法：pwsh -File capture-window-by-pid.ps1 -ProcessId 1234 -OutPath shot.png [-TitleMatch "设置"]
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [string]$TitleMatch = ""
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinCap {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static System.Collections.Generic.List<string> Find(uint targetPid, string titleMatch) {
    var found = new System.Collections.Generic.List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != targetPid || !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      string title = sb.ToString();
      if (title.Length == 0) return true;
      if (titleMatch.Length > 0 && title.IndexOf(titleMatch, StringComparison.OrdinalIgnoreCase) < 0) return true;
      found.Add(h.ToInt64() + "|" + title);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$windows = [WinCap]::Find([uint32]$ProcessId, $TitleMatch)
if (-not $windows -or $windows.Count -eq 0) {
  throw "PID $ProcessId 下没有匹配「$TitleMatch」的可见窗口"
}

Write-Host "找到 $($windows.Count) 个窗口："
foreach ($entry in $windows) { Write-Host "  $($entry.Split('|')[1])" }

# 优先选标题里带「设置 / Preferences」的（偏好设置窗口）
$chosen = $windows | Where-Object { $_ -match "设置|Preferences|Settings" } | Select-Object -First 1
if (-not $chosen) { $chosen = $windows[0] }

$handle = [IntPtr][long]($chosen.Split('|')[0])
$title = $chosen.Split('|')[1]
Write-Host "截取: $title"

[WinCap]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 600

$rect = New-Object WinCap+RECT
[WinCap]::GetWindowRect($handle, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { throw "窗口尺寸无效: ${width}x${height}" }

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
# PW_RENDERFULLCONTENT = 2，能抓到硬件加速渲染的内容
[WinCap]::PrintWindow($handle, $hdc, 2) | Out-Null
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()

$bitmap.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Host "已保存 $OutPath (${width}x${height})"
