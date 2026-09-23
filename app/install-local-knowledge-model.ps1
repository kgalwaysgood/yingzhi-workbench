[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RuntimeRoot = if ($env:DOUYIN_TOOL_HOME) { $env:DOUYIN_TOOL_HOME } else { 'D:\YingzhiWorkbench' }
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
if ([System.IO.Path]::GetPathRoot($RuntimeRoot) -ieq 'C:\') { throw '运行目录不能位于 C 盘。' }
$TempRoot = Join-Path $RuntimeRoot 'tmp'
$BinRoot = Join-Path $RuntimeRoot 'bin\llama-cpp'
$ModelRoot = Join-Path $RuntimeRoot 'models\knowledge'
$ModelPath = Join-Path $ModelRoot 'Qwen3-4B-Q4_K_M.gguf'
$ExpectedModelHash = '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5'
$ModelUrl = 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/a9a60d0/Qwen3-4B-Q4_K_M.gguf?download=true'

foreach ($directory in @($RuntimeRoot, $TempRoot, $BinRoot, $ModelRoot)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
$env:TEMP = $TempRoot
$env:TMP = $TempRoot

function Get-VerifiedDownload {
    param([string]$Url, [string]$Target, [string]$Sha256)
    if ((Test-Path -LiteralPath $Target) -and (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash -ieq $Sha256) {
        Write-Host "已校验，复用：$Target"
        return
    }
    $partial = "$Target.partial"
    & curl.exe --fail --location --retry 3 --continue-at - --output $partial $Url
    if ($LASTEXITCODE -ne 0) { throw "下载失败：$Url；可重新运行以续传。" }
    $actual = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash
    if ($actual -ine $Sha256) { throw "下载校验失败：$partial；文件已保留供排查，未启用。" }
    Move-Item -LiteralPath $partial -Destination $Target -Force
}

$EnginePath = Join-Path $BinRoot 'llama-server.exe'
if (-not (Test-Path -LiteralPath $EnginePath)) {
    $releases = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20'
    $asset = $releases | ForEach-Object { $_.assets } | Where-Object { $_.name -match '^llama-b\d+-bin-win-cpu-x64\.zip$' -and $_.digest -match '^sha256:[a-fA-F0-9]{64}$' } | Select-Object -First 1
    $digestMatch = [regex]::Match([string]$asset.digest, '^sha256:([a-fA-F0-9]{64})$')
    if (-not $asset -or -not $digestMatch.Success) {
        throw '近期官方版本缺少带 SHA-256 的 Windows x64 CPU 安装包；未下载其他来源。'
    }
    $zip = Join-Path $TempRoot $asset.name
    Get-VerifiedDownload -Url $asset.browser_download_url -Target $zip -Sha256 $digestMatch.Groups[1].Value
    Expand-Archive -LiteralPath $zip -DestinationPath $BinRoot -Force
    if (-not (Test-Path -LiteralPath $EnginePath)) { throw '官方压缩包中没有预期的 llama-server.exe；已保留下载文件，未修改 PATH。' }
}

Get-VerifiedDownload -Url $ModelUrl -Target $ModelPath -Sha256 $ExpectedModelHash
Write-Host "本地总结模型已就绪：$ModelPath"
Write-Host "运行程序：$EnginePath"
Write-Host '模型和程序仅位于指定运行目录；未安装系统级服务。'
