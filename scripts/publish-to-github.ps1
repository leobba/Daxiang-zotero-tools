# 一键完成 GitHub 建库 → 推送 → 打 tag → 触发发布。
#
# 前提：项目根目录的 .env 里有 GITHUB_TOKEN（classic token，scope 需要 repo + workflow）。
# 用法：pwsh -NoProfile -File scripts/publish-to-github.ps1
#
# 这个脚本是幂等的：仓库已存在就跳过建库，remote 已配就更新，tag 已存在就跳过。
param(
  [string]$Owner = "leobba",
  [string]$Repo = "Daxiang-zotero-tools",
  [string]$Tag = "",
  [switch]$SkipTag
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot

# ---------- 1. 读 token ----------
$token = $env:GITHUB_TOKEN
if (-not $token -and (Test-Path ".env")) {
  $line = Get-Content ".env" | Where-Object { $_ -match "^\s*GITHUB_TOKEN\s*=" } | Select-Object -First 1
  if ($line) { $token = ($line -split "=", 2)[1].Trim().Trim('"').Trim("'") }
}
if (-not $token) {
  throw "没有找到 GITHUB_TOKEN。请写进 .env（GITHUB_TOKEN=ghp_xxx）或设为环境变量。"
}
Write-Host "✅ 已读到 GITHUB_TOKEN（长度 $($token.Length)）" -ForegroundColor Green

$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent"           = "myzoterotools-publish"
}

# ---------- 2. 确认 token 身份 ----------
$me = Invoke-RestMethod -Uri "https://api.github.com/user" -Headers $headers
Write-Host "✅ token 身份: $($me.login)" -ForegroundColor Green

# ---------- 3. 建仓库（已存在则跳过） ----------
$repoFull = "$Owner/$Repo"
$exists = $true
try {
  Invoke-RestMethod -Uri "https://api.github.com/repos/$repoFull" -Headers $headers | Out-Null
}
catch {
  if ($_.Exception.Response.StatusCode.value__ -eq 404) { $exists = $false }
  else { throw }
}

if ($exists) {
  Write-Host "ℹ️  仓库已存在，跳过创建: $repoFull" -ForegroundColor Yellow
}
else {
  Write-Host "→ 创建公开仓库 $repoFull …"
  $body = @{
    name        = $Repo
    description = "MyZoteroTools — 自用 Zotero 插件（分类聚合 / 阅读状态 / 数据包导出 / 库体检 / 结构化字段 / 元数据清洗）"
    private     = $false
    has_issues  = $true
    has_wiki    = $false
  } | ConvertTo-Json
  Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Method Post -Headers $headers -Body $body | Out-Null
  Write-Host "✅ 仓库已创建（公开）" -ForegroundColor Green
  Start-Sleep -Seconds 2
}

# ---------- 4. 配置 remote 并推送 ----------
$remoteUrl = "https://github.com/$repoFull.git"
$existingRemote = git remote get-url origin 2>$null
if ($existingRemote) {
  git remote set-url origin $remoteUrl
  Write-Host "ℹ️  已更新 origin → $remoteUrl"
}
else {
  git remote add origin $remoteUrl
  Write-Host "ℹ️  已添加 origin → $remoteUrl"
}

# 用 token 拼一个只在本条命令里生效的推送地址，避免把 token 写进 .git/config
$pushUrl = "https://x-access-token:$token@github.com/$repoFull.git"
$branch = (git branch --show-current)
Write-Host "→ 推送分支 $branch …"
git push $pushUrl "refs/heads/${branch}:refs/heads/${branch}" 2>&1 | ForEach-Object { Write-Host "   $_" }
if ($LASTEXITCODE -ne 0) { throw "推送失败" }

# 设上游，后续普通 git push 也能用（凭据交给 Credential Manager）
git branch --set-upstream-to "origin/$branch" $branch 2>&1 | Out-Null

# ---------- 5. 打 tag 并推送（触发 Actions 发布） ----------
if (-not $Tag) {
  $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
  $Tag = "v$($pkg.version)"
}

if ($SkipTag) {
  Write-Host "ℹ️  按要求跳过打 tag"
}
else {
  $tagExists = git tag -l $Tag
  if ($tagExists) {
    Write-Host "ℹ️  tag $Tag 已存在" -ForegroundColor Yellow
  }
  else {
    git tag -a $Tag -m "MyZoteroTools $Tag"
    Write-Host "✅ 已创建 tag $Tag" -ForegroundColor Green
  }
  Write-Host "→ 推送 tag $Tag …"
  git push $pushUrl "refs/tags/${Tag}:refs/tags/${Tag}" 2>&1 | ForEach-Object { Write-Host "   $_" }
  if ($LASTEXITCODE -ne 0) { throw "推送 tag 失败" }
}

Write-Host ""
Write-Host "✅ 完成。接下来：" -ForegroundColor Green
Write-Host "   1. 打开 https://github.com/$repoFull/actions 看 Actions 是否变绿"
Write-Host "   2. 打开 https://github.com/$repoFull/releases 看有没有 xpi 与 update.json"
Write-Host "   3. 验证自动更新地址:"
Write-Host "      https://github.com/$repoFull/releases/download/release/update.json"
