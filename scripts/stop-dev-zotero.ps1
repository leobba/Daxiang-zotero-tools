# 只结束「开发/测试用的 Zotero 实例」，**绝不动用户自己正在用的 Zotero**。
#
# 为什么需要它：跑 `npm test` / `npm start` 前要确保没有残留实例占用 profile，
# 但简单粗暴地 `Get-Process zotero | Stop-Process` 会把用户自己开的 Zotero 一起杀掉。
#
# 判定方式：看进程命令行里有没有本项目的隔离目录（.testkit / .scaffold）。
#   · 开发实例：--profile ...\.testkit\profile
#   · 测试实例：--profile ...\.scaffold\test\profile
# 用户自己开的 Zotero 用的是 %APPDATA%\Zotero\... 或 D:\zotero文献，不会被匹配。
param(
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path $PSScriptRoot -Parent

function Get-ZoteroProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'zotero.exe'" -ErrorAction SilentlyContinue
}

$all = Get-ZoteroProcesses
if (-not $all) {
  if (-not $Quiet) { Write-Host "没有 Zotero 进程。" }
  return
}

$ours = @()
$theirs = @()
foreach ($proc in $all) {
  $cmd = [string]$proc.CommandLine
  if ($cmd -match "\\\.testkit\\" -or $cmd -match "\\\.scaffold\\" -or $cmd -match "zotero-smart-collections") {
    $ours += $proc
  }
  else {
    $theirs += $proc
  }
}

if (-not $Quiet) {
  Write-Host "开发/测试实例: $($ours.Count) 个"
  Write-Host "你自己的 Zotero: $($theirs.Count) 个（不动）"
}

foreach ($proc in $ours) {
  try {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
  }
  catch {
    Write-Warning "结束进程 $($proc.ProcessId) 失败: $_"
  }
}

if ($ours.Count -gt 0) {
  Start-Sleep -Seconds 3
  $left = @(Get-ZoteroProcesses | Where-Object {
      $cmd = [string]$_.CommandLine
      $cmd -match "\\\.testkit\\" -or $cmd -match "\\\.scaffold\\" -or $cmd -match "zotero-smart-collections"
    })
  if (-not $Quiet) {
    if ($left.Count) { Write-Warning "仍有 $($left.Count) 个开发实例未退出" }
    else { Write-Host "开发/测试实例已全部结束。" }
  }
}

# 清掉可能残留的 profile 锁
foreach ($dir in @("$projectRoot\.testkit\profile", "$projectRoot\.scaffold\test\profile")) {
  foreach ($lock in @("$dir\lock", "$dir\.parentlock")) {
    if (Test-Path $lock) {
      Remove-Item $lock -Force -ErrorAction SilentlyContinue
      if (-not $Quiet) { Write-Host "已清理 $lock" }
    }
  }
}
