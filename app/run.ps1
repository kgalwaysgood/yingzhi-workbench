[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Url,
    [switch]$CaptureCookies,
    [switch]$VerboseLogs,
    [ValidateRange(1, 200)]
    [int]$MaxItems = 20,
    [switch]$Headed,
    [switch]$NoTranscribe,
    [string]$ConfigPath
)

$ErrorActionPreference = "Stop"

$ToolRoot = $PSScriptRoot
$VendorRoot = (Resolve-Path (Join-Path $ToolRoot "..\vendor\douyin-downloader-1")).Path
$RuntimeRoot = if ($env:DOUYIN_TOOL_HOME) { $env:DOUYIN_TOOL_HOME } else { "D:\YingzhiWorkbench" }
$CacheRoot = Join-Path $RuntimeRoot "cache"
$TempRoot = Join-Path $RuntimeRoot "tmp"
$BinRoot = Join-Path $RuntimeRoot "bin"
$Python = Join-Path $VendorRoot ".venv\Scripts\python.exe"
$VenvScripts = Split-Path -Parent $Python
$HybridScript = Join-Path $ToolRoot "run-hybrid.ps1"

if (-not (Test-Path -LiteralPath $Python)) {
    throw "尚未安装运行环境，请先执行 .\setup.ps1。"
}

foreach ($path in @($RuntimeRoot, $CacheRoot, $TempRoot, $BinRoot, (Join-Path $RuntimeRoot "private"), (Join-Path $RuntimeRoot "config"), (Join-Path $RuntimeRoot "data"))) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}

$env:TEMP = $TempRoot
$env:TMP = $TempRoot
$env:PIP_CACHE_DIR = Join-Path $CacheRoot "pip"
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $CacheRoot "playwright"
$env:HF_HOME = Join-Path $CacheRoot "huggingface"
$env:TORCH_HOME = Join-Path $CacheRoot "torch"
$env:XDG_CACHE_HOME = $CacheRoot
$env:PYTHONPYCACHEPREFIX = Join-Path $CacheRoot "pycache"
$env:PYTHONPATH = $VendorRoot
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:PATH = "$VenvScripts;$BinRoot;$env:PATH"

if ($Host.Name -eq "ConsoleHost") {
    & chcp 65001 | Out-Null
}

foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "GIT_HTTP_PROXY", "GIT_HTTPS_PROXY")) {
    $item = Get-Item "Env:$name" -ErrorAction SilentlyContinue
    if ($item -and $item.Value -eq "http://127.0.0.1:9") {
        Remove-Item ("Env:" + $name)
    }
}

if (-not $ConfigPath) {
    $ConfigPath = Join-Path $RuntimeRoot "private\config.yml"
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Copy-Item -LiteralPath (Join-Path $ToolRoot "config.template.yml") -Destination $ConfigPath
}

Push-Location $RuntimeRoot
try {
    if ($CaptureCookies) {
        $CookiePath = Join-Path $RuntimeRoot "config\cookies.json"
        & $Python -m tools.cookie_fetcher --output $CookiePath
        if ($LASTEXITCODE -ne 0) {
            throw "登录信息获取失败，退出码：$LASTEXITCODE"
        }
        return
    }

    if ($Url -and $Url -match '^https?://') {
        & $HybridScript -Url $Url -MaxItems $MaxItems -Headed:$Headed -NoTranscribe:$NoTranscribe
        if ($LASTEXITCODE -ne 0) {
            throw "混合处理链路失败，退出码：$LASTEXITCODE"
        }
        return
    }

    $Arguments = @("-m", "cli.main", "-c", $ConfigPath)
    if ($Url) {
        $Arguments += @("-u", $Url)
    }
    if ($VerboseLogs) {
        $Arguments += "--verbose"
    }
    & $Python @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "处理任务失败，退出码：$LASTEXITCODE"
    }
    return
}
finally {
    Pop-Location
}
