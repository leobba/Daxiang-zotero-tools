# 截取开发实例的 Zotero 偏好设置窗口（只截该窗口，不含桌面其它内容）。
# 用 PrintWindow 渲染，不依赖窗口是否在最前，避免抓到别的窗口。
#
# 用法: pwsh -File scripts/capture-prefs.ps1 [-OutPath <png>]
param(
  [string]$OutPath = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MztCap {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Get-ZoteroWindow([string]$pattern) {
  $zoteroPids = @(Get-Process zotero -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $script:found = [IntPtr]::Zero
  $cb = [MztCap+EnumProc]{
    param($h, $l)
    $p = 0
    [MztCap]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
    if ($zoteroPids -contains $p -and [MztCap]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 512
      [MztCap]::GetWindowTextW($h, $sb, 512) | Out-Null
      if ($sb.ToString() -match $pattern) { $script:found = $h }
    }
    return $true
  }
  [MztCap]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  $script:found
}

function Save-PrintWindow([IntPtr]$h, [string]$path) {
  $r = New-Object MztCap+RECT
  [MztCap]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left
  $ht = $r.Bottom - $r.Top
  if ($w -le 0 -or $ht -le 0) { throw "窗口尺寸无效 ${w}x${ht}" }
  $bmp = New-Object System.Drawing.Bitmap($w, $ht)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  # 0x00000002 = PW_RENDERFULLCONTENT，Gecko 这类自绘窗口必须用这个标志
  [MztCap]::PrintWindow($h, $hdc, 2) | Out-Null
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "已保存 $path (${w}x${ht})"
}

$prefs = Get-ZoteroWindow "设置|Preferences"
if ($prefs -eq [IntPtr]::Zero) {
  Write-Host "设置窗口未打开，尝试用 Ctrl+, 打开…"
  $main = Get-ZoteroWindow "Zotero"
  if ($main -eq [IntPtr]::Zero) { throw "找不到 Zotero 主窗口，请先运行 npm start" }
  [MztCap]::ShowWindow($main, 9) | Out-Null
  # HWND_TOP + SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW
  [MztCap]::SetWindowPos($main, [IntPtr]::Zero, 0, 0, 0, 0, 0x0043) | Out-Null
  [MztCap]::SetForegroundWindow($main) | Out-Null
  Start-Sleep -Milliseconds 1200
  [System.Windows.Forms.SendKeys]::SendWait("^,")
  Start-Sleep -Seconds 5
  $prefs = Get-ZoteroWindow "设置|Preferences"
}
if ($prefs -eq [IntPtr]::Zero) {
  throw "仍然打不开设置窗口。可先在 Zotero 里手动打开 编辑 > 设置，再重跑本脚本。"
}

if ($OutPath -eq "") {
  $OutPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".testkit\shot-prefs.png"
}
Save-PrintWindow $prefs $OutPath
