# 当 `git push` 不通时，改用 GitHub REST API 推送本地提交。
#
# 背景：本机到 github.com 的 git 通道（443 上的 smart HTTP）实测经常被重置，
# 但 **api.github.com 一直正常**。所以走 Git Data API：
#   建 blob → 建 tree → 建 commit → 移动分支 ref
#
# 注意：这样创建的提交 SHA 与本地提交不同（内容相同、元数据不同）。
# 本地分支不会被改动；远端会多出一个等价提交。
#
# 用法：
#   pwsh -NoProfile -File scripts/push-via-api.ps1
#   pwsh -NoProfile -File scripts/push-via-api.ps1 -Since ebe71aa -Tag v0.3.0
param(
  [string]$Owner = "leobba",
  [string]$Repo = "Daxiang-zotero-tools",
  [string]$Since = "",
  [string]$Tag = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot

# ---------- token ----------
$token = $env:GITHUB_TOKEN
if (-not $token -and (Test-Path ".env")) {
  $line = Get-Content ".env" | Where-Object { $_ -match "^\s*GITHUB_TOKEN\s*=" } | Select-Object -First 1
  if ($line) { $token = ($line -split "=", 2)[1].Trim().Trim('"').Trim("'") }
}
if (-not $token) { throw "没有 GITHUB_TOKEN" }

$api = "https://api.github.com/repos/$Owner/$Repo"
$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent"           = "dsh-api-push"
}

# 统一用 UTF-8 字节发 JSON，避免中文乱码
function Invoke-Api($method, $uri, $body) {
  if ($null -eq $body) {
    return Invoke-RestMethod -Uri $uri -Method $method -Headers $headers
  }
  $json = $body | ConvertTo-Json -Depth 20 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Uri $uri -Method $method -Headers $headers -Body $bytes -ContentType "application/json; charset=utf-8"
}

# ---------- 远端当前状态 ----------
$ref = Invoke-Api GET "$api/git/ref/heads/main" $null
$remoteSha = $ref.object.sha
Write-Host "远端 main = $remoteSha"

$localHead = (git rev-parse HEAD).Trim()
Write-Host "本地 HEAD = $localHead"
if ($remoteSha -eq $localHead) { Write-Host "✅ 已经一致，无需推送"; return }

if (-not $Since) {
  # ⚠️ 不能用远端 SHA 当基准：API 创建的提交只存在于服务器上，
  #    本地对象库里没有，`git diff <远端SHA>..HEAD` 会算不出任何改动
  #    （实测会报「没有检测到改动」）。所以用本地 ref 记录上次推送位置。
  $lastRef = "refs/mzt/last-api-push"
  $recorded = (git rev-parse --verify --quiet $lastRef 2>$null)
  if ($recorded) {
    $Since = $recorded.Trim()
    Write-Host "基准 = 上次 API 推送记录 $Since"
  }
  else {
    $Since = $remoteSha
    Write-Warning "没有 $lastRef 记录，回退用远端 SHA（可能算不出改动，必要时用 -Since 指定本地提交）"
  }
}
Write-Host "基准提交 = $Since"

# ---------- 找出改动文件 ----------
$nameStatus = git diff --name-status "$Since..$localHead" 2>&1
$changed = @()
$deleted = @()
foreach ($line in $nameStatus) {
  if ($line -notmatch "^(\w)\s+(.+)$") { continue }
  $status = $matches[1]
  $path = $matches[2].Trim()
  if ($status -eq "D") { $deleted += $path } else { $changed += $path }
}
Write-Host "改动文件: $($changed.Count) 个新增/修改，$($deleted.Count) 个删除"
if ($changed.Count -eq 0 -and $deleted.Count -eq 0) { throw "没有检测到改动" }

# ---------- 建 blob ----------
$treeEntries = @()
foreach ($path in $changed) {
  $full = Join-Path $projectRoot ($path -replace "/", "\")
  if (-not (Test-Path $full)) { Write-Warning "跳过不存在的文件: $path"; continue }
  $content = [System.IO.File]::ReadAllText($full, [System.Text.UTF8Encoding]::new($false))
  $blob = Invoke-Api POST "$api/git/blobs" @{ content = $content; encoding = "utf-8" }
  $treeEntries += @{ path = $path; mode = "100644"; type = "blob"; sha = $blob.sha }
  Write-Host "  blob $path → $($blob.sha.Substring(0,8))"
}
# 删除的文件：Git Data API 里用 sha=null 表示删除
foreach ($path in $deleted) {
  $treeEntries += @{ path = $path; mode = "100644"; type = "blob"; sha = $null }
  Write-Host "  delete $path"
}

# ---------- 建 tree ----------
$parentCommit = Invoke-Api GET "$api/git/commits/$remoteSha" $null
$tree = Invoke-Api POST "$api/git/trees" @{
  base_tree = $parentCommit.tree.sha
  tree      = $treeEntries
}
Write-Host "新 tree = $($tree.sha)"

# ---------- 建 commit ----------
# ⚠️ git log 的输出在 PowerShell 里是字符串**数组**，直接 .Trim() 会触发成员枚举、
#    返回的仍是数组，GitHub 会拒绝（message 必须是字符串）。
$message = ((git log -1 --pretty=%B $localHead) -join "`n").Trim()
if (-not $message) { $message = "Update via API" }
$commit = Invoke-Api POST "$api/git/commits" @{
  message = $message
  tree    = $tree.sha
  parents = @($remoteSha)
}
Write-Host "新 commit = $($commit.sha)"

# ---------- 移动分支 ----------
Invoke-Api PATCH "$api/git/refs/heads/main" @{ sha = $commit.sha; force = $true } | Out-Null
Write-Host "✅ main 已更新到 $($commit.sha)" -ForegroundColor Green

# ---------- 打 tag（可选） ----------
if ($Tag) {
  try {
    Invoke-Api POST "$api/git/refs" @{ ref = "refs/tags/$Tag"; sha = $commit.sha } | Out-Null
    Write-Host "✅ tag $Tag 已创建并指向该提交" -ForegroundColor Green
  }
  catch {
    if ($_.Exception.Message -match "already exists") {
      Invoke-Api PATCH "$api/git/refs/tags/$Tag" @{ sha = $commit.sha; force = $true } | Out-Null
      Write-Host "ℹ️  tag $Tag 已存在，已指向新提交" -ForegroundColor Yellow
    }
    else { throw }
  }
}

# 记录本次推送到的本地提交，供下次算基准（远端 SHA 在本地不存在）
git update-ref "refs/mzt/last-api-push" $localHead
Write-Host "ℹ️  已记录 refs/mzt/last-api-push = $localHead"

Write-Host ""
Write-Host "⚠️ 注意：远端提交 SHA 与本地不同（内容相同）。"
Write-Host "   下次 git push 前先 git fetch + reset，避免分叉。"
