[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [ValidateRange(1, 200)]
    [int]$MaxItems = 20,
    [switch]$Headed,
    [switch]$NoTranscribe
)

$ErrorActionPreference = "Stop"

$ToolRoot = $PSScriptRoot
$CandidateRoot = (Resolve-Path (Join-Path $ToolRoot "..\vendor\video-batch-download")).Path
$RuntimeRoot = if ($env:DOUYIN_TOOL_HOME) { $env:DOUYIN_TOOL_HOME } else { "D:\YingzhiWorkbench" }
$CacheRoot = Join-Path $RuntimeRoot "cache"
$TempRoot = Join-Path $RuntimeRoot "tmp"
$PrivateRoot = Join-Path $RuntimeRoot "private"
$ResultRoot = Join-Path $RuntimeRoot "data"
$QueueRoot = Join-Path $RuntimeRoot "queue"
$Python = Join-Path (Resolve-Path (Join-Path $ToolRoot "..\vendor\douyin-downloader-1\.venv\Scripts")).Path "python.exe"
$Ffmpeg = Join-Path $RuntimeRoot "bin\ffmpeg.exe"
$CookieSource = Join-Path $RuntimeRoot "config\cookies.json"
$StorageState = Join-Path $PrivateRoot "playwright-storage-state.json"
$LinksFile = Join-Path $QueueRoot "current-links.txt"
$PrepareManifest = Join-Path $QueueRoot "current-source.json"
$ExpectedCandidateCommit = "be5e41cf7e95b3c3388790bcce91b8becb942ef1"

foreach ($path in @($RuntimeRoot, $CacheRoot, $TempRoot, $PrivateRoot, $ResultRoot, $QueueRoot)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}

$LockPath = Join-Path $PrivateRoot "hybrid-run.lock"
try {
    $LockHandle = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
}
catch {
    throw "已有一个抖音处理任务正在运行，请等待该任务完成后再试。"
}

try {
if (-not (Test-Path -LiteralPath $CookieSource)) { throw "缺少登录信息，请先执行菜单 1。" }
if (-not (Test-Path -LiteralPath $Python)) { throw "缺少 Python 运行环境，请先执行 setup.ps1。" }
if (-not (Test-Path -LiteralPath $Ffmpeg)) { throw "缺少 ffmpeg，请先执行 setup.ps1 -WithHybrid。" }
if (-not (Test-Path -LiteralPath (Join-Path $CandidateRoot "node_modules\playwright"))) { throw "缺少混合下载依赖，请先执行 setup.ps1 -WithHybrid。" }

$ActualCandidateCommit = (& git -C $CandidateRoot rev-parse HEAD).Trim()
if ($ActualCandidateCommit -ne $ExpectedCandidateCommit) {
    throw "混合下载引擎版本漂移：期望 $ExpectedCandidateCommit，实际 $ActualCandidateCommit。"
}

$env:TEMP = $TempRoot
$env:TMP = $TempRoot
$env:PIP_CACHE_DIR = Join-Path $CacheRoot "pip"
$env:npm_config_cache = Join-Path $CacheRoot "npm"
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $CacheRoot "playwright-node"
$env:HF_HOME = Join-Path $CacheRoot "huggingface"
$env:TORCH_HOME = Join-Path $CacheRoot "torch"
$env:XDG_CACHE_HOME = $CacheRoot
$env:PYTHONPYCACHEPREFIX = Join-Path $CacheRoot "pycache"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:PATH = "$(Split-Path -Parent $Python);$(Split-Path -Parent $Ffmpeg);$env:PATH"

foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "GIT_HTTP_PROXY", "GIT_HTTPS_PROXY")) {
    $item = Get-Item "Env:$name" -ErrorAction SilentlyContinue
    if ($item -and $item.Value -eq "http://127.0.0.1:9") { Remove-Item ("Env:" + $name) }
}

$PrepareArgs = @(
    (Join-Path $ToolRoot "prepare-links.mjs"),
    "--input", $Url,
    "--cookie-source", $CookieSource,
    "--storage-state", $StorageState,
    "--links", $LinksFile,
    "--manifest", $PrepareManifest,
    "--candidate-root", $CandidateRoot,
    "--limit", "$MaxItems"
)
if ($Headed) { $PrepareArgs += "--headed" }
& node @PrepareArgs
if ($LASTEXITCODE -ne 0) { throw "主页枚举或链接识别失败，退出码：$LASTEXITCODE" }

$DownloadArgs = @(
    (Join-Path $CandidateRoot "scripts\download.mjs"),
    "--input", $LinksFile,
    "--output", $ResultRoot,
    "--storage-state", $StorageState,
    "--parse-concurrency", "1",
    "--download-concurrency", "1",
    "--max-attempts", "3",
    "--ffmpeg-path", $Ffmpeg
)
if ($Headed) { $DownloadArgs += "--headed" }
if ($NoTranscribe) {
    $DownloadArgs += "--no-transcribe"
} else {
    $DownloadArgs += @("--model", "small", "--device", "cpu", "--compute-type", "int8", "--transcribe-timeout", "1800")
}

& node @DownloadArgs
if ($LASTEXITCODE -ne 0) { throw "下载或转写失败，退出码：$LASTEXITCODE" }

$SummaryPath = Join-Path $ResultRoot "download-summary.json"
if (-not (Test-Path -LiteralPath $SummaryPath)) { throw "处理结束但未生成汇总文件。" }
$Summary = Get-Content -LiteralPath $SummaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
$RequestedCount = (Get-Content -LiteralPath $LinksFile -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
if ([int]$Summary.failed -gt 0 -or [int]$Summary.completed -lt $RequestedCount) {
    throw "本批次未闭环：请求 $RequestedCount 条，完成 $($Summary.completed) 条，失败 $($Summary.failed) 条。"
}
if (-not $NoTranscribe -and [int]$Summary.withTranscript -lt $RequestedCount) {
    throw "视频已下载，但转写未全部完成：请求 $RequestedCount 条，转写 $($Summary.withTranscript) 条。"
}

$KnowledgeArgs = @((Join-Path $ToolRoot "build-knowledge-cards.mjs"), '--summary', $SummaryPath)
$KnowledgeArgs += '--transcript-only'
& node @KnowledgeArgs
if ($LASTEXITCODE -ne 0) { throw "视频处理完成，但文字稿卡片生成失败，退出码：$LASTEXITCODE" }

if ($NoTranscribe) {
    Write-Host "仅下载完成：$RequestedCount 条；尚未执行文字转写和知识总结。" -ForegroundColor Yellow
} else {
    Write-Host "本地转写完成：$RequestedCount 条；核对文字稿后，使用菜单6启动本地知识总结。" -ForegroundColor Green
}
}
finally {
    if ($LockHandle) { $LockHandle.Dispose() }
}
