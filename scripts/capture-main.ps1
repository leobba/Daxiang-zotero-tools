# 截取开发实例的 Zotero 主窗口（用于查看条目信息面板里的自定义区块）。
# 只截 Zotero 窗口，不含桌面其它内容。
param(
  [string]$OutPath = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MztMain {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Get-MainWindow {
  $zoteroPids = @(Get-Process zotero -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $script:found = [IntPtr]::Zero
  $script:bestArea = 0
  $cb = [MztMain+EnumProc]{
    param($h, $l)
    $p = 0
    [MztMain]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
    if ($zoteroPids -contains $p -and [MztMain]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 512
      [MztMain]::GetWindowTextW($h, $sb, 512) | Out-Null
      # 主窗口标题含 "Zotero"，但设置窗口也含；排除「设置 / Preferences」
      if ($sb.ToString() -match "Zotero" -and $sb.ToString() -notmatch "设置|Preferences") {
        $r = New-Object MztMain+RECT
        [MztMain]::GetWindowRect($h, [ref]$r) | Out-Null
        $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
        if ($area -gt $script:bestArea) {
          $script:bestArea = $area
          $script:found = $h
        }
      }
    }
    return $true
  }
  [MztMain]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  $script:found
}

$h = Get-MainWindow
if ($h -eq [IntPtr]::Zero) { throw "找不到 Zotero 主窗口，请先运行 npm start" }

$r = New-Object MztMain+RECT
[MztMain]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[MztMain]::PrintWindow($h, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$g.Dispose()

if ($OutPath -eq "") {
  $OutPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".testkit\shot-main.png"
}
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "已保存 $OutPath (${w}x${ht})"
