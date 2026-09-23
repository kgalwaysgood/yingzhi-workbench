[CmdletBinding()]
param(
    [switch]$WithBrowser,
    [switch]$WithLocalWhisper,
    [switch]$WithHybrid
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$VendorRoot = Join-Path $RepoRoot 'vendor'
$RuntimeRoot = if ($env:DOUYIN_TOOL_HOME) { $env:DOUYIN_TOOL_HOME } else { 'D:\YingzhiWorkbench' }

if ([System.IO.Path]::GetPathRoot($RuntimeRoot).TrimEnd('\').ToUpperInvariant() -eq 'C:') {
    throw 'Runtime data cannot be stored on C:. Set DOUYIN_TOOL_HOME to a D: path.'
}

$dependencies = @(
    @{
        Name = 'douyin-downloader-1'
        Url = 'https://github.com/zinan92/douyin-downloader-1.git'
        Commit = 'b51225e695a9b8fff6eeb8b8178a53306f304f3a'
    },
    @{
        Name = 'video-batch-download'
        Url = 'https://github.com/ljb1020/video-batch-download.git'
        Commit = 'be5e41cf7e95b3c3388790bcce91b8becb942ef1'
    }
)

New-Item -ItemType Directory -Path $VendorRoot,$RuntimeRoot -Force | Out-Null
$env:DOUYIN_TOOL_HOME = $RuntimeRoot

foreach ($dependency in $dependencies) {
    $target = Join-Path $VendorRoot $dependency.Name
    if (-not (Test-Path -LiteralPath (Join-Path $target '.git'))) {
        & git clone --filter=blob:none $dependency.Url $target
        if ($LASTEXITCODE -ne 0) { throw "Failed to clone $($dependency.Name)." }
    }
    & git -C $target fetch --depth 1 origin $dependency.Commit
    if ($LASTEXITCODE -ne 0) { throw "Failed to fetch the pinned $($dependency.Name) commit." }
    & git -C $target checkout --detach $dependency.Commit
    if ($LASTEXITCODE -ne 0) { throw "Failed to checkout the pinned $($dependency.Name) commit." }
    $actual = (& git -C $target rev-parse HEAD).Trim()
    if ($actual -ne $dependency.Commit) { throw "$($dependency.Name) commit verification failed." }
}

$setupArgs = @{}
if ($WithBrowser) { $setupArgs.WithBrowser = $true }
if ($WithLocalWhisper) { $setupArgs.WithLocalWhisper = $true }
if ($WithHybrid) { $setupArgs.WithHybrid = $true }
& (Join-Path $RepoRoot 'app\setup.ps1') @setupArgs
