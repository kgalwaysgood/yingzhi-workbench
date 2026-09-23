[CmdletBinding()]
param(
    [switch]$WithBrowser,
    [switch]$WithLocalWhisper,
    [switch]$WithHybrid
)

$ErrorActionPreference = "Stop"

$ToolRoot = $PSScriptRoot
$VendorRoot = (Resolve-Path (Join-Path $ToolRoot "..\vendor\douyin-downloader-1")).Path
$HybridRoot = (Resolve-Path (Join-Path $ToolRoot "..\vendor\video-batch-download")).Path
$RuntimeRoot = if ($env:DOUYIN_TOOL_HOME) { $env:DOUYIN_TOOL_HOME } else { "D:\YingzhiWorkbench" }
$TempRoot = Join-Path $RuntimeRoot "tmp"
$CacheRoot = Join-Path $RuntimeRoot "cache"
$BinRoot = Join-Path $RuntimeRoot "bin"
$PrivateRoot = Join-Path $RuntimeRoot "private"
$ConfigRoot = Join-Path $RuntimeRoot "config"
$DataRoot = Join-Path $RuntimeRoot "data"
$VenvRoot = Join-Path $VendorRoot ".venv"

foreach ($path in @($RuntimeRoot, $TempRoot, $CacheRoot, $BinRoot, $PrivateRoot, $ConfigRoot, $DataRoot)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}

# Keep installers, model caches, browser binaries and temporary files on D:.
$env:TEMP = $TempRoot
$env:TMP = $TempRoot
$env:PIP_CACHE_DIR = Join-Path $CacheRoot "pip"
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $CacheRoot "playwright"
$env:HF_HOME = Join-Path $CacheRoot "huggingface"
$env:TORCH_HOME = Join-Path $CacheRoot "torch"
$env:XDG_CACHE_HOME = $CacheRoot
$env:PYTHONPYCACHEPREFIX = Join-Path $CacheRoot "pycache"
$env:npm_config_cache = Join-Path $CacheRoot "npm"

# Network policy variables are injected by the host. Remove them only in this
# child process and run pip in isolated mode; system settings stay unchanged.
Get-ChildItem Env: | Where-Object { $_.Name -match "(?i)proxy" } | ForEach-Object {
    Remove-Item ("Env:" + $_.Name) -ErrorAction SilentlyContinue
}
Remove-Item Env:PIP_NO_INDEX -ErrorAction SilentlyContinue
$env:NO_PROXY = "*"

if (-not (Test-Path -LiteralPath (Join-Path $VenvRoot "Scripts\python.exe"))) {
    & python -m venv $VenvRoot
    if ($LASTEXITCODE -ne 0) { throw "创建 D 盘虚拟环境失败。" }
}

$Python = Join-Path $VenvRoot "Scripts\python.exe"
& $Python -m pip --isolated install --no-cache-dir --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "升级 pip 失败。" }

& $Python -m pip --isolated install --no-cache-dir -r (Join-Path $VendorRoot "requirements.txt") pytest pytest-asyncio ruff
if ($LASTEXITCODE -ne 0) { throw "安装基础依赖失败。" }

if ($WithBrowser) {
    & $Python -m pip --isolated install --no-cache-dir playwright
    if ($LASTEXITCODE -ne 0) { throw "安装 Playwright 失败。" }
    & $Python -m playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "安装 Chromium 失败。" }
}

if ($WithLocalWhisper) {
    & $Python -m pip --isolated install --no-cache-dir openai-whisper
    if ($LASTEXITCODE -ne 0) { throw "安装本地 Whisper 失败。" }
}

if ($WithHybrid) {
    & $Python -m pip --isolated uninstall -y opencc-python-reimplemented
    if ($LASTEXITCODE -ne 0) { throw "清理不兼容的 OpenCC 实现失败。" }
    & $Python -m pip --isolated install --no-cache-dir faster-whisper "OpenCC==1.4.2"
    if ($LASTEXITCODE -ne 0) { throw "安装混合链路转写依赖失败。" }

    Push-Location $HybridRoot
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $HybridRoot "node_modules\playwright"))) {
            & npm install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "安装混合链路 Node 依赖失败。" }
        }
        $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $CacheRoot "playwright-node"
        & node (Join-Path $HybridRoot "node_modules\playwright\cli.js") install chromium
        if ($LASTEXITCODE -ne 0) { throw "安装混合链路 Chromium 失败。" }
    }
    finally {
        Pop-Location
    }
}

if ($WithLocalWhisper -or $WithHybrid) {
    & $Python -m pip --isolated install --no-cache-dir imageio-ffmpeg
    if ($LASTEXITCODE -ne 0) { throw "安装 FFmpeg 运行依赖失败。" }
    $FfmpegSource = Get-ChildItem -LiteralPath (Join-Path $VenvRoot "Lib\site-packages\imageio_ffmpeg\binaries") -Filter "ffmpeg-*.exe" -File | Select-Object -First 1
    if (-not $FfmpegSource) { throw "未找到 imageio-ffmpeg 二进制。" }
    Copy-Item -LiteralPath $FfmpegSource.FullName -Destination (Join-Path $BinRoot "ffmpeg.exe") -Force
}

$PrivateConfig = Join-Path $PrivateRoot "config.yml"
if (-not (Test-Path -LiteralPath $PrivateConfig)) {
    Copy-Item -LiteralPath (Join-Path $ToolRoot "config.template.yml") -Destination $PrivateConfig
}

Write-Host "安装完成。所有新增运行数据位于：$RuntimeRoot"
Write-Host "上游固定版本：b51225e695a9b8fff6eeb8b8178a53306f304f3a"
if ($WithHybrid) { Write-Host "混合下载引擎固定版本：be5e41cf7e95b3c3388790bcce91b8becb942ef1" }
Write-Host "下一步：编辑 $PrivateConfig，或运行 .\run.ps1 -CaptureCookies"
